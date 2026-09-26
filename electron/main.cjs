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

function projectRoot() {
  const packaged = path.join(process.resourcesPath || "", "devden");
  if (fs.existsSync(path.join(packaged, "server", "index.js"))) return packaged;
  return path.resolve(__dirname, "..");
}

function getJson(pathname) {
  return new Promise((resolve) => {
    const req = http.get(`http://${HOST}:${PORT}${pathname}`, (res) => {
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
  serverLog = fs.openSync(logPath, "a");
  serverChild = spawn(process.env.DEVDEN_NODE || "node", [path.join(root, "server", "index.js")], {
    cwd: root,
    env: { ...process.env, DEVDEN_HOST: HOST, DEVDEN_PORT: PORT },
    stdio: ["ignore", serverLog, serverLog],
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

function openWindow() {
  const icon = path.join(__dirname, "icon.png");
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    title: "DevDen",
    backgroundColor: "#1d1b18",
    icon: fs.existsSync(icon) ? icon : undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
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
    if (badgeTimer) clearInterval(badgeTimer);
    setBadge(0);
    if (startedByUs && serverChild && !serverChild.killed) serverChild.kill("SIGTERM");
    if (serverLog != null) fs.closeSync(serverLog);
  });

  app.on("window-all-closed", () => {
    app.quit();
  });
}
