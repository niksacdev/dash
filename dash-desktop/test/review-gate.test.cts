import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const entry = "dash-desktop/scripts/review-gate.mts";
const project = resolve(__dirname, "../../..");
type Snapshot = { parent: string; tree: string };
function sandbox() {
  const temp = mkdtempSync(join(tmpdir(), "dash-review-test-"));
  const repo = join(temp, "repo");
  mkdirSync(join(repo, "dash-desktop/scripts"), { recursive: true });
  mkdirSync(join(repo, ".githooks"));
  copyFileSync(join(project, entry), join(repo, entry));
  copyFileSync(join(project, ".githooks/pre-commit"), join(repo, ".githooks/pre-commit"));
  chmodSync(join(repo, ".githooks/pre-commit"), 0o755);
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  for (const k of ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) delete env[k];
  const git = (args: string[], cwd = repo) => {
    const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git(["init", "-q"]);
  git(["config", "user.name", "Synthetic reviewer"]);
  git(["config", "user.email", "review@example.invalid"]);
  git(["add", "."]);
  git(["commit", "-qm", "Baseline"]);
  const gate = (args: string[], stdin = "", cwd = repo) => spawnSync(process.execPath,
    ["--experimental-strip-types", entry, ...args], { cwd, env, encoding: "utf8", input: stdin });
  const stage = (file: string, content: string) => {
    writeFileSync(join(repo, file), content);
    git(["add", "--", file]);
  };
  return { repo, temp, git, gate, stage, env, close: () => rmSync(temp, { recursive: true, force: true }) };
}
type Sandbox = ReturnType<typeof sandbox>;
function snapshot(s: Sandbox): Snapshot {
  const r = s.gate(["snapshot"]);
  assert.equal(r.status, 0, r.stderr);
  const value: unknown = JSON.parse(r.stdout);
  assert.ok(value && typeof value === "object" && "tree" in value && typeof value.tree === "string"
    && "parent" in value && typeof value.parent === "string");
  return { parent: value.parent, tree: value.tree };
}
function record(s: Sandbox, snap: Snapshot, scope: string, reviewer = scope, findings: string[] = []) {
  return s.gate(["record"], JSON.stringify({ ...snap, scope, reviewer, verdict: findings.length ? "block" : "pass", findings }));
}

test("the actual hook requires three passing independent reviews of the exact index and HEAD", t => {
  const s = sandbox();
  t.after(s.close);
  s.stage("example.ts", "export const count = 1;\n");
  const snap = snapshot(s);
  assert.notEqual(s.gate(["verify"]).status, 0);
  for (const scope of ["security", "quality", "reliability"]) assert.equal(record(s, snap, scope).status, 0);
  writeFileSync(join(s.repo, "example.ts"), "unstaged change\n");
  assert.equal(s.gate(["verify"]).status, 0);
  assert.equal(record(s, snap, "security", "quality").status, 0);
  assert.notEqual(s.gate(["verify"]).status, 0, "one identity cannot sign two roles");
  assert.equal(record(s, snap, "security", "security", ["Missing cancellation cleanup"]).status, 0);
  assert.notEqual(s.gate(["verify"]).status, 0);
  assert.equal(record(s, snap, "security").status, 0);
  s.git(["config", "core.hooksPath", ".githooks"]);
  s.git(["commit", "-qm", "Precisely the staged content"]);
  assert.equal(s.git(["show", "HEAD:example.ts"]), "export const count = 1;");
  assert.notEqual(s.gate(["verify"]).status, 0, "identical index and a different parent require a fresh review");
  s.git(["add", "example.ts"]);
  const second = snapshot(s);
  assert.equal(record(s, second, "security").status, 0);
  s.stage("second.ts", "export const next = 2;\n");
  assert.notEqual(record(s, second, "quality").status, 0, "a stale reviewer cannot stamp the changed index");
  const blocked = spawnSync("git", ["commit", "-qm", "Must fail"], { cwd: s.repo, env: s.env, encoding: "utf8" });
  assert.notEqual(blocked.status, 0);
  assert.equal(s.git(["log", "-1", "--pretty=%s"]), "Precisely the staged content");
});

test("linked worktrees do not share receipts for identical staged trees", t => {
  const s = sandbox();
  t.after(s.close);
  const other = join(s.temp, "linked");
  s.git(["worktree", "add", "-q", "--detach", other, "HEAD"]);
  s.stage("example.md", "New docs\n");
  writeFileSync(join(other, "example.md"), "New docs\n");
  s.git(["add", "example.md"], other);
  const snap = snapshot(s);
  const otherSnapshot = s.gate(["snapshot"], "", other);
  assert.equal(otherSnapshot.status, 0);
  assert.deepEqual(JSON.parse(otherSnapshot.stdout), snap);
  for (const scope of ["security", "quality", "reliability"]) assert.equal(record(s, snap, scope).status, 0);
  assert.notEqual(s.gate(["verify"], "", other).status, 0);
});

test("reviewers can record concurrently during a temporary index lock", async t => {
  const s = sandbox();
  t.after(s.close);
  s.stage("example.md", "Review this file\n");
  const snap = snapshot(s);
  const lock = join(s.repo, ".git", "index.lock");
  writeFileSync(lock, "", { flag: "wx" });
  const release = setTimeout(() => rmSync(lock), 250);
  t.after(() => clearTimeout(release));
  await Promise.all(["security", "quality", "reliability"].map(async scope => {
    const child = spawn(process.execPath, ["--experimental-strip-types", entry, "record"],
      { cwd: s.repo, env: s.env, stdio: ["pipe", "ignore", "pipe"] });
    const closed = once(child, "close");
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.stdin.end(JSON.stringify({ ...snap, scope, reviewer: scope, verdict: "pass", findings: [] }));
    assert.equal((await closed)[0], 0, stderr);
  }));
  assert.equal(s.gate(["verify"]).status, 0);
});
