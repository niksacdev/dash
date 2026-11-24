"use strict";

const planningMoney = new Intl.NumberFormat("en-US", {style:"currency", currency:"USD", maximumSignificantDigits:4});
const planningOutcome = {running:"Working",succeeded:"Completed",failed:"Failed",canceled:"Canceled"} as const;

function planningSeconds(ms:number) {
  return (ms/1000).toFixed(1) + " s";
}
// A mounted running receipt owns its clock. Navigation and terminal updates remove it.
customElements.define("dash-planning-elapsed", class extends HTMLElement {
  private clock?:number;
  connectedCallback() {
    const start=Number(this.dataset.started);
    if(!Number.isFinite(start))return;
    const tick=()=>{this.textContent=planningSeconds(Math.max(0,Date.now()-start));};
    tick();this.clock=window.setInterval(tick,1000);
  }
  disconnectedCallback(){window.clearInterval(this.clock);}
});
function planningClock(start:number|undefined) {
  return typeof start==="number" && Number.isFinite(start) ? '<dash-planning-elapsed data-started="'+esc(start)+'"></dash-planning-elapsed>' : "";
}
function planningQueryRow(call:UiPlanningAttempt) {
  const running = call.status === "running";
  const local = call.provider === "lmstudio" || call.provider === "ollama";
  const location = local ? "Local" : call.provider === "openai" ? "Hosted" : "";
  const pending = running ? "Pending" : "Unreported";
  const input = call.usage?.inputTokens;
  const output = call.usage?.outputTokens;
  const usd = call.usage?.estimatedCostUsd;
  const cost = local ? "No API charge" : typeof usd === "number" ? planningMoney.format(usd) + " est." : pending;
  const model = call.revision && call.provider === "openai" ? call.revision : call.model;
  const phase=call.progress?.phase==="processing-prompt" ? "Reading prompt · "+call.progress.percent+"%" :
    call.progress?.phase==="generating" ? "Generating" : planningOutcome[call.status];
  const elapsed=running ? planningClock(call.startedAt) : call.elapsedMs!=null ? planningSeconds(call.elapsedMs) : "";
  const liveOutput=running && call.progress?.phase==="generating" ? "≈"+call.progress.approximateOutputTokens.toLocaleString() : pending;
  return '<div class="ai-query" data-status="'+esc(call.status)+'"><div class="ai-query-head">' +
    (running ? '<span class="ai-pulse" aria-hidden="true"><i></i><i></i><i></i></span>' : '') +
    '<strong>'+esc(call.stage)+'</strong><span class="ai-model">'+esc([location,model].filter(Boolean).join(" · "))+'</span>' +
    '<small>'+esc(phase || call.status)+(call.attempt && call.attempt>1 ? ' · Try '+esc(call.attempt) : '')+'</small></div>' +
    '<dl class="ai-usage"><div><dt>Input tokens</dt><dd>'+esc(input?.toLocaleString() ?? pending)+'</dd></div>' +
    '<div><dt>Output tokens</dt><dd>'+esc(output?.toLocaleString() ?? liveOutput)+'</dd></div>' +
    '<div><dt>API cost</dt><dd>'+esc(cost)+'</dd></div>'+
    (elapsed?'<div><dt>Elapsed</dt><dd>'+elapsed+'</dd></div>':'')+
    (call.firstTokenMs!=null?'<div><dt>First token</dt><dd>'+esc(planningSeconds(call.firstTokenMs))+'</dd></div>':'')+
    (call.tokensPerSecond!=null?'<div><dt>Generation rate</dt><dd>'+esc(call.tokensPerSecond.toFixed(1))+' tok/s</dd></div>':'')+
    (call.discoveryMs!=null?'<div><dt>Runtime lookup</dt><dd>'+esc(planningSeconds(call.discoveryMs))+'</dd></div>':'')+'</dl>' +
    (call.reason ? '<small>'+esc(call.reason)+'</small>' : '')+'</div>';
}
function planningActivityBody(w:Pick<UiWorkflow,"activity"|"busy">,pendingLabel="Finding a planning model…") {
  const calls = w.activity?.calls || [];
  const latest = calls.at(-1);
  if (!latest) return w.busy ? '<span class="wf-hint">'+esc(pendingLabel)+' '+planningClock(w.activity?.startedAt)+'</span>' : "";
  return planningQueryRow(latest) + (calls.length > 1 ? '<details class="ai-earlier"><summary>Earlier queries ('+(calls.length-1)+
    ')</summary>'+calls.slice(0,-1).map(planningQueryRow).join("")+'</details>' : '');
}
function planningActivity(w:UiWorkflow) {
  if (!w.activity || (!w.busy && !w.activity.calls.length)) return "";
  const busy = w.busy === "suggest" || w.busy === "design";
  return '<section id="wf-activity" aria-label="AI planning activity"><div id="wf-progress" role="status" aria-atomic="true" class="visually-hidden">'+
    esc(w.activity.calls.at(-1)?.stage || "Finding a planning model")+'</div><div id="wf-query">'+planningActivityBody(w)+'</div>'+
    (busy ? '<button id="wf-cancel-design" type="button">Cancel preparation</button>' : '')+'</section>';
}
