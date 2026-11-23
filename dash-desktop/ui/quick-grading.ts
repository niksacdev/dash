"use strict";
const quickGradingPlans = new Map<string,UiQuickPlan>();
function newQuickGradingPlan(id:string) {
  const attachment=readGraderAttachment("prompt:"+id);
  return {options:null, saved:new Set(attachment?.ids), enabled:!!attachment?.generic, designed:!!attachment,
    criteria:"", judgeId:"", threshold:1, error:"", sequence:0};
}
function rememberQuickGraders(plan:UiQuickPlan) {
  if (workflows.quick.approved) {
    plan.designed=true;
    writeGraderAttachment("prompt:"+workflows.quick.approved.id,plan.saved,plan.enabled);
  }
}
async function loadQuickGrading(approved:UiApproved|null) {
  if (!approved) return;
  const plan = quickGradingPlans.get(approved.id) || newQuickGradingPlan(approved.id);
  quickGradingPlans.set(approved.id, plan);
  const sequence = ++plan.sequence;
  try {
    if (typeof api.quickGraderOptions !== "function")
      throw Error("Reopen DASH to load grading suggestions for this prompt.");
    const options = await api.quickGraderOptions(approved.id);
    if (sequence !== plan.sequence) return;
    if (!plan.options) {
      plan.criteria = options.generated?.criteria || "";
      plan.judgeId = options.generated?.judgeId || "";
      plan.threshold = options.generated?.threshold ?? 1;
      if (!plan.designed) plan.enabled = !!plan.judgeId && options.judges.some(j=>j.id===plan.judgeId) && !!plan.criteria;

    }
    plan.options=options;
    plan.error="";
  } catch (error) {
    if (sequence===plan.sequence) plan.error=errorText(error);
  }
}
function quickGradePlan() {
  return quickGradingPlans.get(workflows.quick.approved?.id || "");
}
function quickGradePayload(plan?:UiQuickPlan) {
  if (!plan) return {graderIds:[]};
  const graderIds=[...plan.saved];
  if (!plan.enabled) return {graderIds};
  return {graderIds, outcomeRubric:{criteria:plan.criteria.trim(),judgeId:plan.judgeId,threshold:Number(plan.threshold),type:"opik" as const}};
}
function quickGradeIssue(plan?:UiQuickPlan) {
  if (!plan) return "";
  if (plan.error && (plan.enabled || plan.saved.size)) return "Reload grading options or clear the current graders to continue.";
  if (plan.saved.size+Number(plan.enabled)>8) return "Choose up to eight graders.";
  if (plan.options && [...plan.saved].some(id=>!plan.options?.available.some(g=>g.id===id)))
    return "A selected grader is unavailable. Refresh grading options and choose its replacement.";
  if (!plan.enabled) return "";
  if (!plan.options?.judges?.some(j=>j.id===plan.judgeId)) return "Choose a connected judge model to score both responses.";
  if (!plan.criteria.trim()) return "Enter the criteria the judge will use.";
  if (!(Number(plan.threshold)>0 && Number(plan.threshold)<=1)) return "Set a pass threshold above 0 and at most 1.";
  return "";
}
function quickGradeStatus() {
  const plan=quickGradePlan(), issue=quickGradeIssue(plan);
  if (issue) return issue;
  const count=(plan?.saved.size || 0) + Number(!!plan?.enabled);
  if (!plan || !count) return plan?.options?.automatic.length ? "Automatic checks only" : "No graders selected";
  const judge=plan.enabled && plan.options?.judges.find(j=>j.id===plan.judgeId);
  const pinnedJudges=new Set((plan.options?.available || []).filter(g=>plan.saved.has(g.id)).map(g=>g.judge?.id).filter(Boolean));
  if (judge) pinnedJudges.add(judge.id);
  const shared=selectedModels().some(id=>pinnedJudges.has(id));
  return count+" active "+(count===1?"grader":"graders") + (judge?" · "+judge.model+" judges both responses":" · scoring both responses") +
    (shared?" · a selected candidate is also a judge":"");
}
function quickGradePicker() {
  const plan=quickGradePlan(), options=plan?.options;
  if (!plan || !options || plan.error) return '<section id="qc-grading" class="qc-grading"><h2>Score the responses</h2><p role="status">'+
    esc(plan?.error || "Grading options are loading.")+'</p><button type="button" data-qc-reload>Reload grading options</button>'+(plan?.enabled || plan?.saved.size?'<button type="button" data-qc-clear>Clear graders</button>':'')+'</section>';
  const reasons=new Map(options.recommended.map(g=>[g.id,g.reason]));
  const generated=options.generated, judges=options.judges || [];
  const judge=judges.find(j=>j.id===plan.judgeId);
  const unavailable=[...plan.saved].filter(id=>!options.available.some(g=>g.id===id));
  return '<section id="qc-grading" class="qc-grading"><div class="qc-section-title"><h2>Score the responses</h2>'+
    link("Grader library →","graders","link")+'</div>'+automaticChecks(options.automatic)+
    (generated?'<div class="qc-outcome"><div class="qc-section-title"><div><strong>Opik G-Eval outcome rubric</strong><small>'+
      esc(generated.industry)+' · '+(plan.enabled && judge ? esc(judge.model)+' scores both responses':'evaluate the approved measures')+'</small></div><button id="qc-rubric-toggle" type="button" title="'+(plan.enabled?"Disable the suggested judge":"Enable the suggested judge")+'" aria-pressed="'+plan.enabled+'" '+
      'aria-controls="qc-rubric-settings">'+(plan.enabled?"✓ Judge enabled":"Add outcome judge")+'</button></div>'+
      '<details class="qc-rubric-options"><summary>'+(plan.enabled?'Review rubric, judge and threshold':'Preview suggested rubric')+'</summary>'+
      '<div id="qc-rubric-settings">'+
      (plan.enabled ? '<label class="field"><span>Rubric criteria</span><textarea id="qc-criteria" maxlength="6000" required>'+esc(plan.criteria)+'</textarea></label>'+
        '<div class="qc-judge-fields"><label class="field"><span>Judge model</span><select required id="qc-judge">'+opt("","Choose a local judge",plan.judgeId)+judges.map(j=>
        opt(j.id, j.model+" · "+j.provider+(j.loaded?" · loaded":""),plan.judgeId)).join("")+'</select></label>'+
        '<label class="field"><span>Pass threshold (0–1)</span><input id="qc-threshold" type="number" min="0" max="1" step="any" required value="'+esc(plan.threshold)+'"></label></div>'+
        '<small>DASH saves this rubric in the grader library when the run starts.</small>':
        '<p class="qc-rubric-preview">'+esc(plan.criteria)+'</p>')+'</div></details></div>':'')+
    (options.available.length?'<details class="qc-saved"><summary>Optional saved graders · '+plan.saved.size+' selected</summary>'+
      catalogChoices(options.available,plan.saved,"qc-saved-grader",reasons)+'</details>':'')+
    (unavailable.length?'<button type="button" data-qc-unavailable>Remove unavailable graders</button>':'')+'</section>';
}
function updateQuickGradingControls() {
  const text=document.getElementById("qc-grade-status"), go=dashElement("#quick-models .go-button",HTMLButtonElement);
  if (text) text.textContent=quickGradeStatus();
  if (go) go.disabled=!canStartQuick();
}
document.addEventListener("click", async e=>{
  if (!(e.target instanceof Element)) return;

  if (e.target.closest("[data-qc-reload]")) {await render(); return;}
  if (e.target.closest("[data-qc-clear],[data-qc-unavailable]")) {
    const p=quickGradePlan();
    if (!p) return;
    if (e.target.closest("[data-qc-clear]")) {p.saved.clear();p.enabled=false;}
    else for (const id of p.saved) if (!p.options?.available.some(g=>g.id===id)) p.saved.delete(id);
    rememberQuickGraders(p);
    $("#qc-grading").outerHTML=quickGradePicker(); updateQuickGradingControls(); return;
  }
  const button=e.target.closest("#qc-rubric-toggle");
  if (!button) return;
  const plan=quickGradePlan();
  if (!plan || workflows.quick.busy) return;
  plan.enabled=!plan.enabled;
  rememberQuickGraders(plan);
  $("#qc-grading").outerHTML=quickGradePicker();
  document.getElementById("qc-rubric-toggle")?.focus({preventScroll:true});
  updateQuickGradingControls();
});
function handleQuickGradingField(target:EventTarget|null) {
  const plan=quickGradePlan();
  if (!textInput(target) || !plan || !target.closest("#qc-grading")) return;
  if (target.name==="qc-saved-grader") {
    if (target instanceof HTMLInputElement && target.checked) plan.saved.add(target.value); else plan.saved.delete(target.value);
    rememberQuickGraders(plan);
    const summary=target.closest("details.qc-saved")?.querySelector("summary");
    if(summary)summary.textContent="Optional saved graders · "+plan.saved.size+" selected";
  } else {
    if (target.id==="qc-criteria") plan.criteria=target.value;
    else if (target.id==="qc-threshold") plan.threshold=target.value;
    else if (target.id==="qc-judge") plan.judgeId=target.value;
  }
  updateQuickGradingControls();
}
document.addEventListener("input",e=>handleQuickGradingField(e.target));
document.addEventListener("change",e=>handleQuickGradingField(e.target));
