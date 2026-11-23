const {hash}=require("./packs.cjs");
class Endpoints {
  constructor(db) {
    this.db=db;
    this.keys=new Map();
    db.exec("CREATE TABLE IF NOT EXISTS model_endpoints(id TEXT PRIMARY KEY, definition TEXT NOT NULL)");
  }
  save(value) {
    const {section, model, baseUrl, key} = value || {};
    if(!["Frontier Labs","Fine-tuned","Hosted"].includes(section) || typeof model!=="string" ||
      !model.trim() || model.length>240 || typeof baseUrl!=="string" || baseUrl.length>1000 ||
      typeof key!=="string" || key.length>8192 || /[\r\n]/.test(key))throw Error("Enter a model, a valid API base and a session key if required.");
    const url = new URL(baseUrl);
    const local = ["localhost","127.0.0.1","[::1]"].includes(url.hostname);
    if((url.protocol!=="https:" && !(local && url.protocol==="http:")) || url.username || url.password || url.search || url.hash)
      throw Error("Use an HTTPS API base, or HTTP on localhost. Put credentials in the session key field.");
    const endpoint=url.href.replace(/\/+$/,""), name=model.trim();
    const id="compatible/"+hash([endpoint,name]);
    const old=this.list().find(c=>c.id===id);
    const c={id, model:name, provider:"compatible", kind:"model", section, endpoint, revision:null, keyRequired:!!key || !!old?.keyRequired};
    this.db.prepare("INSERT INTO model_endpoints VALUES(?,?) ON CONFLICT(id) DO UPDATE SET definition=excluded.definition").run(id,JSON.stringify(c));
    if(key)this.keys.set(id,key);
    return id;
  }
  list() {return this.db.prepare("SELECT definition FROM model_endpoints ORDER BY rowid").all().map(r=>{
    const c=JSON.parse(r.definition);return {...c,needsKey:c.keyRequired&&!this.keys.has(c.id)};
  });}
}
module.exports={Endpoints};
