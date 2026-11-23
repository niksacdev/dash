"use strict";

const scorePercent = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) ? (value * 100).toLocaleString(undefined,{maximumFractionDigits:2})+"%" : "Unscored";
const scoreMethod = (method: UiReportMetric["method"]) => ({"deterministic":"Rule-based check","llm-judge":"LLM judge","opik-judge":"Opik G-Eval","opik-metric":"Opik metric","decision-model":"Decision model"}[method] || method);
function reportCandidateLabel(c: UiReportCandidate, candidates: UiReportCandidate[]) {
  return candidates.some(other=>other.id!==c.id && other.label===c.label)?c.id:c.label;
}
function metricComparisons(metric: UiReportMetric, candidates: UiReportCandidate[]) {
  return '<div class="er-score-lines">'+candidates.map(c=>{
    const v=metric.values.find(v=>v.candidateId===c.id);
    return '<div class="er-score-line"><span>'+esc(reportCandidateLabel(c,candidates))+'</span><strong>'+esc(scorePercent(v?.score))+'</strong>'+
      (v && Number.isFinite(v.score)?'<progress max="1" value="'+esc(v.score)+'" aria-label="'+esc(c.label+" · "+metric.label)+'"></progress>':'')+
      '<small>'+esc(v?.passes ?? 0)+' passed · '+esc(v?.scoredCases ?? 0)+' matched'+(v && Number.isFinite(v.availableCases) && v.availableCases!==v.scoredCases?' · '+esc(v.availableCases)+' available for this candidate':'')+'</small></div>';
  }).join("")+'</div>';
}
function outcomeBenchmarks(report: UiReport) {
  const rows=report.observedOutcomes || [];
  if (!rows.length) return "";
  return '<section class="er-outcomes"><h3>Observed outcomes</h3>'+table(["Measure",...report.candidates.map(c=>reportCandidateLabel(c,report.candidates))],rows.map(row=>
    [esc(row.label),...report.candidates.map(c=>{
      const value=row.values.find(v=>v.candidateId===c.id);
      if (!value || !Number.isFinite(value.count) || !value.total) return "Unmeasured";
      return esc(value.count+" / "+value.total)+(value.caseIds?.length ? "<details><summary>Cases</summary>"+esc(value.caseIds.join(", "))+"</details>" : "");
    })]))+'</section>';
}
function reportAssistance(r: UiReport) {
  const audit = r.assistance;
  if (!audit) return "";
  const stages = [audit.analyzer, audit.reporter].filter(s => s.model);
  if (!stages.length) return '<p class="muted">'+esc(audit.reason || "")+'</p>';
  const stageLabel = (s: UiReportStage) => esc(s.name)+' · '+esc(s.model)+' · '+(s.status==="verified"?"verified":"used fixed scoring");
  const evidence = audit.citations.map(c => {
    const metric = r.metrics.find(m=>m.id===c.metricId);
    const scores = c.values.map(v=>{
      const model = r.candidates.find(c=>c.id===v.candidateId);
      return esc(model ? reportCandidateLabel(model,r.candidates) : v.candidateId)+' '+esc(scorePercent(v.score));
    });
    let finding: string;
    if (c.observation === "first_higher" || c.observation === "second_higher") {
      const leader = r.candidates[c.observation === "first_higher" ? 0 : 1];
      finding = leader ? reportCandidateLabel(leader,r.candidates)+" scored higher on this case." : "";
    } else {
      finding = { equal: "The candidates tied on this case.", missing: "A case score is missing.", single: "One candidate was scored." }[c.observation];
    }
    return '<li><strong>'+esc(metric?.label ?? c.metricId)+'</strong> · '+esc(c.caseId)+'<br>'+esc(finding)+' '+scores.join(' / ')+'</li>';
  });
  return '<details class="er-policy"><summary>Local agent review'+(evidence.length?' · '+evidence.length+' case '+(evidence.length===1?'highlight':'highlights'):'')+'</summary><p>'+
    stages.map(stageLabel).join('<br>')+'</p>'+(evidence.length?'<ul>'+evidence.join("")+'</ul>':'')+'</details>';
}
function evaluationReport(run: UiRunDetail) {
  const r=run.report;
  if (!r || ["queued","running"].includes(run.status)) return "";
  const winner=r.candidates.find(c=>c.id===r.winnerId);
  const name=winner && reportCandidateLabel(winner,r.candidates);
  const headline=({
    winner:name ? name+" wins" : "Winner recorded", tie:"The models tied", mixed:"The models lead on different measures",
    unsafe:"Quality winner withheld", ungraded:"No quality verdict", incomplete:"Incomplete comparison", single:"Single-candidate result"
  })[r.verdict] || "Evaluation report";
  return '<section class="er-report" aria-labelledby="er-title" data-verdict="'+esc(r.verdict)+'">'+
    '<div class="er-intro"><small class="er-kicker">Evaluation report</small><h2 id="er-title">'+esc(headline)+'</h2><p>'+esc(r.summary)+'</p></div>'+
    (r.metrics.length?'<div class="er-metrics">'+r.metrics.map((m,i)=>
      '<article class="er-metric"><div class="er-metric-head"><div><small>'+(m.informational?'Response diagnostic · ':'')+(m.lineage?esc(m.lineage.scope)+' library · ':'')+esc(scoreMethod(m.method))+(m.judge?' · '+esc(m.judge)+(r.candidates.some(c=>c.id===m.judge)?' · also a candidate':''):'')+'</small><h3>'+esc(m.label)+'</h3></div>'+
      '<span>'+esc(m.pairedCases)+' / '+esc(m.totalCases)+' matched cases</span></div>'+
      (m.comparisonIssue?'<p>'+esc(m.comparisonIssue)+'</p>':'')+metricComparisons(m,r.candidates)+
      '<details class="er-evidence" data-report-run="'+esc(run.manifest.id)+'" data-metric-index="'+i+'"><summary>Case scores and rationale</summary><div></div></details></article>').join("")+'</div>':'')+
    outcomeBenchmarks(r)+reportAssistance(r)+
    '<details class="er-policy"><summary>How DASH reached the verdict</summary><p>'+esc(r.decisionRule)+'</p>'+
    (r.metrics.length?'<ul>'+r.metrics.map(m=>'<li>'+esc(m.label)+' · '+(m.decisionPolicy?'Fail at or below '+esc(m.decisionPolicy.failAt)+', pass at or above '+esc(m.decisionPolicy.passAt)+', review between': 'Pass threshold '+esc(scorePercent(m.threshold)))+'</li>').join("")+'</ul>':'')+
    '<small>'+esc(r.analyzer?.name || "Output Analyzer")+' and '+esc(r.reporter?.name || "Report agent")+' summarize the recorded scores using a fixed decision rule.</small></details></section>';
}
document.addEventListener("toggle",e=>{
  const details=e.target;
  if (!(details instanceof HTMLDetailsElement) || !details.matches(".er-evidence") || !details.open || details.dataset.loaded) return;
  const run=current;
  if (!run?.report || run.manifest.id!==details.dataset.reportRun) return;
  const report = run.report;
  const metric=report.metrics[Number(details.dataset.metricIndex)];
  if (!metric) return;
  const indexes=new Map((run.results || []).map((v,i)=>[JSON.stringify([v.caseId,v.candidateId]),i]));
  const labels=new Map(report.candidates.map(c=>[c.id,reportCandidateLabel(c,report.candidates)]));
  const rows=(metric.caseScores || []).flatMap(c=>c.values.map(v=>{
    const index=indexes.get(JSON.stringify([c.caseId,v.candidateId]));
    const native=v.opikMetric;
    const nativeEvidence=native ? '<small>'+esc(native.metricKey)+' · native score '+esc(native.nativeScore)+' · '+esc(native.direction.replaceAll("-"," "))+'</small>' : "";
    const receipt=v.decision;
    const transport=receipt?.provider==="local" ? (receipt.protocol==="mlx-vlm"?"Local MLX-VLM":"Local System One") : "OpenRouter";
    const switchDetail=receipt?.fallbackReason ? " · switched to "+esc(receipt.dispatchedModel)+" ("+esc(receipt.fallbackReason.replaceAll("-"," "))+")" : "";
    const evidence=receipt?.actualModel ? '<small>'+esc(transport)+switchDetail+' · served '+esc(receipt.actualModel)+' · P(yes) '+esc(receipt.probabilityYes)+'</small>' : switchDetail ? '<small>'+esc(transport)+switchDetail+' · no verified response</small>' : '';
    return [index==null?esc(c.caseId):link(esc(c.caseId),"run/"+encodeURIComponent(run.manifest.id)+"/"+index,"link"),
      esc(labels.get(v.candidateId) || v.candidateId), esc(scorePercent(v.score)),
      receipt?.status==="review"?"Review":v.pass==null?"Unscored":v.pass?"Passed":"Below threshold",esc(v.reason || "")+(nativeEvidence?"<br>"+nativeEvidence:"")+(evidence?"<br>"+evidence:"")];
  }));
  const target = details.querySelector("div");
  if (!target) return;
  const lineage=metric.lineage;
  const origin=lineage ? '<p>Family '+esc(lineage.familyId)+' · revision '+esc(metric.id)+(lineage.parentRevisionId?' · derived from '+esc(lineage.parentRevisionId):'')+'</p>' : "";
  target.innerHTML=origin+(rows.length?table(["Case","Candidate","Score","Result","Evidence"],rows):'<p>No case scores were recorded.</p>');
  details.dataset.loaded="true";
},true);
function guardrailDetails(g: UiGuardrail | null | undefined) {
  if (!g) return "";
  const values=[
    ["Candidate",g.candidateId],["Case",g.caseId],["Checked input",g.inputTokens],["Active context",g.contextTokens],
    ["Input limit",g.requestedInputCap],["Output limit",g.requestedOutputCap],["Model output ceiling",g.maxOutputTokens],["Reserved output",g.outputReserve],["Source",g.source]
  ].filter(([,v])=>v!=null);
  return '<section class="er-guard" data-guardrail="'+esc(g.status)+'"><h3>Token check · '+esc(g.status)+'</h3>'+
    (g.message?'<p>'+esc(g.message)+'</p>':'')+'<dl>'+values.map(([k,v])=>'<div><dt>'+esc(k)+'</dt><dd>'+
    esc(typeof v==="number"?v.toLocaleString()+" tokens":v)+'</dd></div>').join("")+'</dl>'+
    (g.inputOptimization?.status==='compacted'?'<small>Dataset input formatting compacted · '+esc(g.inputOptimization.charactersSaved)+' characters saved.</small>':'')+'</section>';
}
