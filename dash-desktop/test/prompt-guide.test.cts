import {test} from "node:test";
import assert = require("node:assert/strict");
import type {RuntimeInventory} from "../lib/runtime-types.cjs";
import { PromptGuide } from "../lib/prompt-guide.cjs";

import {inventory as runtimeInventory,reply as inferenceReply} from "./runtime-fixtures.cjs";
const runtime=runtimeInventory([]);

test("guidance uses a loaded local model and leaves an arbitrary draft intact", async t => {
  const candidates = [
    {provider:"compatible", model:"hosted", loaded:true},
    {provider:"lmstudio", model:"on disk", loaded:false},
    {provider:"ollama", model:"local", loaded:true},
  ];
  const adapters = {
    discover: async () => [runtime],
  };
  // Simulate a runtime incorrectly advertising a hosted model alongside its local inventory.
  t.mock.method(adapters,"discover",async()=>[{...runtime,models:candidates}]);
  const guide = new PromptGuide({
    discover: adapters.discover,
    invoke: async (model,messages) => {
      assert.equal(model.model,"local");
      assert.deepEqual(JSON.parse(messages[1].content), {draft:"Summarize this note."});
      return inferenceReply('{"kind":"question","text":"Which note should be summarized?"}');
    },
  });
  const suggestion=await guide.suggest("Summarize this note.");
  assert.ok(suggestion.status==="ready");
  assert.equal(suggestion.kind,"question");
  candidates.pop();
  assert.equal((await guide.suggest("Summarize this note.")).status,"offline");
});
test("a canceled discovery cannot start a generation after GO", async () => {
  let complete:(value:RuntimeInventory[])=>void = () => assert.fail("Discovery was never started");
  const promise = new Promise<RuntimeInventory[]>(resolve=>{complete=resolve;});
  const guide = new PromptGuide({
    discover: () => promise,
    invoke: () => assert.fail("An obsolete request reached the runtime"),
  });
  const pending = guide.suggest("Compare these items.");
  guide.cancel();
  complete([{...runtime,models:[{id:"loaded",kind:"model",provider:"lmstudio",model:"loaded",loaded:true}]}]);
  assert.equal((await pending).status,"canceled");
});
