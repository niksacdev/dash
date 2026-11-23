"use strict";

// The family mark identifies the model. Hosting comes from its runtime.
function modelFamily(id) {
  const name = id.toLowerCase();
  if (/(^|[/:-])(lfm\d|liquid(?:ai)?\/)/.test(name)) return "liquid";
  if (/(^|[/:-])gemma/.test(name)) return "gemma-color";
  if (/(^|[/:-])qwen/.test(name)) return "qwen-color";
  if (/^(meta|meta-llama)\//.test(name) || /(^|[/:-])llama\d/.test(name)) return "meta-color";
  return null;
}
function displayModel(id) {
  return id.split("/").pop().replace(/[-_:](?=[a-z\d])/gi, " ")
    .replace(/\b(lfm\d+(?:\.\d+)?|\d+(?:\.\d+)?b|a\d+b|qat|gguf|mlx)\b/gi, s => s.toUpperCase())
    .replace(/\b[a-z]/g, s => s.toUpperCase());
}
function hostingLegend() {
  const locations = [
    ["local", "Local", "Runs on your device."],
    ["frontier", "Frontier closed API", "Runs with the model provider."],
    ["private", "Private hosted", "Runs on your own infrastructure."]
  ];
  return '<section class="hosting-key" aria-labelledby="hosting-label"><h2 id="hosting-label">Where models run</h2>' +
    '<div class="hosting-items">' + locations.map(([view,title,caption]) =>
      '<figure><img alt="" src="assets/model-hosting.svg#' + view + '"><figcaption><strong>' + title +
      '</strong><span>' + caption + '</span></figcaption></figure>').join('') + '</div></section>';
}
