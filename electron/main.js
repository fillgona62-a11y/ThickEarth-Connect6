/**
 * ThickEarth native desktop shell (Electron).
 *
 * The game server, SQLite database and web assets are all local. Electron only
 * provides a normal application window and process lifecycle; it is not a
 * hosted web page and does not require a browser or network access.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../server/index.js";

// The npm "electron" entrypoint is CJS path discovery, so ESM import does not
// expose the runtime API. createRequire is the supported ESM bridge.
const require = createRequire(import.meta.url);
const { app, BrowserWindow, Menu, dialog, shell } = require("electron");
const APP_NAME = "ThickEarth";
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_APP_DATA = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const APP_DATA = path.join(LOCAL_APP_DATA, APP_NAME);
const DATA_DIR = path.join(APP_DATA, "data");
const LOG_DIR = path.join(APP_DATA, "logs");
const DB_PATH = path.join(DATA_DIR, "thick-earth.db");
const LOG_FILE = path.join(LOG_DIR, "app.log");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

function log(level, message) {
  const line = new Date().toISOString() + " [" + level + "] " + message;
  try {
    fs.appendFileSync(LOG_FILE, line + "\n", "utf8");
  } catch {
    // Logging must never take the app down.
  }
  if (process.stdout?.isTTY) console.log(line);
}

const logger = {
  info: (message) => log("INFO", message),
  warn: (message) => log("WARN", message),
  error: (message) => log("ERROR", message)
};

let serverInstance = null;
let mainWindow = null;
let quitting = false;

log("INFO", "shell starting (pid " + process.pid + ")");
app.setName(APP_NAME);
if (process.platform === "win32") app.setAppUserModelId("com.thickearth.app");

function getIconPath() {
  return path.join(APP_ROOT, "desktop", "assets", "thick-earth.ico");
}

function focusMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function createMainWindow() {
  const icon = getIconPath();
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: "#0b0f14",
    title: APP_NAME,
    icon: fs.existsSync(icon) ? icon : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });
  mainWindow = win;

  // Keep the native title stable; the SPA's document.title changes per route.
  win.on("page-title-updated", (event) => {
    event.preventDefault();
    win.setTitle(APP_NAME);
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://127.0.0.1:")) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("http://127.0.0.1:")) event.preventDefault();
  });

  await win.loadURL("http://127.0.0.1:" + serverInstance.port + "/");
  return win;
}

async function boot() {
  const hasLock = app.requestSingleInstanceLock();
  log("INFO", "single-instance lock: " + hasLock);
  if (!hasLock) {
    app.quit();
    return;
  }
  app.on("second-instance", focusMainWindow);
  await app.whenReady();
  log("INFO", "app ready");
  Menu.setApplicationMenu(null);
  process.env.THICK_EARTH_VERSION = app.getVersion();

  serverInstance = await startServer({
    mode: "desktop",
    host: "127.0.0.1",
    port: 0,
    dbPath: DB_PATH,
    staticDir: path.join(APP_ROOT, "web"),
    sharedDir: path.join(APP_ROOT, "shared"),
    secureCookies: false,
    logger
  });
  logger.info("server listening on http://127.0.0.1:" + serverInstance.port + "/");
  logger.info("data directory: " + APP_DATA);
  await createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createMainWindow();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  if (quitting || !serverInstance) return;
  quitting = true;
  serverInstance.close().catch((error) => logger.error("server close failed: " + error.message));
});

boot().catch((error) => {
  logger.error("startup failed: " + (error && error.stack ? error.stack : String(error)));
  dialog.showErrorBox(APP_NAME, "ThickEarth could not start.\n\n" + (error && error.message ? error.message : String(error)));
  app.quit();
});
