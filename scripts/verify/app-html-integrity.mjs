#!/usr/bin/env node
/**
 * app-html-integrity.mjs — the standing house check for app.html.
 *
 * app.html is ~1.2MB of markup + 5 inline <script> blocks + several <style>
 * blocks, so a bad edit fails silently at runtime. This extracts every inline
 * script to a temp file and runs `node --check` on it (never /dev/stdin), and
 * verifies every <style> block is brace-balanced.
 *
 * Usage: node scripts/verify/app-html-integrity.mjs [path-to-app.html]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.argv[2] || path.join(__dirname, '..', '..', 'app.html');
const html = fs.readFileSync(FILE, 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apphtml-'));
const fails = [];

/* ── inline scripts ──────────────────────────────────────────────────────── */
const scriptRe = /<script(?![^>]*\bsrc=)(?![^>]*type="application\/ld\+json")[^>]*>([\s\S]*?)<\/script>/g;
let m, n = 0;
while ((m = scriptRe.exec(html))) {
  const body = m[1];
  if (!body.trim()) continue;
  n++;
  const f = path.join(tmp, `inline-${n}.js`);
  fs.writeFileSync(f, body);
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) fails.push(`inline script #${n} (offset ${m.index}) does not parse:\n${(r.stderr || '').split('\n').slice(0, 6).join('\n')}`);
  else console.log(`  ok  inline script #${n} parses (${body.length} bytes)`);
}
if (n !== 5) fails.push(`expected 5 inline <script> blocks, found ${n} — did an edit drop or add one?`);

/* ── JSON-LD blocks ──────────────────────────────────────────────────────── */
const ldRe = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
let l = 0;
while ((m = ldRe.exec(html))) {
  // skip template-literal JSON-LD that a JS string builds at runtime (`${ld}`)
  if (/\$\{/.test(m[1])) continue;
  l++;
  try { JSON.parse(m[1]); console.log(`  ok  JSON-LD block #${l} parses`); }
  catch (e) { fails.push(`JSON-LD block #${l} does not parse: ${e.message}`); }
}

/* ── style blocks: brace balance ─────────────────────────────────────────── */
const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/g;
let s = 0;
while ((m = styleRe.exec(html))) {
  const css = m[1].replace(/\/\*[\s\S]*?\*\//g, '');
  if (!css.includes('{')) continue; // the `'<style>' + css + '</style>'` JS string
  s++;
  const open = (css.match(/{/g) || []).length;
  const close = (css.match(/}/g) || []).length;
  if (open !== close) fails.push(`<style> block #${s} is brace-UNBALANCED: ${open} { vs ${close} }`);
  else console.log(`  ok  <style> block #${s} brace-balanced (${open}/${close})`);
}
if (s < 3) fails.push(`expected at least 3 real <style> blocks, found ${s}`);

fs.rmSync(tmp, { recursive: true, force: true });
if (fails.length) { console.error('\nFAILURES:'); for (const f of fails) console.error('  ✗ ' + f); process.exit(1); }
console.log('app.html integrity passed');
