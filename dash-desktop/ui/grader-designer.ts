"use strict";

const graderDesignDrafts = new Map<string,UiGraderDraft>();
let workspaceGradeScope = "custom";

function gradeScopeRecord(scope:string) {
  if (scope.startsWith("prompt:")) return (state.prompts || []).find(p=>p.id===scope.slice(7));
  if (scope.startsWith("dataset:")) return state.datasets.find(d=>d.id===scope.slice(8));
  return null;
}
function gradeDesignerDraft(scope:string) {
  const existing=graderDesignDrafts.get(scope);
  if (existing) return existing;
  const record=gradeScopeRecord(scope), scenario=state.packs.find(p=>p.id===(record && "pack" in record ? record.pack : null));
  const draft:UiGraderDraft = {
    objective:(record && "objective" in record ? record.objective : "") || scenario?.description || "", metrics:((record && "metrics" in record ? record.metrics : undefined) || scenario?.metrics || []).join("\n"),
    industry:(record && "domain" in record ? record.domain : "") || (record && "metadata" in record ? record.metadata.industry : "") || "Cross-industry", target:"response",
    checks:[], summary:"", designer:null, error:"", saved:[], busy:"", hasPlan:false,
  };
  graderDesignDrafts.set(scope,draft);
  return draft;
}
function gradeDesignerLocalJudges() {
  return models().filter(m=>["lmstudio","ollama"].includes(m.provider));
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
    formField("Business measures or success criteria",'<textarea data-gd-brief="metrics" maxlength="3000">'+esc(draft.metrics)+'</textarea>')+
    (scope==="custom"?'<div class="cols">'+formField("Industry",'<input data-gd-brief="industry" maxlength="100" value="'+esc(draft.industry)+'">')+
      formField("Evaluation target",'<select data-gd-brief="target">'+opt("response","Model response",draft.target)+opt("agent","Agent trajectory and output",draft.target)+'</select>')+'</div>':
      '<small>'+esc((record && "metadata" in record ? record.metadata.industry : ""))+' · '+esc((record && "metadata" in record ? record.metadata.family || record.name : ""))+' · '+esc(record?.version)+'</small>');
}
function designCheckFields(g:UiEditableGrader,i:number,draft:UiGraderDraft,scope:string) {
  const judge=["opik","judge"].includes(g.type);
  const allowed:UiGradeType[]=["exact","contains",...(state.opikReady?["opik" as const]:[]),
    ...(draft.checks.some(c=>c.proposedType==="field")?["field" as const]:[]),...(scope==="custom" && draft.target==="agent"?["trajectory" as const]:[])];
  const field=(name:string,label:string,input:string)=>formField(label,input.replace("GD_FIELD",'data-gd-field="'+name+'"'));
  const locals=gradeDesignerLocalJudges();
  return '<article class="gd-check" data-gd-check="'+i+'"><label class="gd-inclusion"><input type="checkbox" data-gd-field="included" '+(g.included?"checked":"")+'><span>'+
    esc(g.name || "Proposed grader")+'</span></label><small>'+esc(g.reason)+'</small><fieldset class="gd-check-body" '+(g.included?'':'disabled')+'><div class="cols">'+
    field("name","Grader name",'<input GD_FIELD maxlength="100" value="'+esc(g.name)+'">')+
    field("category","Metric",'<input GD_FIELD maxlength="100" value="'+esc(g.category)+'">')+'</div><div class="cols">'+
    field("type","Method",'<select GD_FIELD>'+allowed.map(type=>opt(type,graderTypes[type],g.type)).join("")+'</select>')+
    field("threshold","Pass threshold (0–1)",'<input GD_FIELD inputmode="decimal" value="'+esc(g.threshold)+'">')+'</div>'+
    field("criteria",graderHints[g.type] || "Grading criteria",'<textarea GD_FIELD maxlength="6000">'+esc(g.criteria)+'</textarea>')+
    (judge?field("judgeId","Judge model",'<select GD_FIELD>'+opt("","Choose a connected model",g.judgeId)+locals.map(m=>opt(m.id,
      m.model+" · "+m.provider+(m.loaded?" · loaded":""),g.judgeId)).join("")+'</select>'):'')+'</fieldset></article>';
}
function gradeDesignerView(scope:string,workspace=false,open=workspace) {
  const d=gradeDesignerDraft(scope), record=gradeScopeRecord(scope);
  const count=d.checks.filter(g=>g.included).length;
  const label=workspace?'Design graders with an agent':'Design graders for this '+(scope.startsWith("prompt:")?'prompt':'dataset');
  return '<details class="gd-panel" data-gd-scope="'+esc(scope)+'" '+(workspace?'data-gd-workspace ':'')+(open?'open':'')+'><summary>'+label+'</summary>'+
    '<div class="gd-content">'+(workspace?gradeDesignerScopeSelector():'')+
    '<fieldset class="gd-fields" '+(d.busy?'disabled':'')+'>'+graderDesignInputs(scope,d,record)+
    '<button type="button" class="gd-generate" data-gd-action="design">'+(d.busy==="design"?'Designing graders…':d.hasPlan || d.saved.length?'Design a new plan':'Propose graders')+'</button>'+
    (d.error?'<p role="alert" class="wf-error">'+esc(d.error)+'</p>':'')+
    (d.hasPlan?'<section class="gd-proposals"><h3>Coverage · '+d.checks.length+' proposed '+(d.checks.length===1?'check':'checks')+'</h3><p>'+esc(d.summary)+'</p>'+
      (d.designer?.model?'<small>Designed by '+esc([d.designer.provider,d.designer.model].filter(Boolean).join(" · "))+'</small>':'')+
      d.checks.map((g,i)=>designCheckFields(g,i,d,scope)).join("")+
      '<div class="gd-actions">'+(d.checks.length?'<button type="button" class="yellow" data-gd-action="confirm" '+(count?'':'disabled')+'>'+
      (d.busy==="confirm"?'Saving versions…':(scope==="custom"?'Save ':'Save and select ')+count+' '+(count===1?'grader':'graders'))+'</button>':'')+
      '<button type="button" data-gd-action="discard">Discard plan</button></div></section>':'')+
    (d.saved.length?'<div class="gd-saved" role="status"><strong>'+(scope==="custom"?'Saved in the grader library':'Confirmed for this '+(scope.startsWith("prompt:")?'prompt version':'dataset snapshot'))+
      '</strong><ul>'+d.saved.map(g=>'<li>'+esc(g.label)+'</li>').join("")+'</ul></div>':'')+'</fieldset></div></details>';
}
function repaintGradeDesigner(scope:string) {
  for (const panel of document.querySelectorAll<HTMLDetailsElement>("details[data-gd-scope]")) {
    if (panel.dataset.gdScope!==scope) continue;
    panel.outerHTML=gradeDesignerView(scope,panel.hasAttribute("data-gd-workspace"),panel.open);
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
function retainedGraderIds(selected:Iterable<string>,definitions:UiGraderDefinition[]) {
  const names=new Set(definitions.map(d=>d.name.toLowerCase()));
  return [...selected].filter(id=>!(state.graders || []).some(g=>g.id===id && !g.origin && names.has(g.name.toLowerCase())));
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
function attachDesignedGraders(scope:string,ids:string[],definitions:UiGraderDefinition[]) {
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
  if (scope.startsWith("dataset:")) datasetScorerChoices.set(scope.slice(8),"selected-graders");
  writeGraderAttachment(scope,selected);
}
function validateGraderDefinitions(draft:UiGraderDraft) {
  const checks=draft.checks.filter(g=>g.included);
  if (!checks.length) throw Error("Select at least one proposed check.");
  if (new Set(checks.map(g=>g.name.trim().toLowerCase())).size!==checks.length) throw Error("Give each selected grader a distinct name.");
  return checks.map(g=>{
    const name=g.name.trim(),category=g.category.trim(),criteria=g.criteria.trim(),threshold=Number(g.threshold);
    if (!name || !category || !criteria) throw Error("Enter a name, metric and criteria for each selected grader.");
    if (!Number.isFinite(threshold) || threshold<=0 || threshold>1) throw Error("Set each pass threshold above zero and at most one.");
    if (["judge","opik"].includes(g.type) && !gradeDesignerLocalJudges().some(m=>m.id===g.judgeId))
      throw Error("Choose a connected judge model for "+name+".");
    return {name,category,industry:g.industry,type:g.type,criteria,threshold,judgeId:g.judgeId};
  });
}
document.addEventListener("keydown",e=>{
  if (!(e.target instanceof Element)) return;

  if (e.key==="Enter" && e.target.matches("input:not([type=checkbox])") && e.target.closest("[data-gd-scope]")) e.preventDefault();
});
function updateDesignerField(t:EventTarget|null) {
  if (!textInput(t)) return;
  const panel=t.closest<HTMLElement>("[data-gd-scope]");
  if (!panel?.dataset.gdScope) return;
  const draft=gradeDesignerDraft(panel.dataset.gdScope);
  if (draft.busy) return;
  const field=t.dataset.gdBrief;
  if (field==="objective" || field==="metrics" || field==="industry" || field==="target") {
    if (draft[field]===t.value) return;
    if (field==="target") {if (t.value!=="agent" && t.value!=="response") return; draft.target=t.value;}
    else draft[field]=t.value;
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
  else if (key==="type" && isGradeType(t.value)) g.type=t.value;
  else if (key==="criteria" || key==="category" || key==="threshold" || key==="judgeId" || key==="name") g[key]=t.value;
  if (key==="name") $(".gd-inclusion span",item).textContent=g.name || "Proposed grader";
}
document.addEventListener("input",e=>updateDesignerField(e.target));
document.addEventListener("change",e=>{
  if (!textInput(e.target)) return;

  const t=e.target,panel=t.closest<HTMLElement>("[data-gd-scope]");
  if (!panel?.dataset.gdScope) return;
  if (t.hasAttribute("data-gd-source")) {
    workspaceGradeScope=t.value;
    panel.outerHTML=gradeDesignerView(workspaceGradeScope,true,true);
  } else {
    updateDesignerField(t);
    if (["type","included"].includes(t.dataset.gdField ?? "")) {
      const i=t.closest<HTMLElement>("[data-gd-check]")?.dataset.gdCheck;
      repaintGradeDesigner(panel.dataset.gdScope);
      document.querySelector<HTMLElement>('[data-gd-check="'+i+'"] [data-gd-field="'+t.dataset.gdField+'"]')?.focus({preventScroll:true});
    }
  }
});
document.addEventListener("click", async e=>{
  if (!(e.target instanceof Element)) return;

  const button=e.target.closest<HTMLButtonElement>("[data-gd-action]"),panel=button?.closest<HTMLElement>("[data-gd-scope]");
  if (!panel?.dataset.gdScope) return;
  e.preventDefault();
  const scope=panel.dataset.gdScope,d=gradeDesignerDraft(scope),action=button?.dataset.gdAction;
  if (!action || !button || d.busy) return;
  if (action==="discard") {
    d.hasPlan=false;d.checks=[];d.summary="";d.error="";
    repaintGradeDesigner(scope);return;
  }
  d.error="";d.busy=action;repaintGradeDesigner(scope);syncGraderDesignLaunch();
  try {
    if (action==="design") {
      const request:UiDesignGraderRequest=scope.startsWith("prompt:") ? {promptId:scope.slice(7)} : {objective:d.objective.trim(),metrics:d.metrics.trim(),
        industry:d.industry.trim(),target:d.target,...(scope.startsWith("dataset:")?{datasetId:scope.slice(8)}:{})};
      if ("objective" in request && (!request.objective || !request.metrics)) throw Error("Describe the task and at least one success measure.");
      const result=await api.designGraders(request);
      const judges=gradeDesignerLocalJudges();
      const preferred=judges.find(m=>m.loaded && m.model===result.designer?.model) || judges.find(m=>m.loaded) || judges[0];
      d.checks=result.checks.map(g=>({...g,included:true,proposedType:g.type,judgeId:preferred?.id || ""}));
      d.summary=result.summary;d.designer=result.designer;d.hasPlan=true;
    } else if (action==="confirm") {
      const definitions=validateGraderDefinitions(d);
      const selected=gradeSelectionForScope(scope);
      if (selected && retainedGraderIds(selected,definitions).length+definitions.length>8)
        throw Error("A run supports up to eight graders. Deselect existing graders or exclude checks before saving.");
      const ids=await api.confirmGraders(definitions);
      attachDesignedGraders(scope,ids,definitions);
      d.saved=ids.map((id,i)=>({id,label:definitions[i].name}));d.hasPlan=false;d.checks=[];
      if (document.querySelector<HTMLElement>("[data-gd-scope]")?.dataset.gdScope===scope) {
        await render();
        d.saved=d.saved.map(g=>{const def=state.graders.find(item=>item.id===g.id);return {...g,label:def?def.name+" · v"+def.version:g.label};});
      }
    }
  } catch(error) {d.error=String(errorText(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/,"");}
  finally {d.busy="";repaintGradeDesigner(scope);syncGraderDesignLaunch();}
});
