import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import * as os from "node:os";
import { z } from "zod";
import { Bench } from "./lib/bench.cjs";
import { PromptGuide } from "./lib/prompt-guide.cjs";
import { OpikExperiments } from "./lib/opik-experiments.cjs";
import { confirmGraderPlan, designGraderPlan } from "./lib/grader-designer.cjs";
import { graderEvidence } from "./lib/evaluation-cases.cjs";
import { diagnostics } from "./lib/diagnostics.cjs";
import { performance } from "./lib/performance.cjs";
import { createDeviceSampler } from "./lib/device-stats.cjs";
import { readPower } from "./lib/power.cjs";
import type { DatasetCase, StartRun } from "./lib/run-types.cjs";
import { listLocalDecisionModels } from "./lib/decision-model.cjs";
import type { GraderEvidence } from "./lib/grader-types.cjs";

const page = path.join(__dirname, "ui", "index.html");
const pageUrl = pathToFileURL(page).href;
let win:BrowserWindow|null = null;
let cancelPlanning:(()=>void)|undefined;
type Command = Exclude<keyof DashBridge,"onPlanningStage">;
type Reply<K extends Command> = Awaited<ReturnType<DashBridge[K]>>;

function bind<K extends Command>(name:K, handler:(...args:unknown[])=>Reply<K>|Promise<Reply<K>>, minimumArgs=handler.length):void {
  ipcMain.handle("dash:"+name,(event,...args:unknown[])=>{
    const frame=event.senderFrame;
    if (!win || win.isDestroyed() || !frame || event.sender!==win.webContents ||
        frame!==win.webContents.mainFrame || frame.url.split("#")[0]!==pageUrl) throw Error("Invalid sender.");
    if (args.length<minimumArgs || args.length>handler.length) throw Error("Invalid arguments for "+name+".");
    return handler(...args);
  });
}

const idSchema=z.string().min(1).max(200);
const modelId=z.string().min(1).max(400);
const tokenCap=z.number().int().min(1).max(1_000_000).nullish();
const startRequest=z.object({
  mode:z.enum(["quick","dataset"]), candidateIds:z.array(modelId).min(1).max(2),
  datasetId:idSchema.nullish(),caseId:idSchema.optional(),parentId:idSchema.optional(),
  approvedPromptId:idSchema.nullish(),caseJudgeId:modelId.optional(),graderIds:z.array(idSchema).max(8).optional(),
  allowHostedDecision:z.boolean().optional(),animation:z.boolean().optional(),inputCap:tokenCap,outputCap:tokenCap,
  datasetScorer:z.enum(["scenario","selected-graders","exact-reference"]).nullish(),
  outcomeRubric:z.object({type:z.enum(["opik","judge"]).optional(),judgeId:modelId,
    criteria:z.string().min(1).max(6000).optional(),threshold:z.number().positive().max(1).optional()}).nullish(),
});
const caseAssessment=z.strictObject({allowHostedDecision:z.boolean().optional(),grader:idSchema,run:idSchema,index:z.number().int().nonnegative()});
const sampleAssessment=z.strictObject({allowHostedDecision:z.boolean().optional(),grader:idSchema,evidence:z.object({
  output:z.string().min(1).max(100000),input:z.unknown().optional(),reference:z.unknown().optional(),trajectory:z.array(z.unknown()).optional(),
  rubric:z.string().optional(),sme_rationale:z.string().optional()
})});
function identifier(raw:unknown):string {
  const value=idSchema.safeParse(raw);
  if (!value.success) throw Error("Invalid identifier.");
  return value.data;
}
function owner():BrowserWindow {
  if (!win || win.isDestroyed()) throw Error("The DASH window was closed.");
  return win;
}

function initialize():void {
  if (cancelPlanning) return;
  const bench = new Bench(path.join(app.getPath("userData"), "dash.sqlite"));
  const guide = new PromptGuide(bench.adapters);
  const opik = new OpikExperiments(bench);
  let pendingImport:{token:string;name:string;pack:string;rows:DatasetCase[]}|null=null;
  cancelPlanning=()=>{guide.cancel();bench.workflow.cancel();pendingImport=null;};
  session.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));

  bind("list",()=>bench.list());
  bind("refresh",()=>bench.refresh());
  bind("dataset",raw=>bench.dataset(identifier(raw)));
  bind("detail",raw=>bench.detail(identifier(raw)));
  bind("guidePrompt",value=>bench.active ? {status:"busy"} : guide.suggest(value));
  bind("cancelGuide",()=>guide.cancel());
  const onStage=(stage:UiPlanningEvent)=>win?.webContents.send("dash:planningStage",stage);
  bind("designPrompt",value=>{guide.cancel();return bench.designPrompt(value,onStage,"draft");});
  bind("suggestMetrics",value=>{guide.cancel();return bench.designPrompt(value,onStage,"suggest");});
  bind("approvePrompt",value=>bench.workflow.approve(value));
  bind("cancelDesign",()=>bench.workflow.cancel());
  bind("saveDomainRole",value=>bench.workflow.saveRole(value));
  bind("savePlannerFallback",value=>bench.plannerSettings.save(value));
  bind("saveEndpoint",value=>bench.endpoints.save(value));
  bind("designGraders",value=>designGraderPlan(bench,value));
  bind("confirmGraders",value=>confirmGraderPlan(bench,value));
  bind("listDecisionModels", (raw, protocol) => listLocalDecisionModels(
    z.string().min(1).max(240).parse(raw), AbortSignal.timeout(5000),
    z.enum(["systemone","mlx-vlm"]).optional().parse(protocol)),1);
  bind("saveGrader",value=>bench.graders.save(value,bench.servers.flatMap(s=>s.models)));
  bind("datasetGraderOptions", id=>bench.datasetGraderOptions(identifier(id)));
  bind("graderRuns", id=>bench.graderRuns(identifier(id)));
  bind("setGeneralGraderDefault",(id,enabled)=>bench.setGeneralGraderDefault(identifier(id),z.boolean().parse(enabled)));
  bind("quickGraderOptions",value=>bench.quickGraderOptions(identifier(value)));
  bind("previewQuickBudget",(value,candidates)=>bench.previewQuickBudget(identifier(value),z.array(modelId).max(2).parse(candidates)));
  bind("graderSamples",()=>bench.graders.recent());
  bind("assess",async value=>{
    const saved=caseAssessment.safeParse(value);
    let evidence:GraderEvidence, graderId:string;
    let allowHostedDecision = false;
    let where:{run?:string;candidate?:string;caseId?:string}={};
    if (saved.success) {
      const {grader,run,index}=saved.data;
      allowHostedDecision = saved.data.allowHostedDecision === true;
      const {manifest,results}=bench.detail(run), result=results[index];
      if (!result || result.error) throw Error("Choose a completed response.");
      const row=manifest.datasetId ? bench.dataset(manifest.datasetId).rows.find(x=>x.case_id===result.caseId) : undefined;
      evidence=graderEvidence(manifest,row ?? {case_id:result.caseId},result,bench.graders.get(grader).type==="catalog");
      graderId=grader;where={run,candidate:result.candidateId,caseId:result.caseId};
    } else {
      const sample=sampleAssessment.safeParse(value);
      if (!sample.success) throw Error("Provide an output and an optional JSON array of agent steps.");
      allowHostedDecision = sample.data.allowHostedDecision === true;
      const data=sample.data.evidence;
      if (JSON.stringify(data).length>240000) throw Error("Grading evidence exceeds the size limit.");
      graderId=sample.data.grader;
      evidence={...data,input:data.input??null,reference:data.reference??null};
    }
    return bench.graders.record(bench.graders.get(graderId),evidence,where,bench.adapters,AbortSignal.timeout(190000),allowHostedDecision);
  });
  const host={platform:process.platform,os:os.version(),arch:os.arch(),cpu:os.cpus()[0]?.model?.trim() ?? "",memoryGiB:Math.round(os.totalmem()/2**30)};
  const sampleDevice=createDeviceSampler({userData:app.getPath("userData"),getAppMetrics:()=>app.getAppMetrics()});
  bind("power",async detailed=>{
    if (detailed!==undefined && typeof detailed!=="boolean") throw Error("Choose a valid device measurement scope.");
    return {...await (detailed ? sampleDevice() : readPower()),host};
  },0);
  bind("diagnostics",value=>diagnostics(bench.detail(identifier(value))));
  bind("performance",value=>performance(bench.db,identifier(value)));
  bind("opikExperimentStatus",value=>opik.status(identifier(value)));
  bind("syncOpikExperiment",value=>opik.sync(identifier(value)));
  bind("openOpikDashboard",()=>{
    if (!opik.config.configured || !opik.config.dashboard) throw Error("No Opik dashboard was configured.");
    return shell.openExternal(opik.config.dashboard);
  });
  bind("start",value=>{
    const parsed=startRequest.safeParse(value);
    if (!parsed.success) throw Error("Invalid run configuration.");
    const request:StartRun={...parsed.data,datasetId:parsed.data.datasetId ?? undefined};
    if (request.parentId) bench.detail(request.parentId);
    guide.cancel();
    return bench.start(request);
  });
  bind("stop",value=>bench.stop(identifier(value)));
  bind("import",async value=>{
    const pack=identifier(value);
    bench.pack(pack);
    const window=owner();
    const dialogResult=await dialog.showOpenDialog(window,{title:"Import a versioned dataset",properties:["openFile"],filters:[{name:"JSON Lines",extensions:["jsonl"]}]});
    if (dialogResult.canceled || !dialogResult.filePaths.length) return null;
    const file=dialogResult.filePaths[0], stat=await fs.lstat(file);
    if (!stat.isFile() || stat.size>2_000_000) throw Error("Choose a JSONL file under 2 MB.");
    const rows=bench.previewImport(pack,await fs.readFile(file,"utf8"));
    if (win!==window || window.isDestroyed()) return null;
    const draft={token:randomUUID(),name:path.basename(file),pack,rows};
    pendingImport=draft;
    return {token:draft.token,name:draft.name,pack,version:rows[0].dataset_version,split:rows[0].split,count:rows.length};
  });
  bind("commitImport",(token,metadata)=>{
    if (!pendingImport || token!==pendingImport.token) throw Error("Choose your dataset file again.");
    if (!metadata || typeof metadata!=="object" || Array.isArray(metadata)) throw Error("Enter dataset metadata.");
    const {pack,name,rows}=pendingImport;
    const result=bench.importRows(pack,name,rows,metadata);
    pendingImport=null;
    return result;
  });
  bind("export",async value=>{
    const key=identifier(value);
    const saved=bench.exportRun(key);
    const target=await dialog.showSaveDialog(owner(),{title:"Export this run",defaultPath:"DASH-"+key+".json",filters:[{name:"JSON",extensions:["json"]}]});
    if (target.canceled || !target.filePath) return false;
    const temp=path.join(path.dirname(target.filePath),".dash-"+randomUUID()+".tmp");
    try{
      await fs.writeFile(temp,JSON.stringify(saved,null,2)+"\n",{flag:"wx",mode:0o600});
      await fs.rename(temp,target.filePath);
    } finally {await fs.rm(temp,{force:true});}
    return true;
  });
}

export function currentWindow():BrowserWindow|null {return win;}
export async function openWindow():Promise<BrowserWindow> {
  if (win && !win.isDestroyed()) return win;
  initialize();
  const window=new BrowserWindow({
    title:"DASH",width:1310,height:910,minWidth:760,minHeight:590,backgroundColor:"#edf3f6",show:false,
    webPreferences:{preload:path.join(__dirname,"preload.cjs"),sandbox:true,contextIsolation:true,nodeIntegration:false,webviewTag:false},
  });
  win=window;
  window.removeMenu();
  window.webContents.setWindowOpenHandler(()=>({action:"deny"}));
  window.webContents.on("will-navigate",e=>e.preventDefault());
  window.once("ready-to-show",()=>window.show());
  window.on("closed",()=>{if (win===window) {cancelPlanning?.();win=null;}});
  await window.loadFile(page,{hash:process.argv.includes("--developer") ? "developer" : "home"});
  return window;
}
