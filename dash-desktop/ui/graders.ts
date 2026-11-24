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
function selectedGradersLabel(chosen:Set<string>) {
  const names=[...chosen].map(id=>{const g=state.graders.find(row=>row.id===id);return g ? g.name+" v"+g.version : "Unavailable version";});
  return names.length ? "Selected graders · "+names.join(", ") : "Add optional graders";
}
function selectedJudgeNotice(chosen:Set<string>) {
  const pending=state.graders.filter(g=>chosen.has(g.id) && g.judge && !models().some(m=>m.id===g.judge?.id && m.loaded));
  if(!pending.length)return "";
  const names=[...new Set(pending.map(g=>g.judge?.model))].join(", ");
  return 'Check the local judge before starting · '+esc(names)+' · '+link("Local runtimes","providers","link");
}
function graderPicker(){
  const scope=activeDatasetGraderScope(),chosen=datasetGradeSelection(scope);
  const available=datasetGradingChoices?.available || [];
  const missing=[...chosen].filter(id=>!available.some(g=>g.id===id));
  return automaticChecks(datasetGradingChoices?.automatic || [])+gradeDesignerView(scope)+'<details class="card grader-picker" data-grade-scope="'+esc(scope)+'"><summary>'+esc(selectedGradersLabel(chosen))+'</summary>'+
    catalogChoices(available,chosen,"custom-grader")+(available.length?"":"<p>No optional graders are available for this snapshot.</p>")+
    missing.map(id=>'<label class="choice"><input type="checkbox" name="custom-grader" value="'+esc(id)+'" checked>Unavailable · '+esc(state.graders.find(g=>g.id===id)?.name || id)+'</label>').join("")+
    link("Open grader library →","graders","link")+'</details><div id="dataset-judge-note" role="status" class="wf-hint">'+selectedJudgeNotice(chosen)+'</div>';
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
  const targets=hosted.map(g=>g.name+" v"+g.version+" → "+g.decision?.model+"\n"+
    (g.decisionView==="answer-only"?"The grader receives its yes/no question and candidate answer only.":g.decisionView==="task-answer"?"The grader receives its yes/no question, candidate task and answer.":evidenceScope));
  return window.confirm("Send grading evidence to OpenRouter for "+scope+"?\n\n"+
    targets.join("\n\n")+"\n\nOpenRouter and its serving provider will receive this evidence. Usage may incur charges. This confirmation applies only to this action.") ? {allowHostedDecision:true} : null;
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
    return [esc(r.name+" v"+r.version)+model+requested+usedFallback,esc(r.datasetCase ? [r.datasetCase.datasetName,r.datasetCase.datasetVersion,r.datasetCase.caseId].join(" · ") : [r.candidate,r.caseId].filter(Boolean).join(" / ") || "Provided output"),
      r.value==null?"—":esc(metricNumber(r.value)),esc(outcome),esc(r.reason)+probability+native];
  })):"";
}
let gradeFilter="",graderDraft:UiGrader|null=null,graderTemplate:UiOpikLibraryTemplate|null=null;
let graderEditIntent:"create"|"derive"|"revise"="create";
function judgeOptions(id?:string|null){
  return opt("","Choose a connected local judge",id)+gradeDesignerLocalJudges().map(m=>opt(m.id,m.model+" · "+m.provider+(m.loaded?" · loaded":""),id)).join("");
}
function nativeJudgeFields(d:UiNativeJudgeDraft,manual:boolean){
  const attr=(name:string)=>manual?' id="'+name+'"':"";
  const ids=d.models || [];
  return '<div data-native-judge>'+formField("Local decision runtime",'<select data-native="protocol" name="decision-protocol">'+
    opt("systemone","System One · llama.cpp / LM Studio",d.protocol)+opt("mlx-vlm","MLX-VLM · native decisions",d.protocol)+'</select>')+
    formField("Loopback server URL",'<input data-native="endpoint" type="url" name="decision-endpoint" required maxlength="240" value="'+esc(d.endpoint)+'">')+
    '<button type="button" data-native-discover'+attr("grade-discover")+'>Find decision models</button><small data-native-status'+attr("grade-discovery-status")+' role="status"></small>'+
    '<label data-native-results'+attr("grade-discovered")+' class="field" '+(manual && !ids.length?'hidden':'')+'><span>Discovered decision model</span>'+
    '<select data-native="selected" name="decision-discovered">'+opt("","Choose a model from this server",d.model)+ids.map(id=>opt(id,id,d.model)).join("")+'</select></label>'+
    (manual?formField(d.protocol==="mlx-vlm"?"Preloaded checkpoint · absolute path":"Served model ID or alias",'<input data-native="model" name="decision-model" required maxlength="512" value="'+esc(d.model)+'">'):'')+'</div>';
}
function nativeDraft():UiNativeJudgeDraft {return {endpoint:"http://127.0.0.1:8080",protocol:"systemone",model:"",failAt:"0.2"};}
function decisionViewOptions(view:UiDecisionView,required:boolean){
  return opt("case","Task, answer and available case evidence",view)+(required?"":opt("task-answer","Task and candidate answer",view)+opt("answer-only","Candidate answer only",view));
}
const hostedDecisionModels=["liquid/d1.2","liquid/d1.2-ultra","typesafe/jev-1.14"];
const decisionStarters = {
  completeness:{name:"Requested deliverables addressed",industry:"Cross-industry",category:"Task completeness",
    criteria:"Does the candidate answer itself address each explicit deliverable in the task, including any requested declaration that evidence is unavailable? Evaluate coverage only. Ignore accuracy and unrequested details."},
  disclosure:{name:"Requested missing-evidence disclosure",industry:"Cross-industry",category:"Evidence disclosure",
    criteria:"The task explicitly identifies missing evidence and asks the respondent to flag it and withhold a dependent conclusion. Does the candidate answer itself both identify that gap and withhold the dependent conclusion?"},
  earnings:{name:"GAAP diluted EPS support",industry:"Financial Services",category:"Financial fact accuracy",
    criteria:"Does the answer report the requested diluted EPS using the reference’s GAAP figure for that period, keeping it distinct from adjusted EPS?"},
  inspection:{name:"Inspection disposition evidence",industry:"Manufacturing",category:"Inspection disposition",
    criteria:"Does the proposed lot disposition follow the acceptance limits for the current drawing revision in the inspection reference?"},
};
function decisionFields(g:UiGraderDefinition) {
  const d=g.decision,local=d?.provider!=="openrouter",enabled=g.type==="decision",mlx=d?.protocol==="mlx-vlm";
  const evidenceCheck=(id:UiDecisionEvidence,label:string)=>'<label class="choice"><input type="checkbox" name="decision-evidence" value="'+id+'" '+(g.requiredEvidence?.includes(id)?'checked':'')+'>'+label+'</label>';
  return '<fieldset id="grade-decision" '+(enabled?'':'disabled hidden')+'><legend>Decision model</legend>'+
    formField("Run the grader on",'<select name="decision-provider">'+opt("local","Local decision server",local?"local":"openrouter")+opt("openrouter","OpenRouter",local?"local":"openrouter")+'</select>')+
    '<fieldset id="grade-decision-local" '+(local?'':'disabled hidden')+'><legend>Local connection</legend>'+
    nativeJudgeFields({endpoint:local && d?.endpoint || "http://127.0.0.1:8080",protocol:d?.protocol || "systemone",model:local && d?d.model:"",failAt:String(d?.failAt ?? 0.2)},true)+
    '<small id="decision-mlx-tip" '+(mlx?'':'hidden')+'>Start MLX-VLM with <code>--decision-model /absolute/path/to/checkpoint</code>. Find decision models reads the directory loaded by that server.</small>'+
    '<details class="wf-options" '+(d?.fallbackModel?'open':'')+'><summary>Alternate local model</summary>'+
    formField(mlx?"Alternate checkpoint · absolute path (optional)":"Alternate served model ID (optional)",'<input name="decision-fallback" maxlength="512" value="'+esc(d?.fallbackModel)+'">')+
    '<small>The same server may use this model if the primary is unavailable before grading. DASH records which model answered.</small></details></fieldset>'+
    '<fieldset id="grade-decision-hosted" '+(local?'disabled hidden':'')+'><legend>Hosted connection</legend>'+
    formField("OpenRouter decision model",'<select name="decision-hosted-model">'+hostedDecisionModels.map(id=>opt(id,id,local?hostedDecisionModels[0]:d?.model)).join("")+'</select>')+
    '<p>Start DASH with <code>OPENROUTER_API_KEY</code> set. Review the evidence setting below. DASH asks before sending evidence for each run or manual grade.</p></fieldset>'+
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
const discoverySequence=new WeakMap<HTMLElement,number>();
function resetNativeDiscovery(panel:HTMLElement){
  discoverySequence.set(panel,(discoverySequence.get(panel) ?? 0)+1);
  $("[data-native-status]",panel).textContent="";
  const results=$("[data-native-results]",panel);
  if(panel.closest("#grade-create"))results.hidden=true;
  requireElement("[data-native=selected]",HTMLSelectElement,panel).replaceChildren(new Option("Choose a model from this server",""));
  requireElement("[data-native-discover]",HTMLButtonElement,panel).disabled=false;
}
function resetDecisionDiscovery(form:HTMLFormElement){resetNativeDiscovery($("[data-native-judge]",form));}
async function discoverDecisionModels(panel:HTMLElement,button:HTMLButtonElement){
  resetNativeDiscovery(panel);
  const request=discoverySequence.get(panel),endpoint=requireElement("[data-native=endpoint]",HTMLInputElement,panel).value.trim();
  const status=$("[data-native-status]",panel),results=$("[data-native-results]",panel);
  const live=()=>request===discoverySequence.get(panel) && panel.isConnected;
  button.disabled=true;status.textContent="Checking local decision server…";
  try{
    const protocol=requireElement("[data-native=protocol]",HTMLSelectElement,panel).value==="mlx-vlm"?"mlx-vlm":"systemone";
    const ids=await api.listDecisionModels(endpoint,protocol);
    if(!live())return;
    const draft=editableJudgeCheck(panel)?.native;
    if(draft)draft.models=ids;
    if(!ids.length){if(draft)draft.model="";status.textContent="This server advertises no native decision models.";return;}
    const field=panel.querySelector<HTMLInputElement>("[data-native=model]");
    const choices=requireElement("[data-native=selected]",HTMLSelectElement,panel);
    const previous=field?.value || draft?.model || "";
    choices.replaceChildren(new Option("Choose a model from this server",""),...ids.map(id=>new Option(id,id)));
    choices.value=ids.includes(previous)?previous:ids.length===1?ids[0]:"";
    if(choices.value && field && !field.value.trim()){
      field.value=choices.value;field.dispatchEvent(new Event("input",{bubbles:true}));
    }
    if(draft)draft.model=choices.value;
    results.hidden=false;status.textContent=ids.length+" native decision model"+(ids.length===1?"":"s")+" advertised.";
  }catch(error){if(live())status.textContent=errorText(error);}
  finally{if(live())button.disabled=false;}
}
let graderAuthoringMode:"agent"|"manual"="agent";
function gradeCreate(){
  const g:UiGraderDefinition & {judge?:UiModel|null}=graderDraft ? {...graderDraft,type:graderDraft.type==="judge"?"opik":graderDraft.type} :
    graderTemplate?{name:graderTemplate.name,category:graderTemplate.category,industry:"Cross-industry",criteria:graderTemplate.criteria,type:"opik-metric",metricKey:graderTemplate.key,threshold:.8}:
    {name:"",category:"",industry:"Cross-industry",criteria:"",type:"opik",threshold:1};
  const inherited=graderDraft?.library?.scenario;
  const lockIndustry=!!inherited;
  const caption=graderTemplate?"Set up "+graderTemplate.name:graderEditIntent==="derive"?"Create a personal version of "+(graderDraft?.name || "grader"):graderEditIntent==="revise"?"Revise "+(graderDraft?.name || "grader"):"Create a grader";
  const editing=!!(graderDraft || graderTemplate);
  const manual='<form id="grade-create" data-method="'+esc(g.type)+'" class="spacer">'+(graderDraft?'<p class="muted">'+esc((graderEditIntent==="derive"?"Based on ":"Previous revision · ")+graderDraft.name+" v"+graderDraft.version+
      (inherited?" · "+graderScenario(graderDraft):""))+'</p>':'')+
    (!editing?'<details class="wf-options"><summary>Start with a yes/no grader</summary><p>The two cross-industry questions are experimental. Edit one and test it with labeled examples before using it in a run.</p>'+
      (Object.keys(decisionStarters) as (keyof typeof decisionStarters)[]).map(key=>'<button type="button" data-decision-starter="'+key+'">'+esc(decisionStarters[key].name)+'</button>').join(" ")+'</details>':'')+'<div class="cols">'+
    formField("Grader name",'<input name="name" required maxlength="100" value="'+esc(g.name)+'">')+
    formField("Category",'<input name="category" required maxlength="100" value="'+esc(g.category)+'" placeholder="e.g. Factual accuracy">')+'</div><div class="cols">'+
    formField("Applies to industry",'<select name="industry" '+(lockIndustry?'disabled':'')+'>'+industryOptions(g.industry)+'</select>')+
    formField("Method",'<select name="type" id="grade-type">'+Object.entries(graderTypes).filter(([k])=>k!=="judge" && (k!=="catalog" || graderDraft?.type==="catalog") && (k!=="opik-metric" || graderTemplate || graderDraft?.type==="opik-metric")).map(([k,v])=>k==="opik"&&!state.opikReady?'<option disabled>Opik G-Eval · SDK unavailable</option>':opt(k,v,g.type)).join("")+'</select>')+'</div>'+
    formField(g.type==="decision"?"Yes/no criterion · yes means pass":"Rule or rubric",'<textarea name="criteria" required maxlength="6000" '+(["catalog","opik-metric"].includes(g.type)?'readonly':'')+' placeholder="'+esc(graderHints[g.type])+'">'+esc(g.criteria)+'</textarea>')+
    '<small id="gc-rule-note" '+(["catalog","opik-metric"].includes(g.type)?'':'hidden')+'>This rule has versioned logic. Choose another method to edit the criterion.</small>'+
    decisionFields(g)+'<div id="grade-decision-view" '+(g.type==="decision"?'':'hidden')+'>'+formField("Evidence shown to the decision model",'<select name="decision-view">'+decisionViewOptions(g.decisionView ?? g.evidenceView ?? "case",!!g.requiredEvidence?.length)+'</select>')+'</div>'+
    '<small id="grade-no-judge" '+(["exact","contains","field","trajectory","catalog"].includes(g.type)?"":"hidden")+'>This rule runs directly. No judge model is needed.</small><div class="cols">' +formField(g.type==="decision"?"Pass when P(yes) is at or above":"Pass threshold (0–1)",'<input name="threshold" type="number" min="0" max="1" step="any" required value="'+esc(g.threshold)+'">')+
    '<div id="judge-choice" '+(["judge","opik","opik-metric"].includes(g.type)?"":"hidden")+'>'+formField("Judge model · local scoring runtime",'<select name="judgeId">'+judgeOptions(g.judge?.id)+'</select>')+'</div></div>'+
    '<div id="grade-evidence-view" '+(g.type==="opik"?'':'hidden')+'>'+formField("Evidence shown to the judge",'<select name="evidenceView">'+
      decisionViewOptions(g.evidenceView ?? g.decisionView ?? "case",!!g.requiredEvidence?.length)+'</select>')+'</div>'+
    '<div class="gc-actions"><button class="yellow">'+(graderEditIntent==="derive"?"Save to My graders":"Save grader version")+'</button>'+
    (graderDraft || graderTemplate?'<button type="button" data-new-grader>Cancel edit</button>':'')+'</div></form>';
  if(editing)return '<details class="panel" open><summary>'+esc(caption)+'</summary>'+manual+'</details>';
  const assisted=graderAuthoringMode==="agent";
  return '<details id="grader-authoring" data-own-open class="panel" '+(showGraderAuthoring ? "open":"")+'><summary>Create a grader</summary><p>Propose checks from your objective and success measures, then review and save the versions you want to use.</p>'+
    '<fieldset class="wf-domain gc-authoring-options"><legend>Authoring method</legend><div>'+
    (["agent","manual"] as const).map(mode=>'<label><input type="radio" name="grader-authoring-mode" value="'+mode+'" '+
      (graderAuthoringMode===mode?'checked':'')+'><span>'+(mode==="agent"?'AI-assisted':'Write manually')+'</span></label>').join("")+'</div></fieldset>'+
    '<div data-authoring-panel="agent" '+(assisted?'':'hidden')+'>'+gradeDesignerView(workspaceGradeScope,true)+'</div>'+
    '<div data-authoring-panel="manual" '+(assisted?'hidden':'')+'>'+manual+'</div></details>';
}
interface SavedGraderChoice {id:string;label:string}
let savedWorkspaceGraders:SavedGraderChoice[]=[];
let savedDesignDataset:string|undefined;
let showGraderAuthoring=false;
let samplePanelOpen=false;
// Keep the submitted draft in memory while its assessment is running, including across route renders.
interface SampleInput {grader:string;input:string;output:string;reference:string;trajectory:string}
let pendingSample:SampleInput|null=null;
let retrySample:{draft:SampleInput;error:string}|null=null;

function readSample(form:HTMLFormElement):SampleInput {
  const read=(key:string)=>formText(form,key);
  return {grader:read("grader"),input:read("input"),output:read("output"),reference:read("reference"),trajectory:read("trajectory")};
}
function sampleRecovery(){
  if(!retrySample)return "";
  return (retrySample.error?'<p data-action-error role="alert" class="wf-error">'+esc(retrySample.error)+'</p>':'')+
    '<button type="button" data-sample-clear>Discard sample</button>';
}
function editSampleRetry(form:HTMLFormElement){
  if(!retrySample || pendingSample)return;
  retrySample={draft:readSample(form),error:""};
  form.querySelector("[data-action-error]")?.remove();
}

function updateSampleLock(){
  const busy=!!pendingSample;
  const form=dashElement("#grade-sample",HTMLFormElement);
  if(form){
    requireElement("fieldset",HTMLFieldSetElement,form).disabled=busy;
    const submit=requireElement("button[type=submit]",HTMLButtonElement,form);
    submit.disabled=busy || !state.graders.length;
    submit.textContent=busy?"Scoring…":"Score this output";
    form.setAttribute("aria-busy",String(busy));
  }
  for(const b of document.querySelectorAll<HTMLButtonElement>("[data-grade-test]"))b.disabled=busy;
}

function recordWorkspaceSave(items:SavedGraderChoice[],scope?:string) {
  savedWorkspaceGraders=items;
  const source=scope ? gradeScopeRecord(scope) : null;
  savedDesignDataset=source && "pack" in source ? source.id : source && "datasetId" in source ? source.datasetId || undefined : undefined;
  showGraderAuthoring=false;samplePanelOpen=false;
}
function needsGraderReference(g:UiGrader) {
  return g.type==="field" || g.metricKey==="hallucination" || !!g.requiredEvidence?.includes("reference");
}
function showSampleEvidence(g:UiGrader) {
  const reference=needsGraderReference(g);
  const steps=g.type==="trajectory" || !!g.requiredEvidence?.includes("trajectory");
  const detail=requireElement("#grade-sample [data-sample-evidence]",HTMLDetailsElement);
  if(reference || steps)detail.open=true;
  const needed=[...(reference?["a reference answer"]:[]),...(steps?["observed agent steps"]:[])];
  $("summary",detail).textContent=needed.length ? "This grader needs "+needed.join(" and ") : "Reference and agent trajectory";
}
function graderUseActions(g:UiGrader,source?:string,versionAction?:"revise"|"customize") {
  const sampleOnly=g.type==="trajectory" || g.requiredEvidence?.includes("trajectory");
  const caseTest=g.type==="catalog" && !!g.library?.scenario;
  const sampleAvailable=g.type!=="catalog";
  const run=!g.library?.automatic && !sampleOnly;
  if (!run && !sampleAvailable && !caseTest && !versionAction) return "";
  return '<div class="gc-use" data-use-version="'+esc(g.id)+'"'+(source?' data-source-dataset="'+esc(source)+'"':'')+'>'+
    (versionAction?'<button type="button" data-'+versionAction+'="'+esc(g.id)+'">Create Version</button>':'')+
    (caseTest?'<button type="button" data-industry-test>Test</button>':
      sampleAvailable?'<button type="button" class="gc-secondary" data-grade-test '+(pendingSample?"disabled":"")+'>'+(versionAction?"Test":"Test one output")+'</button>':'')+
    (run?'<button type="button" data-grade-run>'+(versionAction?'Use in Run':'Use in a dataset run')+'</button>':'')+
    (sampleOnly?'<small>Supply observed agent steps in the output test.</small>':'')+
    '<div class="gc-target" hidden></div></div>';
}
function snapshotLabel(d:UiDataset) {
  return [d.metadata.family || d.name,d.version,d.split,d.metadata.industry || d.pack,d.count+" cases"].join(" · ");
}
function snapshotChooser(snapshots:UiDataset[]) {
  return formField("Choose a dataset snapshot",'<select data-grade-snapshot>'+opt("","Select a snapshot","")+
    snapshots.map(d=>opt(d.id,snapshotLabel(d),"")).join("")+'</select>')+
    '<button type="button" data-grade-continue>Continue to dataset run</button> <button type="button" class="gc-secondary" data-grade-cancel>Cancel</button>';
}
let graderActionSequence=0;
async function openGraderRun(g:UiGrader,d:UiDataset,isCurrent:()=>boolean) {
  const options=await api.datasetGraderOptions(d.id);
  if(!isCurrent())return;
  const w=workflows.dataset;
  if(state.active || w.busy)throw Error("Another run or preparation is active. Finish it before setting up a dataset run.");
  if(!options.available.some(row=>row.id===g.id))throw Error("This version applies to a different industry or scenario.");
  if(needsGraderReference(g) && !options.hasReferences)throw Error("This grader needs a held-out reference. Choose a snapshot with reference answers or import one.");
  const keepVariant=!!w.approved && w.approved.datasetId===d.id;
  const scope=keepVariant && w.approved?"prompt:"+w.approved.id:"dataset:"+d.id;
  const chosen=datasetGradeSelection(scope);
  if(!chosen.has(g.id) && chosen.size>=8)throw Error("This setup already has eight graders. Remove one in Dataset run and try again.");
  const previous=!keepVariant && (w.draft || w.approved || w.variant || w.parentId || w.objective.trim())?"the current dataset run setup":"";
  if(!await allowPageReplacement("Continue to dataset run",previous) || !isCurrent())return;
  if (!keepVariant && (w.variant || w.draft || w.approved || w.parentId || w.objective.trim()))workflows.dataset=plannerState("dataset");
  workflows.dataset.datasetId=d.id;workflows.dataset.error="";packId=d.pack;datasetId=d.id;
  chosen.add(g.id);writeGraderAttachment(scope,chosen);
  if(d.pack==="reference")datasetScorerChoices.set(d.id,"selected-graders");
  navigateAfterDecision("new");
}
async function chooseGraderAction(button:HTMLButtonElement,host:HTMLElement,g:UiGrader) {
  const request=++graderActionSequence;
  const isCurrent=()=>request===graderActionSequence && host.isConnected && trail()[0]==="graders";
  const target=$(".gc-target",host);
  if(button.hasAttribute("data-grade-cancel")){target.hidden=true;$("[data-grade-run]",host).focus();return;}
  if(button.hasAttribute("data-grade-test")){
    if(pendingSample)return;
    const panel=requireElement("#grade-sample-panel",HTMLDetailsElement);
    panel.open=true;
    requireElement("#grade-sample [name=grader]",HTMLSelectElement).value=g.id;
    showSampleEvidence(g);editSampleRetry(requireElement("#grade-sample",HTMLFormElement));
    $("#grade-sample [name=output]").focus();return;
  }
  button.disabled=true;target.hidden=false;
  try {
    if(button.hasAttribute("data-grade-continue")){
      const selected=requireElement("[data-grade-snapshot]",HTMLSelectElement,target);
      const d=state.datasets.find(d=>d.id===selected.value);
      if(!d){selected.focus();throw Error("Select the dataset snapshot to evaluate.");}
      await openGraderRun(g,d,isCurrent);
    }else{
      target.textContent="Finding dataset snapshots…";
      const ids=new Set(await api.graderDatasetIds(g.id));
      if(!isCurrent())return;
      const snapshots=state.datasets.filter(d=>ids.has(d.id));
      if(!snapshots.length){target.innerHTML='<p>No snapshot matches '+esc([g.industry,graderScenario(g)].filter(Boolean).join(" · "))+'. '+link("Import a dataset","datasets","link")+'</p>';return;}
      const d=snapshots.find(d=>d.id===host.dataset.sourceDataset) || (snapshots.length===1?snapshots[0]:null);
      target.innerHTML=snapshots.length>1?snapshotChooser(snapshots):"";
      if(d)await openGraderRun(g,d,isCurrent);
      else requireElement("[data-grade-snapshot]",HTMLSelectElement,target).focus();
    }
  }catch(error){
    if(!isCurrent())return;
    target.querySelector('[role="alert"]')?.remove();
    if(!target.querySelector("[data-grade-snapshot]"))target.replaceChildren();
    target.insertAdjacentHTML("beforeend",'<p class="wf-error" role="alert">'+esc(errorText(error))+'</p>'+(!target.querySelector("[data-grade-snapshot]") ? link("Browse datasets","datasets","link"):""));
  }finally{button.disabled=false;}
}
function workspaceGraderReceipt() {
  if (!savedWorkspaceGraders.length) return "";
  return '<section id="grader-receipt" class="panel gc-receipt" tabindex="-1"><h2>Ready to evaluate</h2>'+
    savedWorkspaceGraders.map(item=>{
      const g=state.graders.find(row=>row.id===item.id);
      const source=state.datasets.find(d=>d.id===savedDesignDataset);
      return '<div><p><strong>'+esc(g ? g.name+" v"+g.version : item.label)+'</strong> · Saved in the grader library</p>'+
        (source?'<p class="muted">'+esc(snapshotLabel(source))+'</p>':"")+
        (g?graderUseActions(g,savedDesignDataset):'')+'</div>';
    }).join("")+'</section>';
}
function gradeSelect(selected=""){return '<select name="grader" required>'+opt("","Choose a grader",selected)+catalogSections.map(({scope,title})=>{
  const list=(state.graders||[]).filter(g=>graderScope(g)===scope);
  return list.length?'<optgroup label="'+title+'">'+list.map(g=>opt(g.id,[g.name+" v"+g.version,g.category,decisionTarget(g)].filter(Boolean).join(" · "),selected)).join("")+'</optgroup>':"";
}).join("")+'</select>';}
function catalogRevision(g:UiGrader,latest:boolean) {
  const scope=graderScope(g);
  const parent=quickLibraryRoute()?undefined:state.graders.find(p=>p.id===g.library?.parentRevisionId);
  const enabled=state.generalGraderDefaults.includes(g.id);
  const use=g.library?.automatic || enabled ? "Automatic on eligible new runs":"Optional";
  const canSetDefault=!!g.generalDefaultKey;
  const replaced=canSetDefault && !enabled && state.graders.find(other=>other.generalDefaultKey===g.generalDefaultKey && state.generalGraderDefaults.includes(other.id));
  const defaultToggle=canSetDefault?'<button type="button" data-grade-default="'+esc(g.id)+'" aria-pressed="'+enabled+'">'+
    (enabled?'Disable automatic grading':'Use on new runs')+'</button>':"";
  const ancestry=parent ? (parent.library?.familyId && parent.library.familyId===g.library?.familyId?"Previous revision":"Based on")+" · "+parent.name+" v"+parent.version : "";
  const text=[g.name,g.category,g.industry,g.criteria,graderScenario(g),graderTypes[g.type]];
  const edit=scope==="customer" && latest ? "revise":"customize";
  const industry=scope==="industry";
  const summary=g.criteria.split(/(?<=[.!?])\s|\n/)[0] || g.category;
  const description=summary.length>155 ? summary.slice(0,152).replace(/\s+\S*$/,"")+"…" : summary;
  const detailsId="grader-info-"+g.id;
  const more='<p>'+esc(g.criteria)+'</p><small>'+esc(graderApplicability(g))+'</small><small>'+esc("Pass threshold · "+g.threshold+" / 1")+'</small>';
  const title='<strong>'+esc(g.name)+'</strong> <small class="gc-version">v'+esc(g.version)+'</small>';
  const open='<article class="grader-row'+(industry && !quickLibraryRoute()?' gc-card':'')+'" data-grade-version="'+esc(g.id)+'" data-filter="'+esc(text.join(" ").toLowerCase())+'">';
  if (quickLibraryRoute()) return open+'<div class="gc-revision-head"><div>'+title+'</div><small>'+esc(graderTypes[g.type])+'</small></div>'+
    '<p class="gc-description">'+esc(description)+'</p><div class="gc-use" data-use-version="'+esc(g.id)+'">'+quickLibraryActions(g)+
    '<div class="gc-target" role="status" hidden></div></div><details class="gc-manage"><summary>Grader details</summary>'+more+'</details></article>';
  return open+'<div class="gc-revision-head"><div>'+title+'</div>'+(industry?'<button type="button" class="gc-info" data-grader-details aria-expanded="false" aria-controls="'+esc(detailsId)+'">Details</button>':'<small>'+esc(use)+'</small>')+'</div>'+
    '<p class="gc-description">'+esc(industry?description:g.criteria)+'</p>'+
    (ancestry?'<small class="block">'+esc(ancestry)+'</small>':'')+
    graderUseActions(g,undefined,edit)+
    (industry?'<div class="gc-detail-body" id="'+esc(detailsId)+'" hidden>'+more+'</div>':'')+
    '<details class="gc-manage"><summary>'+(industry?'Run history':'Manage version')+'</summary><div class="gc-actions">'+
    '<button type="button" data-grade-history="'+esc(g.id)+'" aria-expanded="false">Runs using v'+esc(g.version)+'</button>'+defaultToggle+'</div>'+
    (canSetDefault && g.type==="decision"?'<small>Automatic grading sends the candidate’s task and answer to this local judge. Explicitly selecting the grader can include case evidence.</small>':'')+
    (replaced?'<small>Using this version on new runs replaces '+esc(replaced.name+' v'+replaced.version)+' as the automatic grader.</small>':'')+
    '<div class="gc-uses" data-grade-uses hidden role="status"></div></details></article>';
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
  const groups=new Map<string,UiGrader[]>();
  if(scope==="industry") for(const item of items){
    const group=groups.get(item.industry);
    if(group)group.push(item);else groups.set(item.industry,[item]);
  }
  const body=scope==="industry"?'<div class="gc-shelves">'+[...groups].sort(([a],[b])=>a.localeCompare(b)).map(([industry,graders])=>{
    const icon=industry==="Financial Services"?"finance-i":industry==="Manufacturing"?"factory-i":"case-i";
    const count=new Set(graders.map(g=>g.library?.familyId || g.id)).size;
    return '<section class="gc-industry"><div class="gc-shelf-head"><span class="gc-domain-mark '+icon+'">'+svg(icon)+'</span><h4>'+esc(industry)+'</h4>'+
      '<small>'+count+' '+(count===1?'grader':'graders')+'</small></div>'+familyRevisionList(graders)+'</section>';
  }).join("")+'</div>':familyRevisionList(items);
  const templates=scope==="general"?nativeMetricTemplates():"";
  return '<section class="panel gc-section" data-catalog-scope="'+scope+'" tabindex="-1"><h3>'+title+'</h3>'+body+templates+
    (!items.length && !templates?'<p class="muted">'+(scope==="customer"?"Save a grader or customize a shipped version to start your collection.":"No graders in this section.")+'</p>':'')+'</section>';
}
function applyCatalogFilter(){
  const query=(quickLibraryRoute()?quickChooserFilter:gradeFilter).trim().toLowerCase();
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
  for(const jump of document.querySelectorAll<HTMLButtonElement>("[data-catalog-jump]")){
    jump.disabled=!!document.querySelector('[data-catalog-scope="'+jump.dataset.catalogJump+'"][hidden]');
  }
  const empty=document.getElementById("gc-no-matches");
  if(empty)empty.hidden=!query || !!document.querySelector(".gc-section:not([hidden])");
}
function setCardDetails(card:HTMLElement,open:boolean) {
  const button=card.querySelector<HTMLButtonElement>("[data-grader-details]");
  const detail=card.querySelector<HTMLElement>(".gc-detail-body");
  if(!button || !detail)return;
  button.setAttribute("aria-expanded",String(open));
  detail.hidden=!open;
}
function previewCard(event:PointerEvent,open:boolean) {
  if(event.pointerType!=="mouse" || !(event.target instanceof Element))return;
  const card=event.target.closest<HTMLElement>(".gc-card");
  if(!card || card.hasAttribute("data-info-pinned") || (event.relatedTarget instanceof Node && card.contains(event.relatedTarget)))return;
  if(!open && card.querySelector("[data-grader-details]:focus-visible"))return;
  setCardDetails(card,open);
}
document.addEventListener("pointerover",event=>previewCard(event,true));
document.addEventListener("pointerout",event=>previewCard(event,false));
document.addEventListener("focusin",event=>{
  if(event.target instanceof HTMLElement && event.target.matches("[data-grader-details]:focus-visible")){
    const card=event.target.closest<HTMLElement>(".gc-card");
    if(card)setCardDetails(card,true);
  }
});
document.addEventListener("focusout",event=>{
  if(!(event.target instanceof HTMLElement) || !event.target.matches("[data-grader-details]"))return;
  const card=event.target.closest<HTMLElement>(".gc-card");
  if(card && !card.hasAttribute("data-info-pinned"))setCardDetails(card,false);
});
document.addEventListener("keydown",event=>{
  if(event.key!=="Escape")return;
  for(const card of document.querySelectorAll<HTMLElement>(".gc-card:has([data-grader-details][aria-expanded=true])")){
    delete card.dataset.infoPinned;
    setCardDetails(card,false);
  }
});
async function sampleHistory(){
  try{
    const rows=await api.graderSamples();
    return rows.length?bar("Recent output tests")+scoreRows(rows):"";
  }catch(error){
    return '<p role="alert">Could not read recent output tests. '+esc(errorText(error))+'</p><button type="button" data-grade-retry>Retry recent tests</button>';
  }
}
async function refreshSampleHistory(){
  const sameVisit=currentVisit(),history=await sampleHistory();
  const scores=document.getElementById("grade-sample-scores");
  if(!sameVisit() || !scores)return null;
  scores.innerHTML=history;
  return scores;
}
async function gradersPage(){
  if(quickLibraryRoute())return quickChooserPage();
  const history=await sampleHistory(),draft=pendingSample ?? retrySample?.draft;
  const group=pendingSample ? ' disabled' : '';
  const outputTest='<details id="grade-sample-panel" data-own-open class="panel" '+(samplePanelOpen || retrySample?.error?'open':'')+'><summary>Test one output</summary><p>Paste the task and an existing answer to see the score and rationale from one grader.</p><form id="grade-sample" aria-busy="'+!!pendingSample+'"><fieldset class="gc-sample-fields"'+group+'><legend class="visually-hidden">Output test</legend>'+formField("Grader",gradeSelect(draft?.grader))+
    '<div class="cols">'+formField("Task or input",'<textarea name="input" required>'+esc(draft?.input)+'</textarea>')+formField("Model or agent output",'<textarea name="output" required>'+esc(draft?.output)+'</textarea>')+'</div>'+
    '<details data-sample-evidence '+(draft?.reference || draft?.trajectory?'open':'')+'><summary>Reference and agent trajectory</summary>'+formField("Reference (JSON or text)",'<textarea name="reference">'+esc(draft?.reference)+'</textarea>')+
    formField("Agent steps in order (JSON array)",'<textarea name="trajectory" placeholder=\'[{"tool":"search"},{"tool":"summarize"}]\'>'+esc(draft?.trajectory)+'</textarea>')+'</details>'+
    '<button class="yellow spacer" type="submit" '+(pendingSample || !state.graders.length?'disabled':'')+'>'+(pendingSample?'Scoring…':'Score this output')+'</button></fieldset><div data-sample-recovery>'+sampleRecovery()+'</div></form>'+
    '<div id="grade-sample-scores" tabindex="-1">'+history+'</div></details>';
  return heading("Workspace","Graders","A grader scores a model or agent answer against your success criteria. Create one or use a saved version below.")+
    gradeCreate()+workspaceGraderReceipt()+bar("Grader library",'<div class="gc-jumps"><button type="button" data-catalog-jump="customer">My Graders ↓</button><button type="button" data-catalog-jump="general">General ↓</button></div>')+
    formField("Search graders",'<input type="search" id="grade-filter" value="'+esc(gradeFilter)+'" placeholder="Name, industry, scenario or criterion">')+
    catalogSection("industry","Industry catalogue")+catalogSection("customer","My Graders")+catalogSection("general","General")+
    '<p id="gc-no-matches" hidden role="status">No matching graders.</p>'+outputTest;
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
    $("summary",picker).textContent=selectedGradersLabel(chosen);
    const notice=document.getElementById("dataset-judge-note");
    if(notice)notice.innerHTML=selectedJudgeNotice(chosen);
    updateDatasetGradingControls();
  }
  if(e.target.matches("#grade-sample [name=grader]")){
    if(e.target.form)editSampleRetry(e.target.form);
    const id=e.target.value;
    const g=state.graders.find(row=>row.id===id);
    if(g)showSampleEvidence(g);
    else $("#grade-sample [data-sample-evidence] summary").textContent="Reference and agent trajectory";
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
    $("#grade-decision-view",f).hidden=!decision;
    $("#grade-no-judge",f).hidden=!["exact","contains","field","trajectory","catalog"].includes(e.target.value);
    $("#judge-choice",f).hidden=!["opik","judge","opik-metric"].includes(e.target.value);
    resetDecisionDiscovery(f);
  }
  if(e.target.name==="decision-protocol" && e.target.form?.id==="grade-create"){
    const form=e.target.form,mlx=e.target.value==="mlx-vlm";
    const model=form.querySelector("[name=decision-model]")?.closest("label");
    const alternate=form.querySelector("[name=decision-fallback]")?.closest("label");
    if(model)$("span",model).textContent=mlx?"Preloaded checkpoint · absolute path":"Served model ID or alias";
    if(alternate)$("span",alternate).textContent=mlx?"Alternate checkpoint · absolute path (optional)":"Alternate served model ID (optional)";
    $("#decision-mlx-tip",form).hidden=!mlx;
    resetDecisionDiscovery(form);
  }
  if(e.target.name==="decision-provider" && e.target.form){updateDecisionProvider(e.target.form);resetDecisionDiscovery(e.target.form);}
  if(e.target.name==="decision-discovered" && e.target.form?.id==="grade-create" && e.target.value)
    requireElement("[name=decision-model]",HTMLInputElement,e.target.form).value=e.target.value;
});
document.addEventListener("input",e=>{
  if (!textInput(e.target)) return;
  if(e.target.form?.id==="grade-sample")editSampleRetry(e.target.form);
  if(e.target.name==="decision-endpoint" && e.target.form?.id==="grade-create")resetDecisionDiscovery(e.target.form);
  if(e.target.id==="grade-filter"){if(quickLibraryRoute())quickChooserFilter=e.target.value;else gradeFilter=e.target.value;applyCatalogFilter();}
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
  const detail=e.target.closest<HTMLButtonElement>("[data-grader-details]");
  const card=detail?.closest<HTMLElement>(".gc-card");
  if(card){
    const pinned=card.toggleAttribute("data-info-pinned");
    setCardDetails(card,pinned);return;
  }
  const jump=e.target.closest<HTMLButtonElement>("[data-catalog-jump]");
  if(jump){
    const section=[...document.querySelectorAll<HTMLElement>("[data-catalog-scope]")].find(s=>s.dataset.catalogScope===jump.dataset.catalogJump);
    if(section && !section.hidden){section.focus({preventScroll:true});section.scrollIntoView({block:"start"});}
    return;
  }
  const attach=e.target.closest<HTMLButtonElement>("[data-quick-attach],[data-quick-extra],[data-quick-stay],[data-quick-confirm],[data-quick-cancel]");
  const section=attach?.closest<HTMLElement>("[data-use-version]");
  if (attach && section) {
    const g=state.graders.find(g=>g.id===section.dataset.useVersion);
    if(g)await quickLibraryAction(attach,section,g);
    return;
  }
  const action=e.target.closest<HTMLButtonElement>("[data-grade-run],[data-grade-continue],[data-grade-cancel],[data-grade-test]");
  const host=action?.closest<HTMLElement>("[data-use-version]");
  if(action && host){
    const grader=state.graders.find(g=>g.id===host.dataset.useVersion);
    if(grader)await chooseGraderAction(action,host,grader);
    return;
  }
  const clear=e.target.closest<HTMLButtonElement>("[data-sample-clear]");
  if(clear?.form && !pendingSample){
    retrySample=null;
    for(const field of clear.form.querySelectorAll("textarea")) {
      field.defaultValue="";
      field.value="";
    }
    const grader=requireElement("[name=grader]",HTMLSelectElement,clear.form);
    for(const option of grader.options)option.defaultSelected=option.value==="";
    grader.value="";
    const details=requireElement("[data-sample-evidence]",HTMLDetailsElement,clear.form);
    details.open=false;$("summary",details).textContent="Reference and agent trajectory";
    $("select",clear.form).focus();$("[data-sample-recovery]",clear.form).replaceChildren();return;
  }
  const retry=e.target.closest<HTMLButtonElement>("[data-grade-retry]");
  if(retry){retry.disabled=true;await refreshSampleHistory();return;}
  const starter=e.target.closest<HTMLButtonElement>("[data-decision-starter]");
  const kind=starter?.dataset.decisionStarter;
  if(starter?.form && (kind==="earnings" || kind==="inspection" || kind==="completeness" || kind==="disclosure")){
    const form=starter.form,example=decisionStarters[kind],general=kind==="completeness" || kind==="disclosure";
    const method=requireElement("#grade-type",HTMLSelectElement,form);
    method.value="decision";method.dispatchEvent(new Event("change",{bubbles:true}));
    form.dataset.nativeStarter=String(general);
    if(general){
      const provider=requireElement("[name=decision-provider]",HTMLSelectElement,form);
      provider.value="local";provider.dispatchEvent(new Event("change",{bubbles:true}));
    }
    requireElement("[name=decision-view]",HTMLSelectElement,form).value=general?"task-answer":"case";
    for(const [name,value] of Object.entries(example)){
      const control=form.elements.namedItem(name);
      if(textInput(control)){control.value=value;control.dispatchEvent(new Event("input",{bubbles:true}));}
    }
    requireElement("input[value=reference]",HTMLInputElement,form).checked=!general;
    requireElement("input[value=trajectory]",HTMLInputElement,form).checked=false;
    const criteria=requireElement("[name=criteria]",HTMLTextAreaElement,form);
    criteria.focus();
    message(kind==="disclosure"?"Use only for tasks that identify missing evidence and ask the answer to disclose it.":"Starter applied. Review the criterion and save your grader version.");
    return;
  }
  const discover=e.target.closest<HTMLButtonElement>("[data-native-discover]");
  const panel=discover?.closest<HTMLElement>("[data-native-judge]");
  if(discover && panel){void discoverDecisionModels(panel,discover);return;}
  const toggle=e.target.closest<HTMLButtonElement>("[data-grade-default]");
  if(toggle?.dataset.gradeDefault){
    const id=toggle.dataset.gradeDefault,enabled=!state.generalGraderDefaults.includes(id),stillHere=currentVisit();
    toggle.disabled=true;
    try {
      await api.setGeneralGraderDefault(id,enabled);
      if(!stillHere())return;
      await render();
      message(enabled?"This judge revision will score eligible new runs.":"Automatic grading disabled for this revision.");
    } catch(error){if(toggle.isConnected)inlineError(toggle.closest<HTMLElement>(".grader-row") || $("#screen"),error);}finally{toggle.disabled=false;}
    return;
  }
  const template=e.target.closest<HTMLButtonElement>("[data-grade-template]");
  if(template){
    if(!await allowPageReplacement("Discard and open template") || !template.isConnected)return;
    showGraderAuthoring=true;graderDraft=null;graderEditIntent="create";
    graderTemplate=state.opikLibraryTemplates.find(t=>t.key===template.dataset.gradeTemplate) || null;
    await render(true);dashElement("#grade-create input",HTMLInputElement)?.focus();return;
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
    }).catch(error=>{if(uses.isConnected){uses.setAttribute("role","alert");uses.textContent=errorText(error);}});
    return;
  }
  const edit=e.target.closest<HTMLButtonElement>("[data-revise],[data-customize],[data-new-grader]");
  if(!edit || !await allowPageReplacement("Discard grader edits") || !edit.isConnected)return;
  graderTemplate=null;
  showGraderAuthoring=true;
  graderDraft=state.graders.find(g=>g.id===(edit.dataset.revise || edit.dataset.customize)) || null;
  graderEditIntent=edit.dataset.revise?"revise":edit.dataset.customize?"derive":"create";
  void render(true).then(()=>{if(graderDraft)dashElement("#grade-create input",HTMLInputElement)?.focus();});
});
document.addEventListener("toggle",e=>{
  const details=e.target;
  if(!(details instanceof HTMLDetailsElement) || !details.isConnected)return;
  if(details.id==="grader-authoring")showGraderAuthoring=details.open;
  if(details.id==="grade-sample-panel")samplePanelOpen=details.open;
},true);
async function scoreSample(form:HTMLFormElement) {
  if(pendingSample)return;
  const sameVisit=currentVisit();
  const draft=readSample(form);
  try{
    let reference:unknown=draft.reference.trim() || null,trajectory:unknown;
    try{reference=JSON.parse(draft.reference);}catch{ /* A plain-text reference is also valid. */ }
    if(draft.trajectory.trim()){
      try{trajectory=JSON.parse(draft.trajectory);}catch{throw Error("Enter observed agent steps as a valid JSON array.");}
      if(!Array.isArray(trajectory))throw Error("Agent steps must be a JSON array.");
    }
    const consent=graderConsentById([draft.grader],"this provided output");
    if(!consent)return;
    retrySample=null;$("[data-sample-recovery]",form).replaceChildren();
    pendingSample=draft;updateSampleLock();
    const result=await api.assess({grader:draft.grader,...consent,evidence:{input:draft.input,output:draft.output,reference,
      ...(Array.isArray(trajectory) && {trajectory})}});
    forgetNavigationEdits(form);
    if(trail()[0]!=="graders")return;
    const scores=await refreshSampleHistory();
    if(scores && sameVisit()){
      message(result.pass==null?"Unscored · "+result.reason:"Evaluation saved.");
      if(form.contains(document.activeElement))scores.focus();
    }
  }catch(error){
    retrySample={draft,error:errorText(error)};
    const recovery=document.querySelector<HTMLElement>("#grade-sample [data-sample-recovery]");
    if(recovery && trail()[0]==="graders")recovery.innerHTML=sampleRecovery();
  }finally{
    pendingSample=null;updateSampleLock();
  }
}
document.addEventListener("submit",async e=>{
  if (!(e.target instanceof HTMLFormElement)) return;

  if(e.target.id==="grade-sample"){e.preventDefault();await scoreSample(e.target);return;}
  if(!["grade-case","grade-create"].includes(e.target.id))return;
  e.preventDefault();const f=e.target,b=requireElement("button:not([type=button])",HTMLButtonElement,f);
  const field=(name:string)=>formText(f,name),stillHere=currentVisit();
  if(b.disabled || f.hasAttribute("data-nav-saved"))return;
  f.querySelector(":scope > [data-action-error]")?.remove();
  b.disabled=true;
  const title=b.textContent;
  try{
    if(f.id==="grade-create"){
      const type=field("type");
      if (!isGradeType(type)) throw Error("Choose a grading method.");
      const definition:UiGraderDefinition={name:field("name"),criteria:field("criteria"),industry:field("industry"),category:field("category"),type,threshold:Number(field("threshold")),judgeId:field("judgeId")};
      if(type==="opik"){
        const view=field("evidenceView");definition.evidenceView=view==="answer-only" || view==="task-answer"?view:"case";
      }
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
        const view=field("decision-view");
        if(view==="answer-only" || view==="task-answer")definition.decisionView=view;
        else if(view==="case" && (graderDraft?.decisionView || graderDraft?.evidenceView))definition.decisionView="case";
        if(f.dataset.nativeStarter==="true"){
          if(!local)throw Error("Choose a discovered local judge for this starter.");
          definition.confirmNative=true;
        }
        const checked=new FormData(f).getAll("decision-evidence");
        definition.requiredEvidence=(["reference","trajectory"] as const).filter(key=>checked.includes(key));
      }
      const payload:UiGraderSave=graderEditIntent==="create" || !graderDraft ? {...definition,intent:"create"} :
        {...definition,intent:graderEditIntent,sourceGraderId:graderDraft.id};
      const unlock=lockNavigationWrite(f);
      let savedId:string;
      try{savedId=await api.saveGrader(payload);}finally{unlock();}
      if(!stillHere() || !f.isConnected)return;
      graderEditIntent="create";graderTemplate=null;
      consumeSavedForm(f);graderDraft=null; recordWorkspaceSave([{id:savedId,label:definition.name}]);
    }
    else {
      b.textContent="Grading…";
      if(!f.dataset.id)throw Error("Reopen the saved case before grading it.");
      const grader=field("grader");
      const request:UiGradeRequest={grader,run:f.dataset.id,index:Number(f.dataset.index)};
      const consent=graderConsentById([grader],"this saved case");
      if(!consent)return;
      const result=await api.assess({...request,...consent});
      if(!stillHere())return;
      message(result.pass==null?"Unscored · "+result.reason:"Evaluation saved.");
    }
    await render();
    if(!stillHere())return;
    if(f.id==="grade-create")document.getElementById("grader-receipt")?.focus();
  }catch(error){inlineError(f,error);}finally{b.disabled=f.hasAttribute("data-nav-saved");b.textContent=title;}
});
