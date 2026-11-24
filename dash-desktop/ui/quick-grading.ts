"use strict";

const quickGradingPlans = new Map<string,UiQuickPlan>();
function newQuickGradingPlan(id:string):UiQuickPlan {
  const attachment=readGraderAttachment("prompt:"+id);
  return {options:null,saved:new Set(attachment?.ids),designed:!!attachment && !attachment.generic,measures:new Map(),error:"",sequence:0};
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
async function loadQuickGrading(approved:UiApproved|null) {
  if (!approved) return;
  const plan=quickGradingPlans.get(approved.id) || newQuickGradingPlan(approved.id);
  quickGradingPlans.set(approved.id,plan);
  const sequence=++plan.sequence;
  try {
    const options=await api.quickGraderOptions(approved.id);
    if (sequence!==plan.sequence) return;
    if (!Array.isArray(options.measures)) throw Error("Reopen the updated DASH app to map approved measures to graders.");
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
    plan.options=options;plan.error="";
  } catch (error) {if(sequence===plan.sequence) plan.error=errorText(error);}
}
function quickGradePlan() {return quickGradingPlans.get(workflows.quick.approved?.id || "");}

function quickGradePayload(plan?:UiQuickPlan):Pick<UiStartRun,"graderIds"|"measureGraders"|"outcomeRubric"> {
  if (!plan?.options) return {graderIds:[]};
  const ids=new Set(plan.saved);
  if (!plan.options.measures.length) {
    const legacy=plan.measures.get("Combined outcome rubric");
    return {graderIds:[...ids],...(legacy?.choice==="rubric" && {outcomeRubric:{type:"opik",
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
  return {graderIds:[...ids],measureGraders};
}
function quickGraderCount(payload:ReturnType<typeof quickGradePayload>) {
  return payload.graderIds.length+(payload.measureGraders?.filter(r=>r.kind==="rubric").length ?? 0)+Number(!!payload.outcomeRubric);
}
function quickGradeIssue(plan?:UiQuickPlan) {
  if (!plan?.options || plan.error) return plan?.error || "Loading grader options.";
  const {graderIds,measureGraders=[],outcomeRubric}=quickGradePayload(plan);
  if (graderIds.some(id=>!plan.options?.available.some(g=>g.id===id))) return "A selected grader version is unavailable. Refresh grading options or change the selection.";
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
  return quickGraderCount({graderIds,measureGraders,outcomeRubric})>8 ? "Choose up to eight distinct graders." : "";
}
function quickGradeSummary() {
  const plan=quickGradePlan(),issue=quickGradeIssue(plan);
  if (!plan?.options || issue) return {workload:issue,coverage:""};
  const {measureGraders=[],graderIds,outcomeRubric}=quickGradePayload(plan);
  const selected=plan.options.available.filter(g=>graderIds.includes(g.id));
  const available=(g:UiGrader)=>!needsGraderReference(g) && !g.requiredEvidence?.includes("trajectory");
  const runsModel=(g:UiGrader)=>["judge","opik","decision","opik-metric"].includes(g.type);
  const runnable=(r:UiMeasureAssignment)=>r.kind==="rubric" ? r.evidence==="task-answer" :
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
    editor.choice==="rubric" ? "Opik G-Eval · "+(editor.evidence==="reference" ? "Needs reference" : "Run rubric") : "Grader unavailable";
  const head='<div class="qc-measure" data-qc-measure="'+index+'"><details class="qc-assignment"><summary><span><strong>'+esc(row.metric)+
    '</strong><small>'+esc(policyLabel)+'</small>'+criterion+'</span></summary><div class="qc-assignment-body">';
  const end='</div></details></div>';
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
      (legacy?"":formField("Evidence",'<select data-qc-field="evidence">'+opt("task-answer","Task and candidate answer",editor.evidence)+opt("reference","Require a separate reference",editor.evidence)+'</select>'))+'</div></details>';
    if (editor.evidence==="reference") policy+='<small>Unscored in Quick compare. Use a labeled Dataset run for an independent reference, or choose task and answer if they contain all the evidence.</small>';
  } else if (selected) {
    policy='<small>'+esc(selected.name)+' v'+esc(selected.version)+' · pass threshold '+esc(selected.threshold)+'</small>'+
      '<details class="qc-rubric-options"><summary>View grader rule</summary><p class="qc-rubric-preview">'+esc(selected.criteria)+'</p></details>';
    if (needsGraderReference(selected) || selected.requiredEvidence?.includes("trajectory"))
      policy+='<small>Unscored in Quick compare. This grader needs a separate reference or an agent trace.</small>';
  }
  if (current==="rubric" && !editor.criteria && row.generated) policy+=
    '<p>Custom rubric text stays in the editing session. Re-enter the rubric or restore the proposed wording before running.</p>'+
    '<button type="button" data-restore-quick-rubric="'+index+'">Use proposed rubric</button>';
  return head+select+policy+end;
}
function quickAdditionalVersions(plan:UiQuickPlan,options:UiQuickOptions) {
  const mapped=new Set([...plan.measures.values()].map(editor=>editor.choice));
  const extras=options.available.filter(g=>plan.saved.has(g.id) && !mapped.has("saved:"+g.id));
  return extras.length ? '<h3 class="qc-line-label">Additional graders</h3><ul class="qc-additional-versions">'+extras.map(g=>{
    const label=g.name+" · v"+g.version;
    return '<li><span>'+esc(label)+'</span><button type="button" data-qc-extra-remove="'+esc(g.id)+'" aria-label="Remove '+esc(label)+'">Remove</button></li>';
  }).join("")+'</ul>' : "";
}
function quickGradePicker() {
  const plan=quickGradePlan(),options=plan?.options;
  const heading='<div class="qc-section-title"><h2>Graders</h2>'+chooseQuickGradersLink()+'</div>';
  if (!plan || !options || plan.error) return '<section id="qc-grading" class="qc-grading" tabindex="-1" aria-label="Grading plan">'+heading+'<p role="status">'+esc(plan?.error || "Loading grading options…")+'</p><button type="button" data-qc-reload>Reload grading options</button></section>';
  const missing=[...plan.saved].some(id=>!options.available.some(g=>g.id===id));
  return '<section id="qc-grading" class="qc-grading" tabindex="-1" aria-label="Grading plan">'+heading+
    '<h3 class="qc-line-label">Approved measures</h3>'+
    quickGradingRows(options).map((m,i)=>quickMeasureRow(m,i,plan,options)).join("")+
    (!options.measures.length?'<p>This prompt version has no individually paired measures and pass conditions. Any combined rubric produces one score per answer.</p>':"")+
    '<div class="qc-attached">'+quickAdditionalVersions(plan,options)+'</div>'+
    (missing?'<button type="button" data-qc-unavailable>Remove unavailable additional graders</button>':"")+(options.automatic.length?'<details class="qc-auto-options"><summary>Automatic checks · '+options.automatic.length+'</summary>'+automaticChecks(options.automatic)+'</details>':'')+'<p id="qc-grade-status">'+esc(quickGradeSummary().workload)+'</p></section>';
}
function updateQuickGradingControls() {
  const text=document.getElementById("qc-grade-status"),go=dashElement(".qc-launch .go-button",HTMLButtonElement);
  const status=document.getElementById("qc-launch-state");
  const summary=quickGradeSummary();
  if (text) text.textContent=summary.workload;
  const counts=document.getElementById("qc-setup-counts");
  if(counts)counts.textContent=quickSetupCounts(summary.coverage);
  if (status) status.textContent=quickLaunchIssue() || "Ready to evaluate both answers.";
  if (go) go.disabled=!canStartQuick();
  const plan=quickGradePlan(),attached=document.querySelector(".qc-attached");
  if (attached && plan?.options) attached.innerHTML=quickAdditionalVersions(plan,plan.options);
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
  if (e.target.closest("[data-qc-reload]")) {await render();return;}
  const remove=e.target.closest<HTMLButtonElement>("[data-qc-extra-remove]");
  if(remove?.dataset.qcExtraRemove) {
    const plan=quickGradePlan();
    if(!plan)return;
    plan.saved.delete(remove.dataset.qcExtraRemove);rememberQuickGraders(plan);updateQuickGradingControls();
    document.querySelector<HTMLElement>(".qc-attached button, #qc-grading a")?.focus({preventScroll:true});return;
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
  {
    const field=target.dataset.qcField,fieldset=target.closest<HTMLElement>("[data-qc-measure]");
    const index=Number(fieldset?.dataset.qcMeasure),row=quickGradingRows(plan.options)[index];
    const editor=row && plan.measures.get(row.metric);
    if (!field || !fieldset || !editor) return;
    editor.edited=true;
    if (field==="judgeId" || field==="criteria" || field==="threshold") editor[field]=target.value;
    else if (field==="evidence" && (target.value==="reference" || target.value==="task-answer")) editor.evidence=target.value;
    else if (field==="choice") editor.choice=target.value;
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
