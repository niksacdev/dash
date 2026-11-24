// Only DASH-authored grading diagnostics may become part of an assessment receipt.
export class GradingIssue extends Error {}
export class AssessmentStorageError extends Error {
  constructor(cause:unknown) {
    super("DASH could not save the grader assessment. Check available storage and access to the workspace.",{cause});
  }
}
