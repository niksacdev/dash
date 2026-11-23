import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: dirname(fileURLToPath(import.meta.url)), encoding: "utf8",
}).trim();
const tracked = execFileSync("git", ["ls-files", "-z", "--", "*.md"], { cwd: root, encoding: "utf8" });
const errors: string[] = [];
for (const file of tracked.split("\0").filter(Boolean)) {
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
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Repository documentation links resolve.");
}
