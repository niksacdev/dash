const {test} = require("node:test");
const assert = require("node:assert/strict");
const {Bench, replayCandidate} = require("../lib/bench.cjs");

test("earnings replay keeps the pre-TypeScript scoring policy and measured case outcomes", async t => {
  const bench = new Bench(":memory:");
  t.after(()=>bench.db.close());
  const snapshot = bench.list().datasets.find(d=>d.pack==="earnings" && d.origin==="bundled");
  const id=bench.start({mode:"dataset",datasetId:snapshot.id,candidateIds:[replayCandidate.id]});
  await bench.active.done;
  const saved=bench.exportRun(id);
  assert.equal(saved.status,"completed");
  // Captured from the original JavaScript earnings pack, scorer source and empty custom grader list.
  assert.equal(saved.manifest.policyHash,"b07e0eff41727beec19b3a8458adbe2a9c283ba77f6caf7a857f8077fc486a9b");
  assert.equal(saved.results.length,8);
  assert.deepEqual(saved.results.map(result=>result.score.pass),[true,false,true,true,true,true,true,true]);
});

test("detail preserves absent historical template, domain and guardrail observations",async t=>{
  const bench=new Bench(":memory:");
  t.after(()=>bench.db.close());
  const snapshot=bench.list().datasets.find(d=>d.pack==="earnings"&&d.origin==="bundled");
  const id=bench.start({mode:"dataset",datasetId:snapshot.id,candidateIds:[replayCandidate.id]});
  await bench.active.done;
  const saved=bench.detail(id), manifest=saved.manifest, result=saved.results[0];
  manifest.format=1;
  delete manifest.invocations[0].template;
  delete manifest.datasetMetadata.industry;
  result.guardrail={status:"unverified",requestedInputCap:null,requestedOutputCap:null,inputTokens:null,contextTokens:null,
    outputReserve:512,source:"Provider",message:"Capacity unreported."};
  result.trace.steps.push({at:result.trace.started,action:"Check model capacity",guardrail:result.guardrail});
  const rawManifest=JSON.stringify(manifest),rawResult=JSON.stringify(result);
  bench.db.prepare("UPDATE runs SET manifest=? WHERE id=?").run(rawManifest,id);
  bench.db.prepare("UPDATE results SET record=? WHERE run=? AND case_id=?").run(rawResult,id,result.caseId);
  const opened=bench.detail(id);
  assert.equal(opened.manifest.format,1);
  assert.equal(Object.hasOwn(opened.manifest.invocations[0],"template"),false);
  assert.equal(Object.hasOwn(opened.manifest.datasetMetadata,"industry"),false);
  assert.deepEqual(opened.results[0].guardrail,result.guardrail);
  assert.equal(bench.db.prepare("SELECT manifest FROM runs WHERE id=?").get(id).manifest,rawManifest);
});
