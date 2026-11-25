import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join, dirname, relative, isAbsolute } from "node:path";

export const domains = ["Financial Services", "Manufacturing", "General"] as const;
export type Domain = typeof domains[number];
export type Role = "expert" | "implementer";
export interface Source { title:string; url:string }
export interface AgentPin { id:string; version:number; path:string; hash:string }
export interface AgentDefinition extends AgentPin {
  instructions:string;
  sources:Source[];
  domain?:Domain;
  role?:Role;
  legacyHash?:string;
}
export interface DomainAgent extends AgentDefinition { domain:Domain; role:Role }
export interface AgentRegistry {
  get(id:string):AgentDefinition;
  domainAgents():DomainAgent[];
}
export function isDomain(value:unknown):value is Domain {
  return domains.some(domain => domain === value);
}
export function isRecord(value:unknown):value is Record<string,unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function readSources(value:unknown):Source[] {
  if (!Array.isArray(value)) throw Error("An agent source list must be an array.");
  return value.map((entry:unknown) => {
    if (!isRecord(entry) || typeof entry.title !== "string" || !entry.title.trim() || typeof entry.url !== "string" ||
        !/^https?:\/\//.test(entry.url)) throw Error("An agent reference requires a title and HTTP source URL.");
    return {title:entry.title,url:entry.url};
  });
}
export function agentPin({id,version,path,hash}:AgentPin):AgentPin { return {id,version,path,hash}; }
export function decodeAgentPin(value:unknown):AgentPin {
  if (!isRecord(value) || typeof value.id!=="string" || typeof value.version!=="number" || !Number.isSafeInteger(value.version) ||
      value.version<1 || typeof value.path!=="string" || typeof value.hash!=="string" || !/^[a-f0-9]{64}$/.test(value.hash))
    throw Error("Invalid saved agent provenance.");
  return {id:value.id,version:value.version,path:value.path,hash:value.hash};
}

export function readAgentRegistry(directory = __dirname):AgentRegistry {
  const root = realpathSync(directory);
  const raw:unknown = JSON.parse(readFileSync(join(root,"manifest.json"), "utf8"));
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.agents))
    throw Error("Invalid DASH agent manifest. Expected schemaVersion 1 and an agents array.");
  const definitions = new Map<string,AgentDefinition>();
  const roles = new Map<string,DomainAgent>();
  function readPrompt(path:unknown):string {
    if(typeof path!=="string" || !/^prompts\/[a-z0-9-]+\.md$/.test(path))throw Error("Invalid bundled Markdown path.");
    const resolved=realpathSync(join(root,path));
    const rel=relative(root,resolved);
    if(isAbsolute(rel) || dirname(rel)!=="prompts")throw Error("Agent Markdown must be inside the bundled prompts directory.");
    const source=readFileSync(resolved,"utf8").replace(/\r\n/g,"\n").trim();
    if(!source || source.length>12000)throw Error("Bundled Markdown must contain 1–12,000 characters.");
    return source;
  }
  const entries:unknown[] = raw.agents;
  for (const item of entries) {
    if (!isRecord(item)) throw Error("Invalid agent manifest entry.");
    const {id,version,path,domain,role,legacyHash} = item;
    if (typeof id !== "string" || !/^[a-z][a-z0-9-]{0,99}$/.test(id) || definitions.has(id) ||
        typeof version !== "number" || !Number.isSafeInteger(version) || version < 1 ||
        typeof path !== "string" || !/^prompts\/[a-z0-9-]+\.md$/.test(path))
      throw Error("Invalid or duplicate agent identity, version or Markdown path: " + String(id));
    const roleInstructions=readPrompt(path);
    const instructions=item.guidance===undefined ? roleInstructions : roleInstructions+"\n\n"+readPrompt(item.guidance);
    if (!instructions || instructions.length > 12000) throw Error(id + " needs 1–12,000 characters of instructions.");
    const sources = readSources(item.sources ?? []);
    const hash = createHash("sha256").update(JSON.stringify({id,version,path,domain,role,sources,instructions,...(item.guidance!==undefined && {guidance:item.guidance})})).digest("hex");
    const base = {id,version,path,hash,instructions,sources};
    if (domain !== undefined || role !== undefined) {
      if (!isDomain(domain) || (role !== "expert" && role !== "implementer")) throw Error("Invalid domain role for " + id);
      if (legacyHash !== undefined && (typeof legacyHash !== "string" || !/^[a-f0-9]{64}$/.test(legacyHash))) throw Error("Invalid legacy role hash.");
      const key = domain + "/" + role;
      if (roles.has(key)) throw Error("Duplicate agent role: " + key);
      const entry = {...base,domain,role,...(typeof legacyHash === "string" && {legacyHash})} satisfies DomainAgent;
      roles.set(key,entry);
      definitions.set(id,entry);
    } else definitions.set(id,base);
  }
  for (const required of ["workflow-metric-auditor","grader-designer","report-analyzer","report-reporter","workflow-router","workflow-expert","workflow-implementer","workflow-expert-assignment","workflow-implementer-assignment","prompt-guide"])
    if (!definitions.has(required)) throw Error("Missing bundled agent " + required);
  for (const domain of domains) for (const role of ["expert","implementer"])
    if (!roles.has(domain + "/" + role)) throw Error("Missing bundled agent for " + domain + "/" + role);
  return {
    get(id) {
      const entry = definitions.get(id);
      if (!entry) throw Error("Unknown DASH agent " + id);
      return structuredClone(entry);
    },
    domainAgents:() => structuredClone([...roles.values()]),
  };
}
export const bundledAgents = readAgentRegistry();
export function loadAgent(id:string):AgentDefinition { return bundledAgents.get(id); }
