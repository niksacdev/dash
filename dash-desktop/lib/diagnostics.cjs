// Summarize a saved run for inspection without modifying its original scores.
function classify(manifest, result) {
  if (result.error) return { stage: "Runtime error", note: result.error };
  if (manifest.mode === "quick")
    return { stage: "Response", note: "Prompt completed" };
  const text = result.output || "";
  try {
    JSON.parse(text);
  } catch {
    const fence = /^\s*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/i.exec(
      text,
    );
    if (fence) {
      try {
        const inner = JSON.parse(fence[1]);
        if (inner && typeof inner === "object" && !Array.isArray(inner))
          return {
            stage: "Output format",
            note: "Valid JSON object wrapped in a Markdown fence",
          };
      } catch {
        /* The enclosed text is also malformed. */
      }
    }
    return {
      stage: "Output format",
      note: "Response could not be parsed as JSON",
    };
  }
  if (!result.score) return { stage: "Unscored", note: "No saved score" };
  return result.score.pass
    ? { stage: "Passed", note: "Matched the recorded reference" }
    : { stage: "Grading", note: result.score.reasons.join(" · ") };
}
function diagnostics(run) {
  return {
    id: run.manifest.id,
    status: run.status,
    mode: run.manifest.mode,
    fixture: run.manifest.fixture,
    candidates: run.manifest.candidates.map((c) => ({
      id: c.id,
      model: c.model,
    })),
    traces: run.results.map((r, index) => ({
      index,
      traceId: r.trace.id,
      candidateId: r.candidateId,
      caseId: r.caseId,
      started: r.trace.started,
      finished: r.trace.finished,
      adapter:
        run.manifest.invocations?.find((i) => i.candidateId === r.candidateId)
          ?.adapter ?? null,
      telemetry: r.telemetry,
      finishReason: r.finishReason ?? null,
      ...classify(run.manifest, r),
    })),
  };
}
module.exports = { diagnostics };
