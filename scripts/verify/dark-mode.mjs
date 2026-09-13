#!/usr/bin/env node
/**
 * dark-mode.mjs — verifies the dark-mode + tap-blocking fixes in app.html.
 *
 * This does NOT grep. It parses every <style> block into rules (selector,
 * declarations, !important, media context, document order), implements a
 * specificity calculator and a small selector matcher, and then RESOLVES each
 * property the way a browser would: filter by media, sort by
 * (important, specificity, source order), take the winner.
 *
 * That matters because the bug class this file exists to catch is exactly
 * "a later same-or-higher-specificity !important rule silently eats the fix" —
 * a grep for the fix would happily report success while the fix is dead code.
 *
 * Usage:  node scripts/verify/dark-mode.mjs [path-to-app.html]
 * Exits non-zero on any failure. Prints `dark mode verification passed` on success.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.argv[2] || path.join(__dirname, '..', '..', 'app.html');
const html = fs.readFileSync(FILE, 'utf8');

const failures = [];
const notes = [];
const fail = (m) => failures.push(m);

/* ══════════════════════════════ CSS PARSER ══════════════════════════════ */

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Split on `sep` at nesting depth 0 (parens + brackets aware). */
function splitTop(str, sep) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of str) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

let ORDER = 0;
const RULES = [];

function parseDecls(body) {
  const decls = [];
  for (const chunk of splitTop(body, ';')) {
    const t = chunk.trim();
    if (!t) continue;
    const i = t.indexOf(':');
    if (i < 0) continue;
    const prop = t.slice(0, i).trim().toLowerCase();
    let val = t.slice(i + 1).trim();
    let important = false;
    if (/!\s*important$/i.test(val)) { important = true; val = val.replace(/!\s*important$/i, '').trim(); }
    if (!prop) continue;
    decls.push({ prop, val, important });
  }
  return decls;
}

/** Recursive block parser. `media` = array of raw at-rule preludes in scope. */
function parseBlock(css, media) {
  let i = 0;
  const n = css.length;
  while (i < n) {
    // find the next '{' at depth 0
    let start = i, depth = 0, j = i, open = -1;
    for (; j < n; j++) {
      const c = css[j];
      if (c === '{') { open = j; break; }
      if (c === '}') { i = j + 1; open = -2; break; }
    }
    if (open === -2) continue;
    if (open < 0) break;
    const prelude = css.slice(start, open).trim();
    // find matching close brace
    depth = 1; let k = open + 1;
    for (; k < n && depth > 0; k++) {
      if (css[k] === '{') depth++;
      else if (css[k] === '}') depth--;
    }
    const body = css.slice(open + 1, k - 1);
    i = k;
    if (!prelude) continue;
    if (prelude.startsWith('@')) {
      const name = prelude.slice(1).split(/[\s({]/)[0].toLowerCase();
      if (name === 'keyframes' || name === '-webkit-keyframes' || name === 'font-face' || name === 'import' || name === 'charset') continue;
      // @media / @supports / @layer etc — recurse, carrying the prelude
      parseBlock(body, name === 'media' ? media.concat([prelude]) : media);
      continue;
    }
    const decls = parseDecls(body);
    if (!decls.length) continue;
    for (const sel of splitTop(prelude, ',')) {
      const s = sel.trim().replace(/\s+/g, ' ');
      if (!s) continue;
      RULES.push({ sel: s, decls, media: media.slice(), order: ORDER++, raw: prelude });
    }
  }
}

// Collect every <style> block in document order.
{
  const re = /<style[^>]*>([\s\S]*?)<\/style>/g;
  let m, blocks = 0;
  while ((m = re.exec(html))) { parseBlock(stripComments(m[1]), []); blocks++; }
  notes.push(`parsed ${blocks} <style> block(s) -> ${RULES.length} rules`);
  if (blocks < 2) fail(`expected at least 2 <style> blocks, found ${blocks}`);
  if (RULES.length < 1500) fail(`suspiciously few rules parsed (${RULES.length}) — parser is probably broken`);
}

/* ══════════════════════════ SPECIFICITY ══════════════════════════ */

function specificity(sel) {
  let a = 0, b = 0, c = 0;
  let s = sel;
  // pseudo-elements first (they count as element)
  s = s.replace(/::[a-zA-Z-]+/g, () => { c++; return ' '; });
  s = s.replace(/:not\(([^)]*)\)/g, (_, inner) => {
    const sp = specificity(inner.trim());
    a += sp[0]; b += sp[1]; c += sp[2];
    return ' ';
  });
  s = s.replace(/#[\w-]+/g, () => { a++; return ' '; });
  s = s.replace(/\[[^\]]*\]/g, () => { b++; return ' '; });
  s = s.replace(/\.[\w-]+/g, () => { b++; return ' '; });
  // legacy one-colon pseudo-elements
  s = s.replace(/:(before|after|first-line|first-letter)\b/g, () => { c++; return ' '; });
  s = s.replace(/:[a-zA-Z-]+(\([^)]*\))?/g, () => { b++; return ' '; });
  for (const tok of s.split(/[\s>+~]+/)) {
    const t = tok.trim();
    if (t && t !== '*') c++;
  }
  return [a, b, c];
}
const specCmp = (x, y) => (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]);

/* ══════════════════════════ SELECTOR MATCHER ══════════════════════════ */

/** Parse "div#a.b[c]:hover::before" into a compound descriptor. */
function parseCompound(str) {
  const cmp = { tag: null, id: null, classes: [], attrs: [], pseudos: [], pseudoEl: null, unsupported: false };
  let s = str.trim();
  s = s.replace(/::([a-zA-Z-]+)/g, (_, p) => { cmp.pseudoEl = p; return ''; });
  const re = /(^[a-zA-Z*][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([^\]]*)\]|:([a-zA-Z-]+)(\(([^)]*)\))?/g;
  let m, consumed = 0;
  while ((m = re.exec(s))) {
    consumed = re.lastIndex;
    if (m[1]) cmp.tag = m[1].toLowerCase();
    else if (m[2]) cmp.id = m[2];
    else if (m[3]) cmp.classes.push(m[3]);
    else if (m[4] !== undefined) cmp.attrs.push(m[4]);
    else if (m[5]) {
      const p = m[5].toLowerCase();
      if (p === 'before' || p === 'after') cmp.pseudoEl = p;
      else cmp.pseudos.push({ name: p, arg: m[7] });
    }
  }
  if (consumed < s.trim().length && s.trim().length) cmp.unsupported = true;
  return cmp;
}

/** Parse a full selector into [{combinator, compound}, ...] left→right. */
function parseSelector(sel) {
  const parts = [];
  const toks = sel.split(/\s*([>+~])\s*|\s+/).filter((t) => t !== undefined && t !== '');
  let combi = ' ';
  for (const t of toks) {
    if (t === '>' || t === '+' || t === '~') { combi = t; continue; }
    parts.push({ combi, compound: parseCompound(t) });
    combi = ' ';
  }
  return parts;
}

/**
 * Element spec:
 *   { tag, id, classes:[], attrs:{}, states:[], pseudoEl, parent: <spec|null> }
 * `attrs` covers [data-theme="dark"] via the ancestor <html> spec.
 */
function compoundMatches(cmp, el) {
  if (cmp.unsupported) return false;
  if (cmp.tag && cmp.tag !== '*' && cmp.tag !== (el.tag || '')) return false;
  if (cmp.id && cmp.id !== el.id) return false;
  for (const c of cmp.classes) if (!(el.classes || []).includes(c)) return false;
  for (const a of cmp.attrs) {
    const am = /^([\w-]+)\s*(?:([~|^$*]?=)\s*"?([^"\]]*)"?)?$/.exec(a.trim());
    if (!am) return false;
    const have = (el.attrs || {})[am[1]];
    if (have === undefined) return false;
    if (am[2] && String(have) !== am[3]) return false;
  }
  for (const p of cmp.pseudos) {
    const n = p.name;
    if (n === 'not') {
      const inner = parseCompound(p.arg || '');
      if (compoundMatches(inner, el)) return false;
      continue;
    }
    if (n === 'root') { if (el.tag !== 'html') return false; continue; }
    if (['hover', 'active', 'focus', 'disabled', 'checked', 'first-child', 'last-child', 'empty', 'placeholder', 'focus-visible'].includes(n)) {
      if (!(el.states || []).includes(n)) return false;
      continue;
    }
    return false; // unknown pseudo → don't match (conservative for "does my fix win")
  }
  if ((cmp.pseudoEl || null) !== (el.pseudoEl || null)) return false;
  return true;
}

function selectorMatches(sel, el) {
  const parts = parseSelector(sel);
  if (!parts.length) return false;
  if (parts.some((p) => p.combi === '+' || p.combi === '~')) return false; // unsupported → ignore rule
  let idx = parts.length - 1;
  if (!compoundMatches(parts[idx].compound, el)) return false;
  let node = el.parent;
  idx--;
  while (idx >= 0) {
    const { combi, compound } = parts[idx + 1].combi === '>' ? { combi: '>', compound: parts[idx].compound } : { combi: ' ', compound: parts[idx].compound };
    if (combi === '>') {
      if (!node || !compoundMatches(compound, node)) return false;
      node = node.parent;
    } else {
      let found = null, cur = node;
      while (cur) { if (compoundMatches(compound, cur)) { found = cur; break; } cur = cur.parent; }
      if (!found) return false;
      node = found.parent;
    }
    idx--;
  }
  return true;
}

/* ══════════════════════════ MEDIA EVALUATION ══════════════════════════ */
// Evaluate in the environment where these bugs live: a 390px phone, no hover.
const ENV = { width: 390, hover: false };
function mediaApplies(prelude) {
  const q = prelude.replace(/^@media\s*/i, '').trim().toLowerCase();
  let ok = true;
  let m;
  const maxRe = /\(\s*max-width\s*:\s*(\d+)px\s*\)/g;
  while ((m = maxRe.exec(q))) if (ENV.width > +m[1]) ok = false;
  const minRe = /\(\s*min-width\s*:\s*(\d+)px\s*\)/g;
  while ((m = minRe.exec(q))) if (ENV.width < +m[1]) ok = false;
  if (/\(\s*hover\s*:\s*hover\s*\)/.test(q) && !ENV.hover) ok = false;
  if (/prefers-reduced-motion\s*:\s*reduce/.test(q)) ok = false;
  return ok;
}
const ruleMediaOk = (r) => r.media.every(mediaApplies);

/* ══════════════════════════ CASCADE RESOLUTION ══════════════════════════ */

function resolve(el, prop) {
  let best = null;
  for (const r of RULES) {
    if (!ruleMediaOk(r)) continue;
    let d = null;
    for (const dd of r.decls) if (dd.prop === prop) d = dd;
    if (!d) {
      // shorthand fallbacks
      if (prop === 'border-color') { for (const dd of r.decls) if (dd.prop === 'border') d = { ...dd, val: shorthandBorderColor(dd.val) }; }
      if (!d) continue;
      if (d.val === null) continue;
    }
    if (!selectorMatches(r.sel, el)) continue;
    const sp = specificity(r.sel);
    const cand = { rule: r, decl: d, spec: sp };
    if (!best) { best = cand; continue; }
    if (cand.decl.important !== best.decl.important) { if (cand.decl.important) best = cand; continue; }
    const c = specCmp(cand.spec, best.spec);
    if (c > 0 || (c === 0 && cand.rule.order > best.rule.order)) best = cand;
  }
  // inline style beats everything except !important author rules
  if (el.inline && el.inline[prop] !== undefined) {
    if (!best || !best.decl.important) return { value: el.inline[prop], from: 'inline style', spec: [1, 0, 0], important: false };
  }
  if (!best) return null;
  return { value: best.decl.val, from: best.rule.sel, order: best.rule.order, important: best.decl.important, spec: best.spec, raw: best.rule.raw };
}

function shorthandBorderColor(val) {
  const m = /(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|var\([^)]*\)|transparent|currentcolor)/i.exec(val);
  return m ? m[1] : null;
}

/* ══════════════════════════ COLOUR RESOLUTION ══════════════════════════ */

function varTable(themeSel) {
  const t = {};
  for (const r of RULES) {
    if (r.sel !== themeSel) continue;
    for (const d of r.decls) if (d.prop.startsWith('--')) t[d.prop] = d.val;
  }
  return t;
}
const ROOT_VARS = varTable(':root');
const DARK_VARS = { ...ROOT_VARS, ...varTable('[data-theme="dark"]') };
const LIGHT_VARS = ROOT_VARS;
if (!DARK_VARS['--bg'] || DARK_VARS['--bg'] === LIGHT_VARS['--bg']) fail('dark theme --bg not found / not distinct — var table parse failed');

function expandVars(val, vars, depth = 0) {
  if (val == null || depth > 8) return val;
  let out = val, guard = 0;
  while (/var\(/.test(out) && guard++ < 12) {
    out = out.replace(/var\(\s*(--[\w-]+)\s*(?:,([^()]*(?:\([^()]*\)[^()]*)*))?\)/g, (_, name, fb) => {
      if (vars[name] !== undefined) return vars[name];
      return (fb || '').trim() || 'UNRESOLVED';
    });
  }
  return out;
}

function parseColor(v) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  if (s === 'transparent' || s === 'none' || s === 'unresolved') return null;
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return [parseInt(m[1][0] + m[1][0], 16), parseInt(m[1][1] + m[1][1], 16), parseInt(m[1][2] + m[1][2], 16), 1];
  m = /^#([0-9a-f]{6})$/.exec(s);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1];
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/.exec(s);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  // a background shorthand / gradient — pull the first colour token out
  const t = /(#[0-9a-f]{6}|#[0-9a-f]{3}|rgba?\([^)]*\))/i.exec(s);
  if (t) return parseColor(t[1]);
  return null;
}

const over = (fg, bg) => fg[3] >= 1 ? fg : [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat([1]);
const lum = (c) => {
  const f = c.slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
};
const contrast = (a, b) => { const l1 = lum(a), l2 = lum(b); const hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); };

/** Walk up until an opaque-enough background is found; default to the page bg. */
function effectiveBg(el, vars) {
  let node = el, acc = null;
  while (node) {
    const r = resolve(node, 'background-color') || resolve(node, 'background');
    const c = r ? parseColor(expandVars(r.value, vars)) : null;
    if (c) { acc = acc ? over(acc, c) : c; if (c[3] >= 1) return acc; }
    node = node.parent;
  }
  const page = parseColor(expandVars(vars['--bg'], vars)) || [255, 255, 255, 1];
  return acc ? over(acc, page) : page;
}

/* ══════════════════════════ ELEMENT BUILDERS ══════════════════════════ */

const HTML_DARK = { tag: 'html', classes: [], attrs: { 'data-theme': 'dark' }, parent: null };
const HTML_LIGHT = { tag: 'html', classes: [], attrs: {}, parent: null };
const BODY = (root) => ({ tag: 'body', classes: [], attrs: {}, parent: root });

/** Build an element chain from a descendant path like ".a .b > .c" */
function build(pathStr, { dark = true, states = [], pseudoEl = null, inline = null, extraParent = null } = {}) {
  const root = dark ? HTML_DARK : HTML_LIGHT;
  let node = extraParent || BODY(root);
  const toks = pathStr.split(/\s*>\s*|\s+/).filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    const c = parseCompound(toks[i]);
    const last = i === toks.length - 1;
    node = {
      tag: c.tag || null, id: c.id, classes: c.classes,
      attrs: {}, parent: node,
      states: last ? states : [],
      pseudoEl: last ? pseudoEl : null,
      inline: last ? inline : null,
    };
  }
  return node;
}

/* ══════════════════════════ CHECK 1 — dark fixes not overridden ══════════════════════════ */
{
  let checked = 0, dead = [];
  for (const r of RULES) {
    if (!r.sel.startsWith('[data-theme="dark"]')) continue;
    if (!ruleMediaOk(r)) continue;
    if (/::?(before|after)/.test(r.sel) === false && /:/.test(r.sel.replace(/\[[^\]]*\]/g, ''))) {
      // rule targets a state (:hover/:active) — build it with that state on
    }
    const bare = r.sel.replace(/^\[data-theme="dark"\]\s*/, '');
    if (!bare) continue;
    const stateM = bare.match(/:(hover|active|focus|disabled)\b/);
    const peM = bare.match(/::?(before|after)\b/);
    const clean = bare.replace(/:(hover|active|focus|disabled)\b/g, '').replace(/::?(before|after)\b/g, '');
    let el;
    try {
      el = build(clean, { dark: true, states: stateM ? [stateM[1]] : [], pseudoEl: peM ? peM[1] : null });
    } catch { continue; }
    if (!selectorMatches(r.sel, el)) { notes.push(`   (skipped unmatched dark selector: ${r.sel})`); continue; }
    for (const d of r.decls) {
      if (d.prop.startsWith('--')) continue;
      checked++;
      const w = resolve(el, d.prop);
      if (!w) { dead.push(`${r.sel} { ${d.prop} } — resolved to nothing`); continue; }
      if (!String(w.from).startsWith('[data-theme="dark"]')) {
        // A dark fix that loses to a THEME-AWARE value (var(--token)) is redundant,
        // not broken — the token flips with the theme, so the rendered result is still
        // correct. A dark fix that loses to a HARDCODED literal is the bug class this
        // whole file exists for: the fix is dead and the app renders the light value.
        const themeAware = /var\(\s*--/.test(w.value);
        const msg = `${r.sel} { ${d.prop}: ${d.val} } beaten by "${w.from}" { ${d.prop}: ${w.value}${w.important ? ' !important' : ''} } (spec ${w.spec.join('/')}, order ${w.order})`;
        if (themeAware) notes.push(`   ~   redundant (superseded by a theme-aware value): ${msg}`);
        else dead.push(`${msg}  <-- hardcoded literal wins, so the dark fix NEVER applies`);
      }
    }
  }
  notes.push(`check 1: resolved ${checked} declarations across dark-mode rules`);
  if (!checked) fail('check 1 found no dark-mode declarations to verify — the parser or the fixes are missing');
  for (const d of dead) fail(`OVERRIDDEN DARK FIX: ${d}`);
}

/* ══════════════════════════ CHECK 2 — readable colour pairs in dark ══════════════════════════ */

const MIN_TEXT = 4.5;
const MIN_UI = 3.0;   // non-text UI (indicator bars, icon strokes, borders)

function checkPair(label, elPath, opts = {}) {
  const {
    prop = 'color', min = MIN_TEXT, states = [], pseudoEl = null,
    inline = null, bgOf = null, dark = true,
  } = opts;
  const vars = dark ? DARK_VARS : LIGHT_VARS;
  const el = build(elPath, { dark, states, pseudoEl, inline });
  const fgR = resolve(el, prop);
  if (!fgR) { fail(`${label}: no "${prop}" resolves at all for "${elPath}"`); return; }
  const fg = parseColor(expandVars(fgR.value, vars));
  if (!fg) { fail(`${label}: could not resolve "${prop}" -> "${fgR.value}" (via ${fgR.from})`); return; }
  let bg;
  if (bgOf) {
    // `bgOf` may name a pseudo-element ("... .bv-header-icon::before") — that is how the
    // Assistant avatar's lavender disc is painted, and the glyph sits on top of it.
    const peM = /::(before|after)$/.exec(bgOf);
    const bgEl = build(bgOf.replace(/::(before|after)$/, ''), { dark, pseudoEl: peM ? peM[1] : null });
    bg = effectiveBg(bgEl, vars);
  } else if (prop === 'background' || prop === 'background-color') {
    bg = effectiveBg(el.parent, vars);
  } else {
    bg = effectiveBg(el, vars);
  }
  const ratio = contrast(over(fg, bg), bg);
  if (ratio < min) {
    fail(`${label}: ${prop} ${fgR.value} (via "${fgR.from}") on bg rgb(${bg.slice(0, 3).map(Math.round).join(',')}) = ${ratio.toFixed(2)}:1, need ${min}:1`);
  } else {
    notes.push(`   ok  ${label}  ${ratio.toFixed(1)}:1`);
  }
}

// --- the bottom nav (fix 1 + 2) -------------------------------------------
checkPair('nav active indicator', '.nav-tabs .nav-tab.active', { prop: 'background', pseudoEl: 'before', min: MIN_UI, bgOf: '.nav-tabs' });
checkPair('nav active tab icon', '.nav-tabs .nav-tab.active .tab-icon svg', { prop: 'stroke', min: MIN_UI, bgOf: '.nav-tabs' });

// --- the white button tier (fix 4) ----------------------------------------
for (const c of ['pipe-btn', 'detail-btn', 'tp-action-btn', 'canva-link', 'cm-card-btn', 'cm-detail-btn', 'copy-reel-btn', 'export-btn', 'vt-copy']) {
  checkPair(`white tier .${c} label`, `.${c}`);
  // and the fill must not be a white island on a dark page
  const el = build(`.${c}`, { dark: true });
  const bgR = resolve(el, 'background') || resolve(el, 'background-color');
  const bgc = bgR ? parseColor(expandVars(bgR.value, DARK_VARS)) : null;
  if (bgc && lum(bgc) > 0.55) fail(`white tier .${c}: fill ${bgR.value} (via "${bgR.from}") is a light island in dark mode (luminance ${lum(bgc).toFixed(2)})`);
}
checkPair('lavender primary .detail-btn.primary', '.detail-btn.primary');
checkPair('lavender primary .pipe-btn.next', '.pipe-btn.next');
checkPair('lavender primary .tp-action-btn.approve', '.tp-action-btn.approve');

// --- escape hatches (fix 5) -----------------------------------------------
checkPair('Assistant close x', '.bv-overlay .bv-header .bv-close', { min: MIN_UI });
checkPair('Assistant header svg', '.bv-overlay .bv-header svg', { prop: 'stroke', min: MIN_UI });
checkPair('Assistant header ICON disc svg (must stay ink on lavender)', '.bv-overlay .bv-header .bv-header-icon svg', { prop: 'stroke', min: MIN_UI, bgOf: '.bv-overlay .bv-header .bv-header-icon::before' });
checkPair('"Generate anyway" / Skip / Cancel', '.dismiss-popup .dp-cancel');

// --- the ~20 ink-on-surface controls (fix 6) -------------------------------
const INK_ON_SURFACE = [
  ['.vl-win-chip', {}],
  ['.batch-enter', {}],
  ['.batch-bar .batch-cancel', {}],
  ['.batch-bar .batch-all', {}],
  ['.idea-pick', {}],
  ['.dismiss-popup .dp-option', {}],
  ['.dp-mic-btn', { min: MIN_UI }],
  ['.action-circle.undo', { min: MIN_UI }],
  ['.mascot-bubble .mascot-bubble-btn', {}],
  ['.nb-mic', { min: MIN_UI }],
  ['.nb-act', {}],
  ['.dz-btn.reset', {}],
  ['.bv-vp-cancel', {}],
  ['.brv-sheet .brv-cancel', {}],
  ['.bv-home-chip', {}],
  ['.cm-nav-btn', { min: MIN_UI }],
  ['.tv-praise-chip', {}],
  ['.sp-method', {}],
];
for (const [sel, o] of INK_ON_SURFACE) checkPair(`ink-on-surface ${sel}`, sel, o);
checkPair('mascot bubble bolded field name', '.mascot-bubble .mascot-bubble-text strong');
checkPair('brand-brain nudge headline', '.bb-nudge .bb-nudge-txt strong');
// lavender variants of the same controls must stay INK (they are light fills)
for (const sel of ['.vl-win-chip.active', '.idea-pick.on', '.dismiss-popup .dp-option.sel', '.mascot-bubble .mascot-bubble-btn.primary', '.nb-act.develop', '.sp-method.sp-method-primary', '.batch-bar .batch-go', '.brv-sheet .brv-save']) {
  checkPair(`lavender variant ${sel}`, sel);
}
checkPair('action-circle approve (lavender)', '.action-circle.approve');

// --- contrast failures (fix 7) --------------------------------------------
for (const sel of ['.tour-btn.primary', '.blog-filter-btn.active', '.paa-badge', '.bm-link-editor-actions .bm-save-btn', '.sp-invite-btn.primary', '.bm-add-row button']) {
  checkPair(`contrast ${sel}`, sel);
}

// --- nothing broke in LIGHT mode ------------------------------------------
for (const sel of ['.detail-btn', '.pipe-btn', '.nav-tabs .nav-tab.active .tab-icon svg', '.dismiss-popup .dp-cancel', '.sp-method', '.nb-act', '.action-circle.undo', '.bv-overlay .bv-header .bv-close']) {
  const opts = { dark: false, min: MIN_UI };
  if (sel.endsWith('svg')) { opts.prop = 'stroke'; opts.bgOf = '.nav-tabs'; }
  checkPair(`LIGHT still fine ${sel}`, sel, opts);
}

// --- controls the audit listed that turned out to be ALREADY theme-correct ---
// Kept as regression guards, not as claims that they were broken.
checkPair('already-correct .tp-dismiss-chip', '.tp-dismiss-chip', { min: MIN_TEXT });

/* ══════════════════════════ CHECK 2b — inline-styled text (source-fixed) ══════════════════════════ */
// Inline styles cannot be overridden by any non-!important stylesheet rule, so these
// had to be fixed at source. Verify each resolves to a readable pair in dark.
function checkInline(label, re, { onBg = 'var(--surface)', min = MIN_TEXT } = {}) {
  const m = re.exec(html);
  if (!m) { fail(`${label}: markup not found (the fix may have been reverted or moved)`); return; }
  const style = m[1];
  const cm = /(?:^|;)\s*color\s*:\s*([^;]+)/i.exec(style);
  if (!cm) { fail(`${label}: no color in inline style`); return; }
  const bm = /(?:^|;)\s*background\s*:\s*([^;]+)/i.exec(style);
  const fg = parseColor(expandVars(cm[1].trim(), DARK_VARS));
  const bg = parseColor(expandVars((bm ? bm[1].trim() : onBg), DARK_VARS));
  if (!fg || !bg) { fail(`${label}: could not resolve ${cm[1]} on ${bm ? bm[1] : onBg}`); return; }
  const ratio = contrast(over(fg, bg), bg);
  if (ratio < min) fail(`${label}: inline color ${cm[1]} on ${bm ? bm[1] : onBg} = ${ratio.toFixed(2)}:1, need ${min}:1`);
  else notes.push(`   ok  inline ${label} ${ratio.toFixed(1)}:1`);
}
checkInline('brain card title', /font-weight:800;font-size:16px;(color:[^"]*?)">\$\{ICO\.spark\} Your brand brain/);
checkInline('brain "It already knows about you"', /<strong style="(color:[^"]*?)">It already knows about you:/);
checkInline('brain "A blank ChatGPT"', /<strong style="(color:[^"]*?)">A blank ChatGPT/);
checkInline('brainFlow "How your brand brain works"', /font-weight:700;(color:[^"]*?)">\$\{ICO\.spark\} How your brand brain works/);
// (the blog "Connect a site" summary was removed with the in-app publishing system —
//  it existed only to open the Posting Channels setup, so there is no longer a swatch here.)
checkInline('"Go to Settings" (profile lock hint)', /<span onclick="openSettingsFromLock\(\)" style="([^"]*?)">Go to Settings<\/span>/);
checkInline('"Go to Settings" (feature lock)', /openSettingsFromLock\(\)" style=\\?"([^"\\]*?)\\?">Go to Settings/);
checkInline('team member avatar', /<div class="sp-team-avatar" style="([^"]*?)">/);
checkInline('Assistant "edit Voice Memory by hand" link', /<a class="bv-manual-link"[^>]*style="([^"]*?)"/, { onBg: 'var(--surface)' });
checkInline('prompt-library Copy button', /style="(font-size:11px;background:var\(--gold\);color:[^"]*?)">Copy<\/button>/);
checkInline('settings add-community +', /style="(padding:10px 18px;border:none;background:var\(--accent\);color:[^"]*?)">\+<\/button>/);

/* ══════════════════════════ CHECK 3 — no white inline islands ══════════════════════════ */
{
  const ids = ['remixQuick', 'vlQuick', 'memeQuick'];
  for (const id of ids) {
    const re = new RegExp(`<div[^>]*id="${id}"[^>]*style="([^"]*)"`, 'i');
    const m = re.exec(html);
    if (!m) { fail(`quick-lane card #${id} not found in markup`); continue; }
    const style = m[1];
    if (/background\s*:\s*#fff\b|background\s*:\s*#ffffff\b|background\s*:\s*white\b/i.test(style)) {
      fail(`quick-lane card #${id} still has a hardcoded white inline background: ${style}`);
    }
    const bgm = /background\s*:\s*([^;]+)/i.exec(style);
    if (!bgm) { fail(`quick-lane card #${id} has no background in its inline style`); continue; }
    const c = parseColor(expandVars(bgm[1].trim(), DARK_VARS));
    if (!c) { fail(`quick-lane card #${id} background "${bgm[1]}" does not resolve`); continue; }
    if (lum(c) > 0.55) { fail(`quick-lane card #${id} still renders as a light island in dark mode (${bgm[1]})`); continue; }
    // and the headline text (which inherits body colour) must be readable on it
    const bodyColor = parseColor(expandVars(DARK_VARS['--text'], DARK_VARS));
    const ratio = contrast(bodyColor, c);
    if (ratio < MIN_TEXT) fail(`quick-lane card #${id}: inherited body text on card = ${ratio.toFixed(2)}:1`);
    else notes.push(`   ok  quick-lane #${id} card+headline ${ratio.toFixed(1)}:1`);
  }
  // The ink ring must SURVIVE in light (no unintended light-mode redesign) while the
  // dark layer gives the card a visible edge. Both halves are asserted.
  const MIN_BORDER = 1.4;
  for (const id of [...ids, 'as-close']) {
    const isCls = id === 'as-close';
    const markup = isCls ? /<button class="as-close"[^>]*style="([^"]*)"/.exec(html) : new RegExp(`<div[^>]*id="${id}"[^>]*style="([^"]*)"`, 'i').exec(html);
    if (!markup || !/border\s*:\s*1\.5px solid #16130F/.test(markup[1])) {
      fail(`${id}: the ink border was changed in LIGHT mode too — light should be untouched`);
      continue;
    }
    const el = isCls ? build('.as-close', { dark: true }) : build(`#${id}`, { dark: true });
    const bc = resolve(el, 'border-color');
    const c = bc && parseColor(expandVars(bc.value, DARK_VARS));
    const page = parseColor(expandVars(DARK_VARS['--bg'], DARK_VARS));
    if (!c) { fail(`${id}: no dark border-color resolves (the inline ink border still wins)`); continue; }
    const ratio = contrast(c, page);
    if (ratio < MIN_BORDER) fail(`${id}: dark border ${bc.value} (via "${bc.from}") is invisible on the page (${ratio.toFixed(2)}:1)`);
    else notes.push(`   ok  ${id} dark border ${ratio.toFixed(2)}:1, ink ring kept in light`);
  }
  // the angle-sheet close x is an inline-styled escape hatch too
  const ax = /onclick="closeAngleSheet\(\)"\s+aria-label="Close"\s+style="([^"]*)"/.exec(html);
  if (!ax) fail('angle-sheet close button not found');
  else {
    const cm = /(?:^|;)\s*color\s*:\s*([^;]+)/i.exec(ax[1]);
    const bm = /(?:^|;)\s*background\s*:\s*([^;]+)/i.exec(ax[1]);
    const fg = cm && parseColor(expandVars(cm[1].trim(), DARK_VARS));
    const bg = bm && parseColor(expandVars(bm[1].trim(), DARK_VARS));
    if (!fg || !bg) fail('angle-sheet close x: colour/background do not resolve');
    else {
      const ratio = contrast(fg, bg);
      if (ratio < MIN_UI) fail(`angle-sheet close x is invisible in dark: ${ratio.toFixed(2)}:1 (${cm[1]} on ${bm[1]})`);
      else notes.push(`   ok  angle-sheet close x ${ratio.toFixed(1)}:1`);
    }
  }
}

/* ══════════════════════════ CHECK 4 — fixed + opacity:0 must not eat taps ══════════════════════════ */
{
  // Elements that are created and removed per use, so they never linger invisibly
  // over the page. Each needs a reason, not just a name.
  const EPHEMERAL = {
    '.brv-overlay': 'brain-review sheet: built by openBrainReview() and .remove()d by closeBrainReview() — it does not exist while hidden',
  };
  const seen = new Set();
  let checked = 0;
  for (const r of RULES) {
    if (!r.decls.some((d) => d.prop === 'position' && /fixed/i.test(d.val))) continue;
    if (seen.has(r.sel)) continue;
    seen.add(r.sel);
    if (EPHEMERAL[r.sel]) {
      // Only excusable if the claim is TRUE — the element must actually be removed from the DOM.
      const cls = r.sel.replace(/^\./, '');
      const created = new RegExp(`className\\s*=\\s*['"\`][^'"\`]*${cls}|class=["'\`][^"'\`]*${cls}`).test(html);
      const removed = /\.remove\(\)/.test(html);
      if (!created || !removed) fail(`allowlisted ephemeral "${r.sel}" could not be confirmed as created/removed per use`);
      else notes.push(`   ok  ephemeral "${r.sel}" exempt — ${EPHEMERAL[r.sel]}`);
      continue;
    }
    const bare = r.sel.replace(/^\[data-theme="dark"\]\s*/, '');
    const stateM = bare.match(/:(hover|active|focus|disabled)\b/);
    const clean = bare.replace(/:(hover|active|focus|disabled)\b/g, '').replace(/::?(before|after)\b/g, '');
    if (!clean.trim()) continue;
    let el;
    try { el = build(clean, { dark: true, states: stateM ? [stateM[1]] : [] }); } catch { continue; }
    if (!selectorMatches(r.sel, el)) continue;
    const pos = resolve(el, 'position');
    if (!pos || !/fixed/i.test(pos.value)) continue;
    const op = resolve(el, 'opacity');
    if (!op || parseFloat(op.value) !== 0) continue;
    checked++;
    const pe = resolve(el, 'pointer-events');
    if (!pe || !/none/i.test(pe.value)) {
      fail(`TAP BLOCKER: "${r.sel}" is position:fixed with opacity:0 but pointer-events resolves to "${pe ? pe.value : 'auto (default)'}" — invisible and still hit-testable`);
    } else {
      notes.push(`   ok  fixed+opacity:0 "${r.sel}" -> pointer-events:none`);
    }
  }
  notes.push(`check 4: examined ${checked} fixed+opacity:0 element(s)`);
  if (!checked) fail('check 4 examined nothing — the matcher is broken');
}

/* ══════════════════════════ CHECK 5 — mascot no longer floats over the nav ══════════════════════════ */
{
  const mascot = build('.mascot-wrap', { dark: true });
  const z = resolve(mascot, 'z-index');
  const nav = build('.nav-tabs', { dark: true });
  const navZ = resolve(nav, 'z-index');
  if (!z) fail('mascot: no z-index resolves for .mascot-wrap');
  else if (!navZ) fail('nav: no z-index resolves for .nav-tabs');
  else if (parseInt(z.value, 10) >= parseInt(navZ.value, 10)) {
    fail(`TAP BLOCKER: .mascot-wrap z-index ${z.value} >= .nav-tabs z-index ${navZ.value} — the pointer-events:auto shrimp floats over the nav, sheets and modals`);
  } else {
    notes.push(`   ok  mascot z-index ${z.value} < nav ${navZ.value}`);
  }
  const pet = build('.mascot-wrap .mascot-pet', { dark: true });
  const pePet = resolve(pet, 'pointer-events');
  if (!pePet || !/auto/i.test(pePet.value)) fail('mascot: the shrimp itself is no longer tappable (.mascot-pet pointer-events should stay auto)');
  else notes.push('   ok  .mascot-pet still tappable');
}

/* ══════════════════════════ REPORT ══════════════════════════ */
if (process.env.VERBOSE) for (const n of notes) console.log(n);
else console.log(notes.filter((n) => !n.startsWith('   ok')).join('\n'));

if (failures.length) {
  console.error(`\n${failures.length} FAILURE(S):`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`checks passed: ${notes.filter((n) => n.startsWith('   ok')).length} assertions`);
console.log('dark mode verification passed');
