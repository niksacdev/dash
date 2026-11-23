import {isRecord} from "../lib/runtime-types.cjs";

type JudgeRequest =
  | {stage:"geval-steps";evidence?:undefined}
  | {stage:"geval-score";evidence:Record<string,unknown>};

export function judgeEvidence(text:string):Record<string,unknown> {
  const evidence:unknown=JSON.parse(text);
  if (!isRecord(evidence)) throw Error("Expected a G-Eval evidence object.");
  return evidence;
}

// Interpret the installed G-Eval SDK's two model requests at the transport boundary.
export function opikJudgeRequest(messages:unknown):JudgeRequest|null {
  if (!Array.isArray(messages)) return null;
  const last:unknown=messages.at(-1);
  const prompt=isRecord(last) ? last.content : undefined;
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
  return {stage:"geval-score", evidence:judgeEvidence(prompt.slice(start+begin.length,stop))};
}
