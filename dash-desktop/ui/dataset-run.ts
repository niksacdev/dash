"use strict";

function datasetCaseDetails(row:UiCase, pack?:UiPack|null) {
  const prompt = row.messages ? box("Model-visible conversation", row.messages) : row.prompt ?
    box("Case prompt", row.prompt) : box("Shared scenario instruction", pack?.system || "");
  const answer = row.reference ?? row.gold;
  return prompt + (row.input != null ? box("Case input",row.input) : "") +
    (answer == null && !row.rubric && !row.sme_rationale ? '<p class="muted">The selected grader defines success for this case.</p>' : '<details class="wf-options"><summary>Held-out grading evidence</summary><div class="wf-options-body">' +
    (answer != null ? box("Expected response",answer) : "") +
    (row.sme_rationale ? box("SME rationale",row.sme_rationale) : "") +
    (row.rubric ? box("Case success criteria",row.rubric) : "") + '</div></details>');
}

function datasetImportHelp(packId:string) {
  if (packId !== "reference") return '<small>Use this scenario’s input and gold fields. For your own prompts and SME responses, choose Prompt and reference evaluation.</small>';
  return '<details class="wf-options"><summary>JSONL case format</summary><div class="wf-options-body">' +
    '<p>Each line defines one test. Use a prompt or a chat messages array ending in a user message. Supply a reference answer or case rubric for the local judge. For inputs evaluated entirely by a saved grader, leave both fields out. The judge can also use an SME rationale.</p>' +
    '<pre>'+esc(JSON.stringify({case_id:"inspection-01",dataset_version:"1.0",split:"development",prompt:"A lot measures 10.04 mm. The upper limit is 10.03 mm. What should receiving do?",reference:"Hold the lot for review.",sme_rationale:"The measurement exceeds the upper limit by 0.01 mm.",rubric:"Credit a hold decision supported by the measurement. Accept equivalent wording."}))+
    '</pre><small>Use development or holdout for split. All cases in a file share the same version and split.</small></div></details>';
}

function caseJudgePicker(w:UiWorkflow) {
  const modelsForJudge=models().filter(m=>m.loaded);
  const preferred=modelsForJudge.find(m=>m.id===w.caseJudgeId) || modelsForJudge.find(m=>/lfm3/i.test(m.model)) || modelsForJudge[0];
  return '<label class="field"><span>Opik G-Eval judge for SME references and case rubrics</span><select name="caseJudgeId" required>'+
    (preferred ? modelsForJudge.map(m=>opt(m.id,m.model,preferred.id)).join("") : '<option value="">Load a local model first</option>')+
    '</select></label><small>The judge scores the answer against each case and explains its decision. A score of 0.80 passes.</small>';
}

const datasetScorerChoices=new Map<string,string>();
function datasetScoringMethod(d:UiDataset) {
  const chosen=datasetScorerChoices.get(d.id);
  if (chosen) return chosen;
  if (readGraderAttachment("dataset:"+d.id)?.ids.length) return "selected-graders";
  const withoutGuidance=datasetGradingChoices?.casesWithoutGuidance ?? d.casesWithoutReference;
  if (!withoutGuidance) return "case-judge";
  if (!d.casesWithRubric && datasetGradingChoices?.literalAnswerCount===d.count) return "exact-reference";
  return "selected-graders";
}
function datasetGraderEvidenceIssue(grader:UiGrader,options:UiGraderOptions|null,total:number) {
  if (grader.type==="trajectory" || grader.requiredEvidence?.includes("trajectory"))
    return "This grader needs recorded agent actions. Use Test one output and supply the agent steps.";
  if (!needsGraderReference(grader)) return "";
  const field=referenceFieldFor(grader);
  if (field && !options?.fieldCoverage) return "Restart DASH to check whether each expected answer contains the JSON field "+field+".";
  const count=field ? (options?.fieldCoverage && Object.hasOwn(options.fieldCoverage,field) ? options.fieldCoverage[field] : 0) : options?.expectedAnswerCount;
  if (count===undefined && options?.hasReferences!==false)
    return "Restart DASH to verify how many cases have expected answers for this grader.";
  const requirement=field ? "an expected JSON answer containing the field "+field : "an expected answer";
  if ((count ?? 0)<total) return grader.name+" needs "+requirement+" for every case. "+(count ?? 0)+" of "+total+
    " have one. Add the missing answers in a new dataset version, remove the grader, or disable its automatic use in Graders.";
  return "";
}
function referenceScoringIssue() {
  const d=dataset();
  if(!d)return "";
  const selected=datasetGradeSelection(activeDatasetGraderScope());
  const explicitlySelected=(datasetGradingChoices?.available || []).filter(g=>selected.has(g.id));
  const graders=[...(datasetGradingChoices?.automatic || []),...explicitlySelected];
  for (const grader of graders) {
    const issue=datasetGraderEvidenceIssue(grader,datasetGradingChoices,d.count);
    if (issue) return issue;
  }
  if (pack()?.kind!=="reference" || workflows.dataset.approved)return "";
  const method=datasetScoringMethod(d);
  const withoutGuidance=datasetGradingChoices?.casesWithoutGuidance ?? d.casesWithoutReference;
  if(method==="exact-reference")return (datasetGradingChoices?.literalAnswerCount ?? d.count-d.casesWithoutReference)<d.count || d.casesWithRubric ?
    "Exact matching needs an expected answer on every case and no case rubrics." : "";
  if(method==="case-judge")return withoutGuidance ? "Some cases have neither an expected answer nor a scoring rule. Choose a saved grader with its own criteria." : "";
  const meaningful=graders.filter(g=>!(g.type==="catalog" && ["response-present","completion","json-valid"].includes(g.ruleKey || "")));
  if(d.casesWithRubric && !explicitlySelected.some(g=>g.type==="judge" || (g.type==="opik" && (g.evidenceView ?? "case")==="case") ||
    (g.type==="decision" && (g.decisionView ?? "case")==="case")))
    return "Choose a rubric-aware judge to score the case-specific instructions.";
  if(withoutGuidance && !meaningful.some(g=>g.type==="field" || (!needsGraderReference(g) && g.type!=="trajectory" && !g.requiredEvidence?.includes("trajectory"))))
    return "Choose a grader that can score the input and response without a reference, such as Opik Usefulness.";
  return meaningful.length ? "" : "Choose a saved grader or enable a compatible cross-industry grader in the library.";
}
function updateDatasetGradingControls() {
  const note=document.getElementById("dataset-scoring-issue");
  if(note){const issue=referenceScoringIssue();note.textContent=issue;note.hidden=!issue;}
  const go=dashElement("#dataset-models .go-button",HTMLButtonElement);
  if(go)go.disabled=!canStartDataset();
}
function datasetRunPage(w:UiWorkflow) {
  const d=dataset(), scenario=pack(), reference=scenario?.kind==="reference";
  if (!d || !scenario) return '<section class="wf-page"><h1>Dataset run</h1>'+link("Import a dataset →","datasets")+'</section>';
  const method=datasetScoringMethod(d);
  const error=w.error?'<p class="wf-error" role="alert">'+esc(w.error)+'</p>':'';
  return '<section class="wf-page"><div class="wf-title"><h1>Dataset run</h1></div>'+error+
    '<form id="dataset-run-form" class="wf-panel"><h2>Evaluate saved cases</h2>'+pickers()+
    '<div class="wf-section-head"><p>'+esc(d.metadata.family)+' · '+esc(d.metadata.industry)+' · '+esc(d.count)+' cases</p>'+
    link("Inspect prompts and references →","datasets/"+encodeURIComponent(d.id),"link")+'</div>'+
    '<p>'+esc(reference ? "Each model receives the prompt or conversation saved with each case." : "Each model receives the scenario instructions and the input saved with each case.")+
    (d.casesWithoutReference ? " This snapshot includes input-only cases. These need a grader with its own success criteria.</p>" : " The grader can use the held-out evidence after the model answers.</p>")+
    (reference ? '<label class="field"><span>Scoring method</span><select name="datasetScorer">'+
      opt("case-judge","Use Opik G-Eval on case references and rubrics",method)+
      opt("selected-graders","Use saved graders",method)+opt("exact-reference","Match the reference exactly",method)+'</select></label>'+
      (method==="case-judge" ? caseJudgePicker(w) : '') :
      '<div class="wf-options"><strong>Scenario grader</strong><p>'+esc(scenario.scorer)+' · '+esc(scenario.metrics.join(" · "))+'</p></div>')+
    graderPicker()+
    '<details class="wf-options"><summary>Token limits</summary><div class="cols">'+
    '<label class="field"><span>Max input tokens</span><input name="inputCap" type="number" min="1" max="1000000" value="'+esc(w.inputCap)+'" placeholder="Automatic"></label>'+
    '<label class="field"><span>Max output tokens</span><input name="outputCap" type="number" min="1" max="1000000" value="'+esc(w.outputCap)+'" placeholder="Automatic"></label></div></details>'+
    (!rosterModels().some(m=>!m.needsKey)?'<p class="wf-hint">Connect a candidate in '+link("Local runtimes","providers","link")+' or use Connect a model endpoint below to start this run.</p>':"")+
    modelPicker("dataset",d.count)+'</form>'+endpointForm()+hostingLegend()+
    (reference ? '' : '<div class="wf-actions"><button id="wf-variant" type="button">Test a prompt variant</button><small>Draft an alternate instruction for the same saved cases.</small></div>')+
    fixtureControl(w)+'</section>';
}

function plannerAttempts(p:UiPrompt) {
  if (!p.planningAttempts?.length) return "";
  const review=p.guidanceReview;
  const omitted=review?.omitted ? '<p>'+esc('Draft review removed '+review.omitted+' generated instruction'+(review.omitted===1?'':'s')+' ('+review.reasons.join(', ')+').')+'</p>' : '';
  const sources=[...new Set([review?.supplementSource,p.criteriaReview?.supplementSource].filter(Boolean))];
  const grounding=sources.length?'<p>'+esc('Additional guidance from '+sources.join(' and '))+'.</p>':'';
  return omitted+grounding+'<h3>Planning queries</h3>'+p.planningAttempts.map(planningQueryRow).join("");
}

function plannerSettingsPanel() {
  const s=state.plannerFallback;
  return '<details class="wf-panel"><summary>Prompt creation · LFM3 and OpenAI fallback</summary>'+
    '<form id="planner-fallback" class="wf-options-body"><p>DASH starts with local LFM3. Enabling this option allows paid requests to api.openai.com when local prompt preparation, metric suggestions or grader design cannot finish.</p>'+
    '<details><summary>What a planning request sends</summary><p>The selected OpenAI model receives agent instructions and the task brief, including text pasted into the objective, success measures and criteria. Depending on the stage, the brief includes the scenario contract, field names, token budgets, the expert’s proposed measures, or an earlier approved prompt and aggregate run results.</p></details>'+
    '<label class="choice"><input name="enabled" type="checkbox" '+(s.enabled?'checked':'')+'>Enable direct OpenAI fallback</label>'+
    '<label class="field"><span>OpenAI model ID</span><input name="model" required value="'+esc(s.model || "gpt-4.1-mini")+'"></label>'+
    '<label class="field"><span>API key for this session</span><input name="key" type="password" autocomplete="off" placeholder="'+(s.hasKey?'Key available':'Enter an OpenAI API key')+'"></label>'+
    '<small>The model preference persists. Keys entered here stay in memory.</small><div><button>Save planner settings</button></div></form></details>';
}

document.addEventListener("click",async e=>{
  if (!(e.target instanceof Element)) return;

  if (e.target.closest("#wf-variant")) { workflows.dataset.variant=true; workflows.dataset.error=""; await render(); }
  if (e.target.closest("#dataset-native")) {
    const w=workflows.dataset,stillHere=currentVisit();
    if(!await allowPageReplacement("Discard and use dataset instructions",unapprovedWorkflowLoss(w)) || !stillHere() || workflows.dataset!==w)return;
    workflows.dataset=plannerState("dataset");await render(true);
  }
});
document.addEventListener("input",e=>{
  if (!textInput(e.target)) return;

  if (e.target.form?.id==="dataset-run-form" && (e.target.name==="inputCap" || e.target.name==="outputCap"))
    workflows.dataset[e.target.name]=e.target.value;
});
document.addEventListener("change",e=>{
  if (!textInput(e.target)) return;

  if (e.target.form?.id!=="dataset-run-form") return;
  if (e.target.name==="datasetScorer") { datasetScorerChoices.set(dataset().id,e.target.value); render(); }
  if (e.target.name==="caseJudgeId") workflows.dataset.caseJudgeId=e.target.value;
});
document.addEventListener("submit",async e=>{
  if (!(e.target instanceof HTMLFormElement)) return;

  const f=e.target;
  if (!["planner-fallback","dataset-run-form"].includes(f.id)) return;
  e.preventDefault();
  const btn=dashElement("button[type=submit]",HTMLButtonElement,f) || f.querySelector("button");
  if (!btn || btn.disabled || f.hasAttribute("data-nav-saved") || (f.id==="dataset-run-form" && !canStartDataset())) return;
  const stillHere=currentVisit(), workflow=workflows.dataset;
  btn.disabled=true;
  f.querySelector(":scope > [data-action-error]")?.remove();
  try {
    if (f.id==="planner-fallback") {
      const values={model:formText(f,"model"),key:formText(f,"key"),enabled:requireElement("[name=enabled]",HTMLInputElement,f).checked};
      const unlock=lockNavigationWrite(f);
      try{await api.savePlannerFallback(values);}finally{unlock();}
      consumeSavedForm(f);if(stillHere()){await render();message("Planner preferences saved.");} return;
    }
    const d=dataset();
    workflow.busy="start";
    const ids=selectedModels("dataset");
    const config:UiStartRun={mode:"dataset",datasetId:d.id,candidateIds:ids,graderIds:selectedGraderIds(),animation:!matchMedia("(prefers-reduced-motion: reduce)").matches};
    const scorer=formText(f,"datasetScorer");
    if (scorer) config.datasetScorer=scorer;
    if (config.datasetScorer==="case-judge") { config.datasetScorer="selected-graders"; config.caseJudgeId=formText(f,"caseJudgeId"); }
    for (const key of ["inputCap","outputCap"] as const) {
      const value=formText(f,key);
      if (value) config[key]=Number(value);
    }
    const consent=graderConsentById(config.graderIds,"this dataset run of "+d.count+" cases across "+ids.length+" candidates");
    if(!consent)return;
    const run=await api.start({...config,...consent});
    workflow.error=""; if(stillHere() && workflows.dataset===workflow){baseline="";location.hash="run/"+run;}
  } catch (err) {
    const msg=errorText(err);
    if (f.id==="dataset-run-form") {workflow.busy="";workflow.error=msg;if(stillHere() && workflows.dataset===workflow)await render();}
    else inlineError(f,err);
  } finally {
    if (f.id==="dataset-run-form") workflow.busy="";
    btn.disabled=f.hasAttribute("data-nav-saved");
  }
});
