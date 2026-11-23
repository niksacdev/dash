import type {DatabaseSync} from "node:sqlite";
import {createHash} from "node:crypto";
import {bundledAgents,agentPin,decodeAgentPin,isDomain,isRecord,readSources,type DomainAgent,type Domain,type Role,type Source,type AgentPin,type AgentRegistry} from "../agents/registry.cjs";
export const profiles = bundledAgents.domainAgents();
export interface RoleSnapshot {
  domain:Domain; role:Role; sources:Source[]; version:number; hash:string;
  origin?:"bundle"|"local"; bundle?:AgentPin;
}
export interface DomainRole extends RoleSnapshot { instructions:string }
export function decodeRoleSnapshot(value:unknown):RoleSnapshot {
  if (!isRecord(value) || !isDomain(value.domain) || (value.role!=="expert" && value.role!=="implementer") ||
      typeof value.version!=="number" || !Number.isSafeInteger(value.version) || value.version<1 ||
      typeof value.hash!=="string" || !/^[a-f0-9]{64}$/.test(value.hash))
    throw Error("Invalid saved domain role.");
  if (value.origin!==undefined && value.origin!=="local" && value.origin!=="bundle") throw Error("Invalid saved role origin.");
  return {domain:value.domain,role:value.role,sources:readSources(value.sources),version:value.version,hash:value.hash,
    ...(value.origin && {origin:value.origin}),...(value.bundle!=null && {bundle:decodeAgentPin(value.bundle)})};
}
function roleSpec(profile:DomainAgent|DomainRole,version:number,instructions:string,origin:"bundle"|"local",bundle:AgentPin|undefined):DomainRole {
  const spec = {domain:profile.domain,role:profile.role,instructions,sources:profile.sources};
  return {...spec,version,hash:createHash("sha256").update(JSON.stringify(spec)).digest("hex"),origin,...(bundle && {bundle})};
}
function readRole(raw:unknown):DomainRole {
  if (typeof raw !== "string") throw Error("Missing saved domain role.");
  const v:unknown=JSON.parse(raw);
  if (!isRecord(v) || typeof v.instructions!=="string") throw Error("Invalid saved instructions.");
  const snapshot=decodeRoleSnapshot(v);
  const role={...snapshot,instructions:v.instructions};
  const {domain,role:name,instructions,sources}=role;
  const digest=createHash("sha256").update(JSON.stringify({domain,role:name,instructions,sources})).digest("hex");
  if (digest!==role.hash) throw Error("The stored domain instructions do not match their pinned hash.");
  return role;
}
export function transaction<T>(db:DatabaseSync, work:()=>T):T {
  db.exec("BEGIN IMMEDIATE");
  try { const result=work(); db.exec("COMMIT"); return result; }
  catch(error) { db.exec("ROLLBACK"); throw error; }
}
export class RoleStore {
  constructor(private readonly db:DatabaseSync, private readonly registry:AgentRegistry) {
    db.exec(`CREATE TABLE IF NOT EXISTS outcome_agent_roles(domain TEXT NOT NULL, role TEXT NOT NULL, version INTEGER NOT NULL, spec TEXT NOT NULL, PRIMARY KEY(domain,role,version));
      CREATE TABLE IF NOT EXISTS outcome_agent_bundles(domain TEXT NOT NULL,role TEXT NOT NULL,release INTEGER NOT NULL,hash TEXT NOT NULL,applied_version INTEGER,PRIMARY KEY(domain,role,release))`);
    transaction(db,()=>{for (const profile of registry.domainAgents()) this.upgrade(profile);});
  }
  private latest(domain:string,role:string) {
    const saved=this.db.prepare("SELECT spec FROM outcome_agent_roles WHERE domain=? AND role=? ORDER BY version DESC LIMIT 1").get(domain,role);
    return saved ? readRole(saved.spec) : null;
  }
  private insert(role:DomainRole) {
    this.db.prepare("INSERT INTO outcome_agent_roles VALUES(?,?,?,?)").run(role.domain,role.role,role.version,JSON.stringify(role));
    return role;
  }
  private upgrade(profile:DomainAgent) {
    const {domain,role,version,hash}=profile;
    const seen=this.db.prepare("SELECT release,hash FROM outcome_agent_bundles WHERE domain=? AND role=? ORDER BY release DESC LIMIT 1").get(domain,role);
    if (seen && typeof seen.release==="number" && seen.release>=version) {
      if (seen.release===version && seen.hash!==hash) throw Error("Increment the bundled version after changing "+profile.id+".");
      return;
    }
    const current=this.latest(domain,role);
    const isLegacyDefault=!!current && current.version===1 && !current.origin && current.hash===profile.legacyHash;
    let applied:number|null=null;
    if (!current || current.origin==="bundle" || isLegacyDefault) {
      const next=roleSpec(profile,(current?.version ?? 0)+1,profile.instructions,"bundle",agentPin(profile));
      if (isLegacyDefault && !seen && current && current.hash===next.hash && version===1) applied=current.version;
      else applied=this.insert(next).version;
    }
    this.db.prepare("INSERT INTO outcome_agent_bundles VALUES(?,?,?,?,?)").run(domain,role,version,hash,applied);
  }
  roles():DomainRole[] {
    return this.registry.domainAgents().map((profile):DomainRole=>{
      const current=this.latest(profile.domain,profile.role);
      if (!current) throw Error("Missing role for "+profile.id);
      if (current.origin) return current;
      if (current.version===1 && current.hash===profile.legacyHash) {
        const link=this.db.prepare("SELECT hash FROM outcome_agent_bundles WHERE domain=? AND role=? AND applied_version=? AND release=?").get(current.domain,current.role,current.version,profile.version);
        if (link?.hash===profile.hash) return {...current,origin:"bundle",bundle:agentPin(profile)};
      }
      return {...current,origin:"local"};
    }).sort((a,b)=>a.domain.localeCompare(b.domain)||a.role.localeCompare(b.role));
  }
  save(value:unknown):DomainRole {
    if (!isRecord(value) || !isDomain(value.domain) || (value.role!=="expert" && value.role!=="implementer")) throw Error("Choose an existing domain agent.");
    const {domain,role,instructions,expectedVersion}=value;
    if (typeof instructions!=="string" || !instructions.trim() || instructions.length>12000) throw Error("Agent instructions must contain 1–12,000 characters.");
    return transaction(this.db,()=>{
      const current=this.roles().find(p=>p.domain===domain&&p.role===role);
      if (!current || current.version!==expectedVersion) throw Error("This agent changed. Refresh its instructions before saving.");
      const updated=instructions.trim();
      return current.instructions===updated ? current : this.insert(roleSpec(current,current.version+1,updated,"local",current.bundle));
    });
  }
}
