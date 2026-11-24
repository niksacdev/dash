// Run the compiled test with npm run test:workflow.
import assert from "node:assert/strict";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {mock} from "node:test";
import {createServer} from "node:http";
import {once} from "node:events";
import {app,dialog} from "electron";
import {z} from "zod";
import {opikJudgeRequest} from "./opik-judge-fixture.cjs";
import {decodeApprovedPrompt} from "../lib/outcome-contracts.cjs";
import {decodeManifest} from "../lib/run-decode.cjs";
import power = require("../lib/power.cjs");

const profile = mkdtempSync(path.join(os.tmpdir(), "dash-workflow-smoke-"));
app.setPath("userData", profile);
app.dock?.hide();
app.on("browser-window-created", (_event, window) => {
  // This isolated test should never take focus from the user's DASH window.
  window.show = () => {};
});

const schema = z.looseObject({
  properties: z.record(z.string(), z.looseObject({type:z.unknown().optional()})).optional(),
});
const request = z.looseObject({
  model: z.string(),
  messages: z.array(z.looseObject({role:z.string(), content:z.string()})).min(1),
  format: schema.optional(),
  response_format: z.object({json_schema:z.object({schema})}).optional(),
  options: z.looseObject({num_predict:z.number().optional()}).optional(),
  max_tokens: z.number().optional(),
});
type Stage = "native-relevance" | "expert" | "implementer" | "route" | "analyzer" | "reporter" | "candidate" | "geval-score" | "geval-steps";
interface TransportCall {stage:Stage; body:z.infer<typeof request>; brief:unknown}
const calls:TransportCall[] = [];
const expertBrief = z.object({requirements:z.array(z.string())});
const datasetBrief = z.looseObject({dataset:z.looseObject({outputSchema:z.unknown()})});
const priorRunBrief = z.looseObject({priorRun:z.looseObject({id:z.string(),candidates:z.array(z.looseObject({scored:z.number()}))})});
const stageStatus = z.object({status:z.string()});
const gradedDetail = z.object({
  assessments:z.array(z.object({graderId:z.string(),value:z.number().nullable(),evaluator:z.string().optional()})),
  results:z.array(z.object({guardrail:z.object({status:z.string(),outputReserve:z.number()})})),
  report:z.object({verdict:z.string(),winnerId:z.string().nullable(),metrics:z.array(z.object({method:z.string()})),
    assistance:z.object({analyzer:stageStatus,reporter:stageStatus})}),
});
const models = { ollama: "lfm3-qa-7b", lmstudio: "qa-ledger-2b" };
const quickGoal = "Help inspection staff decide which nonconforming parts need a second inspection.";
const metric = "Measure the share of lots with cited inspection evidence.";
const guidance = "Cite the inspection record and identify the next review step.";
const roleEdit = "Trace the inspection record to the incoming lot.";

function modelOutput(stage:Stage, raw:unknown, model:string):unknown {
  if(stage==="native-relevance")return {answer_relevance_score:.9,reason:"The synthetic response addresses the supplied task."};
  if (stage === "route") return { domain: "Manufacturing" };
  if (stage === "expert") return {
    title: "Review incoming evidence",
    metrics: ["Share of cases with cited evidence"],
    requirements: ["Cite the evidence used for each decision"],
  };
  if (stage === "implementer") {
    const brief = z.object({expertBrief}).parse(raw);
    assert.ok(brief.expertBrief.requirements.length, "Expert output must reach the implementer");
    return { prompt: guidance };
  }
  if (stage === "analyzer") {
    const brief = z.object({evidence:z.array(z.object({id:z.string()})).min(1)}).parse(raw);
    return {evidence:[brief.evidence[0].id]};
  }
  if (stage === "reporter") {
    const brief = z.object({
      selected:z.array(z.object({id:z.string(),scores:z.array(z.number().nullable())})).min(1),
      auditedVerdict:z.record(z.string(),z.unknown()),
    }).parse(raw);
    const { id, scores } = brief.selected[0];
    let observation = "single";
    if (scores.includes(null)) observation = "missing";
    else if (scores.length === 2 && scores[0] !== null && scores[1] !== null)
      observation = scores[0] === scores[1] ? "equal" : scores[0] > scores[1] ? "first_higher" : "second_higher";
    return { ...brief.auditedVerdict, highlights: [{ evidence: id, observation }] };
  }
  if (stage === "geval-score") {
    const brief = z.object({output:z.string()}).parse(raw);
    const cited = brief.output.includes("QA inspection record");
    return { score: cited ? 10 : 0, reason: cited ? "The response cites the inspection record." : "The response lacks the required evidence." };
  }
  return { decision: "review", evidence: model === models.ollama ? "QA inspection record" : "QA response" };
}

// Only this dedicated loopback listener can receive real HTTP in the smoke test.
const localFetch=globalThis.fetch;
let decisionOrigin="", hostedGrades=0;
const decisionQuestion=z.object({model:z.string(),state:z.string(),questions:z.object({criterion:z.object({type:z.literal("noul"),instructions:z.string()})})});
function decisionAnswer(model:string,probability:number){
  return {model,answers:{criterion:{type:"noul",noul:probability}},usage:{input_tokens:12,output_tokens:0}};
}
const streamedQuick:{armed:boolean; send?:(part:0|1|2)=>void}={armed:false};

// Intercept HTTP at the transport boundary. Discovery, request formatting,
// streaming response parsing and all Electron IPC handlers remain in use.
globalThis.fetch = async (url, options = {}) => {
  const target = new URL(url instanceof Request ? url.url : url);
  if(decisionOrigin && target.origin===decisionOrigin)return localFetch(url,options);
  if(target.href==="https://openrouter.ai/api/alpha/decisions"){
    assert.equal(new Headers(options.headers).get("authorization"),"Bearer synthetic-workflow-smoke-key");
    assert.ok(typeof options.body==="string");
    const question=decisionQuestion.parse(JSON.parse(options.body));
    assert.equal(question.model,"typesafe/jev-1.14");
    hostedGrades++;
    return Response.json(decisionAnswer(question.model,.91));
  }
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
  assert.ok(typeof options.body === "string", "Expected a JSON request body");
  const body = request.parse(JSON.parse(options.body));
  const schema = body.format ?? body.response_format?.json_schema?.schema;
  const props = schema?.properties ?? {};
  const evaluation = opikJudgeRequest(body.messages);
  const stage = evaluation?.stage ?? (props.answer_relevance_score ? "native-relevance" : props.highlights ? "reporter" : props.evidence?.type === "array" ? "analyzer" :
    props.domain ? "route" : props.requirements ? "expert" : props.prompt ? "implementer" : "candidate");
  const brief:unknown = evaluation ? evaluation.evidence : stage === "candidate" || stage === "native-relevance" ? null : JSON.parse(body.messages[body.messages.length - 1].content);
  calls.push({ stage, body, brief });
  const content = stage === "geval-steps" ? "Check the inspection record citation against the supplied evidence." : JSON.stringify(modelOutput(stage, brief, body.model));
  if (target.pathname === "/api/chat") {
    if (streamedQuick.armed && stage==="candidate") {
      streamedQuick.armed=false;
      return new Response(new ReadableStream<Uint8Array>({start(controller) {
        const parts=[content.slice(0,4),content.slice(4,8),content.slice(8)];
        streamedQuick.send=part=>{
          const event={message:{content:parts[part]},done:part===2,...(part===2 && {done_reason:"stop",prompt_eval_count:21,eval_count:12})};
          controller.enqueue(new TextEncoder().encode(JSON.stringify(event)+"\n"));
          if (part===2) controller.close();
        };
      }}));
    }
    return new Response(JSON.stringify({ message: { content }, done: true, done_reason: "stop", prompt_eval_count: 21, eval_count: 12 }) + "\n");
  }
  if (target.pathname === "/api/v1/chat") {
    return Response.json({ output: [{ type: "message", content }], stats: { input_tokens: 21, total_output_tokens: 12 } });
  }
  return new Response("data: " + JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 21, completion_tokens: 12 } }) + "\n\ndata: [DONE]\n\n");
};

const readPower:typeof power.readPower = async () => ({watts:null,source:"QA",at:new Date().toISOString()});
const startPower:typeof power.startPower = async () => async () => ({
  source:"QA", scope:"Whole device", samples:[], average_w:null, peak_w:null,
  estimated_energy_j:null, sampled_seconds:0, interval_ms:1000,
});
mock.method(power, "readPower", readPower);
mock.method(power, "startPower", startPower);

async function smoke() {
  const win = await (await import("../desktop.cjs")).openWindow();
  const db = new DatabaseSync(path.join(profile, "dash.sqlite"), { readOnly: true });
  const q = JSON.stringify;
  const js = (source:string):Promise<unknown> => win.webContents.executeJavaScript(source);
  const text = async (source:string) => z.string().parse(await js(source));
  const exists = (selector:string) => js("!!document.querySelector(" + q(selector) + ")");
  async function wait(check:()=>unknown, message:string) {
    const until = Date.now() + 10000;
    do {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < until);
    throw Error(message + "\n" + await js("document.body.innerText.slice(-1600)"));
  }
  async function click(selector:string) {
    await wait(() => js("!!document.querySelector(" + q(selector) + ") && !document.querySelector(" + q(selector) + ").disabled"), "Missing enabled control " + selector);
    await js("document.querySelector(" + q(selector) + ").click(); true");
  }
  async function fill(selector:string, text:string) {
    await wait(() => exists(selector), "Missing input " + selector);
    await js("(() => { const field = document.querySelector(" + q(selector) + "); field.value = " + q(text) + "; field.dispatchEvent(new Event('input',{bubbles:true})); field.dispatchEvent(new Event('change',{bubbles:true})); return true; })()");
  }
  const route = (name:string) => js("location.hash=" + q(name));
  const records = () => db.prepare("SELECT spec FROM outcome_prompts ORDER BY rowid").all().map(row => decodeApprovedPrompt(JSON.parse(z.string().parse(row.spec))));
  async function completedRun(count:number) {
    await wait(() => db.prepare("SELECT count(*) n FROM runs WHERE status='completed'").get()?.n === count, "Expected " + count + " completed runs");
    return decodeManifest(db.prepare("SELECT manifest FROM runs ORDER BY rowid DESC LIMIT 1").get()?.manifest);
  }
  await wait(() => exists(".hero"), "Overview");
  const wc = win.webContents;
  wc.setBackgroundThrottling(false);
  wc.debugger.attach("1.3");
  const motion = (value:"no-preference"|"reduce") => wc.debugger.sendCommand("Emulation.setEmulatedMedia", {
    features: [{name:"prefers-reduced-motion", value}],
  });
  await motion("no-preference");
  const scene = () => js("document.querySelector('.capability-reel').dataset.scene");
  const caption = () => text("document.querySelector('.capability-frame h2').textContent");
  const previous = '[data-carousel="previous"]', next = '[data-carousel="next"]', playback = '[data-carousel="playback"]';
  const slideCount = await js("Number(document.querySelector('.capability-position').textContent.split('/')[1])");
  assert.equal(slideCount, 6);
  const isPlaying = () => js("document.querySelector('.capability-reel').dataset.playing === 'true'");
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
  for (const index of ["1", "2", "3", "4", "5", "0", "1"])
    await wait(async () => await scene() === index, "Automatic slide " + index);
  await click(playback);
  assert.equal(await isPlaying(), false);
  assert.equal(await caption(), "Compare and benchmark multiple models");
  assert.equal(await js("document.querySelectorAll('.banner-car').length"), 3);
  assert.ok(await js(`(async () => {
    const art = getComputedStyle(document.querySelector('.capability-reel'), '::before').backgroundImage;
    const source = art.match(/url\\("([^"]+)"\\)/)?.[1];
    if (!source || !source.endsWith('/scarlet-circuit.jpg')) return false;
    const image = new Image(); image.src = source; await image.decode();
    return image.naturalWidth > 0;
  })()`));
  await click(next);
  assert.equal(await caption(), "Run domain-specific use cases");
  assert.equal(await js("document.querySelector('.capability-context').textContent"), "Domain scenarios");
  assert.deepEqual(await js("Array.from(document.querySelectorAll('.industry-examples strong'), e => e.textContent)"),
    ["Financial Services", "Manufacturing", "Automotive"]);
  assert.match(await text("document.querySelector('.industry-examples figure:last-child small').textContent"), /Planned/);
  assert.ok(await js(`Promise.all(Array.from(document.querySelectorAll('.industry-examples img'), async img => {
    await img.decode();
    return img.currentSrc.startsWith('file:') && img.naturalWidth > 0 && img.checkVisibility({visibilityProperty:true});
  })).then(values => values.length === 3 && values.every(Boolean))`));
  assert.equal(await exists(".banner-track"), false);
  assert.equal(await js("document.querySelector('.hero').offsetHeight"), bannerHeight);
  await js("document.querySelector('[data-carousel=next]').focus()");
  wc.sendInputEvent({type:"keyDown", keyCode:"Right"});
  wc.sendInputEvent({type:"keyUp", keyCode:"Right"});
  await wait(async () => await scene() === "3", "Keyboard next slide");
  assert.equal(await caption(), "Score a whole set of cases");
  assert.equal(await js("document.querySelector('.hero').offsetHeight"), bannerHeight);
  await motion("reduce");
  await wait(() => js("!document.querySelector('.capability-reel').getAnimations({subtree:true}).length"), "Static reduced-motion carousel");
  await click(previous);
  assert.equal(await caption(), "Run domain-specific use cases");
  win.setMinimumSize(320,480);
  win.setContentSize(390,720);
  await wait(() => js("innerWidth <= 400"), "Phone-width carousel");
  assert.ok(await js("document.documentElement.scrollWidth <= innerWidth + 1"));
  assert.ok(await js("document.querySelector('[data-carousel=next]').getBoundingClientRect().width >= 44"));
  for (const width of [390, 780, 1310]) {
    await wc.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {width, height:850, deviceScaleFactor:1, mobile:false});
    const height = await js("document.querySelector('.hero').offsetHeight");
    assert.equal(await js("document.documentElement.scrollWidth <= innerWidth + 1"), true);
    for (const theme of ["light", "dark"]) {
      await js("document.querySelector('#appearance input[value=" + theme + "]').closest('label').click()");
      assert.ok(await js("Array.from(document.querySelectorAll('.industry-examples figcaption')).every(c => c.checkVisibility({visibilityProperty:true}) && c.scrollWidth <= c.clientWidth + 1)"));
      // Start and end on the approved industry slide. Inspect the actual visible art at each step.
      for (const visual of ["industries", "grading", "report", "hardware", "objective", "race"]) {
        assert.equal(await js("document.querySelector('.capability-reel').dataset.visual"), visual);
        assert.equal(await js("document.querySelectorAll('.banner-car').length"), visual === "race" ? 3 : 0);
        const background = await text("getComputedStyle(document.querySelector('.capability-reel'), '::before').backgroundImage");
        assert.equal(background.includes("scarlet-circuit.jpg"), visual === "race");
        const diagram = visual !== "race" && visual !== "industries";
        assert.equal(await exists(".capability-illustration .flow-diagram[role=img][aria-label]"), diagram);
        assert.equal(await js("document.querySelector('.hero').offsetHeight"), height);
        if (diagram) assert.ok(await js(`Array.from(document.querySelectorAll('.flow-diagram text')).every(t => {
          const r = t.getBoundingClientRect(), svg = t.closest('svg').getBoundingClientRect();
          return r.width > 0 && r.left >= svg.left - 1 && r.right <= svg.right + 1;
        })`), "Readable diagram at " + width + "px: " + visual);
        if (process.env.DASH_ART_PREVIEW_DIR) {
          const shot = z.object({data:z.string()}).parse(await wc.debugger.sendCommand("Page.captureScreenshot", {format:"png"}));
          writeFileSync(path.join(process.env.DASH_ART_PREVIEW_DIR, visual + "-" + width + "-" + theme + ".png"), Buffer.from(shot.data, "base64"));
        }
        await click(next);
      }
    }
    await click(next);
    assert.equal(await js("document.querySelector('.hero').offsetHeight"), height);
    await click(previous);
  }
  await wc.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
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
  assert.match(await text("document.querySelector('#wf-objective').value"), /Synthetic inspection record/);
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
  assert.equal(z.object({objective:z.string()}).parse(calls[1].brief).objective, quickGoal);
  assert.deepEqual(z.object({expertBrief}).parse(calls[2].brief).expertBrief.requirements, [criterion]);
  assert.deepEqual(z.object({metrics:z.array(z.string())}).parse(calls[2].brief).metrics, [metric]);
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
  assert.deepEqual(first.agents?.map(a => a.role).sort(), ["expert", "implementer"]);
  // Duplicate delivery and conflicting re-submission go through the public preload bridge.
  const approve = async (value:{draftId:string;prompt:string;metrics:string[]}) => z.object({id:z.string()}).parse(await js("window.dash.approvePrompt(" + q(value) + ")"));
  const repeat = { draftId: z.string().parse(first.draftId), prompt: approvedText, metrics: first.metrics };
  assert.equal((await approve(repeat)).id, first.id);
  await assert.rejects(() => approve({ ...repeat, prompt: "different" }), /already approved/i);
  assert.equal(records().length, 1);

  const pick = (provider:keyof typeof models) => '[data-model="' + provider + "/" + models[provider] + '"]';
  await wait(() => exists("#qc-criteria"), "Default outcome rubric");
  assert.equal(await js("document.querySelector('#qc-rubric-toggle').getAttribute('aria-pressed')"), "true");
  assert.match(await text("document.querySelector('#qc-criteria').value"), /inspection|lots/i);
  await fill("#qc-threshold","0.8");
  await click(pick("lmstudio"));
  assert.equal(await js("document.querySelector('#setup .go-button').disabled"), true);
  await click('[data-model="ollama/qa-short-context"]');
  await wait(() => exists('[data-qc-budget="ollama/qa-short-context"][data-budget-status="blocked"]'), "Short-context lane blocks GO");
  assert.equal(await js("document.querySelector('#setup .go-button').disabled"), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runs").get()?.n, 0);
  await click('[data-remove="ollama/qa-short-context"]');
  await click(pick("ollama"));
  await wait(() => exists('[data-qc-budget="ollama/'+models.ollama+'"][data-budget-status="unverified"]'), "Compatible lane budget preview");
  streamedQuick.armed=true;
  await click("#setup .go-button");
  await wait(()=>Promise.resolve(!!streamedQuick.send),"Quick stream opened");
  const sendPart=streamedQuick.send;
  assert.ok(sendPart);
  const liveField='[data-live-candidate="ollama/'+models.ollama+'"]';
  const expectedContent=JSON.stringify(modelOutput("candidate",null,models.ollama));
  sendPart(0);
  await wait(()=>js("document.querySelector("+q(liveField)+")?.textContent==="+q(expectedContent.slice(0,4))),"First visible response fragment");
  await js("document.querySelector("+q(liveField)+").dataset.qaIdentity='original'");
  sendPart(1);
  await wait(()=>js("document.querySelector("+q(liveField)+")?.textContent==="+q(expectedContent.slice(0,8))),"Incremental response fragment");
  assert.equal(await js("document.querySelector("+q(liveField)+").dataset.qaIdentity"),"original","A token update must retain the visible run view");
  sendPart(2);
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

  const quickRecords = gradedDetail.parse(await js("window.dash.detail(" + q(quick.id) + ")"));
  const business=quick.graders.filter(g=>!g.library?.automatic);
  assert.equal(business.length,1);
  assert.equal(business[0].threshold,.8);
  assert.equal(business[0].type,"opik");
  assert.match(business[0].opikEngine ?? "",/^opik-js@/);
  const baselines=quick.graders.filter(g=>g.type==="catalog");
  assert.deepEqual(baselines.map(g=>g.ruleKey).sort(),["completion","response-present"]);
  assert.ok(baselines.every(g=>g.library?.automatic));
  assert.equal(calls.filter(c=>c.stage==="geval-score").length,2);
  const businessScores=quickRecords.assessments.filter(a=>a.graderId===business[0].id);
  assert.ok(businessScores.every(a=>a.evaluator===business[0].opikEngine));
  assert.equal(businessScores.length,2);
  assert.deepEqual(businessScores.map(a=>a.value).sort(),[0,1]);
  for(const baseline of baselines)assert.equal(quickRecords.assessments.filter(a=>a.graderId===baseline.id).length,2);
  assert.ok(quickRecords.results.every(r=>r.guardrail.status==="unverified" && r.guardrail.outputReserve===180));
  assert.deepEqual(calls.filter(c => ["analyzer","reporter"].includes(c.stage)).map(c=>c.stage), ["analyzer","reporter"]);
  assert.equal(quickRecords.report.assistance.analyzer.status,"verified");
  assert.equal(quickRecords.report.assistance.reporter.status,"verified");
  assert.equal(quickRecords.report.verdict,"winner");
  assert.equal(quickRecords.report.winnerId,"ollama/"+models.ollama);
  assert.ok(quickRecords.report.metrics.some(m=>m.method==="opik-judge"));
  await wait(() => exists('.er-report[data-verdict="winner"]'), "Terminal winner report");
  const businessMetric=quickRecords.report.metrics.findIndex(m=>m.method==="opik-judge");
  const evidenceSelector='.er-evidence[data-metric-index="'+businessMetric+'"]';
  await click(evidenceSelector+" summary");
  await wait(() => js("document.querySelector('.er-evidence[open]').innerText.includes('lacks the required evidence')"), "Saved judge rationale");
  await click(evidenceSelector+" a");
  await wait(() => exists('[data-guardrail="unverified"]'), "Per-response capacity evidence");
  await route("roles");
  const role = 'form[data-wf-role][data-domain="Manufacturing"][data-role="expert"]';
  const area = role + ' textarea[name="instructions"]';
  await wait(() => exists(area), "Manufacturing expert editor");
  const prior = await text("document.querySelector(" + q(area) + ").value");
  await fill(area, prior + "\n" + roleEdit);
  await click(role + " button[type=submit]");
  await wait(() => db.prepare("SELECT MAX(version) AS v FROM outcome_agent_roles WHERE domain=? AND role=?").get("Manufacturing","expert")?.v === 2, "Saved revised role");
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
  assert.equal(first.agents?.find(a => a.role === "expert")?.version, 1);
  assert.equal(second.agents?.find(a => a.role === "expert")?.version, 2);
  assert.ok(calls.filter(c => c.stage === "expert").at(-1)?.body.messages[0].content.includes(roleEdit));
  assert.deepEqual(records()[0], first, "Revision preserves the approved original");

  await route("new");
  const scenario = z.string().parse(db.prepare("SELECT id FROM datasets WHERE pack='earnings' ORDER BY rowid LIMIT 1").get()?.id);
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
  assert.match(await text("document.querySelector('#wf-measure-fields').textContent"), /Financial Services expert/);
  await click("#wf-design");
  await wait(() => exists("#wf-prompt"), "Dataset prompt review");
  const proposalCalls = calls.slice(start);
  assert.deepEqual(proposalCalls.map(c => c.stage), ["expert", "implementer"]);
  for (const call of proposalCalls) {
    const brief = datasetBrief.parse(call.brief);
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
  assert.ok(datasetPrompt);
  assert.equal(datasetPrompt.domain, "Financial Services");
  assert.equal(z.object({datasetId:z.string()}).parse(datasetPrompt.dataset).datasetId, scenario);
  assert.equal(dataset.approvedPromptId, datasetPrompt.id);
  const dispatched = calls.slice(start).filter(c => c.stage === "candidate");
  assert.equal(dispatched.length, dataset.caseIds.length);
  for (const { body } of dispatched) {
    assert.deepEqual(body.format, datasetBrief.parse(proposalCalls[0].brief).dataset.outputSchema);
    assert.ok(body.messages.some(m => m.content.includes(datasetPrompt.prompt)));
    assert.doesNotMatch(JSON.stringify(body.messages), /\\"gold\\":/);
  }
  await route("run/" + dataset.id);
  await click('[data-source-run="' + dataset.id + '"]');
  const beforeRefinement = calls.length;
  await click("#wf-design");
  await wait(() => exists("#wf-prompt"), "Run-informed prompt review");
  for (const call of calls.slice(beforeRefinement)) {
    const brief = priorRunBrief.parse(call.brief);
    assert.equal(brief.priorRun.id, dataset.id);
    assert.equal(brief.priorRun.candidates[0].scored, dataset.caseIds.length);
    assert.doesNotMatch(JSON.stringify(brief.priorRun), /QA response|gold/);
  }
  // Create and revise one grader as an operator would. The scoring server and
  // credential are synthetic; the IPC, validation, version store and UI are real.
  process.env.OPENROUTER_API_KEY="synthetic-workflow-smoke-key";
  const localAlias="qa/decision", localQuestions:string[]=[];
  const checkpoint=mkdtempSync(path.join(profile,"synthetic-checkpoint-"));
  let mlxGrades=0;
  const server=createServer(async(req,res)=>{
    res.setHeader("content-type","application/json");
    if(req.method==="GET" && req.url==="/health"){
      res.end(JSON.stringify({status:"healthy",loaded_models:{decision:{model:checkpoint,model_kind:"decision",adapter:null}}}));return;
    }
    if(req.method==="POST" && req.url==="/v1/decisions"){
      let raw="";
      for await(const chunk of req)raw+=String(chunk);
      try{
        const {model}=z.object({model:z.literal(checkpoint)}).parse(JSON.parse(raw));
        mlxGrades++;
        res.end(JSON.stringify({model,answers:{criterion:{type:"bool",value:true,probability:.94}},usage:{input_tokens:12,output_tokens:0}}));
      }catch{res.statusCode=400;res.end("{}");}
      return;
    }
    if(req.method==="GET" && req.url==="/v1/models"){
      res.end(JSON.stringify({data:[{id:localAlias,architecture:{output_modalities:["decisions"]}}]}));return;
    }
    if(req.method==="POST" && req.url==="/v1/systemone"){
      let body="";
      for await(const chunk of req)body+=String(chunk);
      try {
        const question=decisionQuestion.parse(JSON.parse(body));
        assert.equal(question.model,localAlias);
        localQuestions.push(question.state);
        res.end(JSON.stringify(decisionAnswer(localAlias,question.state.includes("UNCERTAIN")?.5:.92)));
      } catch {res.statusCode=400;res.end("{}");}
      return;
    }
    res.statusCode=404;res.end("{}");
  });
  server.listen(0,"127.0.0.1");
  await once(server,"listening");
  try {
    const address=server.address();
    assert.ok(address && typeof address!=="string");
    decisionOrigin="http://127.0.0.1:"+address.port;
    await route("graders");
    await wait(()=>exists("#grade-create"),"Grader editor");
    win.setContentSize(390,720);
    await wait(()=>js("innerWidth<=400"),"Phone-width catalog");
    assert.ok(await js("document.documentElement.scrollWidth<=innerWidth+1"),"Catalog fits a phone viewport");
    assert.ok(await js("document.querySelector('[data-customize]').getBoundingClientRect().height>=44"),"Touch-size catalog action");
    win.setContentSize(1280,850);
    await js("document.querySelector('#grade-create').closest('details').open=true");
    await fill("#grade-type","decision");
    await click("[data-decision-starter=earnings]");
    assert.equal(await text("document.querySelector('#grade-create [name=industry]').value"),"Financial Services");
    await click("[data-decision-starter=inspection]");
    const criterion=await text("document.querySelector('#grade-create [name=criteria]').value");
    assert.match(criterion,/current drawing revision/);
    assert.equal(await js("document.querySelector('#grade-create [value=reference]').checked"),true);
    await fill("[name=decision-endpoint]",decisionOrigin);
    await click("#grade-discover");
    await wait(()=>js("document.querySelector('[name=decision-model]').value==="+q(localAlias)),"Discovered served decision model");
    const reveal=async(selector:string)=>{
      await wait(()=>exists(selector),"Available control "+selector);
      await js("(() => {for(let node=document.querySelector("+q(selector)+");node;node=node.parentElement)if(node instanceof HTMLDetailsElement)node.open=true})()");
    };
    const primaryAlias="qa/unloaded-primary";
    await fill("[name=decision-model]",primaryAlias);
    await reveal("[name=decision-fallback]");await fill("[name=decision-fallback]",localAlias);
    await click("#grade-create button.yellow");
    const versionId=(n:number)=>db.prepare("SELECT id FROM graders WHERE json_extract(spec,'$.name')=? AND version=?").get("Inspection disposition evidence",n)?.id;
    await wait(()=>versionId(1),"Saved local decision grader");
    const localId=z.string().parse(versionId(1));
    const manualCount=()=>Number(db.prepare("SELECT count(*) n FROM assessments WHERE run IS NULL").get()?.n);
    async function provideSample(id:string,output:string,reference:string) {
      await wait(()=>exists('#grade-sample [value="'+id+'"]'),"Grader available to assess");
      await fill("#grade-sample [name=grader]",id);
      await fill("#grade-sample [name=input]","Synthetic lot B at 10.04 mm; current upper limit 10.03 mm.");
      await fill("#grade-sample [name=output]",output);
      await reveal("#grade-sample [name=reference]");await fill("#grade-sample [name=reference]",reference);
      await click("#grade-sample button");
    }
    const manualStart=manualCount();
    await provideSample(localId,"Hold lot B.","");
    await wait(()=>manualCount()===manualStart+1,"Missing required evidence recorded");
    await wait(()=>js("document.querySelector('#screen table')?.innerText.includes('Unscored')"),"Unscored evidence shown");
    assert.equal(localQuestions.length,0);
    await provideSample(localId,"Hold lot B.","Current drawing calls for a hold.");
    await wait(()=>js("document.querySelector('#screen table')?.innerText.includes('P(yes) 0.92')"),"Local decision probability");
    assert.match(await text("document.querySelector('#screen table').innerText"),/Alternate model used/);
    assert.equal(localQuestions.length,1);
    assert.match(localQuestions[0],/Current drawing calls for a hold/);
    await provideSample(localId,"UNCERTAIN: hold for reinspection.","Current drawing calls for a hold.");
    await wait(()=>js("document.querySelector('#screen table')?.innerText.includes('Abstained · unscored')"),"Uncertain decision excluded from numeric scores");
    assert.equal(manualCount(),manualStart+3);
    await click('[data-revise="'+localId+'"]');
    await wait(()=>js("document.querySelector('#grade-create [name=decision-model]').value==="+q(primaryAlias)),"Pinned model in the revision editor");
    await fill("[name=decision-provider]","openrouter");
    await fill("[name=decision-hosted-model]","typesafe/jev-1.14");
    await click("#grade-create input[value=reference]");
    assert.equal(await text("document.querySelector('#grade-create [name=criteria]').value"),criterion);
    await click("#grade-create button.yellow");
    await wait(()=>versionId(2),"New hosted version of the same criterion");
    const hostedId=z.string().parse(versionId(2));
    assert.notEqual(hostedId,localId);
    const loadedAgain=once(win.webContents,"did-finish-load");
    win.webContents.reload();await loadedAgain;
    await wait(()=>exists("#grade-sample"),"Saved grader versions after reload");
    await js("window.consentPrompts=[];window.allowNextDecision=false;window.confirm=s=>{window.consentPrompts.push(s);const answer=window.allowNextDecision;window.allowNextDecision=false;return answer};true");
    await provideSample(hostedId,"Hold lot B.","Current drawing calls for a hold.");
    assert.equal(manualCount(),manualStart+3);
    assert.equal(hostedGrades,0);
    const confirmation=await text("window.consentPrompts.at(-1)");
    assert.match(confirmation,/OpenRouter/);assert.match(confirmation,/typesafe\/jev-1.14/);assert.match(confirmation,/reference answer/);
    await js("window.allowNextDecision=true");
    await click("#grade-sample button");
    await wait(()=>js("document.querySelector('#screen table')?.innerText.includes('P(yes) 0.91')"),"Consented hosted sample");
    assert.equal(hostedGrades,1);
    await route("prompts");
    await click('[data-wf-use="'+first.id+'"]');
    await reveal('[name=qc-saved-grader][value="'+hostedId+'"]');
    await click('[name=qc-saved-grader][value="'+hostedId+'"]');
    for(const provider of ["ollama","lmstudio"] as const){
      const item=pick(provider);
      if(await js("document.querySelector("+q(item)+").getAttribute('aria-pressed')")!=="true")await click(item);
    }
    const runCount=()=>Number(db.prepare("SELECT count(*) n FROM runs").get()?.n),beforeHostedRun=runCount();
    await click("#setup .go-button");
    assert.match(await text("window.consentPrompts.at(-1)"),/Quick comparison/);
    assert.equal(runCount(),beforeHostedRun);
    await route("new");
    await fill("#pack","manufacturing");
    const inspectionId=z.string().parse(db.prepare("SELECT id FROM datasets WHERE pack='manufacturing' ORDER BY rowid LIMIT 1").get()?.id);
    await fill("#ds",inspectionId);
    await reveal('[name=custom-grader][value="'+hostedId+'"]');
    await click('[name=custom-grader][value="'+hostedId+'"]');
    const localCandidate='#dataset-models [data-model="ollama/'+models.ollama+'"]';
    await wait(()=>exists(localCandidate),"Dataset model selection");
    for(const id of z.array(z.string()).parse(await js("Array.from(document.querySelectorAll('#dataset-models [data-remove]'),e=>e.dataset.remove)")))
      if(id!=="ollama/"+models.ollama)await click('#dataset-models [data-remove="'+id+'"]');
    if(await js("document.querySelector("+q(localCandidate)+").getAttribute('aria-pressed')")!=="true")await click(localCandidate);
    await click("#dataset-run-form button[type=submit]");
    assert.match(await text("window.consentPrompts.at(-1)"),/dataset run of/);
    assert.equal(runCount(),beforeHostedRun);assert.equal(hostedGrades,1);
    await js("window.allowNextDecision=true");
    await click("#dataset-run-form button[type=submit]");
    const hostedRun=await completedRun(4);
    assert.ok(hostedRun.graders.some(g=>g.id===hostedId));
    assert.equal(hostedGrades,1+hostedRun.caseIds.length);
    await route("run/"+hostedRun.id+"/0");
    await click("[data-act=rerun]");
    assert.match(await text("window.consentPrompts.at(-1)"),/rerun of case/);
    assert.equal(runCount(),beforeHostedRun+1);
    await fill("#grade-case [name=grader]",hostedId);
    await click("#grade-case button");
    assert.match(await text("window.consentPrompts.at(-1)"),/this saved case/);
    assert.equal(hostedGrades,1+hostedRun.caseIds.length);
    await route("graders");
    await click('[data-revise="'+hostedId+'"]');
    await wait(()=>js("document.querySelector('[name=decision-provider]').value==='openrouter'"),"Reopen hosted version");
    await fill("[name=decision-provider]","local");
    await fill("[name=decision-protocol]","mlx-vlm");
    await fill("[name=decision-endpoint]",decisionOrigin);
    await click("#grade-discover");
    await wait(()=>js("document.querySelector('[name=decision-model]').value==="+q(checkpoint)),"MLX preloaded checkpoint from health");
    await click("#grade-create button.yellow");
    await wait(()=>versionId(3),"Pinned MLX grader version");
    const mlxId=z.string().parse(versionId(3));
    await provideSample(mlxId,"Hold lot B.","Current drawing calls for a hold.");
    await wait(()=>js("document.querySelector('#screen table')?.innerText.includes('P(yes) 0.94')"),"Native MLX decision score");
    assert.equal(mlxGrades,1);
    // Customize a shipped check, change its scoring method in a new revision,
    // and find two saved runs from the exact grader version.
    for(const section of ["general","industry","customer"])assert.ok(await exists('[data-catalog-scope="'+section+'"]'));
    const shippedId=(key:string)=>z.string().parse(db.prepare("SELECT id FROM graders WHERE json_extract(spec,'$.ruleKey')=? AND json_extract(spec,'$.library.scope')!='customer'").get(key)?.id);
    const original=shippedId("response-present");
    await click('[data-customize="'+original+'"]');
    await wait(()=>js("document.querySelector('#grade-create [name=criteria]').readOnly"),"Deterministic catalog criterion pinned");
    const alias="QA lot tag", loadVersion=(name:string,version:number)=>db.prepare("SELECT id FROM graders WHERE json_extract(spec,'$.name')=? AND version=?").get(name,version)?.id;
    await fill("#grade-create [name=name]",alias);
    await click("#grade-create button.yellow");
    await wait(()=>loadVersion(alias,1),"Independent customer fork");
    const v1=z.string().parse(loadVersion(alias,1));
    assert.notEqual(v1,original);
    await click('[data-revise="'+v1+'"]');
    await wait(()=>js("document.querySelector('#grade-create [name=name]').value==="+q(alias)),"Customer version editor");
    await fill("#grade-type","contains");
    assert.equal(await js("document.querySelector('#grade-create [name=criteria]').readOnly"),false);
    await fill("#grade-create [name=criteria]","QA");
    await fill("#grade-create [name=industry]","Manufacturing");
    await click("#grade-create button.yellow");
    await wait(()=>loadVersion(alias,2),"Customer method revision");
    const v2=z.string().parse(loadVersion(alias,2));
    const lineage=()=>z.array(z.object({id:z.string(),library:z.object({scope:z.string(),familyId:z.string(),parentRevisionId:z.string().optional()})})).parse(
      [v1,v2].map(id=>JSON.parse(z.string().parse(db.prepare("SELECT spec FROM graders WHERE id=?").get(id)?.spec))));
    const [fork,revision]=lineage();
    assert.equal(fork.library.scope,"customer");assert.equal(fork.library.parentRevisionId,original);
    assert.equal(revision.library.familyId,fork.library.familyId);assert.equal(revision.library.parentRevisionId,v1);

    await click('[data-grade-template="answer-relevance"]');
    await wait(()=>js("document.querySelector('#grade-type').value==='opik-metric'"),"Native Opik rubric configured");
    await fill("#grade-create [name=name]","QA native relevance");
    await fill("#grade-create [name=judgeId]","ollama/"+models.ollama);
    await click("#grade-create button.yellow");
    await wait(()=>loadVersion("QA native relevance",1),"Saved native metric and judge");
    const relevance=z.string().parse(loadVersion("QA native relevance",1));
    await click('[data-grade-default="'+relevance+'"]');
    await wait(()=>exists('[data-grade-default="'+relevance+'"][aria-pressed=true]'),"Opted into an automatic semantic metric");
    await route("prompts");await click('[data-wf-use="'+first.id+'"]');
    await wait(()=>js("document.querySelector('#qc-grading .gc-auto')?.innerText.includes('QA native relevance')"),"Native default in Quick preview");
    await route("graders");await click('[data-grade-default="'+relevance+'"]');
    await wait(()=>exists('[data-grade-default="'+relevance+'"][aria-pressed=false]'),"Disabled future semantic baseline");
    await route("new");
    await fill("#pack","earnings");await fill("#ds",scenario);
    const optionFor=(id:string)=>'[name=custom-grader][value="'+id+'"]';
    await wait(()=>exists(optionFor(shippedId("earnings-amount"))),"Compatible Financial Services rule");
    assert.equal(await exists(optionFor(v2)),false);
    assert.equal(await exists(optionFor(shippedId("inspection-reading"))),false);
    await fill("#pack","manufacturing");await fill("#ds",inspectionId);
    const inspectionRule=shippedId("inspection-reading");
    await reveal(optionFor(inspectionRule));await click(optionFor(inspectionRule));
    // The earlier explicitly chosen hosted grader remains attached to this snapshot.
    if(await js("document.querySelector("+q(optionFor(hostedId))+")?.checked"))await click(optionFor(hostedId));
    await click(optionFor(v2));
    const uses:string[]=[];
    for(const count of [5,6]){
      await wait(()=>js("document.querySelector("+q(optionFor(v2))+")?.checked"),"Selected revision restored");
      await click("#dataset-run-form button[type=submit]");
      const run=await completedRun(count);uses.push(run.id);
      assert.ok(run.graders.some(g=>g.id===v2));assert.ok(run.graders.some(g=>g.id===inspectionRule));
      assert.ok(run.graders.some(g=>g.type==="catalog" && g.ruleKey==="json-valid"));
      assert.ok(!run.graders.some(g=>g.id===v1 || g.id===relevance));
      if(count===5){
        await route("graders");await click('[data-revise="'+v2+'"]');
        await wait(()=>js("document.querySelector('#grade-create [name=criteria]').value==='QA'"),"Reopen customer v2");
        await fill("#grade-create [name=criteria]","QA version three");await click("#grade-create button.yellow");
        await wait(()=>loadVersion(alias,3),"Published successor");
        await route("new");
        const v3=z.string().parse(loadVersion(alias,3));
        await wait(()=>exists(optionFor(v3)),"Successor offered alongside earlier revision");
        assert.equal(await js("document.querySelector("+q(optionFor(v3))+").checked"),false);
      }
    }
    await route("graders");
    const history='[data-grade-version="'+v2+'"] [data-grade-uses]';
    await reveal('[data-grade-history="'+v2+'"]');await click('[data-grade-history="'+v2+'"]');
    await wait(()=>js("document.querySelectorAll("+q(history+" a")+").length===2"),"Two linked runs on the exact customer revision");
    for(const id of uses)assert.ok(await exists(history+' a[href="#run/'+id+'"]'));
    await reveal('[data-grade-history="'+v1+'"]');await click('[data-grade-history="'+v1+'"]');
    await wait(()=>js("document.querySelector("+q('[data-grade-version="'+v1+'"] [data-grade-uses]')+").innerText.includes('No saved runs')"),"No uses attributed to predecessor");

    const importFile=path.join(profile,"catalog-inputs.jsonl");
    const pickFile=mock.method(dialog,"showOpenDialog",async()=>({canceled:false,filePaths:[importFile]}));
    const onlyInput={case_id:"catalog-input",dataset_version:"1",split:"development",prompt:"What is the next action for synthetic lot B?"};
    async function referenceSnapshot(name:string,rows:readonly object[]){
      writeFileSync(importFile,rows.map(row=>JSON.stringify(row)).join("\n")+"\n");
      const metadata={industry:"Manufacturing",family:name,category:"QA",tags:[],source:"Synthetic smoke",changeNote:"",parentId:null};
      return text("window.dash.import('reference').then(draft=>window.dash.commitImport(draft.token,"+q(metadata)+"))");
    }
    let inputOnly:string, mixed:string;
    try{
      inputOnly=await referenceSnapshot("Input-only catalog QA",[onlyInput]);
      mixed=await referenceSnapshot("Mixed rubric QA",[onlyInput,{...onlyInput,case_id:"catalog-rubric",rubric:"Credit a response that cites the lot identifier."}]);
    }finally{pickFile.mock.restore();}
    await route("new");await fill("#pack","reference");await fill("#ds",inputOnly);
    await wait(()=>js("document.querySelector('#dataset-scoring-issue')?.innerText.includes('without a reference')"),"Structural checks alone cannot grade an input-only case");
    assert.equal(await js("document.querySelector('#dataset-run-form .go-button').disabled"),true);
    await route("graders");await click('[data-grade-default="'+relevance+'"]');
    await wait(()=>exists('[data-grade-default="'+relevance+'"][aria-pressed=true]'),"Enable the local semantic default");
    await route("new");await fill("#ds",mixed);
    await wait(()=>js("document.querySelector('#dataset-scoring-issue')?.innerText.includes('rubric-aware')"),"Case-specific rubric still needs its own judge");
    assert.equal(await js("document.querySelector('#dataset-run-form .go-button').disabled"),true);
    await fill("#ds",inputOnly);
    await wait(()=>js("!document.querySelector('#dataset-run-form .go-button').disabled"),"Enabled native metric can grade an input-only snapshot");
    await click("#dataset-run-form button[type=submit]");
    const semantic=await completedRun(7);
    assert.equal(semantic.datasetId,inputOnly);
    assert.ok(semantic.graders.some(g=>g.type==="opik-metric" && g.id===relevance));
    const grade=await js("window.dash.detail("+q(semantic.id)+").then(r=>r.assessments.find(a=>a.graderId==="+q(relevance)+").value)");
    assert.equal(grade,.9);

    // Five explicit graders fit within the selection limit. Automatic defaults make nine saved pins.
    const scenarioGraders=["inspection-drawing","inspection-reading","inspection-disposition","inspection-handoff"].map(shippedId);
    const largeParentId=await text("window.dash.start("+q({
      mode:"dataset",datasetId:inspectionId,caseId:"shaft-superseded-revision",candidateIds:["ollama/"+models.ollama],
      graderIds:[...scenarioGraders,v2],animation:false,
    })+")");
    const largeParent=await completedRun(8);
    assert.equal(largeParent.id,largeParentId);
    assert.equal(largeParent.graders.length,9);
    await route("graders");
    await click('[data-grade-default="'+relevance+'"]');
    await wait(()=>exists('[data-grade-default="'+relevance+'"][aria-pressed=false]'),"Workspace default changed since parent ran");
    await route("run/"+largeParent.id+"/0");
    await click("[data-act=rerun]");
    const repeated=await completedRun(9);
    assert.equal(repeated.parentId,largeParent.id);
    assert.deepEqual(repeated.caseIds,largeParent.caseIds);
    assert.deepEqual(repeated.graders,largeParent.graders);
  } finally {
    decisionOrigin="";
    server.closeAllConnections();server.close();
  }
  db.close();
}

app.whenReady().then(smoke).then(() => {
  console.log("Workflow smoke passed: mobile planning, automatic Quick judging, winner and case rationale, blocked preflight, direct dataset runs, approved variants, revisions, decision-grader consent, catalog forks, pinned prior revisions across two runs, native metric defaults and version-specific run links.");
  rmSync(profile, { recursive: true, force: true });
  app.exit(0);
}).catch(err => {
  console.error(err, "\nIsolated test profile:", profile);
  app.exit(1);
});
