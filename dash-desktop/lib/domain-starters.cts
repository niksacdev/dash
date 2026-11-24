import type {Domain} from "../agents/registry.cjs";

interface Starter {
  packId:string;domain:Domain;title:string;task:string;quickObjective:string;
}
function starter(packId:string,domain:Domain,title:string,task:string,sample:string):Starter {
  return {packId,domain,title,task,quickObjective:task+"\n\n"+sample};
}

// Renderer labels and main-process attribution share the same shipped examples.
// An edited or combined task does not inherit an example's domain.
export const domainStarters:readonly Starter[]=[
  starter("earnings","Financial Services","Review earnings disclosures",
    "Identify earnings figures that need analyst review. Cite the reported period and basis for each figure and flag missing evidence.",
    "Synthetic release excerpt: For the quarter ended June 30, diluted GAAP EPS was $0.74. Adjusted diluted EPS was $0.85. The release provides no reconciliation."),
  starter("manufacturing","Manufacturing","Inspect a supplier lot",
    "Help receiving inspection decide which supplier lots need review using the measurement, tolerance and drawing revision in each record.",
    "Synthetic inspection record: Lot K7, shaft diameter. Active drawing B specifies 10.00 ± 0.03 mm. Reading: 10.04 mm. The receiving rule accepts only readings within the stated limits."),
];
