import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("Build the Finder launcher on a Mac.");
const project = fileURLToPath(new URL("../", import.meta.url));
const out = process.argv[2] ? resolve(process.argv[2]) : join(homedir(), "Applications");
await mkdir(out, { recursive: true });
const work = await mkdtemp(join(out, ".dash-launcher-"));
try {
  const app = join(work, "DASH.app");
  const source = join(work, "launch.applescript");
  // The signed launcher's resource points at the checkout whose build produced it.
  await writeFile(source, `on run
    set projectDir to read (path to resource "dash-project.txt") as «class utf8»
    set runtime to projectDir & "/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
    do shell script "test -x " & quoted form of runtime & " && test -f " & quoted form of (projectDir & "/dist/main.cjs")
    do shell script "cd " & quoted form of projectDir & " && " & quoted form of runtime & " " & quoted form of projectDir & " </dev/null >/dev/null 2>&1 &"
end run`);
  execFileSync("osacompile", ["-o", app, source]);
  const resources = join(app, "Contents", "Resources");
  await writeFile(join(resources, "dash-project.txt"), project);
  const iconset = join(work, "DASH.iconset");
  await mkdir(iconset);
  const png = join(project, "ui", "assets", "dash-icon.png");
  for (const points of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const name = `icon_${points}x${points}${scale === 2 ? "@2x" : ""}.png`;
      execFileSync("sips", ["-Z", String(points * scale), png, "--out", join(iconset, name)]);
    }
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(resources, "DASH.icns")]);
  const plist = join(app, "Contents", "Info.plist");
  for (const [key, value] of Object.entries({
    CFBundleName: "DASH", CFBundleDisplayName: "DASH", CFBundleIdentifier: "io.github.niksacdev.dash.launcher",
    CFBundleIconFile: "DASH.icns",
  })) execFileSync("plutil", ["-replace", key, "-string", value, plist]);
  execFileSync("plutil", ["-replace", "LSUIElement", "-bool", "YES", plist]);
  execFileSync("codesign", ["--force", "--sign", "-", "--options", "runtime", app]);
  execFileSync("codesign", ["--verify", "--strict", app]);
  const target = join(out, "DASH.app");
  try {
    await rename(app, target);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error.code === "EEXIST" || error.code === "ENOTEMPTY"))) throw error;
    const priorId = execFileSync("plutil", ["-extract", "CFBundleIdentifier", "raw", join(target, "Contents", "Info.plist")], {encoding:"utf8"}).trim();
    if (priorId !== "io.github.niksacdev.dash.launcher") throw new Error("An unrelated app already occupies " + target);
    execFileSync("osascript", ["-l", "JavaScript", "-e", `ObjC.import("Foundation");
function run(argv) {
  const manager = $.NSFileManager.defaultManager;
  const source = $.NSURL.fileURLWithPath(argv[0]);
  const target = $.NSURL.fileURLWithPath(argv[1]);
  const error = Ref();
  if (!manager.replaceItemAtURLWithItemAtURLBackupItemNameOptionsResultingItemURLError(target, source, ObjC.unwrap($.NSUUID.UUID.UUIDString), 1, Ref(), error)) {
    throw Error(ObjC.unwrap(error[0].localizedDescription));
  }
}`, app, target]);
  }
  execFileSync("codesign", ["--verify", "--strict", target]);
  console.log("Finder launcher ready: " + target);
} finally {
  await rm(work, { recursive: true, force: true });
}
