#!/usr/bin/env node
/**
 * clean-theme.mjs — gate for /clean.css, the "A · Clean" theme (redesign v699, agent T).
 *
 * Checks, all against the real files:
 *  1. clean.css parses: comments and strings close, braces balance, every block has a selector, every
 *     declaration is `property: value`.
 *  2. Every --cs-* token from the contract (.unlazy/redesign/PLAN.md) is defined with the exact value, in the
 *     light block (:root) and in the dark block (:root[data-theme="dark"] — one class above app.html's own
 *     [data-theme="dark"] token defaults, so the theme file wins whatever the order).
 *     The expected values live in this file too, because the PLAN is not shipped; when PLAN.md is present the
 *     two tables must agree.
 *  3. Every legacy variable the app paints with (each var(--x) used in app.html, plus every variable declared
 *     in app.html's :root / [data-theme="dark"] palette blocks) is re-pointed in clean.css's remap block,
 *     and the remap uses tokens only (no hex, no rgb).
 *  4. No gradients and no orange / coral colours anywhere in clean.css, and none of the old shrimp hexes.
 *  5. Contrast, computed from the token values parsed out of clean.css, for both themes: body text ≥ 4.5:1
 *     on every surface it sits on; on-primary on primary; status text on its tint.
 *  6. Touch targets: no clean.css rule shrinks a button / chip / tab / item below 44px.
 *  7. State classes stay visible: for every selected/primary state of a class clean.css paints
 *     (.active .selected .on .primary .sel .picked .checked .current, [aria-pressed="true"], :checked) — found in
 *     clean.css or in app.html — the cascade inside clean.css (!important, specificity, order) must give the state
 *     a different background / colour / border / ring than the bare class, in light and in dark. Catches a state rule
 *     losing to an !important base rule (e.g. `.create-sub-tab{background:transparent !important}` eating `.active`).
 * Prints "CLEAN THEME OK" only when everything passes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CSS_FILE = path.join(ROOT, 'clean.css');
const APP_FILE = path.join(ROOT, 'app.html');
const PLAN_FILE = path.join(ROOT, '.unlazy', 'redesign', 'PLAN.md');

const failures = [];
const fail = (m) => failures.push(m);
const notes = [];

/* contract tokens — PLAN.md "Tokens" */
const TOKENS = {
  light: { bg: '#ffffff', card: '#ffffff', raise: '#f7f7f7', text: '#0d0d0d', muted: '#5d5d5d', line: '#e6e6e6', chip: '#f2f2f2',
    input: '#f2f2f2', primary: '#0d0d0d', 'on-primary': '#ffffff', danger: '#dc2626', ok: '#16a34a', overlay: 'rgba(0,0,0,.35)' },
  dark: { bg: '#212121', card: '#212121', raise: '#2a2a2a', text: '#ececec', muted: '#b4b4b4', line: '#3d3d3d', chip: '#333333',
    input: '#303030', primary: '#ececec', 'on-primary': '#0d0d0d', danger: '#f87171', ok: '#4ade80', overlay: 'rgba(0,0,0,.6)' },
};
/* variables that are not palette: motion curves, the code font, and the per-render b-roll palette JS sets inline */
const EXEMPT = new Set(['--ease-out', '--ease-in-out', '--transition', '--mono']);
const exempt = (v) => EXEMPT.has(v) || v.startsWith('--cs-') || v.startsWith('--brp-') || v === '--br-total';

if (!fs.existsSync(CSS_FILE)) { console.error('clean.css missing at ' + CSS_FILE); process.exit(1); }
const cssRaw = fs.readFileSync(CSS_FILE, 'utf8');
const app = fs.readFileSync(APP_FILE, 'utf8');

/* ───────────── 1. parse ───────────── */
function stripComments(s) {
  let out = '', i = 0;
  while (i < s.length) {
    if (s[i] === '/' && s[i + 1] === '*') {
      const j = s.indexOf('*/', i + 2);
      if (j < 0) { fail('parse: unterminated comment at offset ' + i); return out; }
      i = j + 2; continue;
    }
    out += s[i++];
  }
  return out;
}
const css = stripComments(cssRaw);
const RULES = [];   // { sel, media:[...], decls:[{prop,val,imp}] }
function splitDecls(body, where) {
  const out = []; let cur = '', depth = 0, q = null;
  for (const ch of body) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") q = ch;
    if (ch === '(') depth++; else if (ch === ')') depth--;
    if (ch === ';' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (q) fail('parse: unterminated string in ' + where);
  if (depth !== 0) fail('parse: unbalanced parentheses in ' + where);
  out.push(cur);
  const decls = [];
  for (const raw of out) {
    const t = raw.trim(); if (!t) continue;
    const i = t.indexOf(':');
    if (i <= 0) { fail('parse: not a declaration in ' + where + ': "' + t.slice(0, 60) + '"'); continue; }
    const prop = t.slice(0, i).trim();
    let val = t.slice(i + 1).trim(); let imp = false;
    if (/!\s*important$/i.test(val)) { imp = true; val = val.replace(/\s*!\s*important$/i, '').trim(); }
    if (!/^(--[\w-]+|-?[a-z][a-z-]*)$/i.test(prop)) fail('parse: bad property name "' + prop + '" in ' + where);
    if (!val) fail('parse: empty value for ' + prop + ' in ' + where);
    decls.push({ prop: prop.toLowerCase().startsWith('--') ? prop : prop.toLowerCase(), val, imp });
  }
  return decls;
}
function parseBlock(s, media) {
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf('{', i), close = s.indexOf('}', i);
    if (open < 0) { if (s.slice(i).trim()) { if (close >= 0) fail('parse: stray "}" near "' + s.slice(i, i + 60).trim() + '"'); else fail('parse: trailing text "' + s.slice(i, i + 60).trim() + '"'); } return; }
    if (close >= 0 && close < open) { fail('parse: stray "}" near "' + s.slice(Math.max(0, close - 40), close + 1).trim() + '"'); i = close + 1; continue; }
    const prelude = s.slice(i, open).trim();
    let depth = 0, j = open, q = null;
    for (; j < s.length; j++) {
      const c = s[j];
      if (q) { if (c === q) q = null; continue; }
      if (c === '"' || c === "'") q = c;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) break; }
    }
    if (j >= s.length) { fail('parse: unclosed "{" after "' + prelude.slice(0, 60) + '"'); return; }
    const body = s.slice(open + 1, j);
    if (!prelude) fail('parse: block with no selector near "' + body.slice(0, 40) + '"');
    if (/^@(media|supports)/i.test(prelude)) parseBlock(body, media.concat(prelude));
    else if (/^@(-webkit-)?keyframes/i.test(prelude)) parseBlock(body, media.concat(prelude));
    else if (/^@/.test(prelude)) { /* other at-rules: not used */ }
    else RULES.push({ sel: prelude.replace(/\s+/g, ' '), media, decls: splitDecls(body, '"' + prelude.slice(0, 50) + '"') });
    i = j + 1;
  }
}
parseBlock(css, []);
if (RULES.length < 150) fail('parse: only ' + RULES.length + ' rules found — the parser is not seeing the file');

/* ───────────── 2. tokens ───────────── */
const norm = (v) => v.toLowerCase().replace(/\s+/g, '').replace(/(^|[,(])0\./g, '$1.');
const topRules = RULES.filter(r => r.media.length === 0);
const selList = (sel) => sel.split(',').map(x => x.trim());
const lightRule = topRules.find(r => selList(r.sel).includes(':root') && r.decls.some(d => d.prop === '--cs-bg'));
const darkRule = topRules.find(r => selList(r.sel).includes(':root[data-theme="dark"]') && r.decls.some(d => d.prop === '--cs-bg'));
const tokenVals = { light: {}, dark: {} };
for (const [theme, rule] of [['light', lightRule], ['dark', darkRule]]) {
  if (!rule) { fail('tokens: no ' + theme + ' token block (' + (theme === 'light' ? ':root' : ':root[data-theme="dark"]') + ' declaring --cs-bg)'); continue; }
  for (const d of rule.decls) if (d.prop.startsWith('--cs-')) tokenVals[theme][d.prop.slice(5)] = d.val;
  for (const [k, v] of Object.entries(TOKENS[theme])) {
    const got = tokenVals[theme][k];
    if (got === undefined) fail('tokens: --cs-' + k + ' missing in the ' + theme + ' block');
    else if (norm(got) !== norm(v)) fail('tokens: --cs-' + k + ' is ' + got + ' in ' + theme + ', contract says ' + v);
  }
}
/* the light block must not be reachable in dark through a later, equally specific rule redefining a token */
for (const r of topRules) {
  if (r === lightRule || r === darkRule) continue;
  for (const d of r.decls) if (d.prop.startsWith('--cs-') && TOKENS.light[d.prop.slice(5)] !== undefined)
    fail('tokens: ' + d.prop + ' is redefined outside the two token blocks, in "' + r.sel.slice(0, 60) + '"');
}
if (fs.existsSync(PLAN_FILE)) {
  const plan = fs.readFileSync(PLAN_FILE, 'utf8');
  const sect = (label) => { const m = plan.match(new RegExp(label + '[^\\n]*:([\\s\\S]*?)(?=\\n(?:Light|Font)\\b)')); return m ? m[1] : ''; };
  const parsePlan = (txt) => Object.fromEntries([...txt.matchAll(/--cs-([\w-]+)\s+(rgba\([^)]*\)|#[0-9a-fA-F]{3,8})/g)].map(m => [m[1], m[2]]));
  const pd = parsePlan(sect('Dark \\(DEFAULT\\)')), pl = parsePlan(sect('Light \\(only'));
  if (Object.keys(pd).length < 10 || Object.keys(pl).length < 10) fail('tokens: could not read the token table from PLAN.md');
  for (const [theme, table] of [['dark', pd], ['light', pl]])
    for (const [k, v] of Object.entries(table))
      if (!TOKENS[theme][k] || norm(TOKENS[theme][k]) !== norm(v)) fail('tokens: PLAN.md says --cs-' + k + ' = ' + v + ' (' + theme + ') but this gate expects ' + TOKENS[theme][k]);
} else notes.push('PLAN.md not present (a copied repo) — checked against the table in this gate');

/* ───────────── 3. legacy variables re-pointed ───────────── */
const remapRule = topRules.find(r => selList(r.sel).includes(':root[data-theme]') && r.decls.some(d => d.prop === '--text'));
const remap = {};
if (!remapRule) fail('legacy: no remap block (:root[data-theme] declaring --text)');
else for (const d of remapRule.decls) remap[d.prop] = d.val;
const used = new Set([...app.matchAll(/var\(\s*(--[\w-]+)/g)].map(m => m[1]));
const declared = new Set();
for (const m of app.matchAll(/(?:^|\n)\s*(:root|\[data-theme="dark"\])\s*\{([^}]*)\}/g))
  for (const d of m[2].matchAll(/(--[\w-]+)\s*:/g)) declared.add(d[1]);
if (used.size < 20) fail('legacy: only ' + used.size + ' var() uses found in app.html — the scan is broken');
if (declared.size < 20) fail('legacy: only ' + declared.size + ' palette variables found in app.html — the scan is broken');
const legacy = [...new Set([...used, ...declared])].filter(v => !exempt(v)).sort();
const missing = legacy.filter(v => !(v in remap));
if (missing.length) fail('legacy: not re-pointed in clean.css: ' + missing.join(', '));
for (const [k, v] of Object.entries(remap)) {
  if (/#[0-9a-f]{3,8}\b|rgba?\(/i.test(v)) fail('legacy: ' + k + ' is re-pointed to a raw colour (' + v + '), not a token');
  if (/^--(text|bg|surface|border|lav|gold|accent)/.test(k) && !/var\(--cs-/.test(v)) fail('legacy: ' + k + ' must resolve to a --cs-* token, got ' + v);
}

/* ───────────── 4. no gradients, no orange/coral, no shrimp palette ───────────── */
if (/(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(/i.test(css)) fail('look: clean.css contains a gradient');
function hexRgb(h) { h = h.replace('#', ''); if (h.length === 3 || h.length === 4) h = h.split('').map(c => c + c).join(''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); }
function hueChroma([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = (mx - mn) / 255;
  if (mx === mn) return { h: 0, c: 0, l: mx / 255 };
  let h; const d = mx - mn;
  if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
  h *= 60; if (h < 0) h += 360;
  return { h, c, l: (mx + mn) / 510 };
}
const colours = [...css.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+[^)]*\)/g)].map(m => m[0]);
for (const c of colours) {
  const rgb = c.startsWith('#') ? hexRgb(c) : c.match(/\d+/g).slice(0, 3).map(Number);
  const { h, c: ch } = hueChroma(rgb);
  if (ch >= 0.25 && h >= 10 && h <= 50) fail('look: orange/coral colour ' + c + ' in clean.css');
}
const SHRIMP = ['#16130f', '#e7daf9', '#f9f6ea', '#c9b8e8', '#f5f1e3', '#ddd7c3', '#eae5d2'];
for (const h of SHRIMP) {
  const re = new RegExp(h + '(?![0-9a-f])', 'ig');
  const hits = (css.match(re) || []).length;
  // allowed only inside an attribute selector that MATCHES the old inline palette (e.g. [style*="solid #16130F" i])
  const inSelectors = [...css.matchAll(/\[style[^\]]*\]/gi)].map(m => m[0]).join(' ').match(re) || [];
  if (hits > inSelectors.length) fail('look: old shrimp colour ' + h + ' painted by clean.css (' + (hits - inSelectors.length) + 'x)');
}

/* ───────────── 5. contrast ───────────── */
function parseColour(v, theme, depth = 0) {
  v = v.trim();
  if (depth > 6) return null;
  const vm = v.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  if (vm) {
    const name = vm[1];
    if (name.startsWith('--cs-') && tokenVals[theme][name.slice(5)] !== undefined) return parseColour(tokenVals[theme][name.slice(5)], theme, depth + 1);
    if (name in remap) return parseColour(remap[name], theme, depth + 1);
    return null;
  }
  const mix = v.match(/^color-mix\(\s*in srgb\s*,\s*(.+?)\s+(\d+)%\s*,\s*(.+?)(?:\s+(\d+)%)?\s*\)$/);
  if (mix) {
    const a = parseColour(mix[1], theme, depth + 1), b = parseColour(mix[3], theme, depth + 1);
    if (!a || !b) return null;
    const p = Number(mix[2]) / 100;
    return a.map((x, i) => i < 3 ? x * p + b[i] * (1 - p) : 1);
  }
  if (/^#/.test(v)) return [...hexRgb(v), 1];
  const m = v.match(/^rgba?\(([^)]*)\)$/);
  if (m) { const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] === undefined ? 1 : p[3]]; }
  return null;
}
const lum = ([r, g, b]) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
const derived = {};
for (const k of ['--cs-ok-text', '--cs-danger-text', '--cs-ok-tint', '--cs-danger-tint']) {
  if (!(k in remap)) fail('contrast: ' + k + ' is not defined (status text / tints need it)');
}
const PAIRS = [];
for (const fg of ['text', 'muted']) for (const bg of ['bg', 'card', 'raise', 'chip', 'input']) PAIRS.push(['var(--cs-' + fg + ')', 'var(--cs-' + bg + ')', 4.5]);
PAIRS.push(['var(--cs-on-primary)', 'var(--cs-primary)', 4.5]);
PAIRS.push(['var(--cs-on-primary)', 'var(--cs-danger)', 4.5]);           // destructive fill buttons
PAIRS.push(['var(--cs-bg)', 'var(--cs-text)', 4.5]);                     // toasts (text-coloured pill)
for (const bg of ['bg', 'card', 'raise', 'chip']) { PAIRS.push(['var(--cs-ok-text)', 'var(--cs-' + bg + ')', 4.5]); PAIRS.push(['var(--cs-danger-text)', 'var(--cs-' + bg + ')', 4.5]); }
PAIRS.push(['var(--cs-ok-text)', 'var(--cs-ok-tint)', 4.5]);
PAIRS.push(['var(--cs-danger-text)', 'var(--cs-danger-tint)', 4.5]);
PAIRS.push(['var(--cs-muted)', 'var(--cs-hover)', 3]);                   // large/secondary text on a hovered row (alpha over bg)
let checked = 0;
for (const theme of ['light', 'dark']) {
  for (const [f, b, min] of PAIRS) {
    const fc = parseColour(f, theme); let bc = parseColour(b, theme);
    if (!fc || !bc) { fail('contrast: cannot resolve ' + f + ' / ' + b + ' in ' + theme); continue; }
    if (bc[3] < 1) { const base = parseColour('var(--cs-bg)', theme); bc = bc.map((x, i) => i < 3 ? x * bc[3] + base[i] * (1 - bc[3]) : 1); }
    const r = ratio(fc, bc); checked++;
    if (r < min) fail('contrast: ' + f + ' on ' + b + ' is ' + r.toFixed(2) + ':1 in ' + theme + ' (needs ' + min + ')');
  }
}

/* ───────────── 6. touch targets ───────────── */
const INTERACTIVE = /btn|button|chip|tab\b|-tab|item|toggle|close|circle|action|\bnav\b/i;
for (const r of RULES) {
  if (!INTERACTIVE.test(r.sel) || /::(before|after)|svg|\bi\b|-ic\b|-dot|count|badge|label|lbl|icon/i.test(r.sel.split(',').pop())) continue;
  for (const d of r.decls) {
    if (!['height', 'min-height', 'width', 'min-width'].includes(d.prop)) continue;
    const px = d.val.match(/^(\d+(?:\.\d+)?)px$/);
    if (px && Number(px[1]) < 44) fail('touch: "' + r.sel.slice(0, 70) + '" sets ' + d.prop + ':' + d.val + ' (< 44px)');
  }
}

/* ───────────── 7. state classes are not eaten by !important base rules ───────────── */
const STATE = '(?:\\.(?:active|selected|on|primary|sel|picked|checked|current)|\\[aria-pressed="?true"?\\]|:checked)';
function compounds(sel) { return sel.trim().split(/\s*[ >+~]\s*/).filter(Boolean); }
function specOf(sel) {
  const s = sel.replace(/:not\(([^)]*)\)/g, ' $1');
  const ids = (s.match(/#[\w-]+/g) || []).length;
  const cls = (s.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) || []).length;
  const tags = (s.replace(/\[[^\]]*\]|[.#:][\w-]+(\([^)]*\))?/g, ' ').match(/(^|\s)[a-z][\w-]*/gi) || []).length;
  return ids * 10000 + cls * 100 + tags;
}
/* does `sel` match an element with exactly classes `cls`, whose only ancestors that matter are html/:root (theme) and body? */
function matches(sel, cls, theme) {
  if (/::/.test(sel) || /:(hover|active|focus|focus-visible|disabled|not|empty|first|last|nth|placeholder)/.test(sel.replace(/:root/g, ''))) return false;
  const cs = compounds(sel);
  const last = cs.pop();
  for (const anc of cs) {
    if (/^(:root|html)(\[data-theme(="(dark|light)")?\])?$/.test(anc) || /^\[data-theme(="(dark|light)")?\]$/.test(anc) || anc === 'body') {
      const t = (anc.match(/data-theme="(\w+)"/) || [])[1]; if (t && t !== theme) return false; continue;
    }
    return false;   // any other ancestor: context we cannot assume
  }
  if (/[#\[]|^[a-z]/i.test(last.replace(/\[aria-pressed="?true"?\]/, '').replace(/:checked/, ''))) return false;
  const need = last.match(/\.[\w-]+/g) || [];
  if (!need.length) return false;
  if (/\[aria-pressed/.test(last) && !cls.includes('[aria-pressed="true"]')) return false;
  if (/:checked/.test(last) && !cls.includes(':checked')) return false;
  return need.every(c => cls.includes(c));
}
const LOOK = { bg: ['background', 'background-color'], fg: ['color'], border: ['border', 'border-color', 'border-top', 'border-width'], ring: ['box-shadow'] };
function resolve(cls, theme) {
  const out = {};
  for (const [k, props] of Object.entries(LOOK)) {
    let best = null;
    RULES.forEach((r, order) => {
      if (r.media.some(m => /keyframes/.test(m))) return;
      for (const one of r.sel.split(',')) {
        if (!matches(one.trim(), cls, theme)) continue;
        for (const d of r.decls) {
          if (!props.includes(d.prop)) continue;
          const key = [d.imp ? 1 : 0, specOf(one.trim()), order];
          if (!best || key[0] > best.key[0] || (key[0] === best.key[0] && (key[1] > best.key[1] || (key[1] === best.key[1] && key[2] >= best.key[2])))) best = { key, val: d.val };
        }
      }
    });
    out[k] = best ? best.val.replace(/\s+/g, ' ') : '(app)';
  }
  return out;
}
const pairs = new Map();
const addPair = (base, state) => { const k = base + state; if (!pairs.has(k)) pairs.set(k, [base, state]); };
const pairRe = new RegExp('(\\.[\\w-]+)(' + STATE + ')(?![\\w-])', 'g');
for (const r of RULES) for (const m of r.sel.matchAll(pairRe)) addPair(m[1], m[2]);
const appCss = [...app.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
for (const m of appCss.matchAll(pairRe)) addPair(m[1], m[2]);
let statePairs = 0;
for (const [, [base, state]] of pairs) {
  // only classes whose base look clean.css forces with !important can have their state eaten
  const forced = RULES.some(r => r.decls.some(d => d.imp && Object.values(LOOK).flat().includes(d.prop)) && r.sel.split(',').some(s => matches(s.trim(), [base], 'light') || matches(s.trim(), [base], 'dark')));
  if (!forced) continue;
  const stateCls = state.startsWith('.') ? [base, ...state.match(/\.[\w-]+/g)] : [base, state];
  for (const theme of ['light', 'dark']) {
    const a = resolve([base], theme), b = resolve(stateCls, theme);
    statePairs++;
    if (JSON.stringify(a) === JSON.stringify(b)) fail('state: ' + base + state + ' computes the same look as ' + base + ' in ' + theme + ' (' + JSON.stringify(a) + ') — an !important base rule is eating the state');
  }
}
if (statePairs < 20) fail('state: only ' + statePairs + ' state pairs checked — the scan is not seeing the file');
for (const must of ['.create-sub-tab.active', '.sp-invite-btn.primary', '.list-card.picked']) if (!pairs.has(must)) fail('state: expected pair ' + must + ' not found');

/* ───────────── result ───────────── */
for (const n of notes) console.log('note: ' + n);
console.log('clean.css: ' + RULES.length + ' rules, ' + Object.keys(remap).length + ' variables re-pointed, ' + legacy.length + ' legacy variables required, ' + checked + ' contrast pairs, ' + statePairs + ' state pairs');
if (failures.length) { for (const f of failures) console.error('FAIL ' + f); console.error('clean theme verification FAILED (' + failures.length + ')'); process.exit(1); }
console.log('CLEAN THEME OK');
