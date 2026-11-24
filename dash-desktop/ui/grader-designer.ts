"use strict";

const graderDesignDrafts = new Map<string,UiGraderDraft>();
let workspaceGradeScope = "custom";

function gradeScopeRecord(scope:string) {
  if (scope.startsWith("prompt:")) return (state.prompts || []).find(p=>p.id===scope.slice(7));
  if (scope.startsWith("dataset:")) return state.datasets.find(d=>d.id===scope.slice(8));
  return null;
}
function gradeDesignerDraft(scope:string,workspace=false) {
  const key=(workspace?"workspace/":"run/")+scope;
  const existing=graderDesignDrafts.get(key);
  if (existing) return existing;
  const record=gradeScopeRecord(scope), scenario=state.packs.find(p=>p.id===(record && "pack" in record ? record.pack : null));
  const draft:UiGraderDraft = {
    objective:(record && "objective" in record ? record.objective : "") || scenario?.description || "", metrics:((record && "metrics" in record ? record.metrics : undefined) || scenario?.metrics || []).join("\n"),
    industry:(record && "domain" in record ? record.domain : "") || (record && "metadata" in record ? record.metadata.industry : "") || "Cross-industry", target:"response",
    editableMethods:[],objectiveEdited:false,metricsEdited:false,draftId:"",automatic:[],checks:[], summary:"", designer:null, error:"", saved:[], busy:"", hasPlan:false,
  };
  if(workspace && !scope.startsWith("prompt:")){
    draft.planner=plannerState(record && "pack" in record ? "dataset":"quick");
    draft.planner.objective=draft.objective;
    draft.planner.metrics=draft.metrics;
    if(record && "pack" in record)draft.planner.datasetId=record.id;
  }
  graderDesignDrafts.set(key,draft);
  return draft;
}
function activeGraderPlanning():UiGraderDraft|undefined {
  if(trail()[0]!=="graders" || graderAuthoringMode!=="agent" || graderDraft || graderTemplate)return;
  const draft=gradeDesignerDraft(workspaceGradeScope,true);
  return draft.planner ? draft : undefined;
}
function graderTarget(d:UiGraderDraft) {
  return formField("Evaluation target",'<select data-gd-brief="target" '+(d.planner?.busy?'disabled':'')+'>'+opt("response","Model response",d.target)+opt("agent","Agent trajectory and output",d.target)+'</select>');
}
function approvedGradeBrief(p:UiApproved) {
  return '<div class="gd-brief"><strong>'+esc(p.title || p.objective)+' · v'+esc(p.version)+'</strong>'+
    '<details class="wf-options"><summary>Approved prompt and success metrics</summary><pre>'+esc(p.prompt)+'</pre>'+metricList(p.metrics)+'</details></div>';
}
function gradeDesignerLocalJudges() {
  return state.servers.filter(s=>s.online).flatMap(s=>s.models).filter(m=>["lmstudio","ollama"].includes(m.provider));
}
function gradeDesignerScopeSelector(busy:boolean) {
  return formField("Design for",'<select data-gd-source '+(busy?'disabled':'')+'>'+opt("custom","Describe an evaluation",workspaceGradeScope)+
    (state.prompts?.length?'<optgroup label="Approved prompt versions">'+state.prompts.map(p=>opt("prompt:"+p.id,
      (p.title || p.objective)+" · v"+p.version+" · "+p.domain,workspaceGradeScope)).join("")+'</optgroup>':'')+
    (state.datasets.length?'<optgroup label="Dataset snapshots">'+state.datasets.map(d=>opt("dataset:"+d.id,
      (d.metadata?.family || d.name)+" · "+d.version+" · "+(d.metadata?.industry || d.pack),workspaceGradeScope)).join("")+'</optgroup>':'')+'</select>');
}
function designCheckFields(g:UiEditableGrader,i:number,methods:UiDesignMethod[],scope:string) {
  const source=g.source, reuse=g.action==="reuse", judge=g.action==="derive" || ["opik","judge"].includes(g.type);
  const editableIndustry=!g.source && scope==="custom" && !gradeDesignerDraft(scope,true).planner?.approved;
  const field=(key:string,label:string,body:string)=>formField(label,body.replace("GD_FIELD",'data-gd-field="'+key+'"'));
  const rubric=field("criteria",judge?"Scoring rubric":"Scoring rule",'<textarea class="gd-rubric" GD_FIELD maxlength="6000">'+esc(g.criteria)+'</textarea>');
  const basis=source ? '<p><strong>'+esc(source.scope+' grader · '+source.name+' v'+source.version)+'</strong></p><p class="gd-source-rule">'+esc(source.criteria)+'</p><small>'+esc('Pass threshold · '+g.threshold+' / 1')+'</small>'+
    (source.hosted ? '<p>Uses OpenRouter · '+esc(source.model)+'. Running this grader requires confirmation before case evidence is sent.</p>' : '') : '';
  return '<article class="gd-check" data-gd-check="'+i+'"><label class="gd-inclusion"><input type="checkbox" data-gd-field="included" '+(g.included?"checked":"")+'><span>'+
    esc(g.name || "Proposed grader")+'</span></label><fieldset class="gd-check-body" '+(g.included?'':'disabled')+'>'+
    basis+(source ? field("action","After approval",'<select GD_FIELD>'+opt("reuse","Use this exact version",g.action)+opt("derive","Create a customer rubric from this version",g.action)+'</select>') : '<p>New customer grader</p>')+
    (reuse ? '' : rubric+'<div class="cols">'+field("name","Grader name",'<input GD_FIELD maxlength="100" value="'+esc(g.name)+'">')+
    field("category","Category",'<input GD_FIELD maxlength="100" value="'+esc(g.category)+'">')+'</div><div class="cols">'+
    field("industry","Applies to industry",'<select GD_FIELD '+(editableIndustry?'':'disabled')+'>'+[...new Set([g.industry,"Cross-industry","Financial Services","Manufacturing","General"])].map(v=>opt(v,v,g.industry)).join("")+'</select>')+
    field("type","Method",'<select GD_FIELD '+(g.source?'disabled':'')+'>'+(g.source?opt("opik",graderTypes.opik,"opik"):methods.map(v=>opt(v,graderTypes[v],g.type)).join(""))+'</select>')+'</div>'+
    field("threshold","Pass threshold (0–1)",'<input GD_FIELD type="number" min="0" max="1" step="any" value="'+esc(g.threshold)+'">')+
    (judge?field("evidenceView","Evidence shown to the judge",'<select GD_FIELD>'+opt("case","Task, answer and available case evidence",g.evidenceView || "case")+
      (g.requiredEvidence?.length?'':opt("answer-only","Answer only",g.evidenceView))+'</select>'):'')+
    (judge && g.requiredEvidence?.length?'<small>Cases without '+g.requiredEvidence.map(kind=>kind==="reference"?'a reference':'observed agent steps').join(" or ")+' stay unscored.</small>':'')+
    (judge?field("judgeId","Local judge model",'<select GD_FIELD>'+opt("","Choose a connected model",g.judgeId)+gradeDesignerLocalJudges().map(m=>opt(m.id,
      m.model+' · '+m.provider+(m.loaded?' · loaded':''),g.judgeId)).join("")+'</select>'):''))+'</fieldset></article>';
}
function gradeDesignerPreparation(scope:string,d:UiGraderDraft,workspace:boolean) {
  const record=gradeScopeRecord(scope), w=d.planner;
  const p=w?.approved ?? (record && "prompt" in record ? record : undefined);
  const propose='<button type="button" class="gd-generate" data-gd-action="design">'+(d.busy==="design"?'Designing graders…':d.hasPlan || d.saved.length?'Design a new plan':'Propose graders')+'</button>';
  if(workspace && w && !p)return (w.mode==="quick" ? graderTarget(d):"")+
    (w.draft ? workflowReview(w,true):workflowCompose(w,true))+
    (w.error?'<p role="alert" class="wf-error">'+esc(w.error)+'</p>':'');
  if(p)return approvedGradeBrief(p)+(workspace && p.mode==="quick"?graderTarget(d):"")+propose+
    (w?'<button type="button" data-gd-action="edit">Edit objective</button>':'');
  const snapshot=record && "pack" in record ? record : undefined;
  return formField("Task objective",'<textarea data-gd-brief="objective" maxlength="12000">'+esc(d.objective)+'</textarea>')+
    formField("Success measures (optional, one per line)",'<textarea data-gd-brief="metrics" maxlength="3000">'+esc(d.metrics)+'</textarea>')+
    '<small>'+esc(snapshot?.metadata.industry)+' · '+esc(snapshot?.metadata.family || snapshot?.name)+' · '+esc(snapshot?.version)+'</small>'+propose;
}
function graderPlanExplanation(d:UiGraderDraft) {
  const gaps=d.gaps ?? [];
  const designedBy=d.designer?.model ? '<small class="gd-model">Grader designer · '+esc([d.designer.provider,d.designer.model].filter(Boolean).join(" · "))+'</small>' : "";
  const reasons=d.checks.map(g=>'<li><strong>'+esc(g.name)+'</strong><p>'+esc(g.reason)+'</p></li>');
  const coverage=(d.covered ?? []).map(({measure,grader,reason})=>'<li><strong>'+esc(measure)+'</strong><p>'+esc(grader.name)+' v'+esc(grader.version)+' · '+esc(reason)+'</p></li>');
  const skipped=gaps.map(g=>'<li><strong>'+esc(g.measure)+'</strong><p>'+esc(g.reason)+'</p></li>');
  return designedBy+'<details class="gd-explanation"><summary>Reasoning summary</summary>'+
    (reasons.length?'<h4>Why these checks were proposed</h4><ul>'+reasons.join("")+'</ul>':'')+
    (coverage.length?'<h4>Measures scored automatically</h4><ul>'+coverage.join("")+'</ul>':'')+
    (skipped.length?'<h4>Measures without a score</h4><ul>'+skipped.join("")+'</ul>':'')+
    (!reasons.length && !coverage.length && !skipped.length?'<p>'+esc(d.summary || "No scoring decision was recorded.")+'</p>':'')+'</details>';
}
function graderPlanDiagnostics(names:string[]) {
  const explanations:Record<string,string>={
    "Generation completed":"The runtime reported a normal stop.",
    "Response present":"The model returned nonblank text.",
    "Valid JSON":"The response parses as JSON."
  };
  const diagnostics=names.filter(name=>Object.hasOwn(explanations,name));
  const other=names.filter(name=>!Object.hasOwn(explanations,name));
  return (diagnostics.length?'<details class="gd-diagnostics"><summary>Runtime and format checks</summary><p>These checks describe the response delivery and format. The rubric determines whether the answer meets the objective.</p><ul>'+
    diagnostics.map(name=>'<li><strong>'+esc(name)+'</strong> · '+esc(explanations[name])+'</li>').join("")+'</ul></details>':'')+
    (other.length?'<p>Other automatic graders · '+esc(other.join(" · "))+'</p>':'');
}
function gradeDesignerView(scope:string,workspace=false,open=workspace) {
  const d=gradeDesignerDraft(scope,workspace);
  const count=d.checks.filter(g=>g.included).length;
  const hasCoverage=!!d.covered?.length;
  const fullyCovered=hasCoverage && !d.gaps?.length && !d.checks.length;
  const emptyHeading=fullyCovered?"Existing graders cover all measures":hasCoverage?"Some measures already have graders":"No quality rubric is ready";
  const label=workspace?'Design with an agent':'Design graders for this '+(scope.startsWith("prompt:")?'prompt':'dataset');
  const start=workspace ? '<section class="gd-panel gd-workspace" data-gd-workspace data-gd-scope="'+esc(scope)+'" aria-label="'+label+'">' :
    '<details class="gd-panel" data-gd-scope="'+esc(scope)+'" '+(open?'open':'')+'><summary>'+label+'</summary>';
  return start+
    '<div class="gd-content">'+(workspace?gradeDesignerScopeSelector(!!(d.busy || d.planner?.busy)):'')+
    '<fieldset class="gd-fields" '+(d.busy?'disabled':'')+'>'+gradeDesignerPreparation(scope,d,workspace)+
    graderActivitySection(d)+
    (d.error?'<p role="alert" class="wf-error">'+esc(d.error)+'</p>':'')+
    (d.hasPlan?'<section class="gd-proposals" aria-label="Proposed graders"><h3>'+
      (d.checks.length ? (d.checks.length===1 ? "Review the proposed grader" : "Review "+d.checks.length+" proposed graders") : emptyHeading)+'</h3>'+
      (d.checks.length?'':fullyCovered?'<p>These graders run automatically. You can continue without saving a new grader.</p>':'<p>Review the evidence needed below. Edit the objective to describe an observable part of the answer, or choose a labeled dataset for a reference-based check.</p>')+
      graderPlanExplanation(d)+
      d.checks.map((g,i)=>designCheckFields(g,i,d.editableMethods,scope)).join("")+
      '<div class="gd-actions">'+(d.checks.length?'<button type="button" class="yellow" data-gd-action="confirm" '+(count?'':'disabled')+'>'+
      (d.busy==="confirm"?'Saving versions…':(workspace || scope==="custom"?'Save ':'Save and select ')+count+' '+(count===1?'grader':'graders'))+'</button>':'')+
      '<button type="button" data-gd-action="discard">'+(fullyCovered?"Done":"Discard plan")+'</button></div>'+graderPlanDiagnostics(d.automatic)+'</section>':'')+
    (!workspace && d.saved.length?'<div class="gd-saved" role="status"><strong>'+(workspace || scope==="custom"?'Saved in the grader library':'Confirmed for this '+(scope.startsWith("prompt:")?'prompt version':'dataset snapshot'))+
      '</strong><ul>'+d.saved.map(g=>'<li>'+esc(g.label)+'</li>').join("")+'</ul></div>':'')+'</fieldset></div>'+(workspace?'</section>':'</details>');
}
function repaintGradeDesigner(scope:string,workspace:boolean) {
  for (const panel of document.querySelectorAll<HTMLElement>("[data-gd-scope]")) {
    if (panel.dataset.gdScope!==scope || panel.hasAttribute("data-gd-workspace")!==workspace) continue;
    panel.outerHTML=gradeDesignerView(scope,workspace,!(panel instanceof HTMLDetailsElement) || panel.open);
  }
}
function syncGraderDesignLaunch() {
  const quick=dashElement("#quick-models .go-button",HTMLButtonElement);
  if (quick) quick.disabled=!canStartQuick();
  const ds=dashElement("#dataset-models .go-button",HTMLButtonElement);
  if (ds) ds.disabled=!canStartDataset();
}
function activeDatasetGraderScope() {
  const p=workflows.dataset.approved;
  return p ? "prompt:"+p.id : "dataset:"+(dataset()?.id || "");
}
// Persist saved version IDs and positions in an immutable prompt. Planning text stays in the renderer.
function readGraderAttachment(scope:string) {
  try {
    const saved:unknown=JSON.parse(localStorage.getItem("dash.attachedGraders.v1."+scope) || "null");
    if (!isRecord(saved) || !Array.isArray(saved.ids)) return null;
    const known=new Set((state.graders || []).map(g=>g.id));
    const mapped=new Map<number,string|null>();
    if (Array.isArray(saved.mapped)) for (const row of saved.mapped) {
      if (isRecord(row) && typeof row.index==="number" && Number.isInteger(row.index) &&
          row.index>=0 && row.index<8 && (row.id===null || typeof row.id==="string")) mapped.set(row.index,row.id);
    }
    return {mapped,ids:saved.ids.filter((id:unknown):id is string=>typeof id==="string" && known.has(id)),generic:!!saved.generic};
  } catch {return null;}
}
function writeGraderAttachment(scope:string,ids:Iterable<string>,generic=false,mapped?:{index:number;id:string|null}[]) {
  try {localStorage.setItem("dash.attachedGraders.v1."+scope,JSON.stringify({ids:[...ids],generic,...(mapped && {mapped})}));}
  catch { /* Selections remain in the current workspace session. */ }
}
function retainedGraderIds(selected:Iterable<string>,approved:UiEditableGrader[]) {
  const versions=new Set(approved.filter(g=>g.action==="reuse" && g.source).map(g=>g.source?.id));
  const families=new Set((state.graders || []).filter(g=>versions.has(g.id) && g.library?.familyId).map(g=>g.library?.familyId));
  return [...selected].filter(id=>!versions.has(id) && !(state.graders || []).some(g=>g.id===id && families.has(g.library?.familyId)));
}
function gradeSelectionForScope(scope:string) {
  const rec=gradeScopeRecord(scope);
  if (scope==="custom") return null;
  if (scope.startsWith("prompt:") && rec && "mode" in rec && rec.mode==="quick") {
    if (!quickGradingPlans.has(rec.id)) quickGradingPlans.set(rec.id,newQuickGradingPlan(rec.id));
    return quickGradingPlans.get(rec.id)?.saved ?? null;
  }
  return datasetGradeSelection(scope);
}
function attachDesignedGraders(scope:string,ids:string[],definitions:UiEditableGrader[]) {
  const selected=gradeSelectionForScope(scope);
  if (!selected) return;
  const keep=retainedGraderIds(selected,definitions);
  selected.clear();
  for (const id of [...keep,...ids]) selected.add(id);
  const rec=gradeScopeRecord(scope);
  if (scope.startsWith("prompt:") && rec && "mode" in rec && rec.mode==="quick") {
    const plan=quickGradingPlans.get(rec.id);
    if (!plan) return;
    definitions.forEach((check,index)=>{
      const measures=check.measures ?? [],id=ids[index];
      if (measures.length===1 && id) {
        const metric=measures[0],row=plan.measures.get(metric);
        if (row && plan.options?.measures.some(m=>m.metric===metric && m.criterion && !m.reason)) {
          row.choice="saved:"+id;row.edited=true;selected.delete(id);
        }
      }
      // A shared check has one additional score. Its measures have no independent grades.
      if (measures.length>1) for (const metric of measures) {
        const row=plan.measures.get(metric);
        if (row && !row.edited) {row.choice="skip";row.edited=true;}
      }
    });
    rememberQuickGraders(plan,rec.id);
    return;
  }
  if (scope.startsWith("dataset:") && rec && "pack" in rec && rec.pack==="reference") datasetScorerChoices.set(rec.id,"selected-graders");
  writeGraderAttachment(scope,selected);
}
function reviewChoices(draft:UiGraderDraft):UiReviewChoice[] {
  const result:UiReviewChoice[]=[];
  draft.checks.forEach((g,index)=>{
    if (!g.included) return;
    if(g.action==="reuse"){result.push({index,action:"reuse"});return;}
    const name=g.name.trim(),category=g.category.trim(),criteria=g.criteria.trim(),threshold=Number(g.threshold);
    if(!name || !category || !criteria) throw Error("Enter a name, metric and criteria for each selected grader.");
    if(!Number.isFinite(threshold) || threshold<=0 || threshold>1) throw Error("Set each pass threshold above zero and at most one.");
    const judge=g.action==="derive" || ["judge","opik"].includes(g.type);
    if(judge && !gradeDesignerLocalJudges().some(m=>m.id===g.judgeId))throw Error("Choose a connected local judge for "+name+".");
    const type=g.action==="create" ? draft.editableMethods.find(m=>m===g.type) : undefined;
    result.push({index,action:g.action,definition:{name,category,criteria,threshold,industry:g.industry,...(type && {type}),...(judge && {judgeId:g.judgeId,evidenceView:g.evidenceView ?? "case"})}});
  });
  if (!result.length)throw Error("Select at least one proposed check.");
  return result;
}
document.addEventListener("keydown",e=>{
  if (!(e.target instanceof Element)) return;

  if (e.key==="Enter" && e.target.matches("input:not([type=checkbox])") && e.target.closest("[data-gd-scope]")) e.preventDefault();
});
function updateDesignerField(t:EventTarget|null) {
  if (!textInput(t)) return;
  const panel=t.closest<HTMLElement>("[data-gd-scope]");
  if (!panel?.dataset.gdScope) return;
  const draft=gradeDesignerDraft(panel.dataset.gdScope,panel.hasAttribute("data-gd-workspace"));
  if (draft.busy) return;
  const field=t.dataset.gdBrief;
  if (field==="objective" || field==="metrics" || field==="industry" || field==="target") {
    if (draft[field]===t.value) return;
    if (field==="target") {if (t.value!=="agent" && t.value!=="response") return; draft.target=t.value;}
    else draft[field]=t.value;
    if(field==="objective")draft.objectiveEdited=true;
    if(field==="metrics")draft.metricsEdited=true;
    if (draft.hasPlan) {
      draft.hasPlan=false;draft.checks=[];draft.summary="";
      panel.querySelector(".gd-proposals")?.remove();
      const button=panel.querySelector("[data-gd-action=design]");
      if(button)button.textContent="Propose graders";
    }
    draft.error="";panel.querySelector("[role=alert]")?.remove();
    return;
  }
  const item=t.closest<HTMLElement>("[data-gd-check]"), key=t.dataset.gdField;
  if (!item || !key) return;
  const g=draft.checks[Number(item.dataset.gdCheck)];
  if (!g) return;
  if (key==="included" && t instanceof HTMLInputElement) g.included=t.checked;
  else if(key==="action" && g.source && (t.value==="reuse" || t.value==="derive")) g.action=t.value;
  else if(key==="type" && !g.source){const method=draft.editableMethods.find(m=>m===t.value);if(method)g.type=method;}
  else if(key==="evidenceView" && (t.value==="answer-only" || t.value==="case"))g.evidenceView=t.value;
  else if (key==="industry" && !g.source)g.industry=t.value;
  else if (key==="criteria" || key==="category" || key==="threshold" || key==="judgeId" || key==="name") g[key]=t.value;
  if (key==="name") $(".gd-inclusion span",item).textContent=g.name || "Proposed grader";
}
document.addEventListener("input",e=>updateDesignerField(e.target));
document.addEventListener("change",e=>{
  if (!textInput(e.target)) return;

  const t=e.target,panel=t.closest<HTMLElement>("[data-gd-scope]");
  if (!panel?.dataset.gdScope) return;
  if (t.hasAttribute("data-gd-source")) {
    const prior=gradeDesignerDraft(panel.dataset.gdScope,true),next=gradeDesignerDraft(t.value,true);
    if(prior.busy || prior.planner?.busy)return;
    // Carry manually entered text into an untouched source, never another domain's suggestions or rubric.
    if(panel.dataset.gdScope==="custom" && prior.planner && next.planner && !prior.planner.draft && !prior.planner.suggestion &&
      !next.planner.draft && !next.planner.suggestion && !next.planner.approved &&
      (!prior.planner.domain || prior.planner.domain===next.industry)){
      if(prior.objectiveEdited && !next.objectiveEdited){next.planner.objective=prior.planner.objective;next.objectiveEdited=true;}
      if(prior.metricsEdited && !next.metricsEdited && prior.planner.domain===next.industry){next.planner.metrics=prior.planner.metrics;next.metricsEdited=true;}
      else if(prior.objectiveEdited && !prior.planner.metrics.trim() && !next.metricsEdited)next.planner.metrics="";
    }
    workspaceGradeScope=t.value;
    panel.outerHTML=gradeDesignerView(workspaceGradeScope,true,true);
  } else {
    updateDesignerField(t);
    if (["action","included","type"].includes(t.dataset.gdField ?? "")) {
      const i=t.closest<HTMLElement>("[data-gd-check]")?.dataset.gdCheck;
      repaintGradeDesigner(panel.dataset.gdScope,panel.hasAttribute("data-gd-workspace"));
      document.querySelector<HTMLElement>('[data-gd-check="'+i+'"] [data-gd-field="'+t.dataset.gdField+'"]')?.focus({preventScroll:true});
    }
  }
});
const graderPlanningRequests = new Map<string,UiGraderDraft>();
function graderActivitySection(d:UiGraderDraft) {
  if (d.busy !== "design" && !d.activity?.calls.length) return "";
  const progress = '<span data-gd-progress role="status" class="visually-hidden"></span><div data-gd-query>' +
    planningActivityBody(d, "Finding a grader design model…") + '</div>';
  return d.busy === "design"
    ? '<section class="gd-activity" aria-label="Grader design activity">'+progress+'</section>'
    : '<details class="gd-activity"><summary>Grader design activity</summary>'+progress+'</details>';
}
function updateGraderActivity(event:UiPlanningEvent) {
  const d=graderPlanningRequests.get(event.requestId);
  if (!d) return;
  const panel=Array.from(document.querySelectorAll<HTMLElement>("[data-gd-scope]")).find(el=>
    graderDesignDrafts.get((el.hasAttribute("data-gd-workspace")?"workspace/":"run/")+el.dataset.gdScope) === d);
  updatePlanningActivity(d,event,panel?.querySelector<HTMLElement>("[data-gd-query]") ?? null,
    panel?.querySelector<HTMLElement>("[data-gd-progress]") ?? null);
}
async function proposeGraderChecks(scope:string,d:UiGraderDraft) {
  const promptId=d.planner?.approved?.id ?? (scope.startsWith("prompt:")?scope.slice(7):undefined);
  const request:UiDesignGraderRequest=promptId ? {promptId,target:d.target} : {objective:d.objective.trim(),metrics:d.metrics.trim(),
    target:d.target,...(scope.startsWith("dataset:")?{datasetId:scope.slice(8)}:d.industry==="Cross-industry"?{}:{domainId:d.industry})};
  if ("objective" in request && !request.objective) throw Error("Describe the task you want to evaluate.");
  const requestId=crypto.randomUUID();
  d.activity={requestId,startedAt:Date.now(),calls:[]};
  graderPlanningRequests.set(requestId,d);
  let result:UiGraderDesign;
  try {
    result=await api.designGraders({...request,requestId});
    if (result.planningAttempts) d.activity.calls=result.planningAttempts;
  } finally { graderPlanningRequests.delete(requestId); }
  const judges=gradeDesignerLocalJudges();
  const preferred=judges.find(m=>m.loaded && m.provider===result.designer?.provider && m.model===result.designer.model) || judges.find(m=>m.loaded);
  d.editableMethods=result.editableMethods;
  d.checks=result.checks.map(g=>({...g,included:!g.source?.hosted,judgeId:preferred?.id || ""}));
  d.covered=result.covered;d.gaps=result.gaps;d.draftId=result.draftId;d.automatic=result.automatic;d.summary=result.summary;d.designer=result.designer;d.hasPlan=true;
}

async function proposeReviewedGraders(d:UiGraderDraft) {
  const id=d.planner?.approved?.id;
  if(!id)throw Error("Approve a prompt version before proposing graders.");
  d.error="";d.busy="design";
  try{
    if(d===activeGraderPlanning())repaintGradeDesigner(workspaceGradeScope,true);
    await proposeGraderChecks("prompt:"+id,d);
  }catch(error){d.error=errorText(error);}
  finally{d.busy="";}
}
document.addEventListener("click", async e=>{
  if (!(e.target instanceof Element)) return;

  const button=e.target.closest<HTMLButtonElement>("[data-gd-action]"),panel=button?.closest<HTMLElement>("[data-gd-scope]");
  if (!panel?.dataset.gdScope) return;
  e.preventDefault();
  const workspace=panel.hasAttribute("data-gd-workspace"),scope=panel.dataset.gdScope,d=gradeDesignerDraft(scope,workspace),action=button?.dataset.gdAction;
  if (!action || !button || d.busy) return;
  if(action==="edit" && d.planner && !d.planner.busy){
    d.planner.parentId=d.planner.approved?.id ?? d.planner.parentId;d.planner.approved=null;d.planner.draft=null;d.planner.error="";d.hasPlan=false;d.checks=[];d.summary="";d.error="";
    repaintGradeDesigner(scope,workspace);return;
  }
  if (action==="discard") {
    d.hasPlan=false;d.checks=[];d.summary="";d.error="";
    repaintGradeDesigner(scope,workspace);return;
  }
  d.error="";d.busy=action;repaintGradeDesigner(scope,workspace);syncGraderDesignLaunch();
  try {
    if (action==="design") {
      await proposeGraderChecks(scope,d);
    } else if (action==="confirm") {
      const choices=reviewChoices(d),definitions=choices.map(c=>d.checks[c.index]);
      const selected=workspace?null:gradeSelectionForScope(scope);
      if (selected && retainedGraderIds(selected,definitions).length+definitions.length>8)
        throw Error("A run supports up to eight graders. Deselect existing graders or exclude checks before saving.");
      const ids=await api.confirmGraders({draftId:d.draftId,choices});
      if(!workspace) attachDesignedGraders(scope,ids,definitions);
      d.saved=ids.map((id,i)=>({id,label:definitions[i].name}));d.hasPlan=false;d.checks=[];
      if(workspace)recordWorkspaceSave(d.saved,scope);
      if (document.querySelector<HTMLElement>("[data-gd-scope]")?.dataset.gdScope===scope) {
        await render();
        if(workspace)document.getElementById("grader-receipt")?.focus();
        d.saved=d.saved.map(g=>{const def=state.graders.find(item=>item.id===g.id);return {...g,label:def?def.name+" · v"+def.version:g.label};});
      }
    }
  } catch(error) {d.error=String(errorText(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/,"");}
  finally {d.busy="";repaintGradeDesigner(scope,workspace);syncGraderDesignLaunch();}
});
