"use strict";

const syncingOpik = new Set();
const opikWarnings = new Map();
async function opikExperimentPanel(saved) {
  const id=saved.manifest.id, read=api.opikExperimentStatus;
  if (!read) return "";
  const state=await read(id);
  if (!state.configured) return '<section class="panel"><h3>Opik experiments</h3><p>'+esc(state.error || "Sync is off. Set DASH_OPIK_API_URL and reopen DASH to connect your Opik workspace.")+'</p></section>';
  const running=syncingOpik.has(id) || state.active;
  const finished=["completed","failed","canceled","interrupted"].includes(saved.status);
  const receipt=state.receipt;
  return '<section class="panel" aria-label="Opik experiments"><h3>Opik experiments</h3><p>'+esc(state.workspace)+' / '+esc(state.project)+' · '+esc(state.apiUrl)+'</p>'+
    (state.state==="synced" && receipt ? '<p>Synced '+esc(receipt.caseCount)+' cases · dataset '+esc(receipt.datasetName)+' · '+esc(receipt.version || receipt.versionId)+'</p>'+
      receipt.experiments.map(e=>'<div class="listrow"><div><strong>'+esc(e.candidate)+'</strong><small>'+esc(e.id)+'</small></div><span>'+esc(e.traces)+' traces · '+esc(e.scores)+' scores</span></div>').join("") :
    '<p>Sync sends this run’s cases, reference answers and SME guidance, candidate inputs and outputs, trace timing, token usage and recorded scores to this destination.</p><button type="button" data-opik-sync="'+esc(id)+'" '+(!finished||running?'disabled':'')+'>'+
    (running?'Syncing…':state.state==="partial"||state.state==="syncing"?'Resume saved run sync':'Sync saved run to Opik')+'</button>')+
    (state.hasDashboard?' <button type="button" data-opik-dashboard>Open Opik dashboard ↗</button>':'')+
    (opikWarnings.has(id)||receipt?.error?'<p role="alert">'+esc(opikWarnings.get(id)||receipt.error)+'</p>':'')+'</section>';
}
document.addEventListener("click",async event=>{
  const button=event.target.closest("[data-opik-sync],[data-opik-dashboard]");
  if(!button)return;
  const id=button.dataset.opikSync;
  if(!id){
    try{await api.openOpikDashboard();}
    catch{button.textContent="Could not open the configured dashboard";}
    return;
  }
  if(syncingOpik.has(id))return;
  syncingOpik.add(id);opikWarnings.delete(id);button.disabled=true;button.textContent="Syncing…";
  try{await api.syncOpikExperiment(id);}catch(error){opikWarnings.set(id,error.message);}
  finally{syncingOpik.delete(id);if(trail()[0]==="history")await render();}
});
