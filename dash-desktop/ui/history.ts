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
    output:r.telemetry?.output_tokens, watts:r.telemetry?.device_power?.average_w}));
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
function chartPanel(title: string, notes: string, rows: HistoryChartRow[], maximum?: number) {
  const values = rows.map(r => r.value).filter((v): v is number => v !== null && Number.isFinite(v));
  const scale = maximum ?? Math.max(1, ...values);
  return '<section class="panel metric-chart"><h3>'+esc(title)+'</h3><p>'+esc(notes)+'</p>'+
    rows.map(r => '<div class="chart-line"><div><span>'+esc(r.label)+'</span><strong>'+esc(r.display)+'</strong></div>'+
      (Number.isFinite(r.value) ? '<progress aria-label="'+esc(r.label+' · '+title)+'" value="'+r.value+'" max="'+scale+'"></progress>' : '')+
      '<small>'+esc(r.note)+'</small></div>').join("")+'</section>';
}
function performanceCharts(s: UiPerformance & {readError?:string}) {
  const scored = s.mode === "dataset" && s.packKind !== "reference";
  const cards = [];
  if (scored) {
    for (const [key,title,description] of [
      ["passed","Quality checks passed","Share of scored answers that matched the reference."],
      ["review","Sent for review","Share of scored answers routed to a person."]] as const) {
      cards.push(chartPanel(title,description,s.candidates.map(c=>{
        const value = c.scored ? 100*c[key]/c.scored : null;
        return {label:c.model,value,display:value===null?"No scores":metricNumber(value)+"%",
          note:c[key]+" of "+c.scored+" scored"};
      }),100));
    }
  }
  if (!s.fixture) {
    cards.push(chartPanel("Response latency","End-to-end time per recorded response.",s.candidates.map(c=>({
      label:c.model,value:c.p50,display:c.p50===null?"Unmeasured":metricNumber(c.p50/1000)+" s median",
      note:c.timed && c.p95 !== null ? "95th percentile "+metricNumber(c.p95/1000)+" s · "+c.timed+" measured" : "No recorded timings"
    }))));
    cards.push(chartPanel("Output tokens","Average generated tokens per response with provider usage.",s.candidates.map(c=>({
      label:c.model,value:c.output,display:c.output===null?"Unmeasured":metricNumber(c.output)+" tokens",
      note:c.outputCount+" measured"+(c.input===null?"":" · "+metricNumber(c.input)+" mean input tokens ("+c.inputCount+" measured)")
    }))));
    cards.push(chartPanel("DASH host power","Mean of the measured case averages on the device running DASH. Hosted inference server power is unavailable.",s.candidates.map(c=>({
      label:c.model,value:c.watts,display:c.watts==null?"Unmeasured":metricNumber(c.watts)+" W",
      note:(c.powerCount || 0)+" measured responses"
    }))));
  }
  return (s.readError?readFailure('Showing metrics from the saved run. Historical comparisons are unavailable.',s.readError,'Refresh performance'):'')+'<div class="metric-grid">'+cards.join("")+'</div>';
}
function historyTrend(s: UiPerformance) {
  const plots = s.candidates.map(c=>{
    const points = s.history.flatMap(run => {
      const score = run.scores.find(s => s.candidate === c.id && s.scored > 0);
      return score && score.passed !== null ? [{ run, passed: score.passed, scored: score.scored }] : [];
    });
    if(points.length<2)return "";
    return '<section class="panel"><h3>'+esc(c.model)+'</h3><div class="trend-points">'+points.map(({run,passed,scored})=>{
      const pct=100*passed/scored;
      return '<a href="#run/'+esc(run.id)+'"><strong>'+metricNumber(pct)+'%</strong><progress aria-label="Pass rate" value="'+pct+'" max="100"></progress>'+
        '<span>'+esc(displayTime(run.created))+'</span><small>'+passed+'/'+scored+' passed · '+esc(run.id.slice(0,6))+'</small></a>';
    }).join("")+'</div></section>';
  }).join("");
  return plots ? bar("Pass rate across runs")+'<p class="muted">Up to eight completed runs through this date using the same dataset snapshot, cases, prompt and grader. Each row follows one candidate.</p>'+plots : "";
}
let historyIndustry="All industries";
const runIndustry=(r: UiRunSummary)=>r.industry || state.datasets.find(d=>d.id===r.datasetId)?.metadata?.industry || "Unclassified";
async function historyPage(key?: string) {
  const selector='<label class="field"><span>Industry</span><select id="history-industry">'+industryOptions(historyIndustry,true)+'</select></label>';
  const runs=state.runs.filter(r=>historyIndustry==="All industries" || runIndustry(r)===historyIndustry);
  if(!runs.length)return heading("Workbench","Run history")+selector+'<div class="panel">'+historyList(runs)+'</div>';
  const selectedRun=runs.find(r=>r.id===key) || runs.find(r=>!r.fixture && r.mode==="dataset") || runs[0];
  let saved:UiRunDetail;
  try {saved=await api.detail(selectedRun.id);}
  catch(error){return heading("Workbench","Run history")+selector+readFailure("Couldn’t open the selected run",error,"Retry run details")+bar("Saved runs")+'<div class="panel">'+historyList(runs)+'</div>';}
  const s=await runPerformance(selectedRun.id,saved);
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
    (report && !s.fixture ? '<section class="panel"><h3>Evaluation result</h3><p>'+esc(report.summary)+'</p>'+
      report.metrics.map(m=>'<div class="listrow"><strong>'+esc(m.label)+'</strong><span>'+m.values.map(v=>{
        const model=report.candidates.find(c=>c.id===v.candidateId);
        return esc((model?.label || v.candidateId)+' '+scorePercent(v.score));
      }).join(' · ')+'</span></div>').join('')+'</section>':'')+
    (await opikExperimentPanel(saved))+bar("Performance")+performanceCharts(s)+historyTrend(s)+bar("Saved runs")+'<div class="panel">'+historyList(runs)+'</div>';
}

document.addEventListener("change", e=>{if(e.target instanceof HTMLSelectElement && e.target.id==="history-industry"){historyIndustry=e.target.value; render();}});
