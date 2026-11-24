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
function activeWorkflow() { const mode=workflowMode();return mode ? workflows[mode] : activeGraderPlanning()?.planner ?? null; }
const workflowMode = () => trail()[0] === "compare" ? "quick" : trail()[0] === "new" ? "dataset" : null;
const metricLines = (text:string) => text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
const metricList = (items?:string[]) => '<ul class="wf-metric-list">' + (items || []).map(m => '<li>' + esc(m) + '</li>').join("") + '</ul>';
const roleEdits = new Map<string,{value:string;version:number}>();

function capLabel(p:UiTokenCaps) {
  return [p.inputCap && p.inputCap + " input tokens", p.outputCap && p.outputCap + " output tokens"].filter(Boolean).join(" · ") || "Runtime token defaults";
}
function workflowSteps(index:number,mode:UiMode) {
  return '<ol class="wf-steps" aria-label="Evaluation steps">' + ["Business outcome", "Review prompt", mode==="quick" ? "Set up evaluation" : "Start run"].map((s,i) =>
    '<li' + (i === index ? ' aria-current="step"' : '') + '><span aria-hidden="true">' + (i < index ? "✓" : i+1) + '</span>' + s + '</li>').join("") + '</ol>';
}
function workflowPage(mode:UiMode) {
  const w = workflows[mode];
  if (mode === "dataset" && !w.draft && !w.approved && !w.busy && !w.parentId) w.datasetId = dataset()?.id || "";
  if (mode === "dataset" && !w.approved && !w.draft && !w.parentId && !w.variant)
    return datasetRunPage(w);
  const step = w.approved ? 2 : w.draft ? 1 : 0;
  return '<section class="wf-page"><div class="wf-title"><h1>' + modeName(mode) + '</h1>' + workflowSteps(step,mode) + '</div>' +
    (w.error ? '<div role="alert" class="wf-error">' + esc(w.error) + '</div>' : '') +
    (mode === "dataset" && !w.parentId && !w.busy ? '<button class="quiet" type="button" id="dataset-native">← Use dataset instructions</button>' : '') +
    (w.approved ? workflowReady(w) : w.draft ? workflowReview(w) : workflowCompose(w)) + '</section>';
}
function outcomeExamples(w:UiWorkflow) {
  if (w.parentId) return "";
  const available=state.packs.filter(p=>w.mode==="quick" || p.id===packId);
  const examples=available.flatMap(p=>p.starter ? [{id:p.id,title:p.starter.title}] : []);
  if (!examples.length) return w.mode==="quick" && available.some(p=>p.id==="earnings" || p.id==="manufacturing")
    ? '<p class="wf-hint">Quit and reopen DASH to load the bundled industry examples.</p>' : "";
  return '<div class="wf-examples"><small>Try an outcome</small>'+examples.map(p=>'<button type="button" data-wf-example="'+esc(p.id)+'">'+esc(p.title)+'</button>').join("")+'</div>';
}
function planningDomainLabel(domain:string,source?:string) {
  const labels:Record<string,string>={dataset:"Dataset domain",user:"Selected domain",starter:"Example domain",inferred:"Inferred domain"};
  return (source && Object.hasOwn(labels,source) ? labels[source] : "Domain")+" · "+domain;
}
function domainControl(w:UiWorkflow) {
  const snapshot=state.datasets.find(d=>d.id===w.datasetId);
  const pinned=w.mode==="dataset" && snapshot && planningDomains.includes(snapshot.metadata.industry || "") && snapshot.metadata.industry;
  if (pinned) return '<p>Planning domain · <strong>'+esc(pinned)+'</strong> · assigned to this dataset</p>';
  return '<fieldset class="wf-domain"><legend>Planning domain</legend><div>' +
    [["","Infer from the task"],...planningDomains.map(d => [d,d])].map(([value,label]) =>
      '<label><input type="radio" name="wf-domain" value="' + esc(value) + '" ' + (w.domain===value?'checked':'') + '><span>' + esc(label) + '</span></label>').join("") + '</div></fieldset>';
}
function refinementSummary(run?:UiPriorRun|null,sourceRunId?:string|null) {
  if (!run?.id) return typeof sourceRunId==="string" && sourceRunId
    ? '<h3>Source run</h3>'+link('Open source run '+esc(sourceRunId.slice(0,8))+' →','run/'+encodeURIComponent(sourceRunId),'link')
    : "";
  const rows=run.candidates || [], custom=run.graders || [];
  const measured=rows.map(r => '<li>'+esc(r.candidate)+' · '+esc(r.responses)+' results · '+esc(r.errors)+' errors'+
    (r.scored?' · '+esc(r.passed || 0)+' of '+esc(r.scored)+' passed the scenario grader':'')+'</li>').join("");
  const graded=custom.map(g => '<li>'+esc(g.grader+' v'+g.version+' · '+g.candidate)+' · '+esc(g.passed || 0)+' of '+esc(g.scored)+' passed</li>').join("");
  return '<h3>Prior run observations</h3>'+link('Open source run '+esc(run.id.slice(0,8))+' →','run/'+encodeURIComponent(run.id),'link')+
    (measured || graded ? '<ul class="wf-metric-list">'+measured+graded+'</ul>' : '<p>No case results were recorded for this run.</p>');
}
const auditLabels:Record<UiMetricAudit["status"],string> = {
  proposed:"Proposed run check", "needs-evidence":"Needs evidence", external:"External business outcome"
};
function metricExplanation(review:UiReviewEvidence, edited=false) {
  if (!review.metricAudit?.length) return "";
  const pending=review.metricAudit.filter(row=>row.status==="needs-evidence").length;
  const external=review.metricAudit.filter(row=>row.status==="external").length;
  const summary=[pending && (pending+" awaiting evidence or a grader"),external && (external+" outside the run")].filter(Boolean).join(" · ");
  const rows = review.metricAudit.map(item =>
    '<li><strong>'+esc(item.metric)+'</strong><small>'+esc(auditLabels[item.status])+'</small>'+
    '<p>'+esc(item.reason)+'</p><dl><dt>Pass condition</dt><dd>'+esc(item.criterion)+'</dd>'+
    '<dt>Evidence needed</dt><dd>'+esc(item.evidence)+'</dd><dt>How to score</dt><dd>'+esc(item.method)+'</dd></dl></li>').join("");
  return '<details class="wf-options wf-explanation"><summary>Why these metrics?'+(summary?' <small>· '+summary+'</small>':'')+'</summary><div class="wf-options-body">'+
    '<p>Review by '+esc(review.auditDesigner?.model || "the evaluation metric auditor")+'.</p>'+
    '<p class="wf-edit-note" data-metric-edit-note '+(edited?'':'hidden')+'>This review covers the original proposals. Edited measures need another review.</p>'+
    '<ul>'+rows+'</ul></div></details>';
}
function promptExplanation(p:UiPrompt, edited:boolean) {
  const why=p.promptRationale;
  if (!why) return "";
  return '<details class="wf-options wf-explanation"><summary>Why this prompt?</summary><div class="wf-options-body">'+
    '<p>'+esc(why.reason)+'</p><dl><dt>Original objective</dt><dd>'+esc(why.original)+'</dd>'+
    (why.addition ? '<dt>Instruction added to the draft</dt><dd>'+esc(why.addition)+'</dd>' : '<dt>Draft change</dt><dd>Kept the original objective.</dd>')+'</dl>'+
    '<p class="wf-edit-note" data-prompt-edit-note '+(edited?'':'hidden')+'>This explanation covers the generated draft. You edited the prompt afterward.</p></div></details>';
}
function sameMeasureText(text:string, lines:string[]) {
  const current=metricLines(text);
  return current.length===lines.length && current.every((line,index)=>line===lines[index]);
}
function suggestionEdited(w:UiWorkflow) {
  return !!w.suggestion && (!sameMeasureText(w.chosenMetrics ?? "",w.suggestion.metrics) || !sameMeasureText(w.criteria,w.suggestion.criteria));
}
function planningDetails(p:UiPrompt, promptEdited=false, metricsEdited=false) {
  if (!p.agents?.length) return "";
  return metricExplanation(p,metricsEdited) + promptExplanation(p,promptEdited) + '<details class="wf-options"><summary>How the agents prepared this prompt</summary><div class="wf-options-body"><p>' + esc(planningDomainLabel(p.domain,p.domainSource)) + '</p>' +
    '<p>'+esc(p.agents.map(a=>(a.role==="expert"?"Industry expert":"Industry implementer")+" v"+a.version).join(" → "))+
    (p.designer?.model?' · '+esc(p.designer.model):'')+'</p><h3>Success criteria</h3>'+metricList(p.requirements)+plannerAttempts(p)+refinementSummary(p.priorRun,p.sourceRunId)+'</div></details>';
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
    (w.suggestion ? 'Suggested metrics' : 'Your metrics') + ' · what to measure</span><textarea id="wf-chosen-metrics" rows="3">' +
    esc(w.chosenMetrics) + '</textarea></label><label class="field"><span>Pass conditions · what counts as success for one answer</span><textarea id="wf-criteria" rows="3">' +
    esc(w.criteria) + '</textarea></label></div>' : manual;
  const supplement = w.suggestion?.criteriaReview?.supplementSource;
  const attribution = w.suggestion ? '<strong>AI expert · '+esc(planningDomainLabel(w.suggestion.domain,w.suggestion.domainSource))+'</strong> · AI suggestions can be wrong. Review and edit them before drafting.' +
    (w.mode==="quick" ? ' <button type="button" class="quiet" data-open-planning-domain>Change planning domain</button>' : '') +
    (supplement ? ' Supplementary criteria from '+esc(supplement)+'.' : '') : 'Edit or remove any line before drafting.';
  return head + '<div id="wf-measure-fields">' + fields +
    (selected ? '<p class="wf-hint">Pair each metric with its pass condition on the same line in the next field. The grader checks the answer against that condition.</p><small class="wf-hint">' + attribution + '</small>' : '') + (w.suggestion ? metricExplanation(w.suggestion,suggestionEdited(w)) : '') + '</div>';
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
function workflowCompose(w:UiWorkflow, grader=false) {
  const busy = !!w.busy;
  const objectiveHint = w.mode === "dataset" ? "What decision should these cases help you make?" : "What should a successful response help you do?";
  return '<form id="wf-design-form" class="wf-panel"><fieldset class="wf-fields"' + (busy ? ' disabled' : '') + '>' +
    '<h2>Define the business outcome</h2>' +
    (!grader && w.mode === "dataset" ? (w.parentId ? scenarioContract({...w,mode:"dataset"}) : pickers()) : '') +
    '<label class="field wf-primary"><span>Task objective</span><textarea id="wf-objective" required maxlength="12000" placeholder="' +
    objectiveHint + '">' + esc(w.objective) + '</textarea></label>' + (grader?'':outcomeExamples(w)) +
    (!grader && w.mode==="quick" ? '<label class="wf-json-toggle"><input type="checkbox" id="wf-structured" '+(w.structuredOutput?'checked':'')+'><span>Structured output (JSON)<small>Review the input fields and required response format before either model runs.</small></span></label>' : '') +
    '<section class="wf-measures" id="wf-measures" aria-label="Success measures">' + measuresSection(w) + '</section>' +
    '<details class="wf-options"><summary>Domain and token budgets</summary><div class="wf-options-body">' + domainControl(w) + '<div class="cols"><label class="field"><span>Input token limit</span><input type="number" min="1" max="1000000" step="1" id="wf-input-cap" value="' +
    esc(w.inputCap) + '" placeholder="Runtime default"></label><label class="field"><span>Output token limit</span><input type="number" min="1" max="1000000" step="1" id="wf-output-cap" value="' +
    esc(w.outputCap) + '" placeholder="Runtime default"></label></div><p class="muted">A hard input limit requires exact token counting for the selected runtime. DASH stops before inference if it cannot verify every case against the limit.</p></div></details>' +
    '<div class="wf-actions"><span class="wf-hint">' + (w.sourceRunId?'Revising from run '+esc(w.sourceRunId.slice(0,8))+'. Changing domain starts fresh preparation.':w.parentId?'Revising a saved prompt version.':'The domain agents draft a prompt for your review.') +
    '</span><button class="yellow" id="wf-design" type="submit">' + (w.busy === 'design' ? 'Drafting prompt…' : 'Draft evaluation prompt →') + '</button></div></fieldset></form>' +
    planningActivity(w) +
    (!grader && w.mode === "dataset" ? fixtureControl(w) : '');
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
function schemaAttribution(p:UiPrompt) {
  const role=p.agents?.find(agent=>agent.role==="implementer"), model=p.designer;
  const proposer=[role ? role.domain+" implementer v"+role.version : "",model ? model.provider+" · "+model.model : "",
    model?.revision && model.revision!==model.model ? model.revision : ""].filter(Boolean).join(" · ");
  const audit=p.auditDesigner ? " The metric auditor checked the success measures." : "";
  return (p.schemaReview?.declaredKeys ? '<p>Your objective specifies the output field names.</p>' : "")+
    (proposer ? '<p>Schema proposed by <strong>'+esc(proposer)+'</strong>.</p>' : "")+
    (p.agents?.some(agent=>agent.role==="expert") ? '<p>'+
      (p.metrics.length ? "The domain expert helped prepare the task and its proposed measures." : "The domain expert helped prepare the task.")+
      (p.metrics.length ? audit : "")+'</p>' : "");
}
function fieldContractFact(field:unknown,required:boolean) {
  if (!isRecord(field)) return "Complete the field type to preview its rule.";
  const type=Array.isArray(field.type) ? field.type[0] : field.type;
  const value=type==="string" ? "text" : type==="number" ? "a JSON number" : type==="integer" ? "a whole number" :
    type==="boolean" ? "true or false" : null;
  if (!value || (Array.isArray(field.type) && (field.type.length!==2 || field.type[1]!=="null")))
    return "Complete the field type to preview its rule.";
  if (!required) return "List this field in required before approval.";
  return "The key must appear. Its value must be "+value+(Array.isArray(field.type) ? " or null when unavailable." : ". A null value fails this check.");
}
function schemaFieldNotes(p:UiPrompt,currentSchema:unknown,currentTask:string) {
  if (!isRecord(currentSchema) || !isRecord(currentSchema.properties))
    return '<p>Complete the JSON schema to inspect the field rules.</p>';
  const review=p.schemaReview,fields=currentSchema.properties;
  const required=Array.isArray(currentSchema.required) ? currentSchema.required : [];
  if (Object.keys(fields).length>12 || required.length>12)
    return '<p>Use at most 12 required response fields to preview their rules.</p>';
  let missingNotes=!review;
  const items=Object.entries(fields).map(([name,field])=>{
    const proposal=review?.fields.find(f=>f.name===name);
    const origin=!review ? "Saved contract" : !proposal ? "Added by the operator" : review.declaredKeys ? "Named in your objective" : "Suggested by the implementer";
    const heading='<strong>'+esc(name)+'</strong> · '+origin+'<p>'+esc(fieldContractFact(field,required.includes(name)))+'</p>';
    if (!proposal || !review) return '<li>'+heading+'</li>';
    const original=proposal.nullable ? [proposal.type,"null"] : proposal.type;
    const typeEdited=!isRecord(field) || JSON.stringify(field.type)!==JSON.stringify(original);
    const taskEdited=review.taskEdited || currentTask!==p.prompt;
    const oldType=proposal.type+(proposal.nullable ? " or null" : ", non-null");
    const change=typeEdited ? '<p>Operator edited the type. Original proposal · '+esc(oldType)+'</p>' :
      taskEdited ? '<p>The proposal was made for the original task.</p>' : "";
    const note=proposal.note;
    if (!note) missingNotes=true;
    return '<li>'+heading+change+(note ? '<p>Implementer suggestion · '+esc(note.explanation)+'</p><small>Original objective · “'+esc(note.quote)+'”</small>' : "")+'</li>';
  });
  const removed=review?.fields.filter(f=>!Object.hasOwn(fields,f.name)).map(f=>f.name) ?? [];
  return '<ul class="wf-metric-list">'+items.join("")+'</ul>'+
    (removed.length ? '<p>Removed by the operator · '+esc(removed.join(", "))+'</p>' : '')+
    (missingNotes ? '<small>Only recorded suggestions with a matching task excerpt are shown. The field rules come directly from the contract.</small>' : '');
}
function currentSchemaNotes(w:UiWorkflow) {
  if (!w.draft) return "";
  try {
    const input=readJsonObject(w.reviewInput,"JSON input");
    return schemaFieldNotes(w.draft,readJsonObject(w.reviewSchema,"Required output schema"),typeof input.task==="string" ? input.task : "");
  } catch {return '<p>Complete the JSON edits to compare them with the proposal.</p>';}
}
function structuredReview(w:UiWorkflow) {
  const draft=w.draft;
  if (!draft) return "";
  return '<section aria-label="Candidate instructions"><h3>What each model receives</h3><p>Both models receive your task and source fields. The system message asks for one JSON object with the approved field names and types.</p>'+
    '<details id="wf-request-preview" class="wf-options"><summary>Inspect exact system and user messages</summary><div data-exact-messages></div></details></section>'+
    '<details open class="wf-options"><summary>Why these response fields?</summary>'+schemaAttribution(draft)+'<div data-schema-field-notes>'+currentSchemaNotes(w)+'</div></details>'+
    '<p id="wf-json-edit-status" role="status" class="wf-error" hidden></p><label class="field wf-json-field"><span>JSON input for both models</span><textarea id="wf-json-input" required rows="8" spellcheck="false" aria-describedby="wf-json-input-hint">'+
    esc(w.reviewInput)+'</textarea></label><p class="wf-hint" id="wf-json-input-hint">Edit the task and its source fields. Each source value must appear verbatim in the task.</p>'+
    '<label class="field wf-json-field"><span>Required output schema</span><textarea id="wf-json-schema" required rows="9" spellcheck="false" aria-describedby="wf-json-schema-hint">'+
    esc(w.reviewSchema)+'</textarea></label><p class="wf-hint" id="wf-json-schema-hint">Use 1–12 required fields. Values can be strings, numbers, integers or booleans. Allow null when the source may omit a value.</p>';
}
function reviewedPromptContent(p:UiPrompt) {
  if(!p.outputSchema || !p.input)return '<pre>'+esc(p.prompt)+'</pre>';
  return '<div class="wf-json-preview"><h3>Approved JSON input</h3><pre>'+pretty(p.input)+
    '</pre><h3>Required output schema</h3><pre>'+pretty(p.outputSchema)+'</pre><details class="wf-options"><summary>Why these response fields?</summary>'+schemaAttribution(p)+schemaFieldNotes(p,p.outputSchema,p.prompt)+'</details></div>';
}
// Six-character JSON escapes can expand each code unit of a 24,000-character task
// and eight 2,000-character source values. The source cap also leaves room for keys and formatting.
const structuredEditorLimits={"JSON input":262144,"Required output schema":16384} as const;
type StructuredEditor=keyof typeof structuredEditorLimits;
function sourceLengthError(field:StructuredEditor) {
  return field+" exceeds the editor limit of "+structuredEditorLimits[field].toLocaleString()+" characters.";
}
function readJsonObject(text:string|undefined,field:StructuredEditor) {
  if (text && text.length>structuredEditorLimits[field]) throw Error(sourceLengthError(field));
  let value:unknown;
  try {value=JSON.parse(text ?? "");}
  catch {throw Error("Enter valid JSON in "+field+" before approving.");}
  if(!isRecord(value))throw Error("Use a JSON object in "+field+".");
  return value;
}
async function showExactMessages(panel:HTMLDetailsElement,w:UiWorkflow) {
  const body=panel.querySelector<HTMLElement>("[data-exact-messages]");
  if (!body) return;
  const priorInput=w.reviewInput, priorSchema=w.reviewSchema;
  const current=()=>panel.open && panel.isConnected && w.reviewInput===priorInput && w.reviewSchema===priorSchema;
  body.textContent="Checking current JSON…";
  try {
    const turns=await api.previewStructuredPrompt({input:readJsonObject(priorInput,"JSON input"),outputSchema:readJsonObject(priorSchema,"Required output schema")});
    if (current()) body.innerHTML=turns.map(turn=>'<h4>'+esc(turn.role==="system"?"System message":"User message")+'</h4><pre>'+esc(turn.content)+'</pre>').join("");
  } catch (error) {if(current()) body.textContent=errorText(error);}
}
document.addEventListener("toggle",event=>{
  const panel=event.target,w=activeWorkflow();
  if (panel instanceof HTMLDetailsElement && panel.id==="wf-request-preview" && panel.open && w) void showExactMessages(panel,w);
},true);
document.addEventListener("click",event=>{
  if (!(event.target instanceof Element) || !event.target.closest("[data-refresh-exact]")) return;
  const panel=event.target.closest<HTMLDetailsElement>("#wf-request-preview"),w=activeWorkflow();
  if (panel && w) void showExactMessages(panel,w);
});
function structuredApproval(w:UiWorkflow):Partial<UiApproval> {
  if(!w.draft?.outputSchema)return {};
  const input=readJsonObject(w.reviewInput,"JSON input");
  if(typeof input.task!=="string" || !input.task.trim())throw Error("Enter a task in the JSON input before approving.");
  return {prompt:input.task.trim(),input,outputSchema:readJsonObject(w.reviewSchema,"Required output schema")};
}
function workflowReview(w:UiWorkflow, grader=false) {
  const d = w.draft;
  if (!d) return "";
  return planningActivity(w) + '<form id="wf-approval-form" class="wf-panel"><fieldset class="wf-fields"' + (w.busy ? ' disabled' : '') +
    '><div class="wf-section-head"><h2>Review the evaluation prompt</h2>' + tag(planningDomainLabel(d.domain,d.domainSource)) + '</div>' +
    (d.outputSchema && d.input ? structuredReview(w) : '<label class="field"><span>Task prompt sent to each candidate</span><textarea id="wf-prompt" required maxlength="24000" rows="10">' +
    esc(w.reviewPrompt) + '</textarea></label>') +
    '<label class="field"><span>Success metrics</span><textarea id="wf-review-metrics" rows="3">' +
    esc(w.reviewMetrics) + '</textarea></label><p class="wf-hint">One metric per line. Keep its reviewed name to retain its pass condition. Graders use these measures when scoring the returned answers.</p>' +
    planningDetails(d,w.reviewPrompt.trim()!==d.prompt,!sameMeasureText(w.reviewMetrics,d.metrics)) + scenarioContract({...d,mode:w.mode,datasetId:w.datasetId}) +
    '<div class="wf-actions"><button type="button" data-wf-edit>Edit outcome or domain</button><button class="yellow" type="submit" id="wf-approve">' +
    (w.busy ? 'Saving version…' : grader?'Approve prompt &amp; propose graders':'Approve &amp; choose models →') + '</button></div></fieldset></form>';
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
  if(w.mode==="quick") {
    const fields=p.outputSchema && isRecord(p.outputSchema.properties) ? Object.keys(p.outputSchema.properties).length : 0;
    const responseFormat=fields ? '<span>JSON response · '+fields+(fields===1?' field':' fields')+'</span>' : '';
    return '<section class="qc-brief" aria-label="Approved task"><div class="qc-brief-top"><span>Approved task · v'+esc(p.version)+'</span><span>'+esc(p.domain)+'</span>'+responseFormat+'</div>'+
      '<h2>'+esc(p.title || p.objective)+'</h2>'+(p.title && p.title!==p.objective ? '<p class="qc-objective">'+esc(p.objective)+'</p>' : '')+
      '<details class="qc-brief-details"><summary>Inspect approved task</summary><div>'+reviewedPromptContent(p)+metricList(p.metrics)+
      '<small>'+esc(capLabel(p))+'</small>'+planningDetails(p)+promptActions(p,{reviseLabel:"Revise outcome"})+
      '<button class="wf-new" type="button" data-wf-reset>New outcome</button></div></details></section>'+setupQuick();
  }
  const ds = state.datasets.find(d => d.id === p.datasetId);
  return '<section class="wf-panel wf-approved"><div class="wf-section-head"><div><small class="wf-eyebrow">Approved prompt · v' +
    esc(p.version) + '</small><h2>' + esc(p.title || p.objective) + '</h2></div>' + tag(p.domain) + '</div>' +
    '<details class="wf-options"><summary>Inspect approved prompt and success metrics</summary><div class="wf-options-body">' + reviewedPromptContent(p) + metricList(p.metrics) + '<small>' + esc(capLabel(p)) + '</small></div></details>' + planningDetails(p) + scenarioContract(p) +
    promptActions(p, {reviseLabel:"Revise outcome"}) + '<button class="wf-new" type="button" data-wf-reset>New outcome</button></section>' +
    ('<form id="setup" class="wf-panel"><h2>Select models for ' + esc(ds?.metadata?.family || ds?.name || "the dataset") +
      '</h2>' + graderPicker() + modelPicker("dataset", ds?.count || 0) + '</form>' + endpointForm() + hostingLegend());
}
function promptCatalogPage() {
  const prompts = state.prompts || [];
  return '<section class="wf-page">' + heading("Workspace", "Prompt catalog", "Reuse an approved prompt or revise it for your next evaluation.") +
    (prompts.length ? '<div class="wf-library">' + prompts.map(p =>
      '<article class="wf-panel"><div class="wf-section-head"><div><small class="wf-eyebrow">' + esc(modeName(p.mode)) + ' · v' + esc(p.version) +
      '</small><h2>' + esc(p.title || p.objective) + '</h2></div>' + tag(p.domain) + '</div><p>' + esc(p.objective) +
      '</p><details class="wf-options"><summary>View prompt and proposed metrics</summary><div class="wf-options-body">' + reviewedPromptContent(p) + metricList(p.metrics) + '<small>' + esc(capLabel(p)) + '</small></div></details>' + planningDetails(p) + promptActions(p,{use:true}) + '</article>').join("") + '</div>' :
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
function useWorkflowPrompt(p:UiApproved, revise:boolean, sourceRunId:string|null) {
  const w = plannerState(p.mode);
  Object.assign(w, {structuredOutput:!!p.outputSchema,objective:p.objective,metrics:p.requestedMetrics || "",domain:p.domainSource==="user" ? p.domain : "",inputCap:p.inputCap?.toString()??"",outputCap:p.outputCap?.toString()??"",datasetId:p.datasetId||"",parentId:p.id,sourceRunId});
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
  if(p.mode==="quick" && !revise) recoverQuickLineup(p);
  else {resetModelSelection(p.mode);if(p.mode==="quick")leaveQuickSetup();}
  return true;
}
async function openWorkflowPrompt(p:UiApproved, revise:boolean, sourceRunId:string|null = null) {
  const prior=workflows[p.mode],stillHere=currentVisit();
  if(prior.busy){message("Wait for the current evaluation setup operation to finish.");return;}
  if(!await allowPageReplacement("Discard and open prompt",unapprovedWorkflowLoss(prior)) || !stillHere() || prior!==workflows[p.mode])return;
  if (!useWorkflowPrompt(p,revise,sourceRunId)) return;
  if (trail()[0] === modeRoute(p.mode)) render(true); else navigateAfterDecision(modeRoute(p.mode));
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
function structuredOutputSummary(run:UiRunDetail) {
  if(!run.manifest.approvedPrompt?.outputSchema)return "";
  const rows=run.manifest.candidates.map(candidate=>{
    const index=run.results.findIndex(result=>result.candidateId===candidate.id);
    const result=run.results[index];
    const check=result?.structuredOutputCheck;
    const label=check ? check.valid ? "Conforms" : "Does not conform" : "Not checked";
    const response=index>=0 ? link("View response","run/"+encodeURIComponent(run.manifest.id)+"/"+index,"link") : "";
    return [esc(candidate.model || candidate.id),esc(label),esc(check?.message ?? (result?.error ? "The candidate request failed." : "No validation result was recorded.")),response];
  });
  return '<section class="wf-panel wf-structure-result" aria-label="JSON output validation"><h2>JSON output validation</h2>'+
    '<p>Each response is checked against the approved field names and types. Your graders assess the content.</p>'+
    table(["Candidate","Schema check","Details","Response"],rows)+'</section>';
}
function workflowCaseSummary(m:UiManifest, r:UiResult) {
  if (!m.approvedPrompt) return "";
  const spec=m.invocations?.find(i=>i.candidateId===r.candidateId);
  const actual=r.telemetry || {};
  const input=r.inputBudget;
  return '<div class="wf-panel wf-run-plan"><h3>Inference settings</h3><dl class="catalog-facts"><dt>Model adapter</dt><dd>'+
    esc([spec?.adapter,spec?.template].filter(Boolean).join(" · ") || "Unrecorded")+'</dd><dt>Input tokens</dt><dd>'+
    esc(actual.input_tokens ?? "Unreported")+'</dd>'+
    (input?'<dt>Checked input</dt><dd>'+esc(input.tokens+(input.cap!=null?" of "+input.cap:"")+" · "+input.source)+'</dd>':'')+'<dt>Output tokens</dt><dd>'+
    esc(actual.output_tokens ?? "Unreported")+(m.tokenBudget?.outputCap ? ' · limit '+esc(m.tokenBudget.outputCap) : '')+
    '</dd></dl></div>';
}
function workflowDesignInput(w:UiWorkflow) {
  return {
    mode: w.mode, requestId:w.activity?.requestId, objective: w.objective.trim(), metrics: w.metrics.trim(),
    ...(w.mode==="quick" && w.structuredOutput!==undefined && {structuredOutput:w.structuredOutput}),
    ...(w.chosenMetrics !== null && {measures:{metrics:metricLines(w.chosenMetrics),criteria:metricLines(w.criteria)}}),
    ...(w.suggestion && {suggestionId:w.suggestion.id}),
    ...(w.domain && {domain:w.domain}), ...(w.inputCap && {inputCap:Number(w.inputCap)}),
    ...(w.outputCap && {outputCap:Number(w.outputCap)}), ...(w.mode==="dataset" && {datasetId:w.datasetId}),
    ...(w.parentId && {parentId:w.parentId}), ...(w.sourceRunId && {sourceRunId:w.sourceRunId})
  };
}
function showCurrentWorkflow(w:UiWorkflow) {
  return activeWorkflow()===w;
}
const planningRequests=new Map<string,UiWorkflow>();
function updatePlanningActivity(w:Pick<UiWorkflow,"activity"|"busy">,event:UiPlanningEvent,body:HTMLElement|null,status:HTMLElement|null):void {
  const activity=w.activity;
  if (!activity || activity.requestId!==event.requestId) return;
  const index = activity.calls.findIndex(call => call.queryId === event.queryId);
  if (index < 0) activity.calls.push(event);
  else if (activity.calls[index].status === "running") activity.calls[index] = event;
  else return;
  if (body) {
    const expanded = body.querySelector("details")?.open;
    const focusedSummary = document.activeElement === body.querySelector(".ai-earlier summary");
    body.innerHTML = planningActivityBody(w);
    const earlier = body.querySelector("details");
    if (earlier && expanded) earlier.open = true;
    if (focusedSummary) earlier?.querySelector("summary")?.focus({preventScroll:true});
  }
  const announcement=[event.stage,event.model,planningOutcome[event.status]].join(" · ");
  if (status && status.textContent!==announcement) status.textContent = announcement;
}
window.dash?.onPlanningStage?.(event => {
  if(event.mode==="grader"){updateGraderActivity(event);return;}
  const w=planningRequests.get(event.requestId);
  if(!w || (w.busy!=="design" && w.busy!=="suggest"))return;
  const visible=showCurrentWorkflow(w);
  updatePlanningActivity(w,event,visible ? document.getElementById("wf-query") : null,visible ? document.getElementById("wf-progress") : null);
});
type WorkflowTextField = "objective"|"metrics"|"chosenMetrics"|"criteria"|"inputCap"|"outputCap"|"reviewPrompt"|"reviewMetrics";
const workflowFields:Record<string,WorkflowTextField|undefined> = {
  "wf-objective":"objective","wf-metrics":"metrics","wf-chosen-metrics":"chosenMetrics","wf-criteria":"criteria","wf-input-cap":"inputCap",
  "wf-output-cap":"outputCap","wf-prompt":"reviewPrompt","wf-review-metrics":"reviewMetrics"
};
document.addEventListener("input", e => {
  if (!textInput(e.target)) return;

  const w = activeWorkflow();
  if(w && !w.busy && w.draft?.outputSchema) {
    const field=e.target.id==="wf-json-input" ? "JSON input" : e.target.id==="wf-json-schema" ? "Required output schema" : null;
    if (field) {
      const status=document.getElementById("wf-json-edit-status");
      if (e.target.value.length>structuredEditorLimits[field]) {
        e.target.value=(field==="JSON input" ? w.reviewInput : w.reviewSchema) ?? "";
        if(status){status.hidden=false;status.textContent=sourceLengthError(field)+" Your previous edit was kept.";}
        return;
      }
      if (status) status.hidden=true;
    }
    if(e.target.id==="wf-json-input"){
      w.reviewInput=e.target.value;
      try {
        const input=readJsonObject(w.reviewInput,"JSON input");
        if(typeof input.task==="string")w.reviewPrompt=input.task;
      } catch { /* Incomplete JSON is valid while editing. Validate on approval. */ }
      const note=document.querySelector<HTMLElement>("[data-prompt-edit-note]");
      if(note)note.hidden=w.reviewPrompt.trim()===w.draft.prompt;
    }
    if(e.target.id==="wf-json-schema")w.reviewSchema=e.target.value;
    if (e.target.id==="wf-json-schema" || e.target.id==="wf-json-input") {
      const notes=document.querySelector("[data-schema-field-notes]");
      if (notes) notes.innerHTML=currentSchemaNotes(w);
      const preview=document.querySelector("#wf-request-preview[open] [data-exact-messages]");
      if (preview) preview.innerHTML='<p>Input or schema edited.</p><button type="button" class="quiet" data-refresh-exact>Update exact preview</button>';
    }
  }
  const key = workflowFields[e.target.id];
  if (w && key && !w.busy) {
    const changed = w[key] !== e.target.value;
    w[key] = e.target.value;
    const owner=activeGraderPlanning();
    if(changed && owner?.planner===w){
      if(key==="objective")owner.objectiveEdited=true;
      if(key==="metrics")owner.metricsEdited=true;
    }
    if (changed && (key === "chosenMetrics" || key === "criteria" || key === "reviewMetrics")) {
      const note=document.querySelector<HTMLElement>("[data-metric-edit-note]");
      if (note) note.hidden=key==="reviewMetrics" && w.draft ? sameMeasureText(w.reviewMetrics,w.draft.metrics) : !suggestionEdited(w);
    }
    if (changed && key === "reviewPrompt" && w.draft) {
      const note=document.querySelector<HTMLElement>("[data-prompt-edit-note]");
      if (note) note.hidden=w.reviewPrompt.trim()===w.draft.prompt;
    }
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
  if(w?.mode==="quick" && !w.busy && e.target instanceof HTMLInputElement && e.target.id==="wf-structured")
    w.structuredOutput=e.target.checked;
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
    } catch(error) { inlineError(form,error); }
    finally { delete form.dataset.saving; button.disabled=false; instructionsField.disabled=false; }
    return;
  }
  const design=form.id==="wf-design-form";
  if (!design && form.id!=="wf-approval-form") return;
  e.preventDefault();
  const w=activeWorkflow();
  if (!w || w.busy || !form.reportValidity()) return;
  if (design && !w.objective.trim()) {$("#wf-objective",form).focus();return;}
  if (!design && !w.draft?.outputSchema && !w.reviewPrompt.trim()) {$("#wf-prompt",form).focus();return;}
  const suggest = design && (e.submitter instanceof HTMLButtonElement && e.submitter.value) === "suggest";
  w.error="";
  const grader=activeGraderPlanning();
  if (design) {
    w.activity={requestId:crypto.randomUUID(),startedAt:Date.now(),calls:[]};
    planningRequests.set(w.activity.requestId,w);
  }
  w.busy=suggest ? "suggest" : design ? "design" : "approve";
  requireElement("fieldset",HTMLFieldSetElement,form).disabled=true;
  const refreshPreparation=async()=>{
    if(grader)repaintGradeDesigner(workspaceGradeScope,true);
    else await render();
  };
  void refreshPreparation().then(() => {
    if (design && showCurrentWorkflow(w) && (w.busy === "suggest" || w.busy === "design"))
      document.getElementById("wf-activity")?.scrollIntoView({block:"nearest"});
  });
  try {
    if (suggest) {
      if (!api.suggestMetrics) throw Error("Reopen DASH to use Suggest Metrics.");
      const task=workflowDesignInput(w);
      delete task.suggestionId;
      const result = await api.suggestMetrics(task);
      const parent=w.parentId ? workflowRecord(w.parentId) : null;
      if (w.activity && result.planningAttempts) w.activity.calls=result.planningAttempts.filter(a=>a.requestId===w.activity?.requestId);
      if(parent && !w.suggestion && parent.domain!==result.domain) {
        // The service already reconciled the submitted pairs with their original domain.
        w.chosenMetrics=result.metrics.join("\n");w.criteria=result.criteria.join("\n");
      } else {
        w.chosenMetrics = mergeSuggestions(w.chosenMetrics ?? w.metrics, w.suggestion?.metrics, result.metrics);
        w.criteria = mergeSuggestions(w.criteria, w.suggestion?.criteria, result.criteria);
      }
      w.suggestion = result;
    } else if (design) {
      if (!api.designPrompt) throw Error("The planning service is unavailable in this session. Reopen DASH to load the domain agents.");
      const draft=await api.designPrompt(workflowDesignInput(w));
      if (w.activity && draft.planningAttempts) w.activity.calls=draft.planningAttempts.filter(a=>a.requestId===w.activity?.requestId);
      w.reviewInput=draft.input ? JSON.stringify(draft.input,null,2) : undefined;
      w.reviewSchema=draft.outputSchema ? JSON.stringify(draft.outputSchema,null,2) : undefined;
      w.draft=draft; w.reviewPrompt=draft.prompt; w.reviewMetrics=draft.metrics.join("\n");
    } else {
      if (!w.draft) throw Error("No draft is available to approve.");
      w.approved=await api.approvePrompt({draftId:w.draft.draftId,prompt:w.reviewPrompt.trim(),metrics:metricLines(w.reviewMetrics),...structuredApproval(w)});
      if(grader){
        if(!state.prompts.some(p=>p.id===w.approved?.id))state.prompts=[w.approved,...state.prompts];
        await proposeReviewedGraders(grader);
      } else if (workflows[w.mode]===w) {
        if (w.mode==="quick") recoverQuickLineup(w.approved);
        else resetModelSelection(w.mode);
      }
    }
  } catch(error) {w.error=errorText(error);}
  finally {
    if(w.activity)planningRequests.delete(w.activity.requestId);
    w.busy="";
    if (showCurrentWorkflow(w)) {
      await refreshPreparation();
      (w.error ? document.querySelector('[role="alert"]') : document.querySelector(suggest?"#wf-measures":w.approved?(grader?"[data-gd-scope] .gd-proposals":"#setup"):"#wf-prompt, #wf-json-input"))?.scrollIntoView({block:"nearest"});
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
    catch (error) { if(cancel.isConnected)inlineError(cancel.closest("form") || $("#screen"),error);cancel.disabled = false; }
    return;
  }
  const changeDomain=e.target.closest<HTMLButtonElement>("[data-open-planning-domain]");
  if(changeDomain){
    const form=changeDomain.closest("form"),radio=form?.querySelector<HTMLInputElement>('[name="wf-domain"]:checked');
    const panel=radio?.closest("details");
    if(panel && radio){panel.open=true;radio.focus();}
    return;
  }
  const example=e.target.closest<HTMLButtonElement>("[data-wf-example]");
  if (example) {
    const field=dashElement("#wf-objective",HTMLTextAreaElement);
    const sample=state.packs.find(pack=>pack.id===example.dataset.wfExample)?.starter;
    if (!field || !sample) return;
    const exampleText = workflowMode() === "quick" ? sample.quickObjective : sample.task;
    field.value=field.value.trim()?field.value.trimEnd()+"\n"+exampleText:exampleText;
    field.dispatchEvent(new Event("input",{bubbles:true})); field.focus();
    return;
  }
  const button=e.target.closest<HTMLButtonElement>("[data-wf-use],[data-wf-revise],[data-wf-edit],[data-wf-reset],#wf-fixture");
  if (!button) return;
  const id=button.dataset.wfUse || button.dataset.wfRevise;
  if (id) {
    const p=workflowRecord(id);
    if (p) await openWorkflowPrompt(p, !!button.dataset.wfRevise, button.dataset.sourceRun || null);
    else message("This saved prompt could not be loaded.");
    return;
  }
  const w=activeWorkflow();
  if (!w || w.busy) return;
  const mode=w.mode;
  if (button.id==="wf-fixture") {
    const stillHere=currentVisit();button.disabled=true;
    try {
      const id=await api.start({mode:"dataset",datasetId:w.datasetId,candidateIds:[state.fixtureId],graderIds:[],animation:!matchMedia("(prefers-reduced-motion: reduce)").matches});
      if (stillHere() && showCurrentWorkflow(w)) location.hash="run/"+id;
    } catch(error) {w.error=errorText(error);if(stillHere())await render();}
    finally { button.disabled=false; }
    return;
  }
  const editedReview=button.hasAttribute("data-wf-edit") && w.draft && (w.reviewPrompt!==w.draft.prompt ||
    w.reviewMetrics!==w.draft.metrics.join("\n") || (w.draft.outputSchema && w.reviewSchema!==JSON.stringify(w.draft.outputSchema,null,2)) ||
    (w.draft.input && w.reviewInput!==JSON.stringify(w.draft.input,null,2)));
  if (!await allowPageReplacement("Discard and continue",editedReview?"unsaved changes to the reviewed prompt":
    button.hasAttribute("data-wf-reset")?unapprovedWorkflowLoss(w):"") || !button.isConnected)return;
  if (button.hasAttribute("data-wf-reset") && workflows[mode]===w) {workflows[mode]=plannerState(mode);if (mode==="quick")leaveQuickSetup();}
  else if (button.hasAttribute("data-wf-edit")) {w.draft=null;w.error="";}
  if(activeGraderPlanning()?.planner===w)repaintGradeDesigner(workspaceGradeScope,true);
  else await render(true);
  dashElement("#wf-objective",HTMLTextAreaElement)?.focus();
});
