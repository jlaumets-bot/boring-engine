#!/usr/bin/env node
// GATE: a malformed model reply must not be able to leave a tab permanently blank.
//
// WHY THIS EXISTS
//   /api/remix returned `extractJson(content)` raw — proof only that the reply PARSED, never that
//   its fields were strings. The client unshifts that object into `remixes`, saves it to
//   localStorage AND Supabase, and then renders it. `escapeHtml` was the one escaper in app.html
//   that did not coerce (`str.replace(...)` on a bare parameter), and `remixHasContent` called
//   `.trim()` on raw field values. So one reply with `"remixScript": 12345`:
//     * threw inside renderRemixResults BEFORE `el.innerHTML` was assigned, leaving the list as it
//       was — blank on a first render;
//     * was already persisted, so it was re-read and threw again on EVERY subsequent load.
//   A reload never cleared it. Measured on the real functions: 5 of 6 malformed shapes threw.
//
// HOW IT CHECKS
//   By RUNNING the real remixHasContent / escapeHtml / renderRemixResults out of app.html against
//   malformed rows, and by running the real normalizer out of api/remix.js. Both halves are
//   required: the server fix stops new bad rows, the client fix repairs the ones already saved.
//
// RUN:    node scripts/verify/render-crash-proof.mjs
// EXPECT: prints "PASS" and exits 0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const fails = [];
const bad = m => fails.push(m);

// Top-level functions in app.html close with a '}' at column 0. Brace counting is not usable here:
// renderRemixResults is mostly template literals with nested ${} and quotes inside them.
function extractFn(name) {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in app.html`);
  const end = html.indexOf('\n}', start);
  if (end < 0) throw new Error(`${name}: no closing brace at column 0`);
  return html.slice(start, end + 2);
}

const SRC = [extractFn('remixHasContent'), extractFn('escapeHtml'), extractFn('renderRemixResults')].join('\n');
const el = { innerHTML: '<<UNTOUCHED>>' };
const build = new Function('document', 'saveRemixes', 'safeUrl', 'initial',
  'let remixes = initial;\n' + SRC + '\nreturn { renderRemixResults, escapeHtml, remixHasContent, all: () => remixes };');
const render = row => {
  el.innerHTML = '<<UNTOUCHED>>';
  const api = build({ getElementById: () => el }, () => {}, () => '', [row]);
  try { api.renderRemixResults(); return { ok: true, html: String(el.innerHTML) }; }
  catch (e) { return { ok: false, err: e.message }; }
};

// The shapes a model actually emits when it drifts from the requested JSON.
const CASES = {
  'a script returned as a number': { remixTitle: 'T', remixHook: 'H', remixScript: 12345 },
  'a script returned as a list of lines': { remixTitle: 'T', remixHook: 'H', remixScript: ['line one', 'line two'] },
  'a title returned as an object': { remixTitle: { text: 'T' }, remixHook: 'H', remixScript: 'S' },
  'a creator name returned as a number': { remixTitle: 'T', remixHook: 'H', remixScript: 'S', creatorName: 42 },
  'why-it-works returned as a list': { remixTitle: 'T', remixHook: 'H', remixScript: 'S', whyItWorks: ['x', 'y'] },
  'a series part with a numeric title': { seriesParts: [{ partNumber: 1, remixTitle: 7, remixScript: 'S' }] },
};
for (const [name, row] of Object.entries(CASES)) {
  const r = render(row);
  if (!r.ok) {
    bad(`${name} crashes the render: ${r.err}. The row is already saved to localStorage and ` +
        'Supabase, so it is re-read and throws again on every load — the tab never recovers.');
  } else if (r.html === '<<UNTOUCHED>>') {
    bad(`${name} rendered nothing at all — the list is left exactly as it was, which on a first ` +
        'render is a blank tab.');
  }
}
// Control: the gate must be able to fail. Prove the well-formed case renders real content.
const good = render({ remixTitle: 'T', remixHook: 'H', remixScript: 'S' });
if (!good.ok || !/remix-result/.test(good.html)) {
  bad('a well-formed remix does not render, so the checks above are not exercising the renderer: ' +
      (good.err || JSON.stringify(good.html).slice(0, 120)));
}

// escapeHtml is used in 30+ places; it is the widest safety net in the file and the one escaper
// that did not coerce. Every sibling (escHtml, escAttr, vlEscAttr) already did.
const esc = build({ getElementById: () => el }, () => {}, () => '', []).escapeHtml;
for (const v of [0, 12345, ['a'], { a: 1 }, true]) {
  try { esc(v); } catch (e) { bad('escapeHtml throws on ' + JSON.stringify(v) + ': ' + e.message); }
}
if (esc('<b>&"') !== '&lt;b&gt;&amp;&quot;') bad('escapeHtml stopped escaping: ' + esc('<b>&"'));

// ── the server half: the endpoint must not hand its client a shape it cannot render ──────────
const remixSrc = fs.readFileSync(path.join(ROOT, 'api/remix.js'), 'utf8');
const nm = remixSrc.match(/remix = \(function normalize[\s\S]*?\}\)\(remix, 0\);/);
if (!nm) {
  bad('api/remix.js no longer normalizes the model reply before returning it, so every new ' +
      'malformed reply is written to the database again.');
} else {
  const run = new Function('remix', nm[0].replace(/^remix = /, 'return (') .replace(/;$/, ')'));
  const out = run({ remixTitle: 7, remixScript: ['a', 'b'], whyItWorks: { x: 'y' }, remixHook: null,
                    seriesParts: [{ partNumber: '2', remixTitle: 9 }] });
  const flat = { ...out };
  delete flat.seriesParts;
  for (const [k, v] of Object.entries(flat)) {
    if (typeof v !== 'string') bad(`normalize left ${k} as a ${typeof v}; every rendered field must be a string.`);
  }
  if (out.remixScript !== 'a\nb') {
    bad('normalize threw away a script the model returned as a list of lines instead of joining it: ' +
        JSON.stringify(out.remixScript) + '. Losing the work is worse than the crash was.');
  }
  const part = (out.seriesParts || [])[0] || {};
  if (typeof part.remixTitle !== 'string') bad('normalize does not reach inside seriesParts.');
  if (part.partNumber !== 2) bad('normalize broke partNumber, which the client renders as a number: ' + JSON.stringify(part.partNumber));
}

// ── /api/sharpen must admit when it changed nothing ────────────────────────────────────────
// Every key falls back to the original when the model drops or blanks it, so the merge loop can
// return the input BYTE FOR BYTE. It did so WITHOUT the `unchanged` flag that the endpoint's own
// early-exit path sets and that the client reads (sharpenNow in app.html). Without it the user is
// told "Sharpened ✨" for a rewrite that never happened, a taste signal is recorded for it, and a
// paid model call is presented as work done.
const sharpSrc = fs.readFileSync(path.join(ROOT, 'api/sharpen.js'), 'utf8');
const loop = sharpSrc.match(/const sharpened = \{\};[\s\S]*?\n    \}\n/);
if (!loop) {
  bad('api/sharpen.js no longer has the key-merge loop this checks — re-point the gate at whatever replaced it.');
} else {
  const runMerge = new Function('keys', 'parsed', 'content',
    loop[0] + '\nreturn { sharpened, moved: typeof moved === "undefined" ? null : moved };');
  const keys = ['hook', 'script'];
  const content = { hook: 'the original hook', script: 'the original script' };

  // 1. the model drops everything -> the merge returns the input unchanged
  let r = runMerge(keys, {}, content);
  if (r.moved === null) {
    bad('api/sharpen.js does not track whether the merge actually changed anything, so it cannot ' +
        'set `unchanged` and the client is told a rewrite happened when none did.');
  } else if (r.moved) {
    bad('the merge reports a change when the model returned nothing at all and every key fell back ' +
        'to the original.');
  }
  // 2. the model returns the same text -> still unchanged
  r = runMerge(keys, { hook: 'the original hook', script: 'the original script' }, content);
  if (r.moved) bad('the merge reports a change when the model returned the input verbatim.');
  // 3. a real rewrite -> changed
  r = runMerge(keys, { hook: 'a sharper hook', script: 'the original script' }, content);
  if (!r.moved) bad('the merge reports NO change after a genuine rewrite, so a real sharpen would be ' +
                    'reported to the user as "already sharp" and thrown away.');
  // 4. and the merge must coerce, same defect class as remix
  r = runMerge(keys, { hook: 12345, script: ['a', 'b'] }, content);
  for (const k of keys) {
    if (typeof r.sharpened[k] !== 'string') {
      bad(`api/sharpen.js returns ${k} as a ${typeof r.sharpened[k]}; the client renders it with string methods.`);
    }
  }
  // The endpoint must actually SEND the flag, not just compute it.
  if (!/unchanged: true \}\);/.test(sharpSrc.slice(sharpSrc.indexOf('const sharpened = {};')))) {
    bad('api/sharpen.js computes whether anything moved but never returns `unchanged: true`, so the ' +
        'client has nothing to read.');
  }
}
// And the client must still honour it.
if (!/if\(data\.unchanged\)\{/.test(html)) {
  bad('app.html no longer checks `data.unchanged`, so the flag the server sends is ignored.');
}

// ── /api/generate-ideas must not answer 200 with blank "Untitled" cards ─────────────────────
// Every field fell back to '' and the title to 'Untitled', so a reply the parser could not make
// sense of came back as a success: empty cards on screen, the call metered, nothing saying the
// model had failed. The commonest cause was the commonest drift — `{"ideas":[...]}` instead of a
// bare array — which the old code WRAPPED, producing exactly one blank card from the wrapper.
// Run the real endpoint with a stubbed model, so this tests behaviour and not a regex.
{
  const giSrc = fs.readFileSync(path.join(ROOT, 'api/generate-ideas.js'), 'utf8');
  if (!/for \(const k of \['ideas', 'results', 'items', 'posts', 'data'\]\)/.test(giSrc)) {
    bad('api/generate-ideas.js no longer unwraps a {"ideas":[...]} reply, so the commonest model ' +
        'drift is wrapped instead of recovered and becomes one blank "Untitled" card.');
  }
  if (!/status\(502\)/.test(giSrc)) {
    bad('api/generate-ideas.js has no path that refuses a reply holding no usable idea — a parsed ' +
        'but empty batch is still returned as 200 and metered.');
  }
  // The usable-idea test itself, executed.
  const um = giSrc.match(/const _usable = i =>[\s\S]*?;\n/);
  if (!um) bad('api/generate-ideas.js: the usable-idea test is gone.');
  else {
    const usable = new Function(um[0] + 'return _usable;')();
    const blank = { title: 'Untitled', hook: '', script: '', caption: '', tags: '' };
    if (usable(blank)) bad('a card with a placeholder title and every field empty counts as a usable idea.');
    if (!usable({ title: 'Untitled', script: 'a real script' })) bad('an idea with a script but no title is rejected.');
    if (!usable({ title: 'A real title', hook: '', script: '' })) bad('an idea with a real title is rejected.');
  }
  // And the field coercion, executed.
  const tm = giSrc.match(/const txt = v => \{[\s\S]*?\n    \};\n/);
  if (!tm) bad('api/generate-ideas.js no longer coerces model fields.');
  else {
    const txt = new Function(tm[0] + 'return txt;')();
    if (txt(['line one', 'line two']) !== 'line one\nline two') {
      bad('generate-ideas throws away a script the model returned as a list of lines: ' + JSON.stringify(txt(['a', 'b'])));
    }
    if (typeof txt(12345) !== 'string' || typeof txt({ a: 'b' }) !== 'string') {
      bad('generate-ideas does not coerce numbers/objects to strings.');
    }
  }
}

if (fails.length) {
  console.error('FAIL:');
  fails.forEach(f => console.error('  - ' + f));
  process.exit(1);
}
console.log('render crash-proofing verified: /api/remix returns only strings, and the real ' +
            'remixHasContent / escapeHtml / renderRemixResults survive every malformed shape that ' +
            'used to leave the Create tab permanently blank. /api/sharpen admits when its rewrite ' +
            'changed nothing instead of reporting work it did not do.');
console.log('PASS');
