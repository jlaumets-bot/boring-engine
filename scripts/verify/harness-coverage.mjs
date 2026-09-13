#!/usr/bin/env node
// scripts/verify/harness-coverage.mjs
//
// GATE: the QA simulator (mobile-user.js) really covers today's fixes, and the probes it
// uses to do so are capable of failing.
//
// This does NOT grep for happy-looking strings. Every new probe's `taps` body is EXTRACTED
// from mobile-user.js and EXECUTED — compiled with `new Function` exactly as the harness
// compiles it (plain, NOT async: a top-level `await` there is a SyntaxError that silently
// kills the whole block), then run against stubs, several of which are the REAL shipped
// functions lifted out of app.html. Every behavioural assertion is paired with a MUTATION of
// its subject that must flip the result — a probe that cannot report BROKEN is worthless, and
// that has happened here before.
//
// It also enforces the two rules this harness has been bitten by:
//   • a `taps` TEMPLATE LITERAL eats single backslashes, so every backslash in one must be
//     doubled. A single `\s` either throws (killing the block with no output) or — worse —
//     compiles into a valid-but-wrong regex.
//   • a stub installed in a taps body must have a restore path, or it leaks into every later
//     feature. One unrestored stub once made 29 of 36 features run against a fake empty brain.
//
//   node scripts/verify/harness-coverage.mjs
//
// EXPECT: exits 0 and prints a final line beginning "PASS"

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// HARNESS_SRC / APP_SRC let a deliberately-mutated COPY be checked, so this suite can itself
// be mutation-tested (break a fix in a temp copy → this must go red).
const SRC_PATH = process.env.HARNESS_SRC || path.resolve(HERE, '../../mobile-user.js');
const APP_PATH = process.env.APP_SRC || path.resolve(HERE, '../../app.html');
const src = fs.readFileSync(SRC_PATH, 'utf8');
const app = fs.existsSync(APP_PATH) ? fs.readFileSync(APP_PATH, 'utf8') : '';

const failures = [];
let checks = 0;
function ok(cond, label, detail = '') {
  checks++;
  if (cond) console.log(`  ✓ ${label}`);
  else { console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failures.push(label + (detail ? ' — ' + detail : '')); }
}
function section(t) { console.log(`\n${t}`); }
function threw(fn) { try { fn(); return null; } catch (e) { return e; } }

// ── structural helpers ──────────────────────────────────────────────────────────────────────
// A string-aware brace matcher over a BOUNDED region (a single function / object literal), so
// it never has to reason about the whole 800KB app.html at once.
// REGEX LITERALS MATTER HERE. The first version skipped strings and comments but not regexes,
// so `.replace(/"/g, …)` — which appears in nl2br, escAttr and escHtml — looked like the start
// of a string and swallowed the rest of the file: escHtml "extracted" 39KB and compiled into
// unrelated app code. `/` is a regex only where a value cannot precede it, which the previous
// significant character tells us.
function matchBraceFrom(s, openIdx) {
  let depth = 0, i = openIdx, prev = '';
  const REGEX_OK = '(,=:[!&|?{};+-*%^~<>\n';
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === "'" || c === '"' || c === '`') {          // string literal
      const q = c; i++;
      for (; i < s.length; i++) { if (s[i] === '\\') { i++; continue; } if (s[i] === q) break; }
      prev = q; continue;
    }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i++; continue; }
    if (c === '/' && (prev === '' || REGEX_OK.includes(prev))) {  // regex literal
      i++;
      let inClass = false;
      for (; i < s.length; i++) {
        if (s[i] === '\\') { i++; continue; }
        if (s[i] === '[') inClass = true;
        else if (s[i] === ']') inClass = false;
        else if (s[i] === '/' && !inClass) break;
        else if (s[i] === '\n') break;                  // not a regex after all — bail safely
      }
      prev = '/'; continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
    if (!/\s/.test(c)) prev = c;
  }
  return -1;
}
// One feature object's source, sliced structurally out of ALL_FEATURES.
function featureEntry(id) {
  const at = src.indexOf(`{ id: '${id}'`);
  if (at < 0) return null;
  const close = matchBraceFrom(src, at);
  return close < 0 ? null : src.slice(at, close + 1);
}
// The TEMPLATE-LITERAL half of a feature's `taps` ARRAY (the multi-line probe body).
// MUST be bounded to the taps array: every feature's `test:` is also a backtick template, so
// searching from `taps:` to "the next backtick" silently returned the TEST STRING for every
// feature whose taps are plain double-quoted strings — scanning prose instead of code.
function tapsArraySrc(id) {
  const e = featureEntry(id);
  if (!e) return null;
  const at = e.indexOf('taps:');
  if (at < 0) return null;
  const open = e.indexOf('[', at);
  if (open < 0) return null;
  // bracket-match, string/template-aware
  let depth = 0, i = open;
  for (; i < e.length; i++) {
    const c = e[i];
    if (c === "'" || c === '"' || c === '`') {
      const q = c; i++;
      for (; i < e.length; i++) { if (e[i] === '\\') { i++; continue; } if (e[i] === q) break; }
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return e.slice(open, i + 1); }
  }
  return null;
}
function tapsTemplate(id) {
  const arr = tapsArraySrc(id);
  if (!arr) return null;
  const open = arr.indexOf('`');
  if (open < 0) return null;                       // this feature's taps are quoted strings only
  const close = arr.indexOf('`', open + 1);        // safe: these bodies may contain no escaped backtick
  return close < 0 ? null : arr.slice(open + 1, close);
}
// Every template-literal body that the harness compiles with `new Function` — the taps probes
// plus reload-persistence's postReload, which goes through the same path.
function allTapsTemplates() {
  const listStart = src.indexOf('const ALL_FEATURES = [');
  const listEnd = src.indexOf('\n];', listStart);
  const listSrc = src.slice(listStart, listEnd);
  const ids = [...listSrc.matchAll(/\{ id: '([^']+)'/g)].map(m => m[1]);
  const out = {};
  for (const id of ids) { const t = tapsTemplate(id); if (t) out[id] = t; }
  const pr = (src.match(/postReload: `([\s\S]*?)`,\n/) || [])[1];
  if (pr) out['reload-persistence:postReload'] = pr;
  return out;
}
// A real shipped function's source, lifted out of app.html.
function appFn(name) {
  if (!app) return null;
  const at = app.indexOf(`function ${name}(`);
  if (at < 0) return null;
  const open = app.indexOf('{', at);
  const close = matchBraceFrom(app, open);
  return close < 0 ? null : app.slice(at, close + 1);
}

// What the HARNESS actually compiles is the template AFTER evaluation, not the raw source text.
// Checking the raw text instead is how `\\s` (correct) looks like a broken regex and `\s`
// (broken) looks fine — the whole point of the backslash rule.
const evalTemplate = (raw) => new Function('return `' + raw + '`;')();

const NEW_FEATURES = ['proof-filming-teardown', 'proof-onboarding-honesty', 'proof-escaping'];

// ── 0. the verifier verifies itself ─────────────────────────────────────────────────────────
section('0 · self-check (an audit script needs auditing too)');
{
  ok(matchBraceFrom('{ a { b } c }', 0) === 12, 'matchBraceFrom finds the matching close brace');
  ok(matchBraceFrom('{ a "}" b }', 0) === 10, 'matchBraceFrom ignores braces inside strings');
  ok(featureEntry('quick-post') !== null, 'featureEntry can slice a known feature');
  ok(featureEntry('no-such-feature-xyz') === null, 'featureEntry returns null for a feature that is not there');
  const _t = allTapsTemplates();
  ok(Object.keys(_t).length >= 6, 'found the template-literal probe bodies to scan', Object.keys(_t).join(', '));
  // the extractor must return CODE, not the neighbouring `test:` prose — that bug made this
  // whole section scan English sentences and pass vacuously
  ok(!('ideas' in _t) && !('guardrail' in _t), 'features whose taps are quoted strings are NOT mistaken for templates',
    Object.keys(_t).join(', '));
  for (const id of ['proof-actions', 'proof-data', 'proof-taptargets', ...NEW_FEATURES])
    ok(id in _t && /window\._qaProof/.test(_t[id]), `"${id}" yields real probe CODE, not its test prose`);
  ok(app.length > 100000, 'app.html is present, so the probes can be checked against real shipped code', `${app.length} bytes`);
}

// ── 1. the new features exist, are wired, and are cost-disciplined ──────────────────────────
section('1 · the three new coverage features exist and are budgeted');
{
  for (const id of NEW_FEATURES) {
    const e = featureEntry(id);
    ok(!!e, `feature "${id}" is declared in ALL_FEATURES`);
    if (!e) continue;
    ok(/budget: 3\b/.test(e), `"${id}" caps its driver turns at 3 (it needs none — the driver only transcribes facts.PROOF)`);
    ok(/facts\.PROOF/.test(e), `"${id}" tells the driver to read facts.PROOF, not to judge by eye`);
    ok(/window\._qaProof/.test(e), `"${id}" publishes its results into window._qaProof`);
    ok(/__ran: 'started'/.test(e), `"${id}" publishes __ran immediately, so a mid-block throw is still evidence`);
    ok(/status=pass only if/i.test(e), `"${id}" gives the driver an explicit pass condition`);
  }
  // the run order must not put them behind the long tail — they are cheap and deterministic
  const listStart = src.indexOf('const ALL_FEATURES = [');
  const ids = [...src.slice(listStart, src.indexOf('\n];', listStart)).matchAll(/\{ id: '([^']+)'/g)].map(m => m[1]);
  for (const id of NEW_FEATURES) ok(ids.indexOf(id) < ids.indexOf('pipeline'), `"${id}" runs before the long tail`);
  ok(new Set(ids).size === ids.length, 'no duplicate feature ids');
}

// ── 2. THE SILENT KILLER: a single backslash inside a taps template ─────────────────────────
section('2 · no taps TEMPLATE contains a single-backslash escape (it is eaten at evaluation)');
{
  const templates = allTapsTemplates();
  const offenders = [];
  for (const [id, body] of Object.entries(templates)) {
    // Runs of consecutive backslashes must be EVEN. `\\s` survives evaluation as `\s`; a lone
    // `\s` is eaten, leaving either a SyntaxError or a valid-but-wrong regex.
    for (const m of body.matchAll(/\\+/g)) {
      if (m[0].length % 2 === 1) {
        const ctx = body.slice(Math.max(0, m.index - 40), m.index + 20).replace(/\n/g, ' ');
        offenders.push(`${id}: odd backslash run (${m[0].length}) near "…${ctx}…"`);
      }
    }
    ok(!body.includes('${'), `"${id}" taps template has no \${…} interpolation (it would be evaluated, not passed through)`);
  }
  ok(offenders.length === 0, 'every backslash in every taps template is doubled', offenders.join(' | '));

  // NEGATIVE CONTROL — the scanner must actually catch the shape it exists to catch.
  const scan = (body) => [...body.matchAll(/\\+/g)].filter(m => m[0].length % 2 === 1).length;
  ok(scan('x.split(/\\\\s+/)') === 0, 'control: a correctly DOUBLED \\\\s passes the scanner');
  ok(scan('x.split(/\\s+/)') === 1, 'control: a single \\s is CAUGHT by the scanner');
  ok(scan('m.match(/a\\d+/)') === 1, 'control: a single \\d is CAUGHT by the scanner');

  // and prove WHY it matters, by evaluating a template the way the harness does
  const evalTemplate = (raw) => new Function('return `' + raw + '`;')();
  ok(evalTemplate('/\\\\s+/') === '/\\s+/', 'a doubled backslash survives template evaluation as a real regex escape');
  ok(evalTemplate('/\\s+/') === '/s+/', 'a single backslash is EATEN — the regex silently becomes /s+/');
  ok(threw(() => new Function(evalTemplate('/pipeAdvance\\(/'))) !== null || evalTemplate('/pipeAdvance\\(/') === '/pipeAdvance(/',
    'a single-escaped paren evaluates to an unbalanced regex — the exact shape that killed a whole probe block');
}

// ── 3. every taps body COMPILES the way the harness compiles it ─────────────────────────────
section('3 · every taps body compiles with new Function (plain, not async)');
{
  const templates = allTapsTemplates();
  for (const [id, raw] of Object.entries(templates)) {
    // compile what the HARNESS compiles: the template AFTER evaluation
    const err = threw(() => new Function(evalTemplate(raw)));
    ok(err === null, `"${id}" taps body compiles (as evaluated, the way the harness compiles it)`, err && err.message);
  }
  // The three new probes are deliberately backslash-free, so raw source and evaluated template
  // are byte-identical — which is what makes executing the raw text in sections 5-7 faithful.
  for (const id of NEW_FEATURES)
    ok(templates[id] === evalTemplate(templates[id]),
      `"${id}" contains no escapes at all, so what is executed below IS what the harness runs`);
  // The harness runs taps in a PLAIN function — a top-level await is a SyntaxError there.
  for (const [id, body] of Object.entries(templates)) {
    const looksTopLevelAwait = /^\s*(?:var|let|const)?\s*[\w.]*\s*=?\s*await\s/m.test(
      body.replace(/async function[\s\S]*?\n\s*\}\)?\(\);?/g, '').replace(/\(async function\(\)\{[\s\S]*?\}\)\(\);/g, ''));
    ok(!looksTopLevelAwait, `"${id}" has no top-level await (it would silently kill the whole block)`);
  }
  ok(/await page\.evaluate\(new Function\(sub\)\)/.test(src), 'the harness really does compile taps with a plain new Function');
}

// ── 4. no stub is installed without a restore path ──────────────────────────────────────────
section('4 · every _qa* marker a taps body sets is cleaned up at the next feature start');
{
  const clm = (src.match(/const clearLeftoverModals = async \(\) => \{ await page\.evaluate\(`([\s\S]*?)`\)\.catch/) || [])[1];
  ok(!!clm, 'found the clearLeftoverModals template');
  const err = threw(() => new Function(clm || ''));
  ok(err === null, 'clearLeftoverModals still compiles after the new restore lines', err && err.message);

  const templates = allTapsTemplates();
  // markers a taps body WRITES (assignment or delete), across template and quoted taps alike
  const written = new Set();
  const listStart = src.indexOf('const ALL_FEATURES = [');
  const listSrc = src.slice(listStart, src.indexOf('\n];', listStart));
  for (const m of listSrc.matchAll(/window\.(_{1,2}qa[A-Za-z0-9_]*)\s*=/g)) written.add(m[1]);
  ok(written.size >= 6, 'found the markers taps bodies install', [...written].join(', '));
  const unrestored = [...written].filter(k => !(clm || '').includes(k));
  ok(unrestored.length === 0, 'every marker installed by a taps body is restored/cleared in clearLeftoverModals',
    unrestored.length ? 'UNRESTORED: ' + unrestored.join(', ') : '');

  // the two that overwrite REAL app functions/state must restore the ORIGINAL, not just delete a flag
  ok(/window\.brandBrainBare\s*=\s*window\._qaOrigBare/.test(clm || ''), 'brandBrainBare is restored from its saved original');
  ok(/tpBlur\.stop\s*=\s*window\._qaOrigBlurStop/.test(clm || ''), 'tpBlur.stop is restored from its saved original');
  ok(/_qaObSnap/.test(clm || ''), 'the onboarding wizard snapshot is restored');
  ok(/qaXssHost/.test(clm || '') && /qaXssCtrl/.test(clm || ''), 'the escaping probe containers are swept off the page');

  // NEGATIVE CONTROL — the rule must actually be able to catch an unrestored stub.
  const fakeCLM = (clm || '').split('_qaOrigBlurStop').join('_qaSomethingElse');
  const wouldCatch = [...written].filter(k => !fakeCLM.includes(k));
  ok(wouldCatch.includes('_qaOrigBlurStop'),
    'control: removing the tpBlur.stop restore IS detected by this rule', wouldCatch.join(','));

  // and clearLeftoverModals must run at the START of every feature, before its taps
  const clearAt = src.indexOf('await clearLeftoverModals(); await killOverlays();');
  const tapsAt = src.indexOf('for (const sub of f.taps) {');
  ok(clearAt > 0 && tapsAt > clearAt, 'clearLeftoverModals runs before each feature runs its taps', `clear@${clearAt} taps@${tapsAt}`);
}

// ── 5. the filming-teardown probe EXECUTES, and can report BROKEN ───────────────────────────
section('5 · proof-filming-teardown runs against the REAL tpEndTake (EXECUTED, both outcomes)');
{
  const body = tapsTemplate('proof-filming-teardown');
  ok(!!body, 'extracted the probe body');
  const realEndTake = appFn('tpEndTake');
  const realReview = appFn('tpReview');
  ok(!!realEndTake, 'lifted the REAL tpEndTake out of app.html');
  ok(!!realReview, 'lifted the REAL tpReview out of app.html');

  // A faithful-enough browser: real MediaStreamTrack semantics (live → ended on stop()).
  function makeEnv() {
    const mkTrack = () => ({ readyState: 'live', stop() { this.readyState = 'ended'; } });
    const mkStream = () => { const t = mkTrack(); return { _t: t, getVideoTracks: () => [t], getTracks: () => [t] }; };
    const mkEl = () => {
      const cls = new Set();
      return { srcObject: null, classList: { add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c) } };
    };
    const feed = mkEl(), overlay = mkEl();
    const document = {
      _feed: feed, _overlay: overlay,
      getElementById: id => (id === 'tpCameraFeed' ? feed : id === 'teleprompterOverlay' ? overlay : null),
      createElement: () => ({ width: 0, height: 0, captureStream: () => mkStream() }),
    };
    return { document, feed, overlay, window: {} };
  }
  function runProbe(bodySrc, { endTake, review, blurStop }) {
    const env = makeEnv();
    let stopCount = 0;
    const tpBlur = { stop: blurStop === null ? undefined : function () { stopCount++; if (blurStop) blurStop(); } };
    const prelude = `
      let tpCameraStream = null;
      const document = deps.document, window = deps.window;
      const tpBlur = deps.tpBlur;
      ${endTake}
      ${review}
    `;
    const fn = new Function('deps', `${prelude}\n${bodySrc}\nreturn { proof: window._qaProof, cam: tpCameraStream, blurStop: tpBlur.stop };`);
    const r = fn({ document: env.document, window: env.window, tpBlur });
    return { ...r, env, stopCount: () => stopCount, tpBlur };
  }

  if (body && realEndTake && realReview) {
    // (a) the real, fixed code
    const good = runProbe(body, { endTake: realEndTake, review: realReview });
    const P = good.proof || {};
    ok(P.__ran === 'started', 'the probe publishes __ran immediately');
    for (const k of ['tpEndTake', 'keepEndsTake', 'retakeKeepsCamera', 'tracksReleased', 'cameraHandleCleared',
                     'blurPumpStopped', 'feedDetached', 'camOnCleared', 'controlUntouchedStreamStaysLive', 'restored'])
      ok(k in P, `it produced the key "${k}"`, JSON.stringify(Object.keys(P)));
    ok(/^WORKS/.test(P.tracksReleased || ''), 'against the REAL tpEndTake it reports the track released', P.tracksReleased);
    ok(/^WORKS/.test(P.keepEndsTake || ''), 'it confirms Keep-it ends the take', P.keepEndsTake);
    ok(/^WORKS/.test(P.retakeKeepsCamera || ''), 'it confirms Retake does NOT end the take (the camera must survive a retake)', P.retakeKeepsCamera);
    ok(/^WORKS/.test(P.cameraHandleCleared || ''), 'it confirms tpCameraStream is nulled', P.cameraHandleCleared);
    ok(/^WORKS/.test(P.blurPumpStopped || ''), 'it confirms the blur pump is stopped exactly once', P.blurPumpStopped);
    ok(/^ok /.test(P.controlUntouchedStreamStaysLive || ''), 'its own negative control passes, so the release check CAN fail', P.controlUntouchedStreamStaysLive);
    ok(!Object.values(P).some(v => typeof v === 'string' && v.startsWith('ERROR')), 'nothing threw', JSON.stringify(P));
    // it must leave the app exactly as it found it
    ok(good.cam === null, 'it puts tpCameraStream back');
    ok(good.blurStop === good.tpBlur.stop, 'it unwraps tpBlur.stop');
    ok(good.env.overlay.classList.contains('cam-on') === false, 'it leaves no cam-on class behind');
    ok(!('_qaOrigBlurStop' in good.env.window), 'it deletes its own restore marker on the happy path');

    // (b) MUTATION OF THE SUBJECT — the pre-v613 world, where nothing ended the take.
    const brokenEndTake = 'function tpEndTake(){ /* v612: nothing ended the take */ }';
    const bad = runProbe(body, { endTake: brokenEndTake, review: realReview });
    const B = bad.proof || {};
    ok(/^BROKEN/.test(B.tracksReleased || ''), 'MUTATION: with a no-op tpEndTake it reports BROKEN', B.tracksReleased);
    ok(/^BROKEN/.test(B.cameraHandleCleared || ''), 'MUTATION: it notices the camera handle is still held', B.cameraHandleCleared);
    ok(/^BROKEN/.test(B.blurPumpStopped || ''), 'MUTATION: it notices the blur pump never stopped', B.blurPumpStopped);

    // (c) MUTATION OF THE WIRING — Keep-it that forgets to end the take, Retake that ends it.
    const reviewNoKeep = realReview.split('tpEndTake();   //').join('/* removed */ //');
    ok(reviewNoKeep !== realReview, 'mutation reproduced: the tpEndTake() call is removed from the Keep handler');
    const w = runProbe(body, { endTake: realEndTake, review: reviewNoKeep }).proof || {};
    ok(/^BROKEN/.test(w.keepEndsTake || ''), 'MUTATION: a Keep handler that does not end the take is reported BROKEN', w.keepEndsTake);
    const reviewRetakeEnds = realReview.replace("document.getElementById('tpRvAgain').onclick = () => {",
      "document.getElementById('tpRvAgain').onclick = () => {\n    tpEndTake();");
    ok(reviewRetakeEnds !== realReview, 'mutation reproduced: Retake now ends the take too');
    const w2 = runProbe(body, { endTake: realEndTake, review: reviewRetakeEnds }).proof || {};
    ok(/^BROKEN/.test(w2.retakeKeepsCamera || ''), 'MUTATION: a Retake that kills the camera is reported BROKEN', w2.retakeKeepsCamera);

    // (d) THE HONESTY GUARD. If the probe stream cannot be installed into the app's own binding,
    // tpEndTake would be tearing down nothing and a "BROKEN" verdict would be a lie. Simulated
    // with a real read-only global accessor — assignment silently does nothing, exactly the
    // failure mode being guarded. It must say "CANNOT TEST", never accuse the app.
    ok(/break runtime;/.test(body), 'the guard exits with a labelled break, not a bare return (which would also skip the code after it)');
    ok(/CANNOT TEST/.test(body), 'the probe has an explicit "could not test this" outcome');
    const HAD = Object.getOwnPropertyDescriptor(globalThis, 'tpCameraStream');
    try {
      Object.defineProperty(globalThis, 'tpCameraStream', { configurable: true, get: () => null, set: () => {} });
      const env2 = makeEnv();
      const tpBlur2 = { stop() {} };
      // NOTE: no `let tpCameraStream` in this prelude — the body's assignment therefore hits the
      // sloppy-mode global, which we have made unwritable.
      const fn = new Function('deps',
        `const document = deps.document, window = deps.window; const tpBlur = deps.tpBlur;\n${realEndTake}\n${realReview}\n${body}\nreturn window._qaProof;`);
      const G = fn({ document: env2.document, window: env2.window, tpBlur: tpBlur2 }) || {};
      ok(/^CANNOT TEST/.test(G.tracksReleased || ''),
        'HONESTY: an uninstallable probe stream reports "CANNOT TEST", not a false BROKEN', G.tracksReleased);
      ok(!('cameraHandleCleared' in G), 'and it stops there rather than emitting downstream verdicts it cannot justify',
        JSON.stringify(Object.keys(G)));
      ok(/^WORKS/.test(G.keepEndsTake || ''), 'the wiring half, which does not need the stream, still reports normally', G.keepEndsTake);
    } finally {
      if (HAD) Object.defineProperty(globalThis, 'tpCameraStream', HAD); else delete globalThis.tpCameraStream;
    }
  }
}

// ── 6. the onboarding-honesty probe EXECUTES, and can report BROKEN ─────────────────────────
section('6 · proof-onboarding-honesty drives the REAL step-2 gate (EXECUTED, both outcomes)');
{
  const body = tapsTemplate('proof-onboarding-honesty');
  ok(!!body, 'extracted the probe body');
  const realNext = appFn('obNext');
  const realMin = appFn('isBrandMinimumMet');
  ok(!!realNext, 'lifted the REAL obNext out of app.html');
  ok(!!realMin, 'lifted the REAL isBrandMinimumMet out of app.html');

  function runOb(bodySrc, gateSrc) {
    const vals = { obBrandName: '', obAudience: '', obUsps: '', obTagline: '', obStep2Err: '' };
    const cls = new Set(['hidden']);
    const els = {};
    const mk = id => (els[id] = els[id] || {
      id, get value() { return vals[id] || ''; }, set value(v) { vals[id] = v; },
      textContent: '', style: {}, focus() {}, scrollIntoView() {}, innerHTML: '',
      classList: { add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c) },
    });
    ['obBrandName', 'obAudience', 'obUsps', 'obTagline', 'obStep2Err', 'obProgress', 'obSummary',
     'obToneGrid', 'obCommunityInput', 'onboardingOverlay', 'tvShzCap'].forEach(mk);
    els.tvShzCap.textContent = 'Today’s post, one tap';
    const document = {
      getElementById: id => els[id] || null,
      querySelectorAll: () => [],
      querySelector: () => null,
    };
    const prelude = `
      const document = deps.document, window = deps.window;
      let obSelectedTones = [], obCommunities = [], obCurrentStep = 1;
      const settings = deps.settings;
      function obClearErr(id){ var e = document.getElementById(id); if (e) e.textContent = ''; }
      function obShowErr(id, msg){ var e = document.getElementById(id); if (e) e.textContent = msg; }
      function obGoToStep(s){ obCurrentStep = s; }
      function obBuildSummary(){}
      function brandBrainBare(){ return false; }
      ${gateSrc}
      ${realMin}
    `;
    const fn = new Function('deps', `${prelude}\n${bodySrc}\nreturn { proof: window._qaProof, tones: obSelectedTones, comms: obCommunities, step: obCurrentStep, vals: deps.vals, hidden: deps.cls.has('hidden') };`);
    // the live brand this probe reads (not mutated) — a fully set-up brand
    const settings = { brandName: 'Boring', tones: ['deadpan', 'witty'], communities: ['a', 'b'], targetAudience: 'founders' };
    return fn({ document, window: {}, settings, vals, cls });
  }

  if (body && realNext && realMin) {
    // (a) the real, fixed gate
    const good = runOb(body, realNext);
    const P = good.proof || {};
    for (const k of ['gateAcceptsTheMinimum', 'gateDemandsBrandName', 'gateDemandsTwoTones', 'gateDemandsAudience',
                     'gateDemandsTwoTopics', 'gateDemandsUsps', 'liveCaptionMatchesLock', 'restored'])
      ok(k in P, `it produced the key "${k}"`, JSON.stringify(Object.keys(P)));
    ok(/^WORKS/.test(P.gateAcceptsTheMinimum || ''), 'POSITIVE CONTROL: the complete minimum is accepted, so the gate is reachable', P.gateAcceptsTheMinimum);
    for (const k of ['gateDemandsBrandName', 'gateDemandsTwoTones', 'gateDemandsAudience', 'gateDemandsTwoTopics', 'gateDemandsUsps'])
      ok(/^WORKS/.test(P[k] || ''), `against the REAL gate, ${k} reports WORKS`, P[k]);
    ok(/^WORKS/.test(P.liveCaptionMatchesLock || ''), 'the live caption/lock consistency check agrees on a set-up brand', P.liveCaptionMatchesLock);
    ok(!Object.values(P).some(v => typeof v === 'string' && v.startsWith('ERROR')), 'nothing threw', JSON.stringify(P));
    // it must leave the wizard as it found it
    ok(good.vals.obBrandName === '' && good.vals.obAudience === '' && good.vals.obUsps === '', 'it restores the wizard field values', JSON.stringify(good.vals));
    ok(good.tones.length === 0 && good.comms.length === 0, 'it restores the tone/topic arrays');
    ok(good.step === 1, 'it puts the wizard back on its original step', String(good.step));
    ok(good.hidden === true, 'it leaves the onboarding overlay hidden');

    // (b) MUTATION OF THE SUBJECT — the pre-v613 gate that only required a brand name.
    const oldGate = `function obNext(fromStep){ if (fromStep === 2) { if (!document.getElementById('obBrandName').value.trim()) { obShowErr('obStep2Err','need a name','obBrandName'); return; } } obGoToStep(fromStep + 1); }`;
    const bad = runOb(body, oldGate).proof || {};
    ok(/^WORKS/.test(bad.gateAcceptsTheMinimum || ''), 'MUTATION: the old gate still accepts a complete brand (so the checks below are meaningful)', bad.gateAcceptsTheMinimum);
    ok(/^WORKS/.test(bad.gateDemandsBrandName || ''), 'MUTATION: the old gate did at least demand a brand name');
    for (const k of ['gateDemandsTwoTones', 'gateDemandsAudience', 'gateDemandsTwoTopics', 'gateDemandsUsps'])
      ok(/^BROKEN/.test(bad[k] || ''), `MUTATION: the OLD wizard is caught — ${k} reports BROKEN`, bad[k]);

    // (c) the live contradiction check must fire when caption and lock disagree
    const contra = new Function('deps', `
      const document = deps.document, window = deps.window;
      let obSelectedTones = [], obCommunities = [], obCurrentStep = 1;
      const settings = { brandName: '', tones: [], communities: [], targetAudience: '' };
      function obClearErr(){} function obShowErr(){} function obGoToStep(s){ obCurrentStep = s; }
      function obBuildSummary(){} function brandBrainBare(){ return true; }
      ${realNext}
      ${realMin}
      ${body}
      return window._qaProof;`);
    const els2 = {};
    const mk2 = id => (els2[id] = { id, value: '', textContent: '', style: {}, focus() {}, scrollIntoView() {}, innerHTML: '', classList: { add() {}, remove() {}, contains: () => true } });
    ['obBrandName', 'obAudience', 'obUsps', 'obStep2Err', 'obProgress', 'obSummary', 'onboardingOverlay', 'tvShzCap'].forEach(mk2);
    els2.tvShzCap.textContent = 'Today’s post, one tap';   // says READY…
    const C = contra({ document: { getElementById: id => els2[id] || null, querySelectorAll: () => [], querySelector: () => null }, window: {} });
    ok(/^BROKEN/.test(C.liveCaptionMatchesLock || ''),
      'CONTRADICTION CASE: a "ready" caption on a brand that is NOT minimum-met is reported BROKEN', C.liveCaptionMatchesLock);

    // (d) THE HONESTY GUARD — if the synthetic wizard values cannot be installed, "the gate
    // rejected it" would be true for the wrong reason, so the probe must say so instead.
    ok(/installFailed/.test(body), 'the probe reads its synthetic values back before trusting a rejection');
    const stuck = runOb(body, realNext.replace('function obNext(fromStep) {',
      'function obNext(fromStep) { /* gate untouched */'));
    ok(/^WORKS/.test((stuck.proof || {}).gateAcceptsTheMinimum || ''), 'control: the guard does not fire when installation works',
      (stuck.proof || {}).gateAcceptsTheMinimum);
    const frozen = new Function('deps', `
      const document = deps.document, window = deps.window;
      let obSelectedTones = [], obCommunities = [], obCurrentStep = 1;
      const settings = { brandName: 'x', tones: ['a','b'], communities: ['a','b'], targetAudience: 'y' };
      function obClearErr(){} function obShowErr(){} function obGoToStep(s){ obCurrentStep = s; }
      function obBuildSummary(){} function brandBrainBare(){ return false; }
      ${realNext}
      ${realMin}
      ${body}
      return window._qaProof;`);
    const frozenEls = {};
    // a wizard whose inputs refuse to take a value — assignment silently does nothing
    ['obBrandName', 'obAudience', 'obUsps', 'obStep2Err', 'obProgress', 'obSummary', 'onboardingOverlay', 'tvShzCap']
      .forEach(id => { frozenEls[id] = { id, get value() { return ''; }, set value(v) {}, textContent: '', style: {}, focus() {}, scrollIntoView() {}, innerHTML: '', classList: { add() {}, remove() {}, contains: () => true } }; });
    frozenEls.tvShzCap.textContent = 'Today’s post, one tap';
    const F = frozen({ document: { getElementById: id => frozenEls[id] || null, querySelectorAll: () => [], querySelector: () => null }, window: {} });
    ok(/^CANNOT TEST/.test(F.gateAcceptsTheMinimum || ''),
      'HONESTY: values that will not install report "CANNOT TEST", not a false BROKEN', F.gateAcceptsTheMinimum);
  }
}

// ── 7. the escaping probe EXECUTES against the REAL helpers, and can report BROKEN ──────────
section('7 · proof-escaping runs the REAL nl2br / safeUrl / escJs / escAttr (EXECUTED, both outcomes)');
{
  const body = tapsTemplate('proof-escaping');
  ok(!!body, 'extracted the probe body');
  const helpers = ['nl2br', 'escHtml', 'escJs', 'escAttr', 'safeUrl'].map(n => [n, appFn(n)]);
  for (const [n, s] of helpers) ok(!!s, `lifted the REAL ${n} out of app.html`);

  function runEsc(bodySrc, { nl2brSrc, notes }) {
    // A DOM stub where "did a live element appear?" is modelled the way a browser decides it:
    // literal `<img` markup makes an element, `&lt;img` does not.
    const timers = [];
    const mkEl = () => {
      let html = '';
      const el = {
        style: {}, id: '',
        set innerHTML(v) { html = String(v); }, get innerHTML() { return html; },
        get textContent() { return html.split('&lt;').join('<').split('&gt;').join('>').split('&amp;').join('&').split('<br>').join('\n').replace(/<[^>]*>/g, ''); },
        querySelector: sel => (new RegExp('<' + sel + '\\b', 'i').test(html) ? { tag: sel } : null),
        remove() { el._removed = true; },
        appendChild() {},
      };
      return el;
    };
    const byId = {};
    const document = {
      body: { appendChild(el) { if (el.id) byId[el.id] = el; } },
      createElement: () => mkEl(),
      getElementById: id => byId[id] || null,
    };
    byId.nbInput = { value: '' };
    byId.nbList = mkEl();
    const prelude = `
      const document = deps.document, window = deps.window;
      const setTimeout = deps.setTimeout;
      let notebookNotes = deps.notes;
      ${nl2brSrc}
      ${appFn('escHtml')}
      ${appFn('escJs')}
      ${appFn('escAttr')}
      ${appFn('safeUrl')}
      let _nb = 0;
      function nbSaveNote(){ const v = document.getElementById('nbInput').value; if (!v) return;
        notebookNotes.unshift({ id: 'probe-' + (++_nb), text: v }); document.getElementById('nbInput').value = ''; }
      function nbDelete(id){ notebookNotes = notebookNotes.filter(n => n.id !== id); }
      function renderNotebook(){ document.getElementById('nbList').innerHTML =
        notebookNotes.map(n => '<div class="nb-note-text">' + escHtml(n.text) + '</div>').join(''); }
      function saveNotebookToDB(){}
    `;
    const fn = new Function('deps', `${prelude}\n${bodySrc}\nreturn { proof: window._qaProof, notes: notebookNotes, timers: deps.timers };`);
    const r = fn({ document, window: {}, notes, timers, setTimeout: (f, ms) => timers.push(f) });
    timers.forEach(f => f());   // resolve the deferred "did anything execute?" check
    return r;
  }

  const realNl2br = appFn('nl2br');
  if (body && realNl2br && helpers.every(([, s]) => !!s)) {
    // (a) the real, fixed helpers
    const notes = [{ id: 'real-1', text: 'a genuine note' }];
    const good = runEsc(body, { nl2brSrc: realNl2br, notes });
    const P = good.proof || {};
    for (const k of ['nl2brInert', 'nl2brShowsText', 'controlRawSinkIsLive', 'nl2brNoDoubleEscape',
                     'notebookXss', 'probeCleanedUp', 'safeUrlBlocks', 'safeUrlKeepsReal',
                     'escJsClosesAttr', 'escAttrQuotes', 'noScriptExecuted'])
      ok(k in P, `it produced the key "${k}"`, JSON.stringify(Object.keys(P)));
    for (const k of ['nl2brInert', 'nl2brNoDoubleEscape', 'notebookXss', 'probeCleanedUp',
                     'safeUrlBlocks', 'safeUrlKeepsReal', 'escJsClosesAttr', 'escAttrQuotes'])
      ok(/^WORKS/.test(P[k] || ''), `against the REAL helpers, ${k} reports WORKS`, P[k]);
    ok(/^ok /.test(P.controlRawSinkIsLive || ''), 'its negative control passes, so the inert check CAN fail', P.controlRawSinkIsLive);
    ok(!Object.values(P).some(v => typeof v === 'string' && v.startsWith('ERROR')), 'nothing threw', JSON.stringify(P));
    ok(good.notes.length === 1 && good.notes[0].id === 'real-1', "it deletes ONLY its own probe note — the user's real note survives", JSON.stringify(good.notes));

    // (b) MUTATION OF THE SUBJECT — the pre-v614 nl2br that only turned \n into <br>.
    const oldNl2br = `function nl2br(s){ return String(s == null ? '' : s).replace(/\\r\\n?|\\n/g, '<br>'); }`;
    const bad = runEsc(body, { nl2brSrc: oldNl2br, notes: [{ id: 'real-1', text: 'x' }] }).proof || {};
    ok(/^BROKEN/.test(bad.nl2brInert || ''), 'MUTATION: the old non-escaping nl2br is caught — nl2brInert reports BROKEN', bad.nl2brInert);
    ok(/^BROKEN/.test(bad.nl2brNoDoubleEscape || ''), 'MUTATION: it also notices the old nl2br never escaped &', bad.nl2brNoDoubleEscape);

    // (c) MUTATION — an OVER-escaping nl2br must fail too (breaking real text is also a bug).
    const overNl2br = `function nl2br(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/\\r\\n?|\\n/g,'<br>'); }`;
    const over = runEsc(body, { nl2brSrc: overNl2br, notes: [{ id: 'real-1', text: 'x' }] }).proof || {};
    ok(/^BROKEN/.test(over.nl2brNoDoubleEscape || ''), 'MUTATION: a double-escaping nl2br is ALSO caught (&amp;amp;)', over.nl2brNoDoubleEscape);
    ok(/^WORKS/.test(over.nl2brInert || ''), '…while still correctly reporting the payload inert (the two directions are independent)', over.nl2brInert);
  }
}

// ── 8. PREFLIGHT: the stale-CDN-edge check ──────────────────────────────────────────────────
section('8 · preflight detects a CDN edge serving a stale service worker (EXECUTED)');
{
  const at = src.indexOf('const readSwBuild = async (u) => {');
  ok(at > 0, 'found the edge-cache check');
  const blockStart = src.indexOf('if (ORIGIN) {', src.indexOf('// ── STALE CDN EDGE'));
  const blockEnd = matchBraceFrom(src, src.indexOf('{', blockStart));
  const block = blockStart > 0 && blockEnd > 0 ? src.slice(blockStart, blockEnd + 1) : '';
  ok(!!block, 'sliced the edge-cache block structurally');
  ok(/cache: 'no-store'/.test(block), 'it fetches with cache:no-store so the harness process cannot cache the answer');
  ok(/\?cb=/.test(block), 'it compares the plain URL against a cache-BUSTED URL — the only way to see an edge cache');
  ok(src.indexOf('// ── STALE CDN EDGE') < src.indexOf('PREFLIGHT.forEach(l => console.log'),
    'the check runs before preflight is printed and acted on');
  ok(/🔴 STALE CDN EDGE/.test(block), 'a disagreement is a RED preflight line (it aborts unless FORCE=1)');
  ok(/PREFLIGHT\.some\(l => l\.startsWith\('🔴'\)\) && !process\.env\.FORCE/.test(src),
    'a red preflight line really does halt the run unless FORCE=1');

  if (block) {
    // EXECUTE the real block against a stubbed fetch, in all four states.
    const run = async (edgeBody, freshBody, localSw) => {
      const PREFLIGHT = [];
      const fs_ = { readFileSync: () => localSw == null ? (() => { throw new Error('no sw'); })() : `const BUILD = '${localSw}';` };
      const fetch_ = async (u) => {
        const body = String(u).includes('?cb=') ? freshBody : edgeBody;
        if (body === null) return { ok: false, status: 500, text: async () => '' };
        return { ok: true, status: 200, text: async () => `const BUILD = '${body}';` };
      };
      const fn = new Function('ORIGIN', 'PREFLIGHT', 'fetch', 'fs', 'path', '__dirname',
        `return (async () => { ${block} })();`);
      await fn('https://x.test', PREFLIGHT, fetch_, fs_, { join: (...a) => a.join('/') }, '/app');
      return PREFLIGHT;
    };
    const green = await run('v615-aaa', 'v615-aaa', 'v615-aaa');
    ok(green.length === 1 && green[0].startsWith('✅'), 'a healthy edge produces a green line', green.join(' | '));

    const stale = await run('v606-old', 'v613-new', 'v613-new');
    ok(stale.length === 1 && stale[0].startsWith('🔴 STALE CDN EDGE'), 'THE v613 CASE: edge v606 vs cache-busted v613 goes RED', stale.join(' | '));
    ok(/v606-old/.test(stale[0]) && /v613-new/.test(stale[0]), 'the red line names BOTH builds, so it is actionable', stale[0]);
    ok(/Purge/i.test(stale[0]), 'and it says what to do about it');

    const behind = await run('v610-x', 'v610-x', 'v615-y');
    ok(behind.length === 1 && behind[0].startsWith('🔴 STALE SERVICE WORKER'), 'an origin that is simply behind local also goes red', behind.join(' | '));

    // a check that cannot run must say "I don't know", never invent a red line
    const dunno = await run(null, 'v615-aaa', 'v615-aaa');
    ok(dunno.length === 1 && dunno[0].startsWith('⚠️'), 'a failed fetch produces a ⚠️, NOT a 🔴', dunno.join(' | '));
    ok(!dunno[0].includes('🔴'), 'an unreachable origin never fabricates a stale-edge accusation');
  }
}

// ── 9. spend metering is measured for free and reported honestly ────────────────────────────
section('9 · the run measures its own credit spend without spending more (EXECUTED)');
{
  ok(/let USAGE_BEFORE = null;/.test(src), 'USAGE_BEFORE is declared');
  ok(/fetch\('\/api\/usage'\)/.test(src), 'it reads the real usage endpoint');
  ok((src.match(/fetch\('\/api\/usage'\)/g) || []).length === 2, 'exactly TWO reads — one before, one after; nothing else is spent',
    `found ${(src.match(/fetch\('\/api\/usage'\)/g) || []).length}`);
  ok(!/id: 'spend/.test(src), 'there is deliberately NO spend feature burning credits to re-prove a server fact');
  ok(/scripts\/verify\/spend-cap\.mjs/.test(src), 'the file points at the offline oracle that DOES own that rule');
  ok(/UNTESTABLE FLOWS/.test(src), 'the file documents what it cannot reach, rather than quietly omitting it');
  ok(/magic-link/i.test(src) && /onboarding/i.test(src), 'the onboarding-signup limitation is named in that list');

  const at = src.indexOf('let spendLine = \'\';');
  ok(at > 0, 'found the spend-delta block');
  const end = src.indexOf('// ── QA report ──', at);
  const block = at > 0 && end > at ? src.slice(at, end) : '';
  if (block) {
    const run = async (before, after, nResults) => {
      const fn = new Function('USAGE_BEFORE', 'page', 'results',
        `return (async () => { ${block} return spendLine; })();`);
      return fn(before, { evaluate: async () => after }, new Array(nResults).fill({}));
    };
    const moved = await run({ used: 100, limit: 750, cost: 1.0, plan: 'pro' }, { used: 112, limit: 750, cost: 1.2, plan: 'pro' }, 20);
    ok(/\+12/.test(moved) && /100 → 112/.test(moved), 'a normal run reports the real delta', moved);
    ok(!moved.includes('🔴'), 'a moving counter is not accused of anything', moved);

    const dead = await run({ used: 100, limit: 750, cost: 1.0, plan: 'pro' }, { used: 100, limit: 750, cost: 1.0, plan: 'pro' }, 20);
    ok(dead.includes('🔴') && /Metering looks DEAD/.test(dead), 'a full run that costs ZERO credits IS flagged', dead);
    ok(/ACTION_CREDITS/.test(dead) && /spend-cap\.mjs/.test(dead), 'the flag names where to look', dead);

    const tiny = await run({ used: 100, limit: 750, cost: 1.0, plan: 'pro' }, { used: 100, limit: 750, cost: 1.0, plan: 'pro' }, 2);
    ok(!tiny.includes('🔴'), 'an ONLY= run of 2 features does NOT accuse metering of being dead', tiny);
    ok(/says nothing either way/.test(tiny), '…and says plainly that it proves nothing', tiny);

    const none = await run(null, null, 20);
    ok(none === '', 'no baseline (login failed) → no line at all, no guessing');
  }
  ok(/if \(spendLine\) md \+= spendLine/.test(src), 'the spend line reaches the report');
}

console.log('');
if (failures.length) {
  console.log(`FAIL — ${failures.length} of ${checks} assertions did not hold:`);
  for (const f of failures) console.log('  • ' + f);
  process.exit(1);
}
console.log(`${checks} assertions held.`);
console.log('PASS — harness coverage verified');
