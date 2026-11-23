"use strict";
const graderTypes={contains:"Contains required text",exact:"Exact answer",field:"JSON field matches reference",trajectory:"Agent actions in order",judge:"Local LLM rubric (legacy)",opik:"Opik G-Eval",decision:"Decision model · yes/no"};
const graderHints={contains:"Text the output must contain",exact:"Expected answer",field:'{"outputField":"team","referenceField":"team"}',trajectory:"One required tool or action name per line",judge:"Describe what earns full, partial and zero credit.",opik:"Describe the task, evaluation criteria and what distinguishes a good answer.",decision:"Does the response hold the lot when the measurement exceeds the drawing tolerance?"};
const formField=(label:string,input:string)=>'<label class="field"><span>'+esc(label)+'</span>'+input+'</label>';
const datasetGradeSelections=new Map<string,Set<string>>();
function datasetGradeSelection(scope:string) {
  const selected=datasetGradeSelections.get(scope) ?? new Set(readGraderAttachment(scope)?.ids);
  datasetGradeSelections.set(scope,selected);
  return selected;
}
function selectedGraderIds(){return [...datasetGradeSelection(activeDatasetGraderScope())];}
function graderPicker(){
  const list=state.graders||[],scope=activeDatasetGraderScope(),chosen=datasetGradeSelection(scope);
  return gradeDesignerView(scope)+'<details class="card grader-picker" data-grade-scope="'+esc(scope)+'"><summary>Additional graders · '+chosen.size+' selected</summary>'+
    list.map(g=>'<label class="choice"><input type="checkbox" name="custom-grader" value="'+esc(g.id)+'" '+(chosen.has(g.id)?"checked":"")+'>'+esc([g.name+" v"+g.version,g.category,decisionTarget(g)].filter(Boolean).join(" · "))+'</label>').join("")+
    link("Open grader library →","graders","link")+'</details>';
}
function decisionSource(provider:UiDecisionConfig["provider"]) {
  return provider==="local" ? "Local decision server" : "OpenRouter";
}
function decisionProtocolLabel(protocol?:UiDecisionProtocol) {return protocol==="mlx-vlm"?"MLX-VLM":"System One";}
function decisionTarget(g:UiGraderDefinition) {
  return g.decision ? [decisionSource(g.decision.provider),g.decision.provider==="local"?decisionProtocolLabel(g.decision.protocol):"",g.decision.model].filter(Boolean).join(" · ") : "";
}
const evidenceScope = "The grader receives its yes/no question, the candidate input and output, and any available reference answer, SME notes, case rubric, approved objective and criteria, or supplied agent actions.";
function hostedDecisionConsent(graders:readonly UiGrader[], scope:string):{allowHostedDecision?:true}|null {
  const hosted=graders.filter(g=>g.type==="decision" && g.decision?.provider==="openrouter");
  if (!hosted.length) return {};
  const targets=hosted.map(g=>g.name+" v"+g.version+" → "+g.decision?.model);
  return window.confirm("Send grading evidence to OpenRouter for "+scope+"?\n\n"+
    targets.join("\n")+"\n\n"+evidenceScope+"\n\nOpenRouter and its serving provider will receive this evidence. Usage may incur charges. This confirmation applies only to this action.") ? {allowHostedDecision:true} : null;
}
function graderConsentById(ids:readonly string[],scope:string) {
  return hostedDecisionConsent(ids.map(id=>{
    const saved=state.graders.find(g=>g.id===id);
    if(!saved) throw Error("A selected grader version is unavailable. Refresh the grader library.");
    return saved;
  }),scope);
}
function scoreRows(rows:UiAssessment[]){
  return rows.length?table(["Grader","Candidate / case","Score","Decision","Evidence"],rows.map(r=>{
    const d=r.decision;
    const target=d ? decisionSource(d.provider)+" · "+d.actualModel :
      r.decisionRequest ? decisionSource(r.decisionRequest.provider)+" · requested "+r.decisionRequest.requestedModel : r.judge;
    const model=target?'<small class="block">'+esc(target)+'</small>':"";
    const fallback=d?.fallbackReason ?? r.decisionAttempt?.fallbackReason;
    const usedFallback=fallback ? '<small class="block">Alternate model used · '+(fallback==="primary-unavailable"?"primary unavailable":"primary lacks decision support")+(r.decisionAttempt && !d?" · "+esc(r.decisionAttempt.dispatchedModel):"")+'</small>' : "";
    const requested=d && d.requestedModel!==d.actualModel?'<small class="block">Requested '+esc(d.requestedModel)+'</small>':"";
    const probability=d?'<small class="block">P(yes) '+esc(d.probabilityYes)+' · fail ≤ '+esc(d.failAt)+' · pass ≥ '+esc(d.passAt)+'</small>':"";
    const outcome=r.pass==null ? d ? "Abstained · unscored" : "Unscored" : r.pass ? "Passed" : (d || r.engine==="decision") ? "Failed" : "Review";
    return [esc(r.name+" v"+r.version)+model+requested+usedFallback,esc([r.candidate,r.caseId].filter(Boolean).join(" / ")||"Provided output"),
      r.value==null?"—":esc(metricNumber(r.value)),esc(outcome),esc(r.reason)+probability];
  })):"";
}
let gradeFilter="",graderDraft:UiGrader|null=null;
function judgeOptions(id?:string|null){return opt("","Choose a local model",id)+models().map(m=>opt(m.id,m.model+" · "+m.provider,id)).join("");}
const hostedDecisionModels=["liquid/d1.2","liquid/d1.2-ultra","typesafe/jev-1.14"];
const decisionStarters = {
  earnings:{name:"GAAP diluted EPS support",industry:"Financial Services",category:"Financial fact accuracy",
    criteria:"Does the answer report the requested diluted EPS using the reference’s GAAP figure for that period, keeping it distinct from adjusted EPS?"},
  inspection:{name:"Inspection disposition evidence",industry:"Manufacturing",category:"Inspection disposition",
    criteria:"Does the proposed lot disposition follow the acceptance limits for the current drawing revision in the inspection reference?"},
};
function decisionFields(g:UiGraderDefinition) {
  const d=g.decision,local=d?.provider!=="openrouter",enabled=g.type==="decision",mlx=d?.protocol==="mlx-vlm";
  const evidenceCheck=(id:UiDecisionEvidence,label:string)=>'<label class="choice"><input type="checkbox" name="decision-evidence" value="'+id+'" '+(g.requiredEvidence?.includes(id)?'checked':'')+'>'+label+'</label>';
  return '<fieldset id="grade-decision" '+(enabled?'':'disabled hidden')+'><legend>Decision model</legend>'+
    (!graderDraft?'<div><span>Start from a domain criterion</span> <button type="button" data-decision-starter="earnings">GAAP vs. adjusted EPS</button> <button type="button" data-decision-starter="inspection">Inspection disposition</button></div>':'')+
    formField("Run the grader on",'<select name="decision-provider">'+opt("local","Local decision server",local?"local":"openrouter")+opt("openrouter","OpenRouter",local?"local":"openrouter")+'</select>')+
    '<fieldset id="grade-decision-local" '+(local?'':'disabled hidden')+'><legend>Local connection</legend>'+
    formField("Local decision runtime",'<select name="decision-protocol">'+opt("systemone","System One · llama.cpp / LM Studio",d?.protocol || "systemone")+opt("mlx-vlm","MLX-VLM · native decisions",d?.protocol || "systemone")+'</select>')+
    formField("Loopback server URL",'<input type="url" name="decision-endpoint" required value="'+esc(local && d?.endpoint || "http://127.0.0.1:8080")+'">')+
    '<button type="button" id="grade-discover">Find decision models</button><small id="grade-discovery-status" role="status"></small>'+
    '<label id="grade-discovered" class="field" hidden><span>Advertised models</span><select name="decision-discovered"></select></label>'+
    formField(mlx?"Preloaded checkpoint · absolute path":"Served model ID or alias",'<input name="decision-model" required maxlength="512" value="'+esc(local && d?d.model:"")+'">')+
    '<small id="decision-mlx-tip" '+(mlx?'':'hidden')+'>Start MLX-VLM with <code>--decision-model /absolute/path/to/checkpoint</code>. Find decision models reads the directory loaded by that server.</small>'+
    '<details class="wf-options" '+(d?.fallbackModel?'open':'')+'><summary>Alternate local model</summary>'+
    formField(mlx?"Alternate checkpoint · absolute path (optional)":"Alternate served model ID (optional)",'<input name="decision-fallback" maxlength="512" value="'+esc(d?.fallbackModel)+'">')+
    '<small>The same server may use this model if the primary is unavailable before grading. DASH records which model answered.</small></details></fieldset>'+
    '<fieldset id="grade-decision-hosted" '+(local?'disabled hidden':'')+'><legend>Hosted connection</legend>'+
    formField("OpenRouter decision model",'<select name="decision-hosted-model">'+hostedDecisionModels.map(id=>opt(id,id,local?hostedDecisionModels[0]:d?.model)).join("")+'</select>')+
    '<p>Start DASH with <code>OPENROUTER_API_KEY</code> set. '+esc(evidenceScope)+' DASH asks before sending evidence for each run or manual grade.</p></fieldset>'+
    formField("Fail when P(yes) is at or below",'<input type="number" name="decision-fail" required min="0" max="1" step="any" value="'+esc(d?.failAt ?? 0.2)+'">')+
    '<small>Probabilities between the fail and pass cutoffs abstain and stay unscored.</small>'+
    '<fieldset><legend>Evidence required to grade</legend>'+evidenceCheck("reference","Reference answer")+evidenceCheck("trajectory","Observed agent actions")+
    '<small>If a required item is missing, the case stays unscored.</small></fieldset></fieldset>';
}
function updateDecisionProvider(form:HTMLFormElement) {
  const local=formText(form,"decision-provider")==="local";
  for(const [selector,active] of [["#grade-decision-local",local],["#grade-decision-hosted",!local]] as const) {
    const fieldset=requireElement(selector,HTMLFieldSetElement,form);
    fieldset.hidden=fieldset.disabled=!active;
  }
}
let discoverySequence=0;
function resetDecisionDiscovery(form:HTMLFormElement) {
  discoverySequence++;
  $("#grade-discovered",form).hidden=true;
  $("#grade-discovery-status",form).textContent="";
  requireElement("#grade-discover",HTMLButtonElement,form).disabled=false;
}
async function discoverDecisionModels(form:HTMLFormElement,button:HTMLButtonElement) {
  const request=++discoverySequence,endpoint=formText(form,"decision-endpoint");
  const status=$("#grade-discovery-status",form),advertised=$("#grade-discovered",form);
  advertised.hidden=true; button.disabled=true; status.textContent="Checking local decision server…";
  try {
    const protocol=formText(form,"decision-protocol")==="mlx-vlm"?"mlx-vlm":"systemone";
    const ids=await api.listDecisionModels(endpoint,protocol);
    if(request!==discoverySequence || !form.isConnected) return;
    if(!ids.length){status.textContent="No decision models advertised at this URL.";return;}
    const field=requireElement("[name=decision-model]",HTMLInputElement,form);
    if(ids.length===1 && !field.value.trim()) field.value=ids[0];
    const choices=requireElement("[name=decision-discovered]",HTMLSelectElement,form);
    choices.replaceChildren(new Option("Choose a served model",""),...ids.map(id=>new Option(id,id)));
    choices.value=ids.includes(field.value)?field.value:"";
    advertised.hidden=false;status.textContent=ids.length+" decision model"+(ids.length===1?"":"s")+" advertised.";
  } catch(error){if(request===discoverySequence)status.textContent=errorText(error);}
  finally{if(request===discoverySequence)button.disabled=false;}
}
function gradeCreate(){
  const g:UiGraderDefinition & {judge?:UiModel|null}=graderDraft ? {...graderDraft,type:graderDraft.type==="judge"?"opik":graderDraft.type} :
    {name:"",category:"",industry:"Cross-industry",criteria:"",type:"opik",threshold:1};
  return '<details class="panel" '+(graderDraft?'open':'')+'><summary>Create or revise a grader</summary><form id="grade-create" data-method="'+esc(g.type)+'" class="spacer"><div class="cols">'+
    formField("Grader name",'<input name="name" required maxlength="100" value="'+esc(g.name)+'">')+
    formField("Category",'<input name="category" required maxlength="100" value="'+esc(g.category)+'" placeholder="e.g. Factual accuracy">')+'</div><div class="cols">'+
    formField("Industry",'<select name="industry">'+industryOptions(g.industry)+'</select>')+
    formField("Method",'<select name="type" id="grade-type">'+Object.entries(graderTypes).filter(([k])=>k!=="judge").map(([k,v])=>k==="opik"&&!state.opikReady?'<option disabled>Opik G-Eval · SDK unavailable</option>':opt(k,v,g.type)).join("")+'</select>')+'</div>'+
    formField(g.type==="decision"?"Yes/no criterion · yes means pass":"Rule or rubric",'<textarea name="criteria" required maxlength="6000" placeholder="'+esc(graderHints[g.type])+'">'+esc(g.criteria)+'</textarea>')+
    decisionFields(g)+'<div class="cols">'+formField(g.type==="decision"?"Pass when P(yes) is at or above":"Pass threshold (0–1)",'<input name="threshold" type="number" min="0" max="1" step="any" required value="'+esc(g.threshold)+'">')+
    '<div id="judge-choice" '+(["judge","opik"].includes(g.type)?"":"hidden")+'>'+formField("Judge model",'<select name="judgeId">'+judgeOptions(g.judge?.id)+'</select>')+'</div></div>'+
    '<button class="yellow">Save grader version</button></form></details>';
}
function gradeSelect(){return '<select name="grader" required>'+opt("","Choose a grader","")+(state.graders||[]).map(g=>opt(g.id,[g.name+" v"+g.version,g.category,decisionTarget(g)].filter(Boolean).join(" · "),"")).join("")+'</select>';}
async function gradersPage(){
  const list=state.graders||[], samples=await api.graderSamples();
  return heading("Workspace","Graders","Define how to judge an inference response or an agent’s work. Reuse a saved version across runs.")+
    gradeDesignerView(workspaceGradeScope,true)+gradeCreate()+bar("Grader library")+'<section class="panel">'+formField("Filter by category, industry or name",'<input type="search" id="grade-filter" value="'+esc(gradeFilter)+'">')+
    list.map(g=>'<div class="listrow grader-row" data-filter="'+esc([g.category,g.industry,g.name].join(" ").toLowerCase())+'" '+([g.category,g.industry,g.name].join(" ").toLowerCase().includes(gradeFilter.toLowerCase())?"":"hidden")+'><div><strong>'+
      esc(g.name+" · v"+g.version)+'</strong><small>'+esc([g.category,g.industry,graderTypes[g.type],decisionTarget(g)].filter(Boolean).join(" · "))+'</small><p>'+esc(g.criteria)+'</p></div><button data-revise="'+esc(g.id)+'">Revise</button></div>').join("")+
    (list.length?'':'<p>No custom graders yet. Create a rule, Opik judge or decision grader above.</p>')+'</section>'+
    bar("Grade an output")+'<form id="grade-sample" class="panel">'+formField("Grader",gradeSelect())+
    '<div class="cols">'+formField("Task or input",'<textarea name="input" required></textarea>')+formField("Model or agent output",'<textarea name="output" required></textarea>')+'</div>'+
    '<details><summary>Reference and agent trajectory</summary>'+formField("Reference (JSON or text)",'<textarea name="reference"></textarea>')+
    formField("Agent steps in order (JSON array)",'<textarea name="trajectory" placeholder=\'[{"tool":"search"},{"tool":"summarize"}]\'></textarea>')+'</details>'+
    '<button class="yellow spacer" '+(list.length?"":"disabled")+'>Run grader</button></form>'+
    (samples.length?bar("Recent evaluations")+'<div class="panel">'+scoreRows(samples)+'</div>':"");
}
function caseGrading(run:UiRunDetail,r:UiResult,index:number){
  const rows=(run.assessments||[]).filter(a=>a.caseId===r.caseId && a.candidate===r.candidateId);
  return bar("Grader evaluations")+'<div class="panel">'+scoreRows(rows)+(!r.error?'<form id="grade-case" data-id="'+esc(run.manifest.id)+'" data-index="'+index+'">'+
    formField("Apply a saved grader",gradeSelect())+'<button '+(state.graders?.length?"":"disabled")+'>Grade this output</button></form>':'')+'</div>';
}
document.addEventListener("change",e=>{
  if (!textInput(e.target)) return;

  if(e.target.name==="custom-grader"){
    const picker=e.target.closest<HTMLElement>("[data-grade-scope]");
    if (!picker?.dataset.gradeScope || !(e.target instanceof HTMLInputElement)) return;
    const chosen=datasetGradeSelection(picker.dataset.gradeScope);
    if(e.target.checked)chosen.add(e.target.value);else chosen.delete(e.target.value);
    if (readGraderAttachment(picker.dataset.gradeScope)) writeGraderAttachment(picker.dataset.gradeScope,chosen);
    $("summary",picker).textContent="Additional graders · "+chosen.size+" selected";
  }
  if(e.target.id==="grade-type"){
    const f=e.target.form;
    if (!f || !isGradeType(e.target.value)) return;
    const decision=e.target.value==="decision";
    const field=requireElement("[name=criteria]",HTMLTextAreaElement,f);
    field.placeholder=graderHints[e.target.value];
    if(field.parentElement) $("span",field.parentElement).textContent=decision?"Yes/no criterion · yes means pass":"Rule or rubric";
    const pass=requireElement("[name=threshold]",HTMLInputElement,f);
    if(pass.parentElement)$("span",pass.parentElement).textContent=decision?"Pass when P(yes) is at or above":"Pass threshold (0–1)";
    if((f.dataset.method==="decision")!==decision){
      if(decision){pass.dataset.other=pass.value;pass.value=pass.dataset.decision || "0.8";}
      else {pass.dataset.decision=pass.value;pass.value=pass.dataset.other || "1";}
    }
    f.dataset.method=e.target.value;
    const decisionControls=requireElement("#grade-decision",HTMLFieldSetElement,f);
    decisionControls.hidden=decisionControls.disabled=!decision;
    $("#judge-choice",f).hidden=!["opik","judge"].includes(e.target.value);
    resetDecisionDiscovery(f);
  }
  if(e.target.name==="decision-protocol" && e.target.form){
    const form=e.target.form,mlx=e.target.value==="mlx-vlm";
    const model=form.querySelector("[name=decision-model]")?.closest("label");
    const alternate=form.querySelector("[name=decision-fallback]")?.closest("label");
    if(model)$("span",model).textContent=mlx?"Preloaded checkpoint · absolute path":"Served model ID or alias";
    if(alternate)$("span",alternate).textContent=mlx?"Alternate checkpoint · absolute path (optional)":"Alternate served model ID (optional)";
    $("#decision-mlx-tip",form).hidden=!mlx;
    resetDecisionDiscovery(form);
  }
  if(e.target.name==="decision-provider" && e.target.form){updateDecisionProvider(e.target.form);resetDecisionDiscovery(e.target.form);}
  if(e.target.name==="decision-discovered" && e.target.form && e.target.value)
    requireElement("[name=decision-model]",HTMLInputElement,e.target.form).value=e.target.value;
});
document.addEventListener("input",e=>{
  if (!textInput(e.target)) return;
  if(e.target.name==="decision-endpoint" && e.target.form)resetDecisionDiscovery(e.target.form);
  if(e.target.id==="grade-filter"){gradeFilter=e.target.value;document.querySelectorAll<HTMLElement>(".grader-row").forEach(r=>r.hidden=!(r.dataset.filter || "").includes(gradeFilter.toLowerCase()));}});
document.addEventListener("click",e=>{
  if (!(e.target instanceof Element)) return;
  const starter=e.target.closest<HTMLButtonElement>("[data-decision-starter]");
  const kind=starter?.dataset.decisionStarter;
  if(starter?.form && (kind==="earnings" || kind==="inspection")){
    const form=starter.form,example=decisionStarters[kind];
    for(const [name,value] of Object.entries(example)){
      const control=form.elements.namedItem(name);
      if(textInput(control))control.value=value;
    }
    requireElement("input[value=reference]",HTMLInputElement,form).checked=true;
    const criteria=requireElement("[name=criteria]",HTMLTextAreaElement,form);
    criteria.focus();message("Starter applied. Review the criterion and save your grader version.");
    return;
  }
  const discover=e.target.closest<HTMLButtonElement>("#grade-discover");
  if(discover?.form){void discoverDecisionModels(discover.form,discover);return;}
  const el=e.target.closest<HTMLButtonElement>("[data-revise]");if(el){graderDraft=state.graders.find(g=>g.id===el.dataset.revise) || null;render().then(()=>dashElement("#grade-create input",HTMLInputElement)?.focus());}});
document.addEventListener("submit",async e=>{
  if (!(e.target instanceof HTMLFormElement)) return;

  if(!["grade-case","grade-sample","grade-create"].includes(e.target.id))return;
  e.preventDefault();const f=e.target,b=requireElement("button:not([type=button])",HTMLButtonElement,f);
  const field=(name:string)=>formText(f,name);
  b.disabled=true;
  const title=b.textContent;
  try{
    if(f.id==="grade-create"){
      const type=field("type");
      if (!isGradeType(type)) throw Error("Choose a grading method.");
      const definition:UiGraderDefinition={name:field("name"),criteria:field("criteria"),industry:field("industry"),category:field("category"),type,threshold:Number(field("threshold")),judgeId:field("judgeId")};
      if(type==="decision"){
        const local=field("decision-provider")==="local",failAt=Number(field("decision-fail"));
        if(!(failAt>=0 && failAt<definition.threshold && definition.threshold<=1)) throw Error("Choose a fail cutoff below the pass cutoff, both between 0 and 1.");
        const protocol=field("decision-protocol")==="mlx-vlm"?"mlx-vlm":"systemone",fallbackModel=field("decision-fallback").trim();
        if(local && protocol==="mlx-vlm" && [field("decision-model").trim(),fallbackModel].some(id=>id && !id.startsWith("/")))
          throw Error("For MLX-VLM, enter the absolute checkpoint directory served by the local runtime.");
        definition.decision=local ? {provider:"local",endpoint:field("decision-endpoint").trim(),model:field("decision-model").trim(),failAt,protocol,...(fallbackModel && {fallbackModel})} :
          {provider:"openrouter",model:field("decision-hosted-model"),failAt};
        delete definition.judgeId;
        const checked=new FormData(f).getAll("decision-evidence");
        definition.requiredEvidence=(["reference","trajectory"] as const).filter(key=>checked.includes(key));
      }
      await api.saveGrader(definition);
      graderDraft=null; message("Grader version saved.");
    }
    else {
      b.textContent="Grading…";
      let request:UiGradeRequest;
      const grader=field("grader");
      if(f.id==="grade-case" && f.dataset.id){request={grader,run:f.dataset.id,index:Number(f.dataset.index)};}
      else {
        const raw=field("reference");
        let reference:unknown=raw || null;
        try{reference=JSON.parse(raw);}catch{}
        const supplied=field("trajectory").trim();
        const trajectory:unknown=supplied ? JSON.parse(supplied) : undefined;
        if (supplied && !Array.isArray(trajectory)) throw Error("Agent steps must be a JSON array.");
        request={grader,evidence:{input:field("input"),output:field("output"),reference,...(Array.isArray(trajectory) && {trajectory})}};
      }
      const consent=graderConsentById([grader],f.id==="grade-case"?"this saved case":"this provided output");
      if(!consent)return;
      const result=await api.assess({...request,...consent});message(result.pass==null?"Unscored · "+result.reason:"Evaluation saved.");
    }
    await render();
  }catch(error){message(errorText(error));}finally{b.disabled=false;b.textContent=title;}
});
