const { app, BrowserWindow, shell } = require("electron");
const path = require("node:path");
const APP_URL = process.env.DAMMPULSE_DESKTOP_URL || "https://tarik-ab.github.io/damm-pulse/";
const API_URL = process.env.DAMMPULSE_API_URL || "https://dammpulse-api-production.up.railway.app";
function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 940, minWidth: 980, minHeight: 680,
    title: "DammPulse 360", backgroundColor: "#f4f3ed", autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(APP_URL)) {
      event.preventDefault();
      if (url.startsWith("https://") || url.startsWith("http://")) shell.openExternal(url);
    }
  });
  win.loadURL(APP_URL);
}
app.whenReady().then(() => {
  process.env.DAMMPULSE_API_URL = API_URL;
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
