import {test,type TestContext} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {Graders,type GraderEvidence} from "../lib/graders.cjs";
import {catalogRules} from "../lib/grader-catalog.cjs";
import {hash} from "../lib/packs.cjs";
import type {ApprovedPrompt} from "../lib/outcome-workflow.cjs";
import type {RuntimeAdapters,LocalCandidate} from "../lib/runtime-types.cjs";
import type {ScoredPack} from "../lib/run-types.cjs";
import {reply,present} from "./runtime-fixtures.cjs";

function setup(t:TestContext) {
  const db=new DatabaseSync(":memory:");
  t.after(()=>db.close());
  return {db,graders:new Graders(db)};
}
const financial={name:"Account routing",category:"Operations",industry:"Financial Services",type:"exact",criteria:"hold",threshold:1};
const synthetic:GraderEvidence={input:"Read a synthetic record",reference:null,output:"hold",finishReason:"stop"};
const offline:RuntimeAdapters={discover:async()=>[],invoke:async()=>assert.fail("Unexpected inference")};
const approved:ApprovedPrompt={id:"p",familyId:"family",version:1,mode:"quick",domain:"Financial Services",title:"Account routing",
  objective:"Check account routing",metrics:["Correct routing"],requirements:[],prompt:"Read the supplied record.",
  datasetId:null,packId:null,contractHash:null,inputCap:null,outputCap:null,designer:null};
const signal=()=>new AbortController().signal;

test("initializing the library repeatedly preserves shipped revisions and separates automatic checks from industry choices",async t=>{
  const {db,graders}=setup(t);
  const again=new Graders(db);
  assert.deepEqual(again.list(),graders.list());
  assert.equal(again.list().length,catalogRules.length);
  assert.deepEqual(again.automatic(false).map(g=>g.id).sort(),["dash/completion/v1","dash/response-present/v1"]);
  assert.deepEqual(again.automatic(true).map(g=>g.id).sort(),["dash/completion/v1","dash/json-valid/v1","dash/response-present/v1"]);
  const selection=graders.forDataset("Financial Services","earnings");
  assert.equal(selection.length,4);
  assert(selection.every(g=>g.library?.scenario==="earnings" && g.library.scope==="industry"));
  assert.deepEqual(graders.forDataset("Financial Services","other"),[]);
  assert.deepEqual(graders.quickOptions(approved,[]).available,[]);
  assert.deepEqual(graders.quickOptions(approved,[]).automatic,graders.automatic(false));
  for (const g of graders.automatic(false)) {
    const a=await graders.assess(g,synthetic,offline,signal());
    assert.equal(a.value,1);assert.equal(a.graderId,g.id);
  }
  const missing=await graders.assess(graders.get("dash/completion/v1"),{...synthetic,finishReason:null},offline,signal());
  assert.equal(missing.value,null);assert.equal(missing.pass,null);
});

test("deriving from a domain rule preserves its immutable implementation and permits a changed scoring method in a new customer revision",async t=>{
  const {graders}=setup(t);
  const source=graders.get("dash/earnings-amount/v1");
  const partial={intent:"derive",sourceGraderId:source.id,name:"Desk amount check"};
  const fork=graders.get(graders.save(partial,[]));
  assert.equal(graders.save(partial,[]),fork.id);
  assert.equal(fork.library?.scope,"customer");
  assert.equal(fork.library?.parentRevisionId,source.id);
  assert.notEqual(fork.library?.familyId,source.library?.familyId);
  assert(fork.type==="catalog");
  assert.equal(fork.ruleVersion,1);
  assert.equal(fork.ruleKey,"earnings-amount");
  assert.equal(fork.version,1);
  assert.throws(()=>graders.save({...partial,criteria:"Treat gross as net."},[]),/fixed scoring/);
  assert.throws(()=>graders.save({...partial,ruleKey:"earnings-review"},[]),/fixed scoring/);
  assert.throws(()=>graders.save({...partial,industry:"Manufacturing"},[]),/industry/);
  assert.throws(()=>graders.save({...partial,intent:"revise"},[]),/shipped/);
  assert.throws(()=>graders.save({...financial,type:"catalog",ruleKey:"earnings-amount",intent:"create"},[]),/fixed scoring/);
  assert.equal(graders.save({intent:"revise",sourceGraderId:fork.id},[]),fork.id);
  const next=graders.get(graders.save({intent:"revise",sourceGraderId:fork.id,type:"exact",criteria:"hold"},[]));
  assert.equal(next.version,2);
  assert.equal(next.library?.parentRevisionId,fork.id);
  assert.equal(next.library?.familyId,fork.library?.familyId);
  assert.equal(next.library?.scenario,"earnings");
  assert.equal(next.industry,"Financial Services");
  assert(next.type==="exact");
  assert.equal(graders.get(fork.id).type,"catalog");
  assert.equal((await graders.assess(next,synthetic,offline,signal())).pass,true);
  assert.throws(()=>graders.save({intent:"revise",sourceGraderId:fork.id,threshold:.7},[]),/newer revision/);
  const ids=graders.forDataset("Financial Services","earnings").map(g=>g.id);
  assert(ids.includes(next.id) && !ids.includes(fork.id));
  assert(graders.appliesToDataset(fork,"Financial Services","earnings"));
  assert.equal(graders.appliesToDataset(next,"Manufacturing","manufacturing"),false);
});

test("explicit create, fork and revision writes compose with outer rollbacks and keep same-name industry families independent",t=>{
  const {db,graders}=setup(t);
  const first=graders.get(graders.save({...financial,intent:"create"},[]));
  assert.equal(graders.save({...financial,intent:"create"},[]),first.id);
  const second=graders.get(graders.save({...financial,intent:"create",industry:"Manufacturing"},[]));
  assert.notEqual(first.library?.familyId,second.library?.familyId);
  db.exec("BEGIN IMMEDIATE");
  const rolled=graders.save({intent:"revise",sourceGraderId:first.id,criteria:"escalate"},[]);
  assert.throws(()=>graders.save({intent:"revise",sourceGraderId:first.id,criteria:"skip"},[]),/newer revision/);
  assert.equal(graders.get(rolled).version,2);
  db.exec("ROLLBACK");
  assert.throws(()=>graders.get(rolled),/Unknown grader/);
  const effective=graders.get(graders.save({intent:"revise",sourceGraderId:first.id,criteria:"release"},[]));
  assert.equal(effective.version,2);
  const options=graders.quickOptions(approved,[]);
  assert.deepEqual(options.available.map(g=>g.id),[effective.id,first.id]);
  assert.deepEqual(options.recommended.map(g=>g.id),[effective.id]);
  assert.equal(graders.resolveQuick(approved,[first],null,[])[0].id,first.id);
  assert.throws(()=>graders.resolveQuick(approved,[second],null,[]),/selected grader/);
});

test("pre-library customer snapshots keep their old IDs, support revisions, and can coexist with an identically named grader in another industry",t=>{
  const {db,graders}=setup(t);
  const data={...financial,judge:null};
  const id=hash(data);
  db.prepare("INSERT INTO graders VALUES(?,?,?,?)").run(id,"account routing",1,JSON.stringify({...data,id,version:1}));
  assert.equal(graders.get(id).library,undefined);
  const v2=graders.get(graders.save({intent:"revise",sourceGraderId:id,criteria:"escalate"},[]));
  assert.equal(v2.version,2);
  assert.equal(v2.library?.parentRevisionId,id);
  assert.equal(graders.get(id).criteria,"hold");
  const independent=graders.get(graders.save({...financial,industry:"Manufacturing"},[]));
  assert.equal(independent.version,1);
  assert.notEqual(independent.library?.familyId,v2.library?.familyId);
});

test("pinned local judges and standalone sample receipts omit private scenario rows while retaining the approved evidence",async t=>{
  const {graders}=setup(t);
  const judge:LocalCandidate={kind:"model",id:"synthetic-model",model:"synthetic-model",revision:"pinned-v1",provider:"lmstudio"};
  const grader=graders.get(graders.save({...financial,type:"judge",judgeId:judge.id,intent:"create"},[judge]));
  const pack:ScoredPack={id:"earnings",title:"test",description:"test",system:"NONDISCLOSED_PACK_MARKER",metrics:[],scorer:"earnings-record-v1",
    dataset:"fixture",version:"v1",datasetVersion:"v1",outputSchema:{type:"object"},checks:[],quotes:[],decimalFields:[],decisionField:"finding",accept:"accept",review:"review"};
  const evidence={...synthetic,caseContext:{pack,row:{case_id:"synthetic",gold:{private:"NONDISCLOSED_GOLD_MARKER"}}}};
  let calls=0;
  const adapters:RuntimeAdapters={discover:async()=>[],invoke:async(candidate,messages)=>{
    calls++;assert.equal(candidate.revision,judge.revision);
    assert(!JSON.stringify(messages).includes("NONDISCLOSED"));
    assert(JSON.stringify(messages).includes("synthetic record"));
    return reply(JSON.stringify({score:1,reason:"Matches evidence."}));
  }};
  const item=await graders.record(grader,evidence,{},adapters,signal());
  assert.equal(item.value,1);
  assert.equal(calls,1);
  assert(!JSON.stringify(item).includes("NONDISCLOSED"));
  assert.equal(present(graders.recent()[0].evidence).output,"hold");
  assert(!JSON.stringify(graders.recent()).includes("NONDISCLOSED"));
});
