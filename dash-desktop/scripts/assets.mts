import { cpSync, existsSync, rmSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
copy("packs");
copy("agents", source => extname(source) !== ".cts");
if (existsSync(join(root, "lib/opik_judge.py"))) copy("lib/opik_judge.py");
