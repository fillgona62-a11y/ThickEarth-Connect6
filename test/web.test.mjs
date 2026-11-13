/**
 * Front-end guardrails: the browser bundle has no build step and no test runner,
 * so these tests read the shipped modules as text and assert the invariants the
 * Connect6 rewrite depends on. They are deliberately coarse — they catch a view
 * that still speaks the old territory vocabulary, or a board that lost its 19-wide
 * star points, not cosmetic changes.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, "..", "web");
const jsDir = join(webDir, "js");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".js")) out.push(full);
  }
  return out;
}

function read(relativePath) {
  return readFileSync(join(webDir, relativePath), "utf8");
}

test("the interface dictionary has identical zh and en key sets", async () => {
  const { DICT } = await import("../web/js/core/i18n.js");
  const zh = Object.keys(DICT.zh).sort();
  const en = Object.keys(DICT.en).sort();
  assert.deepEqual(en, zh, "zh/en key sets drifted");
});

test("every t('key') call resolves to a dictionary entry", async () => {
  const { DICT } = await import("../web/js/core/i18n.js");
  const known = new Set(Object.keys(DICT.zh));
  const missing = [];
  for (const file of walk(jsDir)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\bt\(\s*'([a-zA-Z][\w.]*)'/g)) {
      const key = match[1];
      // Keys ending in a dot are prefixes concatenated at runtime, e.g. t('mode.' + mode).
      if (key.endsWith(".") || known.has(key)) continue;
      missing.push(key + " (" + relative(webDir, file) + ")");
    }
  }
  assert.deepEqual(missing, [], "unknown translation keys");
});

test("no view still speaks the old territory vocabulary", () => {
  const banned = [
    { pattern: /notation\.(camp|recall|pass)\b/, why: "camp / recall / pass strings" },
    { pattern: /type:\s*'(camp|recall|pass|resign)'/, why: "a non-place action payload" },
    { pattern: /piecesByPlayerCount/, why: "per-player-count piece tables" },
    { pattern: /showTerritory/, why: "territory overlay state" },
    { pattern: /previewOwnership/, why: "ownership preview in the replay view" }
  ];
  const offenders = [];
  for (const file of walk(jsDir)) {
    const source = readFileSync(file, "utf8");
    for (const rule of banned) {
      if (rule.pattern.test(source)) {
        offenders.push(relative(webDir, file) + ": " + rule.why);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("the setup page offers all four local modes, arena included", () => {
  const source = read("js/views/local-setup.js");
  assert.match(source, /const MODES = \['local', 'ai', 'selfplay', 'arena'\]/);
  assert.match(source, /const PLAYER_COUNT = 2/);
  assert.match(source, /arena: \{/);
});

test("the board renders a 19-wide grid with star points and a winning line", () => {
  const source = read("js/game/board.js");
  assert.match(source, /\[19, \[\[3, 3\], \[9, 3\], \[15, 3\]/);
  assert.match(source, /winLine/);
  assert.match(source, /cell--win/);
  // Two stone shapes are enough for two seats.
  const shapes = source.match(/const STONE_SHAPES = \[([\s\S]*?)\n\];/);
  assert.ok(shapes, "STONE_SHAPES declaration is missing");
  assert.equal((shapes[1].match(/tag:/g) || []).length, 2);
});

test("the stylesheet defaults to a 19-wide board", () => {
  const source = readFileSync(join(webDir, "css", "board.css"), "utf8");
  assert.match(source, /--board-size:\s*19/);
  assert.match(source, /\.cell--win/);
  assert.match(source, /\.stone-token--black/);
});

test("the rules page documents the opening turn and the six-in-a-row win", () => {
  const source = read("js/views/rules.js");
  assert.match(source, /'overview', 'board', 'turn', 'win', 'strategy', 'agent', 'records'/);
  assert.match(source, /staticBoard\(/);
});
