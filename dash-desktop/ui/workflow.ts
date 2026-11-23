"use strict";

const planningDomains = ["Financial Services", "Manufacturing", "General"];
const modeName = (mode:UiMode) => mode === "quick" ? "Quick compare" : "Dataset run";
const modeRoute = (mode:UiMode) => mode === "quick" ? "compare" : "new";
const plannerState = (mode:UiMode):UiWorkflow => ({
  mode, objective: "", metrics: "", domain: "", inputCap: "", outputCap: "",
  datasetId: "", parentId: null, sourceRunId: null, draft: null, approved: null, reviewPrompt: "",
  reviewMetrics: "", suggestion: null, chosenMetrics: null, criteria: "", busy: "", error: ""
});
const workflows = { quick: plannerState("quick"), dataset: plannerState("dataset") };
function activeWorkflow() { const mode=workflowMode();return mode ? workflows[mode] : null; }
const workflowMode = () => trail()[0] === "compare" ? "quick" : trail()[0] === "new" ? "dataset" : null;
const metricLines = (text:string) => text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
const metricList = (items?:string[]) => '<ul class="wf-metric-list">' + (items || []).map(m => '<li>' + esc(m) + '</li>').join("") + '</ul>';
const roleEdits = new Map<string,{value:string;version:number}>();

function capLabel(p:UiTokenCaps) {
  return [p.inputCap && p.inputCap + " input tokens", p.outputCap && p.outputCap + " output tokens"].filter(Boolean).join(" · ") || "Runtime token defaults";
}
function workflowSteps(index:number) {
  return '<ol class="wf-steps" aria-label="Evaluation steps">' + ["Business outcome", "Review prompt", "Start run"].map((s,i) =>
    '<li' + (i === index ? ' aria-current="step"' : '') + '><span aria-hidden="true">' + (i < index ? "✓" : i+1) + '</span>' + s + '</li>').join("") + '</ol>';
}
function workflowPage(mode:UiMode) {
  const w = workflows[mode];
  if (mode === "dataset" && !w.draft && !w.approved && !w.busy && !w.parentId) w.datasetId = dataset()?.id || "";
  if (mode === "dataset" && !w.approved && !w.draft && !w.parentId && !w.variant)
    return datasetRunPage(w);
  const step = w.approved ? 2 : w.draft ? 1 : 0;
  return '<section class="wf-page"><div class="wf-title"><h1>' + modeName(mode) + '</h1>' + workflowSteps(step) + '</div>' +
    (w.error ? '<div role="alert" class="wf-error">' + esc(w.error) + '</div>' : '') +
    (mode === "dataset" && !w.parentId && !w.busy ? '<button class="quiet" type="button" id="dataset-native">← Use dataset instructions</button>' : '') +
    (w.approved ? workflowReady(w) : w.draft ? workflowReview(w) : workflowCompose(w)) + '</section>';
}
const exampleOutcomes:Record<string,{title:string;sample:string;text:string}> = {
  earnings: {title:"Review earnings disclosures", sample:"Synthetic release excerpt: For the quarter ended June 30, diluted GAAP EPS was $0.74. Adjusted diluted EPS was $0.85. The release provides no reconciliation.", text:"Identify earnings figures that need analyst review. Cite the reported period and basis for each figure and flag missing evidence."},
  manufacturing: {title:"Inspect a supplier lot", sample:"Synthetic inspection record: Lot K7, shaft diameter. Active drawing B specifies 10.00 ± 0.03 mm. Reading: 10.04 mm. The receiving rule accepts only readings within the stated limits.", text:"Help receiving inspection decide which supplier lots need review using the measurement, tolerance and drawing revision in each record."},
};
function outcomeExamples(w:UiWorkflow) {
  if (w.parentId) return "";
  const keys=w.mode==="quick"?Object.keys(exampleOutcomes):Object.keys(exampleOutcomes).filter(k=>k===packId);
  if (!keys.length) return "";
  return '<div class="wf-examples"><small>Try an outcome</small>' + keys.map(key => '<button type="button" data-wf-example="'+key+'">'+esc(exampleOutcomes[key].title)+'</button>').join("")+'</div>';
}
function domainControl(w:UiWorkflow) {
  const snapshot=state.datasets.find(d=>d.id===w.datasetId);
  const pinned=w.mode==="dataset" && snapshot && planningDomains.includes(snapshot.metadata.industry || "") && snapshot.metadata.industry;
  if (pinned) return '<p>Planning domain · <strong>'+esc(pinned)+'</strong> · assigned to this dataset</p>';
  return '<fieldset class="wf-domain"><legend>Planning domain</legend><div>' +
    [["","Infer from the task"],...planningDomains.map(d => [d,d])].map(([value,label]) =>
      '<label><input type="radio" name="wf-domain" value="' + esc(value) + '" ' + (w.domain===value?'checked':'') + '><span>' + esc(label) + '</span></label>').join("") + '</div></fieldset>';
}
function refinementSummary(run?:UiPriorRun|null) {
  if (!run?.id) return "";
  const rows=run.candidates || [], custom=run.graders || [];
  const measured=rows.map(r => '<li>'+esc(r.candidate)+' · '+esc(r.responses)+' results · '+esc(r.errors)+' errors'+
    (r.scored?' · '+esc(r.passed || 0)+' of '+esc(r.scored)+' passed the scenario grader':'')+'</li>').join("");
  const graded=custom.map(g => '<li>'+esc(g.grader+' v'+g.version+' · '+g.candidate)+' · '+esc(g.passed || 0)+' of '+esc(g.scored)+' passed</li>').join("");
  return '<h3>Prior run observations</h3>'+link('Open source run '+esc(run.id.slice(0,8))+' →','run/'+encodeURIComponent(run.id),'link')+
    (measured || graded ? '<ul class="wf-metric-list">'+measured+graded+'</ul>' : '<p>No case results were recorded for this run.</p>');
}
function planningDetails(p:UiPrompt) {
  if (!p.agents?.length) return "";
  const domainSources:Record<string,string>={dataset:"Dataset domain",user:"Selected domain",inferred:"Inferred domain"};
  const source=domainSources[p.domainSource || ""] || "Domain";
  return '<details class="wf-options"><summary>How the agents prepared this prompt</summary><div class="wf-options-body"><p>' + esc(source+" · "+p.domain) + '</p>' +
    '<p>'+esc(p.agents.map(a=>(a.role==="expert"?"Industry expert":"Industry implementer")+" v"+a.version).join(" → "))+
    (p.designer?.model?' · '+esc(p.designer.model):'')+'</p><h3>Success criteria</h3>'+metricList(p.requirements)+plannerAttempts(p)+refinementSummary(p.priorRun)+'</div></details>';
}
function measuresSection(w:UiWorkflow) {
  const suggesting = w.busy === "suggest";
  const head = '<div class="wf-measure-head"><h3>Success measures</h3>' +
    '<button type="submit" name="intent" value="suggest" id="wf-suggest" aria-controls="wf-measure-fields" ' +
    (!w.objective.trim() || w.busy ? 'disabled' : '') + '>' + (suggesting ? 'Suggesting metrics…' : 'Suggest Metrics') + '</button></div>';
  const manual = '<label class="field"><span>How will you measure success? <small>Optional</small></span>' +
    '<input id="wf-metrics" maxlength="2000" value="' + esc(w.metrics) + '" placeholder="For example, count incorrect lot acceptances."></label>';
  const selected = w.chosenMetrics !== null;
  const fields = selected ? '<div class="wf-measure-grid"><label class="field"><span>' +
    (w.suggestion ? 'Suggested metrics' : 'Your metrics') + '</span><textarea id="wf-chosen-metrics" rows="3">' +
    esc(w.chosenMetrics) + '</textarea></label><label class="field"><span>Success criteria</span><textarea id="wf-criteria" rows="3">' +
    esc(w.criteria) + '</textarea></label></div>' : manual;
  const source = w.suggestion ? esc(w.suggestion.criteriaReview?.supplementSource || w.suggestion.domain+" expert") + ' · ' : '';
  return head + '<div id="wf-measure-fields">' + fields +
    (selected ? '<small class="wf-hint">' + source + 'Edit or remove any line before drafting.</small>' : '') + '</div>';
}
function mergeSuggestions(text:string, previous:string[] = [], suggested:string[] = []) {
  const current = metricLines(text);
  const custom = current.filter(line => !previous.includes(line));
  const fresh = suggested.filter(line => !previous.includes(line) || current.includes(line));
  return [...new Set([...custom, ...fresh])].join("\n");
}
function invalidateSuggestions(w:UiWorkflow) {
  if (!w.suggestion) return;
  const remainingMetrics = mergeSuggestions(w.chosenMetrics ?? "", w.suggestion.metrics);
  w.criteria = mergeSuggestions(w.criteria, w.suggestion.criteria);
  w.chosenMetrics = remainingMetrics || w.criteria ? remainingMetrics : null;
  w.metrics = remainingMetrics;
  w.suggestion = null;
  const section = document.getElementById("wf-measures");
  if (section) section.innerHTML = measuresSection(w);
}
function workflowCompose(w:UiWorkflow) {
  const busy = !!w.busy;
  const objectiveHint = w.mode === "dataset" ? "What decision should these cases help you make?" : "What should a successful response help you do?";
  return '<form id="wf-design-form" class="wf-panel"><fieldset class="wf-fields"' + (busy ? ' disabled' : '') + '>' +
    '<h2>Define the business outcome</h2>' +
    (w.mode === "dataset" ? (w.parentId ? scenarioContract({...w,mode:"dataset"}) : pickers()) : '') +
    '<label class="field wf-primary"><span>Task objective</span><textarea id="wf-objective" required maxlength="12000" placeholder="' +
    objectiveHint + '">' + esc(w.objective) + '</textarea></label>' + outcomeExamples(w) +
    '<section class="wf-measures" id="wf-measures" aria-label="Success measures">' + measuresSection(w) + '</section>' +
    '<details class="wf-options"><summary>Domain and token budgets</summary><div class="wf-options-body">' + domainControl(w) + '<div class="cols"><label class="field"><span>Input token limit</span><input type="number" min="1" max="1000000" step="1" id="wf-input-cap" value="' +
    esc(w.inputCap) + '" placeholder="Runtime default"></label><label class="field"><span>Output token limit</span><input type="number" min="1" max="1000000" step="1" id="wf-output-cap" value="' +
    esc(w.outputCap) + '" placeholder="Runtime default"></label></div><p class="muted">A hard input limit requires exact token counting for the selected runtime. DASH stops before inference if it cannot verify every case against the limit.</p></div></details>' +
    '<div class="wf-actions"><span class="wf-hint">' + (w.sourceRunId?'The agents will use measured results from run '+esc(w.sourceRunId.slice(0,8))+' to revise the prompt.':w.parentId?'Revising a saved prompt version.':'The domain agents draft a prompt for your review.') +
    '</span><button class="yellow" id="wf-design" type="submit">' + (w.busy === 'design' ? 'Drafting prompt…' : 'Draft evaluation prompt →') + '</button></div></fieldset></form>' +
    (busy ? '<div class="wf-actions wf-progress"><span id="wf-progress" role="status">' +
      esc(w.stage || "Finding a loaded local planning model…") + '</span><button id="wf-cancel-design" type="button">Cancel preparation</button></div>' : '') +
    (w.mode === "dataset" ? fixtureControl(w) : '');
}
function fixtureControl(w:UiWorkflow) {
  const d = state.datasets.find(d=>d.id===w.datasetId);
  if (d?.origin !== "bundled") return "";
  return '<details class="wf-options wf-fixture"><summary>Test the scenario grader with saved answers</summary><p>Replay the bundled responses to inspect which cases the scenario grader passes or fails.</p>' +
    '<button type="button" id="wf-fixture" ' + (state.active || w.busy ? 'disabled' : '') + '>Replay saved answers</button></details>';
}
function scenarioContract(p:{mode:UiMode;datasetId?:string|null;dataset?:UiPack|null}) {
  if (p.mode !== "dataset") return "";
  const d = state.datasets.find(d => d.id === p.datasetId);
  const s = p.dataset || state.packs.find(s => s.id === d?.pack);
  if (!s) return '<p role="alert">The linked scenario is unavailable.</p>';
  return '<details class="wf-options"><summary>Fixed scenario contract · ' + esc(s.title) + '</summary><div class="wf-options-body"><p>' + esc(s.system) +
    '</p><h3>Required output schema</h3><pre>' + pretty(s.outputSchema) + '</pre><small>Snapshot ' + esc((d?.name || s.title) + " · " + (s.version || d?.version || "")) +
    ' · Grader ' + esc(s.scorer || state.packs.find(pack => pack.id===d?.pack)?.scorer || "scenario grader") + '</small></div></details>';
}
function workflowReview(w:UiWorkflow) {
  const d = w.draft;
  if (!d) return "";
  return '<form id="wf-approval-form" class="wf-panel"><fieldset class="wf-fields"' + (w.busy ? ' disabled' : '') +
    '><div class="wf-section-head"><h2>Review the evaluation prompt</h2>' + tag(d.domain) + '</div>' +
    '<label class="field"><span>Prompt for evaluation</span><textarea id="wf-prompt" required maxlength="24000" rows="10">' +
    esc(w.reviewPrompt) + '</textarea></label>' +
    '<label class="field"><span>Success metrics</span><textarea id="wf-review-metrics" rows="3">' +
    esc(w.reviewMetrics) + '</textarea></label><p class="wf-hint">One metric per line. The graders selected for the run determine which checks are scored.</p>' +
    planningDetails(d) + scenarioContract({...d,mode:w.mode,datasetId:w.datasetId}) +
    '<div class="wf-actions"><button type="button" data-wf-edit>Edit outcome or domain</button><button class="yellow" type="submit" id="wf-approve">' +
    (w.busy ? 'Saving version…' : 'Approve &amp; choose models →') + '</button></div></fieldset></form>';
}
function promptActions(p:UiApproved, {use=false,runId=null,reviseLabel="Revise"}:{use?:boolean;runId?:string|null;reviseLabel?:string} = {}) {
  const head=(state.prompts || []).reduce((latest,v)=>v.familyId===p.familyId && v.version>latest.version ? v : latest,p);
  const older=head.id!==p.id;
  const useButton=use?'<button type="button" data-wf-use="'+esc(p.id)+'">Use v'+esc(p.version)+' for run →</button>':'';
  const description=older?'<p class="wf-hint">Version '+esc(p.version)+' is saved. New revisions start from v'+esc(head.version)+'.</p>':'';
  return description+'<div class="wf-version-actions">'+useButton+'<button type="button" data-wf-revise="'+esc(head.id)+'"'+
    (runId && !older?' data-source-run="'+esc(runId)+'"':'')+'>'+esc(older?'Revise latest · v'+head.version:reviseLabel)+'</button></div>';
}
function workflowReady(w:UiWorkflow) {
  const p = w.approved;
  if (!p) return "";
  const ds = state.datasets.find(d => d.id === p.datasetId);
  return '<section class="wf-panel wf-approved"><div class="wf-section-head"><div><small class="wf-eyebrow">Approved prompt · v' +
    esc(p.version) + '</small><h2>' + esc(p.title || p.objective) + '</h2></div>' + tag(p.domain) + '</div>' +
    '<details class="wf-options"><summary>Inspect approved prompt and success metrics</summary><div class="wf-options-body"><pre>' + esc(p.prompt) +
    '</pre>' + metricList(p.metrics) + '<small>' + esc(capLabel(p)) + '</small></div></details>' + planningDetails(p) + scenarioContract(p) +
    promptActions(p, {reviseLabel:"Revise outcome"}) + '<button class="wf-new" type="button" data-wf-reset>New outcome</button></section>' +
    (w.mode === "quick" ? setupQuick() : '<form id="setup" class="wf-panel"><h2>Select models for ' + esc(ds?.metadata?.family || ds?.name || "the dataset") +
      '</h2>' + graderPicker() + modelPicker("dataset", ds?.count || 0) + '</form>' + endpointForm() + hostingLegend());
}
function promptCatalogPage() {
  const prompts = state.prompts || [];
  return '<section class="wf-page">' + heading("Workspace", "Prompt catalog", "Reuse an approved prompt or revise it for your next evaluation.") +
    (prompts.length ? '<div class="wf-library">' + prompts.map(p =>
      '<article class="wf-panel"><div class="wf-section-head"><div><small class="wf-eyebrow">' + esc(modeName(p.mode)) + ' · v' + esc(p.version) +
      '</small><h2>' + esc(p.title || p.objective) + '</h2></div>' + tag(p.domain) + '</div><p>' + esc(p.objective) +
      '</p><details class="wf-options"><summary>View prompt and proposed metrics</summary><div class="wf-options-body"><pre>' + esc(p.prompt) +
      '</pre>' + metricList(p.metrics) + '<small>' + esc(capLabel(p)) + '</small></div></details>' + planningDetails(p) + promptActions(p,{use:true}) + '</article>').join("") + '</div>' :
      '<div class="wf-panel"><h2>No approved prompts yet</h2><p>Approve a draft in Quick compare or Dataset run to save its first version.</p>' +
      link("Start with an outcome →", "compare") + '</div>') + '</section>';
}
function domainRolesPage() {
  const roles = state.domainRoles || [];
  const domains = [...new Set(roles.map(r=>r.domain))];
  return '<section class="wf-page">' + heading("Workspace", "Domain agents", "As the local workspace administrator, edit the instructions used to plan future runs.") +
    plannerSettingsPanel() + (domains.length ? domains.map(domain => '<section class="wf-domain-section"><h2>' + esc(domain) + '</h2><div class="wf-role-grid">' +
      roles.filter(r=>r.domain===domain).map(roleEditor).join("") + '</div></section>').join("") :
      '<p class="wf-error">No domain agent profiles were returned by the workspace.</p>') + '</section>';
}
function roleEditor(r:UiRole) {
  const edit = roleEdits.get(r.domain+"/"+r.role);
  return '<form class="wf-panel" data-wf-role data-domain="' + esc(r.domain) + '" data-role="' + esc(r.role) + '" data-version="' + esc(edit?.version ?? r.version) +
    '"><div class="wf-section-head"><h3>' + esc(r.role==="expert"?"Industry expert":"Industry implementer") + '</h3>' + tag("v"+r.version) +
    '</div><label class="field"><span>Agent instructions</span><textarea rows="7" name="instructions" maxlength="12000" required>' + esc(edit?.value ?? r.instructions) +
    '</textarea></label>' + (r.sources?.length ? '<details class="wf-options"><summary>Reference material</summary><ul class="wf-sources">' + r.sources.map(s =>
      '<li><strong>'+esc(s.title)+'</strong><small>'+esc(s.url)+'</small></li>').join("")+'</ul></details>' : '') +
    '<div class="wf-version-actions"><button type="submit">Save agent version</button><button type="button" data-wf-restore>Reload saved instructions</button></div></form>';
}
function workflowRecord(id:string) {
  return (state.prompts || []).find(p => p.id === id) || (current?.manifest?.approvedPrompt?.id===id ? current.manifest.approvedPrompt : null);
}
function openWorkflowPrompt(p:UiApproved, revise:boolean, sourceRunId:string|null = null) {
  const w = plannerState(p.mode);
  Object.assign(w, {objective:p.objective,metrics:p.requestedMetrics || "",domain:p.domain,inputCap:p.inputCap?.toString()??"",outputCap:p.outputCap?.toString()??"",datasetId:p.datasetId||"",parentId:p.id,sourceRunId});
  if (p.mode === "dataset") {
    const d = state.datasets.find(d=>d.id===p.datasetId);
    if (!d) { message("The dataset snapshot for this version is unavailable."); return; }
    packId=d.pack; datasetId=d.id;
  }
  if (!revise) w.approved = p;
  else {
    w.chosenMetrics = (p.metrics || []).join("\n");
    w.criteria = (p.requirements || []).join("\n");
  }
  workflows[p.mode] = w;
  resetModelSelection(p.mode);
  if (trail()[0] === modeRoute(p.mode)) render(); else location.hash=modeRoute(p.mode);
}
function workflowRunSummary(m:UiManifest, status:string) {
  const p=m.approvedPrompt;
  if (!p) return "";
  return '<section class="wf-panel wf-run-plan"><div class="wf-section-head"><div><small class="wf-eyebrow">Approved evaluation · v' +
    esc(p.version) + '</small><h2>' + esc(p.objective) + '</h2></div>'+tag(p.domain)+'</div><h3>Proposed business metrics</h3>' + metricList(p.metrics) +
    '<small>'+esc(capLabel(p))+'</small><details class="wf-options"><summary>Scoring and prompt versions</summary><div class="wf-options-body"><p>'+
    esc([m.pack?.scorer,...(m.graders || []).map(g=>g.name+" v"+g.version)].filter(Boolean).join(" · ") || "No grader was selected for this run.")+
    '</p><p>Prompt revision '+esc(p.version)+' · '+esc(m.promptHash || p.id)+'</p>'+planningDetails(p)+'</div></details>'+
    (["completed","failed","canceled"].includes(status) ? promptActions(p,{use:true,runId:m.id,reviseLabel:m.guardrailFailure?"Shorten the prompt for this limit →":"Revise for the next run →"}) : '')+'</section>';
}
function workflowCaseSummary(m:UiManifest, r:UiResult) {
  if (!m.approvedPrompt) return "";
  const spec=m.invocations?.find(i=>i.candidateId===r.candidateId);
  const actual=r.telemetry || {};
  const input=r.inputBudget;
  return '<div class="wf-panel wf-run-plan"><h3>Inference settings</h3><dl class="catalog-facts"><dt>Model adapter</dt><dd>'+
    esc([spec?.adapter,spec?.template].filter(Boolean).join(" · ") || "Unrecorded")+'</dd><dt>Input tokens</dt><dd>'+
    esc(input ? input.tokens+" of "+input.cap+" · "+input.source : actual.input_tokens ?? "Unreported")+'</dd><dt>Output tokens</dt><dd>'+
    esc(actual.output_tokens ?? "Unreported")+(m.tokenBudget?.outputCap ? ' · limit '+esc(m.tokenBudget.outputCap) : '')+
    '</dd></dl></div>';
}
function workflowDesignInput(w:UiWorkflow) {
  return {
    mode: w.mode, objective: w.objective.trim(), metrics: w.metrics.trim(),
    ...(w.chosenMetrics !== null && {measures:{metrics:metricLines(w.chosenMetrics),criteria:metricLines(w.criteria)}}),
    ...(w.suggestion && {suggestionId:w.suggestion.id}),
    ...(w.domain && {domain:w.domain}), ...(w.inputCap && {inputCap:Number(w.inputCap)}),
    ...(w.outputCap && {outputCap:Number(w.outputCap)}), ...(w.mode==="dataset" && {datasetId:w.datasetId}),
    ...(w.parentId && {parentId:w.parentId}), ...(w.sourceRunId && {sourceRunId:w.sourceRunId})
  };
}
function showCurrentWorkflow(w:UiWorkflow) {
  return workflows[w.mode]===w && trail()[0]===modeRoute(w.mode);
}
window.dash?.onPlanningStage?.(({mode,stage,model}) => {
  const w = workflows[mode];
  if (!["design","suggest"].includes(w?.busy)) return;
  w.stage = stage + " · " + model;
  if (showCurrentWorkflow(w)) {
    const label = document.querySelector("#wf-progress");
    if (label) label.textContent = w.stage;
  }
});
type WorkflowTextField = "objective"|"metrics"|"chosenMetrics"|"criteria"|"inputCap"|"outputCap"|"reviewPrompt"|"reviewMetrics";
const workflowFields:Record<string,WorkflowTextField|undefined> = {
  "wf-objective":"objective","wf-metrics":"metrics","wf-chosen-metrics":"chosenMetrics","wf-criteria":"criteria","wf-input-cap":"inputCap",
  "wf-output-cap":"outputCap","wf-prompt":"reviewPrompt","wf-review-metrics":"reviewMetrics"
};
document.addEventListener("input", e => {
  if (!textInput(e.target)) return;

  const w = activeWorkflow();
  const key = workflowFields[e.target.id];
  if (w && key && !w.busy) {
    const changed = w[key] !== e.target.value;
    w[key] = e.target.value;
    if (key === "objective") {
      if (changed) invalidateSuggestions(w);
      const suggest = dashElement("#wf-suggest",HTMLButtonElement);
      if (suggest) suggest.disabled = !w.objective.trim();
    }
  }
  const form=e.target.closest<HTMLFormElement>("form[data-wf-role]");
  if (form && e.target.name==="instructions") roleEdits.set(form.dataset.domain+"/"+form.dataset.role,
    {value:e.target.value,version:Number(form.dataset.version)});
});
document.addEventListener("change",e=>{
  if (!textInput(e.target)) return;

  const w=activeWorkflow();
  if (w && !w.busy && e.target.name==="wf-domain" && w.domain !== e.target.value) {
    w.domain=e.target.value;
    invalidateSuggestions(w);
  }
  if (w?.mode==="dataset" && ["pack","ds"].includes(e.target.id)) { w.domain=""; w.error=""; invalidateSuggestions(w); }
});
document.addEventListener("submit", async e=>{
  if (!(e.target instanceof HTMLFormElement)) return;

  const form=e.target;
  if (!(form instanceof HTMLFormElement)) return;
  if (form.matches("[data-wf-role]")) {
    e.preventDefault();
    if (form.dataset.saving) return;
    const {domain,role,version}=form.dataset;
    form.dataset.saving="true";
    const instructionsField=requireElement("[name=instructions]",HTMLTextAreaElement,form);
    const instructions=instructionsField.value;
    if (!domain || !role) return;
    const button=requireElement("button[type=submit]",HTMLButtonElement,form);
    button.disabled=true; instructionsField.disabled=true;
    try {
      await api.saveDomainRole({domain,role,instructions,expectedVersion:Number(version)});
      roleEdits.delete(domain+"/"+role);
      if (trail()[0]==="roles") {await render(); message("Agent version saved.");}
    } catch(error) { message(errorText(error)); }
    finally { delete form.dataset.saving; button.disabled=false; instructionsField.disabled=false; }
    return;
  }
  const design=form.id==="wf-design-form";
  if (!design && form.id!=="wf-approval-form") return;
  e.preventDefault();
  const w=activeWorkflow();
  if (!w || w.busy || !form.reportValidity()) return;
  if (design && !w.objective.trim()) {$("#wf-objective",form).focus();return;}
  if (!design && !w.reviewPrompt.trim()) {$("#wf-prompt",form).focus();return;}
  const suggest = design && (e.submitter instanceof HTMLButtonElement && e.submitter.value) === "suggest";
  w.error=""; w.stage=""; w.busy=suggest ? "suggest" : design ? "design" : "approve";
  requireElement("fieldset",HTMLFieldSetElement,form).disabled=true;
  void render();
  try {
    if (suggest) {
      if (!api.suggestMetrics) throw Error("Reopen DASH to use Suggest Metrics.");
      const task=workflowDesignInput(w);
      delete task.suggestionId;
      const result = await api.suggestMetrics(task);
      w.chosenMetrics = mergeSuggestions(w.chosenMetrics ?? w.metrics, w.suggestion?.metrics, result.metrics);
      w.criteria = mergeSuggestions(w.criteria, w.suggestion?.criteria, result.criteria);
      w.suggestion = result;
    } else if (design) {
      if (!api.designPrompt) throw Error("The planning service is unavailable in this session. Reopen DASH to load the domain agents.");
      const draft=await api.designPrompt(workflowDesignInput(w));
      w.draft=draft; w.reviewPrompt=draft.prompt; w.reviewMetrics=draft.metrics.join("\n");
    } else {
      if (!w.draft) throw Error("No draft is available to approve.");
      w.approved=await api.approvePrompt({draftId:w.draft.draftId,prompt:w.reviewPrompt.trim(),metrics:metricLines(w.reviewMetrics)});
      if (workflows[w.mode]===w) {
        resetModelSelection(w.mode);
      }
    }
  } catch(error) {w.error=String(errorText(error)).replace(/^Error invoking remote method .dash:[^ ]+ Error: /,"");}
  finally {
    w.busy="";
    if (showCurrentWorkflow(w)) {
      await render();
      (w.error ? document.querySelector('[role="alert"]') : document.querySelector(suggest?"#wf-measures":w.approved?"#setup":"#wf-prompt"))?.scrollIntoView({block:"nearest"});
    }
  }
});
document.addEventListener("click", async e=>{
  if (!(e.target instanceof Element)) return;

  const reloadRole=e.target.closest("button[data-wf-restore]")?.closest("form");
  if (reloadRole && !reloadRole.dataset.saving) {
    roleEdits.delete(reloadRole.dataset.domain+"/"+reloadRole.dataset.role); await render(); return;
  }
  const cancel = e.target.closest<HTMLButtonElement>("#wf-cancel-design");
  if (cancel) {
    cancel.disabled = true;
    try { await api.cancelDesign(); }
    catch (error) { message(errorText(error)); cancel.disabled = false; }
    return;
  }
  const example=e.target.closest<HTMLButtonElement>("[data-wf-example]");
  if (example) {
    const field=dashElement("#wf-objective",HTMLTextAreaElement);
    const sample=exampleOutcomes[example.dataset.wfExample ?? ""];
    if (!field || !sample) return;
    const exampleText = workflowMode() === "quick" ? sample.text + "\n\n" + sample.sample : sample.text;
    field.value=field.value.trim()?field.value.trimEnd()+"\n"+exampleText:exampleText;
    field.dispatchEvent(new Event("input",{bubbles:true})); field.focus();
    return;
  }
  const button=e.target.closest<HTMLButtonElement>("[data-wf-use],[data-wf-revise],[data-wf-edit],[data-wf-reset],#wf-fixture");
  if (!button) return;
  const id=button.dataset.wfUse || button.dataset.wfRevise;
  if (id) {
    const p=workflowRecord(id);
    if (p) openWorkflowPrompt(p, !!button.dataset.wfRevise, button.dataset.sourceRun || null);
    else message("This saved prompt could not be loaded.");
    return;
  }
  const mode=workflowMode();
  if (!mode) return;
  const w=workflows[mode];
  if (!w || w.busy) return;
  if (button.id==="wf-fixture") {
    button.disabled=true;
    try {
      const id=await api.start({mode:"dataset",datasetId:w.datasetId,candidateIds:[state.fixtureId],graderIds:[],animation:!matchMedia("(prefers-reduced-motion: reduce)").matches});
      if (showCurrentWorkflow(w)) location.hash="run/"+id;
    } catch(error) { message(errorText(error)); }
    finally { button.disabled=false; }
    return;
  }
  if (button.hasAttribute("data-wf-reset")) workflows[mode]=plannerState(mode);
  else if (button.hasAttribute("data-wf-edit")) {w.draft=null;w.error="";}
  await render();
  dashElement("#wf-objective",HTMLTextAreaElement)?.focus();
});
