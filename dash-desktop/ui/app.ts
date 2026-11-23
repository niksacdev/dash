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
function errorText(error:unknown):string {return error instanceof Error ? error.message : String(error);}
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
  return (location.hash.slice(1) || "home").split("/");
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
    '<div class="dash-wordmark">' + svg("mark", "dash-emblem") + '<h1>DASH</h1></div>' +
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
  let server = state.servers.find((s) => s.provider === "lmstudio");
  if (!server || Date.now() - Date.parse(server.checkedAt) > 15_000) {
    const fresh = await api.refresh();
    server = fresh.find((s) => s.provider === "lmstudio");
  }
  const instances = server?.instances;
  let out =
    heading(
      "Workspace",
      "Developer",
      "Inspect local model sessions and the traces saved by DASH.",
    ) +
    bar("LM Studio sessions", btn("Refresh sessions", "refresh")) +
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
  const run = await api.diagnostics(key);
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
    '</select></label><div class="row">' +
    tag(run.status, true) +
    tag(run.fixture ? "Fixture replay" : "Local inference") +
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
      ],
      run.traces.map((r) => [
        link(esc(r.caseId), "run/" + key + "/" + r.index, "link"),
        esc(r.candidateId),
        esc(r.stage),
        developerMetric(r.telemetry?.device_power?.average_w, " W"),
        developerMetric(r.telemetry?.latency_ms, " ms"),
        developerMetric(r.telemetry?.input_tokens),
        developerMetric(r.telemetry?.output_tokens),
      ]),
    ) +
    "</div>" +
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
function providersPage() {
  return (
    heading(
      "Workspace",
      "Local runtimes",
      "Select models exposed by a local server. The earnings comparison targets Liquid LFM3, Qwen and Gemma 4.",
    ) +
    '<div class="bar"><h2>Connections</h2>' +
    btn("Refresh models", "refresh") +
    '</div><div class="cols">' +
    state.servers
      .map(
        (s) =>
          '<div class="panel"><div class="row"><h3>' +
          esc(s.title) +
          "</h3>" +
          tag(s.online ? "Connected" : "Offline") +
          '</div><p class="mono">' +
          esc(s.address) +
          "</p>" +
          (s.models.length
            ? s.models
                .map(
                  (c) =>
                    '<div class="listrow"><div><strong>' +
                    esc(c.model) +
                    "</strong><small>" +
                    esc(c.quantization || "") +
                    " " +
                    (c.loaded === true
                      ? "· Loaded · "
                      : c.loaded === false
                        ? "· Available to load · "
                        : "· Load state unknown · ") +
                    esc(c.revision?.slice(0, 18) || "Revision unavailable") +
                    "</small></div></div>",
                )
                .join("")
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
async function runPage(id:string, record?:string) {
  const run = await api.detail(id),
    m = run.manifest;
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
            : "Response",
      ) +
      (m.datasetId ? btn("Rerun case", "rerun") : "") +
      '</div><div class="cols spacer"><div class="panel">' +
      (row ? datasetCaseDetails(row, m.pack) : box("Input", m.prompt)) +
      '</div><div class="panel"><h3>' + (r.dispatchState ? "Partial candidate output" : "Candidate output") + '</h3><pre>' +
      esc(r.output ?? (r.dispatchState ? "No response text was observed." : r.error)) +
      "</pre>" +
      (r.error ? box(observationLabel(r) ?? "Runtime error", r.error) : "") +
      (r.score ? box("Score explanation", r.score) : "") +
      '</div></div><details class="card spacer"><summary>Case trace and telemetry</summary>' +
      box("Trace", r.trace) +
      box("Collected telemetry", r.telemetry) +
      "</details>" + guardrailDetails(r.guardrail) + workflowCaseSummary(m,r) + caseGrading(run,r,Number(record))
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
  if (m.error) out += '<div class="wf-error spacer" role="alert">' + esc(m.error) + "</div>";
  if (live && run.partial?.stage) out += '<p role="status">'+esc(run.partial.stage)+' is reviewing the recorded scores…</p>';
  if (m.guardrailFailure) out += guardrailDetails(m.guardrailFailure);
  if (!live) out += evaluationReport(run);
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
            "</small><pre>" +
            esc(
              r?.output ||
                r?.error ||
                part?.text ||
                (live ? "Waiting…" : "No response"),
            ) +
            "</pre>" +
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
                  : !r.score ? "Grader evaluation" : r.score?.pass
                    ? "Passed"
                    : "Failed check",
              ),
              esc(r.error || r.score?.reasons.join(", ") || (r.score ? "Matched reference" : "See grader scores and rationale")),
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
          ];
        }),
      ) +
      "<small>Power covers the whole device during each call. Case traces include sensor samples and estimated joules over the sampled interval.</small></div>";
  return (
    out +
    '<details class="card spacer"><summary>Run manifest</summary><pre>' +
    pretty(m) +
    "</pre></details>"
  );
}
async function render() {
  const seq = ++token;
  clearTimeout(poll);
  const [route, id, rec] = trail();
  try {
    const latest = await api.list();
    if (seq !== token) return;
    state = latest;
    $("#machine").textContent = state.device;
    const navRoute = route === "run" ? "history" : route;
    const items = nav.map(
      ([key, label, ico]) =>
        '<a href="#' +
        key +
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
        html = workflowPage("quick");
        break;
      case "new":
        html = workflowPage("dataset");
        break;
      case "prompts":
        html = promptCatalogPage();
        break;
      case "roles":
        html = domainRolesPage();
        break;
      case "datasets":
        html = await catalogPage(id);
        break;
      case "graders":
        html = await gradersPage();
        break;
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
        html = await runPage(id, rec);
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
      document.querySelectorAll("details[open] summary"),
      (el) => el.textContent,
    );
    $("#screen").innerHTML = html;
    if (route==="compare") scheduleBudgetPreview();
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
    for (const d of document.querySelectorAll("details"))
      if (open.includes(d.querySelector("summary")?.textContent ?? "")) d.open = true;
    if (focus)
      document
        .querySelector<HTMLElement>('[data-act="' + CSS.escape(focus) + '"]')
        ?.focus({ preventScroll: true });
    if (
      route === "run" &&
      rec === undefined &&
      ["queued", "running"].includes(current?.status ?? "")
    )
      poll = setTimeout(render, 220);
  } catch (e) {
    if (seq === token) $("#screen").textContent = errorText(e);
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
  const w = workflows[runMode];
  if (!w?.approved || w.busy || state.active) return;
  const form = e.target, approved = w.approved;
  const candidateIds = selectedModels(runMode);
  if (runMode === "quick" ? !canStartQuick() : !canStartDataset()) return;
  w.busy = "start";
  requireElement("button[type=submit]",HTMLButtonElement,form).disabled = true;
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
    if (showCurrentWorkflow(w)) location.hash = "run/" + id;
  } catch (error) {
    w.error = errorText(error);
    if (showCurrentWorkflow(w)) message(errorText(error));
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
  el.disabled = true;
  try {
    if (act === "refresh") {
      el.textContent = "Checking…";
      clearBudgetPreviews();
      budgetPreviews.refreshing=true;
      paintBudgetPreviews();
      try { await api.refresh(); }
      finally {
        budgetPreviews.refreshing=false;
        await render();
      }
    }
    if (act === "cancel-import") { importDraft = null; await render(); }
    if (act === "import") {
      if (!api.commitImport) throw Error("Reopen DASH to register a dataset with metadata.");
      const draft = await api.import(dashElement("#catalog-pack",HTMLSelectElement)?.value || packId);
      if (draft) {
        importDraft = draft;
        await render();
        dashElement("#catalog-import [name=family]",HTMLInputElement)?.focus();
      }
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
        graderIds: (m.graders || []).map(g=>g.id),
        parentId: id,
        animation: !matchMedia("(prefers-reduced-motion: reduce)").matches,
      });
      location.hash = "run/" + next;
    }
  } catch (err) {
    message(errorText(err));
  } finally {
    el.disabled = false;
  }
});
window.addEventListener("hashchange", () => {
  clearBudgetPreviews();
  baseline = "";
  render();
  window.scrollTo(0, 0);
  $("#screen").focus({ preventScroll: true });
});
async function bootWorkspace() {
  await render();
  const servers = await api.refresh();
  clearBudgetPreviews();
  const route = trail()[0];
  const count = document.getElementById("overview-loaded-models");
  if (route === "home" && count) {
    state.servers = servers;
    count.textContent = loadedModelCount();
  } else if (["home", "providers", "compare", "new", "developer"].includes(route)) {
    await render();
  }
}
void bootWorkspace().catch(error => message(errorText(error)));
