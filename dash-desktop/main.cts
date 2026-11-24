import { app, dialog } from "electron";
import { join } from "node:path";
import { desktopFailure } from "./lib/desktop-errors.cjs";

let opening=false;
let quitting=false;
function startupFailed(error:unknown):void {
  if (quitting) return;
  quitting=true;
  try { dialog.showErrorBox("DASH could not open the workbench",desktopFailure("startup",error)); }
  catch { console.error("DASH could not open the workbench."); }
  finally { app.quit(); }
}

async function showWorkspace():Promise<void> {
  if (opening || quitting || !app.isReady()) return;
  opening=true;
  try {
    // A dependency or workspace read can fail before a renderer exists to show a message.
    const {openWindow,currentWindow}=await import("./desktop.cjs");
    const window=currentWindow();
    if (window && !window.isDestroyed()) {
      window.show();
      window.focus();
    } else {
      await openWindow();
    }
  } catch (error) { startupFailed(error); }
  finally { opening=false; }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance",showWorkspace);
  app.on("activate",showWorkspace);
  app.whenReady().then(() => {
    if (process.platform === "darwin") {
      app.dock?.setIcon(join(__dirname, "ui", "assets", "dash-icon.png"));
      app.setAboutPanelOptions({
        applicationName: "DASH",
        applicationVersion: app.getVersion(),
        credits: "Domain Assessment & Scoring Harness\nTurn a business outcome into a scored model run.",
      });
    }
    return showWorkspace();
  }).catch(startupFailed);
  app.on("before-quit",()=>{quitting=true;});
  app.on("window-all-closed",()=>app.quit());
}
