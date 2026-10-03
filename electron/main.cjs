"use strict";

const { app, BrowserWindow, dialog } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const HOST = process.env.DEVDEN_HOST || "127.0.0.1";
const PORT = String(process.env.DEVDEN_PORT || "4319");

let mainWindow = null;
let serverChild = null;
let serverLog = null;
let startedByUs = false;
let spawnError = null;
let badgeTimer = null;
let lastPending = 0;

// Finder-launched apps get a bare PATH; borrow the login shell's so node and agent CLIs resolve.
function loadShellPath() {
  if (process.platform !== "darwin") return;
  try {
    const out = require("node:child_process").execFileSync(process.env.SHELL || "/bin/zsh", ["-ilc", 'printf "__P__%s" "$PATH"'], {
      encoding: "utf8",
      timeout: 5000,
    });
    const shellPath = out.split("__P__").pop().trim();
    if (shellPath) process.env.PATH = shellPath;
  } catch {}
}

let quitting = false;

// A local Deploy of a devden checkout writes its path here, so the app serves
// that fresh build instead of the copy bundled at install time.
function relaunchFile() {
  return path.join(app.getPath("userData"), "server-root");
}

function projectRoot() {
  try {
    const deployed = fs.readFileSync(relaunchFile(), "utf8").trim();
    if (
      fs.existsSync(path.join(deployed, "server", "index.js")) &&
      fs.existsSync(path.join(deployed, "dist", "index.html"))
    )
      return deployed;
  } catch {}
  const packaged = path.join(process.resourcesPath || "", "devden");
  if (fs.existsSync(path.join(packaged, "server", "index.js"))) return packaged;
  return path.resolve(__dirname, "..");
}

function getJson(pathname) {
  return new Promise((resolve) => {
    const req = http.get(`http://${HOST}:${PORT}${pathname}`, {
      headers: process.env.DEVDEN_TOKEN
        ? { Authorization: `Bearer ${process.env.DEVDEN_TOKEN.trim()}` }
        : {},
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(500, () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function waitForHealth() {
  for (let i = 0; i < 50; i += 1) {
    const health = await getJson("/api/health");
    if (health?.ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function startServer() {
  const root = projectRoot();
  const logPath = path.join(app.getPath("userData"), "server.log");
  if (serverLog != null) fs.closeSync(serverLog);
  serverLog = fs.openSync(logPath, "a");
  serverChild = spawn(process.env.DEVDEN_NODE || "node", [path.join(root, "server", "index.js")], {
    cwd: root,
    env: {
      ...process.env,
      DEVDEN_HOST: HOST,
      DEVDEN_PORT: PORT,
      DEVDEN_RELAUNCH_FILE: relaunchFile(),
    },
    stdio: ["ignore", serverLog, serverLog],
  });
  // Deploy SIGTERMs the server to pick up the new build; we are its
  // supervisor, so bring it back (the page reloads itself once it answers).
  const bootedAt = Date.now();
  serverChild.on("exit", () => {
    // Died within seconds of boot = broken build, not a deploy restart.
    if (!quitting && Date.now() - bootedAt > 3000) startServer();
  });
  serverChild.on("error", (error) => {
    spawnError = error;
  });
  startedByUs = true;
  return logPath;
}

async function ensureServer() {
  if (await getJson("/api/health")) return null;
  const logPath = startServer();
  if (await waitForHealth()) return null;
  if (spawnError?.code === "ENOENT") {
    return "DevDen needs Node.js on your PATH. Install Node, then open DevDen again.";
  }
  return `DevDen could not start. If port ${PORT} is taken, set DEVDEN_PORT.\nLog: ${logPath}`;
}

function setBadge(count) {
  if (process.platform !== "darwin" || !app.dock) return;
  app.dock.setBadge(count > 0 ? String(count) : "");
  if (count > 0 && lastPending === 0) app.dock.bounce("informational");
  lastPending = count;
}

async function pollApprovals() {
  const body = await getJson("/api/attention");
  setBadge(Number(body?.pendingApprovals) || 0);
}

function browserWindowOptions() {
  const icon = path.join(__dirname, "icon.png");
  return {
    width: 1280,
    height: 840,
    title: "DevDen",
    backgroundColor: "#1d1b18",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    icon: fs.existsSync(icon) ? icon : undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  };
}

// Chromium doesn't keep Cmd+/Cmd- zoom across launches here, so we save it ourselves.
const zoomFile = () => path.join(app.getPath("userData"), "zoom-level");

function attachChrome(win) {
  win.on("close", () => {
    try {
      fs.writeFileSync(zoomFile(), String(win.webContents.getZoomLevel()));
    } catch {}
  });
  win.webContents.on("did-finish-load", () => {
    try {
      const level = Number(fs.readFileSync(zoomFile(), "utf8"));
      if (Number.isFinite(level)) win.webContents.setZoomLevel(level);
    } catch {}
    void win.webContents.executeJavaScript(
      "document.documentElement.classList.add('is-electron')",
    );
    void win.webContents.insertCSS(
      "html.is-electron .sidebar__brand-row,html.is-electron .conversation-header{-webkit-app-region:drag}" +
        "html.is-electron .sidebar__brand-row button,html.is-electron .sidebar__brand-row a," +
        "html.is-electron .conversation-header button,html.is-electron .conversation-header a," +
        "html.is-electron .conversation-header input{-webkit-app-region:no-drag}",
    );
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    const child = new BrowserWindow(browserWindowOptions());
    attachChrome(child);
    if (url) child.loadURL(url);
    return { action: "deny" };
  });
}

function openWindow() {
  mainWindow = new BrowserWindow(browserWindowOptions());
  attachChrome(mainWindow);
  const cwd = encodeURIComponent(process.env.DEVDEN_CWD || os.homedir());
  mainWindow.loadURL(`http://${HOST}:${PORT}/?cwd=${cwd}`);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    loadShellPath();
    const failure = await ensureServer();
    if (failure) {
      dialog.showErrorBox("DevDen", failure);
      app.quit();
      return;
    }
    openWindow();
    await pollApprovals();
    badgeTimer = setInterval(() => {
      void pollApprovals();
    }, 2000);
  });

  app.on("before-quit", () => {
    quitting = true;
    if (badgeTimer) clearInterval(badgeTimer);
    setBadge(0);
    if (startedByUs && serverChild && !serverChild.killed) serverChild.kill("SIGTERM");
    if (serverLog != null) fs.closeSync(serverLog);
  });

  app.on("window-all-closed", () => {
    app.quit();
  });
}
