import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Bench } from "../lib/bench.cjs";
import { Catalog } from "../lib/catalog.cjs";

const family = {family:"Operator QA",category:"Review",source:"Synthetic",tags:[]};

test("imports scope family versions and parent choices to their industry", t => {
  const bench = new Bench(":memory:");
  t.after(() => bench.db.close());
  function save(industry:string, version:string, prompt:string, parentId?:string) {
    const row = {case_id:"case-1",dataset_version:version,split:"holdout",prompt,reference:"review"};
    return bench.import("reference", "Operator QA", JSON.stringify(row), {
      ...family, industry, parentId, changeNote:parentId ? "Add a second case variant." : ""
    });
  }
  const finance = save("Financial Services","1","Review EPS.");
  const manufacturing = save("Manufacturing","1","Review the lot.");
  assert.notEqual(finance,manufacturing);
  assert.throws(()=>save("Manufacturing","2","Review the drawing.",finance),/same industry/);
  assert.throws(()=>save("MANUFACTURING","1","Review another lot."),/already contains/);
  assert.equal(bench.db.prepare("SELECT COUNT(*) AS n FROM datasets WHERE pack='reference'").get()?.n,2);
  const child = save("manufacturing","2","Review the drawing.",manufacturing);
  assert.equal(bench.dataset(child).metadata.parentId,manufacturing);
  assert.equal(bench.dataset(finance).metadata.industry,"Financial Services");
});

function legacyCatalog() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE datasets(id TEXT PRIMARY KEY,pack TEXT,name TEXT,rows TEXT);
    CREATE TABLE dataset_catalog(dataset_id TEXT PRIMARY KEY REFERENCES datasets(id),pack TEXT NOT NULL,
      family_key TEXT NOT NULL,version TEXT NOT NULL,split TEXT NOT NULL,metadata TEXT NOT NULL,
      origin TEXT NOT NULL,UNIQUE(pack,family_key,version,split))`);
  return db;
}

test("upgrading preserves snapshots, old parent links, raw metadata and run references across reopen", t => {
  const db = legacyCatalog();
  t.after(()=>db.close());
  db.exec("CREATE TABLE runs(id TEXT PRIMARY KEY,manifest TEXT)");
  const saved = JSON.stringify({...family,industry:"Financial Services",parentId:null,changeNote:""}, null, 2);
  const olderMetadata = JSON.stringify({...family,industry:"Robotics",category:"",oldField:"preserve"});
  const existing = [
    ["finance","reference","1",saved,"import"],
    ["factory","reference","2",JSON.stringify({...family,industry:"Manufacturing",parentId:"finance",changeNote:"Earlier link."}),"import"],
    ["old-seed","earnings","1",JSON.stringify(family),"bundled"],
    ["old-schema","reference","0",olderMetadata,"legacy"]
  ];
  for (const [id,pack,version,raw,origin] of existing) {
    db.prepare("INSERT INTO datasets VALUES(?,?,?,?)").run(id,pack,"Old dataset","[]");
    db.prepare("INSERT INTO dataset_catalog VALUES(?,?,?,?,?,?,?)").run(id,pack,"operator qa",version,"holdout",raw,origin);
  }
  const uncatalogedRows = JSON.stringify([{case_id:"old-1",dataset_version:"3",split:"test",prompt:"Review."}]);
  db.prepare("INSERT INTO datasets VALUES('uncataloged','reference','Legacy family',?)").run(uncatalogedRows);
  const manifest = JSON.stringify({datasetId:"factory",parentId:"old-run"},null,2);
  db.prepare("INSERT INTO runs VALUES('run-id',?)").run(manifest);
  for (let open=0; open<2; open++) {
    const catalog = new Catalog(db,[]);
    assert.equal(catalog.get("factory")?.parentId,"finance");
    assert.equal(catalog.get("old-seed")?.industry,"Financial Services");
    assert.equal(catalog.get("uncataloged")?.industry,"Unclassified");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dataset_catalog").get()?.n,5);
    assert.equal(db.prepare("SELECT metadata FROM dataset_catalog WHERE dataset_id='finance'").get()?.metadata,saved);
    assert.equal(db.prepare("SELECT metadata FROM dataset_catalog WHERE dataset_id='old-schema'").get()?.metadata,olderMetadata);
    assert.equal(db.prepare("SELECT manifest FROM runs WHERE id='run-id'").get()?.manifest,manifest);
    assert.equal(db.prepare("SELECT rows FROM datasets WHERE id='uncataloged'").get()?.rows,uncatalogedRows);
  }
});

test("an interrupted migration rolls back the table replacement and can retry", t => {
  const db = legacyCatalog();
  t.after(()=>db.close());
  db.exec(`INSERT INTO datasets VALUES('original','reference','Imported cases','[]');
    INSERT INTO dataset_catalog VALUES('original','reference','operator qa','1','holdout','{broken','import')`);
  assert.throws(()=>new Catalog(db,[]),SyntaxError);
  assert.equal(db.prepare("SELECT metadata FROM dataset_catalog WHERE dataset_id='original'").get()?.metadata,"{broken");
  assert.equal(db.prepare("PRAGMA table_info(dataset_catalog)").all().some(c=>c.name==="industry_key"),false);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='dataset_catalog_before_industry'").get(),undefined);
  db.prepare("UPDATE dataset_catalog SET metadata=? WHERE dataset_id='original'").run(JSON.stringify(family));
  assert.equal(new Catalog(db,[]).get("original")?.industry,"Unclassified");
});
