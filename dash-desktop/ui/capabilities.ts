"use strict";

const modelGrid = ["Open Source", "Frontier Labs", "FineTuned"];
const domainAgentGrid = ["Financial expert", "Financial implementer", "Output analyzer"];
const inspectionGrid = ["Manufacturing expert", "Manufacturing implementer", "Report agent"];

const scenes = [
  { context: "Business outcome", title: "Start with the decision",
    detail: "Describe the job in one sentence. A domain expert suggests success criteria you can edit.", lanes: modelGrid },
  { context: "Quick compare", title: "Give two models the same task",
    detail: "Send one approved prompt to local or hosted models. Compare their answers against the same rubric.", lanes: modelGrid },
  { context: "Financial Services · Manufacturing", title: "Run domain-specific use cases",
    detail: "Check whether earnings per share are reported or adjusted. Flag parts that fall outside the drawing’s tolerances.", lanes: domainAgentGrid },
  { context: "Grading · Opik experiments", title: "Score a whole set of cases",
    detail: "Grade a versioned dataset against expert references or your rubric. Compare candidates in Opik.", lanes: modelGrid },
  { context: "Run report", title: "See what supports the verdict",
    detail: "Inspect the case scores alongside response time, token use and measured device power.", lanes: modelGrid },
  { context: "Planned · Hardware in the loop", title: "Test on connected hardware",
    detail: "Evaluate how agents respond to signals from a physical device.", lanes: inspectionGrid },
];
const reducedBannerMotion = matchMedia("(prefers-reduced-motion: reduce)");
let currentScene = 0;
let playing = !reducedBannerMotion.matches;

function outcomeTrack() {
  const steps = [
    ["Business outcome", "Describe the job", "compare"],
    ["Success metrics", "Explore reusable graders", "graders"],
    ["Evaluation runs", "Inspect the evidence", "history"],
    ["Refine & rerun", "Revisit an approved prompt", "prompts"],
  ];
  return '<section class="outcome-track" aria-label="DASH evaluation workflow"><ol>' +
    steps.map(([name, hint, route]) =>
      '<li><a href="#' + route + '"><strong>' + esc(name) + '</strong><small>' + esc(hint) + '</small></a></li>'
    ).join("") + '</ol></section>';
}

function capabilityCopy(scene: (typeof scenes)[number]) {
  return '<h2>' + esc(scene.title) + '</h2><p class="capability-detail">' + esc(scene.detail) + '</p>';
}

function bannerCapabilities() {
  const scene = scenes[currentScene];
  const sizers = scenes.map(item => '<div class="capability-sizer" aria-hidden="true">' +
    capabilityCopy(item) + '</div>').join("");
  const lanes = scene.lanes.map(name => '<div><small>' + esc(name) +
    '</small><span>' + svg("car", "banner-car") + '</span></div>').join("");
  const button = (action: string, label: string, icon: string) => '<button type="button" data-carousel="' + action +
    '" aria-label="' + label + '" title="' + label + '" aria-controls="dash-capability-slide"><span aria-hidden="true">' +
    icon + '</span></button>';
  const position = (currentScene + 1) + " / " + scenes.length;
  return '<section class="capability-reel" aria-roledescription="carousel" aria-label="DASH overview" data-scene="' +
    currentScene + '" data-playing="' + playing + '"><div class="capability-toolbar"><p class="capability-context">' +
    esc(scene.context) + '</p><div class="capability-controls">' +
    button("previous", "Previous slide", "←") + '<span class="capability-position" aria-hidden="true">' + position + '</span>' +
    button("next", "Next slide", "→") + button("playback", playing ? "Pause slideshow" : "Play slideshow", "") +
    '</div></div><div class="capability-slide" id="dash-capability-slide" role="group" aria-roledescription="slide" aria-label="' +
    (currentScene + 1) + ' of ' + scenes.length + '"><div class="capability-frame">' +
    capabilityCopy(scene) + '</div>' + sizers + '</div><div class="banner-track" aria-hidden="true">' +
    lanes + '</div><span class="capability-announcement" role="status" aria-atomic="true"></span></section>';
}

function setPlaying(reel: HTMLElement, value: boolean) {
  playing = value && !reducedBannerMotion.matches;
  reel.dataset.playing = String(playing);
  const button = reel.querySelector<HTMLButtonElement>('[data-carousel="playback"]');
  if (!button) return;
  const label = playing ? "Pause slideshow" : "Play slideshow";
  button.setAttribute("aria-label", label);
  button.title = label;
}

function moveScene(reel: HTMLElement, direction: number, manual: boolean) {
  if (manual) setPlaying(reel, false);
  currentScene = (currentScene + direction + scenes.length) % scenes.length;
  const scene = scenes[currentScene];
  const number = currentScene + 1;
  reel.dataset.scene = String(currentScene);
  const context = reel.querySelector(".capability-context");
  const frame = reel.querySelector(".capability-frame");
  const position = reel.querySelector(".capability-position");
  if (context) context.textContent = scene.context;
  if (frame) frame.innerHTML = capabilityCopy(scene);
  if (position) position.textContent = number + " / " + scenes.length;
  reel.querySelector(".capability-slide")?.setAttribute("aria-label", number + " of " + scenes.length);
  reel.querySelectorAll(".banner-track small").forEach((label, i) => { label.textContent = scene.lanes[i]; });
  const announcement = reel.querySelector(".capability-announcement");
  if (manual && announcement) {
    announcement.textContent = "Slide " + number + " of " + scenes.length + ". " + scene.title;
  }
}


document.addEventListener("click", event => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest<HTMLElement>("[data-carousel]");
  const reel = button?.closest<HTMLElement>(".capability-reel");
  if (!button || !reel) return;
  if (button.dataset.carousel === "playback") setPlaying(reel, !playing);
  else moveScene(reel, button.dataset.carousel === "next" ? 1 : -1, true);
});
document.addEventListener("keydown", event => {
  if (!(event.target instanceof Element)) return;
  const reel = event.target.closest<HTMLElement>(".capability-reel");
  if (!reel || event.altKey || event.ctrlKey || event.metaKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  event.preventDefault();
  moveScene(reel, event.key === "ArrowRight" ? 1 : -1, true);
});
document.addEventListener("focusin", event => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest("[data-carousel]");
  const reel = button?.closest<HTMLElement>(".capability-reel");
  if (reel && button?.matches(":focus-visible")) setPlaying(reel, false);
});
document.addEventListener("animationiteration", event => {
  if (!playing || event.animationName !== "capability-dissolve" || !(event.target instanceof Element) ||
      !event.target.matches(".capability-frame")) return;
  const reel = event.target.closest<HTMLElement>(".capability-reel");
  if (reel) moveScene(reel, 1, false);
});
reducedBannerMotion.addEventListener("change", () => {
  if (!reducedBannerMotion.matches) return;
  playing = false;
  const reel = document.querySelector<HTMLElement>(".capability-reel");
  if (reel) setPlaying(reel, false);
});
