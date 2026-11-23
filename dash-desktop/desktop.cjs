const { app, BrowserWindow, ipcMain, dialog, session } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const { pathToFileURL } = require("node:url");
const { randomUUID } = require("node:crypto");
const { Bench } = require("./lib/bench.cjs");
const page = path.join(__dirname, "ui", "index.html");
let bench, win, pendingImport, promptGuide;
const validString = (v, max) =>
  typeof v === "string" && v.length > 0 && v.length <= max;
function bind(name, fn) {
  ipcMain.handle("dash:" + name, (event, ...args) => {
    const frame = event.senderFrame;
    if (
      !win ||
      event.sender !== win.webContents ||
      frame !== win.webContents.mainFrame ||
      frame.url.split("#")[0] !== pathToFileURL(page).href
    )
      throw Error("Invalid sender.");
    return fn(...args);
  });
}
function id(v) {
  if (!validString(v, 200)) throw Error("Invalid identifier.");
  return v;
}
function initialize() {
  if (bench) return;
  bench = new Bench(path.join(app.getPath("userData"), "dash.sqlite"));
  promptGuide = new (require("./lib/prompt-guide.cjs").PromptGuide)(bench.adapters);
  bind("guidePrompt", draft => bench.active ? { status: "busy" } : promptGuide.suggest(draft));
  bind("cancelGuide", () => promptGuide.cancel());
  const prepare = (request, purpose) => {
    promptGuide.cancel();
    return bench.designPrompt(request, stage => win?.webContents.send("dash:planningStage", stage), purpose);
  };
  bind("designPrompt", request => prepare(request, "draft"));
  bind("suggestMetrics", request => prepare(request, "suggest"));
  bind("cancelDesign", () => bench.workflow.cancel());
  bind("approvePrompt", (request) => bench.workflow.approve(request));
  bind("savePlannerFallback", value => bench.plannerSettings.save(value));
  bind("saveDomainRole", (request) => bench.workflow.saveRole(request));
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) =>
    cb(false),
  );
  bind("saveEndpoint", value => bench.endpoints.save(value));
  const graderDesign = require("./lib/grader-designer.cjs");
  bind("designGraders", request => graderDesign.designGraderPlan(bench,request));
  bind("confirmGraders", definitions => graderDesign.confirmGraderPlan(bench,definitions));
  bind("saveGrader", value => bench.graders.save(value,bench.servers.flatMap(s=>s.models)));
  bind("previewQuickBudget",(promptId,candidates)=>bench.previewQuickBudget(id(promptId),candidates));
  bind("quickGraderOptions", promptId => bench.quickGraderOptions(id(promptId)));
  bind("graderSamples", () => bench.graders.recent());
  bind("assess", async value => {
    const grader=bench.graders.get(id(value.grader));
    let evidence, where={};
    if(value.run){
      const r=bench.detail(id(value.run)), result=r.results[value.index];
      if(!result || result.error)throw Error("Choose a completed response.");
      const item=r.manifest.datasetId?bench.dataset(r.manifest.datasetId).rows.find(x=>x.case_id===result.caseId):null;
      evidence=require("./lib/evaluation-cases.cjs").graderEvidence(r.manifest,item ?? {},result);
      where={run:value.run,candidate:result.candidateId,caseId:result.caseId};
    } else {
      evidence=value.evidence;
      if(!evidence || !validString(evidence.output,100000) || JSON.stringify(evidence).length>240000 ||
        (evidence.trajectory!=null && !Array.isArray(evidence.trajectory)))throw Error("Provide an output and an optional JSON array of agent steps.");
    }
    return bench.graders.record(grader,evidence,where,bench.adapters,AbortSignal.timeout(190000));
  });
  const os = require("node:os");
  const host = {
    platform: process.platform, os: os.version(), arch: os.arch(),
    cpu: os.cpus()[0]?.model?.trim(), memoryGiB: Math.round(os.totalmem() / 2**30)
  };
  bind("power", async () => ({ ...await require("./lib/power.cjs").readPower(), host }));
  bind("list", () => bench.list());
  bind("refresh", () => bench.refresh());
  bind("dataset", (key) => bench.dataset(id(key)));
  bind("detail", (key) => bench.detail(id(key)));
  bind("performance", key => require("./lib/performance.cjs").performance(bench.db, id(key)));
  bind("diagnostics", (key) =>
    require("./lib/diagnostics.cjs").diagnostics(bench.detail(id(key))),
  );
  bind("stop", (key) => bench.stop(id(key)));
  bind("start", (v) => {
    if (
      !v ||
      typeof v !== "object" ||
      !Array.isArray(v.candidateIds) ||
      !v.candidateIds.every((x) => validString(x, 400))
    )
      throw Error("Invalid run configuration.");
    if (v.parentId) bench.detail(id(v.parentId));
    if (v.caseId) id(v.caseId);
    if (v.datasetId) id(v.datasetId);
    if (v.approvedPromptId) id(v.approvedPromptId);
    promptGuide.cancel();
    return bench.start(v);
  });
  bind("import", async (pack) => {
    bench.pack(id(pack));
    const r = await dialog.showOpenDialog(win, {
      title: "Import a versioned dataset",
      properties: ["openFile"],
      filters: [{ name: "JSON Lines", extensions: ["jsonl"] }],
    });
    if (r.canceled) return null;
    const file = r.filePaths[0],
      stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 2_000_000)
      throw Error("Choose a JSONL file under 2 MB.");
    const rows = bench.previewImport(pack, await fs.readFile(file, "utf8"));
    pendingImport = { token: randomUUID(), name: path.basename(file), pack, rows };
    return { token: pendingImport.token, name: pendingImport.name, pack,
      version: rows[0].dataset_version, split: rows[0].split, count: rows.length };
  });
  bind("commitImport", (token, metadata) => {
    if (!pendingImport || token !== pendingImport.token)
      throw Error("Choose your dataset file again.");
    if (!metadata || typeof metadata !== "object") throw Error("Enter dataset metadata.");
    const { pack, name, rows } = pendingImport;
    const key = bench.importRows(pack, name, rows, metadata);
    pendingImport = null;
    return key;
  });
  bind("export", async (key) => {
    const value = bench.exportRun(id(key));
    const r = await dialog.showSaveDialog(win, {
      title: "Export this run",
      defaultPath: "DASH-" + key + ".json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (r.canceled) return false;
    const tmp = path.join(
      path.dirname(r.filePath),
      ".dash-" + randomUUID() + ".tmp",
    );
    try {
      await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      await fs.rename(tmp, r.filePath);
    } finally {
      await fs.rm(tmp, { force: true });
    }
    return true;
  });
}
async function openWindow() {
  initialize();
  win = new BrowserWindow({
    title: "DASH",
    width: 1310,
    height: 910,
    minWidth: 760,
    minHeight: 590,
    backgroundColor: "#edf3f6",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.once("ready-to-show", () => win?.show());
  win.on("closed", () => {
    promptGuide.cancel();
    bench.workflow.cancel();
    win = null;
  });
  await win.loadFile(page, {hash: process.argv.includes("--developer") ? "developer" : "home"});
  return win;
}
module.exports = { openWindow, currentWindow: () => win };
