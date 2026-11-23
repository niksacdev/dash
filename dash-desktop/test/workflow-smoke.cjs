// Run with ./node_modules/.bin/electron test/workflow-smoke.cjs.
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { app } = require("electron");

const profile = mkdtempSync(path.join(os.tmpdir(), "dash-workflow-smoke-"));
app.setPath("userData", profile);
app.dock?.hide();
app.on("browser-window-created", (_event, window) => {
  // This isolated test should never take focus from the user's DASH window.
  window.show = () => {};
});

const calls = [];
const models = { ollama: "lfm3-qa-7b", lmstudio: "qa-ledger-2b" };
const quickGoal = "Help inspection staff decide which nonconforming parts need a second inspection.";
const metric = "Measure the share of lots with cited inspection evidence.";
const guidance = "Cite the inspection record and identify the next review step.";
const roleEdit = "Trace the inspection record to the incoming lot.";

function modelOutput(stage, brief, model) {
  if (stage === "route") return { domain: "Manufacturing" };
  if (stage === "expert") return {
    title: "Review incoming evidence",
    metrics: ["Share of cases with cited evidence"],
    requirements: ["Cite the evidence used for each decision"],
  };
  if (stage === "implementer") {
    assert.ok(brief.expertBrief.requirements.length, "Expert output must reach the implementer");
    return { prompt: guidance };
  }
  if (stage === "analyzer") return { evidence: [brief.evidence[0].id] };
  if (stage === "reporter") {
    const { id, scores } = brief.selected[0];
    let observation = "single";
    if (scores.includes(null)) observation = "missing";
    else if (scores.length === 2)
      observation = scores[0] === scores[1] ? "equal" : scores[0] > scores[1] ? "first_higher" : "second_higher";
    return { ...brief.auditedVerdict, highlights: [{ evidence: id, observation }] };
  }
  if (stage === "judge") {
    const cited = brief.output.includes("QA inspection record");
    return { score: cited ? 1 : 0, reason: cited ? "The response cites the inspection record." : "The response lacks the required evidence." };
  }
  return { decision: "review", evidence: model === models.ollama ? "QA inspection record" : "QA response" };
}

// Intercept HTTP at the transport boundary. Discovery, request formatting,
// streaming response parsing and all Electron IPC handlers remain in use.
globalThis.fetch = async (url, options = {}) => {
  const target = new URL(url);
  assert.equal(target.hostname, "127.0.0.1");
  if (target.port === "11434" && ["/api/tags", "/api/ps"].includes(target.pathname)) {
    return Response.json({ models: [
      { name: models.ollama, digest: "qa-7b-v1", context_length: 4096, details: { parameter_size: "7B" } },
      { name: "qa-short-context", digest: "qa-short-v1", context_length: 128, details: { parameter_size: "1B" } },
    ] });
  }
  if (target.port === "1234" && target.pathname === "/v1/models") {
    return Response.json({ data: [{ id: models.lmstudio }] });
  }
  if (target.port === "1234" && target.pathname === "/api/v1/models") {
    return Response.json({ models: [{ key: models.lmstudio, params_string: "2B", loaded_instances: [] }] });
  }
  if (!["/api/chat", "/v1/chat/completions", "/api/v1/chat"].includes(target.pathname)) {
    throw Error("Unexpected request: " + url);
  }
  const body = JSON.parse(options.body);
  const schema = body.format ?? body.response_format?.json_schema?.schema;
  const props = schema?.properties ?? {};
  const judging = body.messages?.[0]?.content?.startsWith("Evaluate the supplied evidence against this rubric:");
  const stage = props.highlights ? "reporter" : props.evidence?.type === "array" ? "analyzer" :
    judging ? "judge" : props.domain ? "route" : props.requirements ? "expert" : props.prompt ? "implementer" : "candidate";
  const brief = stage === "candidate" ? null : JSON.parse(body.messages.at(-1).content);
  calls.push({ stage, body, brief });
  const content = JSON.stringify(modelOutput(stage, brief, body.model));
  if (target.pathname === "/api/chat") {
    return new Response(JSON.stringify({ message: { content }, done: true, done_reason: "stop", prompt_eval_count: 21, eval_count: 12 }) + "\n");
  }
  if (target.pathname === "/api/v1/chat") {
    return Response.json({ output: [{ type: "message", content }], stats: { input_tokens: 21, total_output_tokens: 12 } });
  }
  return new Response("data: " + JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 21, completion_tokens: 12 } }) + "\n\ndata: [DONE]\n\n");
};

const power = require("../lib/power.cjs");
power.readPower = async () => ({ watts: null, source: "QA", at: new Date().toISOString() });
power.startPower = async () => async () => ({ source: "QA", scope: "Test", samples: [], average_w: null });

async function smoke() {
  const win = await require("../desktop.cjs").openWindow();
  const db = new DatabaseSync(path.join(profile, "dash.sqlite"), { readOnly: true });
  const q = JSON.stringify;
  const js = source => win.webContents.executeJavaScript(source);
  const exists = selector => js("!!document.querySelector(" + q(selector) + ")");
  async function wait(check, message) {
    const until = Date.now() + 10000;
    do {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < until);
    throw Error(message + "\n" + await js("document.body.innerText.slice(-1600)"));
  }
  async function click(selector) {
    await wait(() => js("!!document.querySelector(" + q(selector) + ") && !document.querySelector(" + q(selector) + ").disabled"), "Missing enabled control " + selector);
    await js("document.querySelector(" + q(selector) + ").click(); true");
  }
  async function fill(selector, text) {
    await wait(() => exists(selector), "Missing input " + selector);
    await js("(() => { const field = document.querySelector(" + q(selector) + "); field.value = " + q(text) + "; field.dispatchEvent(new Event('input',{bubbles:true})); field.dispatchEvent(new Event('change',{bubbles:true})); return true; })()");
  }
  const route = name => js("location.hash=" + q(name));
  const records = () => db.prepare("SELECT spec FROM outcome_prompts ORDER BY rowid").all().map(row => JSON.parse(row.spec));
  async function completedRun(count) {
    await wait(() => db.prepare("SELECT count(*) n FROM runs WHERE status='completed'").get().n === count, "Expected " + count + " completed runs");
    return JSON.parse(db.prepare("SELECT manifest FROM runs ORDER BY rowid DESC LIMIT 1").get().manifest);
  }
  await wait(() => exists(".hero"), "Overview");
  const wc = win.webContents;
  wc.setBackgroundThrottling(false);
  wc.debugger.attach("1.3");
  const motion = value => wc.debugger.sendCommand("Emulation.setEmulatedMedia", {
    features: [{name:"prefers-reduced-motion", value}],
  });
  await motion("no-preference");
  const scene = () => js("document.querySelector('.capability-reel').dataset.scene");
  const caption = () => js("document.querySelector('.capability-frame h2').textContent");
  const lanes = () => js("document.querySelector('.banner-track').innerText");
  const previous = '[data-carousel="previous"]', next = '[data-carousel="next"]', playback = '[data-carousel="playback"]';
  const slideCount = await js("Number(document.querySelector('.capability-position').textContent.split('/')[1])");
  assert.equal(slideCount, 6);
  const isPlaying = () => js("document.querySelector('.capability-reel').dataset.playing === 'true'");
  await js("window.originalBannerCars = [...document.querySelectorAll('.banner-car')]");
  const bannerHeight = await js("document.querySelector('.hero').offsetHeight");
  assert.equal(await scene(), "0");
  await click(previous);
  assert.equal(await scene(), String(slideCount - 1));
  assert.match(await caption(), /connected hardware/);
  assert.equal(await isPlaying(), false);
  await click(next);
  assert.equal(await scene(), "0");
  await click(playback);
  assert.equal(await isPlaying(), true);
  await js("document.querySelector('.capability-frame').getAnimations()[0].updatePlaybackRate(20)");
  await wait(async () => await scene() === "1", "Automatic next slide");
  await click(playback);
  assert.equal(await isPlaying(), false);
  await click(next);
  assert.equal(await caption(), "Run domain-specific use cases");
  assert.equal(await js("document.querySelector('.capability-context').textContent"), "Financial Services · Manufacturing");
  const domainExamples = await js("document.querySelector('.capability-frame .capability-detail').textContent");
  assert.match(domainExamples, /earnings per share/);
  assert.match(domainExamples, /drawing’s tolerances/);
  assert.match(await lanes(), /Evidence agent v2/);
  await js("document.querySelector('[data-carousel=next]').focus()");
  wc.sendInputEvent({type:"keyDown", keyCode:"Right"});
  wc.sendInputEvent({type:"keyUp", keyCode:"Right"});
  await wait(async () => await scene() === "3", "Keyboard next slide");
  assert.equal(await caption(), "Score a whole set of cases");
  assert.equal(await js("document.querySelector('.hero').offsetHeight"), bannerHeight);
  assert.ok(await js("window.originalBannerCars.every((c,i) => c === document.querySelectorAll('.banner-car')[i])"));
  await motion("reduce");
  await wait(() => js("!document.querySelector('.capability-reel').getAnimations({subtree:true}).length"), "Static reduced-motion carousel");
  await click(previous);
  assert.equal(await caption(), "Run domain-specific use cases");
  win.setMinimumSize(320,480);
  win.setContentSize(390,720);
  await wait(() => js("innerWidth <= 400"), "Phone-width carousel");
  assert.ok(await js("document.documentElement.scrollWidth <= innerWidth + 1"));
  assert.ok(await js("document.querySelector('[data-carousel=next]').getBoundingClientRect().width >= 44"));
  await motion("no-preference");
  wc.debugger.detach();
  await route("compare");
  win.setMinimumSize(320, 480);
  win.setContentSize(390, 720);
  await wait(() => js("innerWidth <= 400"), "Phone-width viewport");
  await wait(() => exists("#wf-design"), "Phone-width composer");
  assert.ok(await js("document.documentElement.scrollWidth <= innerWidth + 1"), "The outcome form should fit a phone viewport");
  assert.ok(await js("document.querySelector('#wf-design').getBoundingClientRect().height >= 44"), "Touch-size draft button");
  await click('[data-wf-example="manufacturing"]');
  assert.match(await js("document.querySelector('#wf-objective').value"), /Synthetic inspection record/);
  await fill("#wf-objective", quickGoal);
  await fill("#wf-metrics", metric);
  await fill("#wf-output-cap", "180");
  assert.equal(await js("document.querySelector('#wf-measures #wf-suggest').textContent"), "Suggest Metrics");
  await click("#wf-suggest");
  await wait(() => exists("#wf-criteria"), "Editable success criteria");
  assert.deepEqual(calls.map(c => c.stage), ["route", "expert"]);
  assert.equal(records().length, 0);
  const criterion = "Route any part with a missing drawing revision to inspection.";
  await fill("#wf-criteria", criterion);
  await fill("#wf-chosen-metrics", metric);
  assert.equal(await exists("[data-model]"), false, "Models follow approval");
  await click("#wf-design");
  await wait(() => exists("#wf-prompt"), "Quick prompt review");
  assert.deepEqual(calls.map(c => c.stage), ["route", "expert", "implementer"]);
  assert.equal(calls[1].brief.objective, quickGoal);
  assert.deepEqual(calls[2].brief.expertBrief.requirements, [criterion]);
  assert.deepEqual(calls[2].brief.metrics, [metric]);
  assert.equal(records().length, 0, "Unapproved drafts stay out of the catalogue");
  const approvedText = quickGoal + "\n\n" + guidance + "\nShow the lot identifier.";
  await fill("#wf-prompt", approvedText);
  await click("#wf-approve");
  await wait(() => records().length === 1 && exists("[data-model]"), "Saved Quick prompt and model roster");
  assert.ok(await js("document.documentElement.scrollWidth <= innerWidth + 1"), "The starting grid should fit a phone viewport");
  win.setContentSize(1280, 850);
  const first = records()[0];
  assert.equal(first.prompt, approvedText);
  assert.equal(first.domain, "Manufacturing");
  assert.equal(first.outputCap, 180);
  assert.equal(first.version, 1);
  assert.deepEqual(first.metrics, [metric]);
  assert.deepEqual(first.requirements, [criterion]);
  assert.deepEqual(first.agents.map(a => a.role).sort(), ["expert", "implementer"]);
  // Duplicate delivery and conflicting re-submission go through the public preload bridge.
  const approve = (value) => js("window.dash.approvePrompt(" + q(value) + ")");
  const repeat = { draftId: first.draftId, prompt: approvedText, metrics: first.metrics };
  assert.equal((await approve(repeat)).id, first.id);
  await assert.rejects(() => approve({ ...repeat, prompt: "different" }), /already approved/i);
  assert.equal(records().length, 1);

  const pick = (provider) => '[data-model="' + provider + "/" + models[provider] + '"]';
  await wait(() => exists("#qc-criteria"), "Default outcome rubric");
  assert.equal(await js("document.querySelector('#qc-rubric-toggle').getAttribute('aria-pressed')"), "true");
  assert.match(await js("document.querySelector('#qc-criteria').value"), /inspection|lots/i);
  await fill("#qc-threshold","0.8");
  await click(pick("lmstudio"));
  assert.equal(await js("document.querySelector('#setup .go-button').disabled"), true);
  await click('[data-model="ollama/qa-short-context"]');
  await wait(() => exists('[data-qc-budget="ollama/qa-short-context"][data-budget-status="blocked"]'), "Short-context lane blocks GO");
  assert.equal(await js("document.querySelector('#setup .go-button').disabled"), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runs").get().n, 0);
  await click('[data-remove="ollama/qa-short-context"]');
  await click(pick("ollama"));
  await wait(() => exists('[data-qc-budget="ollama/'+models.ollama+'"][data-budget-status="unverified"]'), "Compatible lane budget preview");
  await click("#setup .go-button");
  const quick = await completedRun(1);
  assert.equal(quick.mode, "quick");
  assert.equal(quick.prompt, approvedText);
  assert.deepEqual(quick.candidates.map(c => c.model).sort(), Object.values(models).sort());
  const candidateRequests = calls.filter(c => c.stage === "candidate");
  assert.equal(candidateRequests.length, 2);
  for (const { body } of candidateRequests) {
    assert.ok(body.messages.some(m => m.content.includes(approvedText)));
    assert.equal(body.options?.num_predict ?? body.max_tokens, 180);
  }
  assert.equal(quick.approvedPromptId, first.id);
  assert.deepEqual(quick.approvedPrompt, first, "Persist the exact reviewed prompt, agents, and revisions with the run");

  const quickRecords = await js("window.dash.detail(" + q(quick.id) + ")");
  assert.equal(quick.graders.length, 1);
  assert.equal(quick.graders[0].threshold, .8);
  assert.equal(quickRecords.assessments.length, 2);
  assert.deepEqual(quickRecords.assessments.map(a=>a.value).sort(), [0,1]);
  assert.ok(quickRecords.results.every(r=>r.guardrail.status==="unverified" && r.guardrail.outputReserve===180));
  assert.deepEqual(calls.filter(c => ["analyzer","reporter"].includes(c.stage)).map(c=>c.stage), ["analyzer","reporter"]);
  assert.equal(quickRecords.report.assistance.analyzer.status,"verified");
  assert.equal(quickRecords.report.assistance.reporter.status,"verified");
  assert.equal(quickRecords.report.verdict,"winner");
  assert.equal(quickRecords.report.winnerId,"ollama/"+models.ollama);
  assert.ok(quickRecords.report.metrics.some(m=>m.method==="llm-judge"));
  await wait(() => exists('.er-report[data-verdict="winner"]'), "Terminal winner report");
  await click(".er-evidence summary");
  await wait(() => js("document.querySelector('.er-evidence[open]').innerText.includes('lacks the required evidence')"), "Saved judge rationale");
  await click(".er-evidence a");
  await wait(() => exists('[data-guardrail="unverified"]'), "Per-response capacity evidence");
  await route("roles");
  const role = 'form[data-wf-role][data-domain="Manufacturing"][data-role="expert"]';
  const area = role + ' textarea[name="instructions"]';
  await wait(() => exists(area), "Manufacturing expert editor");
  const prior = await js("document.querySelector(" + q(area) + ").value");
  await fill(area, prior + "\n" + roleEdit);
  await click(role + " button[type=submit]");
  await wait(() => db.prepare("SELECT MAX(version) AS v FROM outcome_agent_roles WHERE domain=? AND role=?").get("Manufacturing","expert").v === 2, "Saved revised role");
  await route("prompts");
  await click('[data-wf-use="' + first.id + '"]');
  await wait(() => exists(pick("ollama")), "Reused approved prompt");
  assert.equal(calls.filter(c => c.stage === "expert").length, 1, "Reuse must preserve the approved prompt");
  await route("prompts");
  await click('[data-wf-revise="' + first.id + '"]');
  await click("#wf-design");
  await click("#wf-approve");
  await wait(() => records().length === 2, "Saved revision");
  const second = records()[1];
  assert.equal(second.familyId, first.familyId);
  assert.equal(second.parentId, first.id);
  assert.equal(second.version, 2);
  assert.equal(first.agents.find(a => a.role === "expert").version, 1);
  assert.equal(second.agents.find(a => a.role === "expert").version, 2);
  assert.ok(calls.filter(c => c.stage === "expert").at(-1).body.messages[0].content.includes(roleEdit));
  assert.deepEqual(records()[0], first, "Revision preserves the approved original");

  await route("new");
  const scenario = db.prepare("SELECT id FROM datasets WHERE pack='earnings' ORDER BY rowid LIMIT 1").get().id;
  await fill("#pack", "earnings");
  await fill("#ds", scenario);
  const directStart = calls.length;
  const directChoice = '#dataset-models [data-model="ollama/' + models.ollama + '"]';
  await wait(() => exists(directChoice), "Dataset starting line");
  assert.equal(await js("document.querySelector('#dataset-models .go-button').disabled"), true);
  assert.equal(await js("document.querySelectorAll('#dataset-models [aria-pressed=true]').length"), 0);
  await fill("#model-search", models.ollama);
  await click(directChoice);
  await fill("#model-search", "");
  assert.equal(await js("document.querySelector('#dataset-models .go-button').disabled"), false);
  // A hard input cap cannot dispatch to the simulated Ollama connection.
  await fill('#dataset-run-form [name="inputCap"]',"8");
  await click("#dataset-run-form button[type=submit]");
  await wait(() => exists('[data-guardrail="blocked"]'), "Blocked dataset preflight evidence");
  assert.equal(calls.length,directStart, "Failing preflight must not call the candidate");
  await route("new");
  await fill('#dataset-run-form [name="inputCap"]',"");
  if (!await js("document.querySelector(" + q(directChoice) + ").matches('[aria-pressed=true]')")) await click(directChoice);
  // A configured hosted destination uses the same picker and receives only model-visible inputs.
  await js("api.saveEndpoint({section:'Hosted',model:'qa-hosted',baseUrl:'http://127.0.0.1:9900/v1',key:''}).then(()=>render())");
  const hosted = '#dataset-models [data-model^="compatible/"]';
  await click(hosted);
  assert.equal(await js("document.querySelectorAll('#dataset-models .grid-slot.occupied').length"), 2);
  assert.equal(await js("document.querySelector('#dataset-models [data-model^=lmstudio]').disabled"), true);
  await click("#dataset-run-form button[type=submit]");
  const native = await completedRun(2);
  assert.equal(native.datasetId, scenario);
  assert.equal(native.candidates.length, 2);
  assert.equal(native.approvedPromptId, null);
  assert.equal(native.promptSource, "dataset");
  assert.equal(records().length, 2, "A direct dataset run needs no new prompt catalogue revision");
  const nativeCalls = calls.slice(directStart);
  assert.deepEqual(nativeCalls.map(c=>c.stage), [...native.candidates.flatMap(()=>native.caseIds.map(()=>"candidate")), "analyzer", "reporter"],
    "A native dataset sends its cases directly before both agents review the scores");
  for (const {body} of nativeCalls.filter(c=>c.stage==="candidate")) {
    assert.ok(body.format ?? body.response_format?.json_schema?.schema);
    assert.equal(body.messages[0].content, native.effectiveSystem);
    assert.doesNotMatch(body.messages.map(m=>m.content).join("\n"), /"gold":/);
  }
  await route("new");
  await click("#wf-variant");
  await fill("#wf-objective", "Identify which reported financial facts need analyst verification.");
  const start = calls.length;
  await click("#wf-suggest");
  await wait(() => exists("#wf-criteria"), "Dataset suggestions");
  assert.match(await js("document.querySelector('#wf-measure-fields').textContent"), /Financial Services expert/);
  await click("#wf-design");
  await wait(() => exists("#wf-prompt"), "Dataset prompt review");
  const proposalCalls = calls.slice(start);
  assert.deepEqual(proposalCalls.map(c => c.stage), ["expert", "implementer"]);
  for (const { brief } of proposalCalls) {
    assert.equal(brief.dataset.datasetId, undefined, "Catalogue IDs are not task evidence");
    assert.ok(brief.dataset.outputSchema);
    assert.equal(brief.dataset.rows, undefined);
    assert.equal(brief.dataset.gold, undefined);
    assert.doesNotMatch(JSON.stringify(brief), /"case_id":/);
  }
  await click("#wf-approve");
  const selected = '#setup [data-model="ollama/' + models.ollama + '"]';
  await click(selected);
  await click("#setup button[type=submit]");
  const dataset = await completedRun(3);
  assert.equal(dataset.candidates.length, 1);
  assert.equal(dataset.promptSource, "approved-variant");
  assert.equal(dataset.datasetId, scenario);
  assert.equal(dataset.industry, "Financial Services");
  assert.equal(dataset.fixture, false);
  const datasetPrompt = records().at(-1);
  assert.equal(datasetPrompt.domain, "Financial Services");
  assert.equal(datasetPrompt.dataset.datasetId, scenario);
  assert.equal(dataset.approvedPromptId, datasetPrompt.id);
  const dispatched = calls.slice(start).filter(c => c.stage === "candidate");
  assert.equal(dispatched.length, dataset.caseIds.length);
  for (const { body } of dispatched) {
    assert.deepEqual(body.format, proposalCalls[0].brief.dataset.outputSchema);
    assert.ok(body.messages.some(m => m.content.includes(datasetPrompt.prompt)));
    assert.doesNotMatch(JSON.stringify(body.messages), /\\"gold\\":/);
  }
  await route("run/" + dataset.id);
  await click('[data-source-run="' + dataset.id + '"]');
  const beforeRefinement = calls.length;
  await click("#wf-design");
  await wait(() => exists("#wf-prompt"), "Run-informed prompt review");
  for (const { brief } of calls.slice(beforeRefinement)) {
    assert.equal(brief.priorRun.id, dataset.id);
    assert.equal(brief.priorRun.candidates[0].scored, dataset.caseIds.length);
    assert.doesNotMatch(JSON.stringify(brief.priorRun), /QA response|gold/);
  }
  db.close();
}

app.whenReady().then(smoke).then(() => {
  console.log("Workflow smoke passed: mobile planning, automatic Quick judging, winner and case rationale, blocked preflight, direct dataset runs, approved variants and revisions.");
  rmSync(profile, { recursive: true, force: true });
  app.exit(0);
}).catch(err => {
  console.error(err, "\nIsolated test profile:", profile);
  app.exit(1);
});
