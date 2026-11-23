"use strict";
const api = window.dash;
const $ = (s) => document.querySelector(s);
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const pretty = (v) => esc(JSON.stringify(v, null, 2));
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
const svg = (name, cl = "icon") =>
  '<svg class="' +
  cl +
  '" aria-hidden="true"><use href="#' +
  name +
  '"/></svg>';
const btn = (title, act, cl = "") =>
  '<button class="' + cl + '" data-act="' + act + '">' + title + "</button>";
const link = (title, to, cl = "button") =>
  '<a href="#' + to + '" class="' + cl + '">' + title + "</a>";
const tag = (t, status = false) =>
  '<span class="tag"' + (status ? ' data-status="' + esc(t) + '"' : "") + '>' + esc(t) + "</span>";
const heading = (over, title, desc = "") =>
  '<div class="heading"><span class="above">' +
  esc(over) +
  "</span><h1>" +
  esc(title) +
  "</h1>" +
  (desc ? "<p>" + esc(desc) + "</p>" : "") +
  "</div>";
const bar = (title, action = "") =>
  '<div class="bar"><h2>' + esc(title) + "</h2>" + action + "</div>";
const opt = (value, title, chosen) =>
  '<option value="' +
  esc(value) +
  '" ' +
  (chosen === value ? "selected" : "") +
  ">" +
  esc(title) +
  "</option>";
const displayTime = (s) =>
  new Date(s).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
const box = (label, data) =>
  "<h3>" + esc(label) + "</h3><pre>" + pretty(data) + "</pre>";
let state,
  packId = "earnings",
  datasetId = "",
  token = 0,
  poll,
  toastTimer,
  baseline = "",
  baselineCandidate = "",
  currentCandidate = "",
  current = null;
function message(s) {
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
function race(lanes, active = false, footer = "") {
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
function tile(to, icon, title, desc) {
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
function historyList(items) {
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
function overviewRuns(items) {
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
function overviewStats(power) {
  const host = power?.host || {};
  const platform = {darwin:"macOS", win32:"Windows", linux:"Linux"}[host.platform] || host.platform;
  const platformInfo = [platform, host.arch].filter(Boolean).join(" · ") || state.device;
  const timestamp = Date.parse(power?.at);
  const sample = Number.isFinite(power?.watts)
    ? "Whole-device draw at " + (Number.isFinite(timestamp) ? new Date(timestamp).toLocaleTimeString() : "sampling time")
    : "Whole-device power unavailable on this host";
  const lines = [
    ["Platform", platformInfo], ["OS", host.os], ["Processor", host.cpu],
    ["Memory", host.memoryGiB ? host.memoryGiB + " GiB" : ""], ["Sensor", power?.source]
  ];
  return '<div class="timing-strip"><div class="power-stat"><button type="button" class="device-stat" popovertarget="device-details" aria-describedby="device-details">'+
    'Device power<strong>'+(Number.isFinite(power?.watts) ? developerMetric(power.watts," W") : "Unavailable")+'</strong><span aria-hidden="true">ⓘ</span></button>'+
    '<div id="device-details" popover="auto" role="tooltip"><b>Device details</b><dl>'+
    lines.filter(([,v])=>v).map(([k,v])=>'<dt>'+esc(k)+'</dt><dd>'+esc(v)+'</dd>').join("")+'</dl><small>'+esc(sample)+'</small></div></div>'+
    '<a href="#providers" title="Models confirmed loaded by the latest LM Studio and Ollama inventory.">Loaded models<strong id="overview-loaded-models">'+loadedModelCount()+'</strong></a>'+
    '<a href="#datasets" title="Versioned snapshots in the local DASH dataset catalog.">Dataset snapshots<strong>'+state.datasets.length+'</strong></a>'+
    '<a href="#history" title="Every saved run in this workspace, including failed runs and grader tests.">Total runs<strong id="overview-total-runs">'+state.runs.length+'</strong></a></div>';
}
function bindDeviceDetails() {
  const stat = document.querySelector(".power-stat");
  if (!stat) return;
  const button = stat.querySelector("button"), details = stat.querySelector("[popover]");
  const show = () => { if (!details.matches(":popover-open")) details.showPopover(); };
  const hide = () => { if (details.matches(":popover-open")) details.hidePopover(); };
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
function developerMetric(value, unit = "") {
  return typeof value === "number" && Number.isFinite(value)
    ? esc(value.toLocaleString(undefined, { maximumFractionDigits: 2 }) + unit)
    : "—";
}
async function developerPage(id) {
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
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const n = latency.length,
      median = n ? (latency[(n - 1) >> 1] + latency[n >> 1]) / 2 : null;
    const count = (stage) => cases.filter((r) => r.stage === stage).length;
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
function table(cols, rows) {
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
function measures(run, candidate) {
  const recs = run.results.filter((r) => r.candidateId === candidate.id),
    scored = recs.filter((r) => r.score);
  return {
    recs,
    scored,
    ready: scored.filter((r) => r.score.ready).length,
    unsafe: scored.filter((r) => r.score.falseAccept).length,
    review: scored.filter((r) => r.score.review).length,
    errors: recs.filter((r) => r.error).length,
  };
}
async function paired(run) {
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
      const pairs = run.results
        .filter((r) => r.candidateId === c.id && r.score)
        .map((r) => [
          r,
          other.results.find(
            (o) => o.caseId === r.caseId && o.candidateId === ref.id && o.score,
          ),
        ])
        .filter(([, o]) => o);
      const del = (key) =>
        pairs.reduce(
          (n, [r, o]) => n + Number(r.score[key]) - Number(o.score[key]),
          0,
        );
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
async function runPage(id, record) {
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
          ? "Runtime error"
          : r.score
            ? r.score.pass
              ? "Passed"
              : "Failed check"
            : "Response",
      ) +
      (m.datasetId ? btn("Rerun case", "rerun") : "") +
      '</div><div class="cols spacer"><div class="panel">' +
      (row ? datasetCaseDetails(row, m.pack) : box("Input", m.prompt)) +
      '</div><div class="panel"><h3>Candidate output</h3><pre>' +
      esc(r.output || r.error) +
      "</pre>" +
      (r.error ? box("Runtime error", r.error) : "") +
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
    if (m.pack.kind !== "reference") out +=
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
            n ? z.scored.filter((r) => r.score.pass).length + " / " + n : "—",
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
                  ? "Runtime error"
                  : !r.score ? "Grader evaluation" : r.score.pass
                    ? "Passed"
                    : "Failed check",
              ),
              esc(r.error || r.score?.reasons.join(", ") || (r.score ? "Matched reference" : "See grader scores and rationale")),
            ]),
          )
        : '<div class="empty">Waiting for case results.</div>') +
      "</div>";
    if (!live && m.pack.kind !== "reference") out += await paired(run);
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
    const selection = editing && typeof active.selectionStart==="number" ? [active.selectionStart,active.selectionEnd] : null;
    const focus = active?.dataset.act;
    const open = Array.from(
      document.querySelectorAll("details[open] summary"),
      (el) => el.textContent,
    );
    $("#screen").innerHTML = html;
    if (route==="compare") scheduleBudgetPreview();
    if (editing) {
      const field=document.getElementById(editing);
      if (field && !field.disabled) {
        field.focus({preventScroll:true});
        if (selection) field.setSelectionRange(...selection);
      }
    }
    if (route === "datasets") filterCatalog();
    if (route === "home") bindDeviceDetails();
    for (const car of document.querySelectorAll(".car[data-progress]"))
      car.style.left =
        "calc((100% - 39px) * " + Number(car.dataset.progress) / 100 + ")";
    for (const d of document.querySelectorAll("details"))
      if (open.includes(d.querySelector("summary").textContent)) d.open = true;
    if (focus)
      document
        .querySelector('[data-act="' + CSS.escape(focus) + '"]')
        ?.focus({ preventScroll: true });
    if (
      route === "run" &&
      rec === undefined &&
      ["queued", "running"].includes(current?.status)
    )
      poll = setTimeout(render, 220);
  } catch (e) {
    if (seq === token) $("#screen").textContent = e.message;
  }
}
document.addEventListener("change", (e) => {
  const t = e.target;
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
  if (e.target.id !== "setup") return;
  e.preventDefault();
  const runMode = workflowMode();
  const w = workflows[runMode];
  if (!w?.approved || w.busy || state.active) return;
  const form = e.target, approved = w.approved;
  const candidateIds = selectedModels(runMode);
  if (runMode === "quick" ? !canStartQuick() : !canStartDataset()) return;
  w.busy = "start";
  form.querySelector("button[type=submit]").disabled = true;
  try {
    const grading = runMode === "quick" ? quickGradePayload(quickGradePlan()) : {graderIds:selectedGraderIds()};
    const id = await api.start({
      mode: runMode, datasetId: approved.datasetId || null, approvedPromptId: approved.id,
      ...grading, candidateIds,
      animation: !matchMedia("(prefers-reduced-motion: reduce)").matches,
    });
    baseline = "";
    if (showCurrentWorkflow(w)) location.hash = "run/" + id;
  } catch (error) {
    w.error = error.message;
    if (showCurrentWorkflow(w)) message(error.message);
  } finally {
    w.busy = "";
    if (showCurrentWorkflow(w)) await render();
  }
});
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
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
      const draft = await api.import(document.getElementById("catalog-pack")?.value || packId);
      if (draft) {
        importDraft = draft;
        await render();
        document.querySelector("#catalog-import [name=family]")?.focus();
      }
    }
    if (act === "stop") {
      await api.stop(id);
      await render();
    }
    if (act === "export" && (await api.export(id))) message("Run exported.");
    if (act === "rerun") {
      const r = current.results[Number(rec)],
        m = current.manifest;
      const next = await api.start({
        mode: "dataset",
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
    message(err.message);
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
(async () => {
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
})();
