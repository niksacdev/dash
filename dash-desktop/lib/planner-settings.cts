import type {DatabaseSync} from "node:sqlite";
import {isRecord} from "../agents/registry.cjs";
interface EndpointStore { list(): {id:string;model:string;endpoint?:string}[]; keys:ReadonlyMap<string,string> }
export interface FallbackConfig {model:string;apiKey:string}
export class PlannerSettings {
  private sessionKey = "";
  constructor(private readonly db:DatabaseSync, private readonly endpoints:EndpointStore, private readonly env:NodeJS.ProcessEnv=process.env) {
    db.exec("CREATE TABLE IF NOT EXISTS planner_fallback (singleton INTEGER PRIMARY KEY CHECK(singleton=1), enabled INTEGER NOT NULL, model TEXT NOT NULL)");
  }
  private config() {
    const saved = this.db.prepare("SELECT enabled,model FROM planner_fallback WHERE singleton=1").get();
    if (saved && (typeof saved.model!=="string" || (saved.enabled!==1 && saved.enabled!==0))) throw Error("Invalid saved planner fallback.");
    const registered = this.endpoints.list().filter(c=>c.endpoint === "https://api.openai.com/v1");
    const model = (typeof saved?.model==="string" && saved.model) || this.env.DASH_OPENAI_PLANNER_MODEL || registered[0]?.model || "gpt-4.1-mini";
    const endpoint = registered.find(c=>c.model===model);
    const key = this.sessionKey || this.env.OPENAI_API_KEY || (endpoint && this.endpoints.keys.get(endpoint.id)) || "";
    return {model, enabled:saved?.enabled === 1, key};
  }
  status() {
    const {model,enabled,key} = this.config();
    return {model, enabled, hasKey:!!key};
  }
  fallback():FallbackConfig|null {
    const {model,enabled,key} = this.config();
    return enabled && key ? {model,apiKey:key} : null;
  }
  save(value:unknown) {
    if (!isRecord(value)) throw Error("Invalid planner settings.");
    const {model,enabled,key=""}=value;
    if (typeof enabled !== "boolean" || typeof model !== "string" || !/^[a-zA-Z0-9][\w.:/-]{0,180}$/.test(model) ||
        typeof key !== "string" || key.length>8192 || /[\r\n]/.test(key)) throw Error("Enter a valid OpenAI model ID and session key.");
    this.db.prepare("INSERT INTO planner_fallback VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET enabled=excluded.enabled,model=excluded.model").run(Number(enabled),model);
    if (key) this.sessionKey=key.trim();
    return this.status();
  }
}
