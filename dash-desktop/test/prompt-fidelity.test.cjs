const { test } = require("node:test");
const assert = require("node:assert/strict");
const { candidateGuidance } = require("../lib/prompt-fidelity.cjs");

const objective = "Extract the part ID and decide whether to hold this lot. Sample: part B-71 measures 5.04 mm against a 5.02 mm upper limit.";
const safe = "Identify the part in the supplied inspection record.";

test("candidate guidance keeps the task and drops added tolerances, assumptions and grader metrics", () => {
  const generated = [safe,
    "Use a tolerance of ±0.01 mm (implied).",
    "Assume standard practice to decide whether to release the lot.",
    "Compute missed out-of-limit findings and the pass rate across cases.",
    "Do not assume an undocumented tolerance.",
  ].join(" ");
  const result = candidateGuidance(generated,{objective});
  assert.equal(result.text, safe+" Do not assume an undocumented tolerance.");
  assert.equal(result.omitted,3);
  assert.deepEqual(result.reasons, ["an assumed decision rule","cross-case grading instructions"]);
});

test("an operator's stated numerical and aggregate directions can be preserved verbatim", () => {
  const allowed = "Use a tolerance of ±0.01 mm. Compute the pass rate across cases.";
  assert.deepEqual(candidateGuidance(allowed,{objective:allowed}), {text:allowed,omitted:0,reasons:[]});
  assert.equal(candidateGuidance(safe+" Use a tolerance of ±0.01 mm.",{
    objective:"Never use a tolerance of ±0.01 mm.",
  }).text,safe);
});

test("changing units or swapping a reading and its limit cannot create an approved rule", () => {
  const output = safe+" Compare the reading of 5.02 mm to the 5.04 mm limit. Discard readings in inches. Apply the typical boundary convention.";
  const result = candidateGuidance(output,{objective});
  assert.equal(result.text,safe);
  assert.equal(result.omitted,3);
  assert.throws(()=>candidateGuidance("Use an implied tolerance of ±0.01 mm.",{objective}), /unsupported rules/);
});

test("an unstated external standard or uncertainty rule cannot become mandatory", () => {
  const output = safe+" Apply NIST guidance before finalizing. Flag the case if uncertainty treatment is missing. The lot passes unless stated otherwise.";
  assert.equal(candidateGuidance(output,{objective}).text,safe);
});

test("the real local draft keeps the case instructions and loses internal planning narration", () => {
  const captured = 'You are given a case titled "Lot Hold Decision for Receiving Inspection". In the expert brief, the objective is to extract the part ID and decide whether to hold this lot based on a sample measurement. The proposed disposition is supported by the supplied measurement and its stated limit), requirements (The proposed disposition is supported by the supplied measurement and its stated limit). In the case data you must locate the part ID, the measured value for the sample, and the upper limit against which it is compared.';
  const result = candidateGuidance(captured,{objective,domain:"Manufacturing"});
  assert.match(result.text,/locate the part ID/);
  assert.match(result.text,/Cite the supplied measurement/);
  assert.doesNotMatch(result.text, /expert brief|case titled|requirements/);
  assert.equal(result.omitted,3);
});
