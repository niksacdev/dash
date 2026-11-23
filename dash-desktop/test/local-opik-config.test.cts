import { test } from "node:test";
import assert = require("node:assert/strict");
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localOpikEnvironment } from "../lib/local-opik-config.cjs";

test("a successful DASH-managed setup selects only the fixed loopback destination", t=>{
  const dir=mkdtempSync(join(tmpdir(),"dash-local-opik-"));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const marker=join(dir,"connection.json");
  const cloud={OPIK_API_KEY:"synthetic",OPIK_WORKSPACE:"elsewhere"};
  assert.equal(localOpikEnvironment(cloud,marker),cloud);
  for (const value of ["{}", "broken", '{"port":51735,"version":1}']) {
    writeFileSync(marker,value);
    assert.equal(localOpikEnvironment(cloud,marker),cloud);
  }
  writeFileSync(marker,JSON.stringify({port:51734,version:1,url:"https://example.invalid"}));
  const actual=localOpikEnvironment(cloud,marker);
  assert.equal(actual.DASH_OPIK_API_URL,"http://127.0.0.1:51734/api");
  assert.equal(actual.OPIK_WORKSPACE,"default");
  assert.equal(actual.OPIK_API_KEY,undefined);
  const explicit={...cloud,DASH_OPIK_API_URL:"http://localhost:6000/api"};
  assert.equal(localOpikEnvironment(explicit,marker),explicit);
});
