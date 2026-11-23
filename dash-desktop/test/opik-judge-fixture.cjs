// Interpret the installed G-Eval SDK's two model requests at the transport boundary.
function opikJudgeRequest(messages) {
  const prompt = messages?.at(-1)?.content;
  if (typeof prompt !== "string") return null;
  if (prompt.startsWith("*** TASK:\n") && prompt.includes("evaluation criteria")) {
    return {stage:"geval-steps"};
  }
  if (!prompt.startsWith("*** TASK INTRODUCTION:\n")) return null;
  const begin = "\n\n*** INPUT:\n";
  const end = "\n\n*** OUTPUT:\n";
  const start = prompt.lastIndexOf(begin);
  const stop = prompt.lastIndexOf(end);
  if (start < 0 || stop < start) throw Error("G-Eval request is missing its case evidence.");
  return {stage:"geval-score", evidence:JSON.parse(prompt.slice(start + begin.length, stop))};
}

module.exports = {opikJudgeRequest};
