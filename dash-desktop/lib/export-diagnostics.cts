import type {RunDetail} from "./run-types.cjs";

// Older compatible providers could include arbitrary response text in an exception.
// Preserve case evidence and scores; only the diagnostic and its report copies are projected.
export function publicProviderError(error:string):string {
  return /^Model endpoint returned HTTP [1-5]\d{2}$/.test(error) ? error : "Model endpoint did not return a confirmed successful response.";
}

export function exportDiagnostics(run:Pick<RunDetail,"manifest"|"results"|"report">) {
  const remote = new Set(run.manifest.candidates.filter(c=>c.provider==="compatible").map(c=>c.id));
  const failures = new Map<string, Map<string,string>>();
  const results = run.results.map(result=>{
    if (!result.error || !remote.has(result.candidateId)) return result;
    const error=publicProviderError(result.error);
    const cases=failures.get(result.candidateId) ?? new Map<string,string>();
    cases.set(result.caseId,error);
    failures.set(result.candidateId,cases);
    return {...result,error};
  });
  if (!run.report || !failures.size) return {report:run.report,results};
  const metrics=run.report.metrics.map(metric=>({...metric,caseScores:metric.caseScores.map(row=>
    ({...row,values:row.values.map(value=>{
      const reason=failures.get(value.candidateId)?.get(row.caseId);
      return reason && value.score===null ? {...value,reason} : value;
    })})
  )}));
  return {results,report:{...run.report,metrics}};
}
