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

// behave(n) decides what the nth attempt does: 'hangup' | 'silence' | {status, body}
async function run(behave, opts) {
  let attempts = 0;
  https.request = (o, cb) => {
    const n = ++attempts;
    const req = new EventEmitter();
    req.write = () => {}; req.destroy = () => {};
    let timer = null;
    req.setTimeout = (ms, fn) => { timer = setTimeout(fn, ms); };
    req.end = () => setTimeout(() => {
      const a = behave(n);
      if (a === 'silence') return;                       // never answers: the timeout owns it
      if (timer) clearTimeout(timer);
      if (a === 'hangup') return req.emit('error', new Error('socket hang up'));
      const resp = new EventEmitter();
      resp.statusCode = a.status;
      cb(resp); resp.emit('data', a.body); resp.emit('end');
    }, 1);
    return req;
  };
  const p = require_.resolve(path.join(ROOT, 'api/_llm.js'));
  delete require_.cache[p];
  const { callGrokSearch } = require_(p);
  const t0 = Date.now();
  const out = await callGrokSearch('find me some trends', opts);
  https.request = realRequest;
  return { out, attempts, ms: Date.now() - t0 };
}

const GOOD = { status: 200, body: JSON.stringify({ output: [{ content: [{ type: 'output_text', text: 'a trend' }] }] }) };

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

// ── 7. both callers hand it a deadline, so the race and the socket agree ─────
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

// ── 8. the cron reports work outstanding, not work done-and-skipped ──────────
{
  const cr = fs.readFileSync(path.join(ROOT, 'api/pull-trends-cron.js'), 'utf8');
  ok(/untried \+= \(due\.length - i\)/.test(cr) && /'ms — updated ' \+ updated \+\s*\n?\s*', ' \+ untried \+ ' not attempted/.test(cr.replace(/\r/g, '')),
     '"left for the next run" counts only brands the loop never reached. It used to print `skipped`, which ' +
     'already included brands tried and skipped for a real reason: production logged "8 left" when 4 were.');
}

if (failed === 0) console.log('\nPASS — search-lane-resilience: a dropped connection is retried once, a timeout is not, and no socket outlives its budget.');
else { console.error('\n' + failed + ' failure(s)'); process.exitCode = 1; }
