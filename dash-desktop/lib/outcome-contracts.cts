import {isRecord,isDomain,decodeAgentPin,type AgentPin,type Domain} from "../agents/registry.cjs";
import {decodeRoleSnapshot,type RoleSnapshot} from "./domain-profiles.cjs";
import type {PlanningAttempt,PlannerIdentity} from "./planner-routing.cjs";
export type PlanningPurpose = "draft" | "suggest";
export type RunMode = "quick"|"dataset";
export interface DesignRequest {
  mode:RunMode; objective:string; metrics?:string; domain?:string; inputCap?:number|null; outputCap?:number|null;
  datasetId?:string|null; parentId?:string|null; suggestionId?:string|null; sourceRunId?:string|null;
  measures?:{metrics:string[];criteria:string[]}|null;
}
export interface ScenarioContract {
  id:string; title:string; description?:string; system:string; outputSchema:unknown; metrics:string[];
}
export interface DesignContext {
  pack?:ScenarioContract; datasetId?:string; version?:string|null; split?:string|null; industry?:string|null;
  priorRun?:{id:string}; onStage?:(event:PlanningAttempt & {mode:RunMode})=>void;
}
export function required(value:unknown,name:string,max=24000):string {
  if (typeof value!=="string" || !value.trim() || value.length>max)
    throw Error(name+" must be text between 1 and "+max+" characters.");
  return value.trim();
}
export function optional(value:unknown,name:string,max:number):string {
  return value==null||value==="" ? "" : required(value,name,max);
}
export function lines(value:unknown,label:string,maxLength=1000,minimum=1):string[] {
  if (!Array.isArray(value) || value.length<minimum || value.length>8)
    throw Error(label+" must contain between "+minimum+" and eight entries.");
  return [...new Set(value.map((x:unknown)=>required(x,label,maxLength)))];
}
export function cap(value:unknown,name:string):number|null {
  if (value==null) return null;
  if (typeof value!=="number" || !Number.isSafeInteger(value) || value<1 || value>1000000)
    throw Error(name+" must be a whole number between 1 and 1,000,000 tokens.");
  return value;
}
export function decodeRequest(raw:unknown):DesignRequest {
  if (!isRecord(raw) || (raw.mode!=="quick" && raw.mode!=="dataset")) throw Error("Choose Quick compare or Dataset run.");
  const measures=raw.measures;
  if (measures!=null && !isRecord(measures)) throw Error("Invalid selected measures.");
  return {mode:raw.mode,objective:required(raw.objective,"Business outcome",12000),metrics:optional(raw.metrics,"Business metrics",2000),
    domain:optional(raw.domain,"Planning domain",100),inputCap:cap(raw.inputCap,"Input budget"),outputCap:cap(raw.outputCap,"Output budget"),
    datasetId:optional(raw.datasetId,"Dataset snapshot",256)||null,parentId:optional(raw.parentId,"Parent prompt",256)||null,
    sourceRunId:optional(raw.sourceRunId,"Source run",256)||null,suggestionId:optional(raw.suggestionId,"Suggestion ID",256)||null,
    measures:measures==null?null:{metrics:lines(measures.metrics,"Selected metrics",2000,0),criteria:lines(measures.criteria,"Success criteria",2000,0)}};
}
interface PromptCore {
  mode:RunMode; prompt:string; objective:string; title:string; domain:Domain; metrics:string[]; requirements:string[];
  datasetId:string|null; packId:string|null; contractHash:string|null; inputCap:number|null; outputCap:number|null;
  designer:PlannerIdentity|null;
  agents?:RoleSnapshot[];
  workflowAgents?:AgentPin[];
}
export interface PromptDraft extends PromptCore {draftId:string;parentId:string|null;[key:string]:unknown}
export interface ApprovedPrompt extends PromptCore {id:string;familyId:string;version:number;[key:string]:unknown}
export interface MetricSuggestion {
  id:string; domain:Domain;expertVersion:number;model:string;designer:PlannerIdentity;planningAttempts:PlanningAttempt[];metrics:string[];criteria:string[];criteriaReview?:{omitted:number;reasons:string[];supplementSource?:string};
}
export function decodeApprovedPrompt(raw:unknown):ApprovedPrompt {
  if (!isRecord(raw) || typeof raw.id!=="string" || typeof raw.familyId!=="string" || typeof raw.version!=="number" ||
      !Number.isSafeInteger(raw.version)||raw.version<1||(raw.mode!=="quick"&&raw.mode!=="dataset")||!isDomain(raw.domain)||
      typeof raw.prompt!=="string"||typeof raw.objective!=="string") throw Error("Invalid approved prompt revision.");
  let designer:PlannerIdentity|null=null;
  if (raw.designer!=null) {
    const d=raw.designer;
    if (!isRecord(d)||typeof d.model!=="string"||typeof d.provider!=="string"||!(d.revision==null||typeof d.revision==="string")) throw Error("Invalid planning model in approved prompt.");
    designer={...d,provider:d.provider,model:d.model,revision:d.revision??null};
  }
  const key=(value:unknown) => {if(value==null||typeof value==="string")return value??null;throw Error("Invalid snapshot ID in approved prompt.");};
  const agents=raw.agents, workflowAgents=raw.workflowAgents;
  if (agents!=null && !Array.isArray(agents)) throw Error("Invalid saved domain agent revisions.");
  if (workflowAgents!=null && !Array.isArray(workflowAgents)) throw Error("Invalid saved workflow agent revisions.");
  return {...raw,...(Array.isArray(agents) && {agents:agents.map(decodeRoleSnapshot)}),
    ...(Array.isArray(workflowAgents) && {workflowAgents:workflowAgents.map(decodeAgentPin)}),id:raw.id,familyId:raw.familyId,version:raw.version,mode:raw.mode,domain:raw.domain,prompt:raw.prompt,objective:raw.objective,
    title:typeof raw.title==="string"?raw.title:raw.objective,designer,metrics:lines(raw.metrics??[],"Saved metrics",2000,0),
    requirements:lines(raw.requirements??[],"Saved criteria",2000,0),datasetId:key(raw.datasetId),packId:key(raw.packId),contractHash:key(raw.contractHash),
    inputCap:cap(raw.inputCap,"Input budget"),outputCap:cap(raw.outputCap,"Output budget")};
}
