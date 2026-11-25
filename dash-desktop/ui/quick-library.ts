"use strict";

// Keep only references and non-text controls in this Electron profile. Prompt and rubric text have separate owners.
interface QuickRubricControls {judgeEdited?:boolean;index:number;judge:string;cutoff:number|null;evidence:"task-answer"|"reference";customText:boolean}
interface QuickLineup {inspectionOnly?:boolean;promptId:string;lanes:(string|null)[];rubrics:QuickRubricControls[]}
let resumedQuickId:string|null=null;
let quickChooserFilter="";
let quickReturnFocus:"design"|"grading"|null=null;
const availableQuickVersions=new WeakMap<UiQuickOptions,Set<string>>();
let quickDiscoverySettled=false;
let pendingQuickLineup:string|null=null;
function validRubricControls(row:unknown):row is QuickRubricControls {
  return isRecord(row) && typeof row.index==="number" && Number.isInteger(row.index) && row.index>=0 && row.index<8 &&
    typeof row.judge==="string" && row.judge.length<=500 && (row.judgeEdited===undefined || typeof row.judgeEdited==="boolean") && (row.cutoff===null || typeof row.cutoff==="number" &&
    row.cutoff>0 && row.cutoff<=1) && (row.evidence==="reference" || row.evidence==="task-answer") && typeof row.customText==="boolean";
}
const quickSessionKey="dash.quick-lineups.v1";
const quickSession:{active:string|null;lineups:QuickLineup[]}={active:null,lineups:[]};
let quickSessionLoaded=false;
function readQuickSession() {
  if(quickSessionLoaded)return;
  quickSessionLoaded=true;
  try {
    const stored:unknown=JSON.parse(localStorage.getItem(quickSessionKey) || "null");
    if (isRecord(stored) && Array.isArray(stored.lineups)) {
      for (const entry of stored.lineups.slice(-12)) {
        if (isRecord(entry) && typeof entry.promptId==="string" && entry.promptId.length<=128 &&
            Array.isArray(entry.lanes) && entry.lanes.length===2 &&
            entry.lanes.every(id=>id===null || typeof id==="string" && id.length<=500) &&
            (!entry.lanes[0] || entry.lanes[0]!==entry.lanes[1])) {
          const rubrics=Array.isArray(entry.rubrics) ? entry.rubrics.slice(0,8).filter(validRubricControls).map(({index,judge,judgeEdited,cutoff,evidence,customText})=>({index,judge,judgeEdited,cutoff,evidence,customText})) : [];
          quickSession.lineups.push({promptId:entry.promptId,lanes:[entry.lanes[0],entry.lanes[1]],rubrics,inspectionOnly:entry.inspectionOnly===true});
        }
      }
      if (typeof stored.active==="string" && quickSession.lineups.some(l=>l.promptId===stored.active)) quickSession.active=stored.active;
    }
  } catch { /* Navigation still works for the lifetime of this renderer. */ }
}
function persistQuickSession() {
  try {localStorage.setItem(quickSessionKey,JSON.stringify(quickSession));} catch { /* In-memory fallback. */ }
}
function rememberQuickLineup(lanesChanged=false) {
  const id=workflows.quick.approved?.id;
  if (!id) return;
  if (lanesChanged) pendingQuickLineup=null;
  const plan=quickGradePlan();
  const previous=quickSession.lineups.find(l=>l.promptId===id);
  const rubrics=plan?.options ? quickGradingRows(plan.options).flatMap<QuickRubricControls>((r,index)=>{
    const editor=plan.measures.get(r.metric);
    if (!editor || !editor.edited || editor.choice!=="rubric") return [];
    const cutoff=Number(editor.threshold);
    return [{index,judge:editor.judgeId,judgeEdited:!!editor.judgeEdited,cutoff:cutoff>0 && cutoff<=1?cutoff:null,evidence:editor.evidence,
      customText:editor.criteria!==r.generated?.criteria}];
  }) : previous?.rubrics ?? [];
  quickSession.active=id;
  quickSession.lineups=quickSession.lineups.filter(item=>item.promptId!==id).slice(-11);
  const lanes=pendingQuickLineup===id && previous ? previous.lanes : [...modelSelections.quick.lanes];
  quickSession.lineups.push({promptId:id,lanes,rubrics,inspectionOnly:plan?.inspectionOnly ?? previous?.inspectionOnly ?? false});
  persistQuickSession();
}
function restoredRubric(id:string,index:number) {
  return quickSession.lineups.find(l=>l.promptId===id)?.rubrics.find(r=>r.index===index);
}
function leaveQuickSetup() {
  for (const plan of quickGradingPlans.values()) plan.expectedAnswer="";
  resumedQuickId=null;pendingQuickLineup=null;
  quickSession.active=null;persistQuickSession();
}
function recoverQuickLineup(prompt:UiApproved) {
  const remembered=quickSession.lineups.find(item=>item.promptId===prompt.id);
  const known=rosterModels();
  if (!quickDiscoverySettled && !state.servers.length && remembered?.lanes.some(id=>id && !known.some(m=>m.id===id))) {
    // On a cold desktop launch the main process has not discovered any runtimes yet.
    // Hold the saved IDs until discovery finishes. Empty lanes cannot dispatch.
    pendingQuickLineup=prompt.id;quickSession.active=prompt.id;
    modelSelections.quick=emptySelection();persistQuickSession();return;
  }
  pendingQuickLineup=null;
  const lanes=(remembered?.lanes || [null,null]).map(id=>id && known.some(m=>m.id===id && !m.needsKey)?id:null);
  if(remembered && remembered.lanes.some((id,i)=>id && !lanes[i]))
    workflows.quick.error="A saved model is unavailable or needs a session key. Reconnect it or choose a replacement for the open lane.";
  modelSelections.quick={...emptySelection(),lanes};
  rememberQuickLineup();
}
function restoreActiveQuick() {
  const w=workflows.quick;
  if (w.approved || w.draft || w.busy || w.objective || !quickSession.active) return;
  const prompt=state.prompts.find(p=>p.id===quickSession.active && p.mode==="quick");
  if (prompt) {useWorkflowPrompt(prompt,false,null);resumedQuickId=prompt.id;}
  else leaveQuickSetup();
}
interface DatasetSetupDraft {
  snapshot:string;variant:string|null;lanes:(string|null)[];scorer:string|null;judge:string;inputCap:string;outputCap:string;
}
const datasetSetupKey="dash.dataset-setup.v1";
let readDatasetSetup=false;
let currentDatasetScope:string|null=null;
let missingDatasetSetup=false;
function resetDatasetSetupReceipt() {
  try {localStorage.removeItem(datasetSetupKey);} catch { /* The active form remains usable. */ }
  missingDatasetSetup=false;currentDatasetScope=null;
}
function rememberDatasetSetup() {
  const d=dataset(),w=workflows.dataset;
  if(!d || missingDatasetSetup || (w.variant && !w.approved))return;
  currentDatasetScope=activeDatasetGraderScope();
  const record:DatasetSetupDraft={snapshot:d.id,variant:w.approved?.id ?? null,lanes:[...modelSelections.dataset.lanes],
    scorer:datasetScorerChoices.get(d.id) ?? null,judge:w.caseJudgeId || "",inputCap:w.inputCap,outputCap:w.outputCap};
  try {localStorage.setItem(datasetSetupKey,JSON.stringify(record));} catch { /* The active form remains usable. */ }
}
function recoverDatasetSetup() {
  if(readDatasetSetup || (trail()[0]!=="new" && runLibraryRoute()?.mode!=="dataset"))return;
  readDatasetSetup=true;
  // An explicit catalogue launch has already selected its snapshot or variant.
  if(datasetId || workflows.dataset.datasetId || workflows.dataset.approved)return;
  try {
    const value:unknown=JSON.parse(localStorage.getItem(datasetSetupKey) || "null");
    if(!isRecord(value) || typeof value.snapshot!=="string" || !(value.variant===null || typeof value.variant==="string") ||
      !Array.isArray(value.lanes) || value.lanes.length!==2 || !value.lanes.every(id=>id===null || typeof id==="string" && id.length<=500) ||
      (value.lanes[0] && value.lanes[0]===value.lanes[1]))return;
    const d=state.datasets.find(d=>d.id===value.snapshot);
    const prompt=value.variant && state.prompts.find(p=>p.mode==="dataset" && p.id===value.variant && p.datasetId===d?.id);
    if (!d || (value.variant && !prompt)) {missingDatasetSetup=true;return;}
    if(prompt)useWorkflowPrompt(prompt,false,null);
    packId=d.pack;datasetId=d.id;workflows.dataset.datasetId=d.id;
    currentDatasetScope=activeDatasetGraderScope();
    modelSelections.dataset.lanes=value.lanes.map(id=>typeof id==="string"?id:null);
    if(typeof value.scorer==="string" && ["case-judge","selected-graders","exact-reference"].includes(value.scorer))datasetScorerChoices.set(d.id,value.scorer);
    if(typeof value.judge==="string" && value.judge.length<=500)workflows.dataset.caseJudgeId=value.judge;
    for(const key of ["outputCap","inputCap"] as const)if(typeof value[key]==="string" && /^\d{0,7}$/.test(value[key]))workflows.dataset[key]=value[key];
  } catch { /* Ignore malformed navigation metadata. */ }
}
function runLibraryPath(mode:UiMode) {
  const w=workflows[mode];
  if(mode==="quick") {
    const id=w.approved?.id || quickSession.active;
    return id?"graders/quick/"+encodeURIComponent(id):"graders";
  }
  const id=w.approved?.datasetId || dataset()?.id;
  return id?"graders/dataset/"+encodeURIComponent(id)+(w.approved?"/"+encodeURIComponent(w.approved.id):""):"graders";
}
function runLibraryRoute():{mode:UiMode;id:string;variant:string|null}|null {
  const [page,mode,key,variant]=visibleHash.slice(1).split("?")[0].split("/");
  if(page!=="graders" || !isRunMode(mode))return null;
  try{return {mode,id:decodeURIComponent(key || ""),variant:variant ? decodeURIComponent(variant):null};}catch{return {mode,id:"",variant:null};}
}
function quickLibraryPrompt() {
  const route=runLibraryRoute();
  return route?.mode==="quick" && route.id===quickSession.active ? state.prompts.find(p=>p.id===route.id && p.mode==="quick") : undefined;
}
function libraryDataset() {
  const route=runLibraryRoute();
  return route?.mode==="dataset" && !missingDatasetSetup && currentDatasetScope===activeDatasetGraderScope() && route.id===dataset()?.id && route.variant===(workflows.dataset.approved?.id ?? null) ?
    dataset() : undefined;
}
function quickLibraryUnavailable(g:UiGrader,options:UiQuickOptions) {
  if (g.type==="trajectory" || g.requiredEvidence?.includes("trajectory")) return "Requires an agent trace.";
  let ids=availableQuickVersions.get(options);
  if (!ids) {ids=new Set(options.available.map(option=>option.id));availableQuickVersions.set(options,ids);}
  if(ids.has(g.id)) return options.setupIssues?.[g.id] || savedJudgeIssue("quick",options,g);
  if (g.library?.automatic) return "Runs automatically when applicable.";
  if (g.library?.scenario || !["Cross-industry","General","Unclassified",quickLibraryPrompt()?.domain].includes(g.industry))
    return "Applies to a different scenario or industry.";
  if (g.type==="field") return "Use a dataset with the expected JSON fields for this check.";
  return "This version needs an available judge or a supported Quick scoring method.";
}
type RunGraderContext = {mode:"quick";prompt:UiApproved;plan:UiQuickPlan;options:UiQuickOptions} |
  {mode:"dataset";snapshot:UiDataset;scope:string;options:UiGraderOptions};
function runGraderContext():RunGraderContext|null {
  const p=quickLibraryPrompt(),plan=p && quickGradingPlans.get(p.id);
  if(p && plan?.options && !plan.error)return {mode:"quick",prompt:p,plan,options:plan.options};
  const snapshot=libraryDataset();
  return snapshot && datasetGradingRead.snapshot===snapshot.id && datasetGradingChoices?{mode:"dataset",snapshot,scope:activeDatasetGraderScope(),options:datasetGradingChoices}:null;
}
function graderUnavailable(context:RunGraderContext,g:UiGrader) {
  if(context.mode==="quick")return quickLibraryUnavailable(g,context.options);
  if(context.options.automatic.some(item=>item.id===g.id))return "Runs automatically for this snapshot.";
  const evidence=datasetGraderEvidenceIssue(g,context.options,context.snapshot.count);
  return evidence || (context.options.available.some(item=>item.id===g.id) ? "" : "Unavailable for this scenario and snapshot.");
}
function replacingGrader(ctx:RunGraderContext):string|null {
  const id=new URLSearchParams(visibleHash.split("?")[1]).get("replace");
  if(!id)return null;
  const picked=ctx.mode==="quick"?quickGradePayload(ctx.plan).graderIds:[...datasetGradeSelection(ctx.scope)];
  return picked.includes(id)?id:null;
}
function runChooserBanner(mode:UiMode,content:string) {
  return '<nav class="panel qc-return" aria-label="'+(mode==="quick"?"Quick comparison setup":"Dataset run setup")+'">'+
    link("← Back to evaluation setup",modeRoute(mode),"button")+content+'</nav>';
}
function runChooserPage() {
  const context=runGraderContext(),route=runLibraryRoute();
  if(!context){
    const prompt=quickLibraryPrompt(),plan=prompt && quickGradingPlans.get(prompt.id);
    const mode=route?.mode==="dataset"?"dataset":"quick";
    const snapshot=mode==="dataset" && libraryDataset();
    if(snapshot && !datasetGradingChoices)return runChooserBanner(mode,'<div><h2>'+esc(snapshot.metadata.family)+' · '+esc(snapshot.version)+'</h2>'+datasetGradingFailure()+'</div>');
    return runChooserBanner(mode,plan?.error?quickGraderFailure(plan):'<div role="status"><h2>Evaluation setup unavailable</h2><p>Return to setup to choose an available '+(mode==="dataset"?"dataset snapshot":"approved prompt")+'.</p></div>');

  }
  const quick=context.mode==="quick",back=modeRoute(context.mode),subject=quick?"comparison":"dataset run";
  const title=quick?(context.prompt.title || context.prompt.objective)+" · v"+context.prompt.version:context.snapshot.metadata.family+" · "+context.snapshot.version;
  const industry=quick?context.prompt.domain:context.snapshot.metadata.industry;
  const ids=quick ? quickGradePayload(context.plan).graderIds : [...datasetGradeSelection(context.scope)];
  const lanes=quick ? quickSession.lineups.find(item=>item.promptId===context.prompt.id)?.lanes ?? [] : modelSelections.dataset.lanes;
  const names=lanes.map(id=>{const m=rosterModels().find(model=>id===model.id);return m?displayModel(m.model):id?"Model unavailable":"Open lane";});
  const banner=runChooserBanner(context.mode,'<div><h2>'+esc(title)+'</h2><p>'+esc(industry)+' · '+esc(names.join(" / "))+'</p><small role="status">'+ids.length+' saved grader '+(ids.length===1?'version':'versions')+' attached</small></div>');
  const replace=replacingGrader(context);
  const eligible:UiGrader[]=[],unavailable:UiGrader[]=[];
  for(const g of state.graders)(graderUnavailable(context,g)?unavailable:eligible).push(g);
  const design='<a href="#'+back+'" data-quick-focus="design">Design a grader for this '+(quick?"prompt":"dataset")+'</a>';
  const hasRubric=quick && quickGradingRows(context.options).some(row=>row.generated);
  return banner+'<section class="qc-chooser"><h1>Graders for this '+subject+'</h1>'+
    (replace?'<p>Choose a replacement for '+esc(state.graders.find(g=>g.id===replace)?.name || replace)+'. Your current version stays attached until you confirm.</p>':'')+
    requestedItemsSetup()+
    (eligible.length?formField("Search graders",'<input type="search" id="grade-filter" placeholder="Name, criterion or industry" value="'+esc(quickChooserFilter)+'">')+
      '<div class="panel gc-section" data-quick-eligible>'+familyRevisionList(eligible)+'</div>':'<p>No saved grader matches this '+subject+'.</p>')+
    (hasRubric?'<p><a href="#'+back+'" data-quick-focus="grading">Review proposed rubrics</a> for this run.</p>':'')+'<p>'+design+' to save a reusable version.</p>'+
    (unavailable.length?'<details data-own-open class="panel gc-section"><summary>Unavailable for this '+subject+' · '+unavailable.length+'</summary>'+familyRevisionList(unavailable)+'</details>':'')+
    '<p id="gc-no-matches" hidden role="status">No matching graders.</p></section>';
}
function focusReturnedQuickControl() {
  if (!quickReturnFocus) return;
  const focus=quickReturnFocus;
  quickReturnFocus=null;
  if (focus==="design") {
    const panel=document.querySelector<HTMLDetailsElement>(".qc-workbench details[data-gd-scope]");
    if (panel) {panel.open=true;panel.querySelector("summary")?.focus();panel.scrollIntoView({block:"center"});}
  } else {
    const grading=document.getElementById("qc-grading");
    if(grading) {grading.tabIndex=-1;grading.focus();grading.scrollIntoView({block:"center"});}
  }
}
document.addEventListener("click",event=>{
  const link=event.target instanceof Element && event.target.closest<HTMLElement>("[data-quick-focus]");
  if(link && (link.dataset.quickFocus==="design" || link.dataset.quickFocus==="grading")) quickReturnFocus=link.dataset.quickFocus;
});
function runLibraryActions(g:UiGrader) {
  const ctx=runGraderContext();
  if(!ctx)return "";
  const issue=graderUnavailable(ctx,g);
  if(issue)return '<small>'+esc(issue)+'</small>';
  const measure=ctx.mode==="quick"?[...ctx.plan.measures].find(([,row])=>row.choice==="saved:"+g.id)?.[0]:undefined;
  const added=!!measure || (ctx.mode==="quick"?ctx.plan.saved:datasetGradeSelection(ctx.scope)).has(g.id);
  if(replacingGrader(ctx))return '<button type="button" data-quick-attach>Review replacement</button>';
  return (added?'<small data-quick-added>Added · '+esc(measure || (ctx.mode==="quick"?"Additional check":"Every case"))+'</small>':
    '<button type="button" data-quick-extra aria-label="'+esc("Add "+g.name+" v"+g.version+" to this run")+'">Add to '+(ctx.mode==="quick"?"comparison":"dataset run")+'</button>')+
    '<button type="button" data-quick-attach>'+(ctx.mode==="dataset"?"Review assignment":added?"Change assignment":"Choose measure…")+'</button>';
}
function runAssignmentChoices(ctx:RunGraderContext,g:UiGrader) {
  const quick=ctx.mode==="quick";
  const measures=quick?ctx.options.measures:[];
  const from=replacingGrader(ctx) ?? g.id;
  const selected=quick?measures.findIndex(m=>ctx.plan.measures.get(m.metric)?.choice==="saved:"+from):-1;
  return (quick?formField("Apply "+g.name+" v"+g.version+" to",'<select data-quick-assignment>'+opt("extra","Additional check for both answers",selected<0?"extra":String(selected))+
    measures.map((m,i)=>m.criterion && !m.reason && (!g.presetId || m.canMapRequestedItems)?opt(String(i),m.metric,String(selected)):"").join("")+'</select>'):'<p>'+esc(g.name)+' v'+esc(g.version)+' will assess every selected model on all '+ctx.snapshot.count+' cases.</p>')+
    (selected<0?"":'<small>Moving this grader leaves its previous measure unscored.</small>')+
    '<button type="button" data-quick-stay>Attach</button> <button type="button" data-quick-confirm>Attach and return to '+(quick?'Quick compare':'Dataset run')+'</button> '+
    '<button type="button" data-quick-cancel>Cancel</button>';
}
function attachQuickVersion(ctx:Extract<RunGraderContext,{mode:"quick"}>,g:UiGrader,value:string,replace:string|null=null) {
    const {plan,prompt}=ctx;
    const next:UiQuickPlan={...plan,saved:new Set(plan.saved),measures:new Map(plan.measures)};
    if(replace && replace!==g.id) {
      next.saved.delete(replace);
      for(const [metric,row] of next.measures)if(row.choice==="saved:"+replace)next.measures.set(metric,{...row,choice:"skip",edited:true});
    }
    const mapped=[...next.measures].find(([,row])=>row.choice==="saved:"+g.id);
    if (value==="extra") {
      if (mapped) next.measures.set(mapped[0],{...mapped[1],choice:"skip",edited:true});
      next.saved.add(g.id);
    } else {
      const m=ctx.options.measures[Number(value)],editor=m && next.measures.get(m.metric);
      if (!m?.criterion || m.reason || !editor) throw Error("Choose a measure with an approved pass condition.");
      if(g.presetId && !m.canMapRequestedItems)throw Error("Use this grader for explicitly requested item coverage, or attach it as an additional check.");
      if (mapped && mapped[0]!==m.metric) next.measures.set(mapped[0],{...mapped[1],choice:"skip",edited:true});
      next.measures.set(m.metric,{...editor,choice:"saved:"+g.id,edited:true});next.saved.delete(g.id);
    }
    if (quickGraderCount(quickGradePayload(next))>8) throw Error("Choose up to eight distinct graders. Remove one before attaching another.");
    quickGradingPlans.set(prompt.id,next);
    rememberQuickGraders(next,prompt.id);
}
async function runLibraryAction(button:HTMLButtonElement,host:HTMLElement,g:UiGrader) {
  const scope=host.querySelector<HTMLElement>(".gc-target"),route=runLibraryRoute(),ctx=runGraderContext();
  if(!scope || !route || !ctx)return;
  if(button.hasAttribute("data-quick-cancel")) {scope.hidden=true;scope.replaceChildren();host.querySelector<HTMLElement>("[data-quick-attach]")?.focus();return;}
  const stillHere=currentVisit();button.disabled=true;scope.hidden=false;
  try {
    if(ctx.mode==="quick")await loadQuickGrading(ctx.prompt);
    else {
      const fresh=await fetchDatasetGrading(ctx.snapshot.id);
      if(!stillHere() || !host.isConnected)return;
      applyDatasetGrading(fresh);
      if(!fresh.options){await render();return;}
    }
    if(!stillHere() || !host.isConnected)return;
    const fresh=runGraderContext();if(!fresh)throw Error("Reload grading choices for this run.");
    const unavailable=graderUnavailable(fresh,g);if(unavailable)throw Error(unavailable);
    if(button.hasAttribute("data-quick-attach")) {
      scope.innerHTML=runAssignmentChoices(fresh,g);scope.querySelector<HTMLElement>("select,button")?.focus();return;
    }
    const replace=replacingGrader(fresh);
    if(fresh.mode==="quick") {
      attachQuickVersion(fresh,g,button.hasAttribute("data-quick-extra")?"extra":requireElement("[data-quick-assignment]",HTMLSelectElement,scope).value,replace);
    }else{
      const picked=datasetGradeSelection(fresh.scope);
      const method=datasetScoringMethod(fresh.snapshot);
      if(!replace && !picked.has(g.id) && picked.size>=8)throw Error("Choose up to eight distinct graders.");
      if(replace)picked.delete(replace);
      picked.add(g.id);writeGraderAttachment(fresh.scope,picked);
      if(fresh.snapshot.pack==="reference")datasetScorerChoices.set(fresh.snapshot.id,method);
      rememberDatasetSetup();
    }
    lastRemovedGrader=null;forgetNavigationEdits(scope);
    if(button.hasAttribute("data-quick-confirm"))location.hash=modeRoute(fresh.mode);
    else if(replace)location.hash=runLibraryPath(fresh.mode);
    else {await render();document.querySelector<HTMLElement>('[data-use-version="'+CSS.escape(g.id)+'"] [data-quick-attach]')?.focus({preventScroll:true});}
  }catch(err){if(stillHere() && host.isConnected)inlineError(scope,err);}
  finally{button.disabled=false;}
}

document.addEventListener("click",async event=>{
  const button=event.target instanceof Element && event.target.closest<HTMLButtonElement>("[data-run-remove],[data-run-restore]");
  const mode=workflowMode(),id=button && (button.dataset.runRemove || button.dataset.runRestore);
  if(!button || !mode || !id)return;
  const grading=button.closest<HTMLElement>("#qc-grading");
  if(!grading)return;
  const restoring=!!button.dataset.runRestore;
  try {
    const scope=mode==="quick"?"prompt:"+workflows.quick.approved?.id:activeDatasetGraderScope();
    if(restoring && (lastRemovedGrader?.scope!==scope || lastRemovedGrader.id!==id))return;
    const grade=state.graders.find(g=>g.id===id);
    if(mode==="quick") {
      const prompt=workflows.quick.approved,plan=quickGradePlan(),options=plan?.options;
      if(!prompt || !plan || !options)return;
      if(restoring){
        if(!grade || !options.available.some(g=>g.id===id))throw Error("This grader version is unavailable. Choose another version.");
        const index=options.measures.findIndex(r=>r.metric===lastRemovedGrader?.metric && plan.measures.get(r.metric)?.choice==="skip");
        attachQuickVersion({mode,prompt,plan,options},grade,index<0?"extra":String(index));
      } else {
        const assignment=[...plan.measures].find(([,row])=>row.choice==="saved:"+id);
        if(assignment){changeQuickGrader(plan,assignment[1],"skip");assignment[1].removedChoice="saved:"+id;}
        plan.saved.delete(id);rememberQuickGraders(plan);rememberQuickLineup();lastRemovedGrader={scope,id,metric:assignment?.[0]};
      }
    }else{
      const chosen=datasetGradeSelection(scope);
      if(restoring){
        if(!grade || !datasetGradingChoices?.available.some(g=>g.id===id))throw Error("This grader version is unavailable. Choose another version.");
        const issue=datasetGraderEvidenceIssue(grade,datasetGradingChoices,dataset()?.count ?? 0);
        if(issue)throw Error(issue);
        if(chosen.size>=8)throw Error("Choose up to eight distinct graders.");
        chosen.add(id);
      }else{chosen.delete(id);lastRemovedGrader={scope,id};}
      writeGraderAttachment(scope,chosen);rememberDatasetSetup();
    }
    if(restoring)lastRemovedGrader=null;
    await render();
    document.querySelector<HTMLElement>(restoring?'[data-run-remove="'+CSS.escape(id)+'"]':'[data-run-restore]')?.focus({preventScroll:true});
  } catch(error){inlineError(grading,error);}
});
