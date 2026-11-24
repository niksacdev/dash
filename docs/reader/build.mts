import { execFileSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const book = dirname(fileURLToPath(import.meta.url));
const root = resolve(book, "../..");
const parent = join(root, "dist");
const site = join(parent, "reader");
const section = "/dash/";
const source = join(book, "src");
const sample = "bearing-inspection.jsonl";
const summary = readFileSync(join(source, "SUMMARY.md"), "utf8");
const chapters = Array.from(summary.matchAll(/\]\(([\w-]+\.md)\)/g), match => match[1]);
const quickSetup = "quick-evaluation-setup.png";
const inputs = new Set(["SUMMARY.md", sample, quickSetup, ...chapters]);
if (!chapters.includes("index.md")) throw Error("The reader needs a landing page.");
for (const entry of readdirSync(source, { withFileTypes: true })) {
  if (!entry.isFile() || !inputs.has(entry.name)) throw Error("Unlisted reader input: " + entry.name);
}
for (const file of inputs) {
  const path = join(source, file);
  if (!lstatSync(path).isFile()) throw Error("Missing reader input: " + file);
  if (file.endsWith(".md")) {
    for (const directive of readFileSync(path, "utf8").matchAll(/\{\{\s*#[^}]+\}\}/g)) {
      if (directive[0] !== "{{#include bearing-inspection.jsonl:1}}") throw Error("Unlisted include in " + file);
    }
  }
}

function filesIn(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.name.startsWith(".") && entry.name !== ".nojekyll") throw Error("Hidden generated entry: " + entry.name);
    if (entry.isDirectory()) return filesIn(path);
    if (!entry.isFile()) throw Error("Unexpected generated entry: " + entry.name);
    return [path];
  });
}

// mdBook emits quoted href/src attributes and explicit IDs for chapter headings.
function verifyLinks(output: string) {
  const files = new Set(filesIn(output).map(file => relative(output, file).split(sep).join("/")));
  const ids = new Map<string, Set<string>>();
  const links = new Map<string, string[]>();
  for (const path of files) {
    if (!path.endsWith(".html")) continue;
    const html = readFileSync(join(output, path), "utf8");
    ids.set(path, new Set(Array.from(html.matchAll(/\bid="([^"]+)"/g), match => match[1])));
    links.set(path, Array.from(html.matchAll(/\b(?:href|src)="([^"]+)"/g), match => match[1]));
  }
  for (const [from, refs] of links) {
    for (const ref of refs) {
      const url = new URL(ref.replaceAll("&amp;", "&"), "https://niksacdev.github.io" + section + from);
      if (url.origin !== "https://niksacdev.github.io") continue;
      const path = decodeURIComponent(url.pathname.slice(section.length)) || "index.html";
      if (!url.pathname.startsWith(section) || !files.has(path) ||
          (url.hash && !ids.get(path)?.has(decodeURIComponent(url.hash.slice(1))))) {
        throw Error("Broken reader link in " + from + ": " + ref);
      }
    }
  }
  for (const chapter of chapters) {
    const page = chapter.replace(/\.md$/, ".html");
    const editLink = "https://github.com/niksacdev/dash/edit/main/docs/reader/src/" + chapter;
    if (!links.get(page)?.includes(editLink)) throw Error("Missing chapter or source edit link: " + chapter);
  }
  for (const required of ["searchindex.js", sample, quickSetup, "LICENSE.txt", "NOTICE.txt", "circuit.jpg"]) {
    if (!files.has(required)) throw Error("Missing reader asset: " + required);
  }
}

const mdbook = process.env.MDBOOK || "mdbook";
if (execFileSync(mdbook, ["--version"], { encoding: "utf8" }).trim() !== "mdbook v0.5.4") {
  throw Error("Install mdBook 0.5.4 to match the Pages workflow.");
}
mkdirSync(parent, { recursive: true });
const output = mkdtempSync(join(parent, "reader-build-"));
try {
  execFileSync(mdbook, ["build", book, "--dest-dir", output], { stdio: "inherit" });
  copyFileSync(join(root, "dash-desktop/ui/assets/scarlet-circuit.jpg"), join(output, "circuit.jpg"));
  for (const name of ["LICENSE", "NOTICE"]) copyFileSync(join(root, name), join(output, name + ".txt"));
  verifyLinks(output);
  rmSync(site, { recursive: true, force: true });
  renameSync(output, site);
  console.log("Verified " + chapters.length + " reader pages in " + site);
} finally {
  rmSync(output, { recursive: true, force: true });
}
