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
  graderDesignDrafts.set(key,draft);
  return draft;
}
function gradeDesignerLocalJudges() {
  return state.servers.filter(s=>s.online).flatMap(s=>s.models).filter(m=>["lmstudio","ollama"].includes(m.provider));
}
function gradeDesignerScopeSelector() {
  return formField("Design for",'<select data-gd-source>'+opt("custom","Describe an evaluation",workspaceGradeScope)+
    (state.prompts?.length?'<optgroup label="Approved prompt versions">'+state.prompts.map(p=>opt("prompt:"+p.id,
      (p.title || p.objective)+" · v"+p.version+" · "+p.domain,workspaceGradeScope)).join("")+'</optgroup>':'')+
    (state.datasets.length?'<optgroup label="Dataset snapshots">'+state.datasets.map(d=>opt("dataset:"+d.id,
      (d.metadata?.family || d.name)+" · "+d.version+" · "+(d.metadata?.industry || d.pack),workspaceGradeScope)).join("")+'</optgroup>':'')+'</select>');
}
function graderDesignInputs(scope:string,draft:UiGraderDraft,record:ReturnType<typeof gradeScopeRecord>) {
  if (scope.startsWith("prompt:")) return '<p class="gd-brief"><strong>'+esc((record && "objective" in record ? record.objective : ""))+'</strong><small>'+
    esc([(record && "domain" in record ? record.domain : ""),...((record && "metrics" in record ? record.metrics : undefined) || [])].join(" · "))+'</small></p>';
  return formField("Task objective",'<textarea data-gd-brief="objective" maxlength="12000">'+esc(draft.objective)+'</textarea>')+
    formField("Success measures (optional, one per line)",'<textarea data-gd-brief="metrics" maxlength="3000">'+esc(draft.metrics)+'</textarea>')+
    (scope==="custom"?'<div class="cols">'+formField("Domain",'<select data-gd-brief="industry">'+["Cross-industry","Financial Services","Manufacturing","General"].map(v=>opt(v,v,draft.industry)).join("")+'</select>')+
      formField("Evaluation target",'<select data-gd-brief="target">'+opt("response","Model response",draft.target)+opt("agent","Agent trajectory and output",draft.target)+'</select>')+'</div>':
      '<small>'+esc((record && "metadata" in record ? record.metadata.industry : ""))+' · '+esc((record && "metadata" in record ? record.metadata.family || record.name : ""))+' · '+esc(record?.version)+'</small>');
}
function designCheckFields(g:UiEditableGrader,i:number,methods:UiDesignMethod[],scope:string) {
  const source=g.source, reuse=g.action==="reuse", judge=g.action==="derive" || ["opik","judge"].includes(g.type);
  const editableIndustry=!g.source && scope==="custom";
  const field=(key:string,label:string,body:string)=>formField(label,body.replace("GD_FIELD",'data-gd-field="'+key+'"'));
  const basis=source ? '<p><strong>'+esc(source.scope+' grader · '+source.name+' v'+source.version)+'</strong></p><p>'+esc(source.criteria)+'</p>'+
    (source.hosted ? '<p>Uses OpenRouter · '+esc(source.model)+'. Running this grader requires confirmation before case evidence is sent.</p>' : '') : '';
  return '<article class="gd-check" data-gd-check="'+i+'"><label class="gd-inclusion"><input type="checkbox" data-gd-field="included" '+(g.included?"checked":"")+'><span>'+
    esc(g.name || "Proposed grader")+'</span></label><small>'+esc(g.reason)+'</small><fieldset class="gd-check-body" '+(g.included?'':'disabled')+'>'+
    basis+(source ? field("action","After approval",'<select GD_FIELD>'+opt("reuse","Use this exact version",g.action)+opt("derive","Create a customer rubric from this version",g.action)+'</select>') : '<p>New customer grader</p>')+
    (reuse ? '' : '<div class="cols">'+field("name","Grader name",'<input GD_FIELD maxlength="100" value="'+esc(g.name)+'">')+
    field("category","Category",'<input GD_FIELD maxlength="100" value="'+esc(g.category)+'">')+'</div><div class="cols">'+
    field("industry","Applies to industry",'<select GD_FIELD '+(editableIndustry?'':'disabled')+'>'+[...new Set([g.industry,"Cross-industry","Financial Services","Manufacturing","General"])].map(v=>opt(v,v,g.industry)).join("")+'</select>')+
    field("type","Method",'<select GD_FIELD '+(g.source?'disabled':'')+'>'+(g.source?opt("opik",graderTypes.opik,"opik"):methods.map(v=>opt(v,graderTypes[v],g.type)).join(""))+'</select>')+'</div>'+
    field("threshold","Pass threshold (0–1)",'<input GD_FIELD type="number" min="0" max="1" step="any" value="'+esc(g.threshold)+'">')+
    field("criteria","Grading criteria",'<textarea GD_FIELD maxlength="6000">'+esc(g.criteria)+'</textarea>')+
    (judge?field("evidenceView","Evidence shown to the judge",'<select GD_FIELD>'+opt("case","Task, answer and available case evidence",g.evidenceView || "case")+
      (g.requiredEvidence?.length?'':opt("answer-only","Answer only",g.evidenceView))+'</select>'):'')+
    (judge && g.requiredEvidence?.length?'<small>Cases without '+g.requiredEvidence.map(kind=>kind==="reference"?'a reference':'observed agent steps').join(" or ")+' stay unscored.</small>':'')+
    (judge?field("judgeId","Local judge model",'<select GD_FIELD>'+opt("","Choose a connected model",g.judgeId)+gradeDesignerLocalJudges().map(m=>opt(m.id,
      m.model+' · '+m.provider+(m.loaded?' · loaded':''),g.judgeId)).join("")+'</select>'):''))+'</fieldset></article>';
}
function gradeDesignerView(scope:string,workspace=false,open=workspace) {
  const d=gradeDesignerDraft(scope,workspace), record=gradeScopeRecord(scope);
  const count=d.checks.filter(g=>g.included).length;
  const label=workspace?'Design with an agent':'Design graders for this '+(scope.startsWith("prompt:")?'prompt':'dataset');
  const start=workspace ? '<section class="gd-panel gd-workspace" data-gd-workspace data-gd-scope="'+esc(scope)+'" aria-label="'+label+'">' :
    '<details class="gd-panel" data-gd-scope="'+esc(scope)+'" '+(open?'open':'')+'><summary>'+label+'</summary>';
  return start+
    '<div class="gd-content">'+(workspace?gradeDesignerScopeSelector():'')+
    '<fieldset class="gd-fields" '+(d.busy?'disabled':'')+'>'+graderDesignInputs(scope,d,record)+
    '<button type="button" class="gd-generate" data-gd-action="design">'+(d.busy==="design"?'Designing graders…':d.hasPlan || d.saved.length?'Design a new plan':'Propose graders')+'</button>'+
    (d.error?'<p role="alert" class="wf-error">'+esc(d.error)+'</p>':'')+
    (d.hasPlan?'<section class="gd-proposals"><h3>Review your plan · '+d.checks.length+' proposed '+(d.checks.length===1?'check':'checks')+'</h3><p>'+esc(d.summary)+'</p>'+
      (d.designer?.model?'<small>Designed by '+esc([d.designer.provider,d.designer.model].filter(Boolean).join(" · "))+'</small>':'')+
      (d.automatic.length ? '<p>Automatic checks · '+esc(d.automatic.join(' · '))+'</p>' : '')+
      (d.checks.length?'<p>Review the criteria, evidence and pass threshold before saving.</p>':'')+
      d.checks.map((g,i)=>designCheckFields(g,i,d.editableMethods,scope)).join("")+
      '<div class="gd-actions">'+(d.checks.length?'<button type="button" class="yellow" data-gd-action="confirm" '+(count?'':'disabled')+'>'+
      (d.busy==="confirm"?'Saving versions…':(workspace || scope==="custom"?'Save ':'Save and select ')+count+' '+(count===1?'grader':'graders'))+'</button>':'')+
      '<button type="button" data-gd-action="discard">Discard plan</button></div></section>':'')+
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
// Remember only saved version IDs. Planning text stays in the current renderer.
function readGraderAttachment(scope:string) {
  try {
    const saved:unknown=JSON.parse(localStorage.getItem("dash.attachedGraders.v1."+scope) || "null");
    if (!isRecord(saved) || !Array.isArray(saved.ids)) return null;
    const known=new Set((state.graders || []).map(g=>g.id));
    return {ids:saved.ids.filter((id:unknown):id is string=>typeof id==="string" && known.has(id)),generic:!!saved.generic};
  } catch {return null;}
}
function writeGraderAttachment(scope:string,ids:Iterable<string>,generic=false) {
  try {localStorage.setItem("dash.attachedGraders.v1."+scope,JSON.stringify({ids:[...ids],generic}));}
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
    plan.enabled=false;
    plan.designed=true;
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
      $("[data-gd-action=design]",panel).textContent="Propose graders";
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
    if(!next.hasPlan && !next.saved.length && !t.value.startsWith("prompt:")) {
      if(prior.objectiveEdited && !next.objectiveEdited){next.objective=prior.objective;next.objectiveEdited=true;}
      if(prior.metricsEdited && !next.metricsEdited){next.metrics=prior.metrics;next.metricsEdited=true;}
      if(prior.objectiveEdited && !prior.metrics.trim() && !next.metricsEdited)next.metrics="";
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
document.addEventListener("click", async e=>{
  if (!(e.target instanceof Element)) return;

  const button=e.target.closest<HTMLButtonElement>("[data-gd-action]"),panel=button?.closest<HTMLElement>("[data-gd-scope]");
  if (!panel?.dataset.gdScope) return;
  e.preventDefault();
  const workspace=panel.hasAttribute("data-gd-workspace"),scope=panel.dataset.gdScope,d=gradeDesignerDraft(scope,workspace),action=button?.dataset.gdAction;
  if (!action || !button || d.busy) return;
  if (action==="discard") {
    d.hasPlan=false;d.checks=[];d.summary="";d.error="";
    repaintGradeDesigner(scope,workspace);return;
  }
  d.error="";d.busy=action;repaintGradeDesigner(scope,workspace);syncGraderDesignLaunch();
  try {
    if (action==="design") {
      const request:UiDesignGraderRequest=scope.startsWith("prompt:") ? {promptId:scope.slice(7)} : {objective:d.objective.trim(),metrics:d.metrics.trim(),
        target:d.target,...(scope.startsWith("dataset:")?{datasetId:scope.slice(8)}:d.industry==="Cross-industry"?{}:{domainId:d.industry})};
      if ("objective" in request && !request.objective) throw Error("Describe the task you want to evaluate.");
      const result=await api.designGraders(request);
      const judges=gradeDesignerLocalJudges();
      const preferred=judges.find(m=>m.loaded && m.provider===result.designer?.provider && m.model===result.designer.model) || judges.find(m=>m.loaded);
      d.editableMethods=result.editableMethods;
      d.checks=result.checks.map(g=>({...g,included:!g.source?.hosted,judgeId:preferred?.id || ""}));
      d.draftId=result.draftId;d.automatic=result.automatic;d.summary=result.summary;d.designer=result.designer;d.hasPlan=true;
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
