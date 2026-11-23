import { cpSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
function copy(relative: string, include?: (source: string) => boolean): void {
  cpSync(join(root, relative), join(root, "dist", relative), {
    recursive: true,
    filter: include,
  });
}
if (process.argv.includes("--tests-only")) {
  copy("test", source => ![".ts", ".cts"].includes(extname(source)));
} else {
  copy("ui", source => ![".ts", ".js"].includes(extname(source)));
  copy("packs");
  if (existsSync(join(root, "agents"))) copy("agents", source => extname(source) !== ".cts");
  if (existsSync(join(root, "lib/opik_judge.py"))) copy("lib/opik_judge.py");
}
