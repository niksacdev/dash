# 0031. Keep grader selection inside the active Quick evaluation

**Status** Accepted

## Operator decision

After approving a prompt, an operator needs to return from the grader library to the same two-model comparison with the selected grader attached. The current library action opens Dataset run. Quick compare puts optional saved graders and the approved task behind several similar disclosures. Its disabled GO button does not always say which action would enable it. An operator cannot easily tell which fields an AI proposed or exactly how the response schema reaches the candidates.

## Decision and evidence

Extend [use a saved grader](0024-use-a-saved-grader.md), [per-measure grading](0028-measure-grader-mapping.md) and [approved JSON contracts](0029-approved-json-contract.md). Preserve an approved Quick setup during ordinary navigation. Attach the exact compatible grader revision to this evaluation. Keep the prompt version, starting line and quality graders visible before dispatch. Show the operator the actual contract and the model responsible for drafting the schema. Use measured counts or indeterminate activity according to what the runtime can observe. See the [acceptance scenario](../reviews/outcome-workflow.md#finish-a-quick-evaluation-after-approving-the-prompt).

## Alternatives and trade-offs

Sending the operator to the existing stand-alone catalogue preserves browsing but loses the intended destination. Building another catalogue inside Quick compare would duplicate version selection and compatibility rules. A contextual catalogue reuses the same versions and returns to the approved prompt. Keep model identifiers and selections scoped to that draft. A short summary of the approved contract can sit beside setup without requiring the operator to read a JSON schema to choose models. Derive execution progress from stored responses and assessments. Model generation time varies, so show activity while waiting for a response.

The independent walkthrough reproduced two distinct failures. The library action always selected a dataset. Reopening the same prompt could clear its model lanes. The review also found that the scorer settings rendered ahead of the promised model picker. Verify the complete path in a fresh Electron profile, including a return without selecting a grader, before relying on an isolated component test.
