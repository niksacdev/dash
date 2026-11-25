"use strict";

const quickGradingPlans = new Map<string,UiQuickPlan>();
function newQuickGradingPlan(id:string):UiQuickPlan {
  const attachment=readGraderAttachment("prompt:"+id);
  return {inspectionOnly:quickSession.lineups.find(l=>l.promptId===id)?.inspectionOnly===true,expectedAnswer:"",options:null,saved:new Set(attachment?.ids),designed:!!attachment && !attachment.generic,measures:new Map(),error:"",recovery:"retry",sequence:0};
}
function rememberQuickGraders(plan:UiQuickPlan,id=workflows.quick.approved?.id) {
  if (!id) return;
  const mapped=plan.options?.measures.flatMap<{index:number;id:string|null}>(({metric},index)=>{
    const editor=plan.measures.get(metric);
    if (editor?.choice.startsWith("saved:")) return [{index,id:editor.choice.slice(6)}];
    if (editor?.edited && editor.choice==="skip") return [{index,id:null}];
    return [];
  });
  const legacy=plan.measures.get("Combined outcome rubric");
  writeGraderAttachment("prompt:"+id,plan.saved,legacy?legacy.choice==="rubric":!plan.designed,mapped);
}
// Earlier approved prompts can have one combined rubric without immutable metric/criterion pairs.
function quickGradingRows(options:UiQuickOptions):UiQuickMeasure[] {
  if (options.measures.length || !options.generated) return options.measures;
  return [{metric:"Combined outcome rubric",criterion:null,generated:options.generated,reason:null}];
}
// Old runners returned the complete catalogue without any per-measure assignment support.
function graderReplyFormat(reply:unknown,approved:UiApproved):"current"|"legacy"|"invalid" {
  if (!isRecord(reply)) return "invalid";
  for (const list of [reply.available,reply.automatic,reply.recommended,reply.judges]) {
    if (!Array.isArray(list) || !list.every(item=>isRecord(item) && typeof item.id==="string")) return "invalid";
  }
  if (!(reply.generated===null || isRecord(reply.generated))) return "invalid";
  if (!Object.hasOwn(reply,"measures")) return "legacy";
  const pairs=approved.metricCriteria ?? approved.metricAudit;
  const expected=pairs ? approved.metrics : [];
  if (!Array.isArray(reply.measures) || reply.measures.length!==expected.length) return "invalid";
  const aligned=reply.measures.every((row,index)=>{
    const metric=expected[index],criterion=pairs?.find(pair=>pair.metric===metric)?.criterion ?? null;
    return isRecord(row) && row.metric===metric && row.criterion===criterion &&
      (row.reason===null || typeof row.reason==="string") && (row.generated===null || isRecord(row.generated));
  });
  return aligned?"current":"invalid";
}
function quickGraderFailure(plan:UiQuickPlan) {
  if (plan.recovery!=="restart") return readFailure("Couldn’t load graders",plan.error,"Retry");
  const quit=state.device.startsWith("darwin")?"Quit DASH with ⌘Q":"Quit DASH completely";
  return '<section class="wf-error spacer" role="alert" data-qc-restart><strong>Restart DASH to choose graders</strong>'+
    '<p>Your approved prompt is saved. The running app does not support this screen’s grader requests.</p>'+
    '<p>Copy any unsaved rubric edits. '+quit+', reopen it, then return to Quick compare.</p></section>';
}
async function loadQuickGrading(approved:UiApproved|null) {
  if (!approved) return;
  const plan=quickGradingPlans.get(approved.id) || newQuickGradingPlan(approved.id);
  quickGradingPlans.set(approved.id,plan);
  for (const other of quickGradingPlans.values()) if (other!==plan) other.expectedAnswer="";
  const sequence=++plan.sequence;
  try {
    if (typeof api.quickGraderOptions!=="function") {
      plan.recovery="restart";plan.error="Restart DASH to choose graders.";return;
    }
    const options=await api.quickGraderOptions(approved.id);
    if (sequence!==plan.sequence) return;
    const format=graderReplyFormat(options,approved);
    if (format==="legacy") {
      plan.recovery="restart";
      plan.error="Restart DASH to choose graders.";
      return;
    }
    if (format==="invalid") throw Error("The grader list was incomplete. Retry to load the saved versions for this prompt.");
    const remembered=readGraderAttachment("prompt:"+approved.id)?.mapped;
    for (const [index,row] of quickGradingRows(options).entries()) {
      const judge=row.generated?.judgeId || "";
      const existing=plan.measures.get(row.metric);
      if (existing) {
        if (!existing.edited && !plan.designed && existing.choice==="skip" && !existing.judgeId && judge && options.judges.some(j=>j.id===judge)) {
          existing.choice="rubric";existing.judgeId=judge;
        }
        continue;
      }
      const saved=options.measures.length && !row.reason && remembered?.has(index)
        ? remembered.get(index) : undefined;
      const generated=!plan.designed && row.generated && judge && options.judges.some(j=>j.id===judge) ? "rubric":"skip";
      const recovered=saved===undefined && row.generated ? restoredRubric(approved.id,index) : undefined;
      plan.measures.set(row.metric,{
        choice:recovered?"rubric":saved===undefined?generated:saved===null?"skip":"saved:"+saved,
        judgeId:recovered?.judge ?? judge,threshold:recovered ? String(recovered.cutoff ?? "") : String(row.generated?.threshold ?? 1),
        criteria:recovered?.customText ? "" : row.generated?.criteria || "",
        evidence:recovered?.evidence ?? (row.generated?.requiredEvidence?.includes("reference") ? "reference":"task-answer"),edited:!!recovered || saved!==undefined
      });
    }
    plan.options=options;plan.error="";plan.recovery="retry";
  } catch (error) {
    if(sequence!==plan.sequence) return;
    const reason=errorText(error);
    const missing=staleDesktopMethod(error) || reason.startsWith("This action is unavailable in the running version of DASH.");
    plan.recovery=missing?"restart":"retry";
    plan.error=missing?"Restart DASH to choose graders.":reason;
  }
}
function quickGradePlan() {return quickGradingPlans.get(workflows.quick.approved?.id || "");}

function quickReferenceChecks(plan:UiQuickPlan):string[] {
  const options=plan.options;
  if (!options) return [];
  const saved=new Set(plan.saved), names=new Set<string>();
  for (const row of options.measures) {
    const editor=plan.measures.get(row.metric);
    if (editor?.choice==="rubric" && editor.evidence==="reference") names.add(row.metric);
    if (editor?.choice.startsWith("saved:")) saved.add(editor.choice.slice(6));
  }
  for (const grader of [...options.automatic,...options.available.filter(g=>saved.has(g.id))]) {
    if (needsGraderReference(grader)) names.add(grader.name);
  }
  return [...names];
}
interface ScoreSetupCheck {label:string;correction?:string}
function renderScoreLanes(mode:UiMode,checks:ScoreSetupCheck[]) {
  const lanes=modelSelections[mode].lanes;
  const visible=mode==="quick" ? lanes : (lanes.some(Boolean)?lanes.filter(Boolean):[null]);
  const names=visible.map((id,i)=>rosterModels().find(model=>model.id===id)?.model || "Lane "+(i+1)+" · choose a model");
  const rows=checks.map(row=>[esc(row.label),...visible.map(id=>esc(row.correction || (id?"Can score":"Choose a model")))]);
  return '<section class="qc-score-preview"><h3>Verdict coverage</h3>'+
    (rows.length?table(["Quality check",...names],rows):'<p>Choose a quality grader to compare answers. Response diagnostics alone cannot pick a winner.</p>')+'</section>';
}
function quickScoreChecks(plan:UiQuickPlan):ScoreSetupCheck[] {
  const options=plan.options;
  if (!options) return [];
  const assigned=new Set<string>(), checks:ScoreSetupCheck[]=[];
  for (const row of quickGradingRows(options)) {
    const choice=plan.measures.get(row.metric);
    const saved=options.available.find(g=>choice?.choice==="saved:"+g.id);
    if(saved)assigned.add(saved.id);
    const correction=row.reason || (!choice || choice.choice==="skip" ? "Choose a grader" :
      saved ? (options.setupIssues?.[saved.id] || (options.diagnosticIds?.includes(saved.id)?"Choose a quality grader":"") || (needsGraderReference(saved) && !plan.expectedAnswer.trim()?"Add expected answer":"")) :
      choice.choice!=="rubric" ? "Choose an available grader" :
      !options.judges.some(j=>j.id===choice.judgeId) ? "Choose a judge" :
      !choice.criteria.trim() ? "Enter the rubric" :
      !(Number(choice.threshold)>0 && Number(choice.threshold)<=1) ? "Enter a pass threshold" :
      choice.evidence==="reference" && !plan.expectedAnswer.trim() ? "Add expected answer" : "");
    if (!options.measures.length && choice?.choice==="skip") continue;
    checks.push({label:row.metric,...(correction && {correction})});
  }
  for (const g of [...options.automatic,...options.available.filter(g=>plan.saved.has(g.id))]) {
    if(assigned.has(g.id) || options.diagnosticIds?.includes(g.id))continue;
    assigned.add(g.id);
    const correction=options.setupIssues?.[g.id] || (needsGraderReference(g) && !plan.expectedAnswer.trim()?"Add expected answer":"");
    checks.push({label:g.name,...(correction && {correction})});
  }
  return checks;
}
function quickCoverageIssue(plan:UiQuickPlan) {
  const checks=quickScoreChecks(plan),missing=checks.find(check=>check.correction);
  if(missing)return missing.label+" · "+missing.correction+".";
  if(!checks.length)return "Choose a quality grader for the comparison.";
  return "";
}
function quickScoreReadiness(plan:UiQuickPlan) {
  const gap=quickCoverageIssue(plan);
  return renderScoreLanes("quick",quickScoreChecks(plan))+(gap?'<label class="choice"><input type="checkbox" data-qc-inspect '+(plan.inspectionOnly?'checked':'')+'>Inspect answers without a quality verdict</label>':'');
}
function quickLaunchLabel() {
  const plan=quickGradePlan();
  return plan?.inspectionOnly && quickCoverageIssue(plan)?"Run answer inspection":"Run evaluation";
}
function quickGradePayload(plan?:UiQuickPlan):Pick<UiStartRun,"inspectionOnly"|"graderIds"|"measureGraders"|"outcomeRubric"|"expectedAnswer"> {
  if (!plan?.options) return {graderIds:[]};
  const ids=new Set(plan.saved);
  const expectedAnswer=plan.expectedAnswer.trim();
  const evidence={...(expectedAnswer && quickReferenceChecks(plan).length && {expectedAnswer}),...(plan.inspectionOnly && quickCoverageIssue(plan) && {inspectionOnly:true as const})};
  if (!plan.options.measures.length) {
    const legacy=plan.measures.get("Combined outcome rubric");
    return {graderIds:[...ids],...evidence,...(legacy?.choice==="rubric" && {outcomeRubric:{type:"opik",
      judgeId:legacy.judgeId,criteria:legacy.criteria.trim(),threshold:Number(legacy.threshold)}})};
  }
  const measureGraders=plan.options.measures.map(({metric}):UiMeasureAssignment=>{
    const editor=plan.measures.get(metric);
    if (editor?.choice==="rubric") return {metric,kind:"rubric",judgeId:editor.judgeId,
      criteria:editor.criteria.trim(),threshold:Number(editor.threshold),evidence:editor.evidence};
    if (editor?.choice.startsWith("saved:")) {
      const graderId=editor.choice.slice(6);
      ids.add(graderId); // Also include mapped hosted graders in the existing destination consent.
      return {metric,kind:"saved",graderId};
    }
    return {metric,kind:"skip"};
  });
  return {graderIds:[...ids],measureGraders,...evidence};
}
function quickGraderCount(payload:ReturnType<typeof quickGradePayload>) {
  return payload.graderIds.length+(payload.measureGraders?.filter(r=>r.kind==="rubric").length ?? 0)+Number(!!payload.outcomeRubric);
}
function quickGradeIssue(plan?:UiQuickPlan) {
  if (!plan?.options || plan.error) return plan?.error || "Loading grader options.";
  if(plan.options.scoringVersion!==1)return "Quit and reopen DASH to verify scoring readiness before running.";
  const {graderIds,measureGraders=[],outcomeRubric}=quickGradePayload(plan);
  const unavailable=[...plan.options.automatic.map(g=>g.id),...graderIds].map(id=>plan.options?.setupIssues?.[id]).find(Boolean);
  if(unavailable)return unavailable;
  if (graderIds.some(id=>!plan.options?.available.some(g=>g.id===id))) return "A selected grader version is unavailable. Refresh grading options or change the selection.";
  if (quickReferenceChecks(plan).length) {
    if (plan.options.expectedAnswerVersion!==1) return "Quit and reopen DASH to supply an expected answer before running this grader.";
    if (!plan.expectedAnswer.trim()) return "Add the expected answer or verified facts below, or choose a check that uses the task and answer alone.";
  }
  const mapped=new Set<string>();
  const assignments = outcomeRubric ? [{...outcomeRubric,metric:"Combined outcome rubric",kind:"rubric" as const}] : measureGraders;
  for (const row of assignments) {
    if (row.kind==="saved") {
      if (mapped.has(row.graderId)) return "Assign a different grader to each measure to get independent scores.";
      mapped.add(row.graderId);
    } else if (row.kind==="rubric") {
      if (!plan.options.judges.some(j=>j.id===row.judgeId)) return "Choose a connected judge for "+row.metric+".";
      if (!row.criteria) return "Enter the scoring rubric for "+row.metric+".";
      if (!(row.threshold>0 && row.threshold<=1)) return "Set a pass threshold above 0 and at most 1 for "+row.metric+".";
    }
  }
  if(quickGraderCount({graderIds,measureGraders,outcomeRubric})>8)return "Choose up to eight distinct graders.";
  return plan.inspectionOnly ? "" : quickCoverageIssue(plan);
}
function quickGradeSummary() {
  const plan=quickGradePlan(),issue=quickGradeIssue(plan);
  if (!plan?.options || issue) return {workload:issue,coverage:""};
  const {measureGraders=[],graderIds,outcomeRubric}=quickGradePayload(plan);
  const selected=plan.options.available.filter(g=>graderIds.includes(g.id));
  const available=(g:UiGrader)=>(!needsGraderReference(g) || !!plan.expectedAnswer.trim()) && !g.requiredEvidence?.includes("trajectory");
  const runsModel=(g:UiGrader)=>["judge","opik","decision","opik-metric"].includes(g.type);
  const runnable=(r:UiMeasureAssignment)=>r.kind==="rubric" ? (r.evidence==="task-answer" || !!plan.expectedAnswer.trim()) :
    r.kind==="saved" && selected.some(g=>g.id===r.graderId && available(g));
  const judgeRubrics=measureGraders.filter(r=>r.kind==="rubric" && runnable(r));
  const uniqueChecks=new Map([...selected,...plan.options.automatic].map(g=>[g.id,g]));
  const checks=[...uniqueChecks.values()].filter(available);
  const modelGrades=judgeRubrics.length+Number(!!outcomeRubric)+checks.filter(runsModel).length;
  const rules=checks.filter(g=>!runsModel(g)).length;
  const judges=new Set(judgeRubrics.flatMap(r=>r.kind==="rubric"?[r.judgeId]:[]));
  if (outcomeRubric) judges.add(outcomeRubric.judgeId);
  for (const grader of checks) if (grader.judge) judges.add(grader.judge.id);
  const count=measureGraders.filter(runnable).length;
  const workload=(measureGraders.length?count+" of "+measureGraders.length+" measures ready · ":"")+
    "2 answers × "+modelGrades+" model "+(modelGrades===1?"grader":"graders")+" = "+(modelGrades*2)+" model evaluations"+
    (rules?" · "+(rules*2)+" deterministic checks":"")+
    (selectedModels().some(id=>judges.has(id))?" · a selected candidate is also a judge":"");
  const coverage=measureGraders.length ? (count===measureGraders.length ? count : count+" / "+measureGraders.length)+" "+(measureGraders.length===1?"measure":"measures")+" covered" : "";
  return {workload,coverage};
}
function quickSetupCounts(coverage:string) {
  const count=selectedModels().length;
  return [count+" "+(count===1?"model":"models")+" selected",coverage].filter(Boolean).join(" · ");
}
function quickMeasureRow(row:UiQuickMeasure,index:number,plan:UiQuickPlan,options:UiQuickOptions) {
  const editor=plan.measures.get(row.metric);
  if (!editor) return "";
  const legacy=!options.measures.length;
  const criterion=row.criterion ? '<span class="qc-condition">Pass condition · '+esc(row.criterion)+'</span>' : "";
  const selected=options.available.find(g=>editor.choice==="saved:"+g.id);
  const blocked=(!row.criterion && !legacy) || !!row.reason;
  const policyLabel=blocked || editor.choice==="skip" ? "Unscored" : selected ? selected.name+" · v"+selected.version :
    editor.choice==="rubric" ? "Opik G-Eval · "+(editor.evidence==="reference" ? "Uses expected answer" : "Run rubric") : "Grader unavailable";
  const head='<div class="qc-measure" data-qc-measure="'+index+'"><details class="qc-assignment"><summary><span><strong>'+esc(row.metric)+
    '</strong><small>'+esc(policyLabel)+'</small>'+criterion+'</span></summary><div class="qc-assignment-body">';
  const action=blocked ? "" : editor.choice!=="skip" ? graderSelectionButton("data-qc-toggle",String(index),"Remove","grader for "+row.metric+" from this comparison") :
    graderSelectionButton("data-qc-toggle",String(index),editor.removedChoice?"Restore":"Choose","grader for "+row.metric);
  const end='</div></details>'+action+'</div>';
  if (blocked) return head+'<small>'+esc(row.reason || "This measure has no approved pass condition.")+'</small>'+end;
  const current=editor.choice;
  const unavailable=current.startsWith("saved:") && !selected;
  const select=formField("Grader",'<select data-qc-field="choice">'+
    (row.generated?opt("rubric",legacy?"Opik G-Eval combined rubric":"Opik G-Eval for this measure",current):"")+
    opt("skip","Leave unscored",current)+
    (!legacy && options.available.length?'<optgroup label="Saved grader versions">'+options.available.map(g=>opt("saved:"+g.id,g.name+" · v"+g.version,current)).join("")+'</optgroup>':"")+
    (unavailable?opt(current,"Unavailable grader version",current):"")+'</select>');
  let policy="";
  if (current==="rubric" && row.generated) {
    const judge=options.judges.find(j=>j.id===editor.judgeId);
    policy='<small data-qc-policy-status>'+esc(judge?judge.model:"Choose a judge")+' · pass threshold '+esc(editor.threshold)+'</small>'+
      '<details class="qc-rubric-options"><summary>Edit rubric and judge</summary>'+
      formField("Scoring rubric",'<textarea data-qc-field="criteria" maxlength="6000">'+esc(editor.criteria)+'</textarea>')+
      '<div class="qc-judge-fields">'+formField("Judge model",'<select data-qc-field="judgeId">'+opt("","Choose a local judge",editor.judgeId)+options.judges.map(j=>opt(j.id,j.model+" · "+j.provider,editor.judgeId)).join("")+'</select>')+
      formField("Pass threshold (0–1)",'<input data-qc-field="threshold" type="number" min="0" max="1" step="any" value="'+esc(editor.threshold)+'">')+
      (legacy?"":formField("Evidence",'<select data-qc-field="evidence">'+opt("task-answer","Task and candidate answer",editor.evidence)+opt("reference","Expected answer or verified facts",editor.evidence)+'</select>'))+'</div></details>';
  } else if (selected) {
    policy='<small>'+esc(selected.name)+' v'+esc(selected.version)+' · pass threshold '+esc(selected.threshold)+'</small>'+
      '<details class="qc-rubric-options"><summary>View grader rule</summary><p class="qc-rubric-preview">'+esc(selected.criteria)+'</p></details>';
    if (needsGraderReference(selected)) policy+='<small>Uses the expected answer supplied for this comparison.</small>';
  }
  if (current==="rubric" && !editor.criteria && row.generated) policy+=
    '<p>Custom rubric text stays in the editing session. Re-enter the rubric or restore the proposed wording before running.</p>'+
    '<button type="button" data-restore-quick-rubric="'+index+'">Use proposed rubric</button>';
  return head+select+policy+end;
}
function quickSelectedVersions(plan:UiQuickPlan) {
  const mapped=new Map<string,string>();
  for (const [metric,editor] of plan.measures) if(editor.choice.startsWith("saved:")) mapped.set(editor.choice.slice(6),metric);
  return selectedRunGraders("quick","prompt:"+workflows.quick.approved?.id,[...plan.saved,...mapped.keys()],mapped);
}
function quickGradePicker() {
  const plan=quickGradePlan(),options=plan?.options;
  const scope="prompt:"+workflows.quick.approved?.id;
  if(!plan || !options || plan.error)return runGraderPanel("quick",scope,plan?quickSelectedVersions(plan):selectedRunGraders("quick",scope,[]),
    plan?.error?quickGraderFailure(plan):'<p role="status">Loading grading options…</p>');
  const checks=quickReferenceChecks(plan);
  const example=workflows.quick.approved?.domain==="Manufacturing" ? "Drawing B allows up to 10.03 mm. Sample S1 measured 10.04 mm and needs a signed recheck." :
    "The Q2 release reports diluted GAAP EPS of $0.74 and adjusted diluted EPS of $0.85.";
  const expected='<section class="qc-expected" data-qc-expected '+(checks.length?'':'hidden')+'><label for="qc-expected-answer">Expected answer or verified facts</label>'+
    '<p id="qc-expected-help">Give the correct result a reviewer would accept. Both candidates receive the approved task. The checks listed here receive these facts when grading their answers.</p>'+
    '<small id="qc-expected-checks">'+esc(checks.join(" · "))+'</small><textarea id="qc-expected-answer" rows="3" maxlength="12000" aria-describedby="qc-expected-help qc-expected-checks" placeholder="'+esc("Example: "+example)+'" '+
    (checks.length?'required':'disabled')+'>'+esc(plan.expectedAnswer)+'</textarea></section>';
  const missing=[...plan.saved].some(id=>!options.available.some(g=>g.id===id));
  const controls='<h3 class="qc-line-label">Approved measures</h3>'+
    quickGradingRows(options).map((m,i)=>quickMeasureRow(m,i,plan,options)).join("")+
    (!options.measures.length?'<p>This prompt version has no individually paired measures and pass conditions. Any combined rubric produces one score per answer.</p>':"")+
    expected+'<div id="qc-score-readiness">'+quickScoreReadiness(plan)+'</div>'+
    (missing?'<button type="button" data-qc-unavailable>Remove unavailable additional graders</button>':"")+'<p id="qc-grade-status">'+esc(quickGradeSummary().workload)+'</p>';
  return runGraderPanel("quick",scope,quickSelectedVersions(plan),controls,options.automatic);
}
function updateQuickGradingControls() {
  const text=document.getElementById("qc-grade-status"),go=dashElement(".qc-launch .go-button",HTMLButtonElement);
  const status=document.getElementById("qc-launch-state");
  const summary=quickGradeSummary();
  if (text) text.textContent=summary.workload;
  const counts=document.getElementById("qc-setup-counts");
  if(counts)counts.textContent=quickSetupCounts(summary.coverage);
  if (status) status.textContent=quickLaunchIssue() || "Ready to evaluate both answers.";
  if (go) {go.disabled=!canStartQuick();go.innerHTML=quickLaunchLabel()+' <b aria-hidden="true">❯</b>';}
  const plan=quickGradePlan(),attached=document.querySelector(".qc-attached");
  if (attached && plan?.options) {
    const preview=document.getElementById("qc-score-readiness");
    if(preview){const focused=preview.contains(document.activeElement);preview.innerHTML=quickScoreReadiness(plan);if(focused)preview.querySelector<HTMLInputElement>("input")?.focus({preventScroll:true});}
    attached.innerHTML=quickSelectedVersions(plan);
    const checks=quickReferenceChecks(plan);
    const section=document.querySelector<HTMLElement>("[data-qc-expected]");
    const input=document.querySelector<HTMLTextAreaElement>("#qc-expected-answer");
    if (section && input) {
      section.hidden=!checks.length;
      input.disabled=!checks.length;
      input.required=!!checks.length;
      const names=document.getElementById("qc-expected-checks");
      if (names) names.textContent=checks.join(" · ");
    }
  }
}
function changeQuickGrader(plan:UiQuickPlan,editor:UiMeasureEditor,choice:string) {
  if (editor.choice.startsWith("saved:")) plan.saved.delete(editor.choice.slice(6));
  if (choice.startsWith("saved:")) plan.saved.delete(choice.slice(6));
  editor.choice=choice;
  editor.edited=true;
  delete editor.removedChoice;
}
document.addEventListener("click",async e=>{
  if (!(e.target instanceof Element)) return;
  const restore=e.target.closest<HTMLElement>("[data-restore-quick-rubric]");
  if (restore) {
    const plan=quickGradePlan(),row=plan?.options && quickGradingRows(plan.options)[Number(restore.dataset.restoreQuickRubric)];
    const editor=row && plan?.measures.get(row.metric);
    if (row?.generated && editor) {editor.criteria=row.generated.criteria;rememberQuickLineup();await render();}
    return;
  }
  const toggle=e.target.closest<HTMLButtonElement>("[data-qc-toggle]");
  if (toggle) {
    const plan=quickGradePlan(),index=Number(toggle.dataset.qcToggle);
    const row=plan?.options && quickGradingRows(plan.options)[index],editor=row && plan?.measures.get(row.metric);
    const host=toggle.closest<HTMLElement>("[data-qc-measure]");
    if (!plan?.options || !row || !editor || !host) return;
    if (editor.choice==="skip" && !editor.removedChoice) {
      requireElement(".qc-assignment",HTMLDetailsElement,host).open=true;
      requireElement("[data-qc-field=choice]",HTMLSelectElement,host).focus();return;
    }
    const previous=editor.choice;
    changeQuickGrader(plan,editor,editor.removedChoice ?? "skip");
    if (previous!=="skip") editor.removedChoice=previous;
    rememberQuickGraders(plan);rememberQuickLineup();
    host.outerHTML=quickMeasureRow(row,index,plan,plan.options);updateQuickGradingControls();
    document.querySelector<HTMLButtonElement>('[data-qc-toggle="'+index+'"]')?.focus({preventScroll:true});return;
  }
  if (e.target.closest("[data-qc-unavailable]")) {
    const plan=quickGradePlan();
    if (!plan?.options) return;
    for (const id of plan.saved) if (!plan.options.available.some(g=>g.id===id)) plan.saved.delete(id);
    rememberQuickGraders(plan);
    $("#qc-grading").outerHTML=quickGradePicker();updateQuickGradingControls();
  }
});
function handleQuickGradingField(e:Event) {
  const target=e.target,plan=quickGradePlan();
  if (!textInput(target) || !plan?.options || !target.closest("#qc-grading")) return;
  if (target instanceof HTMLInputElement && target.hasAttribute("data-qc-inspect")) {
    if(e.type==="change"){plan.inspectionOnly=target.checked;rememberQuickLineup();updateQuickGradingControls();}return;
  }
  if (target.id==="qc-expected-answer") {
    plan.expectedAnswer=target.value;
    updateQuickGradingControls();return;
  }
  {
    const field=target.dataset.qcField,fieldset=target.closest<HTMLElement>("[data-qc-measure]");
    const index=Number(fieldset?.dataset.qcMeasure),row=quickGradingRows(plan.options)[index];
    const editor=row && plan.measures.get(row.metric);
    if (!field || !fieldset || !editor) return;
    editor.edited=true;
    if (field==="judgeId" || field==="criteria" || field==="threshold") editor[field]=target.value;
    else if (field==="evidence" && (target.value==="reference" || target.value==="task-answer")) editor.evidence=target.value;
    else if (field==="choice") changeQuickGrader(plan,editor,target.value);
    if (e.type==="change") {
      if (field==="choice") rememberQuickGraders(plan);
      rememberQuickLineup();
    }
    if (e.type==="change" && field!=="criteria" && field!=="threshold") {
      const open=fieldset.querySelector("details")?.open;
      const optionsOpen=fieldset.querySelector<HTMLDetailsElement>(".qc-rubric-options")?.open;
      const html=quickMeasureRow(row,index,plan,plan.options);
      fieldset.outerHTML=html;
      const next=document.querySelector<HTMLElement>('[data-qc-measure="'+index+'"]');
      const details=next?.querySelector("details");
      if (details && open) details.open=true;
      const optionsDetail=next?.querySelector<HTMLDetailsElement>(".qc-rubric-options");
      if(optionsDetail && optionsOpen)optionsDetail.open=true;
      next?.querySelector<HTMLElement>('[data-qc-field="'+field+'"]')?.focus({preventScroll:true});
    }
    if (field==="threshold") {
      const status=fieldset.querySelector("[data-qc-policy-status]");
      if (status?.tagName==="SMALL") status.textContent=(plan.options.judges.find(j=>j.id===editor.judgeId)?.model || "Choose a judge")+" · pass threshold "+editor.threshold;
    }
  }
  updateQuickGradingControls();
}
document.addEventListener("input",handleQuickGradingField);
document.addEventListener("change",handleQuickGradingField);
