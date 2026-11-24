"use strict";

const modelGrid = ["Open Source", "Frontier Labs", "FineTuned"];
const industryTitle = "Run domain-specific use cases";
const industryExamples = [
  { domain: "Financial Services", decision: "Verify reported EPS", image: "financial" },
  { domain: "Manufacturing", decision: "Check part tolerances", image: "manufacturing" },
  { domain: "Automotive", decision: "Planned · vehicle testing", image: "automotive" },
];

type CapabilityVisual = "objective" | "race" | "industries" | "grading" | "report" | "hardware";
interface CapabilityScene { context: string; title: string; detail: string; visual: CapabilityVisual }

const scenes: readonly CapabilityScene[] = [
  { visual: "objective", context: "Business outcome", title: "Start with the decision",
    detail: "Describe the job. Your domain expert suggests checks you can edit before a run." },
  { visual: "race", context: "Quick compare", title: "Compare and benchmark multiple models",
    detail: "Choose two models per run. Compare their answers to the same prompt against one rubric." },
  { visual: "industries", context: "Domain scenarios", title: industryTitle,
    detail: "Check whether earnings per share are reported or adjusted. Flag parts that fall outside the drawing’s tolerances." },
  { visual: "grading", context: "Dataset grading", title: "Score a whole set of cases",
    detail: "Apply a rubric to each answer in a dataset version. Compare the results in Opik when synced." },
  { visual: "report", context: "Run report · Example", title: "See what supports the verdict",
    detail: "Trace a case score to its grader’s reason. Review latency, tokens and available power readings alongside it." },
  { visual: "hardware", context: "Planned · Hardware in the loop", title: "Test on connected hardware",
    detail: "Replay a sensor reading through an agent and record its response for evaluation." },
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

function capabilityCopy(scene: CapabilityScene) {
  return '<h2>' + esc(scene.title) + '</h2><p class="capability-detail">' + esc(scene.detail) + '</p>';
}

function capabilityIllustration(visual: CapabilityVisual): string {
  if (visual === "industries") return "";
  if (visual === "race") {
    const lanes = modelGrid.map(name => '<div><small>' + esc(name) +
      '</small><span>' + svg("car", "banner-car") + '</span></div>').join("");
    return '<div class="banner-track" aria-hidden="true">' + lanes + '</div>';
  }
  const template = document.getElementById("diagram-" + visual);
  if (!(template instanceof HTMLTemplateElement)) throw new Error("Missing Overview diagram: " + visual);
  return template.innerHTML;
}

function bannerCapabilities() {
  const scene = scenes[currentScene];
  const sizers = scenes.filter(item => item.visual !== "industries").map(item =>
    '<div class="capability-sizer" aria-hidden="true" data-visual="' + item.visual + '">' +
    capabilityCopy(item) + '</div>').join("");
  const button = (action: string, label: string, icon: string) => '<button type="button" data-carousel="' + action +
    '" aria-label="' + label + '" title="' + label + '" aria-controls="dash-capability-slide"><span aria-hidden="true">' +
    icon + '</span></button>';
  const gallery = '<div class="industry-view"><h2>' + esc(industryTitle) +
    '</h2><div class="industry-examples">' + industryExamples.map(({domain, decision, image}) =>
      '<figure><img src="assets/industry-' + image + '.jpg" alt=""><figcaption><strong>' + esc(domain) +
      '</strong><small>' + esc(decision) + '</small></figcaption></figure>').join("") + '</div></div>';
  const position = (currentScene + 1) + " / " + scenes.length;
  return '<section class="capability-reel" aria-roledescription="carousel" aria-label="DASH overview" data-scene="' +
    currentScene + '" data-visual="' + scene.visual + '" data-playing="' + playing + '"><div class="capability-toolbar"><p class="capability-context">' +
    esc(scene.context) + '</p><div class="capability-controls">' +
    button("previous", "Previous slide", "←") + '<span class="capability-position" aria-hidden="true">' + position + '</span>' +
    button("next", "Next slide", "→") + button("playback", playing ? "Pause slideshow" : "Play slideshow", "") +
    '</div></div><div class="capability-slide" id="dash-capability-slide" role="group" aria-roledescription="slide" aria-label="' +
    (currentScene + 1) + ' of ' + scenes.length + '"><div class="capability-standard"><div class="capability-live"><div class="capability-frame">' +
    capabilityCopy(scene) + '</div><div class="capability-illustration">' +
    capabilityIllustration(scene.visual) + '</div></div>' + sizers + '</div>' + gallery + '</div><span class="capability-announcement" role="status" aria-atomic="true"></span></section>';
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
  reel.dataset.visual = scene.visual;
  const context = reel.querySelector(".capability-context");
  const frame = reel.querySelector(".capability-frame");
  const position = reel.querySelector(".capability-position");
  if (context) context.textContent = scene.context;
  if (frame) frame.innerHTML = capabilityCopy(scene);
  if (position) position.textContent = number + " / " + scenes.length;
  reel.querySelector(".capability-slide")?.setAttribute("aria-label", number + " of " + scenes.length);
  const illustration = reel.querySelector(".capability-illustration");
  if (illustration) illustration.innerHTML = capabilityIllustration(scene.visual);
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
