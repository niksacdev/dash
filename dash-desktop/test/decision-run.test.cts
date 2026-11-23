import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { Bench, replayCandidate } from "../lib/bench.cjs";
import { present } from "./runtime-fixtures.cjs";

test("dataset execution pins the decision grader revision on case reruns and new evaluations can switch the model", async t => {
  const served: string[] = [];
  const aliases = ["decision-a", "decision-b"];
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url === "/v1/models") {
      response.end(JSON.stringify({data: aliases.map(id => ({id,architecture:{output_modalities:["decisions"]}}))}));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/systemone") {
      let raw = "";
      for await (const chunk of request) raw += chunk.toString();
      const data: unknown = JSON.parse(raw);
      assert.ok(data && typeof data === "object" && "model" in data && typeof data.model === "string");
      assert.ok(aliases.includes(data.model));
      served.push(data.model);
      const probability = data.model === aliases[0] ? 0.97 : 0.04;
      response.end(JSON.stringify({model:data.model,answers:{criterion:{type:"noul",noul:probability}}}));
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0,"127.0.0.1");
  await once(server,"listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const endpoint = "http://127.0.0.1:" + addr.port;
  const bench = new Bench(":memory:");
  t.after(() => bench.db.close());
  const dataset = present(bench.list().datasets.find(d => d.pack === "manufacturing"));
  const caseId = bench.dataset(dataset.id).rows[0].case_id;
  const rubric = {name:"Disposition supported",category:"Inspection",industry:"Manufacturing",type:"decision",
    criteria:"Does the candidate disposition match the supplied inspection evidence?",threshold:0.9,requiredEvidence:["reference"]};
  const save = (model:string) => bench.graders.save({...rubric,decision:{provider:"local",endpoint,model,failAt:0.1}},[]);
  const first = save(aliases[0]);
  const params = {mode:"dataset" as const,datasetId:dataset.id,candidateIds:[replayCandidate.id],caseId};
  const run = bench.start({...params,graderIds:[first]});
  await present(bench.active).done;
  assert.equal(bench.detail(run).status,"completed");
  assert.equal(bench.detail(run).assessments[0].value,1);
  const second = save(aliases[1]);
  assert.notEqual(first,second);
  const rerun = bench.start({...params,parentId:run});
  await present(bench.active).done;
  const fresh = bench.start({...params,graderIds:[second]});
  await present(bench.active).done;
  assert.deepEqual(served,[aliases[0],aliases[0],aliases[1]]);
  assert.equal(bench.exportRun(rerun).manifest.graders[0].id,first);
  assert.equal(bench.exportRun(rerun).assessments[0].decision?.actualModel,aliases[0]);
  assert.equal(bench.exportRun(fresh).assessments[0].value,0);
  assert.equal(bench.exportRun(fresh).assessments[0].decision?.probabilityYes,0.04);
  const hosted = bench.graders.save({...rubric,decision:{provider:"openrouter",model:"liquid/d1.2",failAt:0.1}},[]);
  assert.throws(() => bench.start({...params,graderIds:[hosted]}), /Confirm.*OpenRouter/);
  assert.equal(bench.active,null);
  // A saved consent flag documents the original action. A case rerun is a new disclosure.
  const parent = {...bench.detail(run).manifest, graders:[bench.graders.get(hosted)], hostedDecisionApproved:true};
  bench.db.prepare("UPDATE runs SET manifest=? WHERE id=?").run(JSON.stringify(parent),run);
  assert.throws(() => bench.start({...params,parentId:run}), /Confirm.*OpenRouter/);
  assert.equal(bench.list().runs.length,3);
});
