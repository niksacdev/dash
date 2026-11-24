"use strict";

const syncingOpik = new Set<string>();
const opikWarnings = new Map<string,string>();
async function opikExperimentPanel(saved: UiRunDetail) {
  const id=saved.manifest.id, read=api.opikExperimentStatus;
  let state:UiOpikStatus;
  try {
    if(typeof read!=="function")throw Error("Reopen DASH to reconnect the Opik experiment service.");
    state=await read(id);
  } catch(error) {
    return readFailure("Opik sync status unavailable. This run is saved in DASH.",error,"Check sync status");
  }
  if (!state.configured) return '<section class="panel"><h3>Opik experiments</h3><p>'+esc(state.error || "Start local Opik with npm run setup:local, then reopen DASH. You can sync a saved run to the local dashboard when you choose.")+'</p></section>';
  const running=syncingOpik.has(id) || state.active;
  const finished=["completed","failed","canceled","interrupted"].includes(saved.status);
  const receipt = state.state === "synced" ? state.receipt : null;
  if(receipt)opikWarnings.delete(id);
  const warning = (state.state === "partial" && state.receipt?.error) || opikWarnings.get(id);
  return '<section class="panel" aria-label="Opik experiments"><h3>Opik experiments</h3><p>'+esc(state.workspace)+' / '+esc(state.project)+' · '+esc(state.apiUrl)+'</p>'+
    (state.state==="synced" && receipt ? '<p>Synced '+esc(receipt.caseCount)+' dataset cases · dataset '+esc(receipt.datasetName)+' · '+esc(receipt.version || receipt.versionId)+'</p>'+
      (receipt.promptVersion?'<p>Approved prompt · '+esc(receipt.promptVersion.name)+' · '+esc(receipt.promptVersion.version || receipt.promptVersion.commit || receipt.promptVersion.id)+'</p>':saved.manifest.approvedPromptId?'<p>This earlier sync did not link a native prompt version.</p>':'')+
      receipt.experiments.map(e=>'<div class="listrow"><div><strong>'+esc(e.candidate)+'</strong><small>'+esc(e.id)+'</small></div><span>'+esc(e.traces)+' traces · '+esc(e.scores)+' scores</span></div>').join("") :
    '<p>Sync sends the complete saved dataset snapshot, including case references and SME guidance. It sends candidate inputs, outputs, timing, token usage and scores for this run’s evaluated cases.'+(saved.manifest.approvedPromptId?' The approved candidate-visible prompt is saved in the Opik prompt registry and linked to the experiments.':'')+'</p><button type="button" data-opik-sync="'+esc(id)+'" '+(!finished||running?'disabled':'')+'>'+
    (running?'Syncing…':state.state==="partial"||state.state==="syncing"?'Resume saved run sync':'Sync saved run to Opik')+'</button>')+
    (state.active && !syncingOpik.has(id)?' <button type="button" data-act="retry-read">Check sync status</button>':'')+
    (state.hasDashboard?' <button type="button" data-opik-dashboard>Open Opik dashboard ↗</button>':'')+
    (warning?'<p role="alert">'+esc(warning)+'</p>':'')+'</section>';
}
document.addEventListener("click",async event=>{
  if (!(event.target instanceof Element)) return;
  const button=event.target.closest<HTMLButtonElement>("[data-opik-sync],[data-opik-dashboard]");
  if(!button)return;
  const id=button.dataset.opikSync;
  if(!id){
    const parent=button.closest("section");
    button.disabled=true;
    try{await api.openOpikDashboard();parent?.querySelector("[data-action-error]")?.remove();}
    catch(error){if(parent)inlineError(parent,error);}
    finally{button.disabled=false;}
    return;
  }
  if(syncingOpik.has(id))return;
  syncingOpik.add(id);opikWarnings.delete(id);button.disabled=true;button.textContent="Syncing…";
  try{await api.syncOpikExperiment(id);}catch(error){opikWarnings.set(id,errorText(error));}
  finally{syncingOpik.delete(id);if(trail()[0]==="history" && document.querySelector<HTMLButtonElement>("[data-opik-sync]")?.dataset.opikSync===id)await render();}
});
