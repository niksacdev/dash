import {rubricEvidenceInstruction} from "./measure-graders.cjs";
import {quickStructuredMessages} from "./quick-structure.cjs";
import {isExternalOutcomeMetric} from "./metric-audit.cjs";
import { isDeepStrictEqual } from "node:util";
import { isRecord, validTurns } from "./run-types.cjs";
import type { CaseRow, CaseScore, RunResult, RunManifest, ScenarioPack, ReferencePack } from "./run-types.cjs";
import type { LocalCandidate, ChatTurn } from "./runtime-types.cjs";
import { exactTextScore,opikVersion,decodeGraderSpec } from "./graders.cjs";
import type {GraderSpec,GraderEvidence} from "./graders.cjs";
import {hash} from "./packs.cjs";

export const referencePack:ReferencePack = {
  id: "reference", kind: "reference", title: "Prompt and reference evaluation",
  description: "Compare answers to versioned evaluation cases and SME guidance.",
  system: "", outputSchema: null, metrics: [], scorer: "Case reference or selected grader",
};

function nonempty(value:unknown):value is string { return typeof value === "string" && !!value.trim(); }

export function validateCase(row:Record<string,unknown>, pack:ScenarioPack) {
  for (const key of ["rubric", "sme_rationale"]) {
    if (row[key] != null && !nonempty(row[key])) throw Error(key + " must be nonempty text");
  }
  if (row.prompt !== undefined && !nonempty(row.prompt)) throw Error("prompt must be nonempty text");
  if (pack.kind !== "reference") {
    if (row.messages !== undefined) throw Error("Import chat messages using Prompt and reference evaluation");
    return;
  }
  if ((row.prompt !== undefined) === (row.messages !== undefined))
    throw Error("Provide either a prompt or a messages array ending with a user turn");
  if (row.messages !== undefined) {
    if (!validTurns(row.messages) || !row.messages.length || row.messages.at(-1)?.role !== "user")
      throw Error("messages must end with a user turn. Put the expected answer in reference");
    for (const [i,m] of row.messages.entries()) {
      if (!m || !["system","user","assistant"].includes(m.role) || !nonempty(m.content) ||
          (m.role === "system" && i !== 0)) throw Error("Invalid role or content in messages");
    }
    if (row.input != null) throw Error("Include case inputs in the chat messages");
  }
  if (typeof row.reference === "string" && !row.reference.trim()) throw Error("The reference answer is empty");
}

export function caseMessages(manifest:{pack?:ScenarioPack|null;effectiveSystem?:string|null;prompt?:string|null;approvedPrompt?:RunManifest["approvedPrompt"]}, row:Partial<CaseRow>):ChatTurn[] {
  if (!manifest.pack) {
    const approved=manifest.approvedPrompt;
    if (approved?.input && approved.outputSchema) return quickStructuredMessages(approved.input,approved.outputSchema);
    return [{role:"user", content:manifest.prompt ?? ""}];
  }
  const mapped = row.messages?.map(({role,content})=>({role,content}));
  if (manifest.pack.kind === "reference") {
    if (mapped) return mapped;
    const context = row.input == null ? "" : "\n\nCase input:\n" + (typeof row.input === "string" ? row.input : JSON.stringify(row.input));
    return [{role:"user", content:row.prompt + context}];
  }
  const source = JSON.stringify({input:row.input, source_locator:row.source_locator});
  return [
    {role:"system", content:manifest.effectiveSystem ?? ""},
    {role:"user", content:row.prompt ? row.prompt + "\n\n" + source : source},
  ];
}

type GradingManifest = Parameters<typeof caseMessages>[0] & Partial<Pick<RunManifest,"mode"|"fixture"|"approvedPrompt"|"measureGraders"|"taskAnswerDecisionGraderIds">>;
export function graderEvidence(manifest:GradingManifest, row:CaseRow, result:RunResult, catalogContext=false, graderId?:string):GraderEvidence {
  const input = result.dispatchedMessages ?? caseMessages(manifest,row);
  const inputSource = result.dispatchedMessages ? "recorded-dispatch" : manifest.fixture ? "fixture-case" : "reconstructed-case";
  const output = result.output ?? "";
  if (graderId && manifest.taskAnswerDecisionGraderIds?.includes(graderId))
    return {input, inputSource, output, reference:undefined};
  const approved = manifest.mode === "quick" ? manifest.approvedPrompt : null;
  const mapped=graderId && manifest.measureGraders?.find(row=>row.graderId===graderId);
  return {
    ...(catalogContext && approved?.outputSchema && {quickOutputSchema:approved.outputSchema}),
    ...(catalogContext && {finishReason:result.reportedFinishReason ?? null}),
    ...(catalogContext && manifest.pack && manifest.pack.kind !== "reference" && {caseContext:{pack:manifest.pack,row}}),
    ...(approved && {evaluationBrief:{objective:approved.objective, metrics:mapped ? [mapped.metric] : approved.auditAgent ? approved.metrics.filter(metric=>!isExternalOutcomeMetric(metric)) : approved.metrics, criteria:mapped ? (mapped.criterion ? [mapped.criterion] : []) : approved.requirements}}),
    input, inputSource, output,
    reference: row.reference ?? row.gold ?? null,
    ...(row.sme_rationale && {sme_rationale:row.sme_rationale}),
    ...(row.rubric && {rubric:row.rubric}),
  };
}

export async function exactReference(row:CaseRow, text:string):Promise<CaseScore> {
  if (typeof row.reference === "string") {
    const score = await exactTextScore(text, row.reference);
    return {pass:score.value === 1, reasons:score.value === 1 ? [] : [score.reason ?? "Answer differs from the case reference"], evaluator:opikVersion};
  }
  let actual;
  try { actual = JSON.parse(text); } catch { return {pass:false,reasons:["Expected a JSON value matching the reference"]}; }
  const pass = isDeepStrictEqual(actual, row.reference);
  return {pass, reasons:pass ? [] : ["Answer differs from the case reference"]};
}

export function caseJudgeSpec(judge:LocalCandidate|undefined):GraderSpec {
  if (!judge || !["lmstudio","ollama"].includes(judge.provider)) throw Error("Choose a connected local judge for the case references and rubrics.");
  const criteria = rubricEvidenceInstruction+" Apply the case rubric to the candidate response. Use the SME reference and rationale as grading evidence. Accept equivalent wording unless the case explicitly calls for an exact format. On the 0 to 10 scale, award 10 for complete fulfillment, partial credit for partially meeting the criteria, or 0 for a materially wrong answer. Cite the decisive case evidence.";
  const identity = {id:judge.id,model:judge.model,provider:judge.provider,revision:judge.revision ?? null, nativeChat:!!judge.nativeChat, reasoningOff:!!judge.reasoningOff};
  const spec = {name:"Case reference and rubric",type:"opik" as const,opikEngine:opikVersion,category:"Dataset evaluation",version:3,criteria,threshold:0.8,judge:identity};
  return decodeGraderSpec({...spec,id:"case-judge/"+hash(spec)});
}

