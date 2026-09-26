#!/usr/bin/env node
// GATE: when the AI account is paused, the app says so in the server's words, once, and never
//       retries it or tells the person to "try again in a few seconds".
//
// WHY THIS EXISTS
//   Since v690 every AI endpoint answers a refused xAI account (out of credits / spending limit)
//   with HTTP 503 and { error: <plain message>, code: 'AI_UNAVAILABLE' } (api/_llm.js
//   aiUnavailable). The app had no idea that shape existed. About half the callers never read
//   data.error at all: the automatic refill after every approve, the People-also-ask pull, the hook
//   reader and the settings examples failed silently, and nbDevelop / sparkDevelop / the viral
//   analyser / the scene generator put up their own invented reason ("Could not develop that — try
//   again", "try again in a moment", "Update brand settings to retry"). Retrying can never fix an
//   empty account, so every one of those sentences sent the person to do something useless.
//
// HOW IT CHECKS — it RUNS the real code, lifted from app.html, in node:vm:
//   1. The real global fetch wrapper, over a fake network that answers 503 AI_UNAVAILABLE: the
//      server's message is shown exactly once, recorded for later callers, the body is still
//      readable by the caller, and the network is hit exactly once (no retry).
//      Opposite arms: a plain 503 HTML page and a 503 with some other code raise nothing, and a
//      402 limit_reached still opens the upgrade modal as before.
//   2. The real readJsonOrThrow: the thrown message IS the server's message (no "few seconds",
//      no "in a moment"); an ordinary 503 without a body still gets its old wording.
//   3. The real leanBrandFetch through the wrapper: a 503 is one request; a dropped connection
//      is still retried once (the opposite arm — the network retry must survive).
//   4. The real nbDevelop end to end: the only thing said is the server's message. Opposite arm:
//      an ordinary failure still says "Could not develop that — try again".
//   5. Every client string that says "few seconds" belongs to the rate-limit path, where waiting
//      a few seconds really is the fix.
//
// RUN:    node scripts/verify/rv-front-ai-unavailable.mjs
// EXPECT: prints "AI UNAVAILABLE UI OK" and exits 0.
import fs from 'node:fs'; import vm from 'node:vm';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
setTimeout(() => { console.log('FAIL: wall clock (60s) exceeded'); process.exit(2); }, 60000).unref();
let fail = 0; const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fail++; } else console.log('ok:', m); };
const grab = n => {
  let i = html.indexOf('\nfunction ' + n + '('); if (i < 0) i = html.indexOf('\nasync function ' + n + '(');
  if (i < 0) throw new Error('no function ' + n + ' in app.html — re-anchor this gate');
  return html.slice(i + 1, html.indexOf('\n}', i) + 2);
};
const wrapperSrc = (() => {
  const k = html.indexOf('  if (window.__apiAuthPatched) return; window.__apiAuthPatched = true;');
  const i = html.lastIndexOf('(function(){', k);
  const j = html.indexOf('\n})();', k);
  if (k < 0 || i < 0 || j < 0) throw new Error('fetch wrapper not found — re-anchor this gate');
  return html.slice(i, j + 6);
})();

const MSG = 'The AI writer is paused on our side right now (our AI account hit a limit). Nothing is wrong with your account, and no credits were used. Please try again later.';
const jsonResp = (status, body, url) => {
  const r = new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (url) Object.defineProperty(r, 'url', { value: url });
  return r;
};
const htmlResp = (status) => new Response('<!DOCTYPE html><h1>Service Unavailable</h1>', { status, headers: { 'content-type': 'text/html' } });

function mkWorld(answer) {
  const c = {
    console, JSON, Date, Math, String, Error, TypeError, Promise, Object, Array, Headers, Response,
    setTimeout, clearTimeout,
    location: { origin: 'https://contentshrimp.com' },
    toasts: [], upgrades: [], calls: [],
    connToken: async () => null,
  };
  c.window = c;
  c.showToast = (m) => c.toasts.push(String(m));
  c.showUpgrade = (d) => c.upgrades.push(d);
  c.showFeatureLock = () => {};
  c.refreshUsage = () => {};
  c.markOnb = () => {};
  c.fetch = async (input, init) => { c.calls.push(String(input)); return answer(c.calls.length, input, init); };
  vm.createContext(c);
  for (const n of ['csNoteAiUnavailable', 'csAiPausedText', 'readJsonOrThrow', 'humanErr', '_leanNetFail', 'leanBrandFetch'])
    vm.runInContext(grab(n), c);
  vm.runInContext(wrapperSrc, c);   // replaces c.fetch with the real wrapper around the fake
  return c;
}

// ── 1. the wrapper names it once, in the server's words ─────────────────────
{
  const c = mkWorld(() => jsonResp(503, { error: MSG, code: 'AI_UNAVAILABLE' }));
  const r = await c.fetch('/api/generate-ideas', { method: 'POST', body: '{}' });
  ok(c.calls.length === 1, 'one 503 AI_UNAVAILABLE is ONE request — nothing retries it (' + c.calls.length + ')');
  ok(c.toasts.length === 1 && c.toasts[0] === MSG,
     "the server's own message is shown, once (" + JSON.stringify(c.toasts) + '). Before v690 this ' +
     'wrapper ignored 503 entirely, so every caller that never reads data.error said nothing at all');
  ok(c.window._csAiPaused && c.window._csAiPaused.msg === MSG, 'and it is recorded for the caller that asks next');
  let body = null; try { body = await r.json(); } catch (e) {}
  ok(body && body.code === 'AI_UNAVAILABLE' && body.error === MSG,
     'and the caller still gets the whole body — the wrapper reads a CLONE, it does not eat the response');
  ok(vm.runInContext('csAiPausedText("fallback")', c) === MSG, 'csAiPausedText answers with it inside the window');
  c.window._csAiPaused.at = Date.now() - 120000;
  ok(vm.runInContext('csAiPausedText("fallback")', c) === 'fallback',
     'and lets it go once it is stale, so a later unrelated failure is not blamed on it');
}
// ── 1b. opposite arms: other failures are untouched ──────────────────────────
{
  const c = mkWorld(() => htmlResp(503));
  await c.fetch('/api/generate-ideas', { method: 'POST', body: '{}' });
  ok(c.toasts.length === 0 && !c.window._csAiPaused, 'a plain 503 HTML page raises no AI-paused message (' + JSON.stringify(c.toasts) + ')');
  const c2 = mkWorld(() => jsonResp(503, { error: 'Maintenance', code: 'SOMETHING_ELSE' }));
  await c2.fetch('/api/remix', { method: 'POST', body: '{}' });
  ok(c2.toasts.length === 0 && !c2.window._csAiPaused, 'nor does a 503 carrying a different code');
  const c3 = mkWorld(() => jsonResp(402, { error: 'limit_reached' }, 'https://contentshrimp.com/api/generate-ideas'));
  await c3.fetch('/api/generate-ideas', { method: 'POST', body: '{}' });
  await new Promise(r => setTimeout(r, 20));   // the 402 branch is fire-and-forget
  ok(c3.upgrades.length === 1 && !c3.window._csAiPaused, 'and a 402 limit_reached still opens the upgrade modal exactly as before');
}
// ── 2. readJsonOrThrow passes the message through ────────────────────────────
{
  const c = mkWorld(() => jsonResp(503, { error: MSG, code: 'AI_UNAVAILABLE' }));
  let e1 = null; try { await vm.runInContext('readJsonOrThrow', c)(jsonResp(503, { error: MSG, code: 'AI_UNAVAILABLE' }), 'Writing your post'); } catch (e) { e1 = e; }
  ok(e1 && e1.message === MSG, 'readJsonOrThrow throws the server message word for word (' + (e1 && e1.message) + ')');
  ok(e1 && !/few seconds|in a moment/i.test(e1.message), 'and nothing adds "few seconds" / "in a moment" to it');
  ok(vm.runInContext('humanErr', c)(MSG, 'x') === MSG, 'humanErr leaves a sentence alone, so callers that pass it through show it');
  let e2 = null; try { await vm.runInContext('readJsonOrThrow', c)(htmlResp(503), 'Writing your post'); } catch (e) { e2 = e; }
  ok(e2 && /couldn't reach the AI service \(error 503\)/.test(e2.message),
     'an ordinary 503 with no body keeps its old wording (' + (e2 && e2.message) + ')');
}
// ── 3. leanBrandFetch: no retry for a 503, one retry for a dropped line ─────
{
  const c = mkWorld(() => jsonResp(503, { error: MSG, code: 'AI_UNAVAILABLE' }));
  c.currentBrand = null;
  const r = await vm.runInContext('leanBrandFetch', c)('/api/video-beats', { script: 'x' }, () => ({}));
  ok(r.status === 503 && c.calls.length === 1, 'leanBrandFetch sends a 503 back to its caller after ONE request (' + c.calls.length + ')');
  const c2 = mkWorld((n) => { if (n === 1) throw new TypeError('Failed to fetch'); return jsonResp(200, { beats: [1] }); });
  c2.currentBrand = null;
  const r2 = await vm.runInContext('leanBrandFetch', c2)('/api/video-beats', { script: 'x' }, () => ({}));
  ok(r2.status === 200 && c2.calls.length === 2, 'the opposite arm: a dropped connection is still retried once (' + c2.calls.length + ' requests)');
}
// ── 4. a caller that used to invent a reason now repeats the real one ────────
async function develop(answer) {
  const c = mkWorld(answer);
  Object.assign(c, {
    currentBrand: null, notebookNotes: [{ id: 7, text: 'the boring middle' }],
    brandGate: () => () => true, getTodayName: () => 'Monday', getBrandContext: () => ({}),
    state: [], IDEAS: [], saveState() {}, saveGeneratedIdeas() {}, renderNav() {}, switchView() {},
  });
  vm.runInContext(grab('nbDevelop'), c);
  const btn = { disabled: false, textContent: '' };
  await vm.runInContext('nbDevelop', c)(7, btn);
  return { c, btn };
}
{
  const { c, btn } = await develop(() => jsonResp(503, { error: MSG, code: 'AI_UNAVAILABLE' }));
  ok(c.toasts.length >= 1 && c.toasts.every(t => t === MSG),
     'nbDevelop says only the server message (' + JSON.stringify(c.toasts) + '). It used to add "Could not ' +
     'develop that — try again", which retrying cannot fix');
  ok(c.calls.length === 1, 'and it asked once');
  ok(btn.disabled === false, 'and the button is given back');
  const o = await develop(() => htmlResp(500));
  ok(o.c.toasts.length === 1 && /Could not develop that/.test(o.c.toasts[0]),
     'the opposite arm: an ordinary failure still says "Could not develop that — try again" (' + JSON.stringify(o.c.toasts) + ')');
}
// ── 5. "few seconds" is only ever said about going too fast ──────────────────
{
  const bad = [];
  html.split('\n').forEach((ln, i) => {
    if (!/few seconds/i.test(ln)) return;
    const quoted = /(['"`])[^'"`]*few seconds[^'"`]*\1/i.test(ln);
    if (quoted && !/rate_limited|rate/i.test(ln)) bad.push(i + 1);
  });
  ok(bad.length === 0, 'every "few seconds" string in app.html is on the rate-limit path (offending lines: ' + bad.join(', ') + ')');
}

if (fail === 0) { console.log('\nAI UNAVAILABLE UI OK'); process.exit(0); }
console.log('\n' + fail + ' failure(s)'); process.exit(1);
