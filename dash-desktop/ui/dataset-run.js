"use strict";

function datasetCaseDetails(row, pack) {
  const prompt = row.messages ? box("Model-visible conversation", row.messages) : row.prompt ?
    box("Case prompt", row.prompt) : box("Shared scenario instruction", pack?.system || "");
  const answer = row.reference ?? row.gold;
  return prompt + (row.input != null ? box("Case input",row.input) : "") +
    (answer == null && !row.rubric && !row.sme_rationale ? '<p class="muted">The selected grader defines success for this case.</p>' : '<details class="wf-options"><summary>Held-out grading evidence</summary><div class="wf-options-body">' +
    (answer != null ? box("Expected response",answer) : "") +
    (row.sme_rationale ? box("SME rationale",row.sme_rationale) : "") +
    (row.rubric ? box("Case success criteria",row.rubric) : "") + '</div></details>');
}

function datasetImportHelp(packId) {
  if (packId !== "reference") return '<small>Use this scenario’s input and gold fields. For your own prompts and SME responses, choose Prompt and reference evaluation.</small>';
  return '<details class="wf-options"><summary>JSONL case format</summary><div class="wf-options-body">' +
    '<p>Each line defines one test. Use a prompt or a chat messages array ending in a user message. Supply a reference answer or case rubric for the local judge. For inputs evaluated entirely by a saved grader, leave both fields out. The judge can also use an SME rationale.</p>' +
    '<pre>'+esc(JSON.stringify({case_id:"inspection-01",dataset_version:"1.0",split:"development",prompt:"A lot measures 10.04 mm. The upper limit is 10.03 mm. What should receiving do?",reference:"Hold the lot for review.",sme_rationale:"The measurement exceeds the upper limit by 0.01 mm.",rubric:"Credit a hold decision supported by the measurement. Accept equivalent wording."}))+
    '</pre><small>Use development or holdout for split. All cases in a file share the same version and split.</small></div></details>';
}

function caseJudgePicker(w) {
  const modelsForJudge=models().filter(m=>m.loaded);
  const preferred=modelsForJudge.find(m=>m.id===w.caseJudgeId) || modelsForJudge.find(m=>/lfm3/i.test(m.model)) || modelsForJudge[0];
  return '<label class="field"><span>Opik G-Eval judge for SME references and case rubrics</span><select name="caseJudgeId" required>'+
    (preferred ? modelsForJudge.map(m=>opt(m.id,m.model,preferred.id)).join("") : '<option value="">Load a local model first</option>')+
    '</select></label><small>The judge scores the answer against each case and explains its decision. A score of 0.80 passes.</small>';
}

const datasetScorerChoices=new Map();
function datasetRunPage(w) {
  const d=dataset(), scenario=pack(), reference=scenario?.kind==="reference";
  if (!d) return '<section class="wf-page"><h1>Dataset run</h1>'+link("Import a dataset →","datasets")+'</section>';
  const method=datasetScorerChoices.get(d.id) || (d.casesWithoutReference || readGraderAttachment("dataset:"+d.id)?.ids.length ? "selected-graders" : "case-judge");
  const error=w.error?'<p class="wf-error" role="alert">'+esc(w.error)+'</p>':'';
  return '<section class="wf-page"><div class="wf-title"><h1>Dataset run</h1></div>'+error+
    '<form id="dataset-run-form" class="wf-panel"><h2>Evaluate saved cases</h2>'+pickers()+
    '<div class="wf-section-head"><p>'+esc(d.metadata.family)+' · '+esc(d.metadata.industry)+' · '+esc(d.count)+' cases</p>'+
    link("Inspect prompts and references →","datasets/"+encodeURIComponent(d.id),"link")+'</div>'+
    '<p>'+esc(reference ? "Each model receives the prompt or conversation saved with each case." : "Each model receives the scenario instructions and the input saved with each case.")+
    (d.casesWithoutReference ? " This snapshot includes input-only cases. Choose a saved grader with its own success criteria.</p>" : " The grader can use the held-out evidence after the model answers.</p>")+
    (reference ? '<label class="field"><span>Scoring method</span><select name="datasetScorer">'+
      opt("case-judge","Use Opik G-Eval on case references and rubrics",method)+
      opt("selected-graders","Use saved graders",method)+opt("exact-reference","Match the reference exactly",method)+'</select></label>'+
      (method==="case-judge" ? caseJudgePicker(w) : '') :
      '<div class="wf-options"><strong>Scenario grader</strong><p>'+esc(scenario.scorer)+' · '+esc(scenario.metrics.join(" · "))+'</p></div>')+
    graderPicker()+
    '<details class="wf-options"><summary>Token limits</summary><div class="cols">'+
    '<label class="field"><span>Max input tokens</span><input name="inputCap" type="number" min="1" max="1000000" value="'+esc(w.inputCap)+'" placeholder="Automatic"></label>'+
    '<label class="field"><span>Max output tokens</span><input name="outputCap" type="number" min="1" max="1000000" value="'+esc(w.outputCap)+'" placeholder="Automatic"></label></div></details>'+
    modelPicker("dataset",d.count)+'</form>'+endpointForm()+hostingLegend()+
    (reference ? '' : '<div class="wf-actions"><button id="wf-variant" type="button">Test a prompt variant</button><small>Draft an alternate instruction for the same saved cases.</small></div>')+
    fixtureControl(w)+'</section>';
}

function plannerAttempts(p) {
  if (!p.planningAttempts?.length) return "";
  const review=p.guidanceReview;
  const omitted=review?.omitted ? '<p>'+esc('Draft review removed '+review.omitted+' generated instruction'+(review.omitted===1?'':'s')+' ('+review.reasons.join(', ')+').')+'</p>' : '';
  const sources=[...new Set([review?.supplementSource,p.criteriaReview?.supplementSource].filter(Boolean))];
  const grounding=sources.length?'<p>'+esc('Additional guidance from '+sources.join(' and '))+'.</p>':'';
  return omitted+grounding+'<h3>Planning models</h3><ul>'+p.planningAttempts.map(a=>'<li>'+esc([a.stage,a.model,a.status,a.reason].filter(Boolean).join(" · "))+'</li>').join("")+'</ul>';
}

function plannerSettingsPanel() {
  const s=state.plannerFallback || {};
  return '<details class="wf-panel"><summary>Prompt creation · LFM3 and OpenAI fallback</summary>'+
    '<form id="planner-fallback" class="wf-options-body"><p>LFM3 drafts prompts and suggests metrics locally. If it is unavailable or its answer fails validation, the enabled fallback sends the planning brief to OpenAI.</p>'+
    '<label class="choice"><input name="enabled" type="checkbox" '+(s.enabled?'checked':'')+'>Enable direct OpenAI fallback</label>'+
    '<label class="field"><span>OpenAI model ID</span><input name="model" required value="'+esc(s.model || "gpt-4.1-mini")+'"></label>'+
    '<label class="field"><span>API key for this session</span><input name="key" type="password" autocomplete="off" placeholder="'+(s.hasKey?'Key available':'Enter an OpenAI API key')+'"></label>'+
    '<small>The model preference persists. Keys entered here stay in memory.</small><div><button>Save planner settings</button></div></form></details>';
}

document.addEventListener("click",async e=>{
  if (e.target.closest("#wf-variant")) { workflows.dataset.variant=true; workflows.dataset.error=""; await render(); }
  if (e.target.closest("#dataset-native")) { workflows.dataset=plannerState("dataset"); await render(); }
});
document.addEventListener("input",e=>{
  if (e.target.form?.id==="dataset-run-form" && ["inputCap","outputCap"].includes(e.target.name))
    workflows.dataset[e.target.name]=e.target.value;
});
document.addEventListener("change",e=>{
  if (e.target.form?.id!=="dataset-run-form") return;
  if (e.target.name==="datasetScorer") { datasetScorerChoices.set(dataset().id,e.target.value); render(); }
  if (e.target.name==="caseJudgeId") workflows.dataset.caseJudgeId=e.target.value;
});
document.addEventListener("submit",async e=>{
  const f=e.target;
  if (!["planner-fallback","dataset-run-form"].includes(f.id)) return;
  e.preventDefault();
  const btn=f.querySelector("button[type=submit]") || f.querySelector("button");
  if (btn.disabled || (f.id==="dataset-run-form" && !canStartDataset())) return;
  btn.disabled=true;
  try {
    if (f.id==="planner-fallback") {
      const values=Object.fromEntries(new FormData(f));
      await api.savePlannerFallback({...values, enabled:f.elements.enabled.checked});
      await render(); message("Planner preferences saved."); return;
    }
    const d=dataset();
    workflows.dataset.busy="start";
    const ids=selectedModels("dataset");
    const config={mode:"dataset",datasetId:d.id,candidateIds:ids,graderIds:selectedGraderIds(),animation:!matchMedia("(prefers-reduced-motion: reduce)").matches};
    if (f.elements.datasetScorer) config.datasetScorer=f.elements.datasetScorer.value;
    if (config.datasetScorer==="case-judge") { config.datasetScorer="selected-graders"; config.caseJudgeId=f.elements.caseJudgeId.value; }
    for (const key of ["inputCap","outputCap"]) if (f.elements[key].value) config[key]=Number(f.elements[key].value);
    const run=await api.start(config);
    workflows.dataset.error=""; baseline=""; location.hash="run/"+run;
  } catch (err) {
    const msg=String(err.message).replace(/^Error invoking remote method .dash:[^ ]+ Error: /,"");
    if (f.id==="dataset-run-form") {workflows.dataset.busy="";workflows.dataset.error=msg;await render();}
    else message(msg);
  } finally {
    if (f.id==="dataset-run-form") workflows.dataset.busy="";
    btn.disabled=false;
  }
});
