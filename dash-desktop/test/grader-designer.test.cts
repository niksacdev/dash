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
  const proposal=await designGraderPlan(b,{objective:'Every response must include the literal "HOLD" and cite the measurement.',metrics:"Exact disposition\nEvidence quality",industry:"Manufacturing"});
  assert.equal(present(proposal.designer).model,judge.model);
  assert.deepEqual(proposal.checks.map(g=>g.type),["contains","opik"]);
  assert.equal(b.graders.list().length,0);
  assert.throws(()=>confirmGraderPlan(b,proposal.checks),/judge/);
  assert.equal(b.graders.list().length,0,"Partial confirmations must roll back");
  const edits=proposal.checks.map(g=>({...g,judgeId:judge.id}));
  const ids=confirmGraderPlan(b,edits);
  assert.deepEqual(confirmGraderPlan(b,edits),ids,"Retrying confirmation reuses the same versions");
  const evidence={reference:null,input:"Inspect the part",output:"HOLD. Measured 10.04 mm; max 10.03 mm."};
  const scores=await Promise.all(b.graders.select(ids).map(g=>b.graders.assess(g,evidence,adapters,AbortSignal.timeout(10000))));
  assert.deepEqual(scores.map(s=>[s.value,s.pass]),[[1,true],[0.8,true]]);
  assert.ok(scores.every(s=>s.evaluator?.startsWith("opik-js@")));
  assert.deepEqual(judged,[judge.id,judge.id]);
  const revised=confirmGraderPlan(b,[{...edits[1],threshold:0.9}])[0];
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
  assert.throws(()=>confirmGraderPlan(b,[]),/one to eight/);
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
