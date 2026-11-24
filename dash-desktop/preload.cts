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
    "estimatedCostUsd" in value && (value.estimatedCostUsd === null || (typeof value.estimatedCostUsd === "number" &&
    Number.isFinite(value.estimatedCostUsd) && value.estimatedCostUsd >= 0));
}
function isPlanningEvent(value:unknown):value is UiPlanningEvent {
  return typeof value==="object" && value!==null &&
    "mode" in value && (value.mode==="quick" || value.mode==="dataset") &&
    "requestId" in value && typeof value.requestId==="string" &&
    "queryId" in value && typeof value.queryId==="string" &&
    "provider" in value && ["openai","lmstudio","ollama"].some(p=>p===value.provider) &&
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
      if (isPlanningEvent(stage)) callback(stage);
    });
  },
  list: () => invoke("list"),
  refresh: () => invoke("refresh"),
  loadLocalModel: key => invoke("loadLocalModel",key),
  dataset: (id) => invoke("dataset", id),
  detail: (id) => invoke("detail", id),
  runProgress: (id,revision,offset) => invoke("runProgress",id,revision,offset),
  designPrompt: (request) => invoke("designPrompt", request),
  suggestMetrics: (request) => invoke("suggestMetrics", request),
  approvePrompt: (request) => invoke("approvePrompt", request),
  cancelDesign: () => invoke("cancelDesign"),
  saveDomainRole: (request) => invoke("saveDomainRole", request),
  savePlannerFallback: (request) => invoke("savePlannerFallback", request),
  guidePrompt: (draft) => invoke("guidePrompt", draft),
  cancelGuide: () => invoke("cancelGuide"),
  power: detailed => detailed===undefined ? invoke("power") : invoke("power",detailed),
  saveEndpoint: (request) => invoke("saveEndpoint", request),
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
