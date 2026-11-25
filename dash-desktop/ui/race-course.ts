"use strict";

type RaceState = "queued" | "active" | "waiting" | "finished" | "error" | "stopped";
type RaceColor = "red" | "cyan" | "gold";
interface RaceReading { value:number; max:number }
interface RaceCourseOptions {
  state:RaceState;
  reading?:RaceReading;
  valueText?:string;
  color?:RaceColor;
  kind?:"measurement";
}

// Align each CSS loop with the document clock when a streaming receipt repaints.
customElements.define("dash-race-course", class extends HTMLElement {
  connectedCallback() {
    if (this.dataset.state==="active") this.style.setProperty("--race-delay",(-performance.now()/1000)+"s");
  }
});

function raceCourse(label:string,options:RaceCourseOptions) {
  const {state,reading}=options;
  const known=reading && Number.isFinite(reading.value) && Number.isFinite(reading.max) &&
    reading.max>0 && reading.value>=0 && reading.value<=reading.max ? reading : undefined;
  const position=known ? 100*known.value/known.max : state==="active" ? 32 : 0;
  const value=known ? ' aria-valuemin="0" aria-valuemax="'+known.max+'" aria-valuenow="'+known.value+'"' : '';
  const role=known && options.kind==="measurement" ? 'meter' : known || state==="active" ? 'progressbar' : 'img';
  return '<dash-race-course class="race-course" role="'+role+'" aria-label="'+esc(label)+'"'+value+
    (options.valueText && role!=="img" ? ' aria-valuetext="'+esc(options.valueText)+'"' : '')+
    ' data-state="'+state+'" data-color="'+(options.color || "red")+'"><span class="race-asphalt" aria-hidden="true"></span>'+
    '<svg class="race-field" height="26" width="100%" aria-hidden="true" focusable="false">'+
    '<svg x="'+position+'%" width="42" height="100%" overflow="visible" viewBox="0 0 42 26" preserveAspectRatio="xMinYMid meet"><g transform="translate(-21 0)">'+
    (state==="active" ? '<g class="race-plume" fill="currentColor"><ellipse class="race-wisp" cx="5" cy="10" rx="6" ry="2.7"/>'+
    '<ellipse class="race-wisp" cx="5" cy="16" rx="5" ry="2.3"/></g>' : '')+
    '<use class="race-driver" href="#car" width="42" height="26"/></g></svg></svg></dash-race-course>';
}

function receivedCandidateOutput(text:string|undefined,usage:CandidateUsage|undefined) {
  return !!text || usage?.firstTokenMs!=null || (usage?.approximateOutputTokens ?? 0)>0 || (usage?.outputTokens ?? 0)>0;
}

// Live token events update the existing lane without rebuilding either candidate's view.
function showGenerating(candidateId:string) {
  const lane=document.querySelector<HTMLElement>('[data-racer="'+CSS.escape(candidateId)+'"][data-awaiting-output]');
  if (!lane) return;
  delete lane.dataset.awaitingOutput;
  const status=lane.querySelector(".candidate-race-state span");
  if (status) status.textContent="Generating";
  const road=lane.querySelector(".race-course");
  road?.setAttribute("aria-label",(lane.querySelector("strong")?.textContent || candidateId)+" · Generating");
  if (!road?.hasAttribute("aria-valuenow")) road?.setAttribute("aria-valuetext","Generating");
}
function candidateRace(run:UiRunDetail) {
  const {manifest,partial}=run;
  const total=manifest.caseIds.length;
  const live=run.status==="queued" || run.status==="running";
  const colors:RaceColor[]=["red","cyan","gold"];
  return '<div class="candidate-race">'+manifest.candidates.map((candidate,index)=>{
    const saved=run.results.filter(row=>row.candidateId===candidate.id && row.dispatchState!=="pending");
    const errors=saved.filter(row=>row.error || row.dispatchState).length;
    const active=live && partial?.candidateId===candidate.id && !partial.stage;
    const recorded=active && saved.some(row=>row.caseId===partial?.caseId);
    const receivedText=receivedCandidateOutput(partial?.text,partial?.usage);
    let state:RaceState="queued";
    let status="Queued";
    if (active && partial.grading) {
      state="active"; status="Scoring · "+partial.grading.name+" v"+partial.grading.version;
    } else if (active && !recorded) {
      state="active"; status=manifest.fixture ? "Reading saved answer" : receivedText ? "Generating" : "Waiting for response";
    } else if (errors) {
      state="error"; status=errors===1 ? "1 interrupted or failed case" : errors+" interrupted or failed cases";
    } else if (total>0 && saved.length===total) {
      state="finished"; status=total===1 ? "Response saved" : "Cases recorded";
    } else if (!live) {
      state="stopped"; status="Stopped";
    } else if (saved.length>0) {
      state="waiting"; status="Between cases";
    }
    const name=displayModel(candidate.model);
    const count=total>0 ? saved.length+" / "+total+(total===1 ? " case" : " cases")+" recorded" : "";
    // A case count measures the dataset, never the fraction of the current answer generated.
    const reading=total>0 && (manifest.mode==="dataset" || state==="finished" || state==="error") ?
      {value:saved.length,max:total} : undefined;
    return '<div class="candidate-race-lane" data-racer="'+esc(candidate.id)+'" data-state="'+state+'"'+
      (status==="Waiting for response" ? " data-awaiting-output" : "")+'>'+
      '<div class="candidate-race-label"><strong title="'+esc(candidate.model)+'">'+esc(name)+'</strong><small>'+esc(candidate.provider==="lmstudio" ? "LM Studio" : candidate.provider==="ollama" ? "Ollama" : candidate.provider)+'</small></div>'+
      raceCourse(name+" · "+status,{state,reading,color:colors[index%colors.length],kind:!live ? "measurement" : undefined,valueText:reading ? count : status})+
      '<div class="candidate-race-state"><span>'+esc(status)+'</span>'+
      (manifest.mode==="dataset" && count ? '<small>'+esc(count)+'</small>' : '')+'</div></div>';
  }).join("")+'</div>';
}
