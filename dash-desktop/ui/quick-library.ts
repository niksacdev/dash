"use strict";

// Keep only references and non-text controls in this Electron profile. Prompt and rubric text have separate owners.
interface QuickRubricControls {index:number;judge:string;cutoff:number|null;evidence:"task-answer"|"reference";customText:boolean}
interface QuickLineup {promptId:string;lanes:(string|null)[];rubrics:QuickRubricControls[]}
let resumedQuickId:string|null=null;
let quickChooserFilter="";
let quickReturnFocus:"design"|"grading"|null=null;
const availableQuickVersions=new WeakMap<UiQuickOptions,Set<string>>();
let quickDiscoverySettled=false;
let pendingQuickLineup:string|null=null;
function validRubricControls(row:unknown):row is QuickRubricControls {
  return isRecord(row) && typeof row.index==="number" && Number.isInteger(row.index) && row.index>=0 && row.index<8 &&
    typeof row.judge==="string" && row.judge.length<=500 && (row.cutoff===null || typeof row.cutoff==="number" &&
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
          const rubrics=Array.isArray(entry.rubrics) ? entry.rubrics.slice(0,8).filter(validRubricControls).map(({index,judge,cutoff,evidence,customText})=>({index,judge,cutoff,evidence,customText})) : [];
          quickSession.lineups.push({promptId:entry.promptId,lanes:[entry.lanes[0],entry.lanes[1]],rubrics});
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
    if (!editor || editor.choice!=="rubric") return [];
    const cutoff=Number(editor.threshold);
    return [{index,judge:editor.judgeId,cutoff:cutoff>0 && cutoff<=1?cutoff:null,evidence:editor.evidence,
      customText:editor.criteria!==r.generated?.criteria}];
  }) : previous?.rubrics ?? [];
  quickSession.active=id;
  quickSession.lineups=quickSession.lineups.filter(item=>item.promptId!==id).slice(-11);
  const lanes=pendingQuickLineup===id && previous ? previous.lanes : [...modelSelections.quick.lanes];
  quickSession.lineups.push({promptId:id,lanes,rubrics});
  persistQuickSession();
}
function restoredRubric(id:string,index:number) {
  return quickSession.lineups.find(l=>l.promptId===id)?.rubrics.find(r=>r.index===index);
}
function leaveQuickSetup() {
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
function quickLibraryPath() {
  const id=workflows.quick.approved?.id || quickSession.active;
  return id ? "graders/quick/"+encodeURIComponent(id) : "graders";
}
function chooseQuickGradersLink() {return link("Choose graders",quickLibraryPath(),"link");}
function quickLibraryRoute() {
  const [page,origin,promptId]=trail();
  return page==="graders" && origin==="quick" ? promptId || "missing" : null;
}
function quickLibraryPrompt() {
  const id=quickLibraryRoute();
  return id===quickSession.active ? state.prompts.find(p=>p.id===id && p.mode==="quick") : undefined;
}
function quickLibraryBanner() {
  if (!quickLibraryRoute()) return "";
  const prompt=quickLibraryPrompt();
  if (!prompt) return '<section class="panel" role="status"><h2>Quick setup unavailable</h2><p>Choose an approved prompt to resume a comparison.</p>'+link("Open prompt catalog","prompts","link")+'</section>';
  const plan=quickGradingPlans.get(prompt.id);
  const attached=new Set([...(plan?.saved ?? []),...[...(plan?.measures.values() ?? [])].flatMap(r=>r.choice.startsWith("saved:")?[r.choice.slice(6)]:[])]);
  const names=quickSession.lineups.find(item=>item.promptId===prompt.id)?.lanes.map(id=>{
    const model=rosterModels().find(m=>m.id===id);
    return model ? displayModel(model.model) : id ? "Model unavailable" : "Open lane";
  });
  return '<nav class="panel qc-return" aria-label="Quick comparison setup">'+link("← Back to evaluation setup","compare","button")+
    '<div><h2>'+esc(prompt.title || prompt.objective)+' · v'+esc(prompt.version)+'</h2><p>'+esc(prompt.domain)+
    (names?' · '+esc(names.join(" / ")):'')+'</p>'+
    (plan?.error?quickGraderFailure(plan):plan?.options?'<small role="status">'+attached.size+' saved grader '+(attached.size===1?'version':'versions')+' attached</small>' :'')+'</div></nav>';
}
function quickLibraryUnavailable(g:UiGrader,options:UiQuickOptions) {
  if (needsGraderReference(g)) return "Requires a labeled dataset with a reference answer.";
  if (g.type==="trajectory" || g.requiredEvidence?.includes("trajectory")) return "Requires an agent trace.";
  let ids=availableQuickVersions.get(options);
  if (!ids) {ids=new Set(options.available.map(option=>option.id));availableQuickVersions.set(options,ids);}
  if(ids.has(g.id)) return "";
  if (g.library?.automatic) return "Runs automatically when applicable.";
  if (g.library?.scenario || !["Cross-industry","General","Unclassified",quickLibraryPrompt()?.domain].includes(g.industry))
    return "Applies to a different scenario or industry.";
  return "This version needs an available judge or a supported Quick scoring method.";
}
function quickChooserPage() {
  const prompt=quickLibraryPrompt(),plan=prompt && quickGradingPlans.get(prompt.id);
  const banner=quickLibraryBanner();
  if(!prompt || !plan?.options || plan.error) return banner;
  const eligible:UiGrader[]=[],unavailable:UiGrader[]=[];
  for(const g of state.graders) (quickLibraryUnavailable(g,plan.options)?unavailable:eligible).push(g);
  const design='<a href="#compare" data-quick-focus="design">Design a grader for this prompt</a>';
  const hasRubric=quickGradingRows(plan.options).some(row=>row.generated);
  const rubric='<a href="#compare" data-quick-focus="grading">Review proposed rubrics</a>';
  return banner+'<section class="qc-chooser"><h1>Graders for this comparison</h1>'+
    (eligible.length?formField("Search graders",'<input type="search" id="grade-filter" placeholder="Name, criterion or industry" value="'+esc(quickChooserFilter)+'">')+
      '<div class="panel gc-section" data-quick-eligible>'+familyRevisionList(eligible)+'</div>':
      '<p>No saved grader matches this comparison.</p>')+
    (hasRubric?'<p>'+rubric+' for this run.</p>':'')+'<p>'+design+' to save a reusable version.</p>'+
    (unavailable.length?'<details data-own-open class="panel gc-section"><summary>Unavailable for this comparison · '+unavailable.length+'</summary>'+
      familyRevisionList(unavailable)+'</details>':'')+
    '<p id="gc-no-matches" hidden role="status">No matching graders.</p></section>';
}
function focusReturnedQuickControl() {
  if (!quickReturnFocus) return;
  const focus=quickReturnFocus;
  quickReturnFocus=null;
  if (focus==="design") {
    const panel=document.querySelector<HTMLDetailsElement>("#setup details[data-gd-scope]");
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
function quickLibraryActions(g:UiGrader) {
  const prompt=quickLibraryPrompt(),plan=prompt && quickGradingPlans.get(prompt.id);
  if (!prompt || !plan?.options) return "";
  const reason=quickLibraryUnavailable(g,plan.options);
  if (reason) return '<small>'+esc(reason)+'</small>';
  const measure=[...plan.measures].find(([,row])=>row.choice==="saved:"+g.id)?.[0];
  const added=measure || plan.saved.has(g.id);
  return (added?'<small data-quick-added>Added · '+esc(measure || "Additional check")+'</small>':
    '<button type="button" data-quick-extra aria-label="'+esc("Add "+g.name+" v"+g.version+" as an additional check")+'">Add to comparison</button>')+
    '<button type="button" data-quick-attach>'+ (added?'Change assignment':'Choose measure…')+'</button>';
}
function quickAssignmentChoices(prompt:UiApproved,plan:UiQuickPlan,g:UiGrader) {
  const measures=plan.options?.measures || [];
  const selected=measures.findIndex(m=>plan.measures.get(m.metric)?.choice==="saved:"+g.id);
  return formField("Apply "+g.name+" v"+g.version+" to",'<select data-quick-assignment>'+
    opt("extra","Additional check for both answers",selected<0?"extra":String(selected))+
    measures.map((m,i)=>m.criterion && !m.reason ? opt(String(i),m.metric,String(selected)) : "").join("")+'</select>')+
    (selected<0?"":'<small>Moving this grader leaves its previous measure unscored.</small>')+
    '<button type="button" data-quick-stay>Attach</button> <button type="button" data-quick-confirm>Attach and return to Quick compare</button> '+
    '<button type="button" data-quick-cancel>Cancel</button><small>'+esc(prompt.title)+' · v'+esc(prompt.version)+'</small>';
}
async function quickLibraryAction(button:HTMLButtonElement,host:HTMLElement,g:UiGrader) {
  const prompt=quickLibraryPrompt(),scope=host.querySelector<HTMLElement>(".gc-target");
  if (!prompt || !scope) return;
  if (button.hasAttribute("data-quick-cancel")) {scope.hidden=true;scope.replaceChildren();host.querySelector<HTMLElement>("[data-quick-attach]")?.focus();return;}
  const stillHere=currentVisit();
  button.disabled=true;scope.hidden=false;
  try {
    await loadQuickGrading(prompt);
    if (!stillHere() || !host.isConnected) return;
    const plan=quickGradingPlans.get(prompt.id);
    if (!plan?.options || plan.error) throw Error(plan?.error || "Reload grading choices to continue.");
    const unavailable=quickLibraryUnavailable(g,plan.options);
    if(unavailable)throw Error(unavailable);
    if (button.hasAttribute("data-quick-attach")) {
      scope.innerHTML=quickAssignmentChoices(prompt,plan,g);
      scope.querySelector("select")?.focus();return;
    }
    const value=button.hasAttribute("data-quick-extra") ? "extra" : requireElement("[data-quick-assignment]",HTMLSelectElement,scope).value;
    const next:UiQuickPlan={...plan,saved:new Set(plan.saved),measures:new Map(plan.measures)};
    const mapped=[...next.measures].find(([,row])=>row.choice==="saved:"+g.id);
    if (value==="extra") {
      if (mapped) next.measures.set(mapped[0],{...mapped[1],choice:"skip",edited:true});
      next.saved.add(g.id);
    } else {
      const m=plan.options.measures[Number(value)],editor=m && next.measures.get(m.metric);
      if (!m?.criterion || m.reason || !editor) throw Error("Choose a measure with an approved pass condition.");
      if (mapped && mapped[0]!==m.metric) next.measures.set(mapped[0],{...mapped[1],choice:"skip",edited:true});
      next.measures.set(m.metric,{...editor,choice:"saved:"+g.id,edited:true});next.saved.delete(g.id);
    }
    if (quickGraderCount(quickGradePayload(next))>8) throw Error("Choose up to eight distinct graders. Remove one before attaching another.");
    quickGradingPlans.set(prompt.id,next);
    rememberQuickGraders(next,prompt.id);forgetNavigationEdits(scope);
    if (button.hasAttribute("data-quick-confirm")) location.hash="compare";
    else {await render();document.querySelector<HTMLElement>('[data-use-version="'+CSS.escape(g.id)+'"] [data-quick-attach]')?.focus({preventScroll:true});}
  } catch(err) {
    if(stillHere() && host.isConnected) inlineError(scope,err);
  } finally {button.disabled=false;}
}
