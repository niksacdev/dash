"use strict";

const scorePercent = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) ? (value * 100).toLocaleString(undefined,{maximumFractionDigits:2})+"%" : "Unscored";
const scoreMethod = (method: UiReportMetric["method"]) => ({"deterministic":"Rule-based check","llm-judge":"LLM judge","opik-judge":"Opik G-Eval","opik-metric":"Opik metric","decision-model":"Decision model"}[method] || method);
function reportCandidateLabel(c: UiReportCandidate, candidates: UiReportCandidate[]) {
  return candidates.some(other=>other.id!==c.id && other.label===c.label)?c.id:c.label;
}
function metricComparisons(metric: UiReportMetric, candidates: UiReportCandidate[]) {
  const scores = candidates.map(candidate => metric.values.find(value => value.candidateId === candidate.id));
  const first = scores[0]?.score;
  const equal = scores.length > 1 && typeof first === "number" && Number.isFinite(first) && scores.every(value => value?.score === first);
  return '<div class="er-score-lines">'+candidates.map((candidate, lane)=>{
    const v=scores[lane], label=reportCandidateLabel(candidate,candidates);
    const available=v?.availableCases;
    const display=v?.score==null && available!==0 ? "No comparable score" : scorePercent(v?.score);
    const coverage = v?.score==null ?
      (available==null ? "" : available===0 ? "No case grades recorded for this candidate" : available+" of "+metric.totalCases+" case grades recorded for this candidate") :
      v.passes+" passed · "+v.scoredCases+" matched"+(available!=null && available!==v.scoredCases ? " · "+available+" available for this candidate" : "");
    return '<div class="er-score-line"><span>'+esc(label)+'</span><strong>'+esc(display)+'</strong>'+
      comparisonTrack(label+' · '+metric.label, v?.score, 1, display, lane)+
      (coverage ? '<small>'+esc(coverage)+'</small>' : '')+'</div>';
  }).join("")+'</div>'+(equal?'<small class="er-equal">Equal scores on this measure</small>':'');
}
function outcomeBenchmarks(report: UiReport) {
  const rows=report.observedOutcomes || [];
  if (!rows.length) return "";
  return '<section class="er-outcomes"><h3>Observed outcomes</h3>'+table(["Measure",...report.candidates.map(c=>reportCandidateLabel(c,report.candidates))],rows.map(row=>
    [esc(row.label),...report.candidates.map((c,lane)=>{
      const value=row.values.find(v=>v.candidateId===c.id);
      if (!value || !Number.isFinite(value.count) || !value.total) return "Unmeasured";
      const display=value.count+" / "+value.total;
      return esc(display)+comparisonTrack(reportCandidateLabel(c,report.candidates)+' · '+row.label,value.count,value.total,display,lane)+(value.caseIds?.length ? "<details><summary>Cases</summary>"+esc(value.caseIds.join(", "))+"</details>" : "");
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
function reportEvidence(runId:string,index:number,missing=false,history=false) {
  const label=missing ? "See why cases have no comparable score" : "Case scores and rationale";
  if (history) return link(label,"run/"+encodeURIComponent(runId)+"/measure/"+index,"link");
  return '<details class="er-evidence" data-report-run="'+esc(runId)+'" data-metric-index="'+index+'"><summary>'+label+'</summary><div></div></details>';
}
let responseCase:{runId:string;index:number}|undefined;
function isReportChallenge(run:UiRunDetail) {
  return run.status==="completed" && run.report?.candidates.length===2 && ["winner","tie","mixed","unsafe"].includes(run.report.verdict);
}
function reviewFinding(review:UiSavedReview,report:UiReport) {
  const finding=review.finding;
  if(!finding)return "";
  const candidate=report.candidates.find(c=>c.id===finding.candidateId);
  if(finding.status==="higher" && candidate)return reportCandidateLabel(candidate,report.candidates)+" scored higher on this check.";
  return finding.status==="equal" ? "Both answers received the same score on this check." : "The grader could not establish comparable scores for this check.";
}
function responseComparison(run:UiRunDetail) {
  const report=run.report,ids=run.manifest.caseIds;
  const candidates=report?.candidates ?? run.manifest.candidates.map(c=>({id:c.id,label:c.model}));
  if(!ids.length || !candidates.length)return "";
  const index=responseCase?.runId===run.manifest.id && responseCase.index<ids.length ? responseCase.index : 0;
  const caseId=ids[index];
  const rows=(report?.metrics ?? []).filter(metric=>!metric.informational).map(metric=>({
    metric,values:metric.caseScores?.find(row=>row.caseId===caseId)?.values,
    pin:run.manifest.graders.find(g=>g.id===metric.id),
    measures:run.manifest.measureGraders?.filter(row=>row.graderId===metric.id) ?? [],
  }));
  const reviews=run.savedReviews?.filter(r=>r.caseId===caseId) ?? [];
  const cards=candidates.map(c=>{
    const responseIndex=run.results.findIndex(r=>r.candidateId===c.id && r.caseId===caseId);
    const result=run.results[responseIndex];
    const observed=result && observationLabel(result);
    const partial=!!result?.dispatchState;
    const outputLabel=partial?"Partial candidate output":result?.error?"Output saved before the error":"Saved candidate response";
    const checks=rows.map(({metric,values,pin,measures})=>{
      const grade=values?.find(v=>v.candidateId===c.id);
      const judged=metric.method!=="deterministic",decision=grade?.decision;
      const observed=decision?.actualModel,requested=decision?.requestedModel ?? pin?.judge?.model ?? metric.judge;
      const alsoCandidate=judged && run.manifest.candidates.some(other=>{
        if(observed) {
          if(decision?.provider==="openrouter")return other.model===observed && (other.provider==="openrouter" || other.provider==="compatible" && other.endpoint?.startsWith("https://openrouter.ai/"));
          return other.model===observed && (["lmstudio","ollama","local"].includes(other.provider) ||
            (!!pin?.decision?.endpoint && other.provider==="compatible" && other.endpoint===pin.decision.endpoint));
        }
        return !!pin?.judge && (other.id===pin.judge.id || (other.provider===pin.judge.provider && other.model===pin.judge.model &&
          (!other.revision || !pin.judge.revision || other.revision===pin.judge.revision)));
      });
      const judgeIdentity=observed ? "Serving judge · "+observed+(requested && requested!==observed?" · Requested "+requested:"")+
        (decision?.fallbackReason?" · Alternate model used":"") : requested?"Pinned judge · "+requested:"";
      const required=pin ? [needsGraderReference(pin)?"held-out reference":"",pin.requiredEvidence?.includes("trajectory") || pin.type==="trajectory"?"observed agent steps":""].filter(Boolean) : [];
      const reference=run.manifest.mode==="quick" && run.hasQuickExpectedAnswer!==undefined ?
        (run.hasQuickExpectedAnswer?" · A held-out answer was saved for this run.":" · No held-out answer was saved for this run.") : "";
      return '<li><strong>'+esc(metric.label+(pin?" v"+pin.version:""))+'</strong>'+
        (measures.length?'<p>'+measures.map(row=>'<b>Expected · </b>'+esc(row.criterion || row.metric)).join('<br>')+'</p>':'')+
        (pin?'<details><summary>Original scoring rule</summary><pre>'+esc(pin.criteria)+'</pre></details>':'')+
        '<small>Pass threshold · '+esc(metric.threshold)+' / 1 · '+esc(required.length?'Requires '+required.join(" and "):pin?.evidenceView==="answer-only"?"Uses candidate answer only":"No extra evidence required")+esc(reference)+'</small>'+
        '<p><b>'+esc(judged?"Judge score":"Rule score")+' · </b>'+esc(grade?.score==null?"Unscored":grade.score+" / 1")+
        (grade?.score!=null?' · '+(grade.pass?"Passed":"Below threshold"):'')+
        (judgeIdentity?' · '+esc(judgeIdentity)+(alsoCandidate?' · also a candidate in this run':''):'')+'</p>'+
        (grade?.reason?'<p><b>'+esc(judged?"Recorded judge reason":"Recorded rule result")+' · </b>'+esc(gradingExplanation(grade.reason))+'</p>':'')+'</li>';
    }).join("");
    const later=reviews.map(r=>{
      const receipt=r.grades.find(g=>g.candidate===c.id);
      return '<li><strong>'+esc(r.graderName+" v"+r.version)+'</strong> · '+esc(scorePercent(receipt?.value))+
        (receipt?.pass!=null?' · '+(receipt.pass?"Passed":"Below threshold"):'')+
        '<small>'+esc(r.source+' · '+r.status)+'</small>'+
        (receipt?.reason?'<p>'+esc(gradingExplanation(receipt.reason))+'</p>':'')+'</li>';
    }).join("");
    return '<article class="er-response-card"><h3>'+esc(reportCandidateLabel(c,candidates))+'</h3>'+
      (partial?'<p><strong>'+esc(observed || "Final response unconfirmed")+'</strong> · Only the observed output is available.</p>':'')+
      (result?.output?'<pre tabindex="0" aria-label="'+outputLabel+'">'+esc(result.output)+'</pre>':'<p>No final answer was saved.</p>')+
      (result?.error?'<p>'+esc(result.error)+'</p>':'')+
      (responseIndex>=0?link("Open response and trace","run/"+encodeURIComponent(run.manifest.id)+"/"+responseIndex,"link"):'')+
      (checks?'<h4>Original grader results</h4><ul>'+checks+'</ul>':report?'<p>No business grader was pinned.</p>':'<p>Scores are unavailable for this saved response.</p>')+
      (later?'<h4>Saved-answer review</h4><ul>'+later+'</ul>':'')+'</article>';
  }).join("");
  const picker=ids.length>1?'<form data-response-pager><button type="button" aria-label="Previous case" data-case-step="-1" '+(index===0?'disabled':'')+'>←</button>'+
    '<label>Case <input type="number" name="caseNumber" aria-label="Case number" min="1" max="'+ids.length+'" value="'+(index+1)+'" required> of '+ids.length+'</label>'+
    '<button type="submit">Go to case</button><button type="button" aria-label="Next case" data-case-step="1" '+(index===ids.length-1?'disabled':'')+'>→</button></form>':'';
  const conclusion=report ? reviews.filter(r=>r.finding).map(r=>'<p><strong>'+esc(r.graderName+" v"+r.version)+'</strong> · '+esc(reviewFinding(r,report))+'</p>').join("") : "";
  return '<section class="panel er-responses" data-response-case="'+esc(caseId)+'" data-case-index="'+index+'" aria-label="Responses and grader results"><div class="er-response-heading"><h2>Responses and grader results</h2>'+picker+'</div><p>Case · '+esc(caseId)+'</p>'+
    '<div class="er-response-grid">'+cards+'</div>'+conclusion+
    (isReportChallenge(run)?'<button type="button" data-open-challenge>Challenge verdict</button>':'')+'</section>';
}
function navigateResponseCase(form:HTMLFormElement,step?:number) {
  const run=current,panel=form.closest<HTMLElement>("[data-response-case]");
  if(!run || !panel)return;
  const field=requireElement("input[name=caseNumber]",HTMLInputElement,form);
  const index=step===undefined ? field.valueAsNumber-1 : Number(panel.dataset.caseIndex)+step;
  if(!Number.isSafeInteger(index) || index<0 || index>=run.manifest.caseIds.length)return;
  responseCase={runId:run.manifest.id,index};
  panel.outerHTML=responseComparison(run);
  const control=step===undefined ? undefined : document.querySelector<HTMLButtonElement>('[data-response-pager] [data-case-step="'+step+'"]:enabled');
  (control ?? document.querySelector<HTMLInputElement>("[data-response-pager] input"))?.focus();
}
document.addEventListener("submit",event=>{
  const form=event.target;
  if(form instanceof HTMLFormElement && form.matches("[data-response-pager]")){event.preventDefault();navigateResponseCase(form);}
});
document.addEventListener("click",event=>{
  if(!(event.target instanceof Element))return;
  const step=event.target.closest<HTMLButtonElement>("[data-case-step]");
  if(step?.form){navigateResponseCase(step.form,Number(step.dataset.caseStep));return;}
  const trigger=event.target.closest<HTMLElement>("[data-open-challenge]");
  const challenge=document.querySelector<HTMLDetailsElement>("[data-verdict-challenge]");
  if(!trigger || !challenge || !current)return;
  challenge.open=true;
  const selected=challenge.querySelector<HTMLSelectElement>("[name=reviewCase]");
  const caseId=trigger.closest<HTMLElement>("[data-response-case]")?.dataset.responseCase;
  if(selected && caseId) {selected.value=caseId;selected.dispatchEvent(new Event("change",{bubbles:true}));}
  (challenge.querySelector<HTMLElement>("[name=reviewGrader]") ?? challenge.querySelector<HTMLElement>("summary"))?.focus();
});
function quickMeasureScores(run:UiRunDetail,report:UiReport) {
  const mapped=run.manifest.measureGraders;
  if (run.manifest.mode!=="quick" || !mapped?.length) return "";
  const caseId=run.manifest.caseIds[0];
  const rows=mapped.map(row=>{
    const grader=run.manifest.graders.find(g=>g.id===row.graderId && g.version===row.graderVersion);
    const index=grader ? report.metrics.findIndex(m=>m.id===grader.id) : -1;
    const metric=report.metrics[index];
    const scores=metric?.caseScores?.find(c=>c.caseId===caseId)?.values;
    const rule=grader ? '<small>'+esc(grader.name)+' v'+esc(grader.version)+' · pass threshold '+esc(grader.threshold)+'</small>' : '';
    const measure='<strong>'+esc(row.metric)+'</strong>'+(row.criterion?'<p>Pass condition · '+esc(row.criterion)+'</p>':'')+rule+
      (row.reason?'<small>'+esc(row.reason)+'</small>':'')+(metric?reportEvidence(run.manifest.id,index,metric.pairedCases<metric.totalCases):'');
    return [measure,...report.candidates.map((c,lane)=>{
      const value=scores?.find(v=>v.candidateId===c.id);
      if (!value || value.score==null) return '<strong>Unscored</strong>'+(value?.reason?'<small>'+esc(gradingExplanation(value.reason))+'</small>':'');
      const verdict=value.decision?.status==="review"?"Review":value.pass==null?"Unscored":value.pass?"Passed":"Below threshold";
      const display=value.score+" / 1";
      return '<strong>'+esc(display)+'</strong><small>'+esc(verdict)+'</small>'+
        comparisonTrack(reportCandidateLabel(c,report.candidates)+' · '+row.metric,value.score,1,display+' · '+verdict,lane);
    })];
  });
  return '<section class="er-measure-comparison"><h3>Scores by approved measure</h3><p>Each score applies to one model answer.</p>'+
    table(["Measure and grader",...report.candidates.map(c=>reportCandidateLabel(c,report.candidates))],rows)+'</section>';
}
type ReportMetricEntry = {metric:UiReportMetric;index:number};
function reportMetricGroups(entries:ReportMetricEntry[], report:UiReport, runId:string, history=false) {
  return reportMetricSection("Business graders",entries.filter(({metric})=>!metric.informational),report,runId,history)+
    reportMetricSection("Response diagnostics",entries.filter(({metric})=>metric.informational),report,runId,history);
}
function reportMetricSection(title:string, entries:ReportMetricEntry[], report:UiReport, runId:string, history:boolean) {
  if (!entries.length) return "";
  return '<section class="er-metric-section"><h3>'+esc(title)+'</h3><div class="er-metrics">'+entries.map(({metric:m,index:i})=>
      '<article class="er-metric"><div class="er-metric-head"><div><small>'+(m.lineage?esc(m.lineage.scope)+' library · ':'')+esc(scoreMethod(m.method))+(m.judge?' · '+esc(m.judge)+(report.candidates.some(c=>c.id===m.judge)?' · also a candidate':''):'')+'</small><h3>'+esc(m.label)+'</h3></div>'+
      '<span>'+esc(m.pairedCases)+' of '+esc(m.totalCases)+' '+(m.totalCases===1?'case':'cases')+(report.candidates.length>1?' comparable across candidates':' scored')+'</span></div>'+
      (m.comparisonIssue?'<p>'+esc(m.comparisonIssue)+'</p>':'')+metricComparisons(m,report.candidates)+
      reportEvidence(runId,i,m.pairedCases<m.totalCases,history)+'</article>').join("")+'</div></section>';
}
function reviewableCase(run:UiRunDetail,caseId:string) {
  return run.manifest.candidates.every(c=>run.results.some(r=>r.caseId===caseId && r.candidateId===c.id && !r.dispatchState && !r.error && r.output?.trim()));
}
function reviewCaseGaps(run:UiRunDetail,caseId:string) {
  const report=run.report;
  if(!report)return [];
  const rows:string[]=[];
  for(const c of report.candidates) {
    const result=run.results.find(r=>r.caseId===caseId && r.candidateId===c.id);
    const who=reportCandidateLabel(c,report.candidates);
    if(!result || result.dispatchState || result.error || !result.output?.trim()) {
      rows.push(who+" has no completed answer for "+caseId+". "+(run.manifest.datasetId?"Inspect the case trace and choose Rerun case if you need a new response.":"Open Quick compare and run a new comparison if you need this response."));
      continue;
    }
    for(const m of report.metrics.filter(m=>!m.informational)) {
      const score=m.caseScores?.find(row=>row.caseId===caseId)?.values.find(v=>v.candidateId===c.id);
      if(score?.score!=null)continue;
      const reason=score?.reason || "No assessment was recorded.";
      rows.push(who+" · "+m.label+" — "+(missingAnswerMessages.has(reason)?"The grader needs the correct answer or verified facts. Enter them once below to grade the saved answers.":
        score?.decision?.status==="review"?"The decision model abstained. Review its probability and cutoffs, or choose a different approved grader for a separate assessment.":
        reason+" "+(/truncat|before completing|token budget/i.test(reason)?"Inspect the judge’s output budget before grading the saved answers.":"Review this grader and its evidence before grading the saved answers.")));
    }
  }
  for(const m of report.metrics.filter(m=>m.comparisonIssue))rows.push(m.label+" — "+m.comparisonIssue+" Choose a grader pinned to one serving revision.");
  for(const row of run.manifest.measureGraders ?? [])if(!row.graderId)rows.push(row.metric+" — no grader was assigned. A supplementary check can score the saved answers. For a formal verdict on this measure, map it to a grader in a new comparison.");
  return rows;
}
function savedAnswerGraderChoices(run:UiRunDetail) {
  const pinned=run.manifest.graders;
  return [...new Map([...pinned,...state.graders.filter(g=>!pinned.some(p=>p.id===g.id))].filter(g=>!g.library?.automatic &&
    (!g.library?.scenario || g.library.scenario===run.manifest.pack?.id) && !g.requiredEvidence?.includes("trajectory") && g.type!=="trajectory" &&
    (pinned.some(p=>p.id===g.id) || [run.manifest.industry,"General","Cross-industry","Unclassified"].includes(g.industry))
  ).map(g=>[g.id,g])).values()];
}
function reviewFields(run:UiRunDetail,caseId:string,selected?:string) {
  const challenge=isReportChallenge(run);
  const completed=new Set(run.savedReviews?.filter(r=>r.caseId===caseId && r.status==="completed" &&
    (r.finding?.status==="higher" || r.finding?.status==="equal")).map(r=>r.graderId));
  const options=savedAnswerGraderChoices(run).filter(g=>!challenge || (!completed.has(g.id) && !run.manifest.graders.some(pin=>pin.id===g.id)));
  const missing=run.report?.metrics.find(m=>!m.informational && (m.comparisonIssue || m.caseScores?.find(row=>row.caseId===caseId)?.values.some(v=>v.score===null)) && options.some(g=>g.id===m.id));
  const sourcedCheck=challenge && selected===undefined ?
    options.find(g=>g.ruleKey==="inspection-sample-decision" && (run.hasSourcedInspectionDecision || run.hasInspectionReference)) ??
    options.find(g=>g.ruleKey==="inspection-active-range" && (run.hasSourcedInspectionDecision || run.hasInspectionRangeReference)) : undefined;
  const grader=options.find(g=>g.id===(selected ?? missing?.id)) ?? (challenge?sourcedCheck:options[0]);
  const quick=run.manifest.mode==="quick";
  const field=referenceFieldFor(grader);
  const range=grader?.ruleKey==="inspection-active-range";
  const inspection=inspectionDecisionRule(grader);
  const matched=inspection ? run.hasSourcedInspectionDecision || (range?run.hasInspectionRangeReference:run.hasInspectionReference) : field && grader ? run.quickFieldGraderIds?.includes(grader.id) : run.hasQuickExpectedAnswer;
  const facts=grader && needsGraderReference(grader) && !(quick && matched);
  const required=quick && !(field && run.hasQuickExpectedAnswer && run.quickFieldGraderIds===undefined);
  const fieldHint=field && quick && run.hasQuickExpectedAnswer && matched===false ? "The saved answer lacks the field "+field+". Choose a grader compatible with that answer, or provide a JSON object with this field for this review." : "";
  const alignment=grader && run.decisionReviewTargets?.[grader.id];
  const aligned=alignment && !alignment.caseIds.includes(caseId);
  const gaps=reviewCaseGaps(run,caseId);
  const notes=gaps.length?'<ul>'+gaps.map(g=>'<li>'+esc(g)+'</li>').join("")+'</ul>':'';
  if(!reviewableCase(run,caseId))return notes+run.results.flatMap((r,i)=>r.caseId===caseId && (r.error || !r.output?.trim())?[link("Inspect "+esc(r.candidateId),"run/"+encodeURIComponent(run.manifest.id)+"/"+i,"link")]:[]).join(" ");
  if(!options.length)return notes+link("Create a quality grader","graders","link");
  const select=formField("Grader version",'<select name="reviewGrader" required>'+(challenge?opt("","Choose a supplementary grader",grader?.id ?? ""):"")+options.map(g=>opt(g.id,g.name+" · v"+g.version+(run.manifest.graders.some(pin=>pin.id===g.id)?" · original grader":" · supplementary grader"),grader?.id ?? "")).join("")+'</select>');
  if(!grader)return notes+select;
  return notes+select+
    (inspection && run.hasSourcedInspectionDecision?'<p>The saved task matches the versioned inspection sample. The deterministic grader compares each answer against that sample’s verified facts.</p>':'')+
    (alignment?'<p>'+esc(aligned?"This case already has comparable grades from "+alignment.model+". Select a case still missing this revision.":
      "Use "+alignment.model+" to grade both saved answers for "+caseId+". The other cases in this comparison use this revision.")+'</p>':'')+
    (facts && !aligned?formField(run.manifest.mode==="quick"?"Expected answer or verified facts for both answers":"Verified facts if missing from the saved case",'<textarea name="reviewReference" maxlength="12000" '+(required?'required':'')+'></textarea>')+'<small>'+esc(fieldHint || expectedAnswerHelp(grader))+'</small>':'')+
    '<p>The selected grader receives each saved response'+(facts?' and these facts':'')+'. Only the grader runs. A model-based grader can use tokens.</p><button class="yellow" type="submit" '+(aligned?'disabled':'')+'>Grade saved answers</button>';
}
function reportRecovery(run:UiRunDetail) {
  const r=run.report;
  const challenge=isReportChallenge(run);
  if(!r || (!challenge && !["incomplete","ungraded"].includes(r.verdict)))return "";
  const ids=run.manifest.caseIds;
  const missing=r.metrics.filter(m=>!m.informational).flatMap(m=>m.caseScores?.filter(row=>row.values.some(v=>v.score===null)).map(row=>row.caseId) ?? []);
  const first=Object.values(run.decisionReviewTargets ?? {}).find(target=>target.caseIds.length)?.caseIds[0] ?? missing[0] ?? ids[0];
  const reviews=(run.savedReviews ?? []).map(review=>{
    const target=run.decisionReviewTargets?.[review.graderId];
    const revision=review.grades[0]?.decision?.actualModel;
    const alignment=target && revision && review.grades.every(g=>g.decision?.actualModel===revision) && revision!==target.model ?
      '<p>'+esc("This review used "+revision+". The reviewed comparison uses "+target.model+" across its cases.")+'</p>' : "";
    return '<article><strong>'+esc(review.graderName+" v"+review.version+" · "+review.caseId)+'</strong><p>'+esc(review.status+" · grading evidence: "+review.source)+'</p>'+(review.status==="interrupted"?'<p>This review stopped. Check the saved receipts below before starting another review, which sends each saved answer to the grader again.</p>':'')+
    (review.comparisonIssue?'<p>'+esc(review.comparisonIssue)+' Check that one decision model can serve both answers, then choose Grade saved answers again.</p>':'')+
    (review.finding?'<p>'+esc(reviewFinding(review,r))+'</p>':'')+alignment+(review.grades.length?scoreRows(review.grades):'<p>No grade receipt was saved.</p>')+'</article>';}).join("");
  return (challenge?'<details class="er-recovery" data-verdict-challenge><summary>Challenge verdict</summary><p>Compare both saved answers with a different grader version. Each review records its own conclusion for this case.</p>':'<section class="er-recovery"><h3>Grade saved answers</h3>')+
    (first?'<form data-saved-review data-run="'+esc(run.manifest.id)+'">'+(ids.length>1?formField("Case",'<select name="reviewCase">'+ids.map(id=>opt(id,id,first)).join("")+'</select>'):'<input type="hidden" name="reviewCase" value="'+esc(first)+'">')+
      '<div data-review-fields>'+reviewFields(run,first)+'</div><p role="status" data-review-status></p></form>':'<p>No cases were saved. Start a new evaluation with the intended cases.</p>')+
    (reviews?'<h4>Saved-answer reviews</h4><p>These reviews are local to DASH. The original verdict and its Opik experiment keep the scores recorded during the run.</p>'+reviews:'')+
    (run.reviewedVerdict?'<h4>Reviewed verdict</h4><p>'+esc(run.reviewedVerdict.summary)+'</p>':'')+(challenge?'</details>':'</section>');
}
document.addEventListener("change",e=>{
  const el=e.target;
  if(!(el instanceof HTMLSelectElement) || !["reviewCase","reviewGrader"].includes(el.name))return;
  const f=el.closest<HTMLFormElement>("[data-saved-review]"),run=current;
  if(!f || !run || f.dataset.run!==run.manifest.id)return;
  const caseId=String(new FormData(f).get("reviewCase"));
  const fields=f.querySelector<HTMLElement>("[data-review-fields]");
  if(fields)fields.innerHTML=reviewFields(run,caseId,el.name==="reviewGrader"?el.value:undefined);
});
document.addEventListener("submit",async e=>{
  const form=e.target;
  if(!(form instanceof HTMLFormElement) || !form.matches("[data-saved-review]"))return;
  e.preventDefault();
  const run=current,status=form.querySelector<HTMLElement>("[data-review-status]"),button=form.querySelector<HTMLButtonElement>("button[type=submit]");
  if(!run || run.manifest.id!==form.dataset.run || !status || !button || button.disabled)return;
  const data=new FormData(form),id=String(data.get("reviewGrader")),grader=savedAnswerGraderChoices(run).find(g=>g.id===id);
  if(!grader)return;
  const consent=hostedDecisionConsent([grader],"the saved answers for this case");
  if(!consent)return;
  const expectedAnswer=String(data.get("reviewReference") || "").trim(),caseId=String(data.get("reviewCase"));
  if(typeof api.reviewSavedCase!=="function"){status.textContent="Quit and reopen the updated DASH app to grade both saved answers.";return;}
  button.disabled=true;status.textContent="Grading saved answers…";const stillHere=currentVisit();
  try {
    await api.reviewSavedCase({run:run.manifest.id,caseId,grader:id,...(expectedAnswer && {expectedAnswer}),...consent});
    if(stillHere())await render();
  } catch(error){if(stillHere()){status.textContent=errorText(error);button.disabled=false;}}
});
function evaluationReport(run: UiRunDetail) {
  const r=run.report;
  if (!r || ["queued","running"].includes(run.status)) return "";
  const mapped=new Set(run.manifest.measureGraders?.map(row=>row.graderId));
  const remaining=r.metrics.map((metric,index)=>({metric,index})).filter(({metric})=>!mapped.has(metric.id));
  const winner=r.candidates.find(c=>c.id===r.winnerId);
  const name=winner && reportCandidateLabel(winner,r.candidates);
  const gaps=r.metrics.filter(m=>!m.informational && m.pairedCases<m.totalCases);
  const summary=r.verdict==="incomplete" && run.status==="completed" && gaps.length ?
    gaps.map(m=>m.label+" has comparable scores for "+m.pairedCases+" of "+m.totalCases+" cases.").join(" ") : r.summary;
  const headline=({
    winner:name ? name+" wins" : "Winner recorded", tie:"Equal scores from the original graders", mixed:"The models lead on different measures",
    unsafe:"Quality winner withheld", ungraded:"No quality verdict", incomplete:"Incomplete comparison", single:"Single-candidate result"
  })[r.verdict] || "Evaluation report";
  return '<section class="er-report" aria-labelledby="er-title" data-verdict="'+esc(r.verdict)+'">'+
    '<div class="er-intro"><small class="er-kicker">Evaluation report</small><h2 id="er-title">'+esc(headline)+'</h2><p>'+esc(summary)+'</p></div>'+
    (r.cacheIssue ? '<p class="note">'+esc(r.cacheIssue)+'</p>' : "")+
    reportRecovery(run)+quickMeasureScores(run,r)+
    reportMetricGroups(remaining,r,run.manifest.id)+
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
      receipt?.status==="review"?"Review":v.pass==null?"Unscored":v.pass?"Passed":"Below threshold",esc(v.pass==null?gradingExplanation(v.reason || ""):v.reason || "")+(nativeEvidence?"<br>"+nativeEvidence:"")+(evidence?"<br>"+evidence:"")];
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
