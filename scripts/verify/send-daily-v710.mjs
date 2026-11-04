#!/usr/bin/env node
// GATE send-daily-v710 — the morning batch calls the PUBLIC domain, and a failed batch is counted
// and turns the heartbeat red.
//
// WHY THIS EXISTS (deep audit G-reliability findings 2 and 3)
//   1. send-daily called https://${VERCEL_URL}/api/generate-ideas. VERCEL_URL is the deployment's own
//      *.vercel.app address, which Vercel Authentication guards on this project, so the call got a 401
//      login page. Now: PUBLIC_APP_URL when it is a valid https URL, else https://contentshrimp.com.
//      VERCEL_URL is never used.
//   2. A non-2xx, non-JSON or HTML answer became `null`: no ideas, a plain push, and an 'ok'
//      heartbeat — for weeks nothing turned red. Now each failure is counted (detail.gen) and logged
//      with its status, and a run where EVERY attempted batch failed writes last_status 'error'
//      WITHOUT moving last_success_at. /api/health treats an 'error' row as failing.
//
// HOW IT CHECKS
//   Source checks, then send-daily's REAL handler on the shared virtual-clock harness
//   (scripts/verify/_send-daily-harness.mjs). The store stub gets a recording `rest` so the
//   no-advance heartbeat write is visible.
//
// RUN:    node scripts/verify/send-daily-v710.mjs
// EXPECT: prints "SEND-DAILY V710 OK" and exits 0.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_send-daily-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WALL = setTimeout(() => { console.log('FAIL: send-daily-v710 wall clock (90s) — something hung'); process.exit(1); }, 90000);
let failed = 0, passed = 0;
const ok = (c, m) => { if (c) passed++; else { failed++; console.log('FAIL: ' + m); } };

const H = createHarness(ROOT);
const src = H.sdSrc;
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');   // comments out

// ── source ──
ok(!/VERCEL_URL/.test(code), 'VERCEL_URL is still read in code (it must never be the generate host)');
ok(/PUBLIC_APP_FALLBACK\s*=\s*'https:\/\/contentshrimp\.com'/.test(code), 'the fallback host is not https://contentshrimp.com');
ok(/const host = publicAppUrl\(\)/.test(code), 'the generate host does not come from publicAppUrl()');
ok(/u\.protocol === 'https:'/.test(code), 'PUBLIC_APP_URL is not limited to https');

// ── the store stub gets a recording rest (send-daily holds the same exports object) ──
const store = H.require_(path.join(H.API, '_publish', 'store.js'));
let restCalls = [];
store.rest = async (method, p, opts) => { restCalls.push({ method, path: p, opts }); return { status: 201, data: null }; };

const errs = [];
async function run(o, env) {
  restCalls = []; errs.length = 0;
  if (env && env.PUBLIC_APP_URL != null) process.env.PUBLIC_APP_URL = env.PUBLIC_APP_URL; else delete process.env.PUBLIC_APP_URL;
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = () => {}; console.warn = () => {}; console.error = (...a) => { errs.push(a.map(String).join(' ')); };
  try { const r = await H.run(Object.assign({ verbose: true }, o)); r.rest = restCalls.slice(); r.errs = errs.slice(); return r; }
  finally { Object.assign(console, saved); }
}
const genReqs = (r) => r.reqs.filter(q => q.path === '/api/generate-ideas');
const errBeat = (r) => r.rest.filter(c => c.method === 'POST' && c.path === '/job_heartbeats');
const HTML401 = { status: 401, body: '<!doctype html><html><head><title>Authentication Required</title></head><body>Vercel</body></html>' };

// 1. no PUBLIC_APP_URL (VERCEL_URL=app.test is set by the harness) → contentshrimp.com, never app.test
{
  const r = await run({});
  const g = genReqs(r);
  ok(g.length === 1 && g[0].host === 'contentshrimp.com', 'without PUBLIC_APP_URL the batch goes to contentshrimp.com: ' + JSON.stringify(g.map(q => q.host)));
  ok(!r.reqs.some(q => q.host === 'app.test'), 'VERCEL_URL (app.test) was called');
}
// 2. PUBLIC_APP_URL trimmed, trailing slash dropped
{
  const r = await run({}, { PUBLIC_APP_URL: '  https://app.test/  ' });
  const g = genReqs(r);
  ok(g.length === 1 && g[0].host === 'app.test' && g[0].path === '/api/generate-ideas', 'PUBLIC_APP_URL (trimmed, slash dropped) is the host: ' + JSON.stringify(g.map(q => q.host + q.path)));
  ok(r.inserts.length === 1 && r.heartbeats.length === 1 && r.heartbeats[0].status === 'ok', 'a good batch is saved and the heartbeat is ok');
  const d = r.heartbeats[0] && r.heartbeats[0].detail;
  ok(d && d.gen && d.gen.attempted === 1 && d.gen.ok === 1 && d.gen.failed === 0, 'detail.gen counts a good batch: ' + JSON.stringify(d && d.gen));
  ok(errBeat(r).length === 0, 'a healthy run does not write the error heartbeat');
}
// 3. a plain-http PUBLIC_APP_URL is refused → fallback
{
  const r = await run({}, { PUBLIC_APP_URL: 'http://app.test' });
  ok(genReqs(r).every(q => q.host === 'contentshrimp.com') && genReqs(r).length === 1, 'an http:// PUBLIC_APP_URL falls back to contentshrimp.com');
}
// 4. a 401 HTML login page → failure, counted, logged with its status, heartbeat 'error', last_success_at untouched
{
  const r = await run({ gen: () => HTML401 }, { PUBLIC_APP_URL: 'https://app.test' });
  ok(r.res.statusCode === 200, 'the run still answers 200');
  ok(r.heartbeats.length === 0, 'an all-failed run must not use store.heartbeat (it moves last_success_at)');
  const b = errBeat(r);
  const body = b[0] && b[0].opts && b[0].opts.body;
  ok(b.length === 1 && body && body.job === 'send-daily' && body.last_status === 'error', 'an all-failed run writes last_status error for job send-daily: ' + JSON.stringify(body));
  ok(body && !('last_success_at' in body), 'the error heartbeat must not carry last_success_at');
  ok(b[0] && /merge-duplicates/.test((b[0].opts.headers || {}).Prefer || ''), 'the error heartbeat is the same upsert (merge-duplicates)');
  const g = body && body.detail && body.detail.gen;
  ok(g && g.attempted === 1 && g.ok === 0 && g.failed === 1 && g.outage === 1 && g.statuses && g.statuses['401'] === 1, 'detail.gen counts the 401 as an outage: ' + JSON.stringify(g));
  ok(body && body.detail && body.detail.sent === 1, 'the rest of the detail is still there');
  ok(r.errs.some(e => /generate-ideas FAILED/.test(e) && /status 401/.test(e)), 'a console.error names the 401');
  ok(r.inserts.length === 0, 'nothing saved from a failed batch');
  ok(r.pushes.length === 1 && !/new idea/.test(r.pushes[0].payload.title), 'the plain push still goes out: ' + JSON.stringify(r.pushes.map(p => p.payload.title)));
}
// 5a. OUTAGE signals: every batch like this → the run is 'error'
for (const [name, ans, key] of [
  ['200 HTML page', { status: 200, body: '<html><body>Sign in</body></html>' }, '200'],
  ['200 not JSON', { status: 200, body: 'upstream hiccup' }, '200'],
  ['401 JSON', { status: 401, body: { error: 'Please sign in again.' } }, '401'],
  ['403 JSON', { status: 403, body: { error: 'Forbidden' } }, '403'],
  ['500 JSON', { status: 500, body: { error: 'Failed to parse AI response' } }, '500'],
  ['503 AI unavailable', { status: 503, body: { error: 'AI_UNAVAILABLE' } }, '503'],
]) {
  const r = await run({ gen: () => ans }, { PUBLIC_APP_URL: 'https://app.test' });
  const body = errBeat(r)[0] && errBeat(r)[0].opts.body;
  ok(r.heartbeats.length === 0 && body && body.last_status === 'error' && body.detail.gen.failed === 1 && body.detail.gen.outage === 1 && body.detail.gen.statuses[key] === 1,
    name + ' is an outage → error run: ' + JSON.stringify(body && body.detail.gen));
}
// 5b. ordinary per-brand answers: counted as failed, NOT an outage, the run stays 'ok'
for (const [name, ans, key] of [
  ['502 came back empty', { status: 502, body: { error: 'That came back empty — try again' } }, '502'],
  ['400 bad_input', { status: 400, body: { error: 'Unknown post type.', code: 'bad_input' } }, '400'],
  ['424 brand_context_unavailable', { status: 424, body: { error: 'brand_context_unavailable' } }, '424'],
  ['424 stale_brand_row', { status: 424, body: { error: 'stale_brand_row' } }, '424'],
  ['200 JSON without ideas', { status: 200, body: { warnings: [] } }, '200'],
]) {
  const r = await run({ gen: () => ans }, { PUBLIC_APP_URL: 'https://app.test' });
  const g = r.heartbeats[0] && r.heartbeats[0].detail.gen;
  ok(errBeat(r).length === 0 && r.heartbeats.length === 1 && r.heartbeats[0].status === 'ok' && g && g.failed === 1 && g.outage === 0 && g.statuses[key] === 1,
    name + ' is counted but does not turn the run red: ' + JSON.stringify({ hb: r.heartbeats.map(h => h.status), err: errBeat(r).length, g }));
  ok(r.inserts.length === 0 && r.pushes.length === 1, name + ': nothing saved, plain push sent');
}
// 5c. every batch timed out → outage → 'error'
{
  const r = await run({ gen: () => ({ status: 200, body: { ideas: [] }, ms: 10000000 }) }, { PUBLIC_APP_URL: 'https://app.test' });
  const body = errBeat(r)[0] && errBeat(r)[0].opts.body;
  ok(r.heartbeats.length === 0 && body && body.last_status === 'error' && body.detail.gen.outage === 1 && body.detail.gen.timedOut === 1 && body.detail.gen.failed === 0,
    'an all-timed-out run is an error run: ' + JSON.stringify(body && body.detail.gen));
}
// 5d. one timeout + one ordinary 400 → not every batch is an outage → 'ok'
{
  const subs = [H.mkSub(1), H.mkSub(2)];
  const r = await run({ subs, gen: (rq) => rq.body.forBrandId === 'B1' ? { status: 200, body: { ideas: [] }, ms: 10000000 } : { status: 400, body: { error: 'x', code: 'bad_input' } } },
    { PUBLIC_APP_URL: 'https://app.test' });
  const g = r.heartbeats[0] && r.heartbeats[0].detail.gen;
  ok(errBeat(r).length === 0 && r.heartbeats.length === 1 && g && g.attempted === 2 && g.outage === 1 && g.failed === 1, 'timeout + 400 is not an error run: ' + JSON.stringify(g));
}
// 6. one brand fails, one succeeds → not all failed: store.heartbeat 'ok' with the counts
{
  const subs = [H.mkSub(1), H.mkSub(2)];
  const r = await run({ subs, gen: (rq) => rq.body.forBrandId === 'B1' ? HTML401 : { status: 200, body: H.genOf(rq.body, 'Idea') } }, { PUBLIC_APP_URL: 'https://app.test' });
  ok(errBeat(r).length === 0 && r.heartbeats.length === 1 && r.heartbeats[0].status === 'ok', 'one failure out of two is not an error run: ' + JSON.stringify(r.heartbeats.map(h => h.status)));
  const g = r.heartbeats[0] && r.heartbeats[0].detail.gen;
  ok(g && g.attempted === 2 && g.ok === 1 && g.failed === 1 && g.statuses['401'] === 1, 'mixed run counts: ' + JSON.stringify(g));
}
// 7. a 402 limit_reached is an answer, not an outage
{
  const r = await run({ gen: () => ({ status: 402, body: { error: 'limit_reached', plan: 'free', used: 3, limit: 3 } }) }, { PUBLIC_APP_URL: 'https://app.test' });
  ok(errBeat(r).length === 0 && r.heartbeats.length === 1 && r.heartbeats[0].status === 'ok', 'a 402 limit_reached does not turn the run red');
  ok(r.heartbeats[0] && r.heartbeats[0].detail.overLimit === 1 && r.heartbeats[0].detail.gen.failed === 0, 'the 402 is still counted as over-limit, not failed');
}
// 8. nothing attempted (7 already waiting) → ok, attempted 0
{
  const r = await run({ rows: H.pendingRows(7) }, { PUBLIC_APP_URL: 'https://app.test' });
  ok(genReqs(r).length === 0 && errBeat(r).length === 0 && r.heartbeats.length === 1 && r.heartbeats[0].status === 'ok' && r.heartbeats[0].detail.gen.attempted === 0,
    'no batch attempted → ok, attempted 0');
}

delete process.env.PUBLIC_APP_URL;
clearTimeout(WALL);
if (failed) { console.log('send-daily-v710: ' + failed + ' failed, ' + passed + ' passed'); process.exit(1); }
console.log('SEND-DAILY V710 OK — ' + passed + ' checks: generate host is PUBLIC_APP_URL or contentshrimp.com (never VERCEL_URL); failed batches counted + logged; all-failed run = error heartbeat without moving last_success_at');
