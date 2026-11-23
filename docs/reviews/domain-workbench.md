# DASH domain workbench · product review

**Decision for review.** Make the scenario the unit a practitioner can run and trust. A domain organizes related decisions, terminology, reference tools and data sources. Each scenario defines one decision, what a wrong answer costs, and the evidence required for acceptance. A run records what happened when a particular model or agent attempted it.

The current workbench asks the user to choose Quick Compare or Dataset Run before it knows their job. The earnings pack already has the stronger opening question: can an analyst trust this extracted fact, and what must go to review? Put that question on the first screen. The large DASH mark, race, two entrant slots and GO control belong to the comparison step. Reserve the largest area of the domain landing page for the scenarios someone can try.

## Walk through two decisions

| | Financial Services · earnings release capture | Manufacturing · incoming inspection triage |
| --- | --- | --- |
| User and decision | An analyst decides whether an extracted fact has enough source evidence to enter a reviewable earnings record. | A quality engineer decides which incoming lot needs a hold, new measurement or further review. The engineer owns disposition. |
| Starter task | Extract diluted GAAP EPS, fiscal period and the supporting quote from a supplied release. | Compare a measured dimension with the correct revision of the part specification and explain the proposed routing. |
| Revealing case | The release contains GAAP EPS of 0.74 and adjusted EPS of 0.85. A polished answer citing the adjusted figure fails the basis check. | A synthetic measurement is 10.04 mm. Revision B allows 10.00 ± 0.03 mm. Using obsolete revision A, which allowed ± 0.05 mm, would clear the lot incorrectly. |
| Context and tools | Start with supplied release text and a source locator. A later filing lookup is optional and its result must identify the document revision. | Start with a local part and revision lookup backed by a small synthetic table. Record the revision returned. A live quality-management connection can implement the same lookup later. |
| Hard checks | Exact normalized value, GAAP basis, period, quote and correct routing. | Part identity, revision, units, tolerance arithmetic and routing of out-of-tolerance cases. |
| Judgment | A reusable rubric can score whether the analyst explanation identifies a genuine source conflict and cites both sources. | A reusable rubric can score whether the explanation identifies the discrepancy and gives the reviewer sufficient evidence. |
| Outcome | Correctly accepted facts, incorrect proposed accepts and analyst review load. | Missed holds, unnecessary holds and cases correctly escalated with evidence. |

The first column builds on the existing eight synthetic development cases. The second is a proposed starter scenario. Automotive and Robotics belong in the roadmap until they have a domain owner, runnable cases and reviewed acceptance criteria. Both examples concern inference on saved inputs. No training pipeline is needed.

## What the practitioner sees

1. **Domains → Scenarios → Runs.** Open Financial Services or Manufacturing and see the decisions available to test. Each scenario opens with its question, one representative input, the expected output shape, the available tools and the checks that determine success. Display the latest comparable run underneath the decision.
2. **Try one case.** Preload an editable prompt and a model-visible JSON example. Put the two selected candidates on the starting line and use GO to run the same case. Keep gold answers out of candidate inputs. Let users save an exploratory run to a scenario deliberately. Keep earlier unclassified runs accessible in history.
3. **Evaluate a dataset.** Offer the bundled development set, a user-supplied JSONL version, or dataset discovery. Show which failure modes the cases cover and which remain untested. Display the scenario’s default graders and allow additional reusable versions. A saved-answer demonstration can explicitly show a good case and a deliberately bad one before the user runs a model.
4. **Inspect the decision.** Lead with missed critical cases, review burden and the number of cases evaluated. A click reveals input evidence, output, tool calls and their results, deterministic checks and judge rationale. Show latency, tokens, observed whole-device watts and the information available about cost in a secondary panel.

## Shared assets, scoped runs

**Dataset families.** Give each version an industry, scenario mapping, source and license, split, parent, change note and content identifier. The same family may serve two scenarios if someone maps its inputs and labels to both. A newer version might add supplier revisions or fix an incorrect answer key. Explain that difference before offering a trend. Compare models on identical cases and grader versions. To study the effect of a tool, change that tool alone and rerun both configurations on the same cases.

**Dataset discovery.** Start from a gap such as “find inspection records with measured dimensions, revision identifiers and reviewed dispositions.” Search published catalogs, inspect dataset cards, schemas and sample rows, then return the evidence for fit, missing labels, license, revision, size and provenance. A set of surface-defect photos could suit visual defect detection and still lack the revision or disposition needed for this scenario. Show that limitation. The user chooses what to download locally, maps the fields, reviews examples and promotes a version into their catalog. Preserve the original download alongside its provenance. Their own JSONL takes the same validation path.

**Tools.** Each scenario declares which read-only tools are available, the expected inputs and evidence returned. Ship the starter with a local fixture so an end user can reach a result immediately. Allow a real connector to replace that fixture explicitly. Pin its configuration or source snapshot, record its calls, and keep the candidate and grader permissions separate.

**Graders.** Workspace owns a reusable, categorized, versioned library. Scenarios compose rules for facts and routing, rubrics for judgment and checks for agent tool use. Show one accepted and one rejected example for each published grader. A user can calibrate a judge against those examples and see disagreements. A persuasive explanation cannot rescue an incorrect GAAP figure or an obsolete drawing revision. A judge failure is unscored, and a changed rubric creates a new assessment linked to the original output. Persist the rubric, judge model, cutoff, rationale and evidence. Optional Opik adapters may supply a metric or a trace destination. DASH owns the scenario policy, local history and result presentation.

## What would justify shipping the domain workbench?

| Review question | Evidence |
| --- | --- |
| Can a first-time practitioner run a credible test? | From either launched domain, reach a scored example using bundled assets and a connected local model without authoring a prompt, schema or rubric first. |
| Can they explain a failure? | In Financial Services, show the original quote and GAAP mismatch. In Manufacturing, show the revision lookup, measured value, upper limit and missed hold. |
| Can they trust the comparison? | Both candidates receive the same inputs and allowed tools. The report identifies the dataset, case set, rubric versions and number scored. A critical miss remains visible even if the average score is high. |
| Can a second scenario reuse the work? | Reuse an existing dataset family, tool or grader by version. The run remains attributable to the scenario that executed it. |
| Does DASH stand on its own? | Complete each starter workflow, reopen a failed case, compare a baseline and export the evidence with Opik disconnected. |

**Release sequence.** First demonstrate the complete earnings decision in the domain workbench. Then implement the manufacturing decision using the same scenario contract. That second walkthrough is the architecture review: it should require domain assets and policies, with no finance-specific branching in the runner or results screen. Prioritize discovery breadth and live enterprise connectors after both walkthroughs pass.
