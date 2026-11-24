"use strict";
const graderTypes={"opik-metric":"Opik library metric",catalog:"Versioned catalog rule",contains:"Contains required text",exact:"Exact answer",field:"JSON field matches reference",trajectory:"Agent actions in order",judge:"Local LLM rubric (legacy)",opik:"Opik G-Eval",decision:"Decision model · yes/no"};
const graderHints={"opik-metric":"The Opik metric defines its criterion.",catalog:"The selected rule defines its deterministic check.",contains:"Text the output must contain",exact:"Expected answer",field:'{"outputField":"team","referenceField":"team"}',trajectory:"One required tool or action name per line",judge:"Describe what earns full, partial and zero credit.",opik:"Describe the task, evaluation criteria and what distinguishes a good answer.",decision:"Does the response hold the lot when the measurement exceeds the drawing tolerance?"};
const formField=(label:string,input:string)=>'<label class="field"><span>'+esc(label)+'</span>'+input+'</label>';
const datasetGradeSelections=new Map<string,Set<string>>();
function datasetGradeSelection(scope:string) {
  const selected=datasetGradeSelections.get(scope) ?? new Set(readGraderAttachment(scope)?.ids);
  datasetGradeSelections.set(scope,selected);
  return selected;
}
const catalogSections:readonly {scope:UiGraderScope;title:string}[]=[
  {scope:"general",title:"General"},{scope:"industry",title:"Industry"},{scope:"customer",title:"My graders"},
];
let datasetGradingChoices:UiGraderOptions|null=null;
function graderScope(g:UiGrader):UiGraderScope{return g.library?.scope || "customer";}
function graderScenario(g:UiGrader) {
  const id=g.library?.scenario;
  return id ? state.packs.find(p=>p.id===id)?.title || id : "";
}
function graderApplicability(g:UiGrader) {
  return [g.industry,graderScenario(g),graderTypes[g.type],decisionTarget(g) || g.judge?.model,g.evidenceView==="answer-only"?"Answer only":"",
    g.metricKey && state.opikLibraryTemplates.find(t=>t.key===g.metricKey)?.requiresReference?"Requires a case reference":"",
    g.requiredEvidence?.length?"Requires "+g.requiredEvidence.map(e=>e==="reference"?"a reference answer":"observed agent actions").join(" and "):""
  ].filter(Boolean).join(" · ");
}
function automaticChecks(list:UiGrader[]) {
  if(!list.length)return "";
  return '<section class="gc-auto"><h3>Automatic checks</h3>'+list.map(g=>'<details><summary>'+esc(g.name+' · v'+g.version)+'</summary><p>'+esc(g.criteria)+'</p></details>').join("")+'</section>';
}
function revisionFamilies(items:UiGrader[]) {
  const families=new Map<string,UiGrader[]>();
  for(const g of items){
    const key=g.library?.familyId || g.id,revisions=families.get(key) || [];
    revisions.push(g);families.set(key,revisions);
  }
  return [...families.values()].map(items=>items.sort((a,b)=>b.version-a.version)).sort((a,b)=>a[0].name.localeCompare(b[0].name));
}
function catalogChoices(list:UiGrader[],chosen:Set<string>,inputName:string,reasons?:Map<string,string|undefined>) {
  const choice=(g:UiGrader)=>{
    const rec=reasons?.get(g.id);
    return '<label class="qc-grade-choice choice"><input type="checkbox" name="'+inputName+'" value="'+esc(g.id)+'" '+(chosen.has(g.id)?"checked":"")+
      '><span><strong>'+esc(g.name)+' <small>v'+esc(g.version)+'</small></strong><small>'+esc(graderApplicability(g))+'</small><small>'+esc(g.criteria)+'</small>'+
      (rec?'<small>'+esc(rec)+'</small>':'')+'</span></label>';
  };
  return catalogSections.map(({scope,title})=>{
    const families=revisionFamilies(list.filter(g=>graderScope(g)===scope));
    if(!families.length)return "";
    return '<fieldset class="gc-options"><legend>'+title+'</legend>'+families.map(([head,...previous])=>
      choice(head)+(previous.length?'<details class="gc-previous" '+(previous.some(g=>chosen.has(g.id))?'open':'')+'><summary>Earlier versions of '+esc(head.name)+'</summary>'+
        previous.map(choice).join("")+'</details>':"")).join("")+'</fieldset>';
  }).join("");
}
function selectedGraderIds() {
  const selected=[...datasetGradeSelection(activeDatasetGraderScope())];
  if(selected.some(id=>!datasetGradingChoices?.available.some(g=>g.id===id)))throw Error("Remove unavailable grader versions before starting this run.");
  return selected;
}
function graderPicker(){
  const scope=activeDatasetGraderScope(),chosen=datasetGradeSelection(scope);
  const available=datasetGradingChoices?.available || [];
  const missing=[...chosen].filter(id=>!available.some(g=>g.id===id));
  return automaticChecks(datasetGradingChoices?.automatic || [])+gradeDesignerView(scope)+'<details class="card grader-picker" data-grade-scope="'+esc(scope)+'"><summary>Optional graders · '+chosen.size+' selected</summary>'+
    catalogChoices(available,chosen,"custom-grader")+(available.length?"":"<p>No optional graders are available for this snapshot.</p>")+
    missing.map(id=>'<label class="choice"><input type="checkbox" name="custom-grader" value="'+esc(id)+'" checked>Unavailable · '+esc(state.graders.find(g=>g.id===id)?.name || id)+'</label>').join("")+
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
    const native=r.opikMetric?'<small class="block">Opik '+(r.opikMetric.direction==="higher-is-risk"?"raw risk":"native score")+' · '+esc(r.opikMetric.nativeScore)+'</small>':"";
    const outcome=r.pass==null ? d ? "Abstained · unscored" : "Unscored" : r.pass ? "Passed" : (d || r.engine==="decision") ? "Failed" : "Review";
    return [esc(r.name+" v"+r.version)+model+requested+usedFallback,esc([r.candidate,r.caseId].filter(Boolean).join(" / ")||"Provided output"),
      r.value==null?"—":esc(metricNumber(r.value)),esc(outcome),esc(r.reason)+probability+native];
  })):"";
}
let gradeFilter="",graderDraft:UiGrader|null=null,graderTemplate:UiOpikLibraryTemplate|null=null;
let graderEditIntent:"create"|"derive"|"revise"="create";
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
    (!graderDraft && !graderTemplate?'<div><span>Start from a domain criterion</span> <button type="button" data-decision-starter="earnings">GAAP vs. adjusted EPS</button> <button type="button" data-decision-starter="inspection">Inspection disposition</button></div>':'')+
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
let graderAuthoringMode:"agent"|"manual"="agent";
function gradeCreate(){
  const g:UiGraderDefinition & {judge?:UiModel|null}=graderDraft ? {...graderDraft,type:graderDraft.type==="judge"?"opik":graderDraft.type} :
    graderTemplate?{name:graderTemplate.name,category:graderTemplate.category,industry:"Cross-industry",criteria:graderTemplate.criteria,type:"opik-metric",metricKey:graderTemplate.key,threshold:.8}:
    {name:"",category:"",industry:"Cross-industry",criteria:"",type:"opik",threshold:1};
  const inherited=graderDraft?.library?.scenario;
  const lockIndustry=!!inherited;
  const caption=graderTemplate?"Set up "+graderTemplate.name:graderEditIntent==="derive"?"Customize "+(graderDraft?.name || "grader"):graderEditIntent==="revise"?"Revise "+(graderDraft?.name || "grader"):"Create a grader";
  const editing=!!(graderDraft || graderTemplate);
  const manual='<form id="grade-create" data-method="'+esc(g.type)+'" class="spacer">'+(graderDraft?'<p class="muted">'+esc((graderEditIntent==="derive"?"Based on ":"Previous revision · ")+graderDraft.name+" v"+graderDraft.version+
      (inherited?" · "+graderScenario(graderDraft):""))+'</p>':'')+'<div class="cols">'+
    formField("Grader name",'<input name="name" required maxlength="100" value="'+esc(g.name)+'">')+
    formField("Category",'<input name="category" required maxlength="100" value="'+esc(g.category)+'" placeholder="e.g. Factual accuracy">')+'</div><div class="cols">'+
    formField("Applies to industry",'<select name="industry" '+(lockIndustry?'disabled':'')+'>'+industryOptions(g.industry)+'</select>')+
    formField("Method",'<select name="type" id="grade-type">'+Object.entries(graderTypes).filter(([k])=>k!=="judge" && (k!=="catalog" || graderDraft?.type==="catalog") && (k!=="opik-metric" || graderTemplate || graderDraft?.type==="opik-metric")).map(([k,v])=>k==="opik"&&!state.opikReady?'<option disabled>Opik G-Eval · SDK unavailable</option>':opt(k,v,g.type)).join("")+'</select>')+'</div>'+
    formField(g.type==="decision"?"Yes/no criterion · yes means pass":"Rule or rubric",'<textarea name="criteria" required maxlength="6000" '+(["catalog","opik-metric"].includes(g.type)?'readonly':'')+' placeholder="'+esc(graderHints[g.type])+'">'+esc(g.criteria)+'</textarea>')+
    '<small id="gc-rule-note" '+(["catalog","opik-metric"].includes(g.type)?'':'hidden')+'>This rule has versioned logic. Choose another method to edit the criterion.</small>'+
    decisionFields(g)+'<div class="cols">'+formField(g.type==="decision"?"Pass when P(yes) is at or above":"Pass threshold (0–1)",'<input name="threshold" type="number" min="0" max="1" step="any" required value="'+esc(g.threshold)+'">')+
    '<div id="judge-choice" '+(["judge","opik","opik-metric"].includes(g.type)?"":"hidden")+'>'+formField("Judge model",'<select name="judgeId">'+judgeOptions(g.judge?.id)+'</select>')+'</div></div>'+
    '<div id="grade-evidence-view" '+(g.type==="opik"?'':'hidden')+'>'+formField("Evidence shown to the judge",'<select name="evidenceView">'+
      opt("case","Task, answer and available case evidence",g.evidenceView || "case")+(g.requiredEvidence?.length?'':opt("answer-only","Answer only",g.evidenceView))+'</select>')+'</div>'+
    '<div class="gc-actions"><button class="yellow">'+(graderEditIntent==="derive"?"Save to My graders":"Save grader version")+'</button>'+
    (graderDraft || graderTemplate?'<button type="button" data-new-grader>Cancel edit</button>':'')+'</div></form>';
  if(editing)return '<details class="panel" open><summary>'+esc(caption)+'</summary>'+manual+'</details>';
  const assisted=graderAuthoringMode==="agent";
  return '<details id="grader-authoring" class="panel" open><summary>Create a grader</summary>'+
    '<fieldset class="wf-domain gc-authoring-options"><legend>Authoring method</legend><div>'+
    (["agent","manual"] as const).map(mode=>'<label><input type="radio" name="grader-authoring-mode" value="'+mode+'" '+
      (graderAuthoringMode===mode?'checked':'')+'><span>'+(mode==="agent"?'Design with an agent':'Write manually')+'</span></label>').join("")+'</div></fieldset>'+
    '<div data-authoring-panel="agent" '+(assisted?'':'hidden')+'>'+gradeDesignerView(workspaceGradeScope,true)+'</div>'+
    '<div data-authoring-panel="manual" '+(assisted?'hidden':'')+'>'+manual+'</div></details>';
}
function gradeSelect(){return '<select name="grader" required>'+opt("","Choose a grader","")+catalogSections.map(({scope,title})=>{
  const list=(state.graders||[]).filter(g=>graderScope(g)===scope);
  return list.length?'<optgroup label="'+title+'">'+list.map(g=>opt(g.id,[g.name+" v"+g.version,g.category,decisionTarget(g)].filter(Boolean).join(" · "),"")).join("")+'</optgroup>':"";
}).join("")+'</select>';}
function catalogRevision(g:UiGrader,latest:boolean) {
  const scope=graderScope(g);
  const parent=state.graders.find(p=>p.id===g.library?.parentRevisionId);
  const enabled=state.generalGraderDefaults.includes(g.id);
  const use=g.library?.automatic || enabled ? "Automatic on eligible new runs":"Optional";
  const canSetDefault=g.type==="opik-metric" && ["General","Cross-industry"].includes(g.industry) && !g.library?.scenario;
  const replaced=canSetDefault && !enabled && state.graders.find(other=>other.metricKey===g.metricKey && state.generalGraderDefaults.includes(other.id));
  const defaultToggle=canSetDefault?'<button type="button" data-grade-default="'+esc(g.id)+'" aria-pressed="'+enabled+'">'+
    (enabled?'Disable automatic grading':'Use on new runs')+'</button>':"";
  const ancestry=parent ? (parent.library?.familyId && parent.library.familyId===g.library?.familyId?"Previous revision":"Based on")+" · "+parent.name+" v"+parent.version : "";
  const text=[g.name,g.category,g.industry,g.criteria,graderScenario(g),graderTypes[g.type]];
  const edit=scope==="customer" && latest ? "revise":"customize";
  return '<article class="grader-row" data-grade-version="'+esc(g.id)+'" data-filter="'+esc(text.join(" ").toLowerCase())+'"><div class="gc-revision-head"><div><strong>'+
    esc(g.name)+' <small>v'+esc(g.version)+'</small></strong><small>'+esc([g.category,graderApplicability(g)].filter(Boolean).join(" · "))+'</small></div>'+
    '<small>'+esc(use)+'</small></div><p>'+esc(g.criteria)+'</p>'+
    (ancestry?'<small class="block">'+esc(ancestry)+'</small>':"")+
    '<div class="gc-actions"><button type="button" data-'+edit+'="'+esc(g.id)+'">'+(edit==="revise"?"Revise":"Customize")+'</button>'+
    '<button type="button" data-grade-history="'+esc(g.id)+'" aria-expanded="false">Runs using v'+esc(g.version)+'</button>'+defaultToggle+'</div>'+(replaced?'<small>Using this version on new runs replaces '+esc(replaced.name+' v'+replaced.version)+' as the automatic metric.</small>':'')+
    '<div class="gc-uses" data-grade-uses hidden role="status"></div></article>';
}
function nativeMetricTemplates() {
  return state.opikLibraryTemplates.length?'<div class="gc-templates"><h4>Opik metric templates</h4>'+
    state.opikLibraryTemplates.map(t=>'<article class="grader-row gc-template" data-filter="'+esc([t.name,t.category,t.criteria].join(" ").toLowerCase())+'"><div class="gc-revision-head"><strong>'+
      esc(t.name)+'</strong><small>Choose a local judge</small></div><p>'+esc(t.criteria)+'</p>'+
      (t.requiresReference?'<small class="block">Requires a recorded reference or supporting context.</small>':'')+
      '<div class="gc-actions"><button type="button" data-grade-template="'+esc(t.key)+'">Configure metric</button></div></article>').join("")+'</div>':"";
}
function familyRevisionList(items:UiGrader[]) {
  return revisionFamilies(items).map(([head,...earlier])=>'<div class="gc-family">'+catalogRevision(head,true)+
    (earlier.length?'<details class="gc-previous"><summary>Earlier versions of '+esc(head.name)+' · '+earlier.length+'</summary>'+earlier.map(g=>catalogRevision(g,false)).join("")+'</details>':'')+'</div>').join("");
}
function catalogSection(scope:UiGraderScope,title:string) {
  const items=state.graders.filter(g=>graderScope(g)===scope);
  const body=scope==="industry"?[...new Set(items.map(g=>g.industry))].sort().map(industry=>
    '<div class="gc-industry"><h4>'+esc(industry)+'</h4>'+familyRevisionList(items.filter(g=>g.industry===industry))+'</div>').join(""):familyRevisionList(items);
  const templates=scope==="general"?nativeMetricTemplates():"";
  return '<section class="panel gc-section" data-catalog-scope="'+scope+'"><h3>'+title+'</h3>'+body+templates+
    (!items.length && !templates?'<p class="muted">'+(scope==="customer"?"Save a grader or customize a shipped version to start your collection.":"No graders in this section.")+'</p>':'')+'</section>';
}
function applyCatalogFilter(){
  const query=gradeFilter.trim().toLowerCase();
  for(const row of document.querySelectorAll<HTMLElement>(".gc-template"))row.hidden=!(row.dataset.filter || "").includes(query);
  document.querySelectorAll<HTMLElement>(".gc-family").forEach(family=>{
    const rows=[...family.querySelectorAll<HTMLElement>(".grader-row")];
    for(const row of rows)row.hidden=!(row.dataset.filter || "").includes(query);
    family.hidden=rows.every(row=>row.hidden);
    const previous=family.querySelector<HTMLDetailsElement>(".gc-previous");
    if(previous){
      previous.hidden=rows.slice(1).every(row=>row.hidden);
      if(query && !previous.hidden)previous.open=true;
    }
  });
  for(const section of document.querySelectorAll<HTMLElement>(".gc-section,.gc-industry,.gc-templates"))
    section.hidden=!!query && !section.querySelector(".grader-row:not([hidden])");
  const empty=document.getElementById("gc-no-matches");
  if(empty)empty.hidden=!query || !!document.querySelector(".gc-section:not([hidden])");
}
async function gradersPage(){
  const list=state.graders||[], samples=await api.graderSamples();
  return heading("Workspace","Graders","Choose a versioned check, customize it for your domain, or grade a saved output.")+
    gradeCreate()+bar("Grader library")+formField("Search graders",'<input type="search" id="grade-filter" value="'+esc(gradeFilter)+'" placeholder="Name, industry, scenario or criterion">')+
    catalogSections.map(s=>catalogSection(s.scope,s.title)).join("")+'<p id="gc-no-matches" hidden role="status">No matching graders.</p>'+
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
    writeGraderAttachment(picker.dataset.gradeScope,chosen);
    $("summary",picker).textContent="Optional graders · "+chosen.size+" selected";
    updateDatasetGradingControls();
  }
  if(e.target.id==="grade-type"){
    const f=e.target.form;
    if (!f || !isGradeType(e.target.value)) return;
    const decision=e.target.value==="decision";
    const field=requireElement("[name=criteria]",HTMLTextAreaElement,f);
    field.placeholder=graderHints[e.target.value];
    const wasFixed=field.readOnly;
    field.readOnly=["opik-metric","catalog"].includes(e.target.value);
    if(!wasFixed && field.readOnly) field.dataset.editableCriteria=field.value;
    if(wasFixed && !field.readOnly && field.dataset.editableCriteria!==undefined) field.value=field.dataset.editableCriteria;
    $("#gc-rule-note",f).hidden=!field.readOnly;
    if(field.readOnly)field.value=graderDraft?.criteria || graderTemplate?.criteria || "";
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
    $("#grade-evidence-view",f).hidden=e.target.value!=="opik";
    $("#judge-choice",f).hidden=!["opik","judge","opik-metric"].includes(e.target.value);
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
  if(e.target.id==="grade-filter"){gradeFilter=e.target.value;applyCatalogFilter();}
});
document.addEventListener("change",e=>{
  const radio=e.target;
  if(!(radio instanceof HTMLInputElement) || radio.name!=="grader-authoring-mode" || !radio.checked ||
    (radio.value!=="agent" && radio.value!=="manual"))return;
  graderAuthoringMode=radio.value;
  for(const panel of document.querySelectorAll<HTMLElement>("#grader-authoring [data-authoring-panel]")){
    panel.hidden=panel.dataset.authoringPanel!==graderAuthoringMode;
  }
});
document.addEventListener("click",async e=>{
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
  const toggle=e.target.closest<HTMLButtonElement>("[data-grade-default]");
  if(toggle?.dataset.gradeDefault){
    const id=toggle.dataset.gradeDefault,enabled=!state.generalGraderDefaults.includes(id);
    toggle.disabled=true;
    try {
      await api.setGeneralGraderDefault(id,enabled);
      await render();
      message(enabled?"This judge revision will score eligible new runs.":"Automatic grading disabled for this revision.");
    } catch(error){message(errorText(error));}finally{toggle.disabled=false;}
    return;
  }
  const template=e.target.closest<HTMLButtonElement>("[data-grade-template]");
  if(template){
    graderDraft=null;graderEditIntent="create";
    graderTemplate=state.opikLibraryTemplates.find(t=>t.key===template.dataset.gradeTemplate) || null;
    await render();dashElement("#grade-create input",HTMLInputElement)?.focus();return;
  }
  const history=e.target.closest<HTMLButtonElement>("[data-grade-history]");
  if(history?.dataset.gradeHistory){
    const row=history.closest(".grader-row");
    if(!row)return;
    const uses=$("[data-grade-uses]",row);
    uses.hidden=!uses.hidden;
    history.setAttribute("aria-expanded",String(!uses.hidden));
    if(uses.hidden)return;
    uses.textContent="Loading runs…";
    api.graderRuns(history.dataset.gradeHistory).then(runs=>{
      if(!uses.isConnected)return;
      uses.innerHTML=runs.length?'<ul>'+runs.map(r=>'<li>'+link(esc(r.title+" · "+displayTime(r.created)),"run/"+encodeURIComponent(r.id),"link")+'</li>').join("")+'</ul>':"No saved runs use this version.";
    }).catch(error=>{uses.textContent=errorText(error);});
    return;
  }
  const edit=e.target.closest<HTMLButtonElement>("[data-revise],[data-customize],[data-new-grader]");
  if(!edit)return;
  graderTemplate=null;
  graderDraft=state.graders.find(g=>g.id===(edit.dataset.revise || edit.dataset.customize)) || null;
  graderEditIntent=edit.dataset.revise?"revise":edit.dataset.customize?"derive":"create";
  void render().then(()=>{if(graderDraft)dashElement("#grade-create input",HTMLInputElement)?.focus();});
});
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
      if(type==="opik")definition.evidenceView=field("evidenceView")==="answer-only"?"answer-only":"case";
      if(type==="opik-metric"){
        const key=graderTemplate?.key || graderDraft?.metricKey;
        if(!key)throw Error("Choose an Opik metric template.");
        if(!definition.judgeId)throw Error("Choose the local judge model for this metric.");
        definition.metricKey=key;
      }
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
      await api.saveGrader(graderEditIntent==="create" || !graderDraft ? {...definition,intent:"create"} :
        {...definition,intent:graderEditIntent,sourceGraderId:graderDraft.id});
      graderEditIntent="create";graderTemplate=null;
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
