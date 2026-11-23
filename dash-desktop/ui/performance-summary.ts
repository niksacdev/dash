"use strict";
type UiPerformanceCandidate = Pick<UiCandidateMetrics, "id" | "model" | "provider">;

interface UiMeasurementRow {
  candidate: string;
  error?: string | boolean | number | null;
  pass?: boolean | number | null;
  review?: boolean | number | null;
  latency?: number | null;
  input?: number | null;
  output?: number | null;
  watts?: number | null;
}

function candidateMetrics(candidates: UiPerformanceCandidate[], records: UiMeasurementRow[]): UiCandidateMetrics[] {
  const sorted = (values: (number | null | undefined)[]) => values.filter((x): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0).sort((a,b)=>a-b);
  const percentile = (values: number[], p: number) => values.length ? values[Math.ceil(values.length*p)-1] : null;
  const average = (values: number[]) => values.length ? values.reduce((a,b)=>a+b,0)/values.length : null;
  return candidates.map(c=>{
    const cases = records.filter(r=>r.candidate===c.id);
    const scored = cases.filter(r=>r.pass!=null);
    const times=sorted(cases.map(r=>r.latency)), out=sorted(cases.map(r=>r.output)), inp=sorted(cases.map(r=>r.input));
    const watts=sorted(cases.map(r=>r.watts));
    return { id:c.id,model:c.model,provider:c.provider,recorded:cases.length,errors:cases.filter(r=>r.error).length,
      scored:scored.length,passed:scored.filter(r=>r.pass).length,review:scored.filter(r=>r.review).length,
      timed:times.length,p50:percentile(times,.5),p95:percentile(times,.95),input:average(inp),inputCount:inp.length,
      output:average(out),outputCount:out.length,watts:average(watts),powerCount:watts.length };
  });
}
// SQLite history and the legacy renderer fallback use the same aggregation.
declare const module: { exports: { candidateMetrics: typeof candidateMetrics } };
if (typeof module !== "undefined") module.exports = { candidateMetrics };
