"use strict";
const api = window.dash;
type UiField = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
function textInput(target: unknown): target is UiField {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}
function dashElement<T extends Element>(selector: string, ctor: {new(): T}, root: ParentNode = document): T | null {
  const node = root.querySelector(selector);
  return node instanceof ctor ? node : null;
}
function requireElement<T extends Element>(selector: string, ctor: {new(): T}, root: ParentNode = document): T {
  const node = dashElement(selector, ctor, root);
  if (!node) throw Error("Missing screen control " + selector);
  return node;
}
const $ = (selector:string, root:ParentNode=document) => requireElement(selector,HTMLElement,root);
function formText(form:HTMLFormElement,name:string):string {
  const field=form.elements.namedItem(name);
  return textInput(field) ? field.value : "";
}
function staleDesktopMethod(error:unknown) {
  return /No handler registered|(?:api|window\.dash)\.[\w$]+ is not a function/i.test(error instanceof Error?error.message:String(error));
}
function errorText(error:unknown):string {
  if(staleDesktopMethod(error))return "This action is unavailable in the current desktop session. Quit and reopen DASH to load its desktop services.";
  const raw=error instanceof Error?error.message:String(error);
  return raw.replace(/^(?:Error: )?(?:Error invoking remote method ['"][^'"]+['"]:\s*(?:Error:\s*)?)+/i,"").trim() || "DASH could not complete this action.";
}
function inlineError(host:HTMLElement,error:unknown) {
  if(!host.isConnected)return;
  const note=host.querySelector<HTMLElement>(":scope > [data-action-error]") || document.createElement("div");
  note.dataset.actionError="";note.className="wf-error spacer";note.setAttribute("role","alert");
  note.textContent=errorText(error);
  if(!note.isConnected)host.append(note);
}
function readFailure(label:string,error:unknown,button:string) {
  return '<section class="wf-error spacer" data-read-error role="alert"><strong>'+esc(label)+'</strong><p>'+esc(errorText(error))+
    '</p><button type="button" data-act="retry-read">'+esc(button)+'</button></section>';
}
let visit=0;
function currentVisit() {
  const started=visit;
  return ()=>started===visit;
}
function isRecord(value:unknown):value is Record<string,unknown> {return value!==null && typeof value==="object" && !Array.isArray(value);}
function isRunMode(value:unknown):value is UiMode { return value==="quick" || value==="dataset"; }
function isGradeType(value:unknown):value is UiGradeType {
  return typeof value==="string" && Object.hasOwn(graderTypes,value);
}
function isNumber(value:unknown):value is number {return typeof value==="number" && Number.isFinite(value);}
const htmlEscapes:Record<string,string> = {"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"};
const esc = (v:unknown) => String(v ?? "").replace(/[&<>"']/g, c => htmlEscapes[c]);
const pretty = (v:unknown) => esc(JSON.stringify(v, null, 2));
const nav = [
  ["home", "Overview", "home"],
  ["compare", "Quick compare", "compare"],
  ["new", "Dataset run", "runs"],
  ["history", "Run history", "case"],
  ["datasets", "Datasets", "database"],
  ["prompts", "Prompt catalog", "case"],
  ["roles", "Domain agents", "candidate"],
  ["graders", "Graders", "runs"],
  ["providers", "Local runtimes", "device"],
  ["developer", "Developer", "runs"],
];
const svg = (name:string, cl = "icon") =>
  '<svg class="' +
  cl +
  '" aria-hidden="true"><use href="#' +
  name +
  '"/></svg>';
const btn = (title:string, act:string, cl = "") =>
  '<button class="' + cl + '" data-act="' + act + '">' + title + "</button>";
const link = (title:string, to:string, cl = "button") =>
  '<a href="#' + to + '" class="' + cl + '">' + title + "</a>";
const tag = (t:unknown, status = false) =>
  '<span class="tag"' + (status ? ' data-status="' + esc(t) + '"' : "") + '>' + esc(t) + "</span>";
const heading = (over:string, title:string, desc = "") =>
  '<div class="heading"><span class="above">' +
  esc(over) +
  "</span><h1>" +
  esc(title) +
  "</h1>" +
  (desc ? "<p>" + esc(desc) + "</p>" : "") +
  "</div>";
const bar = (title:string, action = "") =>
  '<div class="bar"><h2>' + esc(title) + "</h2>" + action + "</div>";
const opt = (value:unknown, title:unknown, chosen:unknown) =>
  '<option value="' +
  esc(value) +
  '" ' +
  (chosen === value ? "selected" : "") +
  ">" +
  esc(title) +
  "</option>";
const displayTime = (s:string) =>
  new Date(s).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
const box = (label:string, data:unknown) =>
  "<h3>" + esc(label) + "</h3><pre>" + pretty(data) + "</pre>";
let state:UiState,
  packId = "earnings",
  datasetId = "",
  token = 0,
  poll:number|undefined,
  toastTimer:number|undefined,
  baseline = "",
  baselineCandidate = "",
  currentCandidate = "",
  current:UiRunDetail|null = null;
function message(s:string) {
  $("#msg").textContent = s;
  $("#msg").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("#msg").hidden = true), 6500);
}
function trail() {
  return (visibleHash.slice(1) || "home").split("/");
}
function dataset() {
  const ds = state.datasets.filter((d) => d.pack === packId);
  return ds.find((d) => d.id === datasetId) || ds[0];
}
function pack() {
  return state.packs.find((p) => p.id === packId);
}
function models() {
  return state.servers.flatMap((p) => p.models);
}
function pickers() {
  const choices = state.datasets.filter((d) => d.pack === packId);
  return (
    '<div class="cols"><label class="field"><span>Scenario</span><select id="pack">' +
    state.packs.filter(p=>state.datasets.some(d=>d.pack===p.id)).map((p) => opt(p.id, p.title, packId)).join("") +
    '</select></label><label class="field"><span>Dataset snapshot</span><select id="ds">' +
    choices
      .map((d) =>
        opt(
          d.id,
          (d.metadata?.family || d.name) + " · " + d.version + " · " + d.split + " · " + d.count + " cases",
          dataset().id,
        ),
      )
      .join("") +
    "</select></label></div>"
  );
}
function race(lanes:{label:string;failed:boolean;done:number;total:number}[], active = false, footer = "") {
  return (
    '<div class="race"><div class="racehead"><span class="cap">Comparison lanes</span>' +
    tag(active ? "Processing" : footer || "Awaiting a run") +
    "</div>" +
    lanes
      .map((l) => {
        const pct = l.total
          ? Math.min(l.failed ? 96 : 100, Math.floor((l.done * 100) / l.total))
          : 0;
        return (
          '<div class="lane ' +
          (active && l.done < l.total ? "running" : "") +
          '"><b>' +
          esc(l.label) +
          '</b><div class="road">' +
          '<svg class="car" data-progress="' +
          pct +
          '" aria-hidden="true"><use href="#car"/></svg>' +
          '</div><small class="mono">' +
          (l.total ? l.done + " / " + l.total : "—") +
          "</small></div>"
        );
      })
      .join("") +
    '<div class="racefoot">' +
    esc(
      footer || "Illustrative lanes · candidate progress appears during a run",
    ) +
    "</div></div>"
  );
}
function tile(to:string, icon:string, title:string, desc:string) {
  return link(
    svg(icon + "-i") +
      "<span><b>" +
      title +
      "</b><small>" +
      desc +
      "</small></span><em>↗</em>",
    to,
    "tile",
  );
}
function historyList(items:UiRunSummary[]) {
  return items.length
    ? items
        .map(
          (r) =>
            '<a class="listrow" href="#run/' +
            r.id +
            '"><div><strong>' +
            esc(r.title) +
            "</strong><small>" +
            displayTime(r.created) +
            " · " +
            runKind(r) +
            " · " +
            esc(r.id.slice(0, 8)) +
            "</small></div>" +
            tag(r.status, true) +
            "</a>",
        )
        .join("")
    : '<div class="empty">Your saved runs will appear here.</div>';
}
function overviewRuns(items:UiRunSummary[]) {
  if (!items.length) return '<div class="empty">Your saved runs will appear here.</div>';
  const labels = '<div class="overview-run overview-run-head" aria-hidden="true"><span>Run</span><span>Execution</span><span>Started</span><span>Status</span></div>';
  return labels + items.map(r =>
    '<a class="overview-run" href="#run/' + esc(r.id) + '"><div><strong>' + esc(r.title) +
    '</strong><small>' + esc(r.id.slice(0, 8)) + '</small></div><span class="execution">' + esc(runKind(r)) +
    '</span><time datetime="' + esc(r.created) + '">' + esc(displayTime(r.created)) + '</time>' + tag(r.status, true) + '</a>'
  ).join("");
}
function loadedModelCount() {
  const online = state.servers.filter(s => s.online);
  if (!online.length) return "—";
  const inventory = online.flatMap(s => s.models);
  const loaded = inventory.filter(m => m.loaded === true).length;
  return loaded || !inventory.some(m => m.loaded == null) ? String(loaded) : "—";
}
function memorySize(bytes?: number | null): string {
  if (bytes == null || !Number.isFinite(bytes)) return "Unavailable";
  const gib = bytes / 2 ** 30;
  return gib.toLocaleString(undefined, {maximumFractionDigits:2}) + " GiB";
}
function cpuPercent(value?: number | null): string {
  return value == null || !Number.isFinite(value) ? "Unavailable" :
    value.toLocaleString(undefined, {maximumFractionDigits:2}) + "%";
}
function deviceDetails(power:UiPower|null) {
  const host = power?.host;
  const platforms: Record<string,string> = {darwin:"macOS",win32:"Windows",linux:"Linux"};
  const platform = [platforms[host?.platform ?? ""] || host?.platform, host?.arch].filter(Boolean).join(" · ") || state.device;
  const lines: [string, string][] = [
    ["Platform", platform], ["Processor", host?.cpu || "Unavailable"],
    ["DASH memory", memorySize(power?.memory?.appWorkingSetBytes)],
    ["Host memory", memorySize(power?.memory?.freeBytes) + " free / " + memorySize(power?.memory?.totalBytes ?? (host?.memoryGiB ? host.memoryGiB * 2 ** 30 : null))],
    ["DASH CPU", cpuPercent(power?.cpu?.appPercent)], ["Host CPU", cpuPercent(power?.cpu?.systemPercent)],
    ["Data volume", memorySize(power?.disk?.usedBytes) + " used · " + memorySize(power?.disk?.availableBytes) + " available"],
    ["Device power", isNumber(power?.watts) ? developerMetric(power.watts," W") : "Unavailable"],
  ];
  const time = power?.at ? Date.parse(power.at) : NaN;
  return '<b>Device details</b><dl>' + lines.map(([k,v])=>'<dt>'+esc(k)+'</dt><dd>'+esc(v)+'</dd>').join("") +
    '</dl><small>DASH memory sums Electron process working sets. CPU is a share of host capacity. Data volume holds this workspace.</small>' +
    '<small>'+esc([power?.source, Number.isFinite(time) ? new Date(time).toLocaleTimeString() : ""].filter(Boolean).join(" · "))+'</small>';
}
function overviewStats(power:UiPower|null) {
  return '<div class="timing-strip"><div class="power-stat"><button type="button" class="device-stat" popovertarget="device-details" aria-describedby="device-details">'+
    'Device power<strong>'+(isNumber(power?.watts) ? developerMetric(power.watts," W") : "Unavailable")+'</strong><span aria-hidden="true">ⓘ</span></button>'+
    '<div id="device-details" popover="auto" role="tooltip">'+deviceDetails(power)+'</div></div>'+
    '<a href="#providers" title="Models confirmed loaded by the latest LM Studio and Ollama inventory.">Loaded models<strong id="overview-loaded-models">'+loadedModelCount()+'</strong></a>'+
    '<a href="#datasets" title="Versioned snapshots in the local DASH dataset catalog.">Dataset snapshots<strong>'+state.datasets.length+'</strong></a>'+
    '<a href="#history" title="Every saved run in this workspace, including failed runs and grader tests.">Total runs<strong id="overview-total-runs">'+state.runs.length+'</strong></a></div>';
}
function bindDeviceDetails() {
  const stat = dashElement(".power-stat",HTMLElement);
  if (!stat) return;
  const button = stat.querySelector("button"), details = dashElement("[popover]",HTMLElement,stat);
  if (!button || !details) return;
  const show = () => { if (!details.matches(":popover-open")) details.showPopover(); };
  const hide = () => { if (details.matches(":popover-open")) details.hidePopover(); };
  let generation = 0;
  let refreshTimer: number | undefined;
  details.addEventListener("toggle", () => {
    const current = ++generation;
    window.clearTimeout(refreshTimer);
    if (!details.matches(":popover-open")) return;
    const refresh = async () => {
      if (!details.isConnected || current !== generation || !details.matches(":popover-open")) return;
      const reading = await api.power(true).catch(() => null);
      if (!details.isConnected || current !== generation || !details.matches(":popover-open")) return;
      details.innerHTML = deviceDetails(reading);
      const value = button.querySelector("strong");
      if (value) value.textContent = isNumber(reading?.watts) ? developerMetric(reading.watts," W") : "Unavailable";
      refreshTimer = window.setTimeout(refresh, 3000);
    };
    void refresh();
  });
  stat.addEventListener("pointerenter", e => { if (e.pointerType === "mouse") show(); });
  stat.addEventListener("pointerleave", () => { if (!button.matches(":focus-visible")) hide(); });
  button.addEventListener("focus", () => { if (button.matches(":focus-visible")) show(); });
  button.addEventListener("blur", hide);
}
async function home() {
  const power = typeof api.power === "function" ? await api.power().catch(() => null) : null;
  return '<div class="overview"><div class="hero"><div class="hero-copy">' +
    '<div class="dash-wordmark">' + '<img class="dash-emblem" src="assets/dash-mark.svg" alt="">' + '<h1>DASH</h1></div>' +
    '<p class="hero-name">Domain Assessment <span>&amp; Scoring Harness</span></p>' +
    '<p class="hero-purpose">Turn a business outcome into a scored model run.</p></div>' + bannerCapabilities() + '</div>' +
    overviewStats(power) +
    '<div class="overview-work">' + outcomeTrack() + '<div class="tiles">' +
    tile("compare", "compare", "Quick compare", "Approve a prompt and compare two models") +
    tile("new", "runs", "Dataset run", "Score a versioned set of cases") + '</div>' +
    bar("Recent runs", link("View history →", "history", "link")) +
    '<div class="overview-runs">' + overviewRuns(state.runs.slice(0, 6)) + '</div></div></div>';
}
function developerMetric(value:unknown, unit = "") {
  return typeof value === "number" && Number.isFinite(value)
    ? esc(value.toLocaleString(undefined, { maximumFractionDigits: 2 }) + unit)
    : "—";
}
async function developerPage(id?:string) {
  let server = state.servers.find((s) => s.provider === "lmstudio"),inventoryFailure="";
  if (!server || Date.now() - Date.parse(server.checkedAt) > 15_000) {
    try{const fresh=await api.refresh();server=fresh.find(s=>s.provider==="lmstudio");}
    catch(error){inventoryFailure=readFailure("Couldn’t refresh the LM Studio session inventory",error,"Retry session check");}
  }
  const instances = server?.instances;
  let out =
    heading(
      "Workspace",
      "Developer",
      "Inspect local model sessions and the traces saved by DASH.",
    ) +
    bar("LM Studio sessions", btn("Refresh sessions", "refresh")) + inventoryFailure +
    '<section class="panel">' +
    '<div class="row">' +
    tag(server?.online ? "Connected" : server ? "Offline" : "Checking") +
    (server?.checkedAt
      ? "<small>Checked " +
        esc(new Date(server.checkedAt).toLocaleTimeString()) +
        "</small>"
      : "") +
    "</div>" +
    (Array.isArray(instances)
      ? instances.length
        ? table(
            ["Loaded instance", "Model", "Context", "Quantization"],
            instances.map((i) => [
              esc(i.id),
              esc(i.model),
              developerMetric(i.context),
              esc(i.quantization) || "—",
            ]),
          )
        : "<p>No model instances are loaded.</p>"
      : "<p>Loaded-instance inventory is unavailable.</p>") +
    "</section>";
  if (!state.runs.length)
    return (
      out +
      bar("Run traces") +
      '<div class="panel">Saved runs will appear here.</div>'
    );
  const key = id || state.runs[0].id;
  out +=
    bar("Run traces", link("Open run", "run/" + key, "link")) +
    '<div class="panel"><label class="field"><span>Saved run</span><select id="developer-run">' +
    state.runs
      .map((r) =>
        opt(
          r.id,
          r.title + " · " + displayTime(r.created) + " · " + r.id.slice(0, 8),
          key,
        ),
      )
      .join("") +
    '</select></label>';
  let run:UiDiagnostic;
  try{run=await api.diagnostics(key);}
  catch(error){return out+'</div>'+readFailure("Couldn’t read the saved run traces",error,"Retry traces");}
  out+='<div class="row">'+tag(run.status, true) +
    tag(run.fixture ? "Fixture replay" : "Live inference") +
    "</div>";
  const counts = run.candidates.map((c) => {
    const cases = run.traces.filter((r) => r.candidateId === c.id);
    const latency = cases
      .map((r) => r.telemetry?.latency_ms)
      .filter(isNumber)
      .sort((a, b) => a - b);
    const n = latency.length,
      median = n ? (latency[(n - 1) >> 1] + latency[n >> 1]) / 2 : null;
    const count = (stage:string) => cases.filter((r) => r.stage === stage).length;
    return [
      esc(c.model),
      cases.length,
      count("Runtime error"),
      count("Output format"),
      count("Grading"),
      developerMetric(median, " ms"),
    ];
  });
  out +=
    table(
      [
        "Candidate",
        "Traces",
        "Runtime errors",
        "Format failures",
        "Other grade failures",
        "Median latency",
      ],
      counts,
    ) + "</div>";
  if (!run.traces.length)
    return (
      out + '<p class="muted">No completed case traces in this snapshot.</p>'
    );
  out +=
    bar("Case telemetry") +
    '<div class="panel">' +
    table(
      [
        "Case",
        "Candidate",
        "Stage",
        "Device power",
        "Latency",
        "Input tokens",
        "Output tokens",
        "DASH device energy (est.)",
      ],
      run.traces.map((r) => [
        link(esc(r.caseId), "run/" + key + "/" + r.index, "link"),
        esc(r.candidateId),
        esc(r.stage),
        developerMetric(r.telemetry?.device_power?.average_w, " W"),
        developerMetric(r.telemetry?.latency_ms, " ms"),
        developerMetric(r.telemetry?.input_tokens),
        developerMetric(r.telemetry?.output_tokens),
        deviceEnergyReading(r.telemetry?.device_power),
      ]),
    ) +
    "<small>Energy covers this device, including other activity. Remote server energy is unavailable.</small></div>" +
    bar("Trace details") +
    '<div class="stack">' +
    run.traces
      .map(
        (r) =>
          '<details class="card"><summary>' +
          esc(r.caseId) +
          " · " +
          esc(r.candidateId) +
          " · " +
          esc(r.stage) +
          "</summary><p>" +
          esc(r.note) +
          "</p>" +
          box("Trace", {
            trace_id: r.traceId,
            adapter: r.adapter,
            started: r.started,
            finished: r.finished,
            finish_reason: r.finishReason,
          }) +
          box("Collected telemetry", r.telemetry) +
          link(
            "Inspect input and response",
            "run/" + key + "/" + r.index,
            "link",
          ) +
          "</details>",
      )
      .join("") +
    "</div>";
  return out;
}
let loadingModelKey:string|null=null;
function loadModelButton(model:UiModel):string {
  if (model.provider!=="lmstudio" || !model.nativeKey || model.loaded!==false) return "";
  const pending=loadingModelKey===model.nativeKey;
  const disabled=loadingModelKey!==null || !!state.active;
  return '<button type="button" class="btn" data-act="load-local-model" data-key="'+esc(model.nativeKey)+'"'+
    (disabled?' disabled':'')+' aria-label="'+esc((pending?"Loading ":"Load ")+model.nativeKey)+'">'+
    (pending?"Loading…":state.active?"Run active":"Load")+'</button>';
}
function runtimeModelRow(model:UiModel):string {
  let status = "Load state unknown";
  if (model.loaded === true) status = "Loaded and ready";
  else if (loadingModelKey !== null && model.provider === "lmstudio" && model.nativeKey === loadingModelKey) status = "Loading";
  else if (model.loaded === false) status = "On disk";
  const metadata = [
    model.nativeKey !== model.model ? model.nativeKey : null,
    model.quantization,
    model.revision?.slice(0, 18) || "Revision unavailable",
  ].filter(Boolean).join(" · ");
  return '<div class="listrow runtime-model"><div class="runtime-model-info"><div class="runtime-model-heading"><strong>' +
    esc(model.model) + '</strong>' + tag(status, true) + '</div><small>' + esc(metadata) +
    '</small></div>' + loadModelButton(model) + '</div>';
}
function providersPage() {
  return (
    heading(
      "Workspace",
      "Local runtimes",
      "Load a downloaded LM Studio chat model here, or inspect the models available from Ollama.",
    ) +
    '<div class="bar"><h2>Connections</h2>' +
    btn("Refresh models", "refresh") +
    '</div><div class="cols runtime-connections">' +
    state.servers
      .map(
        (s) =>
          '<div class="panel"><div class="row"><h3>' +
          esc(s.title) +
          "</h3>" +
          tag(s.online ? "Connected" : "Offline", true) +
          '</div><p class="mono">' +
          esc(s.address) +
          "</p>" +
          (s.online && s.models.length
            ? s.models.map(runtimeModelRow).join("")
            : "<small>" +
              esc(
                s.online
                  ? "No models listed."
                  : "Start the local server, then refresh.",
              ) +
              "</small>") +
          "</div>",
      )
      .join("") +
    "</div>"
  );
}
function table(cols:string[], rows:unknown[][]) {
  return (
    '<div class="tablewrap"><table><thead><tr>' +
    cols.map((x) => "<th>" + esc(x) + "</th>").join("") +
    "</tr></thead><tbody>" +
    rows
      .map(
        (row) =>
          "<tr>" + row.map((c) => "<td>" + c + "</td>").join("") + "</tr>",
      )
      .join("") +
    "</tbody></table></div>"
  );
}
function measures(run:UiRunDetail, candidate:UiModel) {
  const recs = run.results.filter((r) => r.candidateId === candidate.id),
    scored = recs.filter((r) => r.score);
  return {
    recs,
    scored,
    ready: scored.filter((r) => r.score?.ready).length,
    unsafe: scored.filter((r) => r.score?.falseAccept).length,
    review: scored.filter((r) => r.score?.review).length,
    errors: recs.filter((r) => r.error && !r.dispatchState).length,
  };
}
async function paired(run:UiRunDetail) {
  const m = run.manifest;
  const choices = state.runs.filter(
    (r) =>
      r.id !== m.id &&
      r.status === "completed" &&
      r.mode === "dataset" &&
      Boolean(r.fixture) === m.fixture,
  );
  if (!choices.length) return "";
  let content = "";
  if (choices.some((r) => r.id === baseline)) {
    const other = await api.detail(baseline),
      b = other.manifest;
    if (
      b.datasetId !== m.datasetId ||
      b.policyHash !== m.policyHash ||
      b.caseSetHash !== m.caseSetHash
    )
      content =
        "<p>Dataset, case set or scoring policy differs. Choose a compatible run.</p>";
    else {
      const c =
        m.candidates.find((x) => x.id === currentCandidate) || m.candidates[0];
      const ref =
        b.candidates.find((x) => x.id === baselineCandidate) ||
        b.candidates.find((x) => x.id === c.id) ||
        b.candidates[0];
      const pairs = run.results.flatMap(r => {
        if (r.candidateId !== c.id || !r.score) return [];
        const baselineScore = other.results.find(o => o.caseId === r.caseId && o.candidateId === ref.id && o.score)?.score;
        return baselineScore ? [{current:r.score, baseline:baselineScore}] : [];
      });
      const del = (key:"pass"|"falseAccept") => pairs.reduce(
        (sum,pair) => sum + Number(pair.current[key]) - Number(pair.baseline[key]), 0);
      content =
        '<div class="cols"><label class="field"><span>Current candidate</span><select id="currentCandidate">' +
        m.candidates.map((v) => opt(v.id, v.model, c.id)).join("") +
        '</select></label><label class="field"><span>Baseline candidate</span><select id="baselineCandidate">' +
        b.candidates.map((v) => opt(v.id, v.model, ref.id)).join("") +
        "</select></label></div>" +
        table(
          ["Paired cases", "Change in passed cases", "Change in false accepts"],
          [[pairs.length, del("pass"), del("falseAccept")]],
        ) +
        "<small>Current minus baseline on shared scored cases.</small>" +
        (b.promptHash !== m.promptHash ? "<p>These runs use different prompts. The difference in scores can reflect the instructions as well as the candidate.</p>" : "");
    }
  }
  return (
    bar("Baseline comparison") +
    '<div class="panel"><label class="field"><span>Saved baseline</span><select id="baseline">' +
    opt("", "Choose a completed run", baseline) +
    choices
      .map((r) =>
        opt(
          r.id,
          r.title + " · " + displayTime(r.created) + " · " + r.id.slice(0, 8),
          baseline,
        ),
      )
      .join("") +
    "</select></label>" +
    content +
    "</div>"
  );
}
function observationLabel(result:UiResult):string|null {
  if (result.dispatchState==="canceled") return "Observation canceled";
  if (result.dispatchState==="interrupted") return "Observation interrupted";
  return null;
}
function usageLabels(row:UiResult|undefined,checked:number|undefined,running:boolean,usage?:CandidateUsage) {
  const actual=row?.telemetry?.input_tokens ?? usage?.inputTokens, output=row?.telemetry?.output_tokens ?? usage?.outputTokens;
  const verified=row?.inputBudget?.tokens ?? checked;
  const waiting=running?"Pending":"Unreported";
  const input=actual!=null?actual.toLocaleString():verified!=null?verified.toLocaleString()+" checked":waiting;
  const produced=output!=null?output.toLocaleString():usage?.approximateOutputTokens!=null?"≈"+usage.approximateOutputTokens.toLocaleString():waiting;
  return {input,produced,first:usage?.firstTokenMs!=null?" · First visible output "+planningSeconds(usage.firstTokenMs):""};
}
function responseTokenUsage(row:UiResult|undefined,checked:number|undefined,running:boolean,provider:string,usage?:CandidateUsage) {
  const {input,produced,first}=usageLabels(row,checked,running,running ? usage : undefined);
  return '<p class="muted response-token-usage"'+(running?' data-current-usage':'')+'>Input tokens <strong data-input-count>'+esc(input)+
    '</strong> · Output tokens <strong data-output-count>'+esc(produced)+'</strong><span data-first-output>'+esc(first)+'</span> · Device energy (est.) <strong>'+
    deviceEnergyReading(row?.telemetry?.device_power,provider,running)+'</strong></p>';
}
function quickExecutionProgress(run:UiRunDetail) {
  const {manifest,partial}=run;
  const candidate=manifest.candidates.find(c=>c.id===partial?.candidateId);
  const saved=run.results.filter(r=>r.dispatchState!=="pending");
  const answers=saved.filter(r=>!r.dispatchState && !r.error && !!r.output?.trim()).length;
  const issues=saved.length-answers;
  const grades=run.assessments.length;
  const total=manifest.candidates.length*manifest.caseIds.length;
  const estimates=total*manifest.graders.length;
  let activity=run.status==="queued" ? "Waiting to start" : "Checking model token budgets";
  if (partial?.stage) activity="Preparing the evaluation report · "+partial.stage;
  else if (candidate && partial?.grading) activity="Scoring "+displayModel(candidate.model)+" · "+partial.grading.name+" v"+partial.grading.version;
  else if (candidate) activity=saved.some(r=>r.candidateId===candidate.id)
    ? "Recording the result for "+displayModel(candidate.model) : "Waiting for "+displayModel(candidate.model)+" to finish its answer";
  return '<section class="run-activity" aria-label="Evaluation progress"><h2>Evaluation in progress</h2><p role="status">'+esc(activity)+'</p>'+
    activityMeter(activity)+'<div class="run-activity-counts"><div><strong>'+esc(answers)+' / '+esc(total)+'</strong><span>Answers received</span>'+
    activityMeter("Candidate answers received",{value:answers,max:Math.max(1,total)})+
    (issues ? '<small>'+esc(issues)+' interrupted or failed</small>' : '')+'</div>'+
    (estimates ? '<div><strong>'+esc(grades)+' / '+esc(estimates)+'</strong><span>Grader assessments recorded</span>'+
      activityMeter("Grader assessments recorded",{value:grades,max:estimates})+'</div>' : '')+'</div></section>';
}
async function runPage(id:string, record:string|undefined, seq:number) {
  const run = await api.detail(id),
    m = run.manifest;
  if (seq!==token) return "";
  current = run;
  if (record !== undefined) {
    const r = run.results[Number(record)];
    if (!r) throw Error("Case result unavailable.");
    const row = m.datasetId
      ? (await api.dataset(m.datasetId)).rows.find(
          (x) => x.case_id === r.caseId,
        )
      : null;
    return (
      link("← Run detail", "run/" + id, "link") +
      heading("Case detail", r.caseId, r.candidateId) +
      '<div class="row">' +
      tag(
        r.error
          ? observationLabel(r) ?? "Runtime error"
          : r.score
            ? r.score?.pass
              ? "Passed"
              : "Failed check"
            : r.gradingError ? "Scenario grader unavailable" : "Response",
      ) +
      (m.datasetId ? btn("Rerun case", "rerun") : "") +
      '</div><div class="cols spacer"><div class="panel">' +
      (row ? datasetCaseDetails(row, m.pack) : box("Input", m.prompt)) +
      '</div><div class="panel"><h3>' + (r.dispatchState ? "Partial candidate output" : "Candidate output") + '</h3><pre>' +
      esc(r.output ?? (r.dispatchState ? "No response text was observed." : r.error)) +
      "</pre>" +
      (!m.fixture && !m.approvedPrompt ? responseTokenUsage(r,undefined,false,m.candidates.find(c=>c.id===r.candidateId)?.provider ?? "") : "") +
      (r.error ? box(observationLabel(r) ?? "Runtime error", r.error) : "") +
      (r.gradingError ? '<p class="note">'+esc(r.gradingError)+'</p>' : "") +
      (r.score ? box("Score explanation", r.score) : "") +
      '</div></div><details class="card spacer"><summary>Case trace and telemetry</summary>' +
      box("Trace", r.trace) +
      box("Collected telemetry", r.telemetry) +
      "</details>" + guardrailDetails(r.guardrail) + workflowCaseSummary(m,r) + caseGrading(run,r,Number(record),row)
    );
  }
  const live = ["queued", "running"].includes(run.status);
  let out =
    heading(
      m.fixture
        ? "Grader test · saved answers"
        : m.mode === "quick"
          ? "Quick compare"
          : "Dataset run",
      m.title,
      displayTime(m.created) + " · " + id.slice(0, 8),
    ) +
    '<div class="row">' +
    tag(run.status, true) + (m.mode==="quick" && !m.industry ? "" : tag(m.industry || state.datasets.find(d=>d.id===m.datasetId)?.metadata?.industry || "Industry unrecorded")) +
    (live ? btn("Stop run", "stop") : btn("Export run JSON", "export")) +
    "</div>";
  if (live) out+='<div id="live-read-status"></div>'+(m.mode==="quick" ? quickExecutionProgress(run) : "");
  if (live && !m.fixture && run.liveUsageVersion!==1)
    out+='<p class="muted">This runner reports token usage when a response finishes. Quit and reopen DASH for live provider counts.</p>';
  if (m.error) out += '<div class="wf-error spacer" role="alert">' + esc(m.error) + "</div>";
  if (live && !m.fixture && m.mode==="dataset" && run.partial?.candidateId && !run.partial.grading) {
    const {candidateId,caseId,checkedInputTokens}=run.partial;
    const candidate=m.candidates.find(c=>c.id===candidateId);
    const saved=run.results.find(r=>r.candidateId===candidateId && r.caseId===caseId);
    if (candidate && (!saved || saved.dispatchState==="pending")) out+='<p class="muted">'+esc(displayModel(candidate.model))+
      ' · '+esc(caseId)+'</p>'+responseTokenUsage(saved,checkedInputTokens,true,candidate.provider,run.partial.usage);
  }
  if (live && m.mode!=="quick" && run.partial?.stage) out += '<p role="status">'+esc(run.partial.stage)+' is reviewing the recorded scores…</p>';
  if (m.guardrailFailure) out += guardrailDetails(m.guardrailFailure);
  if (!live) out += evaluationReport(run);
  if (!live) out += structuredOutputSummary(run);
  out += workflowRunSummary(m, run.status);
  if (!live) out += bar("Performance") + performanceCharts(await runPerformance(id, run));
  if (m.fixture) out += '<p class="muted">These results show how the grader handled saved answers. Choose models in Dataset run to evaluate the saved cases live.</p>';
  if (m.mode === "quick") {
    out +=
      '<div class="panel spacer">' +
      box("Shared prompt", m.prompt) +
      "</div>" +
      bar("Responses") +
      '<div class="responses">' +
      m.candidates
        .map((c) => {
          const i = run.results.findIndex((r) => r.candidateId === c.id),
            r = run.results[i];
          const part = run.partial?.candidateId === c.id ? run.partial : null;
          return (
            '<article class="panel"><h3>' +
            esc(c.model) +
            "</h3><small>" +
            esc(c.provider) +
            '</small><pre data-live-candidate="' + esc(c.id) + '">' +
            esc(
              r?.output ||
                r?.error ||
                part?.text ||
                (live ? "Waiting…" : "No response"),
            ) +
            "</pre>" +
            (r || part ? responseTokenUsage(r,part?.checkedInputTokens,live && (!r || r.dispatchState==="pending"),c.provider,part?.usage) : "")+
            (r && observationLabel(r) ? tag(observationLabel(r) ?? "") : "") +
            (r ? link("Inspect trace", "run/" + id + "/" + i, "link") : "") +
            "</article>"
          );
        })
        .join("") +
      "</div>";
  } else {
    out +=
      bar("Candidate progress") +
      race(
        m.candidates.map((c) => ({
          label: c.model,
          failed: run.results.some((r) => r.candidateId === c.id && r.error),
          total: m.caseIds.length,
          done: run.results.filter((r) => r.candidateId === c.id).length,
        })),
        live,
        run.status +
          " · " +
          m.caseIds.length +
          (m.caseIds.length === 1 ? " case" : " cases") +
          " per candidate",
      );
    if (m.pack && m.pack.kind !== "reference") out +=
      bar("Business outcomes") +
      '<div class="panel">' +
      table(
        [
          "Candidate",
          ...m.pack.metrics,
          "Quality checks passed",
          "Runtime errors",
        ],
        m.candidates.map((c) => {
          const z = measures(run, c),
            n = z.scored.length;
          return [
            esc(c.model),
            n ? z.ready : "—",
            n ? z.unsafe : "—",
            n ? Math.round((z.review / n) * 100) + "%" : "—",
            n ? z.scored.filter((r) => r.score?.pass).length + " / " + n : "—",
            z.errors,
          ];
        }),
      ) +
      "<small>Review rate uses scored responses. A false accept is an incorrect proposal to auto-accept. Failed checks route to review.</small></div>";
    out +=
      bar("Cases") +
      '<div class="panel">' +
      (run.results.length
        ? table(
            ["Case", "Candidate", "Result", "Reason"],
            run.results.map((r, i) => [
              link(esc(r.caseId), "run/" + id + "/" + i, "link"),
              esc(r.candidateId),
              esc(
                r.error
                  ? observationLabel(r) ?? "Runtime error"
                  : r.gradingError ? "Scenario grader unavailable" : !r.score ? "Grader evaluation" : r.score?.pass
                    ? "Passed"
                    : "Failed check",
              ),
              esc(r.error || r.gradingError || r.score?.reasons.join(", ") || (r.score ? "Matched reference" : "See grader scores and rationale")),
            ]),
          )
        : '<div class="empty">Waiting for case results.</div>') +
      "</div>";
    if (!live && m.pack?.kind !== "reference") out += await paired(run);
  }
  if(run.assessments?.length)out+=bar("Grader evaluations")+'<div class="panel">'+scoreRows(run.assessments)+"</div>";
  if (!m.fixture)
    out +=
      bar("Telemetry") +
      '<div class="panel">' +
      table(
        [
          "Candidate",
          "Case",
          "Latency",
          "Device power",
          "First token",
          "Input tokens",
          "Output tokens",
          "Device energy (est.)",
        ],
        run.results.map((r) => {
          const t = r.telemetry ?? {};
          return [
            esc(r.candidateId),
            esc(r.caseId),
            t.latency_ms != null ? esc(t.latency_ms) + " ms" : "—",
            developerMetric(t.device_power?.average_w, " W"),
            t.first_token_ms != null ? t.first_token_ms + " ms" : "—",
            t.input_tokens ?? "—",
            t.output_tokens ?? "—",
            deviceEnergyReading(t.device_power,m.candidates.find(c=>c.id===r.candidateId)?.provider),
          ];
        }),
      ) +
      "<small>Energy covers sampled intervals on the device running DASH, including other activity. Remote server energy is unavailable.</small></div>";
  return (
    out +
    '<details class="card spacer"><summary>Run manifest</summary><pre>' +
    pretty(m) +
    "</pre></details>"
  );
}
function pollRunProgress(seq:number, id:string, run:UiRunDetail, offset=run.partial?.text?.length ?? 0, failures=0) {
  const revision=run.liveRevision;
  if (revision==null || typeof api.runProgress!=="function") {
    poll=window.setTimeout(()=>{if(seq===token)void render();},2000);return;
  }
  poll=window.setTimeout(async () => {
    try {
      const update=run.liveUsageVersion===1 ? await api.runProgress(id,revision,offset,run.partial?.usage?.revision ?? 0) :
        await api.runProgress(id,revision,offset);
      if (seq!==token) return;
      document.getElementById("live-read-status")?.replaceChildren();
      if (update.kind==="refresh") { await render(); return; }
      if (update.usage && run.partial) {
        run.partial.usage=update.usage;
        const slot=document.querySelector<HTMLElement>("[data-current-usage]");
        if (slot) {
          const labels=usageLabels(undefined,run.partial.checkedInputTokens,true,update.usage);
          requireElement("[data-input-count]",HTMLElement,slot).textContent=labels.input;
          requireElement("[data-output-count]",HTMLElement,slot).textContent=labels.produced;
          requireElement("[data-first-output]",HTMLElement,slot).textContent=labels.first;
        }
      }
      if (update.kind==="append") {
        const field=document.querySelector<HTMLElement>('[data-live-candidate="'+CSS.escape(update.candidateId)+'"]');
        if (!field || !run.partial || run.partial.candidateId!==update.candidateId) { await render(); return; }
        if (offset && field.firstChild instanceof Text) field.firstChild.appendData(update.text);
        else field.textContent=update.text;
        offset+=update.text.length;
      }
      pollRunProgress(seq,id,run,offset);
    } catch (e) {
      if(seq!==token)return;
      const slot=document.getElementById("live-read-status");
      if(slot && !slot.firstElementChild)slot.innerHTML=readFailure("Live updates paused. Showing the last received result.",e,"Refresh run");
      if(failures<3)pollRunProgress(seq,id,run,offset,failures+1);
    }
  },failures ? 1000 * 2**(failures-1) : 220);
}
let renderedLocation:string|null=null;
async function render(discardEdits=false) {
  const seq = ++token;
  clearTimeout(poll);
  const [route, id, rec] = trail();
  const place=visibleHash;
  const screen=$("#screen"), replacing=renderedLocation!==place;
  if(replacing){
    current=null;
    screen.innerHTML='<p role="status">Loading workspace…</p>';
  }
  try {
    const latest = await api.list();
    if (seq !== token) return;
    state = latest;
    readQuickSession();
    if(pendingQuickLineup && state.servers.length && workflows.quick.approved?.id===pendingQuickLineup) recoverQuickLineup(workflows.quick.approved);
    if (route==="compare") restoreActiveQuick();
    $("#machine").textContent = state.device;
    const navRoute = route === "run" ? "history" : route;
    const items = nav.map(
      ([key, label, ico]) =>
        '<a href="#' +
        (key==="graders" && (route==="compare" || quickLibraryPrompt())?quickLibraryPath():key) +
        '" ' +
        (key === navRoute ? 'aria-current="page"' : "") +
        ">" +
        svg(ico + "-i") +
        esc(label) +
        "</a>",
    );
    $("#work").innerHTML = items.slice(0, 4).join("");
    $("#env").innerHTML = items.slice(4).join("");
    $("#crumb").textContent =
      route === "run"
        ? rec === undefined
          ? "Run detail"
          : "Case detail"
        : nav.find((r) => r[0] === route)?.[1] || "Overview";
    let html;
    switch (route) {
      case "compare":
        await loadQuickGrading(workflows.quick.approved);
        if (seq !== token) return;
        html=(resumedQuickId && resumedQuickId===workflows.quick.approved?.id ? '<p class="wf-hint" role="status">Resumed your approved Quick setup.</p>' : "")+workflowPage("quick");
        break;
      case "new":{
        const selected=workflows.dataset.approved?.datasetId ?? dataset()?.id;
        const choices=selected ? await api.datasetGraderOptions(selected) : null;
        if(seq!==token)return;
        datasetGradingChoices=choices;
        html = workflowPage("dataset");
        break;
      }
      case "prompts":
        html = promptCatalogPage();
        break;
      case "roles":
        html = domainRolesPage();
        break;
      case "datasets":
        html = await catalogPage(id);
        break;
      case "graders":{
        const origin=quickLibraryPrompt();
        if (origin) {
          await loadQuickGrading(origin);
          if (seq!==token) return;
          if(replacing)quickChooserFilter="";
        }
        html = await gradersPage();
        break;
      }
      case "developer":
        html = await developerPage(id);
        break;
      case "providers":
        html = providersPage();
        break;
      case "history":
        html = await historyPage(id);
        break;
      case "run":
        html = await runPage(id, rec, seq);
        break;
      default:
        html = await home();
    }
    if (seq !== token) return;
    const active = document.activeElement;
    const editing = active?.closest(".wf-page") && active.id && active.matches("input,textarea") ? active.id : null;
    const selection = editing && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && active.selectionStart!==null ? [active.selectionStart,active.selectionEnd] as const : null;
    const focus = active instanceof HTMLElement ? active.dataset.act : undefined;
    const open = Array.from(
      document.querySelectorAll("details[open]:not([data-own-open]) > summary"),
      (el) => el.textContent,
    );
    const decision=navigationDecisionResult;
    if(!replacing && decision) {
      const left=await decision;
      // The original action owns the destination. Reconcile the latest held paint on Stay
      // or after an action that leaves the operator on this page.
      if(seq===token && visibleHash===place && (!left || location.hash===place))await render(discardEdits);
      return;
    }
    renderedLocation=place;
    paintWorkspace(screen,html,!replacing && !discardEdits);
    if(route==="graders")applyCatalogFilter();
    if (route==="compare") {scheduleBudgetPreview();focusReturnedQuickControl();}
    if (editing) {
      const field=document.getElementById(editing);
      if ((field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) && !field.disabled) {
        field.focus({preventScroll:true});
        if (selection) field.setSelectionRange(...selection);
      }
    }
    if (route === "datasets") filterCatalog();
    if (route === "home") bindDeviceDetails();
    for (const car of document.querySelectorAll<SVGElement>(".car[data-progress]"))
      car.style.left =
        "calc((100% - 39px) * " + Number(car.dataset.progress) / 100 + ")";
    for (const d of document.querySelectorAll<HTMLDetailsElement>("details:not([data-own-open])"))
      if (open.includes(d.querySelector("summary")?.textContent ?? "")) d.open = true;
    if (focus)
      document
        .querySelector<HTMLElement>('[data-act="' + CSS.escape(focus) + '"]')
        ?.focus({ preventScroll: true });
    if (
      route === "run" &&
      rec === undefined &&
      current && ["queued", "running"].includes(current.status)
    )
      pollRunProgress(seq,id,current);
  } catch (e) {
    if(seq!==token)return;
    const failure=readFailure("Couldn’t load "+(route==="run"?"this run":nav.find(([key])=>key===route)?.[1] || "this view"),e,"Try again");
    if(replacing){screen.innerHTML=failure;}
    else {screen.querySelector(":scope > [data-route-failure]")?.remove();screen.insertAdjacentHTML("afterbegin",failure);screen.firstElementChild?.setAttribute("data-route-failure","");}
  }
}
document.addEventListener("change", (e) => {
  const t = e.target;
  if (!textInput(t)) return;
  if (t.id === "history-run") { location.hash = "history/" + encodeURIComponent(t.value); return; }
  if (t.id === "developer-run") {
    location.hash = "developer/" + encodeURIComponent(t.value);
    return;
  }
  if (t.id === "pack") {
    packId = t.value;
    datasetId = "";
  } else if (t.id === "ds") datasetId = t.value;
  else if (t.id === "baseline") baseline = t.value;
  else if (t.id === "baselineCandidate") baselineCandidate = t.value;
  else if (t.id === "currentCandidate") currentCandidate = t.value;
  else return;
  render();
});
document.addEventListener("submit", async (e) => {
  if (!(e.target instanceof HTMLFormElement) || e.target.id !== "setup") return;
  e.preventDefault();
  const runMode = workflowMode();
  if (!runMode) return;
  const w = workflows[runMode],stillHere=currentVisit();
  if (!w?.approved || w.busy || state.active) return;
  const form = e.target, approved = w.approved;
  const candidateIds = selectedModels(runMode);
  if (runMode === "quick" ? !canStartQuick() : !canStartDataset()) return;
  w.busy = "start";
  const launchButton=requireElement("button[type=submit]",HTMLButtonElement,form);
  launchButton.disabled=true;
  launchButton.setAttribute("aria-busy","true");
  launchButton.textContent="Starting evaluation…";
  try {
    const grading = runMode === "quick" ? quickGradePayload(quickGradePlan()) : {graderIds:selectedGraderIds()};
    const scope=runMode==="quick"?"this Quick comparison across "+candidateIds.length+" candidates":
      "this dataset run of "+(state.datasets.find(d=>d.id===approved.datasetId)?.count ?? 0)+" cases across "+candidateIds.length+" candidates";
    const consent=graderConsentById(grading.graderIds,scope);
    if(!consent)return;
    const id = await api.start({
      ...consent, mode: runMode, datasetId: approved.datasetId || null, approvedPromptId: approved.id,
      ...grading, candidateIds,
      animation: !matchMedia("(prefers-reduced-motion: reduce)").matches,
    });
    baseline = "";
    const openResult=stillHere() && showCurrentWorkflow(w);
    if(runMode==="quick" && workflows.quick===w) {leaveQuickSetup();workflows.quick=plannerState("quick");}
    if (openResult) location.hash = "run/" + id;
  } catch (error) {
    w.error = errorText(error);

  } finally {
    w.busy = "";
    if (showCurrentWorkflow(w)) await render();
  }
});
document.addEventListener("click", async (e) => {
  const el = e.target instanceof Element ? e.target.closest("button[data-act]") : null;
  if (!(el instanceof HTMLButtonElement)) return;
  e.preventDefault();
  const act = el.dataset.act;
  const [, id, rec] = trail();
  const stillHere=currentVisit();
  el.disabled = true;
  try {
    if(act==="retry-read"){await render();return;}
    if (act==="load-local-model" && el.dataset.key && !loadingModelKey) {
      const key=el.dataset.key;
      loadingModelKey=key;
      try {
        await render();
        const result=await api.loadLocalModel(key);
        if (result.status==="unconfirmed") message("Load status is unconfirmed. Check LM Studio and refresh Local runtimes before requesting another load.");
        else message("LM Studio confirms a loaded instance: "+result.instanceId);
      } finally {
        loadingModelKey=null;
        if(stillHere() || trail()[0]==="providers")await render();
      }
    }
    if (act === "refresh") {
      el.textContent = "Checking…";
      clearBudgetPreviews();
      budgetPreviews.refreshing=true;
      paintBudgetPreviews();
      try { await api.refresh(); }
      finally {
        budgetPreviews.refreshing=false;
        if(stillHere())await render();
      }
    }
    if (act === "cancel-import" && await allowPageReplacement("Discard import metadata") && stillHere()) { importDraft = null; await render(true); }
    if (act === "import") {
      if (!api.commitImport) throw Error("Reopen DASH to register a dataset with metadata.");
      if(importPicking || document.querySelector("#catalog-import[data-nav-saving]"))return;
      const prior=document.querySelector<HTMLFormElement>("#catalog-import");
      if(prior && !await allowPageReplacement("Choose another file","",prior))return;
      if(!stillHere())return;
      const pack=dashElement("#catalog-pack",HTMLSelectElement)?.value || packId;
      importPicking=true;
      const unlock=prior && lockNavigationWrite(prior);
      try {
        const draft=await api.import(pack);
        if(draft) {
          importDraft=draft;
          if(prior)forgetNavigationEdits(prior);
          if(stillHere()){
            await render(true);
            dashElement("#catalog-import [name=family]",HTMLInputElement)?.focus();
          }
        }
      }finally{importPicking=false;unlock?.();}
    }
    if (act === "stop") {
      await api.stop(id);
      await render();
    }
    if (act === "export" && (await api.export(id))) message("Run exported.");
    if (act === "rerun" && current) {
      const r = current.results[Number(rec)],
        m = current.manifest;
      const consent=hostedDecisionConsent(m.graders || [],"this rerun of case "+r.caseId);
      if(!consent)return;
      const next = await api.start({
        ...consent, mode: "dataset",
        datasetId: m.datasetId,
        ...(m.approvedPrompt?.id && {approvedPromptId: m.approvedPrompt.id}),
        candidateIds: [r.candidateId],
        caseId: r.caseId,
        // Main restores every immutable grader pin from the saved parent, including defaults.
        graderIds: [],
        parentId: id,
        animation: !matchMedia("(prefers-reduced-motion: reduce)").matches,
      });
      if(stillHere())location.hash = "run/" + next;
    }
  } catch (err) {
    if(stillHere())inlineError(el.isConnected ? el.closest<HTMLElement>("form,section,.panel,.card") || $("#screen") : $("#screen"),err);
  } finally {
    el.disabled = false;
  }
});
function finishWorkspaceNavigation() {
  visit++;
  clearBudgetPreviews();
  baseline = "";
  render();
  window.scrollTo(0, 0);
  $("#screen").focus({ preventScroll: true });
}
async function bootWorkspace() {
  const stillHere=currentVisit();
  await render();
  const servers=await api.refresh();
  quickDiscoverySettled=true;
  if(pendingQuickLineup && workflows.quick.approved?.id===pendingQuickLineup) {
    state.servers=servers;
    recoverQuickLineup(workflows.quick.approved);
    if (!stillHere() && trail()[0]==="compare") await render();
  }
  if(!stillHere() || navigationLoss())return;
  clearBudgetPreviews();
  const route = trail()[0];
  const count = document.getElementById("overview-loaded-models");
  if (route === "home" && count) {
    state.servers = servers;
    count.textContent = loadedModelCount();
  } else if ((["home", "providers", "compare", "new", "developer"].includes(route) || quickLibraryPrompt())) {
    await render();
  }
}
void bootWorkspace().catch(error => message(errorText(error)));
