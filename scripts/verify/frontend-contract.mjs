#!/usr/bin/env node
// GATE: the frontend contract — app.html cannot re-open the brand-isolation, honesty and
// visibility bugs that were fixed in this round.
//
// WHY THIS EXISTS
//   One bug CLASS caused most of them: a function reads the brand at call time, awaits a
//   15-40s round trip, and then WRITES using whatever brand is open when the response lands.
//   A brand switch mid-flight files brand A's data under brand B — silently, permanently,
//   with nothing on screen to show it happened. The house fix is brandGate(), captured
//   BEFORE the await and enforced at every write.
//
//   The checks below are SCANS, not lists of the functions that were fixed. A NEW unguarded
//   writer added next month goes red on its own — which is the only version of this gate
//   worth having.
//
// WHAT IT ASSERTS (behaviour/structure, never copy)
//   1. every async function that writes brand-scoped data holds a pre-await brand check
//   2. no per-brand cache key is rebuilt from currentBrand.id AFTER an await
//   3. no raw localStorage get/set on a bkey()-built key, and no undefined key helper
//   4. every silently-refusable delete verifies ROWS, not just `error`
//   5. no ink-!important control sits on a dark-theme background with no override
//      (contrast is COMPUTED from the declared theme tokens — no selector list)
//   6. every scrollIntoView({block:'start'}) target carries scroll-margin-top
//
// RUN:    node scripts/verify/frontend-contract.mjs
// EXPECT: frontend contract verification passed

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const HTML = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');

const fails = [];
let checks = 0;
const check = (ok, msg) => { checks++; if (!ok) fails.push(msg); };

// ── source slicing ────────────────────────────────────────────────────────────
const SCRIPTS = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (!SCRIPTS.length) { console.error('FAIL — no inline <script> blocks found in app.html'); process.exit(1); }
// The app is one enormous inline block plus a few small ones; scan them all.
const JS = SCRIPTS.join('\n/*__BLOCK__*/\n');
// CSS comments are stripped FIRST: several of them quote selectors and JS snippets containing
// braces, which would otherwise cut the naive rule parser below in half.
const CSS = [...HTML.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, ' ');
if (!CSS.trim()) { console.error('FAIL — no <style> blocks found in app.html'); process.exit(1); }

// Top-level functions in this file always start at column 0 and end at a column-0 "}".
// Slicing on that is exact here and, unlike brace counting, cannot be fooled by a brace
// inside a string literal (a trap that has cost this repo three debugging rounds).
function topLevelFunctions(src) {
  const lines = src.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(lines[i]);
    if (!m) continue;
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j] === '}') { end = j; break; }
      if (/^(async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/.test(lines[j])) break; // unterminated; bail
    }
    if (end === -1) continue;
    out.push({ name: m[2], isAsync: !!m[1], start: i + 1, body: lines.slice(i, end + 1).join('\n') });
  }
  return out;
}
const FUNCS = topLevelFunctions(JS);
// Report positions in app.html, not in the concatenated script — the reader has to open the file.
{
  const htmlLines = HTML.split('\n');
  const seen = new Map();
  htmlLines.forEach((l, i) => { const t = l.trim(); if (t) { if (!seen.has(t)) seen.set(t, i + 1); else seen.set(t, -1); } });
  for (const f of FUNCS) {
    const decl = f.body.split('\n')[0].trim();
    const at = seen.get(decl);
    f.at = (at && at > 0) ? at : f.start;
  }
}
check(FUNCS.length > 300, `function extraction looks broken — found only ${FUNCS.length} top-level functions`);

// Strip line/block comments so prose ABOUT a bug never matches a scan for the bug.
// (Every fix in this file is documented in a comment directly above it; a naive grep
//  would read those comments as the code and pass a file that had been reverted.)
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}

// ── 1. brand gate coverage ────────────────────────────────────────────────────
// A "brand-scoped write" is any call that persists data the database or localStorage
// files under a brand id. If one of these runs after an await, the brand must have been
// captured before that await.
//
// The second half of the sink list is DERIVED, not written down: addNewBrand() resets
// exactly the globals that belong to a brand, so whatever it clears is by definition
// brand-scoped. Add a new brand-scoped global and this check picks it up on its own.
const BRAND_GLOBALS = (() => {
  const m = /\nasync function addNewBrand\s*\(\)[\s\S]*?\n\}/.exec(JS);
  if (!m) return [];
  const names = new Set();
  for (const a of stripComments(m[0]).matchAll(/(?:^|[\s;{])([A-Za-z_$][\w$]*)\s*(?:\.length)?\s*=[^=]/g)) {
    if (!['currentBrand', 'settings'].includes(a[1])) names.add(a[1]);
  }
  return [...names];
})();
const WRITE_SINKS = [
  /\blsSet\s*\(/,                       // per-brand localStorage
  /\bsaveEditSignals\s*\(/,             // taste signals -> edit_signals.brand_id
  /\b_replaceBrandRows\s*\(/,           // any brand-scoped table rewrite
  /\bsaveIdeasToDB\s*\(/, /\bsaveRemixesToDB\s*\(/, /\bsaveNotebookToDB\s*\(/,
  /\bsaveRefsToDB\s*\(/, /\bsaveBookmarksToDB\s*\(/, /\bsavePromptHistoryToDB\s*\(/,
  /\bsaveBlogPosts\s*\(/, /\bsavePAAState\s*\(/, /\bsaveTrend\s*\(/,
  /\bsaveState\s*\(/, /\bsaveSettings\s*\(/,
  /\bbrand_id\s*:/,                     // a literal row write
  ...BRAND_GLOBALS.map(n => new RegExp('(?:^|[\\s;{])' + n + '\\s*(?:\\.length)?\\s*=[^=]')),
];
check(BRAND_GLOBALS.length > 5, `derived only ${BRAND_GLOBALS.length} brand-scoped globals from addNewBrand — the sink list would be thin`);
// Accepted pre-await brand checks. brandGate() is the house fix; switchBrand's own
// _switchSeq token is the same guarantee expressed differently (it IS the switcher), and
// a captured id compared later is equivalent.
const GATE_CAPTURE = /\bbrandGate\s*\(\s*\)/;
const TOKEN_CAPTURE = /\b(myToken|_seq\w*)\s*=\s*(\+\+)?_switchSeq\b/;

const ungated = [];
for (const fn of FUNCS) {
  const body = stripComments(fn.body);
  const lines = body.split('\n');
  const awaitLines = lines.map((l, i) => (/\bawait\b/.test(l) ? i : -1)).filter(i => i >= 0);
  if (!awaitLines.length) continue;
  // The write must land after a COMPLETED await. `const r = await _replaceBrandRows(...)` is the
  // await itself, not a post-await write — the id it passes was resolved before the call.
  let sink = null, sinkLine = -1;
  for (let i = awaitLines[0] + 1; i < lines.length && !sink; i++) {
    const hit = WRITE_SINKS.find(rx => rx.test(lines[i]));
    if (hit) { sink = hit; sinkLine = i; }
  }
  if (!sink) continue;
  // The capture has to precede the awaits that SEPARATE it from the write — that is the window a
  // brand switch can open in. An await before the capture (switchBrand flushes the outgoing
  // brand's pending save first, on purpose) does not weaken the pin that comes after it.
  const lastAwaitBeforeSink = awaitLines.filter(i => i < sinkLine).pop();
  const before = lines.slice(0, lastAwaitBeforeSink).join('\n');
  const after = lines.slice(awaitLines[0]).join('\n');
  const captured = GATE_CAPTURE.test(before) || TOKEN_CAPTURE.test(before);
  // A capture with no enforcement is decoration — and enforcement somewhere else in the function
  // does not protect THIS write. Require the test to sit in the window between the await that
  // opens the switch window and the write itself.
  // …between the FIRST await (which opens the window) and the write. Awaits that sit between the
  // test and the write are the write's own I/O — they cannot change what was already pinned.
  const window = lines.slice(awaitLines[0], sinkLine + 1).join('\n');
  const enforced = /\b_(sameBrand|stillSameBrand|vg|brandGate\w*)\s*\(\s*\)/.test(window)
    || /_switchSeq/.test(window)
    || /_brandReviewGate/.test(body)
    || /\bbrandGate\s*\(\s*\)/.test(after);   // gate captured here for a later click handler
  if (!captured || !enforced) {
    ungated.push({ name: fn.name, line: fn.at, captured, sink: String(sink) });
  }
}

// A capture with no enforcement is decoration — that is never acceptable, baseline or not.
const decorative = ungated.filter(u => u.captured);
check(decorative.length === 0,
  'brandGate() captured but never enforced (the gate only helps if it is TESTED at write time):\n    - ' +
  decorative.map(u => `${u.name} (app.html:${u.line})`).join('\n    - '));

// RATCHET, not a wish. These functions write brand-scoped data after an await today with no
// pre-await brand check — pre-existing debt, listed so it is visible and can only shrink. The
// point of the scan is the OTHER direction: any writer not on this list (a new one, or a gated
// one whose gate was removed) fails immediately. Never add a name here to make a red run green.
const KNOWN_UNGATED = new Set([
  'inviteByEmail', 'generateInviteLink',                     // one-shot inserts of their own row
    
   // v679: pullReviews is GATED now — it captured brandGate() before its fetch and enforces
   // it after, so one brand's reviews can no longer be written into another's brain.
   // (was: 'pullReviews',)
  'obFinish', 'bvFinishOnboarding', 'initApp',               // boot / first-run: no brand to switch away from
   
]);
const regressions = ungated.filter(u => !u.captured && !KNOWN_UNGATED.has(u.name));
check(regressions.length === 0,
  'NEW unguarded brand-scoped writer(s) — capture brandGate() BEFORE the await and test it at every write:\n    - ' +
  regressions.map(u => `${u.name} (app.html:${u.line}) — sink: ${u.sink}`).join('\n    - '));
// The ratchet must also tighten: a baseline entry that has since been fixed has to be removed,
// or the list slowly stops meaning anything.
const staleBaseline = [...KNOWN_UNGATED].filter(n => !ungated.some(u => u.name === n) && FUNCS.some(f => f.name === n));
check(staleBaseline.length === 0,
  'KNOWN_UNGATED lists function(s) that are now gated — delete them from the baseline: ' + staleBaseline.join(', '));

// ── 2. no per-brand cache key rebuilt from currentBrand.id after an await ──────
// The DB write may correctly use a pre-await id while the cache key underneath silently
// re-reads the global — that is how one brand's notes get filed under another's key.
const lateKeys = [];
for (const fn of FUNCS) {
  const body = stripComments(fn.body);
  const firstAwait = body.search(/\bawait\b/);
  if (firstAwait === -1) continue;
  const after = body.slice(firstAwait);
  // Only the KEY argument matters. `setItem('cs_last_brand', currentBrand.id)` stores the id as a
  // VALUE under a fixed device-global key — that is not a per-brand namespace.
  const rx = /localStorage\.(?:set|get|remove)Item\s*\(([^;,)]{0,160}(?:\([^()]*\))?[^;,)]{0,80})/g;
  let m;
  while ((m = rx.exec(after))) {
    if (/currentBrand\s*(?:&&\s*currentBrand\s*)?\.?\s*\.?id/.test(m[1]) || /\bbkey\s*\(/.test(m[1])) {
      lateKeys.push(`${fn.name} (app.html:${fn.at}) builds a per-brand localStorage key from currentBrand.id AFTER an await: ${m[0].slice(0, 90)}`);
    }
  }
}
check(lateKeys.length === 0,
  'per-brand cache key resolved after an await — capture the id ONCE before the await:\n    - ' + lateKeys.join('\n    - '));

// ── 2b. a read that feeds a brand-scoped global must inspect `error` ─────────
// PostgREST RESOLVES `{data:null, error:{…}}` — it does not throw — so destructuring `data`
// alone turns a failed read into a silently truncated list that is then assigned wholesale.
// The user sees an account with no brands, or a team with no members, and no error at all.
const swallowed = [];
for (const fn of FUNCS) {
  const body = stripComments(fn.body);
  const rx = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*await\s+(?:sb|supabase)\s*\.from\s*\(([^)]*)\)\s*\.select\s*\(/g;
  let m;
  while ((m = rx.exec(body))) {
    if (/\berror\b/.test(m[1])) continue;
    swallowed.push(`${fn.name} (app.html:${fn.at}) reads ${m[2].trim()} and never looks at \`error\` — a failed read becomes an empty list`);
  }
}
check(swallowed.length === 0,
  'read error(s) swallowed into a silently empty list — destructure `error` and surface it:\n    - ' + swallowed.join('\n    - '));

// ── 3. no raw localStorage on a bkey() key, and no undefined key helper ───────
// bkey() falls back to a SHARED "::_none" bucket when no brand is loaded, so a raw
// get/set on it can read and write a bucket every brand shares. lsGet/lsSet/lsDel are
// null-safe and are the only sanctioned accessors.
const JS_NC = stripComments(JS);
// The three accessors are themselves the only sanctioned users of bkey() — skip their own lines.
const JS_NO_ACCESSORS = JS_NC.split('\n')
  .filter(l => !/^\s*function\s+ls(?:Get|Set|Del)\s*\(/.test(l)).join('\n');
const rawBkey = [...JS_NO_ACCESSORS.matchAll(/localStorage\.(?:set|get|remove)Item\s*\([^;]{0,120}?bkey\s*\(/g)].map(m => m[0]);
check(rawBkey.length === 0,
  'raw localStorage on a bkey() key — use lsGet/lsSet/lsDel (null-safe), or the shared "::_none" bucket bleeds between brands:\n    - ' +
  rawBkey.join('\n    - '));

// Every identifier called to BUILD a localStorage key must exist. A half-finished rename
// leaves `localStorage.getItem(_scanKey())` calling a function that was deleted: the
// ReferenceError is swallowed by the surrounding try and the feature silently never fires.
const definedNames = new Set();
for (const m of JS_NC.matchAll(/(?:function\s+|(?:const|let|var)\s+)([A-Za-z_$][\w$]*)\s*(?:\(|=)/g)) definedNames.add(m[1]);
const missingHelpers = [];
for (const m of JS_NC.matchAll(/localStorage\.(?:set|get|remove)Item\s*\(\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
  if (!definedNames.has(m[1])) missingHelpers.push(m[1] + '()');
}
check(missingHelpers.length === 0,
  'localStorage key built by a helper that is not defined anywhere (throws, is swallowed by the enclosing try, feature dies silently): ' +
  missingHelpers.join(', '));

// ── 4. a silently-refusable delete must verify ROWS, not just `error` ─────────
// A PostgREST/RLS refusal resolves {data:[], error:null}. The harm is not the delete — it is
// the CLAIM: a statement that destructures `error` is about to decide whether to tell the user
// it succeeded, and `error` alone cannot see a refusal. So judge exactly those statements.
// A fire-and-forget delete promises nothing and is left alone.
const blindDeletes = [];
for (const m of JS_NC.matchAll(/\{[^{}]*\berror\b[^{}]*\}\s*=\s*await\s+[^;]{0,80}?\.from\s*\(([^)]*)\)\s*\.delete\s*\(\s*\)([\s\S]{0,300}?);/g)) {
  if (/\.select\s*\(/.test(m[2] || '')) continue;
  const at = JS_NC.slice(0, m.index).split('\n').length;
  blindDeletes.push(`delete on ${m[1].trim()} (inline js line ~${at}) inspects only \`error\` and never calls .select() — an RLS refusal returns 0 rows and NO error, so it reports a sweep it did not perform`);
}
check(blindDeletes.length === 0, 'delete(s) that can report success they never achieved:\n    - ' + blindDeletes.join('\n    - '));

// The same lie, one indirection further out: the builder is stashed in a variable first, so the
// `.delete()` and the `{ error } = await …` are on different lines.
const blindViaBuilder = [];
for (const fn of FUNCS) {
  const body = stripComments(fn.body);
  const builders = [...body.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:sb|supabase)\s*\.from\s*\(([^)]*)\)\s*\.delete\s*\(\s*\)/g)]
    .map(m => ({ v: m[1], table: m[2].trim() }));
  for (const b of builders) {
    const rx = new RegExp('\\{[^{}]*\\berror\\b[^{}]*\\}\\s*=\\s*await[^;]*\\b' + b.v + '\\b([^;]*);', 'g');
    let m;
    while ((m = rx.exec(body))) {
      if (!/\.select\s*\(/.test(m[0])) {
        blindViaBuilder.push(`${fn.name} (app.html:${fn.at}) awaits a stashed delete on ${b.table} and inspects only \`error\` — no .select(), so a silent refusal reads as success`);
      }
    }
  }
}
check(blindViaBuilder.length === 0, 'stashed delete builder(s) awaited without verifying rows:\n    - ' + blindViaBuilder.join('\n    - '));

// ── 5. computed dark-mode contrast for ink-!important controls ────────────────
// A sweep that forces `color:#16130F !important` on a control with a transparent (or
// theme-token) background is invisible the moment --surface flips dark. Contrast is
// COMPUTED against the declared dark tokens rather than checked against a selector list,
// so a control added to that sweep tomorrow is caught the same way.
function themeTokens(themeSelector) {
  const rx = new RegExp(themeSelector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g');
  const map = {};
  let m;
  while ((m = rx.exec(CSS))) {
    for (const d of m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) map[d[1]] = d[2].trim();
  }
  return map;
}
const DARK = themeTokens('[data-theme="dark"]');
check(Object.keys(DARK).length > 5, 'could not read the dark theme tokens from app.html — the contrast check would be vacuous');

function hexToRgb(h) {
  h = h.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}
function resolve(v, depth = 0) {
  if (!v || depth > 4) return null;
  v = v.trim().replace(/\s*!important\s*$/, '');
  const varM = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/.exec(v);
  if (varM) return resolve(DARK[varM[1]] || varM[2] || '', depth + 1);
  return hexToRgb(v);
}
const lum = rgb => {
  const [r, g, b] = rgb.map(c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 2.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };

// Collect every rule as { selectors[], decls }, ignoring @media wrappers for simplicity
// (the selectors are what matter here).
const RULES = [...CSS.matchAll(/([^{}@]+)\{([^{}]*)\}/g)]
  .map(m => ({ sel: m[1].trim(), decls: m[2] }))
  .filter(r => r.sel && !r.sel.startsWith('@'));

// Which single-class selectors are given a dark override for colour or background?
const darkOverridden = new Set();
for (const r of RULES) {
  if (!/\[data-theme="dark"\]/.test(r.sel)) continue;
  if (!/(?:^|;|\s)(?:color|background)\s*:/.test(r.decls)) continue;
  for (const part of r.sel.split(',')) {
    // Only a BARE class counts. `[data-theme="dark"] .spark-mic.recording` and `…:hover` fix a
    // state, not the resting control — treating them as coverage is how the invisible default
    // survived a dark-mode pass.
    const bare = /^\[data-theme="dark"\]\s*\.([\w-]+)\s*$/.exec(part.trim());
    if (bare) darkOverridden.add(bare[1]);
  }
}
// Backgrounds each class declares for itself, anywhere in the light sheet.
const ownBg = new Map();
for (const r of RULES) {
  if (/\[data-theme="dark"\]/.test(r.sel)) continue;
  const bg = /(?:^|;|\s)background(?:-color)?\s*:\s*([^;]+)/.exec(r.decls);
  if (!bg) continue;
  for (const part of r.sel.split(',')) {
    const t = part.trim();
    const single = /^\.([\w-]+)$/.exec(t);
    if (single) ownBg.set(single[1], bg[1].trim());
  }
}
const inkOnDark = [];
for (const r of RULES) {
  if (/\[data-theme="dark"\]/.test(r.sel)) continue;
  const col = /(?:^|;|\s)color\s*:\s*(#[0-9a-fA-F]{3,6})\s*!important/.exec(r.decls);
  if (!col) continue;
  const fg = hexToRgb(col[1]);
  if (!fg || lum(fg) > 0.2) continue;                      // only forced DARK ink matters
  for (const part of r.sel.split(',')) {
    const t = part.trim();
    const single = /^\.([\w-]+)$/.exec(t);
    if (!single) continue;                                  // compound/descendant selectors: skip
    const cls = single[1];
    if (darkOverridden.has(cls)) continue;                  // an override exists
    // Its own background if it declares one; otherwise it inherits the container, which in
    // this app is a --surface panel.
    const declared = /(?:^|;|\s)background(?:-color)?\s*:\s*([^;!]+)/.exec(r.decls);
    let bgRaw = (declared && declared[1].trim()) || ownBg.get(cls) || 'var(--surface)';
    if (/^(none|transparent|inherit)$/i.test(bgRaw)) bgRaw = 'var(--surface)';
    const bg = resolve(bgRaw);
    if (!bg) continue;                                      // gradient/unresolvable — not judged
    const ratio = contrast(fg, bg);
    if (ratio < 3) {
      inkOnDark.push(`.${cls} forces ${col[1]} !important on ${bgRaw} → ${ratio.toFixed(2)}:1 in dark mode, with no [data-theme="dark"] override`);
    }
  }
}
check(inkOnDark.length === 0,
  'control(s) invisible in dark mode (an !important ink sweep can only be beaten by a higher-specificity dark rule):\n    - ' +
  inkOnDark.join('\n    - '));

// ── 6. scrollIntoView({block:'start'}) targets need scroll-margin-top ─────────
// The header is sticky, so a top-aligned scroll parks the target's first lines underneath it.
const smtSelectors = new Set();
for (const r of RULES) {
  if (!/scroll-margin-top\s*:/.test(r.decls)) continue;
  for (const part of r.sel.split(',')) smtSelectors.add(part.trim());
}
check(smtSelectors.size > 3, 'no scroll-margin-top rules found — check 6 would be vacuous');

const scrollTargets = [];
for (const m of JS_NC.matchAll(/([A-Za-z_$][\w$]*)\s*\.scrollIntoView\s*\(\s*\{[^}]*block\s*:\s*['"]start['"][^}]*\}\s*\)/g)) {
  const varName = m[1];
  // Resolve the variable back to the selector it was queried with, in the 2500 chars before.
  const ctx = JS_NC.slice(Math.max(0, m.index - 2500), m.index);
  let sel = null;
  const byId = [...ctx.matchAll(new RegExp('\\b' + varName + '\\s*=\\s*(?:[\\w.]*\\s*)?document\\.getElementById\\(\\s*[\'"]([\\w-]+)[\'"]', 'g'))].pop();
  if (byId) sel = '#' + byId[1];
  if (!sel) {
    const byQ = [...ctx.matchAll(new RegExp('\\b' + varName + '\\s*=\\s*[^;\\n]*?querySelector\\w*\\(\\s*[\'"]([^\'"]+)[\'"]', 'g'))].pop();
    if (byQ) sel = byQ[1].split(/[\s>,]/)[0];
  }
  if (!sel) continue;                                       // unresolvable target — not judged
  scrollTargets.push(sel);
}
check(scrollTargets.length >= 3, `resolved only ${scrollTargets.length} scrollIntoView targets — check 6 would be near-vacuous`);
const uncovered = [...new Set(scrollTargets)].filter(sel => {
  if (smtSelectors.has(sel)) return false;
  // A class selector is also covered if a rule lists it among others, or an id target's
  // element carries a covered class in the markup.
  if (sel.startsWith('#')) {
    const id = sel.slice(1);
    const tag = new RegExp('id=["\']' + id + '["\'][^>]*class=["\']([^"\']+)|class=["\']([^"\']+)["\'][^>]*id=["\']' + id + '["\']').exec(HTML);
    const classes = ((tag && (tag[1] || tag[2])) || '').split(/\s+/).filter(Boolean);
    return !classes.some(c => smtSelectors.has('.' + c));
  }
  return true;
});
check(uncovered.length === 0,
  'scrollIntoView({block:"start"}) target(s) with no scroll-margin-top — the sticky header crops their first lines: ' +
  uncovered.join(', '));

// ── report ────────────────────────────────────────────────────────────────────
if (fails.length) {
  console.error('FAIL — frontend contract broken:');
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`frontend contract: ${checks} checks passed over ${FUNCS.length} functions, ${RULES.length} CSS rules`);
console.log('frontend contract verification passed');
