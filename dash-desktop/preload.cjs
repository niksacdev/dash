const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "dash",
  {
    onPlanningStage: (callback) => {
      if (typeof callback === "function") ipcRenderer.on("dash:planningStage", (_event, stage) => callback(stage));
    },
    ...Object.fromEntries(
    [
      "list",
      "designPrompt",
      "suggestMetrics",
      "cancelDesign",
      "approvePrompt",
      "saveDomainRole", "savePlannerFallback",
      "guidePrompt",
      "cancelGuide",
      "saveEndpoint",
      "power",
      "designGraders", "confirmGraders", "saveGrader","graderSamples","quickGraderOptions","previewQuickBudget","assess",
      "refresh",
      "dataset",
      "detail",
      "opikExperimentStatus", "syncOpikExperiment", "openOpikDashboard",
      "performance",
      "diagnostics",
      "start",
      "stop",
      "import",
      "commitImport",
      "export",
    ].map((name) => [
      name,
      (...args) => ipcRenderer.invoke("dash:" + name, ...args),
    ]),
    ),
  },
);
