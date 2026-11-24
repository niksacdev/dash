import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Scope = "security" | "quality" | "reliability";
const scopes: Scope[] = ["security", "quality", "reliability"];
interface Snapshot { parent: string; tree: string }
interface Receipt extends Snapshot { scope: Scope; reviewer: string; verdict: "pass" | "block" }
interface Review extends Receipt { findings: string[] }

const git = (args: string[], input?: string): string =>
  execFileSync("git", args, { encoding: "utf8", input, maxBuffer: 8 * 1024 * 1024 });
const maxJson = 32 * 1024;
const instructions = "Have three independent Codex session reviewers inspect the staged snapshot and submit their verdicts with record.";
async function snapshot(): Promise<Snapshot> {
  const head = spawnSync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { encoding: "utf8" });
  if (head.status !== 0 && head.status !== 1) throw Error("Cannot resolve the commit parent.");
  const parent = head.status === 0 ? head.stdout.trim() : git(["hash-object", "-t", "tree", "-w", "--stdin"], "").trim();
  // Concurrent reviewers briefly contend for Git's index lock when materializing the same tree.
  for (let attempt = 0; ; attempt++) {
    const tree = spawnSync("git", ["write-tree"], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
    if (tree.status === 0) return { parent, tree: tree.stdout.trim() };
    const message = tree.stderr || tree.error?.message || "Cannot resolve the staged tree.";
    if (attempt === 10 || !/index\.lock[^\n]*File exists/.test(message)) throw Error(message);
    await delay(40 * (attempt + 1));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseReceipt(raw: unknown, expected: Snapshot): Receipt {
  if (!isRecord(raw) || raw.parent !== expected.parent || raw.tree !== expected.tree)
    throw Error("Review does not match the current HEAD and staged tree. " + instructions);
  const { scope, reviewer, verdict } = raw;
  if ((scope !== "security" && scope !== "quality" && scope !== "reliability") ||
      typeof reviewer !== "string" || !/^[\w./:@-]{1,128}$/.test(reviewer) ||
      (verdict !== "pass" && verdict !== "block"))
    throw Error("Invalid review scope, reviewer identity or verdict.");
  return { ...expected, scope, reviewer, verdict };
}
function parseReview(raw: unknown, expected: Snapshot): Review {
  const receipt = parseReceipt(raw, expected);
  if (!isRecord(raw) || Object.keys(raw).length !== 6 || !Array.isArray(raw.findings) ||
      raw.findings.length > 32 || !raw.findings.every((s: unknown) => typeof s === "string" && s.trim() && s.length <= 1500) ||
      (receipt.verdict === "pass") !== (raw.findings.length === 0))
    throw Error("A pass requires zero blocking findings. A block requires specific findings.");
  return { ...receipt, findings: raw.findings };
}
async function smallJson(file: string): Promise<unknown> {
  if ((await stat(file)).size > maxJson) throw Error("Review response too large.");
  return JSON.parse(await readFile(file, "utf8"));
}
function receiptDir(): string {
  return git(["rev-parse", "--path-format=absolute", "--git-path", "dash-reviews"]).trim();
}
async function record(review: Review) {
  const receipt = parseReceipt(review, await snapshot());
  const dir = receiptDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, randomUUID());
  try {
    await writeFile(temp, JSON.stringify(receipt), { flag: "wx", mode: 0o600 });
    await rename(temp, join(dir, receipt.scope + ".json"));
  } finally {
    await rm(temp, { force: true });
  }
}
async function verify() {
  const expected = await snapshot();
  const reviewers = new Set<string>();
  for (const scope of scopes) {
    let raw: unknown;
    try { raw = await smallJson(join(receiptDir(), scope + ".json")); }
    catch { throw Error("Missing or unreadable " + scope + " review. " + instructions); }
    const receipt = parseReceipt(raw, expected);
    if (receipt.scope !== scope || receipt.verdict !== "pass" || reviewers.has(receipt.reviewer))
      throw Error("Three distinct passing reviewers are required. Check the " + scope + " review. " + instructions);
    reviewers.add(receipt.reviewer);
  }
  console.log("All three reviews passed for " + expected.tree + ".");
}
async function main() {
  switch (process.argv[2]) {
    case "snapshot": console.log(JSON.stringify(await snapshot())); break;
    case "record": {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of process.stdin) {
        const b = Buffer.from(chunk);
        if ((bytes += b.length) > maxJson) throw Error("Review response too large.");
        chunks.push(b);
      }
      await record(parseReview(JSON.parse(Buffer.concat(chunks).toString("utf8")), await snapshot()));
      break;
    }
    case "verify": await verify(); break;
    default: throw Error("Usage: review-gate.mts snapshot | record | verify");
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Review gate failed.");
  process.exitCode = 1;
});
