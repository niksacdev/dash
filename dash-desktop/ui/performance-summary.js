"use strict";
function candidateMetrics(candidates, records) {
  const sorted = values => values.filter(x => Number.isFinite(x) && x >= 0).sort((a,b)=>a-b);
  const percentile = (values,p) => values.length ? values[Math.ceil(values.length*p)-1] : null;
  const average = values => values.length ? values.reduce((a,b)=>a+b,0)/values.length : null;
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
if (typeof module !== "undefined") module.exports = { candidateMetrics };
