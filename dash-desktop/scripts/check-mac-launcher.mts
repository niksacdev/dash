import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = await mkdtemp(join(tmpdir(), "dash-finder-test-"));
const project = join(temp, "checkout with spaces", "dash-desktop");
const pidFile = join(temp, "electron.pid");

async function shutdownProbe() {
  let pid: number;
  try { pid = Number(await readFile(pidFile, "utf8")); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  // Match both PID and this run's unique checkout before signaling a detached process.
  const ours = () => {
    const checked = spawnSync("ps", ["-p", String(pid), "-o", "command="], {encoding:"utf8"});
    if (checked.error) throw checked.error;
    if (checked.status === 1 && !checked.stdout.trim()) return false;
    assert.equal(checked.status, 0);
    return checked.stdout.trimEnd().endsWith(project + "/") || checked.stdout.trimEnd().endsWith(project);
  };
  for (const signal of [undefined, "SIGTERM", "SIGKILL"] as const) {
    if (!ours()) return;
    if (signal) {
      try { process.kill(pid, signal); }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
    for (let n = 0; n < 20 && ours(); n++) await delay(100);
  }
  assert.ok(!ours(), "The isolated Finder probe must exit before removing its profile");
}
try {
  await mkdir(join(project, "scripts"), { recursive: true });
  await copyFile(join(root, "scripts", "package-mac.mts"), join(project, "scripts", "package-mac.mts"));
  for (const name of ["ui", "node_modules", "dist"]) await symlink(join(root, name), join(project, name), "dir");
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "dash-finder-check", productName: "DASH", main: "probe.cjs" }));
  const profile = join(temp, "profile");
  const receipt = join(temp, "window.json");
  // Run the production main entry point with an isolated profile and capture its first window.
  await writeFile(join(project, "probe.cjs"), `
    const { app } = require("electron");
    const fs = require("node:fs");
    fs.writeFileSync(${JSON.stringify(pidFile + ".tmp")}, String(process.pid));
    fs.renameSync(${JSON.stringify(pidFile + ".tmp")}, ${JSON.stringify(pidFile)});
    setTimeout(() => app.exit(1), 30_000).unref();
    app.setPath("userData", ${JSON.stringify(profile)});
    app.on("browser-window-created", (_, win) => {
      win.show = () => {};
      win.webContents.once("did-finish-load", async () => {
        try {
          const brand = await win.webContents.executeJavaScript(\`(async () => {
            for (let n = 0; n < 50 && !document.querySelector('.hero-purpose'); n++)
              await new Promise(resolve => setTimeout(resolve, 100));
            const image = document.querySelector('.brand img');
            await image.decode();
            return { iconWidth: image.naturalWidth, tagline: document.querySelector('.hero-purpose').textContent };
          })()\`);
          const result = { name: app.getName(), title: win.getTitle(), ...brand };
          fs.writeFileSync(${JSON.stringify(receipt + ".tmp")}, JSON.stringify(result));
          fs.renameSync(${JSON.stringify(receipt + ".tmp")}, ${JSON.stringify(receipt)});
        } catch (error) {
          fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({error:String(error)}));
        } finally { app.quit(); }
      });
    });
    require("./dist/main.cjs");
  `);
  const applications = join(temp, "User Applications");
  execFileSync(process.execPath, ["--experimental-strip-types", join(project, "scripts", "package-mac.mts"), applications], {timeout:60_000});
  const launcher = join(applications, "DASH.app");
  const plist = join(launcher, "Contents", "Info.plist");
  const value = (key:string) => execFileSync("plutil", ["-extract", key, "raw", plist], {encoding:"utf8"}).trim();
  assert.equal(value("CFBundleDisplayName"), "DASH");
  assert.equal(value("CFBundleIdentifier"), "io.github.niksacdev.dash.launcher");
  assert.ok((await stat(join(launcher, "Contents", "Resources", value("CFBundleIconFile")))).size > 0);
  execFileSync("codesign", ["--verify", "--strict", launcher]);
  await mkdir(profile, {recursive:true});
  execFileSync("open", ["-g", "-n", launcher], {timeout:10_000});
  let observed: string | undefined;
  for (let i = 0; i < 150 && !observed; i++) {
    try { observed = await readFile(receipt, "utf8"); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      await delay(200);
    }
  }
  assert.ok(observed, "Finder launcher did not open the DASH window");
  assert.deepEqual(JSON.parse(observed), {
    name: "DASH", title: "DASH — Domain Assessment & Scoring Harness",
    iconWidth: 1024, tagline: "Turn a business outcome into a scored model run.",
  });
  assert.ok((await stat(join(profile, "dash.sqlite"))).isFile());
  console.log("Verified Finder launch, DASH title, logo, tagline and isolated workspace.");
} finally {
  await shutdownProbe();
  await rm(temp, { recursive: true, force: true });
}
