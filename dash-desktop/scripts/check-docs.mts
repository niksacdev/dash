import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: dirname(fileURLToPath(import.meta.url)), encoding: "utf8",
}).trim();
const tracked = execFileSync("git", ["ls-files", "-z", "--", "*.md"], { cwd: root, encoding: "utf8" });
const errors: string[] = [];
const markdown = tracked.split("\0").filter(Boolean);
for (const file of markdown) {
  const source = resolve(root, file);
  const links = readFileSync(source, "utf8").matchAll(/\[([^\]]*)\]\(([^)\n]+)\)/g);
  for (const [, label, raw] of links) {
    const target = raw.replace(/^<|>$/g, "");
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) continue;
    const relative = target.split(/[?#]/, 1)[0];
    if (!relative) continue;
    try {
      if (existsSync(resolve(dirname(source), decodeURIComponent(relative)))) continue;
      errors.push(file + ": " + label + " links to missing " + relative);
    } catch {
      errors.push(file + ": " + label + " contains an invalid encoded path " + relative);
    }
  }
}
// The last dated event is the current decision. Older events preserve the review history.
const decisionLog = "docs/adr/README.md";
const records = markdown.filter(file => /^docs\/adr\/\d{4}-.+\.md$/.test(file));
const latest = new Map<string, string>();
const identifiers = new Set<string>();
let previousDate = "";
for (const line of readFileSync(resolve(root, decisionLog), "utf8").split("\n")) {
  if (!line.startsWith("|") || line.startsWith("| Date ") || line.startsWith("| ---")) continue;
  const columns = line.split("|").map(cell => cell.trim());
  const [,date,link,event,decision,review] = columns;
  const target = /^\[[^\]]+\]\((\d{4}[-\w]*\.md)\)$/.exec(link || "")?.[1];
  if (!target || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < previousDate ||
      !["Proposed","Accepted","Rejected","Deprecated","Superseded"].includes(event) || !decision || !review?.includes("](")) {
    errors.push(decisionLog + ": invalid or out-of-order decision event: " + line);
    continue;
  }
  previousDate = date;
  latest.set("docs/adr/" + target, event);
}
for (const file of records) {
  const id = file.slice("docs/adr/".length, "docs/adr/".length + 4);
  if (identifiers.has(id)) errors.push(file + ": duplicate ADR identifier " + id);
  identifiers.add(id);
  const status = /^\*\*Status\*\* (\w+)\s*$/m.exec(readFileSync(resolve(root, file), "utf8"))?.[1];
  if (!latest.has(file)) errors.push(file + ": missing from the decision log");
  else if (latest.get(file) !== status) errors.push(file + ": latest decision event does not match the recorded status");
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Repository documentation links and ADR history are consistent.");
}
