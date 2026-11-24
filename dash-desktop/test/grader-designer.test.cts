import { test } from "node:test";
import assert from "node:assert/strict";
import { Bench } from "../lib/bench.cjs";
import { designGraderPlan, confirmGraderPlan } from "../lib/grader-designer.cjs";

import {opikJudgeRequest} from "./opik-judge-fixture.cjs";
import { inventory,reply,present } from "./runtime-fixtures.cjs";
import type { LocalCandidate,RuntimeAdapters } from "../lib/runtime-types.cjs";
import {z} from "zod";

const constraints=z.object({properties:z.record(z.string(),z.object({anyOf:z.array(z.object({
  properties:z.object({choice:z.object({enum:z.array(z.string())})})
}))}))});
const anchors={full:"Cites the requested value and its inspection evidence.",partial:"Cites the value without its evidence.",zero:"Omits or contradicts the value.",evidence:"response"};
function allowedChoices(schema:unknown,goal:string) {
  return constraints.parse(schema).properties[goal].anyOf.flatMap(branch=>branch.properties.choice.enum);
}

test("the designer proposes a minimal plan, then confirmation saves reusable versions atomically", async t => {
  const judge:LocalCandidate = {kind:"model",id:"ollama/lfm3-test",provider:"ollama",model:"lfm3-test",loaded:true,revision:"test-r1"};
  const servers = [inventory([judge])];
  const proposed = [
    {name:"Hold wording",choice:"NEW:contains",criteria:"The response must contain the exact word HOLD",reason:"The contract specifies this literal.",threshold:1},
    {name:"Evidence quality",choice:"NEW:judge",anchors,criteria:"Full credit requires the measured diameter and the tolerance. Partial credit for one; zero if both are absent.",reason:"Equivalent explanations are acceptable.",threshold:0.8},
  ];
  const judged:string[] = [];
  const adapters:RuntimeAdapters = {
    discover:async()=>servers,
    invoke:async(candidate,messages,options)=>{
      if (options.planning) {
        const raw:unknown=JSON.parse(present(messages.at(-1)).content);
        const brief=z.object({industry:z.string(),objective:z.string(),metrics:z.array(z.string())}).parse(raw);
        assert.equal(brief.industry,"Manufacturing");
        assert.match(brief.objective,/HOLD/);
        assert.deepEqual(brief.metrics,["Exact disposition","Evidence quality"]);
        assert.deepEqual(allowedChoices(options.structured,"M1").filter(c=>c.startsWith("NEW:")),["NEW:contains","NEW:judge"]);
        return reply(JSON.stringify({M1:proposed[0],M2:proposed[1]}));
      }
      judged.push(candidate.id);
      return reply(options.structured ? '{"score":8,"reason":"The response cites the diameter and tolerance."}' : "Inspect the measurement and its tolerance.");
    }
  };
  const b=new Bench(":memory:",adapters);
  t.after(()=>b.db.close());
  b.servers=servers;
  const proposal=await designGraderPlan(b,{objective:'Every response must include the literal "HOLD" and cite the measurement.',metrics:"Exact disposition\nEvidence quality",domainId:"Manufacturing"});
  const customerCount=()=>b.graders.list().filter(g=>g.library?.scope==="customer").length;
  assert.equal(present(proposal.designer).model,judge.model);
  assert.deepEqual(proposal.checks.map(g=>g.type),["contains","opik"]);
  assert.equal(customerCount(),0);
  const choices=proposal.checks.map((g,index)=>({index,action:"create",
    definition:{name:g.name,category:g.category,criteria:g.criteria,threshold:g.threshold,judgeId:judge.id}}));
  assert.throws(()=>confirmGraderPlan(b,{draftId:proposal.draftId,choices:choices.map(c=>({...c,definition:{...c.definition,judgeId:null}}))}),/judge/i);
  assert.equal(customerCount(),0,"Partial confirmations must roll back");
  const approval={draftId:proposal.draftId,choices};
  const ids=confirmGraderPlan(b,approval);
  assert.deepEqual(b.graders.get(ids[0]).producer,{agent:proposal.agent,model:proposal.designer});
  assert.deepEqual(confirmGraderPlan(b,approval),ids,"Retrying confirmation reuses the same versions");
  const evidence={reference:null,input:"Inspect the part",output:"HOLD. Measured 10.04 mm; max 10.03 mm."};
  const scores=await Promise.all(b.graders.select(ids).map(g=>b.graders.assess(g,evidence,adapters,AbortSignal.timeout(10000))));
  assert.deepEqual(scores.map(s=>[s.value,s.pass]),[[1,true],[0.8,true]]);
  assert.ok(scores.every(s=>s.evaluator?.startsWith("opik-js@")));
  assert.deepEqual(judged,[judge.id,judge.id]);
  assert.throws(()=>confirmGraderPlan(b,{...approval,choices:[choices[0]]}),/already been approved/);
  const revised=b.graders.save({...choices[1].definition,type:"opik",industry:"Manufacturing",threshold:.9,intent:"revise",sourceGraderId:ids[1]},[judge]);
  assert.equal(b.graders.get(revised).version,2);
  assert.equal(b.graders.get(ids[1]).threshold,0.8);
});

test("an input-only objective can leave a business metric unscored", async t=>{
  const m:LocalCandidate={kind:"model",id:"ollama/lfm3-mock",model:"lfm3-mock",provider:"ollama",loaded:true};
  const b=new Bench(":memory:",{discover:async()=>[inventory([m])],invoke:async()=>reply(JSON.stringify({
    M1:{choice:"SKIP",reason:"Actual customer renewals require subsequent outcome observations."}
  }))});
  t.after(()=>b.db.close());
  const p=await designGraderPlan(b,{objective:"Increase customer renewals",metrics:"Renewal rate"});
  assert.equal(p.checks.length,0);
  assert.throws(()=>confirmGraderPlan(b,{draftId:p.draftId,choices:[]}));
});

test("conditional disposition checks score evidence and stay anchored to the requested measures", async t => {
  const m:LocalCandidate={kind:"model",id:"ollama/lfm3-mock",model:"lfm3-mock",provider:"ollama",loaded:true};
  const b=new Bench(":memory:",{discover:async()=>[inventory([m])],invoke:async(c,msg,opt)=>{
    assert.deepEqual(allowedChoices(opt.structured,"M1").filter(c=>c.startsWith("NEW:")),["NEW:judge"]);
    assert.deepEqual(Object.keys(constraints.parse(opt.structured).properties),["M1","M2"]);
    return reply(JSON.stringify({M1:{
      name:"Disposition",choice:"NEW:judge",anchors,criteria:"Credit HOLD when the measurement exceeds tolerance or an in-range disposition otherwise.",reason:"Both branches are valid.",threshold:1
    },M2:{choice:"NEW:judge",anchors,name:"Measurement citation",criteria:"Credit the stated measurement when it appears in the input.",reason:"Check the candidate citation.",threshold:1}}));
  }});
  t.after(()=>b.db.close());
  const plan=await designGraderPlan(b,{objective:"Say HOLD when the measurement exceeds tolerance and cite the value.",metrics:"Disposition accuracy\nMeasurement citation"});
  assert.equal(plan.checks[0].type,"opik");
});

test("the designer reuses a matching industry revision, protects references and creates a separate reviewed customer fork",async t=>{
  const model:LocalCandidate={kind:"model",id:"ollama/lfm3-design",model:"lfm3-design",provider:"ollama",loaded:true};
  const inv=inventory([model]);
  let action:"reuse"|"derive"="reuse", invented=false;
  const bench=new Bench(":memory:",{discover:async()=>[inv],invoke:async(_model,messages)=>{
    const text=present(messages.at(-1)).content;
    const payload=z.object({industry:z.string(),automatic:z.array(z.object({name:z.string()})),
      catalog:z.array(z.object({option:z.string(),name:z.string()}))}).parse(JSON.parse(text));
    assert.equal(payload.industry,"Financial Services");
    assert.ok(payload.automatic.some(g=>g.name==="Response present"));
    assert.ok(!payload.catalog.some(g=>g.name==="Response present" || /drawing/i.test(g.name)));
    assert.doesNotMatch(text,/FY26 Q2|0\.74|0\.85|eps-gaap/);
    const source=present(payload.catalog.find(g=>g.name==="Requested financial fact"));
    return reply(JSON.stringify({M1:{choice:invented?"G9999":action==="derive"?"ADAPT:"+source.option:source.option,
      reason:"The approved outcome requires the reported accounting basis.",
      ...(action==="derive" && {name:"Our EPS basis",anchors:{...anchors,evidence:"reference"},criteria:"Check whether the answer distinguishes diluted GAAP EPS from adjusted EPS.",threshold:1})}}));
  }});
  t.after(()=>bench.db.close());bench.servers=[inv];
  const dataset=present(bench.list().datasets.find(d=>d.pack==="earnings"));
  const request={datasetId:dataset.id,industry:"Manufacturing",objective:"Capture diluted GAAP EPS without substituting adjusted EPS.",metrics:"Basis accuracy"};
  const first=await designGraderPlan(bench,request);
  const s=present(first.checks[0].source);assert.equal(s.scope,"industry");
  const count=bench.graders.list().length;
  assert.throws(()=>confirmGraderPlan(bench,{draftId:first.draftId,choices:[{index:0,action:"reuse",sourceGraderId:"invented"}]}));
  assert.deepEqual(confirmGraderPlan(bench,{draftId:first.draftId,choices:[{index:0,action:"reuse"}]}),[s.id]);assert.equal(bench.graders.list().length,count);
  action="derive";
  const second=await designGraderPlan(bench,request);
  const choice={index:0,action:"derive",definition:{name:"Our EPS review",criteria:"Credit a supported diluted GAAP EPS value and explicit basis.",category:"Basis accuracy",threshold:1,judgeId:model.id}};
  const [id]=confirmGraderPlan(bench,{draftId:second.draftId,choices:[choice]});
  const fork=bench.graders.get(id);assert.notEqual(id,s.id);assert.equal(fork.type,"opik");
  assert.equal(fork.library?.parentRevisionId,s.id);assert.equal(fork.library?.scope,"customer");
  assert.equal(bench.graders.get(s.id).criteria,s.criteria);
  action="reuse";invented=true;await assert.rejects(designGraderPlan(bench,request),/catalog option/i);
  assert.throws(()=>confirmGraderPlan(bench,{draftId:second.draftId,choices:[{index:0,action:"reuse"}]}),/approved/);
});

test("an input-only dataset never offers a judge requiring a held-out reference or candidate trajectory",async t=>{
  const m:LocalCandidate={kind:"model",id:"ollama/lfm3-mock",model:"lfm3-mock",provider:"ollama",loaded:true};
  let checked=false;
  const b=new Bench(":memory:",{discover:async()=>[inventory([m])],invoke:async(_candidate,messages)=>{
    const payload=z.object({referenceCoverage:z.string(),catalog:z.array(z.object({name:z.string()}))})
      .parse(JSON.parse(present(messages.at(-1)).content));
    assert.equal(payload.referenceCoverage,"none");
    assert.ok(!payload.catalog.some(check=>["Has inspector reference","Followed inspection tool order","Grounded in the reference"].includes(check.name)));
    checked=true;return reply(JSON.stringify({M1:{choice:"SKIP",reason:"No reference or tool events support the requested accuracy check."}}));
  }});
  t.after(()=>b.db.close());b.servers=[inventory([m])];
  const ds=b.importRows("reference","Unlabeled inspection",[{case_id:"unknown",dataset_version:"1",split:"development",prompt:"Read the inspection note."}],
    {industry:"Manufacturing",family:"Unlabeled inspection",category:"Inspection"});
  const base={category:"Inspection",criteria:"Use only labeled evidence.",threshold:.8,industry:"Manufacturing"};
  b.graders.save({...base,name:"Has inspector reference",type:"decision",requiredEvidence:["reference"],
    decision:{provider:"local",endpoint:"http://127.0.0.1:8080",model:"synthetic",failAt:.2}},[]);
  b.graders.save({...base,name:"Followed inspection tool order",type:"trajectory",criteria:"inspect"},[]);
  b.graders.save({...base,name:"Grounded in the reference",criteria:undefined,type:"opik-metric",metricKey:"hallucination",judgeId:m.id},[m]);
  const plan=await designGraderPlan(b,{datasetId:ds,objective:"Confirm the disposition against its reference.",metrics:"Disposition accuracy"});
  assert.ok(checked);assert.deepEqual(plan.checks,[]);
});

test("hosted planning sees shipped criteria exclusively and cannot select a concealed local customer grader",async t=>{
  const b=new Bench(":memory:",{discover:async()=>[],invoke:async()=>{throw Error("No candidate may run here.");}});
  t.after(()=>b.db.close());b.plannerSettings.save({enabled:true,model:"mock-remote-planner",key:"test-only"});
  b.graders.save({name:"Internal CFO exception",category:"PRIVATE BOARD MARKER",industry:"Financial Services",type:"contains",criteria:"HIDDEN CFO RULE",threshold:1},[]);
  const ds=present(b.list().datasets.find(d=>d.pack==="earnings"));
  const request={datasetId:ds.id,objective:"Capture diluted GAAP EPS.",metrics:"Basis accuracy"};
  let calls=0;
  t.mock.method(globalThis,"fetch",async(_url:Parameters<typeof fetch>[0],options?:RequestInit)=>{
    calls++;
    const envelope=z.object({messages:z.array(z.object({content:z.string()}))}).parse(JSON.parse(String(options?.body)));
    const serialized=JSON.stringify(envelope);
    assert.doesNotMatch(serialized,/Internal CFO exception|HIDDEN CFO RULE|PRIVATE BOARD MARKER|0\.74|eps-gaap/);
    const payload=z.object({catalog:z.array(z.object({option:z.string(),name:z.string()}))}).parse(JSON.parse(present(envelope.messages.at(-1)).content));
    assert.ok(payload.catalog.some(g=>g.name==="Requested financial fact"));
    const fake={M1:{choice:"G9999",reason:"Check basis."}};
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(fake)}}]}),{headers:{"content-type":"application/json"}});
  });
  await assert.rejects(designGraderPlan(b,request),/catalog option/);assert.equal(calls,2);
});

test("superseded-drawing plans select a pinned rule once, preserve every measure and reject the former conflicting dual lists",async t=>{
  const local:LocalCandidate={kind:"model",id:"lmstudio/lfm3-1.7b",model:"lfm3-1.7b",provider:"lmstudio",loaded:true};
  let calls=0;
  const b=new Bench(":memory:",{discover:async()=>[inventory([local])],invoke:async(_model,messages,options)=>{
    const input=z.object({goals:z.array(z.object({key:z.string(),metric:z.string()})),catalog:z.array(z.object({name:z.string(),option:z.string()}))})
      .parse(JSON.parse(present(messages.at(-1)).content));
    const drawing=present(input.catalog.find(rule=>rule.name==="Active drawing and sample identity"));
    assert.deepEqual(Object.keys(constraints.parse(options.structured).properties),input.goals.map(g=>g.key));
    if(++calls===1){
      return reply(JSON.stringify({summary:"One measure",catalogChoices:[{option:drawing.option,action:"reuse",metric:input.goals[0].metric,criteria:"",reason:"Revision identity"}],
        checks:[{name:drawing.name,method:"judge",metric:input.goals[0].metric,criteria:"Holding the lot is optional when its measurement looks good.",threshold:.5,reason:"Changed criterion"}]}));
    }
    return reply(JSON.stringify(Object.fromEntries(input.goals.map(({key})=>[key,key==="M3"?{choice:"SKIP",reason:"No production hold duration was observed."}:
      {choice:drawing.option,reason:"Compare the requested identity with the labeled active drawing."}]))));
  }});
  t.after(()=>b.db.close());b.servers=[inventory([local])];
  const ds=present(b.list().datasets.find(d=>d.pack==="manufacturing"));
  const request={datasetId:ds.id,objective:"Hold any inspected lot evaluated against a superseded drawing revision.",metrics:"Active drawing revision accuracy"};
  const one=await designGraderPlan(b,request);assert.equal(calls,2);assert.equal(one.checks.length,1);
  assert.equal(one.checks[0].action,"reuse");assert.equal(one.checks[0].source?.name,"Active drawing and sample identity");
  assert.deepEqual(confirmGraderPlan(b,{draftId:one.draftId,choices:[{index:0,action:"reuse"}]}),[one.checks[0].source?.id]);
  const multi=await designGraderPlan(b,{...request,metrics:request.metrics+"\nPart and lot identity accuracy\nReduction in hold duration"});
  assert.equal(multi.checks.length,1);assert.match(multi.summary,/Active drawing revision accuracy/);assert.match(multi.summary,/Part and lot identity accuracy/);
  assert.match(multi.summary,/Reduction in hold duration — unscored/);assert.match(multi.checks[0].reason,/Part and lot identity accuracy/);
});

test("new grader defaults can be edited within evidence and industry constraints before one confirmed save", async t=>{
  const judge:LocalCandidate={kind:"model",id:"ollama/lfm3-test",provider:"ollama",model:"lfm3-test",loaded:true};
  const servers=[inventory([judge])];
  const b=new Bench(":memory:",{discover:async()=>servers,invoke:async()=>reply(JSON.stringify({
    M1:{choice:"NEW:judge",anchors,name:"Disposition",criteria:"Check if the answer holds the batch.",threshold:.8,reason:"Inspect the disposition."},
  }))});
  t.after(()=>b.db.close());b.servers=servers;
  const plan=await designGraderPlan(b,{objective:'The response must include the literal "HOLD".'});
  assert.deepEqual(plan.editableMethods,["contains","opik"]);
  const check={index:0,action:"create",definition:{name:"Hold label",category:"Disposition",criteria:"HOLD",threshold:1,type:"contains",industry:"Manufacturing"}};
  const confirm=(definition:Record<string,unknown>)=>confirmGraderPlan(b,{draftId:plan.draftId,choices:[{...check,definition}]});
  assert.throws(()=>confirm({...check.definition,type:"field"}),/evidence/);
  assert.throws(()=>confirm({...check.definition,industry:"Unregistered"}),/domain/);
  const [id]=confirm(check.definition);
  assert.deepEqual(confirm(check.definition),[id]);
  const actual=b.graders.get(id);
  assert.equal(actual.type,"contains");assert.equal(actual.judge,null);assert.equal(actual.criteria,"HOLD");assert.equal(actual.industry,"Manufacturing");
});

test("reference-dependent semantic rubric preserves the success measure and never invokes the judge on missing evidence",async t=>{
  const model:LocalCandidate={kind:"model",id:"ollama/lfm3-test",model:"lfm3-test",provider:"ollama",loaded:true};
  const inv=inventory([model]);
  let sameAnchors=true,judgeCalls=0;
  const adapters:RuntimeAdapters={discover:async()=>[inv],invoke:async(_m,_messages,options)=>{
    if(options.planning)return reply(JSON.stringify({M1:{choice:"NEW:judge",name:"Requested basis",criteria:"Assess accounting basis against the reference.",
      anchors:{...anchors,partial:sameAnchors?anchors.full:anchors.partial,evidence:"reference"},threshold:.8,reason:"A reference supplies the financial fact."}}));
    judgeCalls++;return reply(options.structured?'{"score":0,"reason":"The cited basis is incorrect."}':"Compare the accounting basis.");
  }};
  const bench=new Bench(":memory:",adapters);t.after(()=>bench.db.close());bench.servers=[inv];
  const scenario=present(bench.list().datasets.find(d=>d.pack==="earnings"));
  const brief={datasetId:scenario.id,objective:"Check the cited accounting basis.",metrics:"Citation basis"};
  await assert.rejects(designGraderPlan(bench,brief),/distinct observable anchors/);
  sameAnchors=false;
  const plan=await designGraderPlan(bench,brief),check=present(plan.checks[0]);
  assert.match(check.criteria,/Success measure: Citation basis/);
  assert.match(check.criteria,/Full credit \(10\)/);assert.match(check.criteria,/Partial credit \(5\)/);assert.match(check.criteria,/Zero credit \(0\)/);
  const id=present(confirmGraderPlan(bench,{draftId:plan.draftId,choices:[{index:0,action:"create",definition:{
    name:check.name,category:check.category,criteria:check.criteria,threshold:.8,judgeId:model.id}}]})[0]);
  const grader=bench.graders.get(id);
  const evidence={input:"Cite GAAP EPS",output:"Adjusted EPS was 0.85",reference:null};
  const missing=await bench.graders.assess(grader,evidence,adapters,new AbortController().signal);
  assert.equal(missing.pass,null);assert.equal(missing.value,null);assert.match(missing.reason,/requires a case reference/);assert.equal(judgeCalls,0);
  const failed=await bench.graders.assess(grader,{...evidence,reference:"GAAP EPS was 0.74."},adapters,new AbortController().signal);
  assert.equal(failed.value,0,failed.reason);assert.equal(failed.pass,false);assert.ok(judgeCalls>0);
});

test("handoff requirement is assessed on the future answer; post-dispatch warranty savings stay external",async t=>{
  const model:LocalCandidate={kind:"model",id:"lmstudio/lfm3-test",provider:"lmstudio",model:"lfm3-test",loaded:true};
  const servers=[inventory([model])];
  let attempts=0,smuggle=false;
  const measurable="Share of handoff notes that identify the lot and state the next action.";
  const external="Measure the actual reduction in warranty costs achieved six months after dispatch.";
  const bench=new Bench(":memory:",{discover:async()=>servers,invoke:async(_m,messages,options)=>{
    attempts++;
    assert.deepEqual(allowedChoices(options.structured,"M2"),["SKIP"]);
    if(attempts===1)return reply(JSON.stringify({M1:{choice:"SKIP",reason:"The supplied brief does not include the actual handoff note text or any candidate response."},M2:{choice:"SKIP",reason:"Requires operational records."}}));
    if(attempts===2)assert.match(present(messages[0]).content,/answer is guaranteed at scoring time/);
    return reply(JSON.stringify({M1:{choice:"NEW:judge",name:smuggle?"Warranty proxy":"Lot and next action",criteria:"Inspect both details in the note. Do not grade warranty cost reduction.",reason:"Inspect the generated handoff.",
      anchors:{full:smuggle?"The lot is identified and a warranty cost reduction is achieved.":"Identifies the lot and next action.",partial:"Names just one detail.",zero:"Omits both details.",evidence:"response"},threshold:1},
      M2:{choice:"NEW:judge",reason:"Trust the estimate printed by the candidate."}}));
  }});
  t.after(()=>bench.db.close());
  const request={domainId:"Manufacturing",objective:"Inspect a handoff note.",metrics:measurable+"\n"+external};
  const plan=await designGraderPlan(bench,request);
  assert.equal(attempts,2);assert.equal(plan.checks.length,1);assert.match(plan.checks[0].criteria,/Share of handoff notes/);assert.match(plan.checks[0].criteria,/unavailable for this binary count/);
  assert.match(plan.summary,/warranty costs.* — unscored/);
  assert.equal(plan.checks[0].evidenceView,"answer-only");bench.servers=servers;
  const g=plan.checks[0];
  const [id]=confirmGraderPlan(bench,{draftId:plan.draftId,choices:[{index:0,action:"create",definition:{name:g.name,category:g.category,criteria:g.criteria,threshold:g.threshold,judgeId:model.id}}]});
  const actual=bench.graders.get(id);assert.equal(actual.type==="opik" && actual.evidenceView,"answer-only");
  const fullCase={input:"Lot K7 must go to SECRET_QUARANTINE.",output:"Lot K7.",reference:"SECRET_EXPECTED_ACTION",evaluationBrief:{objective:"SECRET_BRIEF",metrics:["SECRET_METRIC"],criteria:[]}};
  let verdicts=0;
  const isolated:RuntimeAdapters={discover:async()=>servers,invoke:async(_m,messages)=>{
    assert.doesNotMatch(JSON.stringify(messages),/SECRET_/);
    const call=opikJudgeRequest(messages);
    if(call?.stage==="geval-score"){assert.deepEqual(call.evidence,{output:"Lot K7."});verdicts++;return reply('{"score":0,"reason":"The note omits the next action."}');}
    return reply("Look for a lot identifier and next action in the candidate output.");
  }};
  const scored=await bench.graders.assess(actual,fullCase,isolated,new AbortController().signal);
  assert.equal(scored.value,0,scored.reason);assert.equal(verdicts,1);
  const contextGrader=bench.graders.save({intent:"revise",sourceGraderId:id,evidenceView:"case"},[model]);
  assert.notEqual(contextGrader,id);assert.equal(bench.graders.get(id).type,"opik");
  const empty=await designGraderPlan(bench,{domainId:"Manufacturing",objective:external});
  assert.equal(empty.checks.length,0);assert.equal(attempts,2);assert.equal(empty.designer,null);
  smuggle=true;await assert.rejects(designGraderPlan(bench,request),/cannot earn credit for achieving/);
});
