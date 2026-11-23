const { app } = require("electron");
const { openWindow, currentWindow } = require("./desktop.cjs");

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    const win = currentWindow();
    if (win) {
      win.show();
      win.focus();
    }
  });
  app.whenReady().then(openWindow);
  app.on("activate", () => {
    if (!currentWindow() && app.isReady()) openWindow();
  });
  app.on("window-all-closed", () => app.quit());
}
