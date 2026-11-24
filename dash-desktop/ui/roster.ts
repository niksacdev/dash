"use strict";
const gridSections=["Local","Frontier Labs","Fine-tuned","Hosted"];
interface UiModelSelection {lanes:(string|null)[];requestedLane:number|null;search:string}
const emptySelection = ():UiModelSelection => ({ lanes: [null, null], requestedLane: null, search: "" });
const modelSelections = { quick: emptySelection(), dataset: emptySelection() };
const selectedModels = (mode:UiMode = "quick") => modelSelections[mode].lanes.filter((id): id is string => id!==null);
function resetModelSelection(mode:UiMode) {
  modelSelections[mode] = emptySelection();
}
const rosterModels=()=>[...models(),...(state.endpoints||[])];
const modelSection=(c:UiModel)=>c.section || "Local";
function rosterMark(c:UiModel){
  const f=modelFamily(c.model);
  return '<span class="model-logo">'+(f?'<img alt="" src="assets/model-logos/'+f+'.svg">':svg("candidate-i"))+'</span>';
}
function modelCapacityNote(c:UiModel) {
  const active=isNumber(c.contextTokens) && c.contextTokens>0 ? c.contextTokens : null;
  const max=isNumber(c.maxContextTokens) && c.maxContextTokens>0 ? c.maxContextTokens : null;
  const output=isNumber(c.maxOutputTokens) && c.maxOutputTokens>0 ? c.maxOutputTokens : null;
  return [active ? active.toLocaleString()+" active context" : "Active context unreported",
    max && max!==active ? max.toLocaleString()+" model maximum" : "", output ? output.toLocaleString()+" max output" : ""].filter(Boolean).join(" · ");
}
function capacityIssue(c:UiModel, approved:UiApproved|null) {
  if (approved?.inputCap && (c.provider!=="lmstudio" || c.loaded!==true))
    return "This strict input limit requires a loaded LM Studio model. Choose one or revise the input limit.";
  if (approved?.outputCap && c.maxOutputTokens && approved.outputCap>c.maxOutputTokens)
    return "Requested output exceeds the model’s "+c.maxOutputTokens.toLocaleString()+"-token output ceiling. Lower the limit or choose another model.";
  const limit=c.contextTokens || c.maxContextTokens;
  return approved?.outputCap && limit && approved.outputCap>=limit
    ? "Output limit leaves no room for the prompt. Lower the approved output limit or choose another model." : "";
}
const budgetPreviews:{promptId:string|null;lanes:Map<string,UiLaneBudget>;timer?:number;refreshing:boolean}={promptId:null, lanes:new Map(), timer:undefined, refreshing:false};
function clearBudgetPreviews() {
  clearTimeout(budgetPreviews.timer);
  budgetPreviews.promptId=null;
  budgetPreviews.lanes.clear();
}
function currentBudgetPreview(id:string) {
  return workflows.quick.approved?.id===budgetPreviews.promptId ? budgetPreviews.lanes.get(id) : null;
}
function laneBudgetState(model:UiModel, approved:UiApproved|null):UiLaneBudget {
  const preview=currentBudgetPreview(model.id);
  const localIssue=capacityIssue(model,approved);
  if (localIssue) return {...preview,status:"blocked",message:preview?.status==="blocked" ? preview.message : localIssue};
  if (preview) return preview;
  return {status:typeof api.previewQuickBudget==="function" ? "pending" : "unverified"};
}
function laneBudgetText(budget:UiLaneBudget,model:UiModel) {
  if (budget.status==="pending") return "Checking token allocation…";
  const input=isNumber(budget.inputTokens) ? budget.inputTokens.toLocaleString()+" input tokens" : "Input count unavailable";
  const output=isNumber(budget.outputReserve) ? budget.outputReserve.toLocaleString()+" output reserved" : "Output allocation unavailable";
  const context=isNumber(budget.contextTokens) && budget.contextTokens!==model.contextTokens ? budget.contextTokens.toLocaleString()+" active context" : "";
  if (budget.status==="blocked")
    return '<strong>Token check blocked</strong>'+esc(budget.message || "This prompt cannot run within the current limits.")+
      (isNumber(budget.inputTokens)?'<small>'+esc(input)+'</small>':'')+
      '<a class="link" data-qc-revise href="#prompts">Revise approved prompt →</a>';
  const prefix=budget.status==="verified"?"Verified · ":"";
  return esc(prefix+[input,output,context].filter(Boolean).join(" · "));
}
function laneBudgetMarkup(model:UiModel, approved:UiApproved|null) {
  const budget=laneBudgetState(model, approved);
  return '<div class="qc-lane-budget" data-qc-budget="'+esc(model.id)+'" data-budget-status="'+esc(budget.status)+'" aria-live="polite">'+laneBudgetText(budget,model)+'</div>';
}
function paintBudgetPreviews() {
  if (trail()[0]!=="compare" || !document.querySelector("#quick-models")) return;
  const roster=rosterModels();
  for (const node of document.querySelectorAll<HTMLElement>("[data-qc-budget]")) {
    const model=roster.find(c=>c.id===node.dataset.qcBudget);
    if (!model) continue;
    const budget=laneBudgetState(model,workflows.quick.approved);
    const text=laneBudgetText(budget,model);
    if (node.dataset.budgetStatus!==budget.status || node.innerHTML!==text) {
      node.dataset.budgetStatus=budget.status;
      node.innerHTML=text;
    }
  }
  updateQuickGradingControls();
}
function scheduleBudgetPreview() {
  clearTimeout(budgetPreviews.timer);
  const approved=workflows.quick.approved;
  if (trail()[0]!=="compare" || !approved || !document.querySelector("#quick-models")) {
    clearBudgetPreviews(); return;
  }
  if (typeof api.previewQuickBudget!=="function" || budgetPreviews.refreshing || workflows.quick.busy || state.active) return;
  if (budgetPreviews.promptId!==approved.id) {
    clearBudgetPreviews();
    budgetPreviews.promptId=approved.id;
  }
  const selected=selectedModels();
  for (const id of budgetPreviews.lanes.keys()) if (!selected.includes(id)) budgetPreviews.lanes.delete(id);
  const missing=selected.filter(id=>!budgetPreviews.lanes.has(id));
  if (!missing.length) return;
  // Batch rapid taps; keep an in-flight result for an unchanged lane.
  budgetPreviews.timer=setTimeout(async()=>{
    if (trail()[0]!=="compare" || !document.querySelector("#quick-models") || workflows.quick.busy || state.active) return;
    const pending:UiLaneBudget={status:"pending"};
    for (const id of missing) budgetPreviews.lanes.set(id,pending);
    let rows:UiLaneBudget[]=[];
    try {
      const result=await api.previewQuickBudget(approved.id,missing);
      if (Array.isArray(result)) rows=result;
    } catch {
      // Dispatch performs its own token check if the preview service is unavailable.
    }
    if (budgetPreviews.promptId!==approved.id || workflows.quick.approved?.id!==approved.id || trail()[0]!=="compare" || !document.querySelector("#quick-models")) return;
    for (const id of missing) {
      if (budgetPreviews.lanes.get(id)!==pending || !selectedModels().includes(id)) continue;
      const row=rows.find(r=>r?.candidateId===id);
      budgetPreviews.lanes.set(id,row && ["verified","unverified","blocked"].includes(row.status)?row:{status:"unverified"});
    }
    paintBudgetPreviews();
  },120);
}
function canStartQuick() {
  const approved=workflows.quick.approved;
  if (!approved || state.active || workflows.quick.busy || graderDesignDrafts.get("prompt:"+approved.id)?.busy || selectedModels().length!==2 || quickGradeIssue(quickGradePlan())) return false;
  return !rosterModels().some(c=>selectedModels().includes(c.id) && laneBudgetState(c,approved).status==="blocked");
}
function lineSlots(mode:UiMode){
  const {lanes}=modelSelections[mode];
  const roster=rosterModels();
  return [0,1].map(i=>{
    const model=roster.find(c=>c.id===lanes[i]);
    return '<div class="grid-slot '+(model?'occupied':'')+'"><div class="slot-track">'+svg("car","grid-car")+'</div><div><small>Lane '+(i+1)+'</small>'+
      (model?'<strong>'+esc(displayModel(model.model))+'</strong>':'<button class="choose-slot" type="button" data-choose-slot="'+i+'">Choose a model <span aria-hidden="true">↗</span></button>')+(model?'<small>'+esc(model.endpoint || model.provider)+'</small><small>'+esc(modelCapacityNote(model))+'</small>' + (mode==="quick" ? laneBudgetMarkup(model,workflows.quick.approved) : ""):'')+'</div>'+
      (model?'<button type="button" class="remove-model" data-remove="'+esc(model.id)+'" aria-label="Remove '+esc(model.model)+'">×</button>':'')+'</div>';
  }).join("");
}
function rosterGroups(mode:UiMode){
  const selection=modelSelections[mode];
  const search=selection.search.trim().toLowerCase(), all=rosterModels();
  return gridSections.map(section=>{
    const group=all.filter(c=>modelSection(c)===section);
    const items=group.filter(c=>(c.model+" "+c.provider+" "+section+" "+(c.endpoint||"")).toLowerCase().includes(search));
    return '<section class="roster-group"><div class="group-name"><strong>'+esc(section)+'</strong><small>'+items.length+'</small></div><div class="roster-list">'+
      (items.length ? items.map(c=>{
        const entered=selection.lanes.includes(c.id);
        const runtime=c.endpoint?new URL(c.endpoint).host:(c.provider==="lmstudio"?"LM Studio":c.provider==="ollama"?"Ollama":c.provider);
        const status=c.needsKey?"Enter session key":c.loaded===true?"Loaded":c.loaded===false?"On disk":"";
        return '<button type="button" class="roster-model" data-model="'+esc(c.id)+'" aria-pressed="'+entered+'" '+
          ((selectedModels(mode).length===2&&!entered)||c.needsKey?'disabled':'')+' title="'+esc(c.model)+'">'+rosterMark(c)+'<span><b>'+esc(displayModel(c.model))+'</b>'+
          '<small>'+esc([runtime,status].filter(Boolean).join(" · "))+'</small></span><i aria-hidden="true">'+(entered?'✓':'+')+'</i></button>';
      }).join("") : '<small class="roster-empty">'+(search?"No matches":section==="Local"?"Refresh local runtimes":"No models connected")+'</small>')+'</div></section>';
  }).join("");
}
function canStartDataset() {
  return !state.active && !workflows.dataset.busy && !graderDesignDrafts.get(activeDatasetGraderScope())?.busy && selectedModels("dataset").length > 0 && !referenceScoringIssue();
}
function modelPicker(mode:UiMode, caseCount=0) {
  const quick = mode === "quick";
  const selection = modelSelections[mode];
  const available = rosterModels();
  selection.lanes = selection.lanes.map(id => available.some(c => c.id === id && !c.needsKey) ? id : null);
  const status = quick
    ? '<p id="qc-grade-status" role="status">' + esc(quickGradeStatus()) + '</p>'
    : '<p class="picker-note">Choose one or two models. Each receives ' + esc(caseCount) + (caseCount===1?' case.':' cases.') + '</p>';
  const ready = quick ? canStartQuick() : canStartDataset();
  return '<section class="model-picker" data-picker-mode="'+mode+'" id="'+mode+'-models"><div class="qc-launch-row">'+
    '<div class="picker-heading"><h2>Starting line</h2><span id="pick-count" role="status">'+selectedModels(mode).length+' / 2 ready</span></div>'+
    '<button type="submit" aria-label="'+(quick?'Go · compare both responses':'Start dataset run')+'" class="go-button" '+(!ready?'disabled':'')+'>GO <b aria-hidden="true">❯</b></button></div>'+
    '<div class="starting-grid">'+lineSlots(mode)+'</div>'+status+
    '<section class="compare-roster" aria-labelledby="roster-heading"><div class="picker-heading"><h2 id="roster-heading">Model roster</h2>'+btn("Refresh","refresh","quiet")+'</div>'+
    '<label class="field"><span class="visually-hidden">Search models</span><input type="search" id="model-search" value="'+esc(selection.search)+'" placeholder="Find a model or runtime"></label>'+
    '<div id="roster-groups">'+rosterGroups(mode)+'</div></section></section>';
}
function setupQuick() {
  return '<form id="setup" class="compare-console">'+modelPicker("quick")+gradeDesignerView("prompt:"+workflows.quick.approved?.id)+quickGradePicker()+'</form>'+endpointForm()+hostingLegend();
}
function updateGrid(picker:HTMLElement) {
  const mode = picker?.dataset.pickerMode;
  if (!picker || !isRunMode(mode)) return;
  const focus = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.model : undefined;
  $(".starting-grid",picker).innerHTML = lineSlots(mode);
  $("#roster-groups",picker).innerHTML = rosterGroups(mode);
  $("#pick-count",picker).textContent = selectedModels(mode).length + " / 2 ready";
  if (mode === "quick") {
    updateQuickGradingControls();
    scheduleBudgetPreview();
  } else {
    requireElement(".go-button",HTMLButtonElement,picker).disabled = !canStartDataset();
  }
  if (focus) picker.querySelector<HTMLButtonElement>('[data-model="'+CSS.escape(focus)+'"]')?.focus({preventScroll:true});
}
function endpointForm(){
  return '<details class="card spacer"><summary>Connect a model endpoint</summary><form id="endpoint-form" class="spacer"><div class="cols">'+
    '<label class="field"><span>Section</span><select name="section">'+gridSections.slice(1).map(s=>opt(s,s,"Hosted")).join("")+'</select></label>'+
    '<label class="field"><span>Model identifier</span><input name="model" required maxlength="240"></label></div>'+
    '<label class="field"><span>OpenAI-compatible API base</span><input name="baseUrl" type="url" required placeholder="https://your-server.example/v1"></label>'+
    '<label class="field"><span>API key for this session (optional)</span><input type="password" name="key" autocomplete="off"></label>'+
    '<button>Save endpoint</button><p class="muted">Starting a run sends its inputs to the model destinations shown on the starting line.</p></form></details>';
}
document.addEventListener("input",e=>{
  if (!textInput(e.target)) return;

  if (e.target.id !== "model-search") return;
  const picker = e.target.closest<HTMLElement>("[data-picker-mode]");
  const mode = picker?.dataset.pickerMode;
  if (!picker || !isRunMode(mode)) return;
  modelSelections[mode].search = e.target.value;
  $("#roster-groups",picker).innerHTML = rosterGroups(mode);
});
document.addEventListener("click",e=>{
  if (!(e.target instanceof Element)) return;

  if (e.target.closest("[data-qc-revise]")) {
    const revision=dashElement(".wf-approved [data-wf-revise]",HTMLButtonElement);
    if (revision) {e.preventDefault();revision.click();}
    return;
  }
  const picker=e.target.closest<HTMLElement>("[data-picker-mode]");
  if (!picker) return;
  const mode=picker.dataset.pickerMode;
  if (!isRunMode(mode)) return;
  const selection=modelSelections[mode];
  const lineup=selection.lanes;
  const slot=e.target.closest<HTMLButtonElement>("[data-choose-slot]");
  if(slot){
    selection.requestedLane=Number(slot.dataset.chooseSlot);
    dashElement("#model-search",HTMLInputElement)?.focus();
    return;
  }
  const b=e.target.closest<HTMLButtonElement>("[data-model],[data-remove]");
  if(!b)return;
  const id=b.dataset.model || b.dataset.remove;
  if (!id) return;
  const prior=lineup.indexOf(id);
  if(prior>=0)lineup[prior]=null;
  else {
    const {requestedLane}=selection;
    const lane=requestedLane!==null && lineup[requestedLane]===null ? requestedLane : lineup.indexOf(null);
    if(lane>=0)lineup[lane]=id;
  }
  selection.requestedLane=null;
  updateGrid(picker);
});
document.addEventListener("submit",async e=>{
  if (!(e.target instanceof HTMLFormElement)) return;

  if(e.target.id!=="endpoint-form")return;
  e.preventDefault();
  const f=e.target;
  const submit=f.querySelector<HTMLButtonElement>('button[type="submit"],button:not([type])'),stillHere=currentVisit();
  if (!submit || submit.disabled)return;
  submit.disabled=true;f.querySelector(":scope > [data-action-error]")?.remove();
  try {
    await api.saveEndpoint({section:formText(f,"section"),model:formText(f,"model"),baseUrl:formText(f,"baseUrl"),key:formText(f,"key")});
    if(stillHere()){await render();message("Model endpoint saved.");}
  } catch(error){inlineError(f,error);}
  finally{submit.disabled=false;}
});
