import type {ApprovedPrompt} from "./outcome-workflow.cjs";
import type {GraderSpec} from "./grader-types.cjs";
import type {ModelCandidate} from "./runtime-types.cjs";
import type {PinnedMeasure} from "./measure-graders.cjs";
import {isInformationalRule} from "./grader-catalog.cjs";
import {graderEngineIssue} from "./graders.cjs";

const diagnostic=(grader:GraderSpec)=>grader.type==="catalog" && isInformationalRule(grader.ruleKey);

export function scoringOptions(graders:GraderSpec[],models:ModelCandidate[]) {
  const setupIssues:Record<string,string>={};
  for (const g of graders) {
    const problem=graderEngineIssue(g);
    if (problem) setupIssues[g.id]=g.name+" · "+problem;
    else if (g.judge && !models.some(model=>model.id===g.judge?.id && (!g.judge.revision || model.revision===g.judge.revision)))
      setupIssues[g.id]=g.name+" needs its saved judge "+g.judge.model+". Reconnect its runtime and refresh models, or select a grader with an available judge.";
    else if (g.type==="decision" && g.decision.provider==="openrouter" && !process.env.OPENROUTER_API_KEY?.trim())
      setupIssues[g.id]=g.name+" needs an OpenRouter decision key. Configure OPENROUTER_API_KEY or choose a local grader.";
  }
  return {scoringVersion:1 as const,diagnosticIds:graders.filter(diagnostic).map(g=>g.id),setupIssues};
}

export function quickVerdictIssue(approved:ApprovedPrompt,graders:GraderSpec[],mappings:PinnedMeasure[]|undefined,combined:boolean):string {
  const issue=(text:string)=>text+" For answers without a quality verdict, explicitly choose answer inspection.";
  if (!mappings && !combined && (approved.metricCriteria || approved.metricAudit) && approved.metrics.length)
    return issue("Assign a quality grader to each approved measure before GO, starting with "+approved.metrics[0]+".");
  if (combined && !mappings && (approved.metricCriteria || approved.metricAudit) && approved.metrics.length>1)
    return issue("Assign a separate grader to each approved measure before GO.");
  const qualityIds=new Set(graders.filter(g=>!diagnostic(g)).map(g=>g.id));
  for (const row of mappings ?? []) {
    if (!row.graderId || !qualityIds.has(row.graderId))
      return issue("Choose a quality grader for “"+row.metric+"” before GO."+(row.reason?" "+row.reason:""));
  }
  return qualityIds.size ? "" : issue("Choose a quality grader before GO. Completion and response-format checks only describe the response.");
}
