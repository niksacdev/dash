const { isDeepStrictEqual } = require("node:util");

const referencePack = {
  id: "reference", kind: "reference", title: "Prompt and reference evaluation",
  description: "Compare answers to versioned evaluation cases and SME guidance.",
  system: "", outputSchema: null, metrics: [], scorer: "Case reference or selected grader",
};

function nonempty(value) { return typeof value === "string" && !!value.trim(); }

function validateCase(row, pack) {
  for (const key of ["rubric", "sme_rationale"]) {
    if (row[key] != null && !nonempty(row[key])) throw Error(key + " must be nonempty text");
  }
  if (row.prompt !== undefined && !nonempty(row.prompt)) throw Error("prompt must be nonempty text");
  if (pack.kind !== "reference") {
    if (row.messages !== undefined) throw Error("Import chat messages using Prompt and reference evaluation");
    return;
  }
  if ((row.prompt !== undefined) === (row.messages !== undefined))
    throw Error("Provide either a prompt or a messages array ending with a user turn");
  if (row.messages !== undefined) {
    if (!Array.isArray(row.messages) || !row.messages.length || row.messages.at(-1)?.role !== "user")
      throw Error("messages must end with a user turn. Put the expected answer in reference");
    for (const [i,m] of row.messages.entries()) {
      if (!m || !["system","user","assistant"].includes(m.role) || !nonempty(m.content) ||
          (m.role === "system" && i !== 0)) throw Error("Invalid role or content in messages");
    }
    if (row.input != null) throw Error("Include case inputs in the chat messages");
  }
  if (typeof row.reference === "string" && !row.reference.trim()) throw Error("The reference answer is empty");
}

function caseMessages(manifest, row) {
  if (!manifest.pack) return [{role:"user", content:manifest.prompt}];
  const mapped = row.messages?.map(({role,content})=>({role,content}));
  if (manifest.pack.kind === "reference") {
    if (mapped) return mapped;
    const context = row.input == null ? "" : "\n\nCase input:\n" + (typeof row.input === "string" ? row.input : JSON.stringify(row.input));
    return [{role:"user", content:row.prompt + context}];
  }
  const source = JSON.stringify({input:row.input, source_locator:row.source_locator});
  return [
    {role:"system", content:manifest.effectiveSystem},
    {role:"user", content:row.prompt ? row.prompt + "\n\n" + source : source},
  ];
}

function graderEvidence(manifest, row, result) {
  return {
    input: manifest.pack ? caseMessages(manifest,row) : manifest.prompt,
    reference: row.reference ?? row.gold ?? null,
    ...(row.sme_rationale && {sme_rationale:row.sme_rationale}),
    ...(row.rubric && {rubric:row.rubric}),
    output:result.output, trajectory:result.trace.steps,
  };
}

function exactReference(row, text) {
  let actual = text.trim();
  if (typeof row.reference !== "string") {
    try { actual = JSON.parse(actual); } catch { return {pass:false,reasons:["Expected a JSON value matching the reference"]}; }
  }
  const expected = typeof row.reference === "string" ? row.reference.trim() : row.reference;
  const pass = isDeepStrictEqual(actual, expected);
  return {pass, reasons:pass ? [] : ["Answer differs from the case reference"]};
}

function caseJudgeSpec(judge) {
  if (!judge || !["lmstudio","ollama"].includes(judge.provider)) throw Error("Choose a connected local judge for the case references and rubrics.");
  const criteria = "Apply the case rubric to the candidate response. Use the SME reference and rationale as grading evidence. Accept equivalent wording unless the case explicitly calls for an exact format. Give 1 for complete fulfillment, partial credit for partially meeting the criteria, or 0 for a materially wrong answer. Cite the decisive case evidence.";
  const identity = {id:judge.id,model:judge.model,provider:judge.provider,revision:judge.revision ?? null, nativeChat:!!judge.nativeChat, reasoningOff:!!judge.reasoningOff};
  const spec = {name:"Case reference and rubric",type:"judge",category:"Dataset evaluation",version:1,criteria,threshold:0.8,judge:identity};
  return {...spec,id:"case-judge/"+require("./packs.cjs").hash(spec)};
}

module.exports = { caseJudgeSpec, referencePack, validateCase, caseMessages, graderEvidence, exactReference };
