/**
 * Optional browser-level smoke check: render the real app in headless Chrome/Edge.
 *
 *   npm run test:browser
 *
 * Uses only Node built-ins and a locally installed browser. When no browser is
 * found it prints SKIP and exits 0, so it never breaks a machine without one.
 * The committed `node --test` suite covers the same render paths without a
 * browser; this script is for catching CSS/DOM/runtime issues a shim cannot.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../server/index.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = Number(process.env.BROWSER_SMOKE_PORT ?? 8902);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ].filter(Boolean);
  return candidates.find((path) => existsSync(path)) ?? null;
}

const browser = findBrowser();
if (!browser) {
  console.log("SKIP: no Chrome/Edge found. Set CHROME_PATH to run this check.");
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), "thickearth-browser-"));
const profile = join(tmp, "profile");
const dbPath = join(tmp, "smoke.db");
let server;
let chrome;
let ws;
let nextId = 1;
const pending = new Map();
const exceptions = [];

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}
async function evaluate(expression) {
  const out = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return out?.result?.result?.value ?? null;
}

try {
  server = await startServer({
    mode: "web", host: "127.0.0.1", port: PORT, dbPath,
    publicOrigin: BASE, secureCookies: false,
    env: { ...process.env, AI_SHARED_LLM: "1", AI_SHARED_USER_EMAIL: "smoke@example.com" },
    logger: { info() {}, warn() {}, error() {} }
  });

  chrome = spawn(browser, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--no-proxy-server", "--remote-debugging-port=0", "--user-data-dir=" + profile, "about:blank"
  ], { stdio: "ignore" });

  let cdpPort = null;
  for (let i = 0; i < 60; i += 1) {
    const marker = join(profile, "DevToolsActivePort");
    if (existsSync(marker)) {
      cdpPort = Number(readFileSync(marker, "utf8").split("\n")[0]);
      if (cdpPort) break;
    }
    await sleep(200);
  }
  if (!cdpPort) throw new Error("Chrome DevTools port file was not created");

  let wsUrl = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      wsUrl = list.find((target) => target.type === "page")?.webSocketDebuggerUrl ?? null;
      if (wsUrl) break;
    } catch { /* not ready */ }
    await sleep(200);
  }
  if (!wsUrl) throw new Error("Chrome DevTools did not become ready");

  ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
    if (message.method === "Runtime.exceptionThrown") {
      exceptions.push(message.params?.exceptionDetails?.exception?.description
        || message.params?.exceptionDetails?.text || "unknown");
    }
  };
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: BASE + "/" });
  await sleep(2200);

  const homeLength = await evaluate("document.body.innerHTML.length");
  const registered = await evaluate(`fetch('/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'smoke@example.com',password:'SmokeCheck2026!',displayName:'Smoke'})}).then(r=>r.status)`);
  await evaluate("location.hash = '#/settings'");
  await sleep(1800);
  const settingsText = await evaluate("(document.querySelector('#main-content')||document.body).innerText");
  const settingsLength = await evaluate("document.body.innerHTML.length");
  const navOrder = await evaluate("Array.from(document.querySelectorAll('.main-nav a')).map(a => a.getAttribute('href')).slice(-2).join(',')");

  // Exercise the actual report UI as a registered user borrowing a model.
  // mock://local stays inside the app; no external provider is contacted.
  const finished = await evaluate(`(async () => {
    const call = async (path, body, method = 'POST') => {
      const r = await fetch(path, {method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
      const data = await r.json();
      if (!r.ok) throw new Error(data.error?.code || String(r.status));
      return data;
    };
    await call('/api/ai/settings', {enabled:true, provider:'custom', baseUrl:'mock://local', model:'coach-smoke', apiKey:'smoke-test-key'}, 'PUT');
    await call('/api/auth/register', {email:'smoke-guest@example.com', password:'SmokeCheck2026!', displayName:'Guest'});
    const {game} = await call('/api/games', {mode:'local', playerCount:2, seats:[{kind:'human'}, {kind:'human'}]});
    for (const [x,y] of [[0,9],[10,0],[11,0],[1,9],[2,9],[10,1],[11,1],[3,9],[0,0],[10,2],[11,2],[4,9],[5,9]]) {
      await call('/api/games/' + game.id + '/actions', {action:{type:'place',x,y}});
    }
    return game.id;
  })()`);
  if (typeof finished !== "string") throw new Error("Could not create browser review fixture");
  await send("Page.navigate", { url: BASE + "/#/game/" + encodeURIComponent(finished) });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const generated = await evaluate(`(() => {
      const button = document.querySelector('.postgame-analysis .analysis-empty button');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (generated) break;
    await sleep(100);
  }
  let reviewText = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    reviewText = await evaluate("document.querySelector('.postgame-analysis')?.innerText || ''");
    if (String(reviewText).includes("E10 F10")) break;
    await sleep(100);
  }
  const sharedCoach = await evaluate("document.querySelector('.coach-card')?.innerText.includes('coach-smoke') && document.querySelector('.coach-card')?.innerText.includes('共享模型')");
  await evaluate("document.querySelector('.coach-empty-state button')?.click()");
  let reportReady = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    reportReady = await evaluate("Boolean(document.querySelector('.coach-report .coach-headline'))");
    if (reportReady) break;
    await sleep(100);
  }
  await evaluate("document.querySelector('.postgame-analysis a[href$=\"?turn=6\"]')?.click()");
  let replayStep = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    replayStep = await evaluate("document.querySelector('.replay-layout .move-log-item.is-current .move-log-seq')?.textContent || ''");
    if (String(replayStep).trim() === "9") break;
    await sleep(100);
  }

  console.log("home html length:", homeLength);
  console.log("register status:", registered);
  console.log("settings html length:", settingsLength);
  console.log("settings has cards:", /AI Agent|语言|站点管理/.test(String(settingsText)));
  console.log("settings follows rules:", navOrder === "#/rules,#/settings");
  console.log("review names the two-stone finish:", String(reviewText).includes("E10 F10"));
  console.log("coach uses the shared model:", sharedCoach);
  console.log("coach report rendered:", reportReady);
  console.log("replay opens before turn 6:", String(replayStep).trim() === "9");
  console.log("uncaught exceptions:", exceptions.length);
  for (const error of exceptions.slice(0, 3)) console.log("  !", error.slice(0, 160));

  const pass = homeLength > 1000 && registered === 201
    && settingsLength > 2000 && /AI Agent|语言/.test(String(settingsText))
    && navOrder === "#/rules,#/settings"
    && String(reviewText).includes("E10 F10") && !String(reviewText).includes("棋型差值变化")
    && sharedCoach && reportReady && String(replayStep).trim() === "9"
    && exceptions.length === 0;
  console.log(pass ? "RESULT: PASS" : "RESULT: FAIL");
  if (!pass) process.exitCode = 1;
} catch (error) {
  console.error("RESULT: ERROR -", error.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  try { chrome?.kill(); } catch { /* ignore */ }
  try { await server?.close(); } catch { /* ignore */ }
  await sleep(400);
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}
