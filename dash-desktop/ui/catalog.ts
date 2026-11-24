"use strict";
let importDraft: UiImportDraft | null = null;
let importPicking=false;
let importPack = "";
let catalogSearch = "";
let catalogIndustry = "All industries";
function dsMeta(d: UiDataset): UiDatasetMetadata {
  return d.metadata || {family:d.name,category:"Uncategorized",tags:[],source:d.name,changeNote:"",parentId:null};
}
const versionLink = (d: UiDataset) => link(esc(d.version+" · "+d.split), "datasets/"+encodeURIComponent(d.id), "link");
function sameFamily(d: UiDataset, name:string, industry:string) {
  const meta=dsMeta(d);
  return meta.family.toLowerCase()===name.trim().toLowerCase() &&
    (meta.industry || "Unclassified").toLowerCase()===industry.trim().toLowerCase();
}
function importForm(draft: UiImportDraft) {
  const peers=state.datasets.filter(d=>d.pack===draft.pack);
  const options=(items: string[])=>[...new Set(items)].map(v=>'<option value="'+esc(v)+'"></option>').join("");
  const field=(label: string,input: string)=>'<label class="field"><span>'+label+'</span>'+input+'</label>';
  return '<form class="panel catalog-import" id="catalog-import" data-import-token="'+esc(draft.token)+'"><h2>Catalog this version</h2><p>'+esc(draft.name)+' · '+esc(draft.version)+' · '+esc(draft.split)+' · '+draft.count+' cases</p>'+
    field('Industry','<input name="industry" required list="industry-list" maxlength="100" value="'+esc(catalogIndustry==="All industries"?"":catalogIndustry)+'" placeholder="Choose or enter an industry"><datalist id="industry-list">'+industryOptions("")+'</datalist>')+
    '<div class="cols">'+field('Dataset family','<input name="family" required list="family-names" maxlength="160" placeholder="Choose an existing family or name a new one">')+
    field('Category','<input name="category" required list="category-names" maxlength="100" placeholder="e.g. Financial extraction">')+'</div>'+
    '<datalist id="family-names">'+options(peers.map(d=>dsMeta(d).family))+'</datalist><datalist id="category-names">'+options(peers.map(d=>dsMeta(d).category))+'</datalist>'+
    '<div class="cols">'+field('Tags','<input name="tags" maxlength="999" placeholder="e.g. synthetic, earnings, exceptions">')+
    field('Source','<input name="source" maxlength="500" value="'+esc(draft.name)+'">')+'</div>'+
    field('Parent version','<select name="parentId"><option value="">Independent snapshot</option></select>')+
    field('What changed?','<input name="changeNote" maxlength="1200" placeholder="e.g. Added restated EPS cases to test review routing">')+
    '<small>Version and split come from the JSONL. A parent links this snapshot to the dataset it was derived from.</small>'+
    '<div class="row spacer"><button type="submit" class="yellow">Save dataset version</button><button type="button" data-act="cancel-import">Cancel</button></div></form>';
}
function parentOptions(form: HTMLFormElement) {
  const select = form.elements.namedItem("parentId");
  const note = form.elements.namedItem("changeNote");
  const category = form.elements.namedItem("category");
  const draft = importDraft;
  if (!(select instanceof HTMLSelectElement) || !draft || form.dataset.importToken!==draft.token) return;
  const family = formText(form, "family");
  const industry = formText(form, "industry");
  const old = select.value;
  const choices = state.datasets.filter(d => d.pack === draft.pack && sameFamily(d,family,industry));
  select.innerHTML = opt("","Independent snapshot",old)+choices.map(d=>opt(d.id,d.version+" · "+d.split,old)).join("");
  if (note instanceof HTMLInputElement) note.required = !!select.value;
  const latest = choices.at(-1);
  if (latest && category instanceof HTMLInputElement && !category.value) category.value = dsMeta(latest).category;
}
function filterCatalog() {
  const query=catalogSearch.trim().toLowerCase();
  const rows=[...document.querySelectorAll<HTMLElement>("[data-catalog-search]")];
  rows.forEach(row=>row.hidden=!row.dataset.catalogSearch?.includes(query) || (catalogIndustry!=="All industries" && row.dataset.industry!==catalogIndustry));
  const empty=document.querySelector<HTMLElement>("#catalog-empty");
  if(empty)empty.hidden=rows.some(row=>!row.hidden);
  const detail=document.querySelector<HTMLElement>("#dataset-detail");
  if(detail)detail.hidden=!rows.some(row=>!row.hidden && row.hasAttribute("aria-current"));
}
async function catalogPage(id?: string) {
  const chosen=state.datasets.find(d=>d.id===id) || dataset();
  if(id && state.datasets.some(d=>d.id===id)) {packId=chosen.pack;datasetId=chosen.id;}
  const d=await api.dataset(chosen.id), meta=dsMeta(chosen);
  const peers=state.datasets;
  const versions=peers.filter(x=>x.pack===chosen.pack && sameFamily(x,meta.family,meta.industry || "Unclassified")).reverse();
  const parent=state.datasets.find(x=>x.id===meta.parentId);
  const files=peers.slice().reverse().map(x=>{
    const m=dsMeta(x), terms=[m.industry,m.family,m.category,...m.tags,x.version,x.split,m.source].join(" ").toLowerCase();
    return '<a data-industry="'+esc(m.industry || "Unclassified")+'" class="catalog-entry" data-catalog-search="'+esc(terms)+'" href="#datasets/'+esc(x.id)+'" '+
      (x.id===d.id?'aria-current="true"':'')+(terms.includes(catalogSearch.trim().toLowerCase())?'':' hidden')+
      '><span><strong>'+esc(m.family)+'</strong><small>'+esc([m.industry,m.category,...m.tags].filter(Boolean).join(" · "))+'</small></span><span>'+esc(x.version)+' <small>'+esc(x.split)+'</small></span></a>';
  }).join("");
  return heading("Workspace","Datasets")+(importDraft?importForm(importDraft):"")+
    '<div class="panel"><div class="bar"><label class="field"><span>Scenario for import</span><select id="catalog-pack">'+state.packs.map(p=>opt(p.id,p.title,importPack || chosen.pack)).join("")+
    '</select></label>'+btn("Upload JSONL","import")+'</div>'+datasetImportHelp(importPack || chosen.pack)+'<label class="field"><span>Filter by industry</span><select id="catalog-industry">'+industryOptions(catalogIndustry,true)+'</select></label><label class="field"><span>Find datasets</span><input type="search" id="catalog-search" value="'+esc(catalogSearch)+'" placeholder="Family, category, tag or version"></label>'+
    files+'<p id="catalog-empty" hidden>No matching versions. Upload JSONL to add a dataset for this industry.</p></div>'+'<div id="dataset-detail">'+bar(meta.family)+
    '<section class="panel"><div class="row">'+tag(meta.industry || "Unclassified")+tag(chosen.version)+tag(chosen.split)+tag(chosen.count+" cases")+tag(meta.category)+meta.tags.map(t=>tag(t)).join("")+
    '</div><dl class="catalog-facts"><dt>Source</dt><dd>'+esc(meta.source || "Unspecified")+'</dd><dt>Derived from</dt><dd>'+(parent?versionLink(parent):'No parent recorded')+
    '</dd><dt>Change note</dt><dd>'+esc(meta.changeNote || "No note recorded")+'</dd></dl>'+
    '<div class="row"><strong>Family versions</strong>'+versions.map(x=>x.id===chosen.id?tag(x.version+" · "+x.split):versionLink(x)).join("")+'</div></section>'+
    bar("Case inputs")+'<div class="stack">'+d.rows.map(r=>'<details class="card"><summary>'+esc(r.case_id)+'</summary>'+datasetCaseDetails(r,state.packs.find(p=>p.id===chosen.pack))+
      (r.source_locator?'<small>Source · '+esc(r.source_locator)+'</small>':'')+'</details>').join("")+'</div></div>';
}

document.addEventListener("input", e => {
  if (!(e.target instanceof HTMLInputElement)) return;
  if (e.target.id === "catalog-search") {catalogSearch=e.target.value;filterCatalog();}
  if ((e.target.name === "family" || e.target.name === "industry") && e.target.form?.id === "catalog-import") parentOptions(e.target.form);
});
document.addEventListener("change", async e => {
  if (!(e.target instanceof HTMLSelectElement)) return;
  if (e.target.name === "parentId" && e.target.form?.id === "catalog-import") {
    const note = e.target.form.elements.namedItem("changeNote");
    if (note instanceof HTMLInputElement) note.required = !!e.target.value;
  }
  if (e.target.id === "catalog-industry") {
    catalogIndustry=e.target.value;filterCatalog();
    const first=document.querySelector<HTMLAnchorElement>(".catalog-entry:not([hidden])");
    if(first)location.hash=first.hash;
    else document.querySelector("#dataset-detail")?.setAttribute("hidden","");
  }
  if (e.target.id === "catalog-pack") {
    const select=e.target,prior=importPack || dataset()?.pack || "",next=select.value;
    if(!await allowPageReplacement("Discard and change scenario")){select.value=prior;return;}
    if(!select.isConnected)return;
    importPack=next;importDraft=null;void render(true);
  }
});
document.addEventListener("submit", async e => {
  if (!(e.target instanceof HTMLFormElement) || e.target.id !== "catalog-import") return;
  e.preventDefault();
  const form = e.target;
  const draft = importDraft;
  const submit = form.querySelector<HTMLButtonElement>("[type=submit]");
  if (!submit || submit.disabled || importPicking || form.hasAttribute("data-nav-saved"))return;
  if (!draft || form.dataset.importToken!==draft.token) {inlineError(form,Error("This metadata form is for a different file. Choose your dataset again."));return;}
  const stillHere=currentVisit();
  form.querySelector(":scope > [data-action-error]")?.remove();
  const values: UiCommitImport = {
    industry: formText(form, "industry"),
    family: formText(form, "family"),
    category: formText(form, "category"),
    source: formText(form, "source"),
    changeNote: formText(form, "changeNote"),
    parentId: formText(form, "parentId") || null,
    tags: formText(form, "tags").split(",").map(tag => tag.trim()).filter(Boolean)
  };
  const unlock=lockNavigationWrite(form);
  try {
    const id=await api.commitImport(draft.token,values);
    consumeSavedForm(form);
    if(importDraft===draft)importDraft=null;
    if(!stillHere())return;
    packId=draft.pack;catalogSearch="";datasetId=id;
    if(location.hash==="#datasets/"+id)await render();else location.hash="datasets/"+id;
    message("Dataset version saved.");
  } catch(error) {inlineError(form,error);} finally {unlock();}
});
