import type {DatabaseSync} from "node:sqlite";
import type {Candidate} from "./runtime-types.cjs";
import {stringValue,statusValue} from "./run-types.cjs";
import {decodeManifest} from "./run-decode.cjs";
interface ChartSample {candidate:string;error:number|null;pass:number|null;review:number|null;latency:number|null;input:number|null;output:number|null;watts:number|null}
const charts:{candidateMetrics(c:Candidate[],r:ChartSample[]):UiCandidateMetrics[]}=require("../ui/performance-summary.js");
function numberOrMissing(value:unknown):number|null {
  if(value==null) return null;
  if(typeof value!=="number"||!Number.isFinite(value))throw Error("Invalid numeric sample in the run database.");
  return value;
}
// Only the columns used for charts cross SQLite's JSON boundary.
function count(value:unknown):number {
  if(typeof value!=="number"||!Number.isSafeInteger(value)||value<0)throw Error("Invalid case count in run history.");
  return value;
}
function records(db:DatabaseSync, run:string):ChartSample[] {
  return db.prepare(`SELECT candidate, (json_extract(record,'$.error') IS NOT NULL AND json_extract(record,'$.dispatchState') IS NULL) AS error,
    json_extract(record,'$.score.pass') AS pass, json_extract(record,'$.score.review') AS review,
    json_extract(record,'$.telemetry.latency_ms') AS latency, json_extract(record,'$.telemetry.device_power.average_w') AS watts,
    json_extract(record,'$.telemetry.input_tokens') AS input,
    json_extract(record,'$.telemetry.output_tokens') AS output FROM results WHERE run=? AND json_extract(record,'$.dispatchState') IS NOT 'pending'`).all(run).map(r=>({candidate:stringValue(r.candidate),error:numberOrMissing(r.error),pass:numberOrMissing(r.pass),review:numberOrMissing(r.review),latency:numberOrMissing(r.latency),input:numberOrMissing(r.input),output:numberOrMissing(r.output),watts:numberOrMissing(r.watts)}));
}
export function performance(db:DatabaseSync, id:string) {
  const row = db.prepare("SELECT status,manifest FROM runs WHERE id=?").get(id);
  if (!row) throw Error("Run not found");
  const m = decodeManifest(row.manifest);
  const results = records(db,id);
  const candidates = charts.candidateMetrics(m.candidates, results);
  let history: {id:string;created:string;scores:{candidate:string;scored:number;passed:number|null}[]}[] = [];
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
    history = comparable.reverse().map(run => ({id:stringValue(run.id),created:stringValue(run.created),scores:scores.all(run.id).map(s=>({candidate:stringValue(s.candidate),scored:count(s.scored),passed:numberOrMissing(s.passed)}))}));
  }
  return { id, title: m.title, created: m.created, status: statusValue(row.status), fixture: m.fixture, mode: m.mode,
    datasetId: m.datasetId, version: m.datasetVersion, split: m.split, perCandidate: m.caseIds.length, candidates, history };
}
