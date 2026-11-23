import type { DatabaseSync } from "node:sqlite";
import { hash } from "./packs.cjs";
import { isRecord, type CompatibleCandidate, type EndpointSection } from "./runtime-types.cjs";

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
function endpointDefinition(value: unknown): CompatibleCandidate {
  if (!isRecord(value) || value.provider !== "compatible" || typeof value.id !== "string" ||
      typeof value.model !== "string" || !value.model.trim() || typeof value.endpoint !== "string" || !isSection(value.section))
    throw Error("Saved endpoint has an invalid definition.");
  return { id:value.id, provider:"compatible", kind:"model", model:value.model, endpoint:apiBase(value.endpoint),
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
    const id = "compatible/" + hash([endpoint, model]);
    const old = this.list().find(c => c.id === id);
    const c: CompatibleCandidate = { id, model, provider:"compatible", kind:"model", section:value.section,
      endpoint, revision:null, keyRequired:!!value.key || !!old?.keyRequired };
    this.db.prepare("INSERT INTO model_endpoints VALUES(?,?) ON CONFLICT(id) DO UPDATE SET definition=excluded.definition").run(id, JSON.stringify(c));
    if (value.key) this.keys.set(id,value.key);
    return id;
  }
  list(): CompatibleCandidate[] {
    return this.db.prepare("SELECT definition FROM model_endpoints ORDER BY rowid").all().map(row => {
      if (typeof row.definition !== "string") throw Error("Saved endpoint has an invalid definition.");
      const c = endpointDefinition(JSON.parse(row.definition));
      return { ...c, needsKey:c.keyRequired && !this.keys.has(c.id) };
    });
  }
}
