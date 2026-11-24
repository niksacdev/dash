import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {z} from "zod";
import {Bench} from "../lib/bench.cjs";
import {checkStructuredOutput,decodeQuickOutputSchema,quickStructuredMessages,schemaFromFields} from "../lib/quick-structure.cjs";
import {invoke} from "../lib/providers.cjs";
import {ProviderRejectedError,type ChatTurn,type LocalCandidate,type ModelCandidate,type RuntimeAdapters} from "../lib/runtime-types.cjs";
import {inventory,present,reply,withoutPower} from "./runtime-fixtures.cjs";

const fields=[{name:"part_id",type:"string",nullable:false},{name:"width_mm",type:"number",nullable:true}];
const schema=schemaFromFields(fields);
const objective="Extract part_id and width_mm from the label. Label: P-04, width unavailable.";
const taskInput={task:objective,inputs:{part_id:"P-04"}};
const planningSchema=z.object({properties:z.record(z.string(),z.unknown())});

test("structured contract checks complete JSON independently of business accuracy",()=>{
  const check=(value:string)=>checkStructuredOutput(value,schema).valid;
  assert.ok(check('{"part_id":"P-04","width_mm":null}'));
  assert.ok(check('{"part_id":"wrong part","width_mm":0}'));
  for (const invalid of ['invalid','null','[]','{"part_id":"P-04"}','{"part_id":5,"width_mm":2}',
    '{"part_id":"P-04","width_mm":"two"}','{"part_id":"P-04","width_mm":2,"extra":true}']) assert.equal(check(invalid),false);
  for (const invalid of [{...schema,properties:{part_id:{$ref:"#"},width_mm:{type:"number"}}},
    {...schema,additionalProperties:true},{...schema,required:["part_id","part_id"]},{...schema,patternProperties:{}}])
    assert.throws(()=>decodeQuickOutputSchema(invalid));
  assert.throws(()=>schemaFromFields([{name:"constructor",type:"string",nullable:false}]));
});

test("Quick approves editable source/schema once, sends both lanes the pinned contract and reuses it after reopening",async t=>{
  const home=mkdtempSync(join(tmpdir(),"dash-json-contract-"));
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  const filename=join(home,"runs.sqlite");
  const models=["lfm3-1.7b","second"].map((model):LocalCandidate=>({kind:"model",provider:"lmstudio",model,id:"lmstudio/"+model,loaded:true}));
  const dispatched:{messages:ChatTurn[];schema:unknown;strict:boolean|undefined}[]=[];
  const planningCalls:ChatTurn[][]=[];
  const adapters:RuntimeAdapters={
    discover:async()=>[inventory(models)],
    invoke:async(candidate,messages,options)=>{
      if (options.planning) {
        planningCalls.push(messages);
        const properties=planningSchema.parse(options.structured).properties;
        const response=properties.requirements ?
          {title:"Extract part labels",metrics:["Correct part identifier"],requirements:["Copy the part identifier from the label."]} :
          {prompt:"Record the part identifier from the supplied label.",reason:"The label supplies the requested identifier.",
            ...(!!properties.fields && {fields,inputs:[{name:"part_id",value:"P-04"},{name:"guessed",value:"18.6"}]})};
        return reply(JSON.stringify(response));
      }
      dispatched.push({messages,schema:options.structured,strict:options.strictSchema});
      return reply(candidate.id===models[0].id ? '{"part_id":"P-04","width_mm":null}' : '{"part_id":"P-04"}');
    },
  };
  let bench=new Bench(filename,adapters,withoutPower);
  t.after(()=>bench.db.close());
  await bench.refresh();
  const request={mode:"quick",domain:"Manufacturing",objective,measures:{metrics:[],criteria:[]},metrics:"PRIVATE_GRADER_TARGET"};
  const draft=await bench.designPrompt({...request,structuredOutput:true});
  assert.deepEqual(draft.outputSchema,schema);
  assert.deepEqual(draft.input,{task:draft.prompt,inputs:{part_id:"P-04"}});
  assert.doesNotMatch(JSON.stringify(planningCalls.at(-1)),/PRIVATE_GRADER_TARGET/);
  const callCount=planningCalls.length;
  const edited={...taskInput,task:draft.prompt,inputs:{label_value:"P-04"}};
  const approval={draftId:draft.draftId,prompt:draft.prompt,input:edited,outputSchema:schema};
  assert.throws(()=>bench.workflow.approve({...approval,input:{...edited,inputs:{part:"INVENTED"}}}),/copied exactly/);
  assert.throws(()=>bench.workflow.approve({...approval,outputSchema:{...schema,additionalProperties:true}}),/closed JSON/);
  const approved=bench.workflow.approve(approval);
  assert.deepEqual(approved,bench.workflow.approve(approval));
  assert.throws(()=>bench.workflow.approve({...approval,input:{...edited,inputs:{}}}),/already approved/);
  assert.throws(()=>bench.workflow.approve({...approval,outputSchema:schemaFromFields(fields.slice(0,1))}),/already approved/);
  assert.deepEqual(bench.workflow.get(approved.id).input,edited);
  const candidateIds=models.map(model=>model.id);
  const start=(id:string)=>bench.start({mode:"quick",approvedPromptId:id,candidateIds});
  const runId=start(approved.id);
  await present(bench.active).done;
  const run=bench.detail(runId);
  const messages=quickStructuredMessages(edited,schema);
  assert.deepEqual(dispatched,[{messages,schema,strict:true},{messages,schema,strict:true}]);
  assert.doesNotMatch(JSON.stringify(messages),/PRIVATE_GRADER_TARGET|Copy the part identifier/);
  assert.deepEqual(run.results.map(r=>r.structuredOutputCheck?.valid),[true,false]);
  assert.deepEqual(run.results.map(r=>r.dispatchedMessages),[messages,messages]);
  assert.deepEqual(run.manifest.approvedPrompt?.outputSchema,schema);
  const jsonGrader=present(run.manifest.graders.find(g=>g.type==="catalog" && g.ruleKey==="json-valid"));
  // Lane two is valid JSON with a missing required field. Native Opik syntax and contract conformance stay distinct.
  assert.deepEqual(run.assessments.filter(a=>a.graderId===jsonGrader.id).map(a=>a.value),[1,1]);
  bench.db.close();
  bench=new Bench(filename,adapters,withoutPower);
  await bench.refresh();
  assert.deepEqual(bench.detail(runId).results.map(r=>r.structuredOutputCheck?.valid),[true,false]);
  const again=start(approved.id);
  await present(bench.active).done;
  assert.equal(bench.detail(again).manifest.promptHash,run.manifest.promptHash);
  assert.equal(planningCalls.length,callCount);
  const plain=await bench.designPrompt({...request,structuredOutput:false});
  assert.equal(planningCalls.length,2*callCount);
  assert.equal(plain.outputSchema,undefined);
  assert.equal(plain.input,undefined);
  const saved=bench.workflow.approve({draftId:plain.draftId,prompt:plain.prompt});
  const plainRun=start(saved.id);
  await present(bench.active).done;
  assert.deepEqual(dispatched.at(-1),{messages:[{role:"user",content:saved.prompt}],schema:undefined,strict:undefined});
  assert.equal(bench.detail(plainRun).results[0].structuredOutputCheck,undefined);
  assert.notEqual(bench.detail(plainRun).manifest.promptHash,run.manifest.promptHash);
  await assert.rejects(bench.designPrompt({...request,mode:"dataset",structuredOutput:true}),/dataset uses its pinned/);
});

test("strict Quick sends native format to Ollama and strict JSON Schema to LM Studio and compatible endpoints",async t=>{
  const messages=quickStructuredMessages(taskInput,schema);
  const candidates:ModelCandidate[]=[
    {kind:"model",provider:"ollama",id:"ollama/example",model:"example"},
    {kind:"model",provider:"lmstudio",id:"lmstudio/example",model:"example",nativeChat:true},
    {kind:"model",provider:"compatible",id:"custom/example",model:"example",section:"Hosted",keyRequired:false,endpoint:"https://model.example.invalid/v1"},
  ];
  let fail=false;
  const lastRequests:{url:string;body:Record<string,unknown>}[]=[];
  t.mock.method(globalThis,"fetch",async(url:string,options:RequestInit)=>{
    const body=z.record(z.string(),z.unknown()).parse(JSON.parse(String(options.body)));
    lastRequests.push({url,body});
    const response=url.endsWith("/api/chat") ? '{"done":true,"message":{"content":"{}"}}\n' : 'data: [DONE]\n';
    return new Response(fail ? "private error with prompt" : response,{status:fail ? 422 : 200});
  });
  for (const candidate of candidates) {
    await invoke(candidate,messages,{signal:AbortSignal.timeout(2000),structured:schema,strictSchema:true});
    const {url,body}=present(lastRequests.at(-1));
    assert.deepEqual(body.messages,messages);
    if (candidate.provider==="ollama") {
      assert.deepEqual(body.format,schema);assert.match(url,/\/api\/chat$/);
    } else {
      assert.match(url,/\/v1\/chat\/completions$/);
      assert.deepEqual(body.response_format,{type:"json_schema",json_schema:{name:"case_output",schema,strict:true}});
    }
  }
  fail=true;
  const rejectedAt=lastRequests.length;
  await assert.rejects(invoke(candidates[2],messages,{signal:AbortSignal.timeout(2000),structured:schema,strictSchema:true}),
    (error:unknown)=>error instanceof ProviderRejectedError && /JSON Schema/.test(error.message) && !error.message.includes("private"));
  assert.equal(lastRequests.length,rejectedAt+1);
});
