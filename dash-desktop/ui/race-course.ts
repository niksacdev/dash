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

function raceCourse(label:string, options:RaceCourseOptions) {
  const {state, reading} = options;
  const measured = reading && Number.isFinite(reading.value) && Number.isFinite(reading.max) &&
    reading.max > 0 && reading.value >= 0 && reading.value <= reading.max ? reading : undefined;
  const role = measured && options.kind === "measurement" ? "meter" : measured || state === "active" ? "progressbar" : "img";
  const value = measured ? ' aria-valuemin="0" aria-valuemax="'+measured.max+'" aria-valuenow="'+measured.value+'"' : "";
  let graphic = "";
  if (measured) {
    const end = (100 * (measured.value / measured.max)) + "%";
    graphic = '<div class="timing-scale" aria-hidden="true"><svg focusable="false">'+
      '<line class="timing-axis" x1="0" y1="50%" x2="100%" y2="50%"/>'+
      [0,25,50,75,100].map(tick => '<line class="timing-ticks" x1="'+tick+'%" x2="'+tick+'%" y1="34%" y2="66%"/>').join("")+
      '<line class="timing-range" x1="0" x2="'+end+'" y1="50%" y2="50%"/>'+
      '<line class="timing-marker" x1="'+end+'" x2="'+end+'" y1="17%" y2="83%"/></svg></div>';
  } else if (state === "active") {
    graphic = '<span class="timing-feed" aria-hidden="true"><i class="timing-signal"></i></span>';
  }
  return '<div class="race-course" role="'+role+'" aria-label="'+esc(label)+'"'+value+
    (options.valueText && role !== "img" ? ' aria-valuetext="'+esc(options.valueText)+'"' : '')+
    ' data-state="'+state+'" data-color="'+(options.color || "red")+'">'+graphic+'</div>';
}

function receivedCandidateOutput(text:string|undefined,usage:CandidateUsage|undefined) {
  return !!text || usage?.firstTokenMs!=null || (usage?.approximateOutputTokens ?? 0)>0 || (usage?.outputTokens ?? 0)>0;
}

// Live token events update the existing lane without rebuilding either candidate's view.
function showGenerating(candidateId:string) {
  const lane = document.querySelector<HTMLElement>('[data-racer="'+CSS.escape(candidateId)+'"][data-state="active"]');
  if (!lane || lane.closest("[data-stale]")) return;
  if (lane.hasAttribute("data-awaiting-output")) {
    delete lane.dataset.awaitingOutput;
    const status = lane.querySelector(".candidate-race-state span");
    if (status) status.textContent = "Generating";
    const road = lane.querySelector(".race-course");
    road?.setAttribute("aria-label",(lane.querySelector("strong")?.textContent || candidateId)+" · Generating");
    if (!road?.hasAttribute("aria-valuenow")) road?.setAttribute("aria-valuetext","Generating");
  }
  const signal = lane.querySelector(".timing-signal");
  if (signal && !matchMedia("(prefers-reduced-motion: reduce)").matches && !signal.getAnimations().length) {
    signal.animate([{translate:"0"}, {translate:"16px",offset:.8}, {translate:"16px",opacity:0}], {duration:280,easing:"ease-out"});
  }
}
function candidateRace(run:UiRunDetail) {
  const {manifest}=run;
  const partials=activeRunPartials(run);
  const total=manifest.caseIds.length;
  const live=run.status==="queued" || run.status==="running";
  const colors:RaceColor[]=["red","cyan","gold"];
  return '<div class="candidate-race">'+manifest.candidates.map((candidate,index)=>{
    const saved=run.results.filter(row=>row.candidateId===candidate.id && row.dispatchState!=="pending");
    const errors=saved.filter(row=>row.error || row.dispatchState).length;
    const partial=partials.find(part=>part.candidateId===candidate.id);
    const active=live && !!partial;
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
    const start=partial?.grading?.startedAt ?? partial?.startedAt;
    const clock=state==="active" && start ? planningClock(Date.parse(start)) : "";
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
      (clock?'<small>'+esc(partial?.grading?"Grading":"Request")+' · '+clock+'</small>':'')+
      (manifest.mode==="dataset" && count ? '<small>'+esc(count)+'</small>' : '')+'</div></div>';
  }).join("")+'</div>';
}
