"use strict";

const modelGrid = ["Open Source", "Frontier Labs", "FineTuned"];
const domainAgentGrid = ["Rules agent v1", "Evidence agent v2", "Review agent v3"];
const inspectionGrid = ["Rule inspector v2", "Drawing reader v1", "Quality check v3"];

const scenes = [
  { context: "Business outcome", title: "Start with the decision",
    detail: "Describe the job in one sentence. A domain expert suggests success criteria you can edit.", lanes: modelGrid },
  { context: "Quick compare", title: "Give two models the same task",
    detail: "Send one approved prompt to local or hosted models. Compare their answers against the same rubric.", lanes: modelGrid },
  { context: "Financial Services · Manufacturing", title: "Run domain-specific use cases",
    detail: "Check whether earnings per share are reported or adjusted. Flag parts that fall outside the drawing’s tolerances.", lanes: domainAgentGrid },
  { context: "Dataset runs · Optional Opik G-Eval", title: "Score a whole set of cases",
    detail: "Run a versioned dataset. Grade each answer against an expert reference or your own rubric.", lanes: modelGrid },
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

function capabilityCopy(scene) {
  return '<h2>' + esc(scene.title) + '</h2><p class="capability-detail">' + esc(scene.detail) + '</p>';
}

function bannerCapabilities() {
  const scene = scenes[currentScene];
  const sizers = scenes.map(item => '<div class="capability-sizer" aria-hidden="true">' +
    capabilityCopy(item) + '</div>').join("");
  const lanes = scene.lanes.map(name => '<div><small>' + esc(name) +
    '</small><span>' + svg("car", "banner-car") + '</span></div>').join("");
  const button = (action, label, icon) => '<button type="button" data-carousel="' + action +
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

function setPlaying(reel, value) {
  playing = value && !reducedBannerMotion.matches;
  reel.dataset.playing = String(playing);
  const button = reel.querySelector('[data-carousel="playback"]');
  const label = playing ? "Pause slideshow" : "Play slideshow";
  button.setAttribute("aria-label", label);
  button.title = label;
}

function moveScene(reel, direction, manual) {
  if (manual) setPlaying(reel, false);
  currentScene = (currentScene + direction + scenes.length) % scenes.length;
  const scene = scenes[currentScene];
  const number = currentScene + 1;
  reel.dataset.scene = String(currentScene);
  reel.querySelector(".capability-context").textContent = scene.context;
  reel.querySelector(".capability-frame").innerHTML = capabilityCopy(scene);
  reel.querySelector(".capability-position").textContent = number + " / " + scenes.length;
  reel.querySelector(".capability-slide").setAttribute("aria-label", number + " of " + scenes.length);
  reel.querySelectorAll(".banner-track small").forEach((label, i) => { label.textContent = scene.lanes[i]; });
  if (manual) {
    reel.querySelector(".capability-announcement").textContent = "Slide " + number + " of " + scenes.length + ". " + scene.title;
  }
}

document.addEventListener("click", event => {
  const button = event.target.closest("[data-carousel]");
  if (!button) return;
  const reel = button.closest(".capability-reel");
  if (button.dataset.carousel === "playback") setPlaying(reel, !playing);
  else moveScene(reel, button.dataset.carousel === "next" ? 1 : -1, true);
});
document.addEventListener("keydown", event => {
  const reel = event.target.closest(".capability-reel");
  if (!reel || event.altKey || event.ctrlKey || event.metaKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  event.preventDefault();
  moveScene(reel, event.key === "ArrowRight" ? 1 : -1, true);
});
document.addEventListener("focusin", event => {
  const button = event.target.closest("[data-carousel]");
  if (button?.matches(":focus-visible")) setPlaying(button.closest(".capability-reel"), false);
});
document.addEventListener("animationiteration", event => {
  if (playing && event.animationName === "capability-dissolve" && event.target.matches(".capability-frame")) {
    moveScene(event.target.closest(".capability-reel"), 1, false);
  }
});
reducedBannerMotion.addEventListener("change", () => {
  if (!reducedBannerMotion.matches) return;
  playing = false;
  const reel = document.querySelector(".capability-reel");
  if (reel) setPlaying(reel, false);
});
