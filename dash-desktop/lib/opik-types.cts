import { z, type Opik } from "opik";
import type { DatabaseSync } from "node:sqlite";
import type { RunDetail, CaseRow, DatasetSnapshot } from "./run-types.cjs";

export type NativeOpik = Opik["api"];
export type DatasetVersion = NonNullable<Awaited<ReturnType<NativeOpik["datasets"]["listDatasetVersions"]>>["content"]>[number];
export type DatasetRow = Parameters<NativeOpik["datasets"]["createOrUpdateDatasetItems"]>[0]["items"][number];
export type NativeTrace = Parameters<NativeOpik["traces"]["createTraces"]>[0]["traces"][number];
export type NativeSpan = Parameters<NativeOpik["spans"]["createSpans"]>[0]["spans"][number];
export type NativeItem = Parameters<NativeOpik["experiments"]["createExperimentItems"]>[0]["experimentItems"][number];
export type NativeScore = Parameters<NativeOpik["traces"]["scoreBatchOfTraces"]>[0]["scores"][number];
export const datasetVersion = z.object({id:z.string(),hash:z.string(),name:z.string(),caseIds:z.record(z.string(),z.string())});
export const promptLink = z.object({id:z.string(),promptId:z.string(),name:z.string(),commit:z.string().nullable(),version:z.string().nullable(),
  approvedId:z.string(),revision:z.number().nullable(),variant:z.enum(["quick-user","dataset-system"])});
export const syncReceipt = z.object({
  runId:z.string(),datasetId:z.string(),datasetName:z.string(),versionId:z.string(),version:z.string().nullable(),caseCount:z.number().int().nonnegative(),
  experiments:z.array(z.object({id:z.string(),name:z.string(),candidate:z.string(),traces:z.number().int().nonnegative(),scores:z.number().int().nonnegative()})),
  promptVersion:promptLink.nullable().optional(),syncedAt:z.string(),
});
export type SyncReceipt=z.infer<typeof syncReceipt>;
export type SavedRun=Pick<RunDetail,"status"|"manifest"|"results"|"assessments"|"report"> & {cases:CaseRow[]};
export interface SyncStore {
  readonly db: DatabaseSync;
  exportRun(id:string):SavedRun;
  dataset(id:string):DatasetSnapshot;
}
export interface Destination {
  configured:true; apiUrl:string; dashboard:string|null; workspace:string; project:string; key:string; apiKey:string;
}
export type OpikConfiguration = Destination | {configured:false;error?:string};
export interface SyncOptions {env?:NodeJS.ProcessEnv;makeApi?:(c:Destination)=>NativeOpik}
export type Checkpoint=<T>(key:string,decode:{parse(v:unknown):T},action:()=>Promise<T>)=>Promise<T>;
export type CaseItem = DatasetRow & { data:{case_id:string} & Record<string,unknown> };
export type PublishState =
  | {configured:false;error?:string}
  | {configured:true;apiUrl:string;workspace:string;project:string;hasDashboard:boolean;active:boolean} & (
    {state:"ready"|"syncing";receipt:null}|{state:"partial";receipt:{error:string}}|{state:"synced";receipt:SyncReceipt});
export function statusCode(error:unknown):number|undefined {
  return typeof error==="object" && error!==null && "statusCode" in error && typeof error.statusCode==="number" ? error.statusCode : undefined;
}
