"use strict";

let guideEnabled = localStorage.getItem("dash.quickGuide") !== "off";
let guideSequence = 0, guidePending = false, guideDraft = "";
let guideTimer: number | undefined;
let guideResult: UiGuideResult | null = null;

function cancelPromptGuide() {
  ++guideSequence;
  clearTimeout(guideTimer);
  if (guidePending) window.dash.cancelGuide?.().catch(() => {});
  guidePending = false;
}
function guideBody() {
  const result = guideResult;
  if (!guideEnabled) return "";
  if (!window.dash.guidePrompt) return '<small>Reopen DASH to load the local prompt guide.</small>';
  if (guidePending) return '<small role="status">Reading your draft locally…</small>';
  if (!result) return "";
  if (result.status !== "ready") {
    const note = {canceled: "", offline:"Load a model in LM Studio or Ollama to get a suggestion.",
      busy:"Guidance is available after the active run.",
      unavailable:"The guide couldn’t return a suggestion."}[result.status];
    return note ? '<small>'+esc(note)+'</small> <button type="button" data-guide="retry">Try again</button>' : "";
  }
  return '<div class="guide-response"><span class="guide-source">'+esc(displayModel(result.model))+'</span>'+
    '<p>'+esc(result.text)+'</p>'+(result.kind === "question"
      ? '<label class="guide-answer"><span class="visually-hidden">Clarifying detail</span><input type="text" id="guide-answer" maxlength="1500" placeholder="Add that detail…"></label><button type="button" data-guide="answer">Add detail</button>'
      : '<button type="button" data-guide="apply">Add to shared prompt</button>')+
    ' <button type="button" data-guide="dismiss">Dismiss</button></div>';
}
function promptGuidePanel() {
  return '<section class="prompt-guide" aria-label="Prompt guidance"><div class="guide-tools">'+
    '<button type="button" data-guide="toggle" aria-pressed="'+guideEnabled+'">'+svg("compare-i")+
    ' Local prompt guide <span>'+(guideEnabled?"On":"Off")+'</span></button></div>'+
    '<div id="guide-body" aria-live="polite">'+guideBody()+'</div></section>';
}
function drawGuide() {
  const body = document.querySelector("#guide-body");
  if (body) body.innerHTML = guideBody();
}
function scheduleGuide(force = false) {
  const input = document.querySelector<HTMLTextAreaElement>("#prompt");
  if (!input) return;
  const draft = input.value.trim();
  if (!force && draft === guideDraft) return;
  cancelPromptGuide();
  guideResult = null;
  guideDraft = draft;
  drawGuide();
  if (!guideEnabled || !draft || (!force && draft.length < 4) || !window.dash.guidePrompt || state?.active) return;
  const version = guideSequence;
  guideTimer = window.setTimeout(async () => {
    if (version !== guideSequence || !document.querySelector("#prompt") || trail()[0]!=="compare") return;
    guidePending = true;
    drawGuide();
    let result: UiGuideResult;
    try { result = await window.dash.guidePrompt(draft); }
    catch { result = { status: "unavailable" }; }
    if (version !== guideSequence) return;
    guidePending = false;
    guideResult = result;
    drawGuide();
  }, force ? 0 : 1500);
}
function addGuidance(action: "answer" | "apply") {
  const prompt = document.querySelector<HTMLTextAreaElement>("#prompt");
  if (!prompt || prompt.value.trim() !== guideDraft || guideResult?.status !== "ready") return;
  const answer = document.querySelector<HTMLInputElement>("#guide-answer")?.value.trim();
  if (action === "answer" && !answer) { document.querySelector<HTMLInputElement>("#guide-answer")?.focus(); return; }
  const addition = action === "answer" ? guideResult.text+"\n"+answer : guideResult.text;
  const combined = prompt.value.trimEnd()+"\n\n"+addition;
  if (combined.length > prompt.maxLength) {message("The extra detail exceeds the shared prompt limit.");return;}
  cancelPromptGuide();
  guideResult = null;
  guideDraft = combined.trim();
  prompt.value = combined;
  prompt.dispatchEvent(new Event("input", {bubbles:true}));
  drawGuide();
  prompt.focus();
  prompt.setSelectionRange(combined.length, combined.length);
  if (action === "answer") scheduleGuide(true);
}
document.addEventListener("input", e => { if (e.target instanceof HTMLElement && e.target.id === "prompt") scheduleGuide(); });
document.addEventListener("keydown", e => {
  if (e.target instanceof HTMLElement && e.target.id === "guide-answer" && e.key==="Enter" && !e.isComposing) {
    e.preventDefault(); addGuidance("answer");
  }
});
document.addEventListener("click", e => {
  if (!(e.target instanceof Element)) return;
  const button = e.target.closest<HTMLButtonElement>("[data-guide]");
  if (!button) return;
  switch (button.dataset.guide) {
    case "toggle":
      guideEnabled = !guideEnabled;
      localStorage.setItem("dash.quickGuide",guideEnabled?"on":"off");
      button.setAttribute("aria-pressed", String(guideEnabled));
      const label = button.querySelector("span");
      if (label) label.textContent = guideEnabled?"On":"Off";
      scheduleGuide(true);
      break;
    case "dismiss": cancelPromptGuide(); guideResult=null; drawGuide(); break;
    case "retry": scheduleGuide(true); break;
    case "apply": case "answer": addGuidance(button.dataset.guide); break;
  }
});
window.addEventListener("hashchange", () => {
  cancelPromptGuide(); guideDraft=""; guideResult=null;
});
