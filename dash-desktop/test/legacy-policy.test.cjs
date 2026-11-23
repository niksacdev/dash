const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Bench, replayCandidate } = require("../lib/bench.cjs");

// Captured from an unmodified 17f6dc6e1be777c16a00ee5e182c22c9ebfa99a8
// Bench replay on a new synthetic profile. Reusing the canonical pack here
// detects a compiler/refactor changing snapshots or scorer identities.
test("compiled Manufacturing replay retains the pre-TypeScript policy, prompt and case identities", async t => {
  const bench = new Bench(":memory:");
  t.after(() => bench.db.close());
  const datasetId = "manufacturing-72164523cd480f55d53d75318e78e7e92339985095e95cb32722dff049618ef7";
  const id = bench.start({ mode:"dataset", datasetId, candidateIds:[replayCandidate.id] });
  await bench.active.done;
  const run = bench.exportRun(id);
  assert.equal(run.status, "completed");
  assert.equal(run.manifest.caseSetHash, "72164523cd480f55d53d75318e78e7e92339985095e95cb32722dff049618ef7");
  assert.equal(run.manifest.policyHash, "eac91f9418b60c322297095194d99b096b25f81ef12065ced93205057ff584f7");
  assert.equal(run.manifest.promptHash, "8d45b67dc13a412f472d0002b4f1a42a5bbea6c6653c7021beb6a8d8cd750c85");
  assert.deepEqual(run.results.map(r => [r.caseId, r.score.pass]), [
    ["bushing-within", true], ["pin-at-upper-limit", true], ["shim-unit-conversion", true],
    ["shaft-superseded-revision", false], ["washer-missing-rule", true],
  ]);
});
