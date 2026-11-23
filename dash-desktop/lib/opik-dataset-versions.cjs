"use strict";
const {isDeepStrictEqual} = require("node:util");

function caseData(row) {
  // Opik edits merge top-level data columns. A fixed set of columns also clears
  // removed reference fields when a newer DASH snapshot changes its schema.
  return {
    case_id:row.case_id, prompt:row.prompt ?? null, messages:row.messages ?? null,
    input:row.input ?? null, expected_output:row.reference ?? row.gold ?? null,
    rubric:row.rubric ?? null, sme_rationale:row.sme_rationale ?? null, case:row,
  };
}

async function nativeVersion(api, datasetId, items, snapshot, meta, options, problem) {
  const marker="dash-"+snapshot;
  const desired=new Set(items.map(item=>item.data.case_id));
  async function versions() {
    let head=null;
    for(let page=1;;page++){
      const response=await api.datasets.listDatasetVersions(datasetId,{page,size:100},options);
      const all=response.content || [];
      head ??= all[0];
      const found=all.find(v=>v.tags?.includes(marker) || v.metadata?.dash_snapshot===snapshot);
      if(found || all.length<100 || page*100>=response.total) return {head,found};
    }
  }
  async function contents(v) {
    const rows=new Map();
    if(!v)return rows;
    if(!v.versionHash)throw problem("Opik has not indexed the dataset version hash. Retry after indexing.");
    for(let page=1;;page++){
      const result=await api.datasets.getDatasetItems(datasetId,{page,size:100,version:v.versionHash,truncate:false},options);
      const items=result.content || [];
      for(const row of items){
        // Native delta writes allocate IDs for new cases on the server. Read the
        // version's returned IDs before linking experiments or editing cases.
        const key=row.data?.case_id;
        if(!row.id || typeof key!=="string" || rows.has(key))throw problem("The native version contains an unidentified or duplicate case.");
        rows.set(key,{id:row.id,data:row.data});
      }
      if(items.length<100 || page*100>=result.total)return rows;
    }
  }
  async function confirmed(v) {
    if(!v?.id || !v.versionHash) throw problem("Opik has not confirmed the native dataset version yet. Retry after indexing.");
    const actual=await contents(v);
    if(actual.size!==items.length || items.some(item=>!isDeepStrictEqual(actual.get(item.data.case_id)?.data,item.data)))
      throw problem("Opik has not confirmed the exact versioned case content. Retry after indexing.");
    return {id:v.id,hash:v.versionHash,name:v.versionName || v.versionHash,caseIds:Object.fromEntries([...actual].map(([key,r])=>[key,r.id]))};
  }
  for(let attempt=0;attempt<3;attempt++){
    const {head,found}=await versions();
    if(found)return confirmed(found);
    if(!head){
      // Opik requires an empty base when a new dataset has no versions.
      try {
        await api.datasets.applyDatasetItemChanges(datasetId,{override:false,body:{
          base_version:null,tags:["dash-family-base"],change_description:"Initialize DASH dataset family",
        }},options);
      } catch(e) {
        if(![400,409].includes(e.statusCode) || !(await versions()).head)throw e;
      }
      continue;
    }
    const previous=await contents(head);
    const body={
      base_version:head?.id ?? null, tags:[marker], metadata:{...meta,dash_snapshot:snapshot},
      change_description:meta.change_note || ("DASH "+(meta.dash_dataset_version || "prompt")+" · "+meta.split),
      added_items:[],edited_items:[],deleted_ids:[...previous].filter(([key])=>!desired.has(key)).map(([,r])=>r.id),
    };
    for(const item of items){
      const prior=previous.get(item.data.case_id);
      if(!prior)body.added_items.push(item);
      else if(!isDeepStrictEqual(prior.data,item.data))body.edited_items.push({id:prior.id,data:item.data});
    }
    try {
      const created=await api.datasets.applyDatasetItemChanges(datasetId,{body,override:false},options);
      return await confirmed(created);
    } catch(e) {
      if(e.statusCode!==409)throw e;
    }
  }
  throw problem("The Opik family changed concurrently. Retry to use its latest version.");
}
module.exports={caseData,nativeVersion};
