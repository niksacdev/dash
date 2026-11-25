import {missingExpectedAnswer} from "./grading-errors.cjs";
import type {RecordedAssessment} from "./grader-types.cjs";
import type {RunDetail} from "./run-types.cjs";
import {httpGuidance,templateAdvice} from "./provider-errors.cjs";

const opaqueProviderError="Model endpoint did not return a confirmed successful response.";
const knownMessages=new Set([
  templateAdvice,
  "Preparation canceled before candidate inference was sent.",
  "Observation canceled after dispatch. The final candidate response is unknown.",
  "Observation interrupted after dispatch. The final candidate response is unknown.",
  "Dispatch was checkpointed without a final response. The final candidate response is unknown.",
  "Provider completed without visible response content.",
  "The runtime reported input usage above the approved cap.",
  "The local runtime could not verify the input token count. Check its connection and model template.",
  "Provider disconnected before completing the response",
  "Provider returned malformed JSON.",
  "Provider returned an invalid JSON object.",
  "Provider returned an empty response body.",
  "Provider returned an empty streaming response.",
  "Provider response exceeds the permitted size.",
  "Model provider reported an error during generation. Check the server activity before starting another request.",
  "LM Studio prediction failed. Check the model and server activity before starting another request.",
  "LM Studio input measurement timed out. Check the local runtime and retry.",
]);

// A saved provider string has lost its original error type. Rebuild status messages
// from finite fields; never forward trailing HTTP bodies or arbitrary SDK exceptions.
export function publicProviderError(error:string):string {
  if (knownMessages.has(error)) return error;
  const compatible=/^Model endpoint returned HTTP ([1-5]\d{2})(?=$|[.:\s])/.exec(error);
  if (compatible) return "Model endpoint returned HTTP "+compatible[1];
  const local=/^(LM Studio|Ollama) (\/(?:api\/v1\/chat|v1\/chat\/completions|api\/chat)) returned HTTP ([1-5]\d{2})(?=$|[.:\s])/.exec(error);
  if (local) {
    const prefix=local[1]+" "+local[2]+" returned HTTP "+local[3]+". ";
    return prefix+(error===prefix+templateAdvice ? templateAdvice : httpGuidance(Number(local[3])));
  }
  if (/^(?:LM Studio|Ollama) (?:refused the local connection\. Start the local server and refresh Local runtimes\.|connection failed\. Check Local runtimes and the server activity\.)$/.test(error) ||
    /^LM Studio stopped the prediction \((failed|modelUnloaded|userStopped)\)\.$/.test(error) ||
    /^The runtime reported \d+ output tokens above its \d+-token allocation\.$/.test(error) ||
    /^LM Studio reported (?:unknown|\d+) input tokens after verifying \d+\. The run cannot be scored\. Check the model's runtime and template\.$/.test(error))
    return error.trimEnd();
  if (error.endsWith(" "+templateAdvice) && knownMessages.has(error.slice(0,-templateAdvice.length-1))) return error;
  const limit=/^Output stopped at the generation or context limit(?: after \d+ generated tokens)? \(output allocation \d+\)/.exec(error);
  return limit ? limit[0]+". The partial response was saved without a score." : opaqueProviderError;
}

function exportManifest(manifest:RunDetail["manifest"]) {
  const failure=manifest.guardrailFailure;
  // The tokenizer exception path in historical profiles stored the raw SDK reason in both fields.
  if (!failure || failure.source!=="LM Studio local runtime") return manifest;
  const candidate=manifest.candidates.find(c=>c.id===failure.candidateId);
  if (!candidate) return manifest;
  const base="LM Studio could not count the complete input for "+candidate.model+". Check its connection and chat template, or remove the input cap.";
  const known=[
    base,base+" "+templateAdvice,
    "Load "+candidate.model+" in LM Studio before using an input cap, or remove the cap.",
    "LM Studio returned an invalid input count for "+candidate.model+".",
    candidate.model+" needs "+failure.inputTokens+" input tokens after applying its chat template. The cap is "+failure.requestedInputCap+". Shorten the input or raise the cap.",
  ];
  const message=known.includes(failure.message) ? failure.message :
    failure.message.startsWith(base) ? base : publicProviderError(failure.message);
  return {...manifest,guardrailFailure:{...failure,message},
    ...(manifest.error && {error:candidate.model+" · "+failure.caseId+" — "+message})};
}

const knownGradingFailures=new Set([
  missingExpectedAnswer,
  "Grading canceled.","Grading timed out. Inspect the judge connection and response budget.",
  "The judge stopped before completing its verdict. Inspect the judge output budget and case size.",
  "The judge returned invalid JSON. Check its prompt template and structured-output support.",
  "The judge verdict requires a numeric score and a written rationale.",
  "Judge returned an invalid score or rationale.","The Opik judge returned no rationale.",
  "This rubric requires a case reference. The case is unscored.",
  "This rubric requires an observed agent trajectory. The case is unscored.",
  "Hallucination requires a nonempty case reference for grounding.",
  "Allow this operation to send grading evidence to OpenRouter first.",
  "This decision criterion requires a reference answer. The case has none.",
  "This decision criterion requires an observed agent trajectory. The case has none.",
  "Decision model refused to assess the criterion.",
  "Decision server did not return the named criterion with a valid probability and model identity.",
  "The judge did not return a usable verdict. Check the local judge connection, prompt template and response budget.",
]);

function publicAssessmentReason(a:RecordedAssessment):string {
  if(a.value!==null || a.pass!==null || !["judge","opik","opik-metric","decision"].includes(a.engine) ||
    knownGradingFailures.has(a.reason)) return a.reason;
  const d=a.decision;
  if (a.engine==="decision" && d && d.probabilityYes>d.failAt && d.probabilityYes<d.passAt)
    return "P(criterion met) = "+d.probabilityYes+", between the fail threshold of "+d.failAt+" and the pass threshold of "+d.passAt+". Review this case.";
  const safe=publicProviderError(a.reason);
  return safe===opaqueProviderError ? "No score was recorded. Inspect the pinned grader and its required evidence in the local workspace." : safe;
}

export function exportDiagnostics(run:Pick<RunDetail,"manifest"|"results"|"report"|"assessments">) {
  const manifest=exportManifest(run.manifest);
  const fixtures=new Set(manifest.candidates.filter(c=>c.provider==="fixture").map(c=>c.id));
  // Several assessments may exist for one case and grader. Change only a matching diagnostic copy.
  const replacements=new Map<string,string>();
  const key=(candidate:string,caseId:string,grader:string|null,reason:string)=>JSON.stringify([candidate,caseId,grader,reason]);
  const results=run.results.map(result=>{
    if (!result.error || fixtures.has(result.candidateId)) return result;
    const error=publicProviderError(result.error);
    if(error===result.error) return result;
    replacements.set(key(result.candidateId,result.caseId,null,result.error),error);
    return {...result,error};
  });
  const assessments=run.assessments.map(a=>{
    const reason=publicAssessmentReason(a);
    if(reason===a.reason) return a;
    replacements.set(key(a.candidate,a.caseId,a.graderId,a.reason),reason);
    return {...a,reason};
  });
  if (!run.report || !replacements.size) return {manifest,results,assessments,report:run.report};
  const metrics=run.report.metrics.map(metric=>({...metric,caseScores:metric.caseScores.map(row=>
    ({...row,values:row.values.map(value=>{
      if(value.score!==null) return value;
      const reason=replacements.get(key(value.candidateId,row.caseId,metric.id,value.reason)) ??
        replacements.get(key(value.candidateId,row.caseId,null,value.reason));
      return reason ? {...value,reason} : value;
    })})
  )}));
  return {manifest,results,assessments,report:{...run.report,metrics}};
}
