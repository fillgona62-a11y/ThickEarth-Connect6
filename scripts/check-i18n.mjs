/**
 * Sanity check: every t('key') used in web/js exists in both dictionaries, and
 * the zh/en key sets match. Run with `node scripts/check-i18n.mjs`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const webDir = join(root, 'web', 'js');

async function loadDictionaries() {
  const module = await import(pathToFileURL(join(webDir, 'core', 'i18n.js')).href);
  if (module.DICT && typeof module.DICT === 'object') return module.DICT;
  if (typeof module.default === 'object') return module.default;
  throw new Error('i18n.js does not export a dictionary map');
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

const dictionaries = await loadDictionaries();
const langs = Object.keys(dictionaries);
const [first, ...rest] = langs;
const missingInOthers = new Map();
for (const lang of rest) {
  const missing = Object.keys(dictionaries[first]).filter((key) => !(key in dictionaries[lang]));
  const extra = Object.keys(dictionaries[lang]).filter((key) => !(key in dictionaries[first]));
  if (missing.length || extra.length) missingInOthers.set(lang, { missing, extra });
}

const used = new Map();
for (const file of walk(webDir)) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/\bt\(\s*'([a-zA-Z][\w.]*)'/g)) {
    const key = match[1];
    if (!used.has(key)) used.set(key, new Set());
    used.get(key).add(file);
  }
}

const unknown = [...used.entries()].filter(([key]) => !key.endsWith('.') && !(key in dictionaries[first]));

let failed = false;
if (missingInOthers.size) {
  failed = true;
  for (const [lang, diff] of missingInOthers) {
    console.log(`[i18n] ${lang} vs ${first}: missing ${diff.missing.length}, extra ${diff.extra.length}`);
    if (diff.missing.length) console.log('  missing:', diff.missing.join(', '));
    if (diff.extra.length) console.log('  extra  :', diff.extra.join(', '));
  }
}
if (unknown.length) {
  failed = true;
  for (const [key, files] of unknown) {
    console.log(`[i18n] unknown key "${key}" used in ${[...files].join(', ')}`);
  }
}

if (!failed) {
  console.log(`[i18n] ok — ${Object.keys(dictionaries[first]).length} keys in ${langs.join(' / ')}, ${used.size} referenced keys resolve`);
} else {
  process.exitCode = 1;
}
