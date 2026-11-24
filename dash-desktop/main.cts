import { app } from "electron";
import { join } from "node:path";
import { openWindow, currentWindow } from "./desktop.cjs";

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    const win = currentWindow();
    if (win) {
      win.show();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    if (process.platform === "darwin") {
      app.dock?.setIcon(join(__dirname, "ui", "assets", "dash-icon.png"));
      app.setAboutPanelOptions({
        applicationName: "DASH",
        applicationVersion: app.getVersion(),
        credits: "Domain Assessment & Scoring Harness\nTurn a business outcome into a scored model run.",
      });
    }
    return openWindow();
  });
  app.on("activate", () => {
    if (!currentWindow() && app.isReady()) openWindow();
  });
  app.on("window-all-closed", () => app.quit());
}
