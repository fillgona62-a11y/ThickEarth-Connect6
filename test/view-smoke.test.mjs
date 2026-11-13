/**
 * View smoke test: render the Settings page in a minimal DOM shim.
 *
 * The 2026-11-13 blank-page incident was a ReferenceError inside a render
 * branch. Backend tests cannot catch that, so this renders the real view with
 * a signed-in administrator session and fails on any thrown exception.
 * No DOM library is used — the project intentionally has zero dependencies.
 */
import test from "node:test";
import assert from "node:assert/strict";

class FakeNode {
  constructor(tag = "div") {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
    this.textContent = "";
    this.innerHTML = "";
    this.className = "";
  }
  get firstChild() { return this.children[0] ?? null; }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { for (const child of children) this.children.push(child); }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    return child;
  }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener() {}
  removeEventListener() {}
  contains() { return false; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  insertBefore(node) { this.children.unshift(node); return node; }
  focus() {}
  click() {}
  remove() {}
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

const ADMIN_USER = {
  id: "user_admin", email: "admin@example.com", displayName: "Admin",
  createdAt: 1, isAdmin: true
};

function responses(path) {
  if (path === "/api/config") {
    return jsonResponse({
      app: "ThickEarth", version: "0.4.0", mode: "web",
      features: { auth: true, online: true, llm: true, agentSeats: true },
      rules: { version: "connect6/v1", boardSize: 19, winLength: 6, stonesPerTurn: 2, firstTurnStones: 1, playerCounts: [2] }
    });
  }
  if (path === "/api/auth/me") return jsonResponse({ authenticated: true, user: ADMIN_USER, mode: "web" });
  if (path === "/api/ai/settings") {
    return jsonResponse({
      enabled: true, configured: true, provider: "custom",
      baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash",
      temperature: 0.2, maxOutputTokens: 1200, maxMovesPerGame: 40,
      monthlyCallLimit: 500, hasKey: true, keyHint: "abcd", sharedAvailable: true,
      usage: { monthCalls: 0, monthInputTokens: 0, monthOutputTokens: 0 }, presets: []
    });
  }
  if (path === "/api/admin/shared-llm") return jsonResponse({ enabled: true, available: true });
  return jsonResponse({});
}

function installDomShim() {
  const storage = new Map();
  globalThis.Node = FakeNode;
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key)
  };
  globalThis.document = {
    createElement: (tag) => new FakeNode(tag),
    createElementNS: (_ns, tag) => new FakeNode(tag),
    createTextNode: (value) => {
      const node = new FakeNode("#text");
      node.textContent = String(value);
      return node;
    },
    createDocumentFragment: () => new FakeNode("#fragment"),
    body: new FakeNode("body"),
    documentElement: new FakeNode("html"),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {}
  };
  globalThis.window = {
    location: { hash: "#/settings", href: "http://localhost/#/settings" },
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    localStorage: globalThis.localStorage,
    requestAnimationFrame: (fn) => setTimeout(fn, 0)
  };
  globalThis.location = globalThis.window.location;
  Object.defineProperty(globalThis, "navigator", {
    value: { language: "zh-CN" }, configurable: true, writable: true
  });
  globalThis.fetch = async (input) => responses(String(input).replace(/^https?:\/\/[^/]+/, ""));
}

/** Flatten rendered text so the assertion does not depend on DOM structure. */
function collectText(node, out = []) {
  if (!node) return out;
  if (typeof node.textContent === "string" && node.textContent) out.push(node.textContent);
  for (const child of node.children || []) collectText(child, out);
  return out;
}

installDomShim();

const { loadSession } = await import("../web/js/core/store.js");
const { mount } = await import("../web/js/views/settings.js");

test("settings page renders for an admin without throwing", async () => {
  const session = await loadSession({ force: true });
  assert.equal(session.authenticated, true);
  assert.equal(session.user.isAdmin, true);

  const container = document.createElement("div");
  const errors = [];
  const onRejection = (error) => errors.push(error);
  process.on("unhandledRejection", onRejection);
  try {
    await mount(container, { name: "settings" });
    await new Promise((resolve) => setTimeout(resolve, 80));
  } finally {
    process.off("unhandledRejection", onRejection);
  }

  assert.deepEqual(errors, [], "async render must not reject");
  assert.ok(container.children.length > 0, "settings page appended content");
  const text = collectText(container).join(" ");
  assert.match(text, /站点管理/, "admin card is rendered");
  assert.match(text, /共享 LLM/, "shared toggle is rendered");
  assert.match(text, /AI Agent/, "AI provider card is rendered");
});
