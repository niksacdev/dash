import {z} from "opik";
import {jsonText,isScenarioPack} from "./run-types.cjs";
import type {RunManifest,RunResult,ScenarioPack} from "./run-types.cjs";
import {isCandidate,type Candidate} from "./runtime-types.cjs";
import {decodeGraderSpec} from "./graders.cjs";
import {decodeApprovedPrompt} from "./outcome-workflow.cjs";

const str = z.string(), num = z.number(), n = num.nullable(), nullable = str.nullable();
const turn = z.object({role:z.enum(["system","user","assistant"]),content:str}).passthrough();
const budget = z.object({inputCap:n,outputCap:n}).passthrough();
const guardrailShape = {reasoningPolicy:str.optional(),status:z.enum(["verified","blocked","unverified"]),requestedInputCap:n,requestedOutputCap:n,
  inputTokens:n,contextTokens:n,maxOutputTokens:n.optional(),outputReserve:num,source:str,message:str,
  inputOptimization:z.object({status:z.enum(["preserved","compacted","already_compact"]),charactersSaved:num}).optional()};
const guardrail=z.object(guardrailShape).passthrough();
export const savedMetadata=z.object({industry:str,family:str,category:str,source:str,tags:z.array(str),changeNote:str,parentId:nullable}).passthrough();
const runSummary=z.object({id:str,created:str,status:z.enum(["queued","running","completed","failed","canceled","interrupted"]),title:str,mode:z.enum(["quick","dataset"]),fixture:z.union([z.literal(0),z.literal(1)]),industry:nullable,datasetId:nullable});
export type RunSummary=z.infer<typeof runSummary>;
export const decodeRunSummary=(row:unknown):RunSummary=>runSummary.parse(row);
const datasetSummary=z.object({id:str,pack:str,name:str,count:num,casesWithoutReference:num,version:str,split:z.enum(["development","holdout"]),origin:z.enum(["bundled","legacy","import"]),metadata:z.unknown().transform(v=>savedMetadata.parse(jsonText(v)))});
export type DatasetSummary=z.infer<typeof datasetSummary>;
export const decodeDatasetSummary=(row:unknown):DatasetSummary=>datasetSummary.parse(row);
const candidate=z.preprocess(v=>{
  if(v && typeof v==="object" && !("kind" in v))return {...v,kind:"provider" in v && v.provider==="fixture"?"fixture":"model"};
  return v;
},z.custom<Candidate>(isCandidate));
const manifest=z.object({format:num,id:str,created:str,title:str,mode:z.enum(["quick","dataset"]),fixture:z.boolean(),
  candidates:z.array(candidate),caseIds:z.array(str),pack:z.custom<ScenarioPack>(isScenarioPack).nullable(),
  graders:z.array(z.unknown().transform(decodeGraderSpec)).default([]),approvedPrompt:z.unknown().transform(v=>v==null?v:decodeApprovedPrompt(v)).optional(),
  approvedPromptId:nullable.optional(),datasetScorer:z.enum(["scenario","selected-graders","exact-reference"]).nullable().optional(),
  prompt:nullable,effectiveSystem:nullable.optional(),objective:nullable.optional(),promptSource:str.optional(),tokenBudget:budget.optional(),
  datasetId:nullable,datasetMetadata:savedMetadata.partial({industry:true}).nullable().optional(),datasetVersion:nullable,split:nullable,industry:nullable.optional(),
  policyHash:nullable,promptHash:str,caseSetHash:str,invocations:z.array(z.object({candidateId:str,adapter:str,template:nullable.optional(),reasoning:str.optional()}).passthrough()).optional(),
  outputPolicy:z.object({mode:str,automaticTarget:num,providerFallback:num}).passthrough().nullable().optional(),
  parameters:z.object({maxTokens:num.optional(),temperature:num.optional()}).passthrough(),device:z.object({platform:str,arch:str,release:str}).passthrough(),
  parentId:nullable.optional(),replayHash:nullable.optional(),animation:z.boolean(),error:str.optional(),
  guardrailFailure:z.object({...guardrailShape,candidateId:str,caseId:str}).passthrough().optional(),
}).passthrough();
const power=z.object({source:nullable,scope:str,interval_ms:num.optional(),samples:z.union([num,z.array(z.object({ms:num,watts:n}))]),
  average_w:n,peak_w:n.optional(),sampled_seconds:num.optional(),estimated_energy_j:n.optional()});
const telemetry=z.object({
  latency_ms:num.optional(),first_token_ms:n.optional(),input_tokens:n.optional(),output_tokens:n.optional(),provider_first_token_ms:n.optional(),
  reasoning_tokens:n.optional(),tokens_per_second:n.optional(),load_ms:n.optional(),model_instance_id:nullable.optional(),load_ns:n.optional(),
  prompt_ns:n.optional(),generation_ns:n.optional(),runtime_stop_reason:str.optional(),reasoning_control:str.optional(),reasoning_content_present:z.boolean().optional(),
  device_power:power.nullable().optional(),
}).passthrough();
export type StoredPower=z.infer<typeof power>;
const result=z.object({candidateId:str,caseId:str,output:nullable,error:nullable,
  trace:z.object({id:str,runId:str,candidateId:str,caseId:str,started:str,finished:str.optional(),
    steps:z.array(z.object({at:str,action:str,guardrail:guardrail.optional()}).passthrough())}).passthrough(),
  score:z.object({pass:z.boolean(),reasons:z.array(str),ready:z.boolean().optional(),falseAccept:z.boolean().optional(),review:z.boolean().optional(),evaluator:str.optional()}).passthrough().nullable(),
  finishReason:nullable.optional(),telemetry:telemetry.nullable(),guardrail:guardrail.optional(),dispatchedMessages:z.array(turn).optional(),
  inputBudget:z.object({tokens:num,source:str,cap:n}).passthrough().optional(),
}).passthrough();
export function decodeManifest(raw:unknown):RunManifest {return manifest.parse(jsonText(raw));}
export function decodeResult(raw:unknown):RunResult {return result.parse(jsonText(raw));}
