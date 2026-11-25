// Only DASH-authored grading diagnostics may become part of an assessment receipt.
export class GradingIssue extends Error {}

export const missingExpectedAnswer = "No expected answer was supplied. This grader needs the correct answer or verified facts to compare with the model’s response.";

export class AssessmentStorageError extends Error {
  constructor(cause:unknown) {
    super("DASH could not save the grader assessment. Check available storage and access to the workspace.",{cause});
  }
}
