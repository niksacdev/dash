import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {z} from "zod";
import {alignIntervalProposal,declaredOutputKeys,declaredPlannerFields,proposedOutputSchema} from "../lib/quick-declaration.cjs";
import {decodeApprovedPrompt} from "../lib/outcome-contracts.cjs";
import {Bench} from "../lib/bench.cjs";
import {checkStructuredOutput,decodeQuickOutputSchema,quickStructuredMessages,previewStructuredMessages,schemaFromFields,reviewProposedFields} from "../lib/quick-structure.cjs";
import {invoke} from "../lib/providers.cjs";
import {ProviderRejectedError,type ChatTurn,type LocalCandidate,type ModelCandidate,type RuntimeAdapters} from "../lib/runtime-types.cjs";
import {auditReply} from "./audit-fixture.cjs";
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

test("an explicit output declaration fixes key identities even when an archived source supplies a distractor",()=>{
  const current="Return part_id and lot_id for the current inspection record. Use exactly two string fields with those names. Current record: part MX-417, lot L-08. Archived record: part MX-417, lot L-07.";
  const missing="Return part_id and lot_id for the current inspection record. Use exactly those two fields. The current record gives part MX-417 but has no lot identifier. Return null for its missing lot_id.";
  const keys=["part_id","lot_id"];
  for (const task of [current,missing,"Return exactly part_id and lot_id.","Return the extraction using keys part_id and lot_id."])
    assert.deepEqual(declaredOutputKeys(task),keys);
  for (const free of ["Summarize the case. Source: Return exactly part_id and lot_id.",
    "Return a summary of this record: output using keys lot_id and order_id.","Identify the part identifier and originating lot.",
    "Return exactly the blue part and the yellow lot."]) assert.equal(declaredOutputKeys(free),null);
  assert.deepEqual(Object.keys(declaredPlannerFields(keys).properties),keys);
  assert.throws(()=>proposedOutputSchema({part_id:{type:"string",nullable:false},lot_id_archived:{type:"string",nullable:false}},keys),/declared fields/);
  const response=proposedOutputSchema({lot_id:{type:"string",nullable:true},part_id:{type:"string",nullable:false}},keys);
  assert.deepEqual(response.required,keys);
  assert.deepEqual(response.properties.lot_id.type,["string","null"]);
  const note={name:"part_id",quote:"part_id and lot_id",explanation:"The identifier is text and must be returned."};
  const accepted=reviewProposedFields(response,[note],current,true);
  assert.ok(accepted.declaredKeys);
  assert.equal(accepted.fields[0].note?.explanation,note.explanation);
  for (const invalid of [{...note,quote:"Archived record"},{...note,explanation:"This guarantees 100 percent higher accuracy."},
    {...note,explanation:"Use part MX-417 as this string."}]) assert.equal(reviewProposedFields(response,[invalid],current,true).fields[0].note,null);
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
            ...(!!properties.fields && {fields,inputs:[{name:"part_id",value:"P-04"},{name:"guessed",value:"18.6"}],
              fieldNotes:[{name:"part_id",quote:"Extract part_id",explanation:"A non-null string preserves the printed identifier."},
                {name:"width_mm",quote:"The caliper read 77",explanation:"Unobserved quote."}]})};
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
  const notes=present(draft.schemaReview);
  assert.equal(notes.fields[0].note?.quote,"Extract part_id");
  assert.equal(notes.fields[1].note,null);
  assert.equal(notes.taskEdited,false);
  assert.equal(draft.designer?.model,"lfm3-1.7b");
  assert.ok(draft.workflowAgents?.some(role=>role.id==="workflow-structured-output" && role.version===3));
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
  const {schemaReview:_historical,...historic}=approved;
  assert.equal(decodeApprovedPrompt(historic).schemaReview,undefined);
  const candidateIds=models.map(model=>model.id);
  const start=(id:string)=>bench.start({mode:"quick",inspectionOnly:true,approvedPromptId:id,candidateIds});
  const runId=start(approved.id);
  await present(bench.active).done;
  const run=bench.detail(runId);
  const messages=quickStructuredMessages(edited,schema);
  assert.deepEqual(previewStructuredMessages({input:edited,outputSchema:schema}),messages);
  assert.throws(()=>previewStructuredMessages({input:{...edited,inputs:{value:"invented"}},outputSchema:schema}),/copied exactly/);
  assert.doesNotMatch(JSON.stringify(messages),/non-null string preserves|Unobserved quote/);
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
  const changed=await bench.designPrompt({...request,structuredOutput:true});
  const editedTask=changed.prompt+" Preserve the identifier exactly.";
  const changedSchema=schemaFromFields([{name:"part_id",type:"integer",nullable:true}]);
  const savedEdit=bench.workflow.approve({draftId:changed.draftId,prompt:editedTask,input:{task:editedTask,inputs:{}},outputSchema:changedSchema});
  assert.equal(savedEdit.schemaReview?.taskEdited,true);
  assert.equal(savedEdit.schemaReview?.fields[0].type,"string");
  assert.deepEqual(savedEdit.outputSchema?.properties.part_id,{type:["integer","null"]});
  await assert.rejects(bench.designPrompt({...request,mode:"dataset",structuredOutput:true}),/dataset uses its pinned/);
});

test("interval proposals distinguish both endpoints from one threshold, width or a range mentioned only in source data",()=>{
  const range={name:"pressureInterval",type:"number",nullable:true};
  const extra=["upper_limit","interval_width","range_min","out_of_range_count"].map(name=>({...range,name}));
  const original=schemaFromFields([range,...extra]);
  for (const task of ["Return the upper limit of the pressure range.","Report the interval width.","Report whether the reading falls within the permitted range.",
      "Report whether both readings fall within the range.",
      "Cite the measured reading. Source: Report the permissible range.","Report the maximum pressure. The permitted range is 4–9."]) {
    assert.deepEqual(alignIntervalProposal(original,false,task,[]).schema,original);
  }
  const full="State the permitted range and cite the measured reading.";
  assert.deepEqual(alignIntervalProposal(original,false,"Return only the upper limit. Source: The drawing permits 4–9.",[full]).schema,original);
  const two=alignIntervalProposal(original,false,full,[]).schema;
  assert.deepEqual(two.required,["pressureInterval_lower","pressureInterval_upper",...extra.map(f=>f.name)]);
  const mixed=schemaFromFields([range,{...range,name:"temperature_range"}]);
  assert.deepEqual(alignIntervalProposal(mixed,false,"Report the pressure interval and cite only the upper temperature threshold.",[]).schema.required,
    ["pressureInterval_lower","pressureInterval_upper","temperature_range"]);
  const fixed=alignIntervalProposal(original,true,full,[]);
  assert.deepEqual(fixed.schema.required,original.required);
  assert.deepEqual(fixed.schema.properties.pressureInterval.type,["string","null"]);
  assert.equal(fixed.intervals.get("pressureInterval"),"text");
  const occupied=schemaFromFields([range,{...range,name:"pressureInterval_lower"}]);
  assert.deepEqual(alignIntervalProposal(occupied,false,full,[]).schema.required,occupied.required);
  const twelve=schemaFromFields([range,...Array.from({length:11},(_,i)=>({...range,name:"reading_"+i}))]);
  assert.equal(alignIntervalProposal(twelve,false,full,[]).schema.required.length,12);
  assert.deepEqual(alignIntervalProposal(twelve,false,full,[]).schema.properties.pressureInterval.type,["string","null"]);
});

test("a reviewed drawing-range measure changes new Quick proposals, and earlier scalar approvals keep their dispatch contract",async t=>{
  const home=mkdtempSync(join(tmpdir(),"dash-drawing-range-"));
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  const filename=join(home,"runs.sqlite");
  const models=["lfm3-1.7b","gemma"].map((model):LocalCandidate=>({kind:"model",provider:"lmstudio",model,id:"lmstudio/"+model,loaded:true}));
  const objective="Write a two-sentence handoff for the incoming-quality shift lead. Give the disposition of sample S1 and cite the applicable drawing limit and reading. Identify the next action and say whether the shift note establishes that it was completed. Source: Active drawing B permits 9.97–10.03 mm inclusive. Superseded drawing A permitted 9.95–10.05 mm. Reading: 10.04 mm.";
  const metric="Drawing evidence accuracy";
  const criterion="Identify the correct drawing (B vs A) and state the permitted range for sample S1, and cite the actual reading.";
  const proposed=[{name:"limit_range",type:"number",nullable:true},{name:"reading",type:"number",nullable:false}];
  const prompts:ChatTurn[][]=[];
  const adapters:RuntimeAdapters={
    discover:async()=>[inventory(models)],
    invoke:async(candidate,messages,options)=>{
      if (options.planning) {
        const properties=planningSchema.parse(options.structured).properties;
        if (properties.audit) return reply(JSON.stringify(auditReply(messages)));
        if (properties.requirements) return reply(JSON.stringify({title:"Inspection handoff",metrics:[metric],requirements:["Cite the applicable drawing and reading in the handoff."]}));
        assert.doesNotMatch(JSON.stringify(messages),/Identify the correct drawing \(B vs A\)/);
        return reply(JSON.stringify({prompt:"Report limit_range as a single number.",reason:"A drawing supports the decision.",
          fields:proposed,inputs:[],fieldNotes:[{name:"limit_range",quote:"drawing limit",explanation:"Return one numeric value."}]}));
      }
      prompts.push(messages);
      return reply(JSON.stringify(candidate.model==="gemma" ? {limit_range_upper:10.03,reading:10.04} :
        {limit_range_lower:9.97,limit_range_upper:10.03,reading:10.04}));
    },
  };
  let bench=new Bench(filename,adapters,withoutPower);
  t.after(()=>bench.db.close());
  await bench.refresh();
  const request={mode:"quick",domain:"Manufacturing",objective,structuredOutput:true,measures:{metrics:[metric],criteria:[criterion]}};
  // A saved contract with one numeric limit must retain the original interpretation on read and approval replay.
  const oldDraft=await bench.designPrompt(request);
  const scalar=schemaFromFields(proposed);
  const oldReceipt={draftId:oldDraft.draftId,prompt:oldDraft.prompt,input:oldDraft.input,outputSchema:scalar};
  const original=bench.workflow.approve(oldReceipt);
  const receiptHash=()=>bench.db.prepare("SELECT approval_hash FROM outcome_prompts WHERE id=?").get(original.id)?.approval_hash;
  const oldHash=receiptHash();
  assert.ok(oldHash);
  bench.db.close();
  bench=new Bench(filename,adapters,withoutPower);
  await bench.refresh();
  assert.deepEqual(bench.workflow.approve(oldReceipt).outputSchema,scalar);
  const draft=await bench.designPrompt({...request,parentId:original.id});
  const schema=present(draft.outputSchema);
  assert.equal(draft.prompt,objective);
  assert.match(draft.promptRationale?.reason ?? "",/earlier numeric interval proposal/);
  assert.deepEqual(schema.required,["limit_range_lower","limit_range_upper","reading"]);
  assert.deepEqual(schema.properties.limit_range_lower.type,["number","null"]);
  assert.deepEqual(schema.properties.limit_range_upper.type,["number","null"]);
  assert.deepEqual(draft.schemaReview?.fields.map(f=>f.interval),["lower","upper",undefined]);
  assert.equal(draft.schemaReview?.fields[0].note,null);
  const approved=bench.workflow.approve({draftId:draft.draftId,prompt:draft.prompt,input:draft.input,outputSchema:schema});
  assert.equal(approved.version,original.version+1);
  const id=bench.start({mode:"quick",candidateIds:models.map(m=>m.id),approvedPromptId:approved.id,inspectionOnly:true});
  await present(bench.active).done;
  const run=bench.detail(id);
  for (const messages of prompts) {
    assert.deepEqual(messages,quickStructuredMessages(present(approved.input),schema));
    assert.doesNotMatch(JSON.stringify(messages),/Identify the correct drawing \(B vs A\)/);
  }
  assert.equal(prompts.length,2);
  assert.deepEqual(run.results.map(r=>r.structuredOutputCheck?.valid).sort(),[false,true]);
  assert.deepEqual(bench.workflow.get(original.id).outputSchema,scalar);
  assert.equal(receiptHash(),oldHash);
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
