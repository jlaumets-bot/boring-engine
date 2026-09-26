#!/usr/bin/env node
// GATE: the trends cron counts an abandoned batch once, and still raises the all-silent alarm.
//
// WHY THIS EXISTS
//   v690 review, leaf-2 F4 (K3). When a batch outlived the run budget, api/pull-trends-cron.js
//   added EVERY brand from that index on to `untried` — including brands of the same batch that
//   had already finished and been counted as updated / no-items / failed. `_triedBrands` then
//   subtracted them a second time. Concrete: two brands due, one comes back with nothing from any
//   source, the other hangs until the budget race abandons the batch — _triedBrands = 0, the
//   "every source silent" alarm cannot fire, the heartbeat says 'ok' with updated 0 (so
//   /api/health stays green), and the log says "2 not attempted at all" about brands that ran.
//
// HOW IT CHECKS
//   It RUNS the real handler with its store and trend lanes stubbed (no network) and the run's
//   long timers shrunk 1000x, and reads the heartbeat it writes. Arms: the failure above must
//   heartbeat 'error' and count 1 abandoned / 0 untried; the opposite arms — a healthy run stays
//   'ok', and a run where every brand really was silent (no abandonment) still says 'error'.
//
// RUN:    node scripts/verify/rv-backend-2.mjs
// EXPECT: prints "PASS" and exits 0.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const realSetTimeout = global.setTimeout;
const wall = realSetTimeout(() => { console.error('FAIL: wall clock — rv-backend-2 did not finish in 60s'); process.exit(1); }, 60000);
wall.unref();

let failed = 0;
const ok = (c, m) => { if (c) console.log('ok: ' + m); else { console.error('FAIL: ' + m); failed++; } };
process.env.CRON_SECRET = 'test-only-cron-secret';
delete process.env.XAI_API_KEY;           // no competitor pulse leg
delete process.env.APIFY_API_TOKEN;

const put = (rel, exp) => { const k = require_.resolve(path.join(ROOT, rel)); require_.cache[k] = { id: k, filename: k, loaded: true, exports: exp }; };

// plan: brandId -> 'items' | 'empty' | 'hang'
async function runCron(plan) {
  const beats = []; const patches = [];
  const brands = Object.keys(plan).map((id, n) => ({ id, brand_name: 'Brand ' + id, communities: ['coffee lovers ' + n], auto_trends: null }));
  put('api/_publish/store.js', {
    setRequestBudget: () => 20000,
    rest: async (m, p) => {
      if (m === 'GET' && p.startsWith('/brands?select=')) return { status: 200, data: brands };
      if (m === 'GET' && p.startsWith('/ideas?')) return { status: 200, data: [] };
      if (m === 'PATCH') { patches.push(p); return { status: 204, data: null }; }
      return { status: 200, data: [] };
    },
    heartbeat: async (job, status, meta) => { beats.push({ job, status, meta }); },
  });
  put('api/_trends.js', {
    pullAllTrends: (kws, tok, win, xMs, b) => {
      const what = plan[b.id];
      if (what === 'hang') return new Promise(() => {});
      const arr = what === 'items' ? [{ text: 'a real trend for ' + b.id, source: 'news', link: 'https://n/1', ts: 1 }] : [];
      arr.lanes = { grok: 0, news: arr.length, x: 0 };
      return Promise.resolve(arr);
    },
    scoreTrends: (items) => items.map(it => Object.assign({ hot: false }, it)),
    pullCompetitorPulse: async () => '',
  });
  const cronKey = require_.resolve(path.join(ROOT, 'api', 'pull-trends-cron.js'));
  delete require_.cache[cronKey];
  const handler = require_(cronKey);
  // shrink only the run's long budget timers (the 270s race); short ones run as written
  global.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms >= 4000 ? ms / 1000 : ms, ...a);
  const res = { _code: 0, _body: null, setHeader() {}, status(c) { this._code = c; return this; }, json(b) { this._body = b; return this; } };
  try { await handler({ method: 'GET', headers: { authorization: 'Bearer test-only-cron-secret' }, query: {} }, res); }
  finally { global.setTimeout = realSetTimeout; }
  return { res, beat: beats[0], patches };
}

// ── ARM 1: one brand silent, one hung past the budget → 'error', counted once ──
{
  const { res, beat } = await runCron({ A: 'empty', B: 'hang' });
  ok(beat && beat.job === 'pull-trends-cron', 'the run still wrote its heartbeat');
  ok(beat && beat.meta.ranOut === true, 'the hung brand made the batch outlive the budget (ranOut)');
  ok(beat && beat.status === 'error',
     'a run where the only brand that finished got NOTHING from any source, and the other was cut off, heartbeats error — got ' +
     JSON.stringify(beat && beat.status) + ' meta=' + JSON.stringify(beat && beat.meta));
  ok(beat && beat.meta.allSilent === true && res._body && res._body.ok === false, 'and reports allSilent / ok:false');
  ok(beat && beat.meta.untried === 0 && beat.meta.abandoned === 1,
     'the tail is split honestly: 0 never tried, 1 cut off mid-run — got untried=' + (beat && beat.meta.untried) + ' abandoned=' + (beat && beat.meta.abandoned));
  ok(beat && beat.meta.skipped === 2 && beat.meta.skipNoItems === 1, 'skipped counts each brand once (2 = 1 silent + 1 cut off) — got ' + (beat && beat.meta.skipped));
}
// ── ARM 2 (opposite): a healthy run stays 'ok' ──
{
  const { beat, patches } = await runCron({ A: 'items', B: 'items', C: 'items' });
  ok(beat && beat.status === 'ok' && beat.meta.updated === 3 && patches.length === 3 && beat.meta.ranOut === false,
     'a run where every brand got trends heartbeats ok with updated 3 — got ' + JSON.stringify(beat && beat.meta));
}
// ── ARM 3 (opposite): all silent without any abandonment is still an error ──
{
  const { beat } = await runCron({ A: 'empty', B: 'empty', C: 'empty' });
  ok(beat && beat.status === 'error' && beat.meta.allSilent === true && beat.meta.untried === 0 && beat.meta.abandoned === 0,
     'three silent brands, no budget trouble: still error / allSilent — got ' + JSON.stringify(beat && beat.meta));
}
// ── ARM 4 (opposite): one real update among a cut-off batch is not "all silent" ──
{
  const { beat } = await runCron({ A: 'items', B: 'hang' });
  ok(beat && beat.status === 'ok' && beat.meta.updated === 1 && beat.meta.allSilent === false && beat.meta.abandoned === 1,
     'a brand that DID update keeps the run ok even when its batch-mate was cut off — got ' + JSON.stringify(beat && beat.meta));
}

// ── ARM 5 (round 2): a LATER batch is cut off (CONC=2: [A,B] finish, then [C,D] with D hung) ──
// The first-round arms cannot see a counter that is declared once per RUN instead of per batch:
// in batch 2 it would still hold batch 1's finishes, and abandoned/skipped go wrong (even negative).
{
  const { beat } = await runCron({ A: 'items', B: 'items', C: 'empty', D: 'hang' });
  const m = (beat && beat.meta) || {};
  ok(beat && beat.status === 'ok' && m.ranOut === true && m.updated === 2 && m.allSilent === false,
     'two brands updated in batch 1, batch 2 cut off: the run is ok and not all-silent — got ' + JSON.stringify(m));
  ok(m.abandoned === 1 && m.untried === 0, 'only D is abandoned and nothing is untried — got abandoned=' + m.abandoned + ' untried=' + m.untried);
  ok(m.skipped === 2 && m.skipNoItems === 1, 'skipped = C (no items) + D (cut off) = 2 — got ' + m.skipped);
}
// ── ARM 6 (round 2): a later batch cut off with a batch still to come → that one is UNTRIED ──
{
  const { beat } = await runCron({ A: 'empty', B: 'empty', C: 'hang', D: 'empty', E: 'items' });
  const m = (beat && beat.meta) || {};
  ok(m.abandoned === 1 && m.untried === 1 && m.skipNoItems === 3 && m.skipped === 5 && m.updated === 0,
     'batch 2 [C,D] with C hung, batch 3 [E] never started: abandoned 1, untried 1, skipped 5 (A,B,D no items + C + E) — got ' + JSON.stringify(m));
  ok(beat && beat.status === 'error' && m.allSilent === true,
     'the three brands that reached a verdict all got nothing: still the all-silent error — got ' + JSON.stringify(beat && beat.status));
}

clearTimeout(wall);
if (failed) { console.error('\n' + failed + ' failure(s)'); process.exit(1); }
console.log('\nPASS — rv-backend-2: an abandoned trends batch is counted once, and a silent run cannot hide behind it.');
process.exit(0);
