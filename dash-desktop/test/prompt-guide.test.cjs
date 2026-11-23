const test = require("node:test");
const assert = require("node:assert/strict");
const { PromptGuide } = require("../lib/prompt-guide.cjs");

test("guidance uses a loaded local model and leaves an arbitrary draft intact", async () => {
  const candidates = [
    {provider:"compatible", model:"hosted", loaded:true},
    {provider:"lmstudio", model:"on disk", loaded:false},
    {provider:"ollama", model:"local", loaded:true},
  ];
  const guide = new PromptGuide({
    discover: async () => [{models:candidates}],
    invoke: async (model,messages) => {
      assert.equal(model.model,"local");
      assert.deepEqual(JSON.parse(messages[1].content), {draft:"Summarize this note."});
      return {output:'{"kind":"question","text":"Which note should be summarized?"}'};
    },
  });
  assert.equal((await guide.suggest("Summarize this note.")).kind,"question");
  candidates.pop();
  assert.equal((await guide.suggest("Summarize this note.")).status,"offline");
});
test("a canceled discovery cannot start a generation after GO", async () => {
  let complete;
  const guide = new PromptGuide({
    discover: () => new Promise(resolve => {complete=resolve;}),
    invoke: () => assert.fail("An obsolete request reached the runtime"),
  });
  const pending = guide.suggest("Compare these items.");
  guide.cancel();
  complete([{models:[{provider:"lmstudio",loaded:true}]}]);
  assert.equal((await pending).status,"canceled");
});
