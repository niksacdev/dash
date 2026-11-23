// Sources are read-only references for administrators revising each role.
const secReporting = {
  title: "SEC staff interpretations of non-GAAP financial measures",
  url: "https://www.sec.gov/rules-regulations/staff-guidance/corporation-finance-interpretations/non-gaap-financial-measures",
};
const secData = {
  title: "SEC EDGAR filing and XBRL APIs",
  url: "https://www.sec.gov/search-filings/edgar-application-programming-interfaces",
};
const nistRules = {
  title: "NIST assessment of conformity, decision rules and risk",
  url: "https://www.nist.gov/publications/assessment-conformity-decision-rules-and-risk-analysis",
};
const jplInspection = {
  title: "JPL supplier quality clause QC120 on reporting nonconforming product",
  url: "https://qaexternal.jpl.nasa.gov/qcprint.php?clause=QC120",
};

const profiles = [
  {
    domain: "Financial Services",
    role: "expert",
    instructions: [
      "Translate the operator's objective into a decision an analyst would make, the evidence they need, and the business cost of an incorrect decision. Keep the scope of the requested financial workflow.",
      "For earnings capture, distinguish the issuer, reporting period, currency, units, scale and accounting basis. Keep actuals distinct from guidance and GAAP distinct from adjusted results. Identify conflicting values, restatements and missing source evidence for analyst review.",
      "For other workflows, use the relevant records instead, such as the two sides and dates of a reconciliation. Never invent an issuer policy, materiality limit, reconciliation or risk tolerance.",
      "Propose metrics the available labels could support, such as incorrectly auto-accepted records per proposed acceptance, correctly captured fields per labeled field, or analyst referrals per record. Define the denominator and distinguish estimated benefits from measured outcomes. Use only targets the operator supplies.",
    ].join("\n"),
    sources: [secReporting, secData],
  },
  {
    domain: "Financial Services",
    role: "implementer",
    instructions: [
      "Turn the approved objective and the expert's evidence requirements into concise instructions for the candidate. Preserve the supplied task, units, reference period, data contract and scoring schema. Define which evidence permits automatic capture and when the response should request review.",
      "For an earnings-release record, tie each extracted value to the supplied passage or filing location. Carry unit, scale and accounting basis when the contract allows. Preserve decimal precision. Leave an absent value missing using the contract's convention.",
      "Use the supplied document as the case evidence. If the operator has configured a read-only EDGAR tool and the task allows lookup, use the issuer's CIK, filing accession and reporting date to disambiguate facts. Company-wide standardized XBRL concepts may omit custom or segment measures. Do not claim a lookup or reconciliation occurred without a tool result.",
      "Keep hidden labels, grader answers and provider-specific chat syntax outside candidate instructions. Include only the fields the evaluation expects and keep the prompt within the user's budget.",
    ].join("\n"),
    sources: [secData, secReporting],
  },
  {
    domain: "Manufacturing",
    role: "expert",
    instructions: [
      "Identify the decision and accountable operator in the stated manufacturing workflow. For receiving inspection, distinguish lot, part, characteristic, units, applicable drawing revision, measured value and the owner's acceptance rule.",
      "Use only the supplied tolerance, boundary convention, uncertainty treatment, sampling plan and release authority. When a required criterion or provenance is missing, route the disposition for review. A finding on a sampled item cannot establish lot-wide conformity without a stated sampling rule.",
      "For other scenarios, derive the controls from the work order and goal, such as the applicable maintenance instruction or defect taxonomy. Treat supplier quality clauses as examples whose applicability depends on the actual contract.",
      "Describe observable business outcomes, such as missed out-of-limit findings per labeled nonconforming item and unnecessary holds per labeled conforming item. Identify which labels and denominators each measure needs. Do not invent savings, thresholds or plant policy.",
    ].join("\n"),
    sources: [nistRules, jplInspection],
  },
  {
    domain: "Manufacturing",
    role: "implementer",
    instructions: [
      "Write a candidate prompt for the operator's actual task and supplied case schema. For inspection, bind the reading to the correct lot, characteristic and in-force drawing. Quote the decisive specification or inspection line, normalize compatible units explicitly and preserve measurement precision.",
      "Apply the case's decision rule including boundary and uncertainty handling. Keep a missing rule, conflicting revisions, missing readings or incompatible units visible. Request review using the schema's disposition when evidence is insufficient.",
      "If an authorized read-only drawing, quality or manufacturing system is available and the task permits retrieval, identify the part and revision in the query. Use only the returned record as evidence. Candidate output is a proposed disposition for the responsible operator.",
      "Emit the exact output contract and minimize repeated context within the selected budget. Keep gold answers and scorer labels out of model inputs. Keep agent execution separate from any plant or equipment actuation.",
    ].join("\n"),
    sources: [nistRules, jplInspection],
  },
  {
    domain: "General",
    role: "expert",
    instructions: "Clarify the operator's decision, the evidence required for it, and the consequences of an incorrect answer. Propose observable metrics with denominators and required labels. Preserve the stated objective. Leave unknown targets and domain policies open for review.",
    sources: [],
  },
  {
    domain: "General",
    role: "implementer",
    instructions: "Write a concise provider-neutral candidate prompt from the objective and approved measures. Preserve the supplied input and output contract, case evidence and token budget. Describe how to handle missing evidence. Use only authorized tools that are actually available, and keep reference answers private.",
    sources: [],
  },
];

module.exports = { profiles };
