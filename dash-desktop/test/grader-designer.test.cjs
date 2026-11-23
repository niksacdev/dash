const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Bench } = require("../lib/bench.cjs");
const { designGraderPlan, confirmGraderPlan } = require("../lib/grader-designer.cjs");

test("the designer proposes a minimal plan, then confirmation saves reusable versions atomically", async t => {
  const judge = {id:"ollama/lfm3-test",provider:"ollama",model:"lfm3-test",loaded:true,revision:"test-r1"};
  const inventory = [{provider:"ollama",online:true,models:[judge]}];
  const proposed = [
    {name:"Hold wording",metric:"Exact disposition",method:"contains",criteria:"The response must contain the exact word HOLD",reason:"The contract specifies this literal.",threshold:1},
    {name:"Evidence quality",metric:"Evidence quality",method:"judge",criteria:"Full credit requires the measured diameter and the tolerance. Partial credit for one; zero if both are absent.",reason:"Equivalent explanations are acceptable.",threshold:0.8},
  ];
  const judged = [];
  const adapters = {
    discover:async()=>inventory,
    invoke:async(candidate,messages,options)=>{
      if (options.planning) {
        const brief=JSON.parse(messages.at(-1).content);
        assert.equal(brief.industry,"Manufacturing");
        assert.match(brief.objective,/HOLD/);
        assert.deepEqual(brief.metrics,["Exact disposition","Evidence quality"]);
        assert.deepEqual(options.structured.properties.checks.items.properties.method.enum,["contains","judge"]);
        return {output:JSON.stringify({summary:"Check the disposition separately from its supporting measurement.",checks:proposed})};
      }
      judged.push({candidate,messages,options});
      return {output:options.structured ? '{"score":8,"reason":"The response cites the diameter and tolerance."}' : "Inspect the measurement and its tolerance."};
    }
  };
  const b=new Bench(":memory:",adapters);
  t.after(()=>b.db.close());
  b.servers=inventory;
  const proposal=await designGraderPlan(b,{objective:'Every response must include the literal "HOLD" and cite the measurement.',metrics:"Exact disposition\nEvidence quality",industry:"Manufacturing"});
  assert.equal(proposal.designer.model,judge.model);
  assert.deepEqual(proposal.checks.map(g=>g.type),["contains","opik"]);
  assert.equal(b.graders.list().length,0);
  assert.throws(()=>confirmGraderPlan(b,proposal.checks),/judge/);
  assert.equal(b.graders.list().length,0,"Partial confirmations must roll back");
  const edits=proposal.checks.map(g=>({...g,judgeId:judge.id}));
  const ids=confirmGraderPlan(b,edits);
  assert.deepEqual(confirmGraderPlan(b,edits),ids,"Retrying confirmation reuses the same versions");
  const evidence={input:"Inspect the part",output:"HOLD. Measured 10.04 mm; max 10.03 mm."};
  const scores=await Promise.all(b.graders.select(ids).map(g=>b.graders.assess(g,evidence,adapters,AbortSignal.timeout(10000))));
  assert.deepEqual(scores.map(s=>[s.value,s.pass]),[[1,true],[0.8,true]]);
  assert.ok(scores.every(s=>s.evaluator.startsWith("opik-js@")));
  assert.deepEqual(judged.map(c=>c.candidate.id),[judge.id,judge.id]);
  const revised=confirmGraderPlan(b,[{...edits[1],threshold:0.9}])[0];
  assert.equal(b.graders.get(revised).version,2);
  assert.equal(b.graders.get(ids[1]).threshold,0.8);
});

test("an input-only objective can leave a business metric unscored", async t=>{
  const m={id:"ollama/lfm3-mock",model:"lfm3-mock",provider:"ollama",loaded:true};
  const b=new Bench(":memory:",{discover:async()=>[{models:[m]}],invoke:async()=>({output:JSON.stringify({
    summary:"Actual customer renewals require subsequent outcome observations.",checks:[]
  })})});
  t.after(()=>b.db.close());
  const p=await designGraderPlan(b,{objective:"Increase customer renewals",metrics:"Renewal rate"});
  assert.equal(p.checks.length,0);
  assert.throws(()=>confirmGraderPlan(b,[]),/one to eight/);
});

test("conditional disposition checks score evidence and stay anchored to the requested measures", async t => {
  const m={id:"ollama/lfm3-mock",model:"lfm3-mock",provider:"ollama",loaded:true};
  const b=new Bench(":memory:",{discover:async()=>[{models:[m]}],invoke:async(c,msg,opt)=>{
    const fields=opt.structured.properties.checks.items.properties;
    assert.deepEqual(fields.method.enum,["judge"]);
    assert.deepEqual(fields.metric.enum,["Disposition accuracy","Measurement citation"]);
    return {output:JSON.stringify({summary:"Assess the applicable disposition for the supplied measurement.",checks:[{
      name:"Disposition",metric:"Disposition accuracy",method:"judge",criteria:"Credit HOLD when the measurement exceeds tolerance, or an in-range disposition otherwise.",reason:"Both branches are valid.",threshold:1
    }]})};
  }});
  t.after(()=>b.db.close());
  const plan=await designGraderPlan(b,{objective:"Say HOLD when the measurement exceeds tolerance and cite the value.",metrics:"Disposition accuracy\nMeasurement citation"});
  assert.equal(plan.checks[0].type,"opik");
});
