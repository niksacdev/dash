import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const root = fileURLToPath(new URL("../../", import.meta.url));
function copy(relative: string, include?: (source: string) => boolean): void {
  cpSync(join(root, relative), join(root, "dist", relative), {
    recursive: true,
    filter: include,
  });
}
// A regular build must never ship old test code. The test build compiles it afterwards.
rmSync(join(root, "dist", "test"), { recursive: true, force: true });
copy("ui", source => ![".ts", ".js"].includes(extname(source)));
const manifest: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const { version } = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/) }).parse(manifest);
let revision = "";
if (existsSync(join(root, "..", ".git"))) {
  const git = spawnSync("git", ["describe", "--always", "--exclude=*", "--abbrev=8", "--dirty=-modified"], {
    cwd: root, encoding: "utf8", timeout: 2000, windowsHide: true,
  });
  const id = git.stdout?.trim() ?? "";
  if (git.status === 0 && /^[a-f0-9]{8,64}(?:-modified)?$/.test(id)) revision = " · build " + id;
}
const index = join(root, "dist", "ui", "index.html");
writeFileSync(index, readFileSync(index, "utf8").replaceAll("{{DASH_VERSION}}", version).replace("{{DASH_REVISION}}", revision));
for (const file of ["LICENSE", "NOTICE"]) {
  cpSync(join(root, "..", file), join(root, "dist", file));
}
copy("packs");
copy("agents", source => extname(source) !== ".cts");
if (existsSync(join(root, "lib/opik_judge.py"))) copy("lib/opik_judge.py");
