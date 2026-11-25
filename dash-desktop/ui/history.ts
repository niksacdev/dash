"use strict";
async function runPerformance(id: string, loadedRun?: UiRunDetail): Promise<UiPerformance & {readError?:string}> {
  let readError:string|undefined;
  if (typeof api.performance === "function") {
    try { return await api.performance(id); }
    catch (error) {
      readError=errorText(error);
    }
  } else readError="Reopen DASH to load performance history for this session.";
  const run = loadedRun || await api.detail(id), m = run.manifest;
  const records = run.results.map(r => ({candidate:r.candidateId, error:r.dispatchState ? null : r.error, pass:r.score?.pass,
    review:r.score?.review, latency:r.telemetry?.latency_ms, input:r.telemetry?.input_tokens,
    output:r.telemetry?.output_tokens, watts:r.telemetry?.device_power?.average_w, energy:r.telemetry?.device_power}));
  return {id,readError,packKind:m.pack?.kind, title:m.title,created:m.created,status:run.status,fixture:m.fixture,mode:m.mode,
    datasetId:m.datasetId,version:m.datasetVersion,split:m.split,perCandidate:m.caseIds.length,
    candidates:candidateMetrics(m.candidates,records),history:[]};
}
const runKind = (r: { fixture: boolean | number; mode: string }) => r.fixture ? "Grader test" : r.mode === "quick" ? "Quick compare" : "Live evaluation";
const metricNumber = (n: number) => n.toLocaleString(undefined, {maximumFractionDigits: 1});
interface HistoryChartRow {
  label: string;
  value: number | null;
  note: string;
  display: string;
}
type HistoryUnit = "%" | "s" | "tokens" | "J" | "W";
const measuredNumber = (value:number) => value.toLocaleString(undefined,{maximumSignificantDigits:5});
function chartPanel(title: string, notes: string, rows: HistoryChartRow[], unit:HistoryUnit) {
  const values = rows.map(r => r.value).filter((v): v is number => v !== null && Number.isFinite(v) && v >= 0);
  const scale = unit==="%" ? 100 : Math.max(0,...values) || 1;
  const scaleLabel = values.length ? '<small class="chart-scale">Scale · 0–'+esc(measuredNumber(scale))+(unit==="%"?"":" ")+esc(unit)+'</small>' : "";
  return '<section class="panel metric-chart"><h3>'+esc(title)+'</h3><p>'+esc(notes)+'</p>'+
    rows.map((r,lane) => '<div class="chart-line"><div class="chart-heading"><span>'+esc(r.label)+'</span><strong>'+esc(r.display)+'</strong></div>'+
      comparisonTrack(r.label+' · '+title,r.value,scale,r.display,lane)+
      '<small>'+esc(r.note)+'</small></div>').join("")+scaleLabel+'</section>';
}
function performanceCharts(s: UiPerformance & {readError?:string}) {
  const scored = s.mode === "dataset" && s.packKind !== "reference";
  const cards = [];
  const candidateLabel = (c:UiCandidateMetrics) =>
    s.candidates.some(other=>other.id!==c.id && other.model===c.model) ? c.id : c.model;
  if (scored) {
    for (const [key,title,description] of [
      ["passed","Quality checks passed","Share of scored answers that matched the reference."],
      ["review","Sent for review","Share of scored answers routed to a person."]] as const) {
      cards.push(chartPanel(title,description,s.candidates.map(c=>{
        const value = c.scored ? 100*c[key]/c.scored : null;
        return {label:candidateLabel(c),value,display:value===null?"No scores":metricNumber(value)+"%",
          note:c[key]+" of "+c.scored+" scored"};
      }),"%"));
    }
  }
  if (!s.fixture) {
    cards.push(chartPanel("Response latency","Time per recorded response. A shorter time is faster.",s.candidates.map(c=>({
      label:candidateLabel(c),value:c.p50===null?null:c.p50/1000,display:c.p50===null?"Unmeasured":measuredNumber(c.p50/1000)+" s median",
      note:c.timed && c.p95 !== null ? "95th percentile "+measuredNumber(c.p95/1000)+" s · "+c.timed+" measured" : "No recorded timings"
    })),"s"));
    for (const [field,title,description,count] of [
      ["input","Input tokens","Average prompt tokens per response with reported input usage.","inputCount"],
      ["output","Output tokens","Average generated tokens per response with reported output usage.","outputCount"],
    ] as const) {
      cards.push(chartPanel(title,description,s.candidates.map(c=>{
        const value=c[field];
        return {label:candidateLabel(c),value,display:value===null?"Unreported":measuredNumber(value)+" tokens",note:c[count]+" measured"};
      }),"tokens"));
    }
    if(s.candidates.some(c=>c.energyCount!==undefined)) {
      cards.push(chartPanel("Device energy (est.)","Average joules over sampled intervals per measured case on the device running DASH. Remote server energy is unavailable.",s.candidates.map(c=>({
        label:candidateLabel(c),value:c.energy ?? null,display:c.energy==null?"Unmeasured":measuredNumber(c.energy)+" J",
        note:(c.energyCount ?? 0)+" of "+c.recorded+" recorded cases measured"
      })),"J"));
    }
    cards.push(chartPanel("DASH host power","Mean of the measured case averages on the device running DASH. Hosted inference server power is unavailable.",s.candidates.map(c=>({
      label:candidateLabel(c),value:c.watts,display:c.watts==null?"Unmeasured":measuredNumber(c.watts)+" W",
      note:(c.powerCount || 0)+" measured responses"
    })),"W"));
  }
  return (s.readError?readFailure('Showing metrics from the saved run. Historical comparisons are unavailable.',s.readError,'Refresh performance'):'')+'<div class="metric-grid">'+cards.join("")+'</div>';
}
function historyTrend(s: UiPerformance) {
  const plots = s.candidates.map((c,lane)=>{
    const points = s.history.flatMap(run => {
      const score = run.scores.find(s => s.candidate === c.id);
      return score ? [{ run, passed: score.passed, scored: score.scored }] : [];
    });
    if(points.length<2)return "";
    return '<section class="panel"><h3>'+esc(c.model)+'</h3><div class="trend-points">'+points.map(({run,passed,scored})=>{
      const pct=passed!==null && scored>0 ? 100*passed/scored : null, display=pct===null ? "Unscored" : metricNumber(pct)+"%";
      return '<a href="#run/'+esc(run.id)+'"><strong>'+esc(display)+'</strong>'+
        comparisonTrack(c.model+' · pass rate · '+displayTime(run.created),pct,100,display,lane)+
        '<span>'+esc(displayTime(run.created))+'</span><small>'+(pct===null?'No recorded scores':passed+'/'+scored+' passed')+' · '+esc(run.id.slice(0,6))+'</small></a>';
    }).join("")+'</div></section>';
  }).join("");
  return plots ? bar("Pass rate across runs")+'<p class="muted">Up to eight completed runs through this date using the same dataset snapshot, cases, prompt and grader. Each row follows one candidate.</p>'+plots : "";
}
let historyIndustry="All industries";
const runIndustry=(r: UiRunSummary)=>r.industry || state.datasets.find(d=>d.id===r.datasetId)?.metadata?.industry || "Unclassified";
async function historyPage(key:string|undefined, seq:number) {
  const selector='<label class="field"><span>Industry</span><select id="history-industry">'+industryOptions(historyIndustry,true)+'</select></label>';
  const runs=state.runs.filter(r=>historyIndustry==="All industries" || runIndustry(r)===historyIndustry);
  if(!runs.length)return heading("Workbench","Run history")+selector+'<div class="panel">'+historyList(runs)+'</div>';
  const selectedRun=runs.find(r=>r.id===key) || runs.find(r=>!r.fixture && r.mode==="dataset") || runs[0];
  let saved:UiRunDetail;
  try {saved=await api.detail(selectedRun.id);}
  catch(error){return heading("Workbench","Run history")+selector+readFailure("Couldn’t open the selected run",error,"Retry run details")+bar("Saved runs")+'<div class="panel">'+historyList(runs)+'</div>';}
  const s=await runPerformance(selectedRun.id,saved);
  if (seq!==token) return "";
  current=saved;
  const report = saved.report;
  s.packKind=saved.manifest.pack?.kind;
  const ds=state.datasets.find(d=>d.id===s.datasetId);
  const records=saved.results.length;
  const unconfirmed=saved.results.filter(row=>row.dispatchState).length;
  const errors=saved.results.filter(row=>row.error && !row.dispatchState).length;
  return heading("Workbench","Run history")+selector+
    '<section class="panel"><label class="field"><span>Run to inspect</span><select id="history-run">'+runs.map(r=>
      opt(r.id,r.title+" · "+runKind(r)+" · "+displayTime(r.created)+" · "+r.id.slice(0,6),s.id)).join("")+'</select></label>'+
    '<div class="bar"><div class="row">'+tag(runKind(s))+(s.mode==="quick" && !selectedRun.industry ? "" : tag(runIndustry(selectedRun)))+tag(saved.status, true)+(ds?tag((ds.metadata?.family || ds.name)+" · "+s.version+" · "+s.split):"")+'</div>'+
    link("Open run details →","run/"+s.id,"link")+'</div>'+
    '<p>'+records+' of '+(s.perCandidate*s.candidates.length)+' cases recorded'+
      (unconfirmed?' · '+unconfirmed+' without a confirmed final response':'')+
      ' · '+errors+' runtime '+(errors===1?"error":"errors")+'</p>'+
    (s.fixture?'<small>Saved answers exercise the grader. Timing and token usage apply to live model runs.</small>':'')+'</section>'+
    (saved.status==="running" || saved.status==="queued" ? "" : responseComparison(saved))+
    bar("Performance")+sharedPowerMeasurement(saved.manifest,saved.status==="running" || saved.status==="queued")+performanceCharts(s)+
    (report && !s.fixture ? '<section class="panel history-report"><h3>Evaluation result</h3><p>'+esc(report.summary)+'</p>'+
      reportMetricGroups(report.metrics.map((metric,index)=>({metric,index})),report,s.id,true)+'</section>':'')+
    (isReportChallenge(saved)?reportRecovery(saved):"")+(await opikExperimentPanel(saved))+historyTrend(s)+bar("Saved runs")+'<div class="panel">'+historyList(runs)+'</div>';
}

document.addEventListener("change", e=>{if(e.target instanceof HTMLSelectElement && e.target.id==="history-industry"){historyIndustry=e.target.value; render();}});
