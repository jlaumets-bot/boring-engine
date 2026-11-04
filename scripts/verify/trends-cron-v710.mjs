#!/usr/bin/env node
// GATE: the nightly trends cron pays only for brands someone actually uses, most recently active first.
//
// WHY THIS EXISTS
//   deep-audit F-money #3. api/pull-trends-cron.js ran a paid Grok web search + Apify tweet run (+ a
//   weekly competitor-pulse search) every night for EVERY stale brand — abandoned, test and free brands
//   included — oldest first, 30 a run. Past 30 brands the dead ones took the slots of live ones.
//   v710 applies api/fact-pack.js's activity rule (lastActivityAt + INACTIVE_MS = 14 days) before
//   any money is spent, and orders the rest by most recent activity.
//
// HOW IT CHECKS
//   RUNS the real handler with store and trend lanes stubbed (no network, no AI). Every provider
//   call goes through the stubbed pullAllTrends, so "no call" is observed, not inferred.
//
// RUN:    node scripts/verify/trends-cron-v710.mjs
// EXPECT: prints "PASS" and exits 0.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const wall = setTimeout(() => { console.error('FAIL: wall clock — trends-cron-v710 did not finish in 60s'); process.exit(1); }, 60000);
wall.unref();

let failed = 0;
const ok = (c, m) => { if (c) console.log('ok: ' + m); else { console.error('FAIL: ' + m); failed++; } };
process.env.CRON_SECRET = 'test-only-cron-secret';
delete process.env.XAI_API_KEY;          // the competitor pulse is not under test here
delete process.env.APIFY_API_TOKEN;

const DAY = 24 * 3600 * 1000;
const iso = (agoMs) => new Date(Date.now() - agoMs).toISOString();
const put = (rel, exp) => { const k = require_.resolve(path.join(ROOT, rel)); require_.cache[k] = { id: k, filename: k, loaded: true, exports: exp }; };

// spec: id -> { ideas, usage, unreadable, fresh }
async function runCron(spec) {
  const beats = [], providerCalls = [], logs = [], errs = [];
  const brands = Object.keys(spec).map((id) => ({ id, brand_name: 'Brand ' + id, communities: ['niche ' + id],
    auto_trends: spec[id].fresh ? { at: Date.now() - 3600 * 1000, items: [] } : null }));
  const idOf = (p) => decodeURIComponent((/brand_id=eq\.([^&]+)/.exec(p) || [])[1] || '');
  put('api/_publish/store.js', {
    setRequestBudget: () => 20000,
    rest: async (m, p) => {
      if (m === 'GET' && p.startsWith('/brands?select=')) return { status: 200, data: brands };
      if (m === 'PATCH') return { status: 204, data: null };
      if (m === 'GET' && p.startsWith('/ideas?select=title')) return { status: 200, data: [] };   // preference read
      const s = spec[idOf(p)] || {};
      if (s.unreadable) return { status: 503, data: null, raw: 'upstream down' };
      if (m === 'GET' && p.startsWith('/ideas?')) return { status: 200, data: s.ideas || [] };
      if (m === 'GET' && p.startsWith('/usage_events?')) return { status: 200, data: s.usage || [] };
      return { status: 200, data: [] };
    },
    heartbeat: async (job, status, meta) => { beats.push({ job, status, meta }); },
  });
  put('api/_trends.js', {
    pullAllTrends: async (kws, tok, win, xMs, b) => {
      providerCalls.push(b.id);
      const arr = [{ text: 'trend for ' + b.id, source: 'news', link: 'https://n/1', ts: 1 }];
      arr.lanes = { grok: 0, news: 1, x: 0 };
      return arr;
    },
    scoreTrends: (items) => items.map(it => Object.assign({ hot: false }, it)),
    pullCompetitorPulse: async () => { providerCalls.push('pulse'); return ''; },
  });
  const cronKey = require_.resolve(path.join(ROOT, 'api', 'pull-trends-cron.js'));
  delete require_.cache[cronKey];
  const handler = require_(cronKey);
  const res = { _code: 0, _body: null, setHeader() {}, status(c) { this._code = c; return this; }, json(b) { this._body = b; return this; } };
  const ol = console.log, oe = console.error;
  console.log = (...a) => logs.push(a.join(' ')); console.error = (...a) => errs.push(a.join(' '));
  try { await handler({ method: 'GET', headers: { authorization: 'Bearer test-only-cron-secret' }, query: {} }, res); }
  finally { console.log = ol; console.error = oe; }
  return { res, beat: beats[0], beats, providerCalls, logs, errs };
}

const used = (agoMs) => ({ usage: [{ created_at: iso(agoMs), action: 'write' }] });

// ── ARM 1: inactive brands cost nothing, active ones are pulled, most recent first ──
{
  const r = await runCron({
    OLD:    used(3 * DAY),                         // active, least recent
    DEAD:   used(30 * DAY),                        // inactive 30 days
    NEVER:  {},                                    // never did anything
    ROBOT:  { ideas: [{ created_at: iso(DAY), status: 'pending', gen_flow: 'daily' }],      // only the daily cron's own rows
              usage: [{ created_at: iso(DAY), action: 'ideas' }] },
    NEWEST: { ideas: [{ created_at: iso(2 * 3600 * 1000), status: 'filming', gen_flow: 'daily' }] }, // a person acted on it
    MID:    used(1 * DAY),
    BLIND:  { unreadable: true },                  // activity cannot be read
    FRESH:  Object.assign({ fresh: true }, used(3600 * 1000)), // refreshed an hour ago: not due
  });
  const calls = r.providerCalls;
  for (const id of ['DEAD', 'NEVER', 'ROBOT', 'BLIND', 'FRESH'])
    ok(!calls.includes(id), id + ' makes no provider call — calls were ' + JSON.stringify(calls));
  for (const id of ['NEWEST', 'MID', 'OLD'])
    ok(calls.includes(id), id + ' (active) is pulled');
  ok(JSON.stringify(calls) === JSON.stringify(['NEWEST', 'MID', 'OLD']),
     'most recently active first: NEWEST, MID, OLD — got ' + JSON.stringify(calls));
  ok(r.beat && r.beat.job === 'pull-trends-cron' && r.beat.status === 'ok' && r.beat.meta.updated === 3,
     'heartbeat still written, ok, updated 3 — got ' + JSON.stringify(r.beat));
  ok(r.beat && r.beat.meta.skipInactive === 3 && r.beat.meta.skipActivityUnknown === 1 && r.beat.meta.total === 8,
     'heartbeat meta counts 3 inactive, 1 unknown, 8 total — got ' + JSON.stringify(r.beat && r.beat.meta));
  const line = r.logs.find(l => /brands total=/.test(l)) || '';
  ok(/brands total=8, skipped as inactive=3\b/.test(line) && /processed=3$/.test(line),
     'one summary line: total 8, inactive 3, processed 3 — got ' + JSON.stringify(line));
  ok(r.logs.filter(l => /brands total=/.test(l)).length === 1, 'exactly one summary line per run');
}

// ── ARM 2: past CAP, dead brands no longer take paying brands' slots ──
{
  const spec = {};
  for (let i = 0; i < 31; i++) spec['A' + String(i).padStart(2, '0')] = used((i + 1) * 3600 * 1000);  // A00 newest ... A30 oldest
  for (let i = 0; i < 10; i++) spec['Z' + i] = used(60 * DAY);
  const r = await runCron(spec);
  ok(r.providerCalls.length === 30 && r.providerCalls.every(id => id.startsWith('A')),
     '30 slots, all to active brands — got ' + r.providerCalls.length + ' calls, dead ones: ' + r.providerCalls.filter(id => !id.startsWith('A')).length);
  ok(!r.providerCalls.includes('A30'), 'the least recently active brand is the one left for the next night');
  ok(r.providerCalls[0] === 'A00' && r.providerCalls[29] === 'A29', 'and the order is newest activity first');
}

// ── ARM 3: every activity read failing is a broken read, not "nobody is active" ──
{
  const r = await runCron({ X: { unreadable: true }, Y: { unreadable: true } });
  ok(r.providerCalls.length === 0, 'no provider call when activity cannot be read');
  ok(r.res._code === 500 && r.beats.length === 0,
     'answers 500 with NO heartbeat (same as a failed brands read) — got ' + r.res._code + ', beats=' + r.beats.length);
}

// ── ARM 4 (opposite): only fresh brands -> nothing due, no reads, ordinary ok run ──
{
  const r = await runCron({ F1: Object.assign({ fresh: true }, used(DAY)) });
  ok(r.providerCalls.length === 0 && r.res._code === 200 && r.beat && r.beat.status === 'ok',
     'nothing due is an ordinary ok run — got ' + r.res._code + ' ' + JSON.stringify(r.beat && r.beat.status));
}

clearTimeout(wall);
if (failed) { console.error('\n' + failed + ' failure(s)'); process.exit(1); }
console.log('\nPASS — trends-cron-v710: inactive brands cost nothing, active brands go most-recent first.');
process.exit(0);
