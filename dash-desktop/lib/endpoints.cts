import type { DatabaseSync } from "node:sqlite";
import { hash } from "./packs.cjs";
import { isRecord, supportsScenarioCache, type CompatibleCandidate, type EndpointSection } from "./runtime-types.cjs";

function isSection(value: unknown): value is EndpointSection {
  return value === "Frontier Labs" || value === "Fine-tuned" || value === "Hosted";
}
function apiBase(base: string): string {
  const url = new URL(base);
  const local = ["localhost","127.0.0.1","[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash)
    throw Error("Use an HTTPS API base, or HTTP on localhost. Put credentials in the session key field.");
  return url.href.replace(/\/+$/, "");
}
function cachePreference(endpoint:string, model:string, enabled:unknown):boolean {
  if (enabled === undefined || enabled === false) return false;
  if (enabled !== true || !supportsScenarioCache(endpoint,model))
    throw Error("Shared-instruction caching requires a supported Anthropic Claude model on the OpenRouter API.");
  return true;
}
function endpointId(endpoint:string,model:string):string {
  return "compatible/" + hash([endpoint,model]);
}
function endpointDefinition(rowId:unknown,value: unknown): CompatibleCandidate {
  if (!isRecord(value) || value.provider !== "compatible" || typeof value.id !== "string" ||
      typeof value.model !== "string" || !value.model.trim() || typeof value.endpoint !== "string" || !isSection(value.section) ||
      (value.cacheScenarioInstructions !== undefined && typeof value.cacheScenarioInstructions !== "boolean"))
    throw Error("Saved endpoint has an invalid definition.");
  const endpoint = apiBase(value.endpoint);
  if (rowId!==value.id || value.id!==endpointId(endpoint,value.model))
    throw Error("A saved endpoint no longer matches its registered model and address. Check the endpoint configuration before running.");
  return { id:value.id, provider:"compatible", kind:"model", model:value.model, endpoint,
    // A retired cache policy must not make the endpoint inventory or older runs unreadable.
    ...(value.cacheScenarioInstructions && supportsScenarioCache(endpoint,value.model) && {cacheScenarioInstructions:true}),
    section:value.section, revision:typeof value.revision === "string" ? value.revision : null, keyRequired:value.keyRequired === true };
}
export class Endpoints {
  readonly keys = new Map<string, string>();
  constructor(private readonly db: DatabaseSync) {
    db.exec("CREATE TABLE IF NOT EXISTS model_endpoints(id TEXT PRIMARY KEY, definition TEXT NOT NULL)");
  }
  save(value: unknown): string {
    if (!isRecord(value) || !isSection(value.section) || typeof value.model !== "string" ||
        !value.model.trim() || value.model.length > 240 || typeof value.baseUrl !== "string" || value.baseUrl.length > 1000 ||
        typeof value.key !== "string" || value.key.length > 8192 || /[\r\n]/.test(value.key))
      throw Error("Enter a model, a valid API base and a session key if required.");
    const endpoint = apiBase(value.baseUrl), model = value.model.trim();
    const id = endpointId(endpoint,model);
    const old = this.list().find(c => c.id === id);
    const cache = cachePreference(endpoint, model, value.cacheScenarioInstructions === undefined ? old?.cacheScenarioInstructions : value.cacheScenarioInstructions);
    const c: CompatibleCandidate = { ...(cache && {cacheScenarioInstructions:true}), id, model, provider:"compatible", kind:"model", section:value.section,
      endpoint, revision:null, keyRequired:!!value.key || !!old?.keyRequired };
    this.db.prepare("INSERT INTO model_endpoints VALUES(?,?) ON CONFLICT(id) DO UPDATE SET definition=excluded.definition").run(id, JSON.stringify(c));
    if (value.key) this.keys.set(id,value.key);
    return id;
  }
  list(): CompatibleCandidate[] {
    return this.db.prepare("SELECT id,definition FROM model_endpoints ORDER BY rowid").all().map(row => {
      if (typeof row.definition !== "string") throw Error("Saved endpoint has an invalid definition.");
      const c = endpointDefinition(row.id,JSON.parse(row.definition));
      return { ...c, needsKey:c.keyRequired && !this.keys.has(c.id) };
    });
  }
}
