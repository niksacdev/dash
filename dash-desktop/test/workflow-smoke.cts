// Run the compiled test with npm run test:workflow.
import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
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
type Stage = "grader-plan" | "audit" | "native-relevance" | "expert" | "implementer" | "route" | "analyzer" | "reporter" | "candidate" | "geval-score" | "geval-steps";
let inlineDesignerFixture=false;
let holdRouting: (()=>Promise<void>) | undefined;
interface TransportCall {stage:Stage; body:z.infer<typeof request>; brief:unknown}
const calls:TransportCall[] = [];
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
const markerMetric="Share of responses correctly including the QA response marker.";
const markerCriterion="Include the literal text QA response in the answer.";
const guidance = "Cite the inspection record and identify the next review step.";
const roleEdit = "Trace the inspection record to the incoming lot.";

function modelOutput(stage:Stage, raw:unknown, model:string):unknown {
  if(stage==="grader-plan") {
    const {goals,automatic}=z.object({goals:z.array(z.object({key:z.string(),metric:z.string()})),
      automatic:z.array(z.object({option:z.string(),name:z.string()}))}).parse(raw);
    if (inlineDesignerFixture) return Object.fromEntries(goals.map(({key,metric:goal},i)=>[key,{
      choice:"NEW:judge",name:"Reviewed Quick measure "+(i+1),criteria:"Assess this answer independently for "+goal,
      anchors:{full:"Includes the named item and ties it to the decision.",partial:"Mentions the item without a decision.",
        zero:"Omits the item entirely.",evidence:"response"},threshold:.85,reason:"This measure can be checked in the supplied answer."
    }]));
    return Object.fromEntries(goals.map(({key,metric},i)=>[key,metric==="Response present"?
      {choice:z.string().parse(automatic.find(g=>g.name===metric)?.option),reason:"   The response-presence check detects an empty answer.   "}:
      {choice:"NEW:judge",name:i?"Evidence citation":"Inspection disposition reasoning",
      criteria:i?"Check whether the answer cites the current inspection record.":"Assess the proposed disposition against the supplied inspection details.",
      anchors:{full:"Cites the record and connects it to the decision.",partial:"Names a record without connecting the decision.",zero:"Omits the record.",evidence:"response"},
      threshold:i ? .8 : .9,reason:"A local judge can evaluate the supplied answer."}]));
  }
  if(stage==="native-relevance")return {answer_relevance_score:.9,reason:"The synthetic response addresses the supplied task."};
  if (stage === "route") return { domain: "Manufacturing" };
  if (stage === "expert") return {
    title: "Review incoming evidence",
    metrics: ["Share of cases with cited evidence",...(z.object({objective:z.string()}).parse(raw).objective===quickGoal?[markerMetric]:[])],
    requirements: ["Cite the evidence used for each decision",...(z.object({objective:z.string()}).parse(raw).objective===quickGoal?[markerCriterion]:[])],
  };
  if (stage === "audit") {
    const check=z.object({metric:z.string(),criterion:z.string()});
    const {proposals}=z.object({proposals:z.array(check)}).parse(raw);
    return {audit:proposals.map(pair=>({...pair,status:"needs-evidence",evidenceBasis:"reference",
      evidence:"A labeled case with the expected decision and the candidate response.",
      method:"Compare the decision and supporting citation with the source case.",
      reason:"The cited record allows a grader to check the requested inspection decision."}))};
  }
  if (stage === "implementer") {
    const brief=z.looseObject({objective:z.string().min(1)}).parse(raw);
    assert.equal(brief.expertBrief,undefined,"Held-out grader criteria stay with the evaluators");
    return { prompt: guidance, reason:"Asking for a citation lets the grader locate the inspection evidence.",
      ...(typeof brief.formatInstructions==="string" && {fields:[{name:"decision",type:"string",nullable:false}],
        inputs:[{name:"lot",value:"K7"}]}) };
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
  const stage = evaluation?.stage ?? (props.M1 ? "grader-plan" : props.answer_relevance_score ? "native-relevance" : props.highlights ? "reporter" : props.evidence?.type === "array" ? "analyzer" :
    props.audit ? "audit" : props.domain ? "route" : props.requirements ? "expert" : props.prompt ? "implementer" : "candidate");
  const brief:unknown = evaluation ? evaluation.evidence : stage === "candidate" || stage === "native-relevance" ? null : JSON.parse(body.messages[body.messages.length - 1].content);
  calls.push({ stage, body, brief });
  if (stage==="route" && holdRouting) await holdRouting();
  const structuredCandidate=stage==="candidate" && !!props.lotCode;
  const content = structuredCandidate ? JSON.stringify(body.model===models.ollama ? {decision:"review",lotCode:"K7"} : {decision:"review"}) : stage === "geval-steps" ? "Check the inspection record citation against the supplied evidence." : JSON.stringify(modelOutput(stage, brief, body.model));
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
  async function checkRosterColors() {
    const original = await text("document.documentElement.dataset.appearance");
    for (const theme of ["light", "dark"]) {
      await click('#appearance input[value="' + theme + '"] + span');
      const palette = await js(`(() => {
        const picker = document.querySelector(".model-picker");
        const selected = picker.querySelector('[data-model][aria-pressed="true"]');
        const other = picker.querySelector('[data-model][aria-pressed="false"]');
        const style = element => getComputedStyle(element);
        return {
          action: style(document.querySelector(".header-actions .button")).backgroundColor,
          selected: style(selected).backgroundColor,
          other: style(other).backgroundColor,
          metadata: style(other.querySelector("small")).color,
          disabled: other.disabled,
          addVisible: style(other.querySelector("i")).visibility === "visible",
          removable: !selected.disabled && selected.querySelector("i").textContent === "✓",
        };
      })()`);
      const colors = z.object({action:z.string(), selected:z.string(), other:z.string(), metadata:z.string(),
        disabled:z.boolean(), addVisible:z.boolean(), removable:z.boolean()}).parse(palette);
      assert.equal(colors.action, "rgb(255, 207, 0)");
      assert.notEqual(colors.selected, colors.action);
      assert.notEqual(colors.other, colors.action);
      assert.notEqual(colors.selected, colors.other);
      assert.notEqual(colors.metadata, colors.other);
      assert.equal(colors.addVisible, !colors.disabled);
      assert.ok(colors.removable);
    }
    await click('#appearance input[value="' + original + '"] + span');
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
  async function verifyStructuredQuick() {
    await route("compare");
    await wait(()=>js("!!document.querySelector('#wf-structured,[data-wf-reset]')"),"Quick planner or an approved prompt");
    if(await exists("[data-wf-reset]"))await click("[data-wf-reset]");
    await wait(()=>exists("#wf-structured"),"Structured output option");
    assert.equal(await js("document.querySelector('#wf-structured').checked"),false);
    await click('[data-wf-example="manufacturing"]');
    await click("#wf-structured");
    await fill("#wf-output-cap","150");
    await click("#wf-design");
    await wait(()=>exists("#wf-json-input"),"Review the generated JSON contract");
    const input=z.object({task:z.string(),inputs:z.record(z.string(),z.string())}).parse(JSON.parse(await text("document.querySelector('#wf-json-input').value")));
    assert.equal(input.inputs.lot,"K7");
    assert.match(input.task,/10.04 mm/);
    const reviewed={...input,inputs:{...input.inputs,reading:"10.04 mm"}};
    const contract={type:"object",properties:{decision:{type:"string"},lotCode:{type:"string"}},required:["decision","lotCode"],additionalProperties:false};
    await fill("#wf-json-input",JSON.stringify(reviewed));
    await fill("#wf-json-schema","{");
    await click("#wf-approve");
    await wait(()=>js("document.querySelector('[role=alert]')?.textContent.includes('Enter valid JSON')"),"Show which JSON document needs correction");
    await fill("#wf-json-schema",JSON.stringify(contract));
    await click("#wf-approve");
    await wait(()=>exists("#setup .go-button"),"Approved structured prompt");
    const approved=records().at(-1);
    assert.deepEqual(approved?.input,reviewed);
    assert.deepEqual(approved?.outputSchema,contract);
    const start=calls.length;
    await click('[data-model="lmstudio/'+models.lmstudio+'"]');
    await click('[data-model="ollama/qa-short-context"]');
    await wait(()=>exists('[data-qc-budget="ollama/qa-short-context"][data-budget-status="blocked"]'),"Short context blocks this JSON contract");
    assert.equal(await js("document.querySelector('#setup .go-button').disabled"),true);
    await click('[data-remove="ollama/qa-short-context"]');
    await click('[data-model="ollama/'+models.ollama+'"]');
    await click("#setup .go-button");
    await wait(()=>exists(".wf-structure-result"),"Per-model JSON conformance");
    const summary=await text("document.querySelector('.wf-structure-result').innerText");
    assert.match(summary,/Conforms/);
    assert.match(summary,/Does not conform/);
    assert.match(summary,/Missing required field: lotCode/);
    const dispatched=calls.slice(start).filter(call=>call.stage==="candidate");
    assert.equal(dispatched.length,2);
    for(const {body} of dispatched){
      assert.deepEqual(JSON.parse(body.messages.at(-1)?.content ?? ""),reviewed);
      assert.deepEqual(body.format ?? body.response_format?.json_schema.schema,contract);
    }
  }
  await wait(() => exists(".hero"), "Overview");
  if(process.argv.includes("--structured-quick")){
    try {await verifyStructuredQuick();}finally{db.close();}
    return;
  }
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
  await click(previous);
  assert.equal(await scene(), String(slideCount - 1));
  assert.equal(await caption(), "Hardware in the Loop");
  assert.equal(await js("document.querySelector('.capability-context').textContent"), "FUTURES");
  assert.deepEqual(await js("Array.from(document.querySelectorAll('.flow-diagram text'), t => t.textContent)"),
    ["PHYSICAL", "Controller", "SIMULATED", "Motor", "Drive command", "Speed feedback"]);
  assert.equal(await isPlaying(), false);
  await click(next);
  assert.equal(await scene(), "0");
  await click(playback);
  assert.equal(await isPlaying(), true);
  await js("document.querySelector('.capability-frame').getAnimations()[0].updatePlaybackRate(20)");
  for (const index of ["1", "2", "3", "4", "5", "0", "1", "2"])
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
  await js("document.querySelector('[data-carousel=next]').focus()");
  wc.sendInputEvent({type:"keyDown", keyCode:"Right"});
  wc.sendInputEvent({type:"keyUp", keyCode:"Right"});
  await wait(async () => await scene() === "3", "Keyboard next slide");
  assert.equal(await caption(), "Grade each answer against your rubric");
  assert.ok(await js("Array.from(document.querySelectorAll('.flow-diagram text'), t => t.textContent).includes('AI Industry Graders')"));
  assert.equal(await js("document.querySelector('.hero').offsetHeight"), bannerHeight);
  await motion("reduce");
  await wait(() => js("!document.querySelector('.capability-reel').getAnimations({subtree:true}).length"), "Static reduced-motion carousel");
  await click(next);
  assert.equal(await caption(), "See why an answer passed or failed");
  assert.equal(await js("document.querySelector('.capability-context').textContent"), "Traceability and Observability");
  await click(next);
  await click(next);
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
      for (const visual of ["industries", "objective", "race", "grading", "report", "hardware"]) {
        assert.equal(await js("document.querySelector('.capability-reel').dataset.visual"), visual);
        assert.equal(await js("document.querySelectorAll('.banner-car').length"), visual === "race" ? 3 : 0);
        const background = await text("getComputedStyle(document.querySelector('.capability-reel'), '::before').backgroundImage");
        assert.equal(background.includes("scarlet-circuit.jpg"), visual === "race");
        if (visual === "objective") {
          assert.equal(await caption(), "Task Objective, Success Metrics (AI Optimized)");
          assert.deepEqual(await js("Array.from(document.querySelectorAll('.flow-diagram .diagram-value'), t => t.textContent)"),
            ["Flag out-of-spec", "bearings", "Defects caught (%)", "Good parts flagged (%)"]);
        }
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
  await fill("#wf-metrics", [metric,markerMetric].join("\n"));
  await fill("#wf-output-cap", "180");
  assert.equal(await js("document.querySelector('#wf-measures #wf-suggest').textContent"), "Suggest Metrics");
  let releaseRouting:()=>void = ()=>{};
  const gate=new Promise<void>(resolve=>{releaseRouting=resolve;});
  holdRouting=()=>gate;
  await click("#wf-suggest");
  try {
    await wait(()=>exists('#wf-activity [data-status="running"] .ai-pulse'), "Live planning query");
    assert.match(await text("document.querySelector('#wf-query .ai-model').textContent"), /Local.*lfm3/i);
    assert.equal(await text("document.querySelector('#wf-query dd').textContent"), "Pending");
    assert.ok(await js("document.documentElement.scrollWidth <= innerWidth + 1"), "Planning activity fits the phone viewport");
    assert.ok(await js("getComputedStyle(document.querySelector('.ai-model')).color !== getComputedStyle(document.querySelector('.ai-query-head strong')).color"));
    win.webContents.debugger.attach("1.3");
    try {
      await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]});
      assert.equal(await text("getComputedStyle(document.querySelector('.ai-pulse i')).animationName"), "none");
      await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"no-preference"}]});
      assert.equal(await text("getComputedStyle(document.querySelector('.ai-pulse i')).animationName"), "planning-pulse");
    } finally {win.webContents.debugger.detach();}
  } finally {releaseRouting();holdRouting=undefined;}
  await wait(() => exists("#wf-criteria"), "Editable success criteria");
  assert.match(await text("document.querySelector('#wf-measure-fields').textContent"), /AI expert.*AI suggestions can be wrong/);
  assert.equal(await js("document.querySelectorAll('#wf-activity .ai-query').length"),3);
  assert.deepEqual(await js("Array.from(document.querySelector('#wf-query .ai-query').querySelectorAll('dd'),n=>n.textContent).slice(0,3)"),["21","12","No API charge"]);
  assert.match(await text("document.querySelector('#wf-query .ai-query').textContent"),/Elapsed[\d.]+ s/);
  assert.equal(await exists("#wf-activity .ai-pulse"),false);
  assert.deepEqual(calls.map(c => c.stage), ["route", "expert", "audit"]);
  assert.equal(await js("document.querySelector('#wf-measures .wf-explanation').open"),false);
  await click("#wf-measures .wf-explanation summary");
  assert.match(await text("document.querySelector('#wf-measures .wf-explanation').innerText"),/Evidence needed/);
  assert.equal(records().length, 0);
  const criterion = "Route any part with a missing drawing revision to inspection.";
  const markerGrader=z.string().parse(await js("window.dash.saveGrader("+q({
    intent:"create",name:"QA response marker",category:"Response format",industry:"Manufacturing",
    type:"contains",criteria:"QA response",threshold:1
  })+")"));
  await fill("#wf-criteria", [criterion,markerCriterion].join("\n"));
  await fill("#wf-chosen-metrics", [metric,markerMetric].join("\n"));
  assert.equal(await js("document.querySelector('[data-metric-edit-note]').hidden"),false);
  assert.equal(await exists("[data-model]"), false, "Models follow approval");
  await click("#wf-design");
  await wait(() => exists("#wf-prompt"), "Quick prompt review");
  assert.deepEqual(calls.map(c => c.stage), ["route", "expert", "audit", "audit", "implementer"]);
  assert.equal(await js("document.querySelectorAll('#wf-activity .ai-query').length"),2,"Editing a criterion triggers a new audit without repeating the domain proposal");
  assert.equal(z.object({objective:z.string()}).parse(calls[1].brief).objective, quickGoal);
  const auditInput=z.object({proposals:z.array(z.object({metric:z.string(),criterion:z.string()}))}).parse(calls[3].brief);
  assert.deepEqual(auditInput.proposals,[{metric,criterion},{metric:markerMetric,criterion:markerCriterion}],"The auditor sees the exact edited pair");
  assert.equal(z.object({objective:z.string()}).parse(calls[4].brief).objective,quickGoal);
  assert.ok(!JSON.stringify(calls[4].brief).includes(criterion),"Grader-only criteria stay out of candidate prompt drafting");
  assert.equal(records().length, 0, "Unapproved drafts stay out of the catalogue");
  const approvedText = quickGoal + "\n\n" + guidance + "\nShow the lot identifier.";
  assert.match(await text("document.querySelector('#wf-approval-form').textContent"),/Why this prompt\?/);
  await fill("#wf-prompt", approvedText);
  assert.equal(await js("document.querySelector('[data-prompt-edit-note]').hidden"),false);
  await click("#wf-approve");
  await wait(() => records().length === 1 && exists("[data-model]"), "Saved Quick prompt and model roster");
  assert.ok(await js("document.documentElement.scrollWidth <= innerWidth + 1"), "The starting grid should fit a phone viewport");
  win.setContentSize(1280, 850);
  const first = records()[0];
  assert.equal(first.prompt, approvedText);
  assert.equal(first.domain, "Manufacturing");
  assert.equal(first.outputCap, 180);
  assert.equal(first.version, 1);
  assert.deepEqual(first.metrics, [metric,markerMetric]);
  assert.deepEqual(first.requirements, [criterion,markerCriterion]);
  assert.deepEqual(first.agents?.map(a => a.role).sort(), ["expert", "implementer"]);
  // Duplicate delivery and conflicting re-submission go through the public preload bridge.
  const approve = async (value:{draftId:string;prompt:string;metrics:string[]}) => z.object({id:z.string()}).parse(await js("window.dash.approvePrompt(" + q(value) + ")"));
  const repeat = { draftId: z.string().parse(first.draftId), prompt: approvedText, metrics: first.metrics };
  assert.equal((await approve(repeat)).id, first.id);
  await assert.rejects(() => approve({ ...repeat, prompt: "different" }), /already approved/i);
  assert.equal(records().length, 1);

  const pick = (provider:keyof typeof models) => '[data-model="' + provider + "/" + models[provider] + '"]';
  const rowA='[data-qc-measure="0"]',rowB='[data-qc-measure="1"]';
  const controls=(selector:string,field:string)=>selector+' [data-qc-field="'+field+'"]';
  await wait(() => exists(controls(rowA,"criteria")), "Grader for each approved measure");
  assert.equal(await text("document.querySelector("+q(controls(rowA,"choice"))+").value"),"rubric");
  assert.match(await text("document.querySelector("+q(rowA)+").textContent"),/Unscored in Quick compare/);
  assert.match(await text("document.querySelector("+q(controls(rowA,"criteria"))+").value"),/inspection|lots/i);
  assert.match(await text("document.querySelector("+q(rowB)+").textContent"),/literal text QA response/);
  await fill(controls(rowA,"evidence"),"task-answer");
  await fill(controls(rowA,"threshold"),"0.8");
  await fill(controls(rowB,"choice"),"skip");
  assert.match(await text("document.querySelector('#qc-grade-status').textContent"),/1 of 2 measures ready/);
  await fill(controls(rowB,"choice"),"saved:"+markerGrader);
  assert.match(await text("document.querySelector('#qc-grade-status').textContent"),/2 of 2 measures ready.*2 model evaluations.*6 deterministic checks/);
  await click(pick("lmstudio"));
  await checkRosterColors();
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
  assert.equal(business.length,2);
  const judged=business.find(g=>g.type==="opik");
  assert.ok(judged);
  assert.deepEqual(quick.measureGraders?.map(r=>[r.metric,r.criterion,r.graderId,r.graderVersion]),
    [[metric,criterion,judged.id,judged.version],[markerMetric,markerCriterion,markerGrader,1]]);
  assert.equal(judged.threshold,.8);
  assert.equal(judged.type,"opik");
  assert.match(judged.opikEngine ?? "",/^opik-js@/);
  const baselines=quick.graders.filter(g=>g.type==="catalog");
  assert.deepEqual(baselines.map(g=>g.ruleKey).sort(),["completion","response-present"]);
  assert.ok(baselines.every(g=>g.library?.automatic));
  assert.equal(calls.filter(c=>c.stage==="geval-score").length,2);
  const businessScores=quickRecords.assessments.filter(a=>a.graderId===judged.id);
  assert.ok(businessScores.every(a=>a.evaluator===judged.opikEngine));
  assert.equal(businessScores.length,2);
  assert.deepEqual(businessScores.map(a=>a.value).sort(),[0,1]);
  for(const baseline of baselines)assert.equal(quickRecords.assessments.filter(a=>a.graderId===baseline.id).length,2);
  assert.ok(quickRecords.results.every(r=>r.guardrail.status==="unverified" && r.guardrail.outputReserve===180));
  assert.deepEqual(calls.filter(c => ["analyzer","reporter"].includes(c.stage)).map(c=>c.stage), ["analyzer","reporter"]);
  assert.equal(quickRecords.report.assistance.analyzer.status,"verified");
  assert.equal(quickRecords.report.assistance.reporter.status,"verified");
  const markerScores=quickRecords.assessments.filter(a=>a.graderId===markerGrader);
  assert.deepEqual(markerScores.map(a=>a.value).sort(),[0,1]);
  assert.equal(quickRecords.report.verdict,"mixed");
  assert.equal(quickRecords.report.winnerId,null);
  assert.ok(quickRecords.report.metrics.some(m=>m.method==="opik-judge"));
  await wait(() => exists('.er-report[data-verdict="mixed"]'), "Different answers lead on different measures");
  const comparison=".er-measure-comparison";
  assert.equal(await js("document.querySelectorAll("+q(comparison+" .er-answer a")+").length"),2);
  assert.deepEqual(await js("Array.from(document.querySelectorAll("+q(comparison+" tbody tr")+")).slice(1).map(row=>Array.from(row.querySelectorAll('td')).slice(1).map(cell=>cell.innerText))"),
    [["0 / 1\nBelow threshold","1 / 1\nPassed"],["1 / 1\nPassed","0 / 1\nBelow threshold"]]);
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
  await checkRosterColors();
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
  assert.match(await text("document.querySelector('#wf-measure-fields').textContent"), /AI expert.*Review and edit them before drafting/);
  await click("#wf-design");
  await wait(() => exists("#wf-prompt"), "Dataset prompt review");
  const proposalCalls = calls.slice(start);
  assert.deepEqual(proposalCalls.map(c => c.stage), ["expert", "audit", "implementer"]);
  for (const call of proposalCalls) {
    if (call.stage==="audit") {
      assert.doesNotMatch(JSON.stringify(call.brief),/"(case_id|rows|gold|sme_rationale)":/);
      continue;
    }
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
  const stages=calls.slice(beforeRefinement);
  assert.ok(stages.some(call=>call.stage==="expert"));
  for (const call of stages) {
    if (call.stage!=="expert") {
      assert.doesNotMatch(JSON.stringify(call.brief),/"scored"|"gold"|"case_id"|QA response/);
      continue;
    }
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
  let mlxGrades=0,sampleGate:Promise<void>|undefined;
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
        if(sampleGate)await sampleGate;
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
    assert.ok(await js("document.querySelector('[data-grade-run]').getBoundingClientRect().height>=44"),"Touch-size catalog action");
    const shelfNames=await js("Array.from(document.querySelectorAll('.gc-shelf-head h4'),h=>h.textContent)");
    assert.deepEqual(shelfNames,["Financial Services","Manufacturing"]);
    assert.ok(await js("Array.from(document.querySelectorAll('.gc-shelf-head use')).every(u=>document.getElementById(u.getAttribute('href').slice(1)) && u.getBoundingClientRect().width>0)"),"Industry icons render in the catalogue");
    assert.ok(await js("document.querySelector('.gc-section').dataset.catalogScope==='industry' && !!document.querySelector('.gc-section[data-catalog-scope=customer]')"),"Industry catalogue and personal versions are separate");
    assert.ok(await js("!!(document.querySelector('#grader-authoring').compareDocumentPosition(document.querySelector('.gc-section')) & Node.DOCUMENT_POSITION_FOLLOWING)"),"Create a grader stays above the catalogue");
    const firstCard=".gc-industry .grader-row";
    assert.deepEqual(await js("Array.from(document.querySelector("+q(firstCard)+").querySelectorAll('.gc-use > button'),b=>b.textContent)"),["Create Version","Test","Use in Run"]);
    assert.ok(await js("Array.from(document.querySelector("+q(firstCard)+").querySelectorAll('.gc-use > button')).every(b=>b.getBoundingClientRect().height>=44)"),"Compact catalogue actions are touch sized");
    const detailsButton=firstCard+" [data-grader-details]";
    const expanded=()=>js("document.querySelector("+q(detailsButton)+").getAttribute('aria-expanded')==='true'");
    const detailsPoint=async()=>z.object({x:z.number(),y:z.number()}).parse(await js("(() => {const b=document.querySelector("+q(detailsButton)+");b.scrollIntoView({block:'center'}); const r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()"));
    const keyboard=(key:string)=>js("document.querySelector("+q(detailsButton)+").dispatchEvent(new KeyboardEvent('keydown',{key:"+q(key)+",bubbles:true}));true");
    wc.debugger.attach("1.3");
    try{
      await wc.debugger.sendCommand("Input.dispatchMouseEvent",{type:"mouseMoved",...await detailsPoint()});
      await wait(expanded,"Hover reveals the saved criterion");
      await js("document.querySelector("+q(detailsButton)+").focus();true");
      await keyboard("Escape");await wait(async()=>!(await expanded()),"Keyboard dismisses grader details");
      await wc.debugger.sendCommand("Input.dispatchMouseEvent",{type:"mouseMoved",x:0,y:0});
      await js("document.activeElement.blur();document.querySelector("+q(detailsButton)+").focus();true");
      await wait(expanded,"Keyboard focus reveals the same criterion");
      await keyboard("Escape");await js("document.activeElement.blur();true");
      await wc.debugger.sendCommand("Emulation.setTouchEmulationEnabled",{enabled:true,maxTouchPoints:1});
      try{
        await wc.debugger.sendCommand("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[await detailsPoint()]});
        await wc.debugger.sendCommand("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
        await wait(expanded,"Touch opens the grader details");
      }finally{await wc.debugger.sendCommand("Emulation.setTouchEmulationEnabled",{enabled:false});}
      await keyboard("Escape");
    }finally{wc.debugger.detach();}

    win.setContentSize(1280,850);
    const runCount=()=>Number(db.prepare("SELECT count(*) n FROM runs").get()?.n);
    const manualCount=()=>Number(db.prepare("SELECT count(*) n FROM assessments WHERE run IS NULL").get()?.n);
    const shippedId=(key:string)=>z.string().parse(db.prepare("SELECT id FROM graders WHERE json_extract(spec,'$.ruleKey')=? AND json_extract(spec,'$.library.scope')!='customer'").get(key)?.id);
    // Industry catalogue tests use only the existing saved case and a pasted answer.
    const beforeTests={models:calls.length,jobs:runCount(),scores:manualCount()};
    let scored=0;
    for(const example of [
      {pack:"earnings",rule:"earnings-fact",pass:"rev-scale",fail:"eps-gaap"},
      {pack:"manufacturing",rule:"inspection-drawing",pass:"bushing-within",fail:"shaft-superseded-revision"},
    ]) {
      const grader=shippedId(example.rule);
      const card='[data-grade-version="'+grader+'"] ';
      const form=card+"[data-industry-test-form] ";
      await click(card+"[data-industry-test]");
      const snapshotId=z.string().parse(db.prepare("SELECT id FROM datasets WHERE pack=? ORDER BY rowid LIMIT 1").get(example.pack)?.id);
      const snapshot=form+"[name=snapshot]",cases=form+"[name=caseId]",answer=form+"[name=output]";
      await wait(()=>exists(snapshot+' option[value="'+snapshotId+'"]'),"Compatible case-test snapshot");
      await fill(snapshot,snapshotId);
      await wait(()=>exists(cases+' option[value="'+example.pass+'"]'),"Available domain cases");
      const replay=z.record(z.string(),z.unknown()).parse(JSON.parse(readFileSync(path.join(__dirname,"../packs",example.pack,"replay.json"),"utf8")));
      for(const [caseId,expected] of [[example.pass,1],[example.fail,0]] as const){
        await fill(cases,caseId);
        await fill(answer,"");
        assert.equal(await js("document.querySelector("+q(form+"button[type=submit]")+").disabled"),true);
        assert.ok(await js("document.querySelector("+q(form+"[data-case-source]")+").textContent.includes('Required response format')"));
        await fill(answer,JSON.stringify(replay[caseId]));
        await click(form+"[type=submit]");
        const verdict=expected?"Passed":"Failed";
        await wait(()=>js("document.querySelector("+q(form+"[data-case-result]")+").innerText.includes("+q(verdict)+")"),"Catalogue verdict for "+caseId);
        assert.ok(await js("document.querySelector("+q(form+"[data-case-result]")+").innerText.includes("+q(caseId)+")"));
        await js("document.querySelector("+q(form.trim())+").requestSubmit();true");
        const assessment=z.object({graderId:z.string(),value:z.number(),reason:z.string().min(1),datasetCase:z.object({datasetId:z.string(),caseId:z.string()})}).parse(JSON.parse(z.string().parse(db.prepare("SELECT record FROM assessments WHERE run IS NULL ORDER BY rowid DESC LIMIT 1").get()?.record)));
        assert.equal(assessment.graderId,grader);assert.equal(assessment.value,expected);
        assert.deepEqual([assessment.datasetCase.datasetId,assessment.datasetCase.caseId],[snapshotId,caseId]);
        assert.equal(manualCount(),beforeTests.scores+(++scored));
      }
      await click(form+"[data-close-test]");
    }
    assert.equal(calls.length,beforeTests.models,"Case tests do not call a candidate or a judge model");
    assert.equal(runCount(),beforeTests.jobs,"Testing a single answer never creates a run");

    // Workspace creation reviews several checks without attaching them to a run.
    const designer="#grader-authoring [data-gd-workspace]";
    assert.equal(await js("document.querySelector('#grader-authoring').open"),false);
    await click("#grader-authoring>summary");
    const source=designer+" [data-gd-source]";
    const goal="Review the active drawing before accepting a synthetic inspection lot.";
    const proposedCount=()=>Number(db.prepare("SELECT COUNT(*) AS n FROM graders").get()?.n);
    const quickSelectionBefore=await js("JSON.stringify(modelSelections.quick.lanes)");
    await fill(source,"prompt:"+first.id);
    assert.equal(await exists("#wf-design-form"),false,"An approved prompt skips drafting");
    assert.ok(await js("document.querySelector("+q(designer+" .gd-brief pre")+").textContent==="+q(first.prompt)));
    const reusedStart=calls.length;
    await fill(designer+" [data-gd-brief=target]","agent");
    await click(designer+" [data-gd-action=design]");
    await wait(()=>exists(designer+" .gd-explanation"),"Grader design from approved version");
    const savedBrief=z.object({target:z.literal("agent"),approvedPrompt:z.string(),metrics:z.array(z.string())})
      .parse(calls.slice(reusedStart).find(c=>c.stage==="grader-plan")?.brief);
    assert.deepEqual(savedBrief,{target:"agent",approvedPrompt:first.prompt,metrics:first.metrics});
    assert.equal(calls.slice(reusedStart).some(c=>["audit","expert","implementer","route"].includes(c.stage)),false);
    await fill(source,"custom");
    await fill(designer+" #wf-objective",goal);
    await click("#wf-suggest");
    await wait(()=>exists("#wf-chosen-metrics"),"First draft has scoped suggestions");
    const otherSnapshot=z.string().parse(db.prepare("SELECT id FROM datasets WHERE pack='earnings' ORDER BY rowid LIMIT 1").get()?.id);
    await fill(source,"dataset:"+otherSnapshot);
    assert.equal(await exists("#wf-chosen-metrics"),false,"A Financial Services snapshot has no Manufacturing metric audit");
    assert.ok(!(await text("document.querySelector('#wf-metrics').value")).includes("Share of cases with cited evidence"));
    await fill(source,"custom");
    assert.equal(await exists("#wf-chosen-metrics"),true,"The original source keeps its own draft");
    await fill("#wf-objective",goal+" Reassess all lots.");
    await fill("#wf-objective",goal);
    assert.equal(await exists("#wf-chosen-metrics"),false,"Editing the objective invalidates its audit");
    const inspectionId=z.string().parse(db.prepare("SELECT id FROM datasets WHERE pack='manufacturing' ORDER BY rowid LIMIT 1").get()?.id);
    const snapshot="dataset:"+inspectionId;
    await fill(source,snapshot);
    assert.equal(await text("document.querySelector('#wf-objective').value"),goal);
    assert.equal(await text("document.querySelector('#wf-metrics').value"),"");
    const attachmentBefore=await js("localStorage.getItem('dash.attachedGraders.v1.'+"+q(snapshot)+")");
    const initial=proposedCount(), planStart=calls.length;
    await click("#wf-suggest");
    await wait(()=>exists("#wf-chosen-metrics"),"Shared suggestions inside Create a grader");
    assert.ok(await js("document.querySelector('#wf-measures').innerText.includes('Why these metrics?')"));
    const readyCalls=calls.filter(c=>c.stage==="expert").length;
    await click("#wf-design");
    await wait(()=>exists("#wf-prompt"),"Shared editable prompt review inside Create a grader");
    assert.equal(calls.filter(c=>c.stage==="expert").length,readyCalls,"Draft reused the unchanged audited suggestion");
    const approvedTask=goal+"\n\nRequire a quoted active drawing revision and the inspection lot ID.";
    await fill("#wf-prompt",approvedTask);
    const reviewedMetrics=["Disposition rationale","Inspection record citation"];
    await fill("#wf-review-metrics",reviewedMetrics.join("\n"));
    assert.equal(calls.slice(planStart).some(c=>c.stage==="grader-plan"),false,"No grader proposal before prompt approval");
    await click("#wf-approve");
    await wait(()=>exists(designer+" [data-gd-check='1']"),"Two editable proposals for the approved prompt and metrics");
    assert.ok(await js("document.querySelector('.gd-model + details.gd-explanation > summary')?.textContent==='Reasoning summary'"),"Rationale is directly beneath the model");
    assert.equal(await js("document.querySelector('.gd-explanation').open"),false);
    await click(".gd-explanation summary");
    assert.ok(await js("document.querySelector('.gd-explanation li p').innerText.trim().length>0"));
    assert.ok(await js("document.querySelector('.gd-proposals [data-gd-field=criteria]').value.trim().length>0"),"The actual editable rule is visible in the review");
    assert.equal(await js("document.querySelector('.gd-diagnostics').open"),false);
    await click(".gd-diagnostics summary");
    assert.ok(await js("document.querySelector('.gd-diagnostics').innerText.includes('runtime reported a normal stop')"),"Completion diagnostics are explained separately");
    const planCall=calls.slice(planStart).find(c=>c.stage==="grader-plan");
    const planBrief=z.object({approvedPrompt:z.string(),objective:z.string(),metrics:z.array(z.string()),industry:z.string(),referenceCoverage:z.string()}).parse(planCall?.brief);
    assert.deepEqual(planBrief,{approvedPrompt:approvedTask,objective:goal,metrics:reviewedMetrics,industry:"Manufacturing",referenceCoverage:"all"});
    assert.deepEqual(await js("JSON.stringify(modelSelections.quick.lanes)"),quickSelectionBefore);
    assert.equal(proposedCount(),initial,"Approving the prompt and proposing checks does not save a grader");
    const proposal=designer+" [data-gd-check='0']";
    assert.equal(await text("document.querySelector("+q(proposal+" [data-gd-field=name]")+").value"),"Inspection disposition reasoning");
    assert.equal(await text("document.querySelector("+q(proposal+" [data-gd-field=threshold]")+").value"),"0.9");
    assert.ok(await text("document.querySelector("+q(proposal+" [data-gd-field=judgeId]")+").value"));
    const name="Reviewed workspace inspection checks";
    await fill(proposal+" [data-gd-field=name]",name);
    await fill(proposal+" [data-gd-field=threshold]","0.75");
    await click(designer+" [data-gd-check='1'] [data-gd-field=included]");
    assert.equal(proposedCount(),initial);
    await click(designer+" [data-gd-action=confirm]");
    await wait(()=>js("document.querySelector('#grader-receipt')?.innerText.includes("+q(name+" v1")+")"),"Saved version and next actions");
    assert.equal(proposedCount(),initial+1);
    assert.equal(await js("localStorage.getItem('dash.attachedGraders.v1.'+"+q(snapshot)+")"),attachmentBefore);
    const saved=await js("window.dash.list().then(s=>s.graders.find(g=>g.name==="+q(name)+"))");
    assert.equal(z.object({threshold:z.literal(.75),type:z.literal("opik"),version:z.literal(1)}).safeParse(saved).success,true);
    const savedId=z.object({id:z.string()}).parse(saved).id;
    if(process.env.DASH_GRADER_PREVIEW_DIR){
      await wait(()=>js("document.querySelector('#msg').hidden"),"Clear unrelated transient notices from preview");
      const frame=await win.webContents.capturePage();
      writeFileSync(path.join(process.env.DASH_GRADER_PREVIEW_DIR,"saved-grader.png"),frame.toPNG());
    }
    await click("#grader-receipt [data-grade-test]");
    assert.equal(await text("document.querySelector('#grade-sample [name=grader]').value"),savedId);
    assert.equal(await js("document.activeElement===document.querySelector('#grade-sample [name=output]')"),true);
    // The earlier synthetic workflow may still have an open prompt variant.
    await js("window.confirm=message=>message.startsWith('Switch the dataset setup to ');true");
    await click("#grader-receipt [data-grade-run]");
    await wait(()=>js("document.querySelector('#ds')?.value==="+q(snapshot.slice(8))),"Use source dataset without a second selection");
    assert.ok(await js("document.querySelector('[name=custom-grader][value="+q(savedId)+"]')?.checked"));
    await click('[name=custom-grader][value="'+savedId+'"]');
    await route("graders");await click("#grader-authoring>summary");
    await click('#grader-authoring [name="grader-authoring-mode"][value="manual"]');
    assert.equal(await js("document.querySelector('#grade-create').checkVisibility()"),true);
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
    let releaseSample=()=>{};
    sampleGate=new Promise<void>(resolve=>{releaseSample=resolve;});
    try{
      await provideSample(localId,"Hold lot B.","Current drawing calls for a hold.");
      await wait(()=>localQuestions.length===1,"Judge received the submitted sample");
      await route("datasets");await wait(()=>exists("#catalog-search"),"Other workspace navigation while scoring");
      await route("graders");await wait(()=>exists('#grade-sample[aria-busy=true]'),"Pending grade restored on return");
      assert.equal(await text("document.querySelector('#grade-sample [name=output]').value"),"Hold lot B.");
      assert.equal(await js("document.querySelectorAll('[data-grade-test]:enabled').length"),0);
      assert.equal(await js("[...document.querySelectorAll('#grade-sample textarea,#grade-sample select,#grade-sample button')].every(e=>e.matches(':disabled'))"),true);
      await js("document.querySelector('#grade-sample').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));true");
      await click("#grader-authoring>summary");await click('#grader-authoring [name=grader-authoring-mode][value=manual]');
      await fill("#grade-create [name=name]","Another grader draft");
    }finally{releaseSample();sampleGate=undefined;}
    await wait(()=>js("document.querySelector('#grade-sample[aria-busy=false]') && document.querySelector('#grade-sample-scores').textContent.includes('P(yes) 0.92')"),"Pending score finishes without replacing the workspace");
    assert.equal(await text("document.querySelector('#grade-create [name=name]').value"),"Another grader draft");
    assert.equal(await js("document.querySelectorAll('[data-grade-test]:disabled').length"),0);
    assert.equal(manualCount(),manualStart+2);
    assert.match(await text("document.querySelector('#screen table').innerText"),/Alternate model used/);
    assert.equal(localQuestions.length,1);
    assert.match(localQuestions[0],/Current drawing calls for a hold/);
    await provideSample(localId,"UNCERTAIN: hold for reinspection.","Current drawing calls for a hold.");
    await wait(()=>js("document.querySelector('#screen table')?.innerText.includes('Abstained · unscored')"),"Uncertain decision excluded from numeric scores");
    assert.equal(manualCount(),manualStart+3);
    const failureFixture=new DatabaseSync(path.join(profile,"dash.sqlite"));
    try{
      failureFixture.exec("CREATE TRIGGER fail_sample_save BEFORE INSERT ON assessments WHEN NEW.run IS NULL BEGIN SELECT RAISE(ABORT,'Synthetic sample store unavailable'); END");
      await provideSample(localId,"Keep this response for retry.","Current drawing calls for a hold.");
      await wait(()=>exists("#grade-sample [data-action-error]"),"Sample persistence failure stays at the output test");
      assert.equal(await text("document.querySelector('#grade-sample [name=output]').value"),"Keep this response for retry.");
      assert.equal(await js("document.querySelector('#grade-sample button[type=submit]').disabled"),false);
      const attempts=localQuestions.length;
      sampleGate=new Promise<void>(resolve=>{releaseSample=resolve;});
      try{
        await provideSample(localId,"Recover this after navigation.","Current drawing calls for a hold.");
        await wait(()=>localQuestions.length===attempts+1,"Judge received the second sample");
        await route("datasets");await wait(()=>exists("#catalog-search"),"Leave before sample persistence fails");
      }finally{releaseSample();sampleGate=undefined;}
      await wait(()=>js("pendingSample===null"),"Failure settles while another page is open");
      assert.equal(await js("location.hash"),"#datasets");
      await route("graders");await wait(()=>exists("#grade-sample [data-action-error]"),"Recover failed sample on return");
      for(const [key,value] of [["grader",localId],["output","Recover this after navigation."],["reference","Current drawing calls for a hold."]]){
        assert.equal(await text("document.querySelector("+q("#grade-sample [name="+key+"]")+").value"),value);
      }
      assert.equal(await js("document.querySelector('#grade-sample button[type=submit]').disabled"),false);
      await click("[data-sample-clear]");
      assert.ok(await js("Array.from(document.querySelectorAll('#grade-sample textarea')).every(el=>el.value==='' && el.defaultValue==='' && el.textContent==='')"),"Discard clears the live and original evidence");
      await js("document.querySelector('#grade-sample').reset();true");
      assert.ok(await js("Array.from(document.querySelectorAll('#grade-sample textarea,#grade-sample select')).every(el=>el.value==='')"),"Reset cannot restore discarded sample data or its selected grader");
      assert.equal(localQuestions.length,attempts+1,"Returning or discarding does not retry the model");
      assert.equal(manualCount(),manualStart+3);
    }finally{try{failureFixture.exec("DROP TRIGGER IF EXISTS fail_sample_save");}finally{failureFixture.close();}}
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
    await wait(()=>exists(controls(rowB,"choice")),"Reopened approved prompt");
    assert.equal(await text("document.querySelector("+q(controls(rowB,"choice"))+").value"),"saved:"+markerGrader,
      "Reopening DASH restores the exact saved grader version to its approved measure");
    await reveal('[name=qc-saved-grader][value="'+hostedId+'"]');
    await click('[name=qc-saved-grader][value="'+hostedId+'"]');
    for(const provider of ["ollama","lmstudio"] as const){
      const item=pick(provider);
      if(await js("document.querySelector("+q(item)+").getAttribute('aria-pressed')")!=="true")await click(item);
    }
    const beforeHostedRun=runCount();
    await click("#setup .go-button");
    assert.match(await text("window.consentPrompts.at(-1)"),/Quick comparison/);
    assert.equal(runCount(),beforeHostedRun);
    await route("new");
    await fill("#pack","manufacturing");
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
    assert.equal(await exists('[data-grade-default="'+hostedId+'"]'),false);
    assert.equal(await exists('[data-grade-default="'+localId+'"]'),false);
    const generalDecision="QA supports its conclusion";
    await reveal('#grader-authoring [name="grader-authoring-mode"][value="manual"]');
    await click('#grader-authoring [name="grader-authoring-mode"][value="manual"]');
    await fill("#grade-type","decision");
    await fill("#grade-create [name=name]",generalDecision);
    await fill("#grade-create [name=category]","Evidence");
    await fill("#grade-create [name=criteria]","Does the answer cite a supplied value to support its conclusion?");
    await fill("#grade-create [name=decision-endpoint]",decisionOrigin);
    await fill("#grade-create [name=decision-model]",localAlias);
    await click("#grade-create button.yellow");
    await wait(()=>loadVersion(generalDecision,1),"Saved a cross-industry local decision");
    const decisionDefault=z.string().parse(loadVersion(generalDecision,1));
    const defaultButton='[data-grade-default="'+decisionDefault+'"]';
    await reveal(defaultButton);await click(defaultButton);
    await wait(()=>exists(defaultButton+'[aria-pressed=true]'),"Enabled the decision family default");
    await route("prompts");await click('[data-wf-use="'+first.id+'"]');
    await wait(()=>js("document.querySelector('#qc-grading .gc-auto')?.innerText.includes("+q(generalDecision)+")"),"Decision default in Quick compare");
    await route("new");
    await wait(()=>js("document.querySelector('.gc-auto')?.innerText.includes("+q(generalDecision)+")"),"Decision default in Dataset run");
    await route("graders");await reveal(defaultButton);await click(defaultButton);
    await wait(()=>exists(defaultButton+'[aria-pressed=false]'),"Disabled decision grading for future runs");
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
    await route("graders");
    const runsBeforeSetup=runCount();
    const revisionAction='[data-grade-version="'+v2+'"] [data-use-version="'+v2+'"]';
    await click(revisionAction+" [data-grade-run]");
    await wait(()=>js("location.hash==='#new' || !!document.querySelector("+q(revisionAction+" [data-grade-snapshot]")+")"),"Select or open eligible dataset");
    if(await exists(revisionAction+" [data-grade-snapshot]")){
      assert.equal(await exists(revisionAction+' option[value="'+scenario+'"]'),false);
      await click(revisionAction+" [data-grade-cancel]");
      assert.equal(await js("location.hash"),"#graders");
      await click(revisionAction+" [data-grade-run]");
      await fill(revisionAction+" [data-grade-snapshot]",inspectionId);
      await click(revisionAction+" [data-grade-continue]");
    }
    await wait(()=>js("document.querySelector('#ds')?.value==="+q(inspectionId)),"Dataset form for the requested grader");
    assert.ok(await js("document.querySelector('.grader-picker>summary').innerText.includes("+q(alias+" v2")+")"));
    assert.equal(runCount(),runsBeforeSetup,"Opening setup requires explicit GO");
    const uses:string[]=[];
    for(const count of [5,6]){
      await wait(()=>js("document.querySelector("+q(optionFor(v2))+")?.checked"),"Selected revision restored");
      await click("#dataset-run-form button[type=submit]");
      const run=await completedRun(count);uses.push(run.id);
      assert.ok(run.graders.some(g=>g.id===v2));assert.ok(run.graders.some(g=>g.id===inspectionRule));
      assert.ok(run.graders.some(g=>g.type==="catalog" && g.ruleKey==="json-valid"));
      assert.ok(!run.graders.some(g=>g.id===v1 || g.id===relevance));
      await wait(()=>js("!![...document.querySelectorAll('.er-metric h3')].find(h=>h.textContent.includes("+q(alias)+"))"),"Completed evaluation shows the selected grader");
      await js("document.querySelectorAll('.er-metric h3').forEach(h=>{if(h.textContent.includes("+q(alias)+"))h.closest('article').querySelector('summary').click()});true");
      await wait(()=>js("!![...document.querySelectorAll('.er-metric')].find(m=>m.querySelector('h3').textContent.includes("+q(alias)+") && m.querySelector('.er-evidence table a'))"),"Grader rationale links to a scored case");
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
    await route("graders");
    const referenceOnly='[data-grade-version="'+localId+'"] [data-use-version]';
    await reveal(referenceOnly+" [data-grade-test]");await click(referenceOnly+" [data-grade-test]");
    assert.equal(await js("document.querySelector('#grade-sample [data-sample-evidence]').open"),true);
    assert.match(await text("document.querySelector('#grade-sample [data-sample-evidence] summary').textContent"),/needs a reference answer/);
    await reveal(referenceOnly+" [data-grade-run]");await click(referenceOnly+" [data-grade-run]");
    await fill(referenceOnly+" [data-grade-snapshot]",inputOnly);
    await click(referenceOnly+" [data-grade-continue]");
    await wait(()=>js("document.querySelector("+q(referenceOnly+" [role=alert]")+")?.textContent.includes('held-out reference')"),"Unscorable snapshot explains missing reference");
    assert.equal(await js("location.hash"),"#graders");
    assert.equal(await js("JSON.parse(localStorage.getItem("+q("dash.attachedGraders.v1.dataset:"+inputOnly)+") || '{}').ids?.includes("+q(localId)+") || false"),false);
    await click(referenceOnly+" [data-grade-cancel]");
    await click('[data-grade-default="'+relevance+'"]');
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

    // Design from a snapshot to verify actual automatic assignments in the operator's review.
    await route("new");await fill("#ds",inputOnly);
    const coveragePanel='[data-gd-scope="dataset:'+inputOnly+'"] ';
    await reveal(coveragePanel+"[data-gd-brief=objective]");
    await fill(coveragePanel+"[data-gd-brief=objective]","Review the synthetic lot response.");
    const coverageReason="The response-presence check detects an empty answer.";
    const initialCount=proposedCount();
    for(const measures of [["Response present"],["Response present","Disposition reasoning","Reduce operating costs"]]){
      await fill(coveragePanel+"[data-gd-brief=metrics]",measures.join("\n"));
      await click(coveragePanel+"[data-gd-action=design]");
      await wait(()=>exists(coveragePanel+".gd-proposals"),"Review actual automatic coverage");
      const title=await text("document.querySelector("+q(coveragePanel+".gd-proposals h3")+").textContent");
      assert.equal(title,measures.length===1?"Existing graders cover all measures":"Review the proposed grader");
      await click(coveragePanel+".gd-explanation summary");
      const reasoning=await text("document.querySelector("+q(coveragePanel+".gd-explanation")+").innerText");
      assert.match(reasoning,/Response present v1/);
      assert.ok(reasoning.includes(coverageReason));
      if(measures.length===1){
        assert.equal(await exists(coveragePanel+"[data-gd-action=confirm]"),false);
        assert.equal(await text("document.querySelector("+q(coveragePanel+"[data-gd-action=discard]")+").textContent"),"Done");
      }else{
        assert.ok(reasoning.includes("Reduce operating costs"));
        assert.ok(reasoning.includes("Disposition reasoning"));
      }
      const draft=z.object({covered:z.array(z.object({measure:z.string(),reason:z.string(),grader:z.object({id:z.string(),version:z.number(),name:z.string()})}))})
        .parse(JSON.parse(z.string().parse(db.prepare("SELECT draft FROM grader_design_drafts ORDER BY rowid DESC LIMIT 1").get()?.draft)));
      assert.deepEqual(draft.covered,[{measure:"Response present",reason:coverageReason,grader:{id:shippedId("response-present"),version:1,name:"Response present"}}]);
      await click(coveragePanel+"[data-gd-action=discard]");
    }
    assert.equal(proposedCount(),initialCount);

    // The in-run designer carries immutable measure identities even when the operator renames a grader.
    await route("prompts");await click('[data-wf-use="'+first.id+'"]');
    const inline='[data-gd-scope="prompt:'+first.id+'"] ';
    await reveal(inline+"[data-gd-action=design]");
    inlineDesignerFixture=true;
    await click(inline+"[data-gd-action=design]");
    await wait(()=>exists(inline+"[data-gd-check='1']"),"Design two checks for the saved measures");
    inlineDesignerFixture=false;
    await fill(inline+"[data-gd-check='0'] [data-gd-field=name]","Renamed inspection criterion");
    await fill(inline+"[data-gd-check='0'] [data-gd-field=category]","Inspection");
    await click(inline+"[data-gd-action=confirm]");
    await wait(()=>exists(inline+".gd-saved"),"Reviewed grader versions selected for the exact prompt");
    const reviewed=z.string().parse(loadVersion("Renamed inspection criterion",1));
    assert.equal(await text("document.querySelector("+q(controls(rowA,"choice"))+").value"),"saved:"+reviewed);
    assert.deepEqual(await js("JSON.parse(localStorage.getItem("+q("dash.attachedGraders.v1.prompt:"+first.id)+")).mapped[0]"),{index:0,id:reviewed});
    assert.equal(await js("document.querySelector("+q('[name=qc-saved-grader][value="'+reviewed+'"]')+")?.checked"),false);

  } finally {
    decisionOrigin="";
    server.closeAllConnections();server.close();
  }
  await verifyStructuredQuick();
  db.close();
}

app.whenReady().then(smoke).then(() => {
  if(process.argv.includes("--structured-quick"))console.log("Structured Quick smoke passed: opt-in, input and schema approval, token preflight, matching dispatch and distinct per-model format results.");
  else console.log("Workflow smoke passed: mobile planning, mapped Quick graders, mixed verdict and case rationale, blocked preflight, direct dataset runs, approved variants, revisions, decision-grader consent, catalog forks, pinned prior revisions across two runs, native metric defaults, version-specific run links and structured Quick conformance.");
  rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  app.exit(0);
}).catch(err => {
  console.error(err, "\nIsolated test profile:", profile);
  app.exit(1);
});
