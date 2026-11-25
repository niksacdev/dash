import {contextBridge, ipcRenderer} from "electron";

type Command = Exclude<keyof DashBridge, "onPlanningStage">;
type Reply<K extends Command> = Awaited<ReturnType<DashBridge[K]>>;

// Only explicit methods below can invoke the main process. IPC handlers enforce the same reply contract.
async function invoke<K extends Command>(command:K, ...args:Parameters<DashBridge[K]>):Promise<Reply<K>> {
  const channel="dash:"+command;
  try { return await ipcRenderer.invoke(channel,...args); }
  catch (error) {
    const prefix="Error invoking remote method '"+channel+"': ";
    const raw=error instanceof Error ? error.message : "";
    const reason=(raw.startsWith(prefix) ? raw.slice(prefix.length) : raw).replace(/^Error: /,"");
    if (reason==="No handler registered for '"+channel+"'") {
      throw Error("This action is unavailable in the running version of DASH. Save or copy your edits, quit DASH completely, then reopen it.");
    }
    throw Error(reason || "DASH could not confirm this action. Check the workspace before repeating it.");
  }
}

function isUsage(value:unknown):value is PlanningUsage {
  if (!value || typeof value !== "object") return false;
  const count = (n:unknown) => n === null || (typeof n === "number" && Number.isSafeInteger(n) && n >= 0);
  return "inputTokens" in value && count(value.inputTokens) && "outputTokens" in value && count(value.outputTokens) &&
    (!("cachedInputTokens" in value) || (typeof value.cachedInputTokens==="number" && count(value.cachedInputTokens) &&
      typeof value.inputTokens==="number" && value.cachedInputTokens<=value.inputTokens)) &&
    "estimatedCostUsd" in value && (value.estimatedCostUsd === null || (typeof value.estimatedCostUsd === "number" &&
    Number.isFinite(value.estimatedCostUsd) && value.estimatedCostUsd >= 0));
}
function validPlanningProgress(value:unknown):boolean {
  if (!value || typeof value!=="object" || !("phase" in value)) return false;
  if (value.phase==="processing-prompt" && "percent" in value)
    return typeof value.percent==="number" && Number.isInteger(value.percent) && value.percent>=0 && value.percent<=100;
  return value.phase==="generating" && "approximateOutputTokens" in value && (value.approximateOutputTokens===null ||
    typeof value.approximateOutputTokens==="number" && Number.isSafeInteger(value.approximateOutputTokens) && value.approximateOutputTokens>=0);
}
function planningEnergy(value:unknown):UiDeviceEnergy|undefined {
  if (!value || typeof value!=="object" || !("scope" in value) || value.scope!=="Whole device" ||
      !("source" in value) || !(value.source===null || (typeof value.source==="string" && value.source.length<=240)) ||
      !("sampled_seconds" in value) || typeof value.sampled_seconds!=="number" || !Number.isFinite(value.sampled_seconds) || value.sampled_seconds<0 ||
      !("estimated_energy_j" in value) || !(value.estimated_energy_j===null || (typeof value.estimated_energy_j==="number" &&
        Number.isFinite(value.estimated_energy_j) && value.estimated_energy_j>=0 && value.sampled_seconds>0))) return undefined;
  return {scope:value.scope,source:value.source,sampled_seconds:value.sampled_seconds,estimated_energy_j:value.estimated_energy_j};
}
function isPlanningEvent(value:unknown):value is Omit<UiPlanningEvent,"energy"> & {energy?:unknown} {
  return typeof value==="object" && value!==null &&
    "mode" in value && (value.mode==="quick" || value.mode==="dataset" || value.mode==="grader") &&
    "requestId" in value && typeof value.requestId==="string" &&
    "queryId" in value && typeof value.queryId==="string" &&
    "provider" in value && ["openai","lmstudio","ollama"].some(p=>p===value.provider) &&
    Object.entries(value).every(([key,v]) => !["startedAt","elapsedMs","discoveryMs","firstTokenMs","tokensPerSecond"].includes(key) ||
      (typeof v==="number" && Number.isFinite(v) && v>=0)) &&
    (!("progress" in value) || validPlanningProgress(value.progress)) &&
    (!("usage" in value) || isUsage(value.usage)) &&
    (!("revision" in value) || value.revision === null || typeof value.revision === "string") &&
    (!("reason" in value) || typeof value.reason === "string") &&
    "stage" in value && typeof value.stage==="string" &&
    "model" in value && typeof value.model==="string" &&
    "status" in value && (value.status==="running" || value.status==="failed" || value.status==="succeeded" || value.status==="canceled") &&
    "attempt" in value && typeof value.attempt==="number" && Number.isSafeInteger(value.attempt);
}

const bridge:DashBridge = {
  onPlanningStage(callback) {
    if (typeof callback !== "function") return;
    ipcRenderer.on("dash:planningStage",(_event, stage:unknown) => {
      if (!isPlanningEvent(stage)) return;
      const {energy,...receipt}=stage;
      const measured=planningEnergy(energy);
      callback(measured ? {...receipt,energy:measured} : receipt);
    });
  },
  list: () => invoke("list"),
  refresh: () => invoke("refresh"),
  loadLocalModel: key => invoke("loadLocalModel",key),
  dataset: (id) => invoke("dataset", id),
  detail: (id) => invoke("detail", id),
  runLaneProgress:(id,revision,cursors)=>invoke("runLaneProgress",id,revision,cursors),
  runProgress: (id,revision,offset,usageRevision) => usageRevision===undefined ? invoke("runProgress",id,revision,offset) : invoke("runProgress",id,revision,offset,usageRevision),
  designPrompt: (request) => invoke("designPrompt", request),
  suggestMetrics: (request) => invoke("suggestMetrics", request),
  previewStructuredPrompt: request => invoke("previewStructuredPrompt",request),
  approvePrompt: (request) => invoke("approvePrompt", request),
  cancelDesign: () => invoke("cancelDesign"),
  saveDomainRole: (request) => invoke("saveDomainRole", request),
  savePlannerFallback: (request) => invoke("savePlannerFallback", request),
  guidePrompt: (draft) => invoke("guidePrompt", draft),
  cancelGuide: () => invoke("cancelGuide"),
  power: detailed => detailed===undefined ? invoke("power") : invoke("power",detailed),
  saveEndpoint: (request) => invoke("saveEndpoint", request),
  openCacheGuide: () => invoke("openCacheGuide"),
  designGraders: (request) => invoke("designGraders", request),
  confirmGraders: (definitions) => invoke("confirmGraders", definitions),
  listDecisionModels: (baseUrl,protocol) => invoke("listDecisionModels",baseUrl,protocol),
  saveGrader: (definition) => invoke("saveGrader", definition),
  graderSamples: () => invoke("graderSamples"),
  graderDatasetIds: id => invoke("graderDatasetIds",id),
  datasetGraderOptions: id => invoke("datasetGraderOptions",id),
  graderRuns: id => invoke("graderRuns",id),
  setGeneralGraderDefault: (id,enabled) => invoke("setGeneralGraderDefault",id,enabled),
  quickGraderOptions: (id) => invoke("quickGraderOptions", id),
  previewQuickBudget: (id, models) => invoke("previewQuickBudget", id, models),
  reviewSavedCase: request=>invoke("reviewSavedCase",request),
  assess: (request) => invoke("assess", request),
  diagnostics: (id) => invoke("diagnostics", id),
  opikExperimentStatus: (id) => invoke("opikExperimentStatus", id),
  syncOpikExperiment: (id) => invoke("syncOpikExperiment", id),
  openOpikDashboard: () => invoke("openOpikDashboard"),
  performance: (id) => invoke("performance", id),
  start: (request) => invoke("start", request),
  stop: (id) => invoke("stop", id),
  import: (pack) => invoke("import", pack),
  commitImport: (token, metadata) => invoke("commitImport", token, metadata),
  export: (id) => invoke("export", id),
};
contextBridge.exposeInMainWorld("dash", bridge);
