import { test } from "node:test";
import assert from "node:assert/strict";
import { Bench } from "../lib/bench.cjs";
import { designGraderPlan, confirmGraderPlan } from "../lib/grader-designer.cjs";

import { inventory,reply,present } from "./runtime-fixtures.cjs";
import type { LocalCandidate,RuntimeAdapters } from "../lib/runtime-types.cjs";
import {z} from "zod";

const constraints=z.object({properties:z.object({checks:z.object({items:z.object({properties:z.object({
  method:z.object({enum:z.array(z.string())}),metric:z.object({enum:z.array(z.string())})
})})})})});

test("the designer proposes a minimal plan, then confirmation saves reusable versions atomically", async t => {
  const judge:LocalCandidate = {kind:"model",id:"ollama/lfm3-test",provider:"ollama",model:"lfm3-test",loaded:true,revision:"test-r1"};
  const servers = [inventory([judge])];
  const proposed = [
    {name:"Hold wording",metric:"Exact disposition",method:"contains",criteria:"The response must contain the exact word HOLD",reason:"The contract specifies this literal.",threshold:1},
    {name:"Evidence quality",metric:"Evidence quality",method:"judge",criteria:"Full credit requires the measured diameter and the tolerance. Partial credit for one; zero if both are absent.",reason:"Equivalent explanations are acceptable.",threshold:0.8},
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
        assert.deepEqual(constraints.parse(options.structured).properties.checks.items.properties.method.enum,["contains","judge"]);
        return reply(JSON.stringify({summary:"Check the disposition separately from its supporting measurement.",checks:proposed}));
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
    summary:"Actual customer renewals require subsequent outcome observations.",checks:[]
  }))});
  t.after(()=>b.db.close());
  const p=await designGraderPlan(b,{objective:"Increase customer renewals",metrics:"Renewal rate"});
  assert.equal(p.checks.length,0);
  assert.throws(()=>confirmGraderPlan(b,{draftId:p.draftId,choices:[]}));
});

test("conditional disposition checks score evidence and stay anchored to the requested measures", async t => {
  const m:LocalCandidate={kind:"model",id:"ollama/lfm3-mock",model:"lfm3-mock",provider:"ollama",loaded:true};
  const b=new Bench(":memory:",{discover:async()=>[inventory([m])],invoke:async(c,msg,opt)=>{
    const fields=constraints.parse(opt.structured).properties.checks.items.properties;
    assert.deepEqual(fields.method.enum,["judge"]);
    assert.deepEqual(fields.metric.enum,["Disposition accuracy","Measurement citation"]);
    return reply(JSON.stringify({summary:"Assess the applicable disposition for the supplied measurement.",checks:[{
      name:"Disposition",metric:"Disposition accuracy",method:"judge",criteria:"Credit HOLD when the measurement exceeds tolerance, or an in-range disposition otherwise.",reason:"Both branches are valid.",threshold:1
    }]}));
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
    return reply(JSON.stringify({summary:"The selected fact check covers the requested accounting basis.",checks:[],
      catalogChoices:[{option:invented?"G9999":source.option,action,metric:"Basis accuracy",criteria:action==="derive"?"Check whether the answer distinguishes diluted GAAP EPS from adjusted EPS.":"",
        reason:"The approved outcome requires the reported accounting basis."}]}));
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
  invented=true;await assert.rejects(designGraderPlan(bench,request),/catalog options/i);
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
    checked=true;return reply(JSON.stringify({summary:"No reference or tool events support the requested accuracy check.",checks:[]}));
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
    const fake={summary:"A customer source was guessed.",checks:[],catalogChoices:[{option:"G9999",metric:"Basis accuracy",action:"reuse",criteria:"",reason:"Check basis."}]};
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(fake)}}]}),{headers:{"content-type":"application/json"}});
  });
  await assert.rejects(designGraderPlan(b,request),/catalog options/);assert.equal(calls,2);
});
