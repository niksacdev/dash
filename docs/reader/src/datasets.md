# Import and version cases

Use **Workspace → Datasets** when you have examples of the decisions your team wants to test. **Prompt and reference evaluation** accepts questions or conversations you wrote yourself. The bundled industry scenarios use their own structured schemas.

## Try a two-case Manufacturing dataset

[Download the synthetic bearing inspection JSONL](bearing-inspection.jsonl). Save the linked file with the `.jsonl` extension. Both cases use the same upper limit. One exceeds it and should produce `HOLD`; the other sits on the limit and should produce `RELEASE`.

```json
{{#include bearing-inspection.jsonl:1}}
```

1. Under **Scenario for import**, select **Prompt and reference evaluation**, then **Upload JSONL** and open the downloaded file.
2. In **Catalog this version**, choose **Manufacturing** as the industry, use **Bearing inspection** for the dataset family, and enter **Incoming quality** as the category. You can tag it `synthetic`. The preview should show two cases, version `1`, and split `development`.
3. Select **Save dataset version**. Open the snapshot to inspect its case inputs and held-out references.
4. In **Dataset run**, select this snapshot and **Match the reference exactly**. Choose a candidate and **GO**. A literal `HOLD` passes the first case. A wrong disposition fails even if its explanation sounds convincing.

## Build a later version

Give every row a unique `case_id` within the snapshot. All rows share a `dataset_version` and `split`. Each case carries either `prompt` or `messages` ending with a user turn. The candidate sees that request. Fields such as `reference`, `rubric` and `sme_rationale` supply held-out evidence for grading.

When you add a case, set every row’s `dataset_version` to `2`. Import into the same industry, scenario and family, choose version 1 under **Parent version**, and describe **What changed?**. The older snapshot stays available for reproducing prior runs.

A grader that checks factual correctness against a known answer needs that evidence for every case it will score. In a prompt dataset, put the correct result in each row’s `reference` field. Scenario packs use their labeled fields. Check coverage in run setup. For a JSON-field grader, each row needs the particular expected field named in the rule. For example, a grader comparing reported EPS needs the path `reported.eps` in that row. For exact matching, `[]` is a valid expected answer to “List the defects.” If rows lack the required evidence, import a new snapshot with the missing facts or choose a suitable task-and-answer grader.

For input-only cases, [choose a saved grader](graders.md) that can evaluate the response without a reference. For structured imports, use the corresponding [scenario pack](https://github.com/niksacdev/dash/tree/main/dash-desktop/packs) as the schema example.
