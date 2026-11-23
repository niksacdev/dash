const { candidateMetrics } = require("../ui/performance-summary.js");
// Only the columns used for charts cross SQLite's JSON boundary.
function records(db, run) {
  return db.prepare(`SELECT candidate, json_extract(record,'$.error') IS NOT NULL AS error,
    json_extract(record,'$.score.pass') AS pass, json_extract(record,'$.score.review') AS review,
    json_extract(record,'$.telemetry.latency_ms') AS latency, json_extract(record,'$.telemetry.device_power.average_w') AS watts,
    json_extract(record,'$.telemetry.input_tokens') AS input,
    json_extract(record,'$.telemetry.output_tokens') AS output FROM results WHERE run=?`).all(run);
}
function performance(db, id) {
  const row = db.prepare("SELECT status,manifest FROM runs WHERE id=?").get(id);
  if (!row) throw Error("Run not found");
  const m = JSON.parse(row.manifest);
  const results = records(db,id);
  const candidates = candidateMetrics(m.candidates, results);
  let history = [];
  if (m.mode === "dataset" && m.datasetId && m.caseSetHash && m.policyHash && m.promptHash) {
    const comparable = db.prepare(`SELECT id,created FROM runs WHERE status='completed' AND created<=?
      AND json_extract(manifest,'$.datasetId')=? AND json_extract(manifest,'$.caseSetHash')=?
      AND json_extract(manifest,'$.policyHash')=? AND json_extract(manifest,'$.promptHash')=?
      AND json_extract(manifest,'$.fixture')=? AND EXISTS (SELECT 1 FROM json_each(runs.manifest,'$.candidates') c
        WHERE json_extract(c.value,'$.id') IN (SELECT value FROM json_each(?)))
      ORDER BY created DESC, rowid DESC LIMIT 8`).all(m.created,m.datasetId,m.caseSetHash,m.policyHash,
        m.promptHash,Number(m.fixture),JSON.stringify(candidates.map(c=>c.id)));
    const scores = db.prepare(`SELECT candidate, COUNT(json_extract(record,'$.score.pass')) AS scored,
      SUM(json_extract(record,'$.score.pass')) AS passed FROM results WHERE run=? GROUP BY candidate`);
    history = comparable.reverse().map(run => ({ ...run, scores: scores.all(run.id) }));
  }
  return { id, title: m.title, created: m.created, status: row.status, fixture: m.fixture, mode: m.mode,
    datasetId: m.datasetId, version: m.datasetVersion, split: m.split, perCandidate: m.caseIds.length, candidates, history };
}
module.exports = { performance };
