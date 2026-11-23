class PlannerSettings {
  constructor(db, endpoints, env = process.env) {
    this.db = db;
    this.endpoints = endpoints;
    this.env = env;
    this.sessionKey = "";
    db.exec("CREATE TABLE IF NOT EXISTS planner_fallback (singleton INTEGER PRIMARY KEY CHECK(singleton=1), enabled INTEGER NOT NULL, model TEXT NOT NULL)");
  }
  config() {
    const saved = this.db.prepare("SELECT enabled,model FROM planner_fallback WHERE singleton=1").get();
    const registered = this.endpoints.list().filter(c=>c.endpoint === "https://api.openai.com/v1");
    const model = saved?.model || this.env.DASH_OPENAI_PLANNER_MODEL || registered[0]?.model || "gpt-4.1-mini";
    const key = this.sessionKey || this.env.OPENAI_API_KEY || this.endpoints.keys.get(registered.find(c=>c.model===model)?.id) || "";
    return {model, enabled:saved ? !!saved.enabled : !!key, key};
  }
  status() {
    const {model,enabled,key} = this.config();
    return {model, enabled, hasKey:!!key};
  }
  fallback() {
    const {model,enabled,key} = this.config();
    return enabled && key ? {model,apiKey:key} : null;
  }
  save({model, enabled, key=""}) {
    if (typeof enabled !== "boolean" || typeof model !== "string" || !/^[a-zA-Z0-9][\w.:/-]{0,180}$/.test(model) ||
        typeof key !== "string" || key.length>8192 || /[\r\n]/.test(key)) throw Error("Enter a valid OpenAI model ID and session key.");
    this.db.prepare("INSERT INTO planner_fallback VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET enabled=excluded.enabled,model=excluded.model").run(Number(enabled),model);
    if (key) this.sessionKey=key.trim();
    return this.status();
  }
}
module.exports={PlannerSettings};
