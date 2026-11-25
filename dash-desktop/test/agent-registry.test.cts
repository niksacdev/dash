import {auditReply} from "./audit-fixture.cjs";
import { test, type TestContext } from "node:test";
import assert = require("node:assert/strict");
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {z} from "zod";
import {PlannerSettings} from "../lib/planner-settings.cjs";
import type {PlannerAdapters} from "../lib/planner-routing.cjs";

import {inventory as runtimeInventory,reply as inferenceReply} from "./runtime-fixtures.cjs";
const runtime=runtimeInventory([]);

test("local planning requires an explicit saved opt-in before using available OpenAI credentials",t=>{

  const db=new DatabaseSync(":memory:");
  t.after(()=>db.close());
  const endpoint={id:"hosted-model",model:"configured-test",endpoint:"https://api.openai.com/v1"};
  const endpoints={list:()=>[endpoint],keys:new Map([[endpoint.id,"FAKE_ENDPOINT_KEY"]])};
  const env={OPENAI_API_KEY:"FAKE_ENV_KEY"};
  const settings=new PlannerSettings(db,endpoints,env);
  assert.deepEqual(settings.status(),{enabled:false,hasKey:true,model:"configured-test"});
  assert.equal(settings.fallback(),null);
  assert.equal(new PlannerSettings(db,endpoints,{}).fallback(),null);
  settings.save({model:"configured-test",enabled:true});
  assert.deepEqual(new PlannerSettings(db,endpoints,env).fallback(),{model:"configured-test",apiKey:"FAKE_ENV_KEY"});
  settings.save({model:"configured-test",enabled:false});
  assert.equal(new PlannerSettings(db,endpoints,env).fallback(),null);
});

import { bundledAgents,readAgentRegistry } from "../agents/registry.cjs";
import { OutcomeWorkflow } from "../lib/outcome-workflow.cjs";

function setup(t:TestContext) {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),"dash-agent-upgrade-"));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const assets=path.join(folder,"agents");
  fs.cpSync(path.join(__dirname,"../agents"),assets,{recursive:true});
  const manifestFile=path.join(assets,"manifest.json");
  const entry=z.object({id:z.string(),path:z.string(),version:z.number().int()}).passthrough();
  const manifest=z.object({schemaVersion:z.literal(1),agents:z.array(entry)}).parse(JSON.parse(fs.readFileSync(manifestFile,"utf8")));
  const db=new DatabaseSync(path.join(folder,"workbench.sqlite"));
  t.after(()=>db.close());
  const offline:PlannerAdapters={discover:async()=>[],invoke:async()=>assert.fail("No inference expected during an upgrade")};
  const work=()=>new OutcomeWorkflow(db,offline, {},readAgentRegistry(assets));
  return {db,work,manifest,manifestFile,assets};
}

test("updating bundled experts appends untouched defaults and preserves local role overrides and historical rows", t=>{
  const {db,work,manifest,manifestFile,assets}=setup(t);
  db.exec("CREATE TABLE outcome_agent_roles(domain TEXT, role TEXT, version INTEGER, spec TEXT, PRIMARY KEY(domain,role,version))");
  const old=bundledAgents.get("manufacturing-expert");
  assert.ok(old.domain && old.role && old.legacyHash);
  const historic=JSON.stringify({domain:old.domain,role:old.role,instructions:old.instructions,sources:old.sources,version:1,hash:old.legacyHash});
  db.prepare("INSERT INTO outcome_agent_roles VALUES(?,?,?,?)").run(old.domain,old.role,1,historic);
  const previous=work();
  const first=previous.roles().find(r=>r.domain==="Manufacturing" && r.role==="expert");
  assert.ok(first?.bundle);
  assert.equal(first.version,1);
  assert.equal(first.bundle.id,"manufacturing-expert");
  const local=previous.saveRole({domain:"Financial Services",role:"expert",expectedVersion:1,instructions:"Apply local accounting policy."});
  for (const id of ["financial-services-expert","manufacturing-expert"]) {
    const profile=manifest.agents.find(a=>a.id===id);
    assert.ok(profile);
    profile.version++;
    fs.appendFileSync(path.join(assets,profile.path),"Review the supplied exception.\n");
  }
  fs.writeFileSync(manifestFile,JSON.stringify(manifest));
  const revised=work().roles();
  const upgraded=revised.find(r=>r.domain==="Manufacturing" && r.role==="expert");
  assert.ok(upgraded?.bundle);
  assert.equal(upgraded.version,2);
  assert.equal(upgraded.bundle.version,2);
  assert.notEqual(upgraded.bundle.hash,first.bundle.hash);
  assert.match(upgraded.instructions,/supplied exception/);
  assert.deepEqual(revised.find(r=>r.domain==="Financial Services" && r.role==="expert"),local);
  assert.equal(db.prepare("SELECT spec FROM outcome_agent_roles WHERE domain=? AND role=? AND version=1").get(old.domain,old.role)?.spec,historic);
  assert.deepEqual(work().roles(),revised);
  fs.appendFileSync(path.join(assets,old.path),"Unversioned revision.\n");
  assert.throws(work,/Increment the bundled version/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM outcome_agent_roles WHERE domain=? AND role=?").get(old.domain,old.role)?.count,2);
});

test("the manifest rejects duplicate or external prompt files before a role can be dispatched", t=>{
  const {manifest,manifestFile,assets}=setup(t);
  const original=manifest.agents[0];
  manifest.agents.push(original);
  fs.writeFileSync(manifestFile,JSON.stringify(manifest));
  assert.throws(()=>readAgentRegistry(assets),/duplicate agent/);
  manifest.agents.pop();
  original.path="../secrets";
  fs.writeFileSync(manifestFile,JSON.stringify(manifest));
  assert.throws(()=>readAgentRegistry(assets),/Markdown path/);
});

test("changing shared grading guidance revises only its consumers and rejects an external guide",t=>{
  const {assets,manifest,manifestFile}=setup(t);
  const registry=readAgentRegistry(assets);
  const file="prompts/grading-evidence-v1.md";
  const consumers=manifest.agents.filter(entry=>entry.guidance===file);
  assert.deepEqual(consumers.map(a=>a.id).sort(),["grader-designer","report-analyzer","report-reporter","workflow-expert","workflow-metric-auditor"]);
  fs.appendFileSync(path.join(assets,file),"\nSynthetic revision to the shared evidence policy.\n");
  const updated=readAgentRegistry(assets);
  for(const entry of manifest.agents){
    const before=registry.get(entry.id),after=updated.get(entry.id);
    if(entry.guidance===file){
      assert.notEqual(before.hash,after.hash);
      assert.ok(after.instructions.endsWith("Synthetic revision to the shared evidence policy."));
    }else assert.equal(before.hash,after.hash);
  }
  consumers[0].guidance="../outside.md";
  fs.writeFileSync(manifestFile,JSON.stringify(manifest));
  assert.throws(()=>readAgentRegistry(assets),/Markdown path/);
});

test("the dispatched domain prompt and approved plan pin the deployed Markdown version",async t=>{
  const {db,manifest,manifestFile,assets}=setup(t);
  const calls:string[]=[];
  const adapters:PlannerAdapters={
    discover:async()=>[{...runtime,models:[{kind:"model",id:"lfm3-test",provider:"lmstudio",model:"lfm3-test",loaded:true}]}],
    async invoke(model,messages,{structured}) {
      calls.push(messages[0].content);
      const fields=z.object({properties:z.record(z.string(),z.unknown())}).parse(structured);
      if(fields.properties.audit) return inferenceReply(JSON.stringify(auditReply(messages)));
      const reply=fields.properties.requirements
        ? {title:"Inspected revision",metrics:["Correct drawing revisions per cited revision"],requirements:["Cite the drawing revision."]}
        : {prompt:"Cite the supplied drawing revision."};
      return inferenceReply(JSON.stringify(reply));
    },
  };
  const request={mode:"quick",domain:"Manufacturing",objective:"Inspect the sample and cite the drawing revision."};
  const open=()=>new OutcomeWorkflow(db,adapters,{},readAgentRegistry(assets));
  const initial=open(), first=await initial.design(request);
  const saved=initial.approve({draftId:first.draftId,prompt:first.prompt});
  const release=manifest.agents.find(a=>a.id==="manufacturing-expert");
  assert.ok(release);
  const next=fs.readFileSync(path.join(assets,release.path),"utf8")+"Record the supplied evidence locator.\n";
  fs.writeFileSync(path.join(assets,release.path),next);
  release.version=2;
  fs.writeFileSync(manifestFile,JSON.stringify(manifest));
  const after=open(), draft=await after.design(request);
  assert.ok(calls[3].includes(next.trim()));
  assert.equal(draft.agents?.find(r=>r.role==="expert")?.bundle?.version,2);
  assert.deepEqual(draft.workflowAgents?.map(a=>a.id),["workflow-expert","workflow-expert-assignment","workflow-metric-auditor","workflow-implementer","workflow-implementer-assignment"]);
  assert.deepEqual(after.get(saved.id),saved);
  assert.equal(saved.agents?.find(r=>r.role==="expert")?.bundle?.version,1);
});
