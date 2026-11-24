"use strict";

interface IndustryTestAttempt {input:UiDatasetCaseTest; result:Promise<UiAssessment>; pending:boolean}
// Retain at most one submitted case while saving or recovering from a failed save.
let industryTestAttempt:IndustryTestAttempt|null=null;

function industryCaseEvidence(row:UiCase,pack:UiPack){
  return '<details><summary>Case input and required JSON format</summary><p>'+esc(pack.system)+'</p>'+
    '<pre>'+pretty(row.input ?? row.messages ?? row.prompt)+'</pre>'+(row.source_locator!=null?box("Source locator",row.source_locator):"")+
    box("Required response format",pack.outputSchema)+'</details>';
}

async function openIndustryTest(button:HTMLButtonElement,host:HTMLElement,grader:UiGrader) {
  const target=$(".gc-target",host);
  const previous=target.querySelector<HTMLFormElement>("[data-industry-test-form]");
  if(previous && !target.hidden){
    previous.focus();return;
  }
  // A pending run-setup read for this card must not replace the case test.
  ++graderActionSequence;
  const form=document.createElement("form");
  form.dataset.industryTestForm="";form.tabIndex=-1;form.className="wf-options";
  form.setAttribute("aria-label","Test "+grader.name+" v"+grader.version);
  form.innerHTML='<h4>'+esc(grader.name)+' <small>v'+esc(grader.version)+'</small></h4>'+
    '<p>Score an existing answer against one labeled case.</p>'+
    '<fieldset><legend class="visually-hidden">Case to test</legend>'+
    formField("Dataset snapshot",'<select name="snapshot" required disabled></select>')+
    formField("Dataset case",'<select name="caseId" required disabled></select>')+
    '<div data-case-source></div>'+
    formField("Model or agent output",'<textarea name="output" required rows="4" maxlength="100000" placeholder="Paste the response JSON"></textarea>')+
    '<div class="gc-actions"><button type="submit" disabled>Score this output</button>'+
    '<button type="button" class="gc-secondary" data-close-test>Close test</button></div></fieldset>'+
    '<div data-case-result role="status" aria-live="polite"></div>';
  target.hidden=false;target.replaceChildren(form);form.focus();
  const sameVisit=currentVisit();
  const present=()=>sameVisit() && form.isConnected && !target.hidden;
  const snapshots=requireElement("[name=snapshot]",HTMLSelectElement,form);
  const cases=requireElement("[name=caseId]",HTMLSelectElement,form);
  const output=requireElement("[name=output]",HTMLTextAreaElement,form);
  const fields=requireElement("fieldset",HTMLFieldSetElement,form);
  const score=requireElement("[type=submit]",HTMLButtonElement,form);
  const source=$("[data-case-source]",form),result=$("[data-case-result]",form);
  let detail:UiDatasetDetail|null=null,readSequence=0,alreadyScored=false;
  const currentRow=()=>detail?.rows.find(row=>row.case_id===cases.value);
  const ready=()=>{score.disabled=fields.disabled || alreadyScored || !currentRow() || !output.value.trim();};
  const resetResult=()=>{alreadyScored=false;result.replaceChildren();ready();};
  function chooseCase(){
    const row=currentRow(),pack=state.packs.find(p=>p.id===detail?.pack);
    source.innerHTML=row && pack ? industryCaseEvidence(row,pack) : "";
    resetResult();
  }
  async function loadCases(preferred=""){
    const request=++readSequence,id=snapshots.value;
    detail=null;cases.replaceChildren();cases.disabled=true;source.replaceChildren();resetResult();
    if(!id)return;
    result.textContent="Reading dataset cases…";
    try{
      const dataset=await api.dataset(id);
      if(!present() || request!==readSequence)return;
      detail=dataset;
      const selected=preferred || (dataset.rows.length===1 ? dataset.rows[0].case_id : "");
      cases.innerHTML=opt("","Choose a case",selected)+dataset.rows.map(row=>opt(row.case_id,row.case_id,selected)).join("");
      cases.disabled=!dataset.rows.length;
      chooseCase();
      if(cases.disabled)result.textContent="This snapshot contains no cases. Choose another snapshot.";
    }catch(error){
      if(present() && request===readSequence){
        result.textContent=errorText(error);
        const retry=document.createElement("button");retry.type="button";retry.textContent="Retry reading cases";
        retry.onclick=()=>{void loadCases(preferred);};result.append(" ",retry);
      }
    }
  }
  async function showAssessment(attempt:IndustryTestAttempt) {
    fields.disabled=true;score.disabled=true;form.setAttribute("aria-busy","true");result.textContent="Scoring the supplied answer…";
    try{
      const saved=await attempt.result;
      if(industryTestAttempt===attempt)industryTestAttempt=null;
      if(!present())return;
      const evidence=saved.datasetCase;
      const verdict=saved.pass==null?"Unscored":saved.pass?"Passed":"Failed";
      result.innerHTML='<strong>'+esc(verdict)+(saved.value==null?"":" · "+esc(metricNumber(saved.value)))+'</strong>'+
        '<p>'+esc(saved.reason)+'</p><small>'+esc([saved.name+" v"+saved.version,evidence && evidence.datasetName,evidence && evidence.datasetVersion,evidence?.caseId ?? attempt.input.caseId].filter(Boolean).join(" · "))+'</small>';
      alreadyScored=true;
      void refreshSampleHistory();
    }catch(error){if(present())result.textContent=errorText(error);}
    finally{attempt.pending=false;fields.disabled=false;form.removeAttribute("aria-busy");ready();}
  }
  snapshots.onchange=()=>{void loadCases();};cases.onchange=chooseCase;output.oninput=resetResult;
  $("[data-close-test]",form).onclick=async()=>{
    if(!await allowPageReplacement("Discard answer and close","",form) || !present())return;
    if(industryTestAttempt?.input.grader===grader.id && !industryTestAttempt.pending)industryTestAttempt=null;
    target.replaceChildren();target.hidden=true;button.focus();
  };
  form.onsubmit=e=>{
    e.preventDefault();if(score.disabled || !form.reportValidity())return;
    if(industryTestAttempt?.pending){result.textContent="A case test is being saved. Try again when it finishes.";return;}
    const input={grader:grader.id,datasetId:snapshots.value,caseId:cases.value,output:output.value};
    forgetNavigationEdits(form);
    industryTestAttempt={input,result:api.assess(input),pending:true};void showAssessment(industryTestAttempt);
  };
  result.textContent="Finding compatible snapshots…";
  try{
    const ids=new Set(await api.graderDatasetIds(grader.id));
    if(!present())return;
    const available=state.datasets.filter(d=>ids.has(d.id));
    const prior=industryTestAttempt?.input.grader===grader.id ? industryTestAttempt : null;
    const preferred=prior?.input.datasetId || host.dataset.sourceDataset;
    const selected=available.find(d=>d.id===preferred) || (available.length===1 ? available[0] : null);
    snapshots.innerHTML=opt("","Choose a snapshot",selected?.id)+available.map(d=>opt(d.id,snapshotLabel(d),selected?.id)).join("");
    snapshots.disabled=!available.length;
    if(!available.length){
      result.innerHTML='No compatible labeled snapshot is available. '+link("Browse datasets","datasets","link");return;
    }
    await loadCases(prior?.input.caseId);
    if(!present())return;
    if(prior && currentRow()?.case_id===prior.input.caseId && snapshots.value===prior.input.datasetId){
      output.value=prior.input.output;await showAssessment(prior);
    }
  }catch(error){
    if(present()){
      result.textContent=errorText(error);
      const retry=document.createElement("button");retry.type="button";retry.textContent="Retry finding snapshots";
      retry.onclick=()=>{target.replaceChildren();void openIndustryTest(button,host,grader);};result.append(" ",retry);
    }
  }
}

document.addEventListener("click",e=>{
  if(!(e.target instanceof Element))return;
  const button=e.target.closest<HTMLButtonElement>("[data-industry-test]");
  const host=button?.closest<HTMLElement>("[data-use-version]");
  const grader=host && state.graders.find(g=>g.id===host.dataset.useVersion);
  if(button && host && grader)void openIndustryTest(button,host,grader);
});
