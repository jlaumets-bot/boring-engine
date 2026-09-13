#!/usr/bin/env node
// scripts/verify/harness-fixes.mjs
//
// Proves the six verified defects in mobile-user.js are actually fixed.
//
// This does NOT just grep for happy-looking strings. Where a defect was a RUNTIME failure
// (a SyntaxError that killed a whole function, a TDZ ReferenceError, a verdict-flipping filter,
// an unreachable branch, an inert .map) the real code is EXTRACTED from mobile-user.js and
// EXECUTED, with a NEGATIVE CONTROL that reproduces the original bug and must still fail —
// so an assertion that could not fail is caught here rather than certified at report time.
//
//   node scripts/verify/harness-fixes.mjs
//
// Prints "harness fixes verification passed" and exits 0 only when every assertion holds.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// HARNESS_SRC lets a deliberately-mutated COPY be checked, so the suite itself can be
// mutation-tested (revert a fix in a temp copy → this must go red).
const SRC_PATH = process.env.HARNESS_SRC || path.resolve(HERE, '../../mobile-user.js');
const src = fs.readFileSync(SRC_PATH, 'utf8');

const failures = [];
let checks = 0;
function ok(cond, label, detail = '') {
  checks++;
  if (cond) { console.log(`  ✓ ${label}`); }
  else { console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failures.push(label + (detail ? ' — ' + detail : '')); }
}
function section(t) { console.log(`\n${t}`); }
function threw(fn) { try { fn(); return null; } catch (e) { return e; } }
const NOOP_CONSOLE = { log() {}, error() {}, warn() {} };

// ── a tiny source blanker so brace-matching is structural, not textual ───────────────────────
// Replaces every comment / string / template / regex literal with spaces of the SAME length, so
// character indices are preserved and { } counting reflects real code structure.
function blankOut(s) {
  const out = s.split('');
  const n = s.length;
  let i = 0, last = '';
  const blank = (k) => { if (s[k] !== '\n') out[k] = ' '; };
  const scanQuoted = (q) => {                     // ' or "
    blank(i); i++;
    while (i < n) {
      if (s[i] === '\\') { blank(i); blank(i + 1); i += 2; continue; }
      if (s[i] === q) { blank(i); i++; return; }
      blank(i); i++;
    }
  };
  const scanTemplate = () => {                    // ` ... ${ nested code } ... `
    blank(i); i++;
    while (i < n) {
      if (s[i] === '\\') { blank(i); blank(i + 1); i += 2; continue; }
      if (s[i] === '`') { blank(i); i++; return; }
      if (s[i] === '$' && s[i + 1] === '{') {
        blank(i); blank(i + 1); i += 2;
        let depth = 1;
        while (i < n && depth > 0) {
          const k = s[i];
          if (k === '`') { scanTemplate(); continue; }
          if (k === "'" || k === '"') { scanQuoted(k); continue; }
          if (k === '{') depth++;
          else if (k === '}') depth--;
          blank(i); i++;
        }
        continue;
      }
      blank(i); i++;
    }
  };
  const scanRegex = () => {
    blank(i); i++;
    let inClass = false;
    while (i < n) {
      if (s[i] === '\\') { blank(i); blank(i + 1); i += 2; continue; }
      if (s[i] === '[') inClass = true;
      else if (s[i] === ']') inClass = false;
      else if (s[i] === '/' && !inClass) { blank(i); i++; while (i < n && /[a-z]/.test(s[i])) { blank(i); i++; } return; }
      blank(i); i++;
    }
  };
  while (i < n) {
    const c = s[i], d = s[i + 1];
    if (c === '/' && d === '/') { while (i < n && s[i] !== '\n') { blank(i); i++; } continue; }
    if (c === '/' && d === '*') { blank(i); blank(i + 1); i += 2; while (i < n && !(s[i] === '*' && s[i + 1] === '/')) { blank(i); i++; } if (i < n) { blank(i); blank(i + 1); i += 2; } continue; }
    if (c === "'" || c === '"') { scanQuoted(c); continue; }
    if (c === '`') { scanTemplate(); continue; }
    if (c === '/' && (last === '' || '(,=:[!&|?{};+-*%^~'.includes(last))) { scanRegex(); last = '/'; continue; }
    if (!/\s/.test(c)) last = c;
    i++;
  }
  return out.join('');
}
function matchBrace(blanked, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < blanked.length; i++) {
    if (blanked[i] === '{') depth++;
    else if (blanked[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

const blanked = blankOut(src);

// ── 0. the verifier verifies itself ─────────────────────────────────────────────────────────
section('0 · self-check (an audit script needs auditing too)');
{
  const opens = (blanked.match(/\{/g) || []).length, closes = (blanked.match(/\}/g) || []).length;
  ok(opens === closes && opens > 100, 'blankOut parsed the file cleanly (braces balance)', `{=${opens} }=${closes}`);
  ok(matchBrace(blankOut('{ a { b } c }'), 0) === 12, 'matchBrace finds the matching close brace');
  ok(blankOut(`x = "a{b{c"; y = 1;`).indexOf('{') === -1, 'blankOut removes braces hidden inside strings');
}

// ── 1. clearLeftoverModals template must PARSE (missing semicolon killed the whole function) ──
section('1 · clearLeftoverModals template is syntactically valid (EXECUTED)');
{
  const m = src.match(/const clearLeftoverModals = async \(\) => \{ await page\.evaluate\(`([\s\S]*?)`\)\.catch/);
  ok(!!m, 'found the clearLeftoverModals page.evaluate template');
  if (m) {
    const body = m[1];
    const err = threw(() => new Function(body));
    ok(err === null, 'the template body compiles with new Function (it did not before)', err && err.message);

    // NEGATIVE CONTROL — put the missing semicolon back; this MUST still fail, otherwise the
    // assertion above is an oracle that cannot fail.
    const broken = body.replace('window._qaKeepTour = false; window._qaKeepNotif', 'window._qaKeepTour = false window._qaKeepNotif');
    ok(broken !== body, 'negative control reproduced the original (semicolon removed)');
    const brokenErr = threw(() => new Function(broken));
    ok(brokenErr instanceof SyntaxError, 'negative control still throws SyntaxError', brokenErr ? brokenErr.message : 'it compiled — the check is worthless');

    // and the effects the dead function was supposed to have are all still in it
    for (const eff of ['_qaOrigBare', 'delete window._qaProof', 'toggleDarkMode(false)', '_qaKeepNotif'])
      ok(body.includes(eff), `template still performs its job: ${eff}`);
  }
  ok(!/= false window\._qaKeepNotif/.test(src), 'no unseparated statements left in the source');
}

// ── 2. version read + PREFLIGHT must not be nested inside the expired-login branch ───────────
section('2 · preflight runs on EVERY run, not only when the login expired');
{
  // predicate: is the LIVE_VERSION read inside the interactive `if (!ready && await isLogin())` body?
  function liveVersionNestedInLogin(source) {
    const b = blankOut(source);
    const at = source.indexOf('if (!ready && await isLogin()) {');
    if (at < 0) return 'ANCHOR-MISSING';
    const open = source.indexOf('{', at);
    const close = matchBrace(b, open);
    if (close < 0) return 'UNBALANCED';
    const live = source.indexOf('LIVE_VERSION = await page.evaluate');
    if (live < 0) return 'LIVE-MISSING';
    return live < close;
  }
  // prove the predicate can tell the two shapes apart before trusting it on the real file
  const NESTED = `if (!ready && await isLogin()) {\n  login();\n  LIVE_VERSION = await page.evaluate(x);\n}\n`;
  const HOISTED = `if (!ready && await isLogin()) {\n  login();\n}\nif (ready) {\n  LIVE_VERSION = await page.evaluate(x);\n}\n`;
  ok(liveVersionNestedInLogin(NESTED) === true, 'predicate detects the ORIGINAL nested shape');
  ok(liveVersionNestedInLogin(HOISTED) === false, 'predicate accepts the hoisted shape');

  ok(liveVersionNestedInLogin(src) === false, 'LIVE_VERSION read is NOT inside the expired-login branch');

  const b = blankOut(src);
  const at = src.indexOf('if (!ready && await isLogin()) {');
  const close = matchBrace(b, src.indexOf('{', at));
  const preflight = src.indexOf('const localApp = fs.readFileSync');
  ok(preflight > close, 'the PREFLIGHT block is NOT inside the expired-login branch either');
  const readyGuard = src.indexOf('if (ready) {', close);
  ok(readyGuard > close && readyGuard < src.indexOf('LIVE_VERSION = await page.evaluate'),
    'the hoisted block is guarded by `if (ready)` so it runs after login settles on either path');
  ok(src.indexOf('PREFLIGHT.push(`🔴 STALE DEPLOY') > close, 'the stale-deploy guard is reachable on a normal run');
}

// ── 3. observational diagnostics must not flip a PASS into a FAIL ────────────────────────────
section('3 · CLICK BLOCKED / NETWORK FAIL no longer turn a pass into a fail (EXECUTED)');
{
  const m = src.match(/const OBSERVATIONAL_KINDS = [\s\S]*?if \(hardErrs\.length && verdict\.status === 'pass'\) verdict\.status = 'fail';/);
  ok(!!m, 'found the verdict-downgrade logic in its fixed form');
  ok(!/if \(errs\.length && verdict\.status === 'pass'\)/.test(src), 'the old unfiltered downgrade line is gone');
  if (m) {
    // run the SHIPPED lines, not a paraphrase of them
    const run = new Function('errs', 'verdict', m[0] + '\nreturn verdict.status;');
    ok(run([{ kind: 'CLICK BLOCKED', detail: 'x' }], { status: 'pass' }) === 'pass', 'CLICK BLOCKED alone keeps a pass');
    ok(run([{ kind: 'NETWORK FAIL', detail: 'x' }], { status: 'pass' }) === 'pass', 'NETWORK FAIL alone keeps a pass');
    ok(run([{ kind: 'CLICK BLOCKED' }, { kind: 'NETWORK FAIL' }], { status: 'pass' }) === 'pass', 'both observational kinds together keep a pass');
    ok(run([], { status: 'pass' }) === 'pass', 'no errors keeps a pass');
    ok(run([{ kind: 'JS error', detail: 'boom' }], { status: 'pass' }) === 'fail', 'a REAL JS error still fails the feature');
    ok(run([{ kind: 'HTTP 500' }], { status: 'pass' }) === 'fail', 'a REAL HTTP 5xx still fails the feature');
    ok(run([{ kind: 'CLICK BLOCKED' }, { kind: 'HTTP 402' }], { status: 'pass' }) === 'fail', 'a real error mixed with an observational one still fails');
    ok(run([{ kind: 'CLICK BLOCKED' }], { status: 'blocked' }) === 'blocked', 'a non-pass verdict is left alone');
  }
  ok(/errors: errs\b/.test(src), 'observational diagnostics are STILL reported in the per-feature error list');
}

// ── 4. DRIVER_DEAD must be reachable and must not deref a null verdict ───────────────────────
section('4 · DRIVER_DEAD detection is reachable and crash-free (EXECUTED)');
{
  // The crash was a SECOND results.push that read verdict.observed while verdict was still null.
  // (The one surviving push is safe — it runs after the `if (!verdict) verdict = …` fallback.)
  ok(!/status: 'unknown', expected: f\.test, observed: verdict\.observed/.test(src),
    'the null-verdict dereference in the DRIVER_DEAD push is gone');
  ok((src.match(/results\.push\(/g) || []).length === 1, 'exactly ONE results.push site — no second, null-verdict push',
    `found ${(src.match(/results\.push\(/g) || []).length}`);
  ok(src.indexOf("if (!verdict) verdict = { status: 'blocked'") < src.indexOf('results.push('),
    'the surviving push is preceded by the fallback, so verdict can never be null there');
  ok(!/^\s*if \(lastErr && \/403\|used all available credits/m.test(src), 'the unreachable standalone credit check is gone');
  ok(!/lastErr\.message\.slice\(0, 120\)/.test(src), 'the 120-char truncation that cut "used all available credits" is gone');

  const at = src.indexOf('if (!act) {');
  ok(at > 0, 'found the all-attempts-failed branch');
  const close = matchBrace(blanked, src.indexOf('{', at));
  const block = src.slice(at, close + 1);
  ok(block.includes('DRIVER_DEAD ='), 'DRIVER_DEAD is now set INSIDE the !act branch');
  ok(block.includes("status: 'unknown'"), "a dead driver records status 'unknown', never 'fail'");
  ok(/break;\s*\}$/.test(block.trim()), 'the branch still breaks out of the feature loop');
  ok(!block.includes('verdict.observed'), 'the branch builds a LOCAL object, it does not read verdict');

  // EXECUTE the real branch with stubs. `break` needs a loop, so wrap it in one.
  const run = new Function('act', 'lastErr', 'f', 'console',
    `let verdict = null, DRIVER_DEAD = null;\nfor (;;) {\n${block}\nbreak;\n}\nreturn { verdict, DRIVER_DEAD };`);

  // a REAL 403 body: the give-away phrase sits past character 120, which the old slice(0,120) cut off
  const creditMsg = 'LLM 403 {"error":{"code":"permission_denied","message":"Your team ' + 'x'.repeat(90) + ' has used all available credits"}}';
  const dead = run(null, new Error(creditMsg), { test: 'spec' }, NOOP_CONSOLE);
  ok(dead.DRIVER_DEAD !== null, 'a credits/403 failure now sets DRIVER_DEAD (it was unreachable before)');
  ok(dead.verdict && dead.verdict.status === 'unknown', 'the feature is recorded as unknown', JSON.stringify(dead.verdict));
  ok(dead.verdict && /used all available credits/.test(dead.verdict.observed),
    'the give-away phrase survives truncation (it did not at 120 chars)', dead.verdict && dead.verdict.observed);

  const other = run(null, new Error('socket hang up'), { test: 'spec' }, NOOP_CONSOLE);
  ok(other.DRIVER_DEAD === null, 'an ordinary driver failure does NOT declare the driver dead');
  ok(other.verdict && other.verdict.status === 'blocked', 'an ordinary driver failure is still blocked');

  const fine = run({ action: 'click' }, null, { test: 'spec' }, NOOP_CONSOLE);
  ok(fine.verdict === null && fine.DRIVER_DEAD === null, 'a successful driver turn is untouched by the branch');

  // NEGATIVE CONTROL — the original ordering, where `!act` always won the race first.
  const originalOrder = `if (!act) { verdict = { status: 'blocked', observed: 'x' }; break; }\n` +
    `if (lastErr && /403|used all available credits/i.test(String(lastErr.message||''))) { DRIVER_DEAD = 'dead'; break; }`;
  const runOld = new Function('act', 'lastErr', 'console',
    `let verdict = null, DRIVER_DEAD = null;\nfor (;;) {\n${originalOrder}\nbreak;\n}\nreturn { verdict, DRIVER_DEAD };`);
  const oldDead = runOld(null, new Error(creditMsg), NOOP_CONSOLE);
  ok(oldDead.DRIVER_DEAD === null, 'negative control: the ORIGINAL ordering never reached DRIVER_DEAD');
}

// ── 5. viewportShot screenshots must not hit the temporal dead zone ──────────────────────────
section('5 · viewportShot screenshot path is declared before use (EXECUTED)');
{
  const declRe = /const _shotName = \(DESKTOP \? 'qa-desktop-' : 'qa-'\) \+ f\.id \+ '\.png';\s*\n\s*const _shotPath = path\.join\(OUT, _shotName\);/;
  const decl = src.match(declRe);
  ok(!!decl, 'found the _shotName/_shotPath declarations');
  ok((src.match(/const _shotPath = /g) || []).length === 1, '_shotPath is declared exactly once');
  ok((src.match(/const _shotName = /g) || []).length === 1, '_shotName is declared exactly once');
  const declIdx = src.indexOf('const _shotName = (DESKTOP');
  const useIdx = src.indexOf('if (f.viewportShot) { await page.screenshot({ path: _shotPath })');
  ok(useIdx > 0, 'found the viewportShot early-exit');
  ok(declIdx > 0 && declIdx < useIdx, 'declarations come BEFORE the viewportShot early-exit', `decl@${declIdx} use@${useIdx}`);

  // EXECUTE the real declaration lines in both orders to prove the TDZ was the failure mode.
  const D = decl ? decl[0] : '';
  const good = new Function('f', 'DESKTOP', 'path', 'OUT',
    `${D}\nif (f.viewportShot) { return _shotPath; }\nreturn _shotPath;`);
  const goodErr = threw(() => good({ id: 'shrimp', viewportShot: true }, false, path, '/tmp/shots'));
  ok(goodErr === null, 'fixed order runs without a ReferenceError', goodErr && goodErr.message);
  ok(good({ id: 'shrimp', viewportShot: true }, false, path, '/tmp/shots') === path.join('/tmp/shots', 'qa-shrimp.png'),
    'fixed order produces the right screenshot path');

  // NEGATIVE CONTROL — original order: use first, declare after.
  const bad = new Function('f', 'DESKTOP', 'path', 'OUT',
    `if (f.viewportShot) { return _shotPath; }\n${D}\nreturn _shotPath;`);
  const badErr = threw(() => bad({ id: 'shrimp', viewportShot: true }, false, path, '/tmp/shots'));
  ok(badErr instanceof ReferenceError, 'negative control: the ORIGINAL order throws ReferenceError (TDZ)', badErr ? badErr.message : 'it ran — the check is worthless');
}

// ── 6. the "Provider, not app" section must actually name features ───────────────────────────
section('6 · "Provider, not app" names real features and catches 403s (EXECUTED)');
{
  const m = src.match(/const _provider = results\.filter\([\s\S]*?\.map\(r => r\.feature\);/);
  ok(!!m, 'the _provider list maps to r.feature (results are keyed `feature`, not `id`)');
  ok(!/\.map\(r => r\.id\)/.test(src), 'no `.map(r => r.id)` left anywhere');
  ok(/results\.push\(\{ feature: f\.id/.test(src), 'results really are pushed with the key `feature` (the reason r.id was undefined)');
  if (m) {
    const run = new Function('results', m[0] + '\nreturn _provider;');
    const got = run([
      { feature: 'quick-post', observed: 'The AI is having a moment', bugs: [] },
      { feature: 'ideas', observed: '', bugs: ['LLM 403 permission-denied from the provider'] },
      { feature: 'remix', observed: 'hit a 429 rate limit', bugs: [] },
      { feature: 'notebook', observed: 'used all available credits', bugs: [] },
      { feature: 'pipeline', observed: 'all good here', bugs: [] },
    ]);
    ok(got.every(x => typeof x === 'string' && x.length), 'every entry is a real feature name, not undefined', JSON.stringify(got));
    ok(got.join(',') === 'quick-post,ideas,remix,notebook', 'it names exactly the provider-failed features', JSON.stringify(got));
    ok(got.includes('ideas'), 'a 403 / permission-denied failure is now caught by the widened regex');
    ok(!got.includes('pipeline'), 'a healthy feature is not swept in');
    ok(got.length >= 2, 'with 2+ hits the section would render (>= 2 is the gate)');

    // NEGATIVE CONTROL — the original r.id mapping and narrow regex.
    const oldRun = new Function('results', m[0].replace('.map(r => r.feature)', '.map(r => r.id)') + '\nreturn _provider;');
    const oldGot = oldRun([{ feature: 'quick-post', observed: 'The AI is having a moment', bugs: [] }]);
    ok(oldGot.length === 1 && oldGot[0] === undefined, 'negative control: the ORIGINAL r.id mapping yields undefined');
    const narrow = new Function('results',
      m[0].replace(/\|\\b403\\b\|permission-denied\|quota\|insufficient/, '') + '\nreturn _provider;');
    const narrowGot = narrow([{ feature: 'ideas', observed: '', bugs: ['LLM 403 permission-denied from the provider'] }]);
    ok(narrowGot.length === 0, 'negative control: the ORIGINAL narrow regex missed the 403 case');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// ROUND 2 — the eight remaining reliability defects. Same rule as above: EXECUTE the shipped code
// wherever the defect was a runtime behaviour, and pair every assertion with a negative control
// that reproduces the original and must still fail.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

// pull one feature object's source out of ALL_FEATURES, structurally (brace-matched, not regex-y)
function featureEntry(id) {
  const at = src.indexOf(`{ id: '${id}'`);
  if (at < 0) return null;
  const close = matchBrace(blanked, at);
  return close < 0 ? null : src.slice(at, close + 1);
}

// ── 7. a BLIND driver must be told it is blind, and must not judge visual features ──────────────
section('7 · no-vision driver is told it cannot see, and visual features are skipped (EXECUTED)');
{
  const hvSrc = (src.match(/function hasVision\(llm\) \{[\s\S]*?\n\}/) || [])[0];
  ok(!!hvSrc, 'hasVision() is extracted into a named, testable function');
  if (hvSrc) {
    const hasVision = new Function(`${hvSrc}\nreturn hasVision;`)();
    ok(hasVision({ kind: 'anthropic', model: 'claude-sonnet-4-6' }) === true, 'anthropic driver has vision');
    ok(hasVision({ kind: 'openai', model: 'grok-4.6' }) === true, 'grok driver has vision');
    ok(hasVision({ kind: 'openai', model: 'gpt-4o-mini' }) === true, 'gpt-4o driver has vision');
    // THE case that produced fabricated visual verdicts: the Groq/llama fallback.
    ok(hasVision({ kind: 'openai', model: 'llama-3.3-70b-versatile' }) === false, 'the Groq/llama fallback is correctly detected as BLIND');
    ok(hasVision({ kind: 'openai', model: 'some-custom-model' }) === false, 'an unknown MODEL= override is treated as blind (conservative)');
    ok(threw(() => hasVision(null)) === null && hasVision(null) === false, 'hasVision(null) is false, not a crash');
    ok(threw(() => hasVision({ kind: 'openai' })) === null, 'a missing model string does not throw');
  }

  const notice = (src.match(/const NO_VISION_NOTICE = `([\s\S]*?)`;/) || [])[1] || '';
  ok(notice.length > 200, 'NO_VISION_NOTICE exists and is substantive', `len=${notice.length}`);
  ok(/blind/i.test(notice), 'it states plainly that the driver is blind');
  ok(/ignore every instruction above/i.test(notice), 'it overrides the "USE YOUR EYES" opening of the system prompt');
  ok(/blocked/i.test(notice), 'it tells the driver to answer "blocked", not to guess');
  ok(/USE YOUR EYES/.test(src), 'the (now-overridden) "USE YOUR EYES" line is still in the base prompt for sighted runs');

  // the notice must actually be APPENDED — i.e. come after the base prompt, closest to the task
  const sysRun = (src.match(/const SYS_RUN = [^\n;]+;/) || [])[0] || '';
  ok(/visionOK \? SYS : SYS \+ NO_VISION_NOTICE/.test(sysRun), 'SYS_RUN appends the notice LAST when blind', sysRun);
  const built = new Function('visionOK', 'SYS', 'NO_VISION_NOTICE', `${sysRun}\nreturn SYS_RUN;`);
  ok(built(false, 'BASE', '|NOTICE') === 'BASE|NOTICE', 'blind run really gets base + notice');
  ok(built(true, 'BASE', '|NOTICE') === 'BASE', 'a sighted run is completely unchanged');
  ok(!/askLLM\(llm, SYS,/.test(src), 'every driver call now uses SYS_RUN, not the raw SYS');
  ok((src.match(/askLLM\(llm, SYS_RUN,/g) || []).length === 2, 'both driver call sites (turn + out-of-actions) use SYS_RUN');

  // the skip branch — executed
  const skipAt = src.indexOf('if (f.needsVision && !visionOK) {');
  ok(skipAt > 0, 'found the needsVision skip branch');
  if (skipAt > 0) {
    const skipBlock = src.slice(skipAt, matchBrace(blanked, src.indexOf('{', skipAt)) + 1);
    const run = new Function('f', 'visionOK', 'llm', 'console',
      `let verdict = null;\n${skipBlock}\nreturn verdict;`);
    const blind = run({ needsVision: true, id: 'dark-mode', test: 'contrast audit' }, false,
      { name: 'Groq', model: 'llama-3.3-70b-versatile' }, NOOP_CONSOLE);
    ok(blind && blind.status === 'blocked', 'a visual feature on a blind driver is BLOCKED, never pass/fail', JSON.stringify(blind && blind.status));
    ok(blind && /cannot receive screenshots/i.test(blind.observed), 'the reason names the real cause');
    ok(blind && /llama-3\.3-70b-versatile/.test(blind.observed), 'the reason names the model, so it is actionable');
    ok(blind && Array.isArray(blind.bugs) && blind.bugs.length === 0, 'it invents NO bugs');
    // controls: it must be conditional in BOTH directions, or it is an oracle that cannot fail
    ok(run({ needsVision: true, id: 'dark-mode', test: 't' }, true, { name: 'xAI', model: 'grok-4.6' }, NOOP_CONSOLE) === null,
      'control: with vision, the same visual feature is NOT skipped');
    ok(run({ needsVision: false, id: 'pipeline', test: 't' }, false, { name: 'Groq', model: 'llama' }, NOOP_CONSOLE) === null,
      'control: a non-visual feature on a blind driver still runs');
  }

  for (const id of ['dark-mode', 'shrimp', 'settings-deep']) {
    const e = featureEntry(id);
    ok(!!e && /needsVision: true/.test(e), `the purely-visual feature "${id}" is flagged needsVision`);
  }
  ok(!/const visionOK = llm\.kind === 'anthropic'/.test(src), 'the old inline per-feature visionOK expression is gone');
  ok(/neverRan = true;/.test(src) && /if \(neverRan\) continue;/.test(src),
    'a skipped feature does not overwrite qa-<id>.png with a picture of an unrelated screen');
  ok(src.indexOf('if (neverRan) continue;') < src.indexOf('await page.screenshot({ path: _shotPath, fullPage: true })'),
    'that guard sits before the screenshot is taken');
  ok(/PREFLIGHT\.push\(`⚠️ NO VISION/.test(src), 'a blind run is announced in the report Preflight section');
  ok(src.indexOf('PREFLIGHT.push(`⚠️ NO VISION') < src.indexOf('const browser = await chromium.launch'),
    'the no-vision notice is decided before the browser even starts');
}

// ── 8. waitIdle must respect the app's own budgets and SAY when it gives up ─────────────────────
section('8 · waitIdle is per-feature and its timeout is visible (EXECUTED with a fake clock)');
{
  const wiSrc = (src.match(/const waitIdle = async \(maxMs = WAIT_IDLE_MS\) => \{[\s\S]*?\n  \};/) || [])[0];
  ok(!!wiSrc, 'found the waitIdle definition with a configurable default');

  // Run the REAL body against a fake clock. `Date` is a parameter, so it shadows the global inside
  // the compiled function — a 330-second wait is then instantaneous and exactly measurable.
  function makeWaiter(bodySrc, inflightAlways) {
    let now = 0;
    const page = { waitForTimeout: async (ms) => { now += ms; } };
    const Date = { now: () => now };
    const fn = new Function('page', 'WAIT_IDLE_MS', 'Date', 'inflight',
      `${bodySrc}\nreturn waitIdle;`)(page, 75000, Date, inflightAlways);
    return { fn, elapsed: () => now };
  }

  if (wiSrc) {
    const idle = makeWaiter(wiSrc, 0);
    const r1 = await idle.fn(75000);
    ok(r1 === 'idle', 'a quiet page returns the string "idle"', String(r1));

    const busy = makeWaiter(wiSrc, 1);           // a request that never finishes
    const r2 = await busy.fn(330000);
    ok(typeof r2 === 'string' && /HARNESS WAIT TIMEOUT/.test(r2), 'a timeout returns a LOUD string, not silence', String(r2));
    ok(/330s/.test(r2), 'the message states the real budget that was used', String(r2));
    ok(/harness stopped waiting/i.test(r2) && /Do NOT report this as the app hanging/i.test(r2),
      'the message tells the driver this is the HARNESS, not the app');
    ok(busy.elapsed() >= 330000, 'it genuinely waited the full 330s budget before giving up', `${busy.elapsed()}ms`);

    // NEGATIVE CONTROL — the ORIGINAL: hard-coded 75s, bare `return`, no message.
    const OLD = `const waitIdle = async (maxMs = 75000) => { const t0 = Date.now(); let quiet = Date.now(); while (Date.now() - t0 < maxMs) { if (inflight > 0) quiet = Date.now(); else if (Date.now() - quiet > 1400) return; await page.waitForTimeout(200); } };`;
    const oldBusy = makeWaiter(OLD, 1);
    const r3 = await oldBusy.fn();               // callers passed nothing → the flat default
    ok(r3 === undefined, 'negative control: the ORIGINAL returned undefined — the give-up was silent');
    ok(oldBusy.elapsed() < 76000, 'negative control: the ORIGINAL abandoned a 300s-budget crawl after ~75s', `${oldBusy.elapsed()}ms`);
    ok(busy.elapsed() > oldBusy.elapsed() * 4, 'the fix waits >4x longer where the feature asks for it');
  }

  ok(/const _waitMs = f\.waitMs \|\| WAIT_IDLE_MS;/.test(src), 'each feature gets its own wait budget');
  ok((src.match(/await waitIdle\(_waitMs\)/g) || []).length === 2, 'BOTH wait sites (after taps, after each action) use the per-feature budget');
  ok(!/await waitIdle\(\);/.test(src), 'no bare waitIdle() call is left using the flat default');
  ok(/flow\.push\('\(' \+ _tapWait \+ '\)'\)/.test(src) && /flow\.push\('\(' \+ _actWait \+ '\)'\)/.test(src),
    'a timeout is pushed into the flow log at both sites');
  ok(/Actions so far this feature: \$\{flow/.test(src), 'the flow log is fed to the driver, so the timeout is actually seen');

  const sa = featureEntry('settings-autofill');
  ok(!!sa && /waitMs: 330000/.test(sa), 'settings-autofill (the 1-2 minute crawl) waits 330s — above its backend maxDuration of 300');
  const trends = featureEntry('trends');
  ok(!!trends && /waitMs: 120000/.test(trends), 'trends (60s pull-trends budget) waits 120s');
  // ...and the number is justified by the backend, not invented
  const vercel = path.resolve(HERE, '../../vercel.json');
  if (fs.existsSync(vercel)) {
    const vj = JSON.parse(fs.readFileSync(vercel, 'utf8'));
    const crawl = ((vj.functions || {})['api/crawl-brand.js'] || {}).maxDuration;
    ok(crawl === 300, 'evidence: api/crawl-brand.js really is a 300s function', `maxDuration=${crawl}`);
    ok(330000 > crawl * 1000, 'the chosen wait budget exceeds the backend budget it must outlast');
  }
}

// ── 9. openSections.advanced — the key the Daily Ping does NOT live behind ──────────────────────
section('9 · the notifications tap opens the Daily Ping where it ACTUALLY lives (checked vs app.html)');
{
  const APP = path.resolve(HERE, '../../app.html');
  ok(fs.existsSync(APP), 'app.html is present to check the claim against');
  if (fs.existsSync(APP)) {
    const app = fs.readFileSync(APP, 'utf8');
    // the app's real default openSections object, executed
    const defRaw = (app.match(/openSections:\s*(\{[^}]*\})/) || [])[1];
    ok(!!defRaw, 'found the default openSections object in app.html');
    const def = new Function(`return ${defRaw};`)();
    ok(!('advanced' in def), 'CONFIRMED DEFECT: "advanced" is NOT a default openSections key', Object.keys(def).join(','));
    for (const k of ['brand', 'deep', 'tone', 'schedule', 'mix']) ok(k in def, `the real keys exist ("${k}") — so the guard used elsewhere is right`);
    // and even the accordion that IS called 'advanced' is the wrong one: it is Custom Instructions
    // v636: the 'advanced' accordion (Custom Instructions / Master Prompt) was removed with that
    // feature, so the point stands even more strongly — there is no 'advanced' section to confuse
    // with notifications. Assert it is gone rather than asserting what it contains.
    ok(!/toggleSection\('advanced'\)/.test(app), "no 'advanced' accordion remains to be mistaken for notifications");
    // the Daily Ping lives in the Workspace TAB
    const pingAt = app.indexOf('>Daily Idea Ping<');
    const wsAt = app.indexOf("spActiveTab==='workspace'?'block':'none'");
    ok(pingAt > 0 && wsAt > 0 && pingAt > wsAt, 'Daily Idea Ping is inside the Workspace TAB region', `ping@${pingAt} tab@${wsAt}`);
    ok(/function spSetTab\(t\)/.test(app), 'spSetTab() is the real mechanism for reaching it');
    ok(/id="dailyPushHour"/.test(app), '#dailyPushHour is the anchor the tap scrolls to');
  }
  const notif = featureEntry('notifications');
  ok(!!notif, 'found the notifications feature');
  ok(!!notif && !/openSections\.advanced/.test(notif), 'the taps no longer poke the non-existent openSections.advanced');
  // the only surviving mentions must be the explanatory comment, never executable code
  const advLines = src.split('\n').filter(l => l.includes('openSections.advanced'));
  ok(advLines.length > 0 && advLines.every(l => /^\s*\/\//.test(l)),
    'every remaining "openSections.advanced" mention is a comment, not live code', advLines.filter(l => !/^\s*\/\//.test(l)).join(' | '));
  ok(!!notif && /spSetTab\('workspace'\)/.test(notif), 'the taps switch to the Workspace tab');
  ok(!!notif && /dailyPushHour/.test(notif), 'the taps scroll the Daily Ping row into view');
  // the surviving openSections tap (brain) must still use only real keys
  const brain = featureEntry('brain');
  const brainKeys = (brain && brain.match(/\['brand','deep','tone','mix','schedule'\]/)) ? true : false;
  ok(brainKeys, 'the brain feature still forces only real openSections keys');
}

// ── 10. proof-brand-delete must genuinely run last ─────────────────────────────────────────────
section('10 · the destructive brand-delete test really is ordered LAST (EXECUTED sort)');
{
  const rankSrc = (src.match(/function featureRank\(f\) \{[\s\S]*?\n\}/) || [])[0];
  ok(!!rankSrc, 'featureRank() is extracted as a testable function');
  const cpSrc = (src.match(/const CRITICAL_PATH = \[[^\]]*\];/) || [])[0];
  ok(!!cpSrc, 'found CRITICAL_PATH');

  // real declaration order + real flags, read structurally from ALL_FEATURES
  const listStart = src.indexOf('const ALL_FEATURES = [');
  const listEnd = src.indexOf('\n];', listStart);
  const listSrc = src.slice(listStart, listEnd);
  const ids = [...listSrc.matchAll(/\{ id: '([^']+)'/g)].map(m => m[1]);
  ok(ids.length > 20 && ids.includes('proof-brand-delete') && ids.includes('brand-switch'), 'read the real feature list', `${ids.length} features`);
  const stubs = ids.map(id => { const e = featureEntry(id) || ''; return { id, runLast: /runLast: true/.test(e) }; });
  ok(stubs.filter(s => s.runLast).length === 1, 'exactly one feature is flagged runLast');

  // EXECUTE THE REAL SORT STATEMENT, not a re-typed copy of it — otherwise reverting the comparator
  // while leaving featureRank defined-but-unused would slip straight past this section.
  const sortSrc = (src.match(/FEATURES = \[\.\.\.FEATURES\]\.sort\([^\n]*\);/) || [])[0];
  ok(!!sortSrc, 'found the real FEATURES sort statement');
  ok(!!sortSrc && /featureRank/.test(sortSrc), 'the shipped sort actually calls featureRank', sortSrc);
  const order = new Function('FEATURES', `${cpSrc}\n${rankSrc}\n${sortSrc}\nreturn FEATURES.map(f => f.id);`);
  const sorted = order(stubs);
  ok(sorted[sorted.length - 1] === 'proof-brand-delete', 'proof-brand-delete is now the LAST feature to run', sorted.slice(-3).join(' → '));
  ok(sorted.indexOf('brand-switch') < sorted.indexOf('proof-brand-delete'),
    'brand-switch (which enumerates brands) runs BEFORE the brand is created+deleted');
  const cp = new Function(`${cpSrc}\nreturn CRITICAL_PATH;`)();
  ok(sorted.slice(0, cp.length).join(',') === cp.join(','), 'the critical path still runs FIRST, in order', sorted.slice(0, cp.length).join(','));

  // NEGATIVE CONTROL — the ORIGINAL comparator, which knew nothing about runLast.
  const oldOrder = new Function('FEATURES', `${cpSrc}\nreturn [...FEATURES].sort((a, b) => { const ai = CRITICAL_PATH.indexOf(a.id), bi = CRITICAL_PATH.indexOf(b.id); return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi); }).map(f => f.id);`);
  const oldSorted = oldOrder(stubs);
  ok(oldSorted[oldSorted.length - 1] !== 'proof-brand-delete', 'negative control: the ORIGINAL comparator did NOT put it last');
  ok(oldSorted.indexOf('proof-brand-delete') < 10, 'negative control: it originally ran in the first 10 features', `position ${oldSorted.indexOf('proof-brand-delete') + 1}`);
  ok(oldSorted.indexOf('proof-brand-delete') < oldSorted.indexOf('brand-switch'),
    'negative control: it originally ran BEFORE brand-switch — the exact leftover-brand hazard');
}

// ── 11. approve-jump must not permanently mutate a real idea ────────────────────────────────────
section('11 · approve-jump restores what it approved, and skips when nothing is safe (EXECUTED)');
{
  const entry = featureEntry('approve-jump') || '';
  const taps = (entry.match(/taps: \["switchView\('ideas'\)", "([\s\S]*?)"\],/) || [])[1];
  ok(!!taps, 'extracted the approve-jump taps');
  const restore = (entry.match(/restore: "([\s\S]*?)",\n/) || [])[1];
  ok(!!restore, 'approve-jump now declares a `restore` script');
  ok(/if \(f\.restore\)/.test(src), 'the harness actually RUNS f.restore after the verdict');
  ok(src.indexOf('if (f.restore)') > src.indexOf('results.push({ feature: f.id'), 'restore runs AFTER the verdict is recorded, not before the driver looks');

  const unesc = s => s.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  function runTaps(tapSrc, state) {
    const win = {};
    const doc = { querySelectorAll: () => [] };
    const calls = [];
    const quickApprove = (id) => { calls.push(id); const it = state.find(x => x.id === id); if (it) it.status = 'filming'; };
    new Function('document', 'state', 'quickApprove', 'cancelApprovePopup', 'window', unesc(tapSrc))(doc, state, quickApprove, () => {}, win);
    return { win, calls, state };
  }
  function runRestore(restoreSrc, state, win) {
    let saved = 0;
    new Function('window', 'state', 'saveState', 'refreshCurrentView', unesc(restoreSrc))(win, state, () => saved++, () => {});
    return saved;
  }

  if (taps && restore) {
    // A) a pending idea exists → approve it, then put it back exactly as it was
    const st = [{ id: 0, status: 'done' }, { id: 1, status: 'pending' }, { id: 2, status: 'filming' }];
    const a = runTaps(taps, st);
    ok(a.calls.length === 1 && a.calls[0] === 1, 'it approves the PENDING idea (id 1), not the done one', JSON.stringify(a.calls));
    ok(st[1].status === 'filming', 'the approve really happened (so the toast under test really fires)');
    ok(st[0].status === 'done', 'the DONE post was never touched');
    ok(a.win._qaApproveJump && a.win._qaApproveJump.prev === 'pending', 'it remembered the original status');
    const saves = runRestore(restore, st, a.win);
    ok(st[1].status === 'pending', 'restore put the idea back to pending', st[1].status);
    ok(saves === 1, 'restore persisted the rollback (saveState called)');
    ok(!a.win._qaApproveJump, 'the restore marker is cleared afterwards');
    // restore must be idempotent / harmless when there is nothing to undo
    const st2 = [{ id: 1, status: 'pending' }];
    ok(threw(() => runRestore(restore, st2, {})) === null, 'restore with no marker is a safe no-op');
    ok(st2[0].status === 'pending', 'and it changes nothing');

    // B) NOTHING pending → it must skip, not manufacture a victim
    const done = [{ id: 0, status: 'done' }, { id: 1, status: 'filming' }];
    const b = runTaps(taps, done);
    ok(b.calls.length === 0, 'with no pending idea it approves NOTHING');
    ok(done[0].status === 'done' && done[1].status === 'filming', 'it leaves every real post exactly as it found it');
    ok(typeof b.win._qaSkipFeature === 'string' && /no PENDING idea/i.test(b.win._qaSkipFeature), 'it sets _qaSkipFeature with a plain reason', String(b.win._qaSkipFeature));

    // the harness honours that skip as BLOCKED (executed)
    const skipAt = src.indexOf('if (_skip) {');
    ok(skipAt > 0, 'found the _qaSkipFeature handler');
    const skipBlock = src.slice(skipAt, matchBrace(blanked, src.indexOf('{', skipAt)) + 1);
    const runSkip = new Function('_skip', 'f', 'console', `let verdict = null;\n${skipBlock}\nreturn verdict;`);
    const v = runSkip('no PENDING idea exists', { id: 'approve-jump', test: 't' }, NOOP_CONSOLE);
    ok(v && v.status === 'blocked', 'a self-skipped feature reports blocked', JSON.stringify(v && v.status));
    ok(v && /SKIPPED BY THE HARNESS/.test(v.observed), 'and says plainly that the HARNESS skipped it');
    ok(runSkip(null, { id: 'x', test: 't' }, NOOP_CONSOLE) === null, 'control: with no skip flag the feature runs normally');
    ok(/delete window\._qaSkipFeature/.test(src), 'the skip flag is cleared at the start of each feature so it cannot leak');

    // NEGATIVE CONTROL — the ORIGINAL taps, which rewrote a real post's status to test on it.
    const OLD = "try{document.querySelectorAll('.dp-backdrop').forEach(function(x){x.remove();});}catch(e){} var i=(typeof state!=='undefined'&&state)?state.find(function(x){return x&&x.status==='pending';}):null; if(!i && typeof state!=='undefined' && state){ i=state.find(function(x){return x&&x.status;}); if(i) i.status='pending'; } if(i && typeof quickApprove==='function'){ quickApprove(i.id); if(typeof cancelApprovePopup==='function') cancelApprovePopup(); }";
    const oldState = [{ id: 0, status: 'done' }, { id: 1, status: 'filming' }];
    const o = runTaps(OLD, oldState);
    ok(o.calls.length === 1 && o.calls[0] === 0, 'negative control: the ORIGINAL grabbed the DONE post');
    ok(oldState[0].status === 'filming', 'negative control: the ORIGINAL left a real done post sitting in "filming", permanently');
    ok(!o.win._qaSkipFeature, 'negative control: the ORIGINAL had no skip path at all');
  }
}

// ── 12. the notebook probe must be identified by ID, not by position ────────────────────────────
section('12 · notebook delete-probe cannot destroy a real note (EXECUTED, incl. an appending app)');
{
  const pd = featureEntry('proof-data') || src;
  const startAt = pd.indexOf('// 2. NOTEBOOK save + delete');
  const endAt = pd.indexOf("} catch(e){ out.notebookSave='ERROR '+e.message; }", startAt);
  ok(startAt > 0 && endAt > startAt, 'extracted the notebook probe block');
  const block = pd.slice(startAt, endAt + "} catch(e){ out.notebookSave='ERROR '+e.message; }".length);

  // Run the REAL probe against a stub notebook. `append` flips the app from unshift (today) to push
  // (the change that would silently make the OLD probe eat the user's genuine first note).
  function runProbe(body, { append }) {
    return new Function('cfg', `
      let notebookNotes = cfg.notes;
      const out = {};
      const el = { value: '' };
      const document = { getElementById: () => el };
      function switchView(){}
      function saveNotebookToDB(){}
      function nbSaveNote(){ const t = el.value; if (!t) return;
        const n = { id: 'nb-probe', text: t };
        if (cfg.append) notebookNotes.push(n); else notebookNotes.unshift(n);
        el.value = ''; }
      function nbDelete(id){ notebookNotes = notebookNotes.filter(n => n.id !== id); }
      ${body}
      return { out, notes: notebookNotes };
    `)({ notes: [{ id: 'real-1', text: "the user's genuine first note" }, { id: 'real-2', text: 'second' }], append });
  }

  // (a) today's app (unshift) — must still work exactly as before
  const un = runProbe(block, { append: false });
  ok(/^saved \(probe id nb-probe\)/.test(un.out.notebookSave), 'unshift app: the probe is identified by id', un.out.notebookSave);
  ok(un.out.notebookDelete === 'WORKS (probe removed)', 'unshift app: delete reports WORKS', un.out.notebookDelete);
  ok(un.notes.length === 2 && un.notes[0].id === 'real-1', 'unshift app: both real notes survive');

  // (b) THE DEFECT: an app that APPENDS. The fix must still delete the probe and keep the real note.
  const ap = runProbe(block, { append: true });
  ok(ap.out.notebookDelete === 'WORKS (probe removed)', 'appending app: still reports WORKS because it really worked', ap.out.notebookDelete);
  ok(!ap.notes.some(n => n.id === 'nb-probe'), 'appending app: the PROBE is what got deleted');
  ok(ap.notes.some(n => n.id === 'real-1'), "appending app: the user's genuine first note survives");

  // NEGATIVE CONTROL — the ORIGINAL position-based probe on the same appending app.
  const OLD = `
        if (typeof nbSaveNote!=='function' || typeof notebookNotes==='undefined') out.notebookSave='functions/state missing';
        else {
          switchView('notebook');
          var ni=document.getElementById('nbInput');
          if(!ni) out.notebookSave='composer not rendered';
          else {
            var n0=notebookNotes.length;
            ni.value='QA probe note — safe to delete.';
            nbSaveNote();
            var saved=notebookNotes.length===n0+1;
            out.notebookSave=(saved?'saved ':'NOT saved (BROKEN) ');
            if(saved && typeof nbDelete==='function'){ nbDelete(notebookNotes[0].id);
              out.notebookDelete = notebookNotes.length===n0 ? 'WORKS' : 'BROKEN (note still there)'; }
          }
        }`;
  const oldAp = runProbe(OLD, { append: true });
  ok(oldAp.out.notebookDelete === 'WORKS', 'negative control: the ORIGINAL still reported WORKS…', oldAp.out.notebookDelete);
  ok(!oldAp.notes.some(n => n.id === 'real-1'), "negative control: …while actually deleting the user's real first note");
  ok(oldAp.notes.some(n => n.id === 'nb-probe'), 'negative control: …and leaving the QA probe behind');
}

// ── 13. errors logged before the first feature must be visible in the report ────────────────────
section('13 · pre-feature (boot) errors are attributed and rendered (EXECUTED)');
{
  ok(/const BOOT_ERR_END = allErrors\.length;/.test(src), 'the boot/feature boundary is captured');
  const bAt = src.indexOf('const BOOT_ERR_END = allErrors.length;');
  const loopAt = src.indexOf('if (ready) for (const f of FEATURES) {');
  ok(bAt > 0 && loopAt > bAt, 'the boundary is taken BEFORE the feature loop starts', `boundary@${bAt} loop@${loopAt}`);
  ok(/const bootErrs = allErrors\.slice\(0, BOOT_ERR_END\);/.test(src), 'the report slices exactly the pre-feature errors');

  const secAt = src.indexOf('if (bootErrs.length) {');
  ok(secAt > 0, 'found the boot section renderer');
  const secBlock = src.slice(secAt, matchBrace(blanked, src.indexOf('{', secAt)) + 1);
  const render = new Function('bootErrs', `let md = '';\n${secBlock}\nreturn md;`);
  const out = render([{ kind: 'JS error', detail: 'boom during boot' }]);
  ok(/## boot/.test(out), 'it renders a labelled boot section');
  ok(/JS error/.test(out) && /boom during boot/.test(out), 'the actual error text appears in the report', out.slice(0, 60));
  ok(/exit code/i.test(out), 'it explains that these count toward the headline total + exit code');
  ok(render([]) === '', 'control: a clean boot renders nothing at all');

  // it must land in the document, not after the end
  ok(secAt < src.indexOf('fs.writeFileSync(REPORT, md);'), 'the section is added before the report is written');
  ok(/const hard = allErrors\.filter/.test(src), 'the hard-error headline still counts from allErrors (so boot errors are in it — now explained)');
}

// ── 14. the requestfailed handler must not close over a not-yet-declared const ──────────────────
section('14 · current/IGNORE are declared before the listeners that use them (EXECUTED TDZ proof)');
{
  const decl = src.indexOf("let current = 'boot';");
  const ign = src.indexOf('const IGNORE = /favicon');
  const handler = src.indexOf("page.on('requestfailed', r => {");
  ok(decl > 0 && ign > 0 && handler > 0, 'found the declarations and the handler');
  ok(decl < handler, '`current` is declared before the requestfailed handler', `decl@${decl} handler@${handler}`);
  ok(ign < handler, '`IGNORE` is declared before the requestfailed handler', `decl@${ign} handler@${handler}`);
  ok((src.match(/let current = 'boot';/g) || []).length === 1, 'current is declared exactly once');
  ok((src.match(/const IGNORE = \/favicon/g) || []).length === 1, 'IGNORE is declared exactly once');
  const pageerror = src.indexOf("page.on('pageerror'");
  ok(decl < pageerror && ign < pageerror, 'the other listeners are covered by the same hoist too');

  // Prove the failure mode is real: a handler that fires before the const line throws a TDZ error.
  const badErr = threw(() => new Function(`
    const handlers = [];
    const on = (fn) => handlers.push(fn);
    on(() => IGNORE.test('x') ? current : current);
    handlers[0]();
    let current = 'boot';
    const IGNORE = /favicon/;
  `)());
  ok(badErr instanceof ReferenceError, 'negative control: the ORIGINAL ordering is a TDZ ReferenceError when the handler fires', badErr ? badErr.message : 'it ran — the check is worthless');
  const goodErr = threw(() => new Function(`
    let current = 'boot';
    const IGNORE = /favicon/;
    const handlers = [];
    const on = (fn) => handlers.push(fn);
    on(() => IGNORE.test('x') ? current : current);
    handlers[0]();
  `)());
  ok(goodErr === null, 'the hoisted ordering runs cleanly', goodErr && goodErr.message);
}

console.log('');
if (failures.length) {
  console.log(`FAILED — ${failures.length} of ${checks} assertions did not hold:`);
  for (const f of failures) console.log('  • ' + f);
  process.exit(1);
}
console.log(`${checks} assertions held.`);
console.log('harness fixes verification passed');
