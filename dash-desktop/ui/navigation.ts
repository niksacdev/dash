"use strict";

// Only mark edits that live in the current DOM. Workflow and retry drafts have their own owners.
const volatileForms:Record<string,string>={
  "requested-items-setup":"unsaved local judge settings","grade-create":"manual grader edits","grade-sample":"the unsaved test input",
  "catalog-import":"dataset import metadata","endpoint-form":"unsaved endpoint settings",
  "planner-fallback":"unsaved fallback settings"
};
type NavField=HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement;
const navEdited="[data-nav-edited]";
function navFieldChanged(field:NavField) {
  if (field instanceof HTMLSelectElement) {
    const original=Array.from(field.options).find(o=>o.defaultSelected) || field.options[0];
    return field.value!==(original?.value || "");
  }
  if (field instanceof HTMLInputElement && (field.type==="checkbox" || field.type==="radio")) return field.checked!==field.defaultChecked;
  return field.value!==field.defaultValue;
}
function trackNavigationEdit(event:Event) {
  const field=event.target;
  if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)) return;
  if (!field.matches("[data-quick-assignment]") && !(field.name==="output" && field.form?.hasAttribute("data-industry-test-form")) && !volatileForms[field.form?.id || ""]) return;
  document.querySelector("[data-nav-recent]")?.removeAttribute("data-nav-recent");
  const edited=navFieldChanged(field);field.toggleAttribute("data-nav-edited",edited);field.toggleAttribute("data-nav-recent",edited);
}
document.addEventListener("input",trackNavigationEdit);
document.addEventListener("change",trackNavigationEdit);
function forgetNavigationEdits(owner:Element) {
  for(const field of owner.querySelectorAll(navEdited)){field.removeAttribute("data-nav-edited");field.removeAttribute("data-nav-recent");}
}
function consumeSavedForm(form:HTMLFormElement) {
  forgetNavigationEdits(form);
  form.dataset.navSaved="";
  for (const button of form.querySelectorAll<HTMLButtonElement>("button")) if(button.type==="submit")button.disabled=true;
}
function lockNavigationWrite(form:HTMLFormElement) {
  const controls=[...form.querySelectorAll<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement|HTMLButtonElement>("input,textarea,select,button")].filter(control=>!control.disabled);
  for (const control of controls)control.disabled=true;
  form.dataset.navSaving="";form.setAttribute("aria-busy","true");
  return ()=>{for(const control of controls)control.disabled=false;delete form.dataset.navSaving;form.removeAttribute("aria-busy");};
}

// Reuse private form nodes without serializing their values. A refresh can update the
// selected dataset, receipt and runtime roster while an independent editor stays intact.
function paintWorkspace(screen:HTMLElement,html:string,preserve:boolean) {
  if(!preserve){screen.innerHTML=html;return;}
  const fields=screen.querySelectorAll<HTMLElement>(navEdited+",[data-nav-saving]");
  if(!fields.length){screen.innerHTML=html;return;}
  const template=document.createElement("template");template.innerHTML=html;
  const retained=new Map<Element,Element>();
  for(const field of fields) {
    const panel=field.closest<HTMLElement>(".gc-target"),card=panel?.closest<HTMLElement>("[data-use-version]");
    const owner=panel || field.closest("form");
    if(!owner || retained.has(owner))continue;
    let replacement:Element|null=null;
    if(card?.dataset.useVersion && panel){
      const selector='[data-use-version="'+CSS.escape(card.dataset.useVersion)+'"] .gc-target';
      if(card.closest("#grader-receipt"))replacement=template.content.querySelector("#grader-receipt "+selector);
      replacement ??=template.content.querySelector("[data-grade-version] "+selector);
    }else if(owner.id)replacement=template.content.querySelector("#"+CSS.escape(owner.id));
    if(replacement)retained.set(owner,replacement);
  }
  const active=document.activeElement;
  for(const [owner,replacement] of retained)replacement.replaceWith(owner);
  screen.replaceChildren(template.content);
  if(active instanceof HTMLElement && active.isConnected && [...retained.keys()].some(owner=>owner.contains(active)))active.focus({preventScroll:true});
}
function navigationLoss(owner?:Element) {
  const reasons=new Set<string>();
  for (const field of (owner || document).querySelectorAll<NavField>(navEdited)) {
    if (!navFieldChanged(field)) continue;
    if (field.form?.id==="grade-sample" && (pendingSample || retrySample)) continue;
    if (field.form?.id==="catalog-import" && !importDraft) continue;
    const reason=field.matches("[data-quick-assignment]")?"the unapplied grader assignment":field.form?.hasAttribute("data-industry-test-form")?"the unsubmitted industry case answer":volatileForms[field.form?.id || ""];
    if(reason)reasons.add(reason);
  }
  return [...reasons].join(" and ");
}
let discardDecision:HTMLDialogElement|null=null;
let navigationDecisionResult:Promise<boolean>|null=null;
function confirmNavigationLoss(loss:string,action:string):Promise<boolean> {
  if (!loss) return Promise.resolve(true);
  if (discardDecision) return Promise.resolve(false);
  const dialog=document.createElement("dialog");
  discardDecision=dialog;
  dialog.className="navigation-decision";
  dialog.setAttribute("aria-labelledby","nav-dialog-title");
  dialog.setAttribute("aria-describedby","nav-dialog-description");
  dialog.innerHTML='<form method="dialog"><h2 id="nav-dialog-title">Discard unsaved changes?</h2><p id="nav-dialog-description">Continuing will discard '+esc(loss)+'.</p><div><button value="stay" autofocus>Stay here</button><button value="leave">'+esc(action)+'</button></div></form>';
  const focus=document.querySelector("[data-nav-recent]") || document.activeElement;
  document.body.append(dialog);
  navigationDecisionResult=new Promise<boolean>(resolve=>{
    function finish(leave:boolean) {
      if(discardDecision!==dialog)return;
      discardDecision=null;navigationDecisionResult=null;dialog.close();dialog.remove();
      if (!leave && focus instanceof HTMLElement && focus.isConnected)focus.focus({preventScroll:true});
      resolve(leave);
    }
    dialog.addEventListener("submit",event=>{
      event.preventDefault();
      finish(event.submitter instanceof HTMLButtonElement && event.submitter.value==="leave");
    });
    dialog.addEventListener("cancel",event=>{event.preventDefault();finish(false);});
    dialog.showModal();
  });
  return navigationDecisionResult;
}
async function allowPageReplacement(action:string,extra="",owner:Element=document.body) {
  const loss=[navigationLoss(owner),extra].filter(Boolean).join(" and ");
  if(loss && !await confirmNavigationLoss(loss,action))return false;
  return true;
}
function unapprovedWorkflowLoss(w:UiWorkflow) {
  return !w.approved && (w.draft || w.objective.trim() || w.metrics.trim()) ? "the current unapproved "+(w.mode==="quick"?"Quick compare":"dataset")+" objective and its edits" : "";
}

// Chromium's native index covers Back/Forward entries created before DASH loaded.
let visibleHash=location.hash;
function nativeStep() {
  const index=window.navigation?.currentEntry?.index;
  return typeof index==="number" && index>=0 ? index : undefined;
}
let visibleStep=nativeStep();
let allowedHash:string|null=null;
function navigateAfterDecision(hash:string) {
  allowedHash="#"+hash;location.hash=hash;
}
let rollingBack=false;
function navDiscardLabel(hash:string) {
  return ((hash==="#compare" && runLibraryRoute()?.mode==="quick") || (hash==="#new" && runLibraryRoute()?.mode==="dataset")) ? "Discard and return to setup" : "Discard and leave";
}
document.addEventListener("click",async event=>{
  if (event.button!==0 || event.defaultPrevented || event.ctrlKey || event.shiftKey || event.metaKey || event.altKey || !(event.target instanceof Element)) return;
  const anchor=event.target.closest<HTMLAnchorElement>('a[href^="#"]');
  if (!anchor || anchor.hash===visibleHash || anchor.target || anchor.hasAttribute("download"))return;
  const loss=navigationLoss();
  if(!loss)return;
  event.preventDefault();event.stopImmediatePropagation();
  const stillHere=currentVisit(),target=anchor.hash,focus=anchor.dataset.quickFocus;
  if (await confirmNavigationLoss(loss,navDiscardLabel(target)) && stillHere()){
    if(focus==="design" || focus==="grading")quickReturnFocus=focus;
    navigateAfterDecision(target.slice(1));
  }
},true);
window.addEventListener("hashchange",async (event:HashChangeEvent)=>{
  const next=new URL(event.newURL).hash;
  if(next!==location.hash)return;
  if(rollingBack && next===visibleHash){rollingBack=false;return;}
  const nextStep=nativeStep();
  if(next===visibleHash){visibleStep=nextStep;return;}
  const allow=allowedHash===next;
  allowedHash=null;
  const loss=!allow && navigationLoss();
  if(loss && !await confirmNavigationLoss(loss,navDiscardLabel(next))) {
    if(location.hash!==next)return;
    if(visibleStep!==undefined && nextStep!==undefined && visibleStep!==nextStep) {
      rollingBack=true;history.go(visibleStep-nextStep);
    } else {
      history.replaceState(history.state,"",visibleHash || location.pathname);
    }
    return;
  }
  if(location.hash!==next)return;
  visibleHash=next;visibleStep=nextStep;rollingBack=false;
  forgetNavigationEdits(document.body);
  finishWorkspaceNavigation();
});
