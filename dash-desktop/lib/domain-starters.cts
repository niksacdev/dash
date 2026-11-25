import type {Domain} from "../agents/registry.cjs";

interface Starter {
  packId:string;domain:Domain;title:string;task:string;quickObjective:string;
}

// The approved source for the published example also feeds its local disposition grader.
export const starterInspectionV1={lot:"K7",sample:"S1",active:"B",previous:"A",lower_mm:"9.97",upper_mm:"10.03",measured_mm:"10.04",
  rule:"inclusive_limits",required_action:"signed_recheck",recheck_complete:false} as const;

// Keep this source revision available when a later starter supersedes it. Saved grades
// and saved-answer reviews can then establish exactly which task the candidate saw.
export const inspectionHandoffObjectiveV1=[
      "Write a two-sentence handoff for the incoming-quality shift lead. Give the disposition of sample S1 and cite the applicable drawing limit and reading. Identify the next action and say whether the shift note establishes that it was completed.",
      `Synthetic inspection record: Lot ${starterInspectionV1.lot}, shaft sample ${starterInspectionV1.sample}. Active drawing ${starterInspectionV1.active} permits ${starterInspectionV1.lower_mm}–${starterInspectionV1.upper_mm} mm inclusive. Superseded drawing ${starterInspectionV1.previous} permitted 9.95–10.05 mm. Reading: ${starterInspectionV1.measured_mm} mm.`,
      "Receiving rule: Accept an in-limit sample. Send an out-of-limit sample to Quality for a signed recheck. Shift note: “Recheck after changeover.” The record contains no signed recheck.",
    ].join("\n\n");

// Dataset objectives apply to each row under its existing scenario contract.
// Quick objectives include one synthetic record the candidate can actually inspect.
export const domainStarters:readonly Starter[]=[
  {
    packId:"earnings",domain:"Financial Services",title:"Brief an earnings analyst",
    task:"Extract the requested financial fact for each case. Cite its period, accounting basis and source, and route uncertain figures for analyst review using the scenario contract.",
    quickObjective:[
      "Write a two-sentence handoff for the analyst covering Q2. Cite the release when reporting GAAP and adjusted diluted EPS. Explain what management’s remark establishes about the difference and what evidence the analyst still needs.",
      "Synthetic release excerpt: Q2 results, note 3 — diluted GAAP EPS was $0.74 and adjusted diluted EPS was $0.85. This excerpt contains no reconciliation.",
      "Synthetic earnings call: The CFO said, “Freight was a headwind this quarter.” The CFO did not quantify its effect on EPS.",
    ].join("\n\n"),
  },
  {
    packId:"manufacturing",domain:"Manufacturing",title:"Prepare a quality handoff",
    task:"For each sampled dimension, cite the active drawing and recorded reading, apply the supplied decision rule, and route the sample using the scenario’s output fields.",
    quickObjective:inspectionHandoffObjectiveV1,
  },
];

// Original unedited Quick objectives retain their source when an operator revises them.
const previousQuickExamples=new Map<string,string>([
  ["Identify earnings figures that need analyst review. Cite the reported period and basis for each figure and flag missing evidence.\n\nSynthetic release excerpt: For the quarter ended June 30, diluted GAAP EPS was $0.74. Adjusted diluted EPS was $0.85. The release provides no reconciliation.","earnings"],
  ["Help receiving inspection decide which supplier lots need review using the measurement, tolerance and drawing revision in each record.\n\nSynthetic inspection record: Lot K7, shaft diameter. Active drawing B specifies 10.00 ± 0.03 mm. Reading: 10.04 mm. The receiving rule accepts only readings within the stated limits.","manufacturing"],
]);

export function quickStarterFor(objective:string):Starter|undefined {
  const previous=previousQuickExamples.get(objective);
  return domainStarters.find(s=>s.quickObjective===objective || s.packId===previous);
}
