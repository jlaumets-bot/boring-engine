#!/usr/bin/env node
// GATE: one socket hang-up may not end the web-search lane, and its socket may not outlive its budget.
//
// WHY THIS EXISTS
//   Production, 2026-09-18 05:35 UTC, /api/pull-trends-cron — four brands, every one of them:
//     grok-search: timed out after 90s
//     grok-search: request failed — socket hang up
//     pull-trends-cron: brand <id> got NOTHING from any source — lanes grok=0 news=0 x=0
//     pull-trends-cron: EVERY source returned nothing for all 4 brand(s) that were actually tried
//   callXAI — the sibling that makes every other x.ai call in this app — retries up to four
//   times with exponential backoff on a NETWORK error, and deliberately never retries a timeout
//   (a timeout means the request is being worked on; a hang-up means it never started).
//   callGrokSearch had no retry at all: one dropped connection emptied the lane. It is not only
//   trends — brand-voice-chat.js, crawl-brand.js and reviews.js all go through it.
//
//   Its timeout was also hard-coded at 90s while every caller races it against something much
//   shorter (the cron computes ~45s from its remaining budget, the on-demand button passes 35s).
//   The race resolved and the lane moved on, but the SOCKET stayed open for the full 90s — so a
//   retry could never have fitted inside the budget even if one had existed.
//
// HOW IT CHECKS
//   It RUNS the real callGrokSearch with node:https stubbed, and counts attempts. Both arms of
//   the rule are proved: a network error retries, a timeout does not. It also proves the retry
//   is bounded — it must not fire when the caller's deadline has no room left — and that a
//   successful call still makes exactly one request.
//
// RUN:    node scripts/verify/search-lane-resilience.mjs
// EXPECT: prints "PASS" and exits 0.
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.XAI_API_KEY = 'test-only-not-a-real-key';

let failed = 0;
const ok = (c, m) => { if (c) console.log('ok: ' + m); else { console.error('FAIL: ' + m); failed++; } };
const https = require_('node:https');
const realRequest = https.request;

// behave(n) decides what the nth attempt does:
//   'hangup'  — socket error
//   'silence' — accepted, then nothing at all (the idle timer owns it)
//   {sse:[...], gapMs} — a real event-stream, optionally drip-fed
//   {status, body} — one buffered JSON body
async function run(behave, opts) {
  let attempts = 0;
  const timers = [];
  https.request = (o, cb) => {
    const n = ++attempts;
    const req = new EventEmitter();
    req.write = () => {};
    let idle = null, killed = false;
    req.destroy = () => { killed = true; if (idle) clearTimeout(idle); };
    req.setTimeout = (ms, fn) => { idleFn = fn; idleMs = ms; idle = setTimeout(fn, ms); timers.push(idle); };
    // A real socket RE-ARMS its inactivity timer on every byte. Clearing it once (as this stub
    // first did) makes a stalled stream look survivable and hides the missing absolute deadline.
    let idleFn = null, idleMs = 0;
    const bump = () => { if (idle) clearTimeout(idle); if (idleFn) { idle = setTimeout(idleFn, idleMs); timers.push(idle); } };
    req.end = () => setTimeout(() => {
      const a = behave(n);
      if (a === 'silence') return;                       // never answers: the idle timer owns it
      if (a === 'hangup') { if (idle) clearTimeout(idle); return req.emit('error', new Error('socket hang up')); }
      const resp = new EventEmitter();
      if (a.sse) {
        resp.statusCode = a.status || 200;
        resp.headers = { 'content-type': 'text/event-stream' };
        cb(resp);
        let t = 0;
        const gap = a.gapMs || 5;
        a.sse.forEach((chunk) => {
          t += gap;
          const h = setTimeout(() => { if (killed) return; bump(); resp.emit('data', Buffer.from(chunk)); }, t);
          timers.push(h);
        });
        if (!a.neverEnds) {
          const h = setTimeout(() => { if (killed) return; resp.emit('end'); }, t + gap);
          timers.push(h);
        }
        return;
      }
      if (idle) clearTimeout(idle);
      resp.statusCode = a.status;
      resp.headers = { 'content-type': 'application/json' };
      cb(resp); resp.emit('data', Buffer.from(a.body)); resp.emit('end');
    }, 1);
    return req;
  };
  const p = require_.resolve(path.join(ROOT, 'api/_llm.js'));
  delete require_.cache[p];
  const { callGrokSearch } = require_(p);
  const t0 = Date.now();
  // NO ARM MAY HANG. Without this a missing absolute deadline stalls the gate instead of failing
  // it, and a gate that hangs is a gate nobody runs — which is exactly how that mutation escaped.
  const WALL = ((opts && opts.timeoutMs) || 90000) + 5000;
  const out = await Promise.race([
    callGrokSearch('find me some trends', opts),
    new Promise(r => { const h = setTimeout(() => r('__HUNG__'), WALL); timers.push(h); }),
  ]);
  https.request = realRequest;
  timers.forEach(t => { try { clearTimeout(t); } catch (_) {} });
  if (out === '__HUNG__') { ok(false, 'callGrokSearch NEVER SETTLED within ' + WALL + 'ms (budget ' + ((opts && opts.timeoutMs) || 90000) + 'ms) — nothing bounds the call, so in production the platform kills the whole function instead.'); return { out: null, attempts, ms: Date.now() - t0, hung: true }; }
  return { out, attempts, ms: Date.now() - t0 };
}
const sseEvent = (o) => 'data: ' + JSON.stringify(o) + '\n\n';

const GOOD = { status: 200, body: JSON.stringify({ output: [{ content: [{ type: 'output_text', text: 'a trend' }] }] }) };
// A realistic event-stream: text arrives as deltas, then one completed response.
const GOOD_SSE = { sse: [
  sseEvent({ type: 'response.output_text.delta', delta: 'a ' }),
  sseEvent({ type: 'response.output_text.delta', delta: 'trend' }),
  sseEvent({ type: 'response.completed', response: { output: [{ content: [{ type: 'output_text', text: 'a trend' }] }] } }),
  'data: [DONE]\n\n',
] };

// ── 1. a network error retries ONCE, and can still succeed ───────────────────
{
  const r = await run(n => (n === 1 ? 'hangup' : GOOD), { maxTokens: 100, timeoutMs: 20000 });
  ok(r.attempts === 2, 'a socket hang-up is retried (attempts=' + r.attempts + ') — before this, one dropped connection emptied the whole lane');
  ok(r.out === 'a trend', 'and the retry that succeeds returns the text (' + JSON.stringify(r.out) + ')');
}
// ── 2. it retries ONCE, not forever ──────────────────────────────────────────
{
  const r = await run(() => 'hangup', { maxTokens: 100, timeoutMs: 20000 });
  ok(r.attempts === 2, 'a persistently dead connection is attempted exactly twice, not indefinitely (attempts=' + r.attempts + ')');
  ok(r.out === null, 'and it still resolves null rather than throwing into the lane');
}
// ── 3. a TIMEOUT is never retried — same rule as callXAI ─────────────────────
{
  // Raced against a wall clock: if the socket timeout goes back to being hard-coded, this arm
  // FAILS in 9 seconds instead of hanging for 90. A gate that hangs is a gate nobody runs.
  const WATCH = 9000;
  const race = await Promise.race([
    run(() => 'silence', { maxTokens: 100, timeoutMs: 5000 }).then(r => r),
    new Promise(r => setTimeout(() => r('OVERRAN'), WATCH)),
  ]);
  ok(race !== 'OVERRAN',
     'callGrokSearch honours the CALLER\'s timeout — it was hard-coded at 90s while every caller ' +
     'races it against something far shorter, so the socket stayed open long after the lane had ' +
     'given up on it, and a retry could never have fitted inside the budget.');
  if (race !== 'OVERRAN') {
    ok(race.attempts === 1, 'a timeout is NOT retried (attempts=' + race.attempts + ') — a timeout means the request is being worked on, a hang-up means it never started');
    ok(race.out === null, 'and it resolves null');
    ok(race.ms < WATCH, 'and it returns inside its 5000ms budget (' + race.ms + 'ms)');
  }
}
// ── 4. the retry is bounded by the deadline, not by hope ─────────────────────
{
  const r = await run(() => 'hangup', { maxTokens: 100, timeoutMs: 5000 });
  ok(r.attempts === 1, 'with only 5s of budget there is no room for a retry, so none is attempted (attempts=' + r.attempts + ')');
}
// ── 5. the happy path is unchanged: exactly one request ──────────────────────
{
  const r = await run(() => GOOD, { maxTokens: 100, timeoutMs: 20000 });
  ok(r.attempts === 1 && r.out === 'a trend', 'a call that works makes exactly one request (attempts=' + r.attempts + ')');
}
// ── 6. an HTTP error is not retried either — it is an answer ─────────────────
{
  const r = await run(() => ({ status: 429, body: '{"error":"rate limited"}' }), { maxTokens: 100, timeoutMs: 20000 });
  ok(r.attempts === 1 && r.out === null, 'a 429 is a real answer and is not retried here (attempts=' + r.attempts + ')');
}

// ── 7. a streamed answer is read, and the caller's deadline is ABSOLUTE ──────
// This is the production failure. Every call on 2026-09-19 ended in "timed out", never once an
// HTTP status — at 90s before v684 and at 45s after. The shape is not wrong (docs.x.ai documents
// exactly this endpoint and body), and no parameter bounds how much searching the model does.
// req.setTimeout is Node's socket INACTIVITY timeout, so a non-streaming agentic search — which
// sends zero bytes while it works — is indistinguishable from a dead socket. Streaming keeps
// bytes flowing so the idle timer only fires on real silence, and an ABSOLUTE deadline (which the
// old code never had) is what bounds the call.
{
  const r = await run(() => GOOD_SSE, { maxTokens: 100, timeoutMs: 20000 });
  ok(r.out === 'a trend', 'a streamed answer is assembled into text (' + JSON.stringify(r.out) + ')');
  ok(r.attempts === 1, 'in one attempt');
}
{
  // Deltas only, no completed event — the text must still come through.
  const r = await run(() => ({ sse: [
    sseEvent({ delta: 'half ' }), sseEvent({ delta: 'a trend' }), 'data: [DONE]\n\n',
  ] }), { maxTokens: 100, timeoutMs: 20000 });
  ok(r.out === 'half a trend', 'deltas alone are enough when no completed event arrives (' + JSON.stringify(r.out) + ')');
}
{
  // THE REAL ONE: bytes keep trickling, so the idle timer never fires. Without an absolute
  // deadline this call runs until the platform kills the whole function.
  const t0 = Date.now();
  const r = await run(() => ({ sse: Array.from({ length: 400 }, (_, i) => sseEvent({ delta: 'x' + i })), gapMs: 30, neverEnds: true }),
                      { maxTokens: 100, timeoutMs: 6000 });
  const el = Date.now() - t0;
  ok(el < 9000, 'a stream that never finishes is cut off at the caller\'s budget (' + el + 'ms for 6000ms) — ' +
     'the idle timer alone would never fire while bytes keep arriving, and the function would be killed instead');
  ok(r.out === null, 'and it returns null rather than half a JSON array, which every caller would fail to parse');
}
{
  // A server that ignores `stream` and sends one JSON body must still work.
  const r = await run(() => GOOD, { maxTokens: 100, timeoutMs: 20000 });
  ok(r.out === 'a trend', 'a buffered (non-streaming) answer is still parsed (' + JSON.stringify(r.out) + ')');
}
{
  const src = fs.readFileSync(path.join(ROOT, 'api/_llm.js'), 'utf8');
  ok(/stream: true/.test(src), 'the request asks for a stream');
  ok(/first byte /.test(src) && /bytes, /.test(src) && /events, /.test(src),
     'and every outcome logs first-byte latency, bytes and events, so the next run says how long ' +
     'the search actually takes instead of only that it did not fit');
}

// ── 8. both callers hand it a deadline, so the race and the socket agree ─────
{
  const tr = fs.readFileSync(path.join(ROOT, 'api/_trends.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, '');
  for (const [what, re] of [
    ['the trends lane', /callGrokSearch\(prompt, \{ maxTokens: 1200, timeoutMs: grokTimeoutMs/],
    ['the competitor pulse', /callGrokSearch\(prompt, \{ maxTokens: 700, timeoutMs: opts\.timeoutMs/],
  ]) ok(re.test(tr), what + ' passes its own deadline down, so callGrokSearch cannot hold a socket open past it');
  ok(/pullGrokTrends\(keywords, maxAgeHours, brainObj, grokTimeoutMs\)/.test(tr),
     'and the deadline is actually IN SCOPE where it is used — pullGrokTrends takes it as a parameter ' +
     '(reading a caller-only variable here would be a ReferenceError at runtime, which no syntax check catches)');
}

// ── 9. the cron reports work outstanding, not work done-and-skipped ──────────
{
  const cr = fs.readFileSync(path.join(ROOT, 'api/pull-trends-cron.js'), 'utf8');
  ok(/untried \+= \(due\.length - i\)/.test(cr) && /'ms — updated ' \+ updated \+\s*\n?\s*', ' \+ untried \+ ' not attempted/.test(cr.replace(/\r/g, '')),
     '"left for the next run" counts only brands the loop never reached. It used to print `skipped`, which ' +
     'already included brands tried and skipped for a real reason: production logged "8 left" when 4 were.');
}

if (failed === 0) console.log('\nPASS — search-lane-resilience: a dropped connection is retried once, a timeout is not, and no socket outlives its budget.');
else { console.error('\n' + failed + ' failure(s)'); process.exitCode = 1; }
