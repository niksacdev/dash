import { RegexMatch, IsJson, z } from "opik";
import { grade, packField, packDecimal } from "./packs.cjs";
import { isRecord } from "./run-types.cjs";
import type { ScoredPack } from "./run-types.cjs";
import type { GraderEvidence } from "./grader-types.cjs";

import {inspectionRuleKey,scoreInspectionDecision,inspectionRangeKey,scoreInspectionRange} from "./inspection-decision.cjs";

type Scenario = "earnings" | "manufacturing";
export interface CatalogRule {
  key:string;
  version:number;
  scope:"general"|"industry";
  industry:string;
  name:string;
  category:string;
  criteria:string;
  scenario?:Scenario;
  automatic?:boolean;
}
interface ScenarioRule extends CatalogRule {
  scenario:Scenario;
  fields:readonly string[];
}
interface RuleScore { value:number|null; reason:string; evaluator:string }

function general(key:string, name:string, criteria:string):CatalogRule {
  return {key, version:1, scope:"general", industry:"General", name, category:"Response diagnostics", criteria, automatic:true};
}
function industry(scenario:Scenario, key:string, name:string, criteria:string, fields:string[]):ScenarioRule {
  return {key, version:1, scope:"industry", industry:scenario==="earnings" ? "Financial Services" : "Manufacturing",
    name, category:scenario==="earnings" ? "Earnings release capture" : "Incoming inspection",
    criteria, scenario, fields};
}
const diagnostics = [
  general("response-present", "Response present", "Check whether the returned answer contains any non-whitespace text."),
  general("completion", "Generation completed", "Check whether the runtime recorded a normal stop. A missing or unfamiliar stop reason leaves this check unscored."),
  general("json-valid", "Valid JSON", "Check whether the answer parses as JSON when the scenario explicitly requires a JSON response."),
];
const operations = [
  industry("earnings","earnings-fact","Requested financial fact",
    "Match the requested field, fiscal period, accounting basis and normalized value. Verify the labeled release excerpt so an adjusted or year-to-date figure cannot pass under the requested label.",
    ["field","period","basis","value","evidence"]),
  industry("earnings","earnings-amount","Amount and currency",
    "Compare the signed, normalized decimal amount and reporting currency with the labeled release record. Preserve reported zero and an explicitly unknown amount.",
    ["value","currency"]),
  industry("earnings","earnings-citation","Release evidence and locator",
    "Match the labeled excerpt and source locator. Verify the excerpt in the supplied release, allowing an explicitly absent quotation for an undisclosed fact.",
    ["evidence","source_locator"]),
  industry("earnings","earnings-review","Analyst review routing",
    "Match the labeled fact status and analyst route. Keep unavailable values empty. On a source conflict, preserve the release value and quote and reconcile the separately labeled later filing.",
    ["status","routing"]),
  industry("manufacturing","inspection-drawing","Active drawing and sample identity",
    "Match the part, lot, active drawing revision, limits in millimetres and quoted specification against the inspection record.",
    ["part_id","lot_id","revision","lower_mm","upper_mm","spec_evidence"]),
  industry("manufacturing","inspection-reading","Measured dimension and units",
    "Match the measured value in millimetres and the quoted reading line. Compare decimal values after unit normalization.",
    ["measured_mm","reading_evidence"]),
  industry("manufacturing","inspection-disposition","Sample against drawing limits",
    "Match the finding, measured dimension and both drawing limits against the labeled case under its supplied sample decision rule.",
    ["finding","measured_mm","lower_mm","upper_mm"]),
  industry("manufacturing","inspection-handoff","Quality review routing",
    "Match the labeled sample finding and accept or review route. An explicitly missing decision instruction requires an insufficient-evidence finding and quality review.",
    ["finding","routing"]),
];
export const catalogRules:readonly CatalogRule[] = [...diagnostics, ...operations, {
  key:inspectionRuleKey,version:1,scope:"industry",industry:"Manufacturing",name:"Inspection sample decision",category:"Receiving inspection",
  criteria:"Compare the JSON disposition or routing with the approved case decision. For inclusive-limits records, compare the recorded dimension with both active bounds in millimetres. Check next_action for a signed recheck and shift_note_completes_disposition when the case requires them. Missing facts or ambiguous response wording leave this check unscored.",
},{
  key:inspectionRangeKey,version:1,scope:"industry",industry:"Manufacturing",name:"Active drawing range and reading",category:"Receiving inspection",
  criteria:"Match the active drawing revision, both labeled limits in mm, and the reading in the JSON answer. A single endpoint or a superseded range cannot establish the active bounds.",
}];
export const isInformationalRule = (key:string|undefined):boolean => diagnostics.some(rule=>rule.key===key);

const nonwhite = new RegexMatch("response_present",false);
const json = new IsJson("json_valid",false);
const sdk = "opik-js@" + z.object({version:z.string()}).parse(require("opik/package.json")).version;
const scorer = {earnings:"earnings-record-v1",manufacturing:"incoming-inspection-v1"};
const financialStatuses = new Set(["supported","not_disclosed","ambiguous","source_conflict"]);
const findings = new Set(["within_limits","outside_limits","insufficient_evidence"]);

function scoreIndustry(rule:ScenarioRule, context:GraderEvidence["caseContext"], output:string, evaluator:string):RuleScore {
  const unscored = (reason:string):RuleScore => ({value:null,reason,evaluator});
  if (!context || context.pack.id!==rule.scenario || context.pack.scorer!==scorer[rule.scenario])
    return unscored("This check needs a labeled case from " + rule.category + " and its pinned scenario contract.");
  const {row,pack}=context;
  const source=pack.sourceText && packField(row.input,pack.sourceText);
  if (typeof source!=="string" || !source.trim()) return unscored("The case is missing its source text.");
  if (!row.gold) return unscored("The case is missing its reference labels.");
  const fields=[...rule.fields];
  if (rule.scenario==="earnings") {
    if (typeof row.gold.status!=="string" || !financialStatuses.has(row.gold.status)) return unscored("The case is missing a valid fact-status label.");
    if (rule.key==="earnings-review") {
      fields.push("reconciliation");
      if (row.gold.status==="source_conflict") fields.push("value","evidence");
      if (row.gold.status==="not_disclosed" || row.gold.status==="ambiguous") fields.push("value");
    }
  } else if (rule.key==="inspection-disposition" || rule.key==="inspection-handoff") {
    const instruction=packField(row.input,"decision_rule");
    if (typeof instruction!=="string" || !instruction.trim()) return unscored("The case is missing its decision-rule evidence.");
    if (typeof row.gold.finding!=="string" || !findings.has(row.gold.finding)) return unscored("The case is missing a valid inspection finding.");
  }
  if (fields.includes("routing") && row.gold.routing!==pack.accept && row.gold.routing!==pack.review)
    return unscored("The case is missing a valid routing label.");
  const checks:ScoredPack["checks"]=[];
  const quotes=pack.quotes.filter(q=>fields.some(k=>q===k || q.startsWith(k+".")));
  for (const key of fields) {
    const check=pack.checks.find(c=>c.key===key);
    if (!check) return unscored("The pinned scenario contract is missing the check for " + key + ".");
    const expected=packField(row,check.ref);
    if (key==="reconciliation") {
      if (row.gold.status==="source_conflict") {
        if (!isRecord(expected) || expected.status!=="conflict" || packDecimal(expected.value)===undefined ||
            typeof expected.evidence!=="string" || !expected.evidence.trim() || !source.includes(expected.evidence))
          return unscored("The case is missing a complete, source-backed later-filing reference.");
      } else if (expected!==undefined || !check.optional) {
        return unscored("The case has inconsistent later-filing labels for its fact status.");
      }
    } else if (key==="value" && (row.gold.status==="not_disclosed" || row.gold.status==="ambiguous")) {
      if (expected!==null) return unscored("This fact status requires an explicitly unknown reference amount.");
    } else if (key==="evidence" && row.gold.status==="not_disclosed" && expected===null) {
      // The reference explicitly labels the requested fact as undisclosed.
    } else if (typeof expected!=="string" || !expected.trim() ||
        (pack.decimalFields.includes(key) && packDecimal(expected)===undefined)) {
      return unscored("The case is missing a valid reference for " + key + ".");
    } else if (quotes.includes(key) && !source.includes(expected)) {
      return unscored("The labeled quotation for " + key + " is absent from the supplied source.");
    }
    checks.push(check);
  }
  const result=grade({...pack,checks,quotes},row,output);
  return {value:Number(result.pass),reason:result.pass ? rule.name+" matched the labeled case." : result.reasons.join(". "),evaluator};
}

export async function scoreCatalogRule(key:string,e:GraderEvidence,version=1):Promise<RuleScore> {
  const evaluator="dash-catalog/"+key+"@"+version;
  const unscored = (reason:string):RuleScore => ({value:null,reason,evaluator});
  if (version!==1 || !catalogRules.some(rule=>rule.key===key)) return unscored("This catalog rule revision is unavailable.");
  if (key==="completion") {
    switch (e.finishReason) {
      case "stop": case "end_turn": case "stop_sequence": case "eos_token": case "eosFound": case "stopStringFound":
        return {value:1,reason:"The runtime recorded a normal stop ("+e.finishReason+").",evaluator};
      case "length": case "max_tokens": case "content_filter": case "contextLengthReached": case "maxPredictedTokensReached":
        return {value:0,reason:"The runtime ended generation with "+e.finishReason+".",evaluator};
      default: return unscored("The runtime did not report a recognized final stop reason.");
    }
  }
  if (key==="response-present") {
    const score=await nonwhite.score({output:e.output,pattern:"\\S"});
    return {value:score.value, reason:score.value ? "The answer contains text." : "The returned answer was empty or contained only whitespace.",evaluator:evaluator+" · "+sdk+" · RegexMatch"};
  }
  if (key==="json-valid") {
    const contract=e.quickOutputSchema ?? e.caseContext?.pack.outputSchema;
    if (!isRecord(contract) || !Object.keys(contract).length)
      return unscored("This run has no explicit JSON output contract.");
    const score=await json.score({output:e.output});
    return {value:score.value,reason:score.value ? "The answer parses as JSON." : "The answer is invalid JSON.",evaluator:evaluator+" · "+sdk+" · IsJson"};
  }
  if(key===inspectionRangeKey)return {...scoreInspectionRange(e),evaluator};
  if(key===inspectionRuleKey)return {...scoreInspectionDecision(e),evaluator};
  const rule=operations.find(rule=>rule.key===key);
  return rule ? scoreIndustry(rule,e.caseContext,e.output,evaluator) : unscored("Unknown catalog rule.");
}
