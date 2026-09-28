#!/usr/bin/env node
// GATE fix7-server — the morning push fills Ideas with a SAVED batch, one per brand, for everyone
// due in the hour; it never charges an inactive user every day or a brand twice; and /api/write's
// hashtags come only from the brand's own words.
//
// WHY THIS EXISTS (.unlazy/fix7/PLAN.md items 1 and 6, server half; rounds 2 and 3)
//   1. The owner wants the Ideas flow: several ideas waiting each morning to approve or reject.
//      send-daily tops the brand's pending ideas up to DAILY_TARGET (7): enough waiting → nothing
//      generated, nothing charged, "You have N ideas waiting"; otherwise ONE generate call (one
//      'ideas' credit, like "Plan my week"), saved as pending for the VERIFIED brand, and
//      "N new ideas ready — pick today's post" opens /app.html?open=ideas&b=<brandId>.
//   2. Review (HIGH): the cron's own rows made every user look active forever → a paid batch every
//      day. Rows made here carry gen_flow='daily'; still-pending ones do not count as activity.
//   3. Review (HIGH): model/script-built hashtags could flip a denial into a claim (#cureinsomnia).
//      Hashtags now come ONLY from the brand's own Content Themes / day themes and its name.
//   4. Review r3 (HIGH): subscribers ran one after another, so with ~60s batches only ~2 of 6 people
//      due in the same hour got a push. Units (one per brand) now run CONCURRENCY at a time.
//   5. Review r3 (MEDIUM): two devices on one brand each paid for a batch, and a batch that hit the
//      cap was billed with nothing saved — then retried (and billed) by the next hourly run. Now one
//      generation per brand per run, a 200s cap, and a timed-out brand is paused for 20h.
//
// HOW IT CHECKS
//   send-daily's REAL handler runs end to end on a VIRTUAL CLOCK (scripts/verify/_send-daily-harness.mjs):
//   only https, web-push, the store and the brand loader are stubbed, and "a batch takes 190s" costs
//   no wall time. Rows are compared key-for-key with app.html's _buildIdeaRows. runWrite runs for real
//   with callLLM stubbed.
//
// RUN:    node scripts/verify/fix7-server.mjs
// EXPECT: prints "FIX7 SERVER OK" and exits 0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_send-daily-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WALL = setTimeout(() => { console.log('FAIL: fix7-server wall clock (90s) — something hung'); process.exit(1); }, 90000);
let failed = 0, passed = 0;
const ok = (c, m) => { if (c) passed++; else { failed++; console.log('FAIL: ' + m); } };

const H = createHarness(ROOT);
const { run, sdSrc, stub, require_, API, NOW, WK, ago, SUB, mkSub, mkIdea, ACTIVE, pendingRows } = H;
const TODAY = WK[NOW.getUTCDay()];
const IDEAS_URL = '/app.html?open=ideas&b=B-OK';
const pl = (r, k) => (r.pushes[k || 0] || {}).payload || {};
const num = (n) => Number((sdSrc.match(new RegExp('const ' + n + '\\s*=\\s*(\\d+)')) || [])[1]);

// ── the app's row shape, read from app.html (never restated here) ─────────────
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const bAt = html.indexOf('\nfunction _buildIdeaRows(');
const bSeg = html.slice(bAt, html.indexOf('\n}', bAt));
const mapSeg = bSeg.slice(bSeg.indexOf('.map(idea => ({'), bSeg.indexOf('}));'));
const APP_KEYS = [...mapSeg.matchAll(/^\s{4}([a-z_]+):/gm)].map(m => m[1]);
const APP_OPTIONAL = [...mapSeg.matchAll(/\.\.\.\(idea\.\w+ \? \{ ([a-z_]+):/g)].map(m => m[1]);
ok(bAt > 0 && APP_KEYS.length >= 18 && APP_KEYS.includes('brand_id') && APP_OPTIONAL.includes('gen_flow'),
  'read the app row shape from app.html _buildIdeaRows (' + APP_KEYS.length + ' keys + optional ' + APP_OPTIONAL.join(',') + ')');

// 1. active user, nothing waiting: ONE generate call, all saved, one push
{
  const r = await run({ rows: ACTIVE.concat([{ created_at: ago(3), status: 'filming', title: 'IDEA 2', format: 'video', day: 'Friday' }]), prefix: 'Idea' ,
    gen: (rq) => ({ status: 200, body: { ideas: rq.body.gaps.map((g, k) => mkIdea('Idea ' + (k + 1), g.day)) } }) });
  ok(r.res.statusCode === 200 && r.pushes.length === 1, 'the push went out');
  ok(r.gens.length === 1, 'exactly ONE generate call — one credit, like "Plan my week" (got ' + r.gens.length + ')');
  const gb = (r.gens[0] || {}).body || {};
  ok(gb.count === 7 && Array.isArray(gb.gaps) && gb.gaps.length === 7 && gb.gaps[0].day === TODAY && gb.gaps[6].day === WK[(NOW.getUTCDay() + 6) % 7],
    'asks for 7 - 0 pending = 7 ideas, one gap per day starting today (' + JSON.stringify((gb.gaps || []).map(g => g.day)) + ')');
  ok(gb.forBrandId === 'B-OK' && gb.forUserId === 'U1' && (r.gens[0].headers || {}).Authorization === 'Bearer cron-test',
    'metered against the account: CRON caller + forUserId + the VERIFIED forBrandId');
  ok(/IDEAS THE USER LIKED[\s\S]*Shipped yesterday/.test(gb.learningContext) && /REJECTED[\s\S]*Nope idea[^\n]*too salesy/.test(gb.learningContext) &&
     /TITLES ALREADY IN THE LIBRARY[\s\S]*"IDEA 2"/.test(gb.learningContext), 'the learning context is rebuilt the way generateNewIdeas builds it');
  ok(/Monday: Founders/.test(gb.brandContext && gb.brandContext.communities) && /Tuesday = Posting less/.test(gb.brandContext && gb.brandContext.dayMap),
    'the day-theme strings the app adds are added here too');
  const cap = Number((r.gens[0] || {}).timeout);
  ok(cap === num('GEN_TIMEOUT_MS'), 'a healthy first-wave batch gets the full generate cap (' + cap + 'ms)');
  ok(r.inserts.length === 1, 'the batch is saved in ONE insert request');
  const ins = r.inserts[0] || { body: [], headers: {} };
  const rows = Array.isArray(ins.body) ? ins.body : [];
  ok(rows.length === 6, 'the title the library already has ("Idea 2" vs "IDEA 2") is skipped: 6 of 7 saved (' + rows.length + ')');
  ok(ins.host === 'sb.test' && ins.headers.Authorization === 'Bearer svc-test-key', 'the insert uses the SERVICE ROLE');
  ok(rows.every(x => x.brand_id === 'B-OK' && x.status === 'pending' && x.gen_flow === 'daily' && x.is_generated === true),
    'every row: the verified brand, pending, marked gen_flow=daily');
  const bad = rows.map(x => Object.keys(x)).map(k => APP_KEYS.filter(a => !k.includes(a)).concat(k.filter(a => !APP_KEYS.includes(a) && !APP_OPTIONAL.includes(a)))).flat();
  ok(rows.length && !bad.length, 'every row has the app\'s exact shape (' + bad.join(',') + ')');
  ok(rows.every(x => JSON.stringify(x.emphasis) === '["The fix is boring"]'), 'emphasis keeps only phrases found in the text');
  ok(Number(ins.timeout) > 0 && Number(ins.timeout) <= 8000, 'the insert carries its own short timeout (' + ins.timeout + 'ms)');
  const p = pl(r);
  ok(p.title === "6 new ideas ready — pick today's post" && p.url === IDEAS_URL, 'push: "6 new ideas ready — pick today\'s post" → ' + p.url);
  ok(!/open=idea&|[?&]t=/.test(p.url), 'the push never links to a single (possibly done/dismissed) row');
  ok(r.heartbeats[0].detail.ideaSaved === 6 && r.heartbeats[0].status === 'ok', 'heartbeat: ideaSaved 6');
  ok(JSON.stringify(Object.keys(r.res.body)) === JSON.stringify(['checked', 'due', 'sent', 'failed', 'skipped', 'stampFailed', 'ranOut']),
    'the HTTP response keeps its exact shape');
}
// 1b. dedupe inside one batch
{
  const r = await run({ gen: () => ({ status: 200, body: { ideas: [mkIdea('Same', TODAY), mkIdea(' same ', TODAY), mkIdea('Other', TODAY)] } }) });
  ok(r.inserts.length === 1 && r.inserts[0].body.map(x => x.title).join('|') === 'Same|Other', 'a duplicate inside the batch is skipped too');
}
// 2. some waiting: only the gap to 7 is asked for
{
  const r = await run({ rows: ACTIVE.concat(pendingRows(4)) });
  ok(r.gens.length === 1 && r.gens[0].body.count === 3, '4 waiting → asks for 3 (' + (r.gens[0] && r.gens[0].body.count) + ')');
}
// 3. enough waiting: nothing generated, nothing charged
{
  const r = await run({ rows: ACTIVE.concat(pendingRows(7)) });
  ok(r.gens.length === 0 && r.inserts.length === 0 && r.ctxCalls === 0, '7 waiting → NO generate call (no charge), no insert, no brand load');
  ok(pl(r).title === "You have 7 ideas waiting — pick today's post" && pl(r).url === IDEAS_URL, 'push: "You have 7 ideas waiting — pick today\'s post"');
  ok(r.heartbeats[0].detail.ideaWaiting === 1, 'counted as waiting');
}
// 4. insert failure never fails the push
for (const [label, ins] of [['a 500', () => ({ status: 500, body: { message: 'boom' } })], ['a timeout', () => 'hang']]) {
  const r = await run({ insert: ins });
  ok(r.pushes.length === 1 && r.res.body.sent === 1 && r.res.body.failed === 0, label + ' on the insert: the push is still sent and counted');
  ok(pl(r).title === 'Time to make something' && pl(r).url === '/app.html', label + ': nothing saved and nothing waiting → the plain push');
  ok(r.heartbeats[0].detail.ideaSaveFailed === 1, label + ': counted as ideaSaveFailed');
  const r2 = await run({ insert: ins, rows: ACTIVE.concat(pendingRows(2)) });
  ok(pl(r2).title === "You have 2 ideas waiting — pick today's post" && pl(r2).url === IDEAS_URL, label + ' with 2 already waiting → the waiting push');
}
// 5. databases without the optional columns
{
  const r = await run({ insert: (n, rq) => (rq.body[0] && 'gen_flow' in rq.body[0])
    ? { status: 400, body: { code: 'PGRST204', message: "Could not find the 'gen_flow' column of 'ideas' in the schema cache" } } : { status: 201, body: null } });
  ok(r.inserts.length === 2 && r.inserts[1].body.every(x => !('gen_flow' in x)) && pl(r).title.endsWith("new ideas ready — pick today's post"),
    'insert without gen_flow: retried once without the marker, still saved');
  const e = await run({ insert: (n, rq) => (rq.body[0] && 'emphasis' in rq.body[0])
    ? { status: 400, body: { code: 'PGRST204', message: "Could not find the 'emphasis' column of 'ideas' in the schema cache" } } : { status: 201, body: null } });
  ok(e.inserts.length === 2 && e.inserts[1].body.every(x => !('emphasis' in x)), 'insert without emphasis: retried once without it');
  const g = await run({ noGenFlowCol: true });
  const reads = g.reqs.filter(x => x.method === 'GET' && x.path.startsWith('/rest/v1/ideas'));
  ok(reads.length === 2 && !/gen_flow/.test(reads[1].path) && g.gens.length === 1 && g.res.body.failed === 0,
    'activity read on a database without gen_flow: repeated without it, the run still works');
}
// 6. over the plan limit (402): nothing inserted, plain push
{
  const r = await run({ gen: () => ({ status: 402, body: { error: 'limit_reached', plan: 'free', used: 5, limit: 5 } }) });
  ok(r.inserts.length === 0 && pl(r).title === 'Time to make something' && pl(r).url === '/app.html', 'over-limit: NOTHING inserted, the plain push');
  ok(r.heartbeats[0].detail.overLimit === 1, 'over-limit still counted');
}
// 7. no VERIFIED brand: nothing generated, nothing charged, nothing inserted
{
  const d = await run({ subs: [Object.assign({}, SUB, { brand_id: 'B-STRANGER' })] });
  ok(d.gens.length === 0 && d.inserts.length === 0, 'a brand the subscriber cannot access: no generation, no insert');
  const u = await run({ subs: [Object.assign({}, SUB, { motivation_on: false })], access: async () => { const e = new Error('db down'); e.accessCheckFailed = true; throw e; } });
  ok(u.gens.length === 0 && u.inserts.length === 0 && u.pushes.length === 1, 'an access check that could not run: no generation, no insert, push sent');
  const n = await run({ subs: [Object.assign({}, SUB, { brand_id: null, motivation_on: false })] });
  ok(n.gens.length === 0 && n.inserts.length === 0 && pl(n).url === '/app.html', 'no brand at all: no generation');
  ok(/saveDailyBatch\(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, brandId,/.test(sdSrc) && !/saveDailyBatch\([^)]*sub\.brand_id/.test(sdSrc),
    'the save is handed the verified brandId, never sub.brand_id');
}
// 8. the "gone quiet" check ignores the cron's own still-pending rows
{
  const rows = [{ created_at: ago(4), status: 'done', title: 'Mine' }].concat(pendingRows(3, { gen_flow: 'daily', created_at: ago(0.1) }));
  const r = await run({ rows });
  ok(r.gens.length === 0 && !/ideas ready|waiting/.test(pl(r).title), 'fresh cron-made rows do NOT make a 4-day-quiet user look active (push: ' + pl(r).title + ')');
  const acted = [{ created_at: ago(0.1), status: 'dismissed', title: 'Daily one they rejected', gen_flow: 'daily' }, { created_at: ago(9), status: 'done', title: 'Old' }];
  ok((await run({ rows: acted })).gens.length === 1, 'a cron-made row the user ACTED on (dismissed) does count as activity');
}
// 9. SIX-DAY SIMULATION — an inactive user is charged at most once (with the marker and without it)
async function simulate(noGenFlowCol, userActs) {
  const table = [{ day: -1, status: 'done', title: 'Last thing they made' }];
  const log = [];
  let charges = 0;
  for (let d = 0; d < 6; d++) {
    if (userActs && d > 0) table.filter(x => x.status === 'pending').slice(0, 2).forEach(x => { x.status = 'filming'; x.day = d - 0.5; });
    const rows = table.map(x => ({ created_at: ago(d - x.day), status: x.status, title: x.title, gen_flow: x.gen_flow }));
    const r = await run({ rows, noGenFlowCol, prefix: 'Day ' + d + ' idea' });
    charges += r.gens.length;
    for (const ins of r.inserts) for (const row of ins.body) table.push({ day: d, status: 'pending', title: row.title, gen_flow: row.gen_flow });
    log.push('d' + d + ':' + (r.gens.length ? 'batch' : '-'));
  }
  return { charges, log: log.join(' ') };
}
{
  const a = await simulate(false, false);
  ok(a.charges <= 1, 'inactive user, 6 days: at most ONE paid batch (' + a.charges + ') — ' + a.log);
  const b = await simulate(true, false);
  ok(b.charges <= 1, 'same, on a database WITHOUT gen_flow (the target rule alone): ' + b.charges + ' — ' + b.log);
  const c = await simulate(false, true);
  ok(c.charges >= 3, 'an ACTIVE user who approves ideas keeps getting new ones (' + c.charges + ' batches) — ' + c.log);
}

// ═════ fix7 r3 — units, concurrency, the generate cap, the timeout pause ═════
// 10. SIX people due in the same hour, six brands, batches of 60s — and of 190s (near the cap): all pushed
for (const genMs of [60000, 190000]) {
  const subs = Array.from({ length: 6 }, (_, k) => mkSub(k + 1));
  const r = await run({ subs, genMs });
  const got = new Set(r.pushes.map(x => x.sub.endpoint));
  ok(got.size === 6 && r.res.body.sent === 6 && r.res.body.skipped === 0, '6 same-hour users, ' + genMs / 1000 + 's batches: all 6 pushed (sent ' + r.res.body.sent + ', skipped ' + r.res.body.skipped + ')');
  ok(r.inserts.length === 6 && r.pushes.every(x => /new ideas ready/.test(x.payload.title)), '  … and every brand\'s batch was SAVED (' + r.inserts.length + ' inserts)');
  ok(r.heartbeats.length === 1 && r.heartbeats[0].at <= 290000 && r.heartbeats[0].status === 'ok', '  … heartbeat written at ' + r.heartbeats[0].at + 'ms (<= 290s)');
  const gensAt = r.gens.map(g => g.at);
  ok(Math.max(...gensAt) - Math.min(...gensAt) < 1000, '  … the six batches ran at the SAME time, not one after another');
}
// 11. more brands than one wave: 18 fit with 60s batches (three waves); 30 → the rest counted and said so
{
  const r = await run({ subs: Array.from({ length: 18 }, (_, k) => mkSub(k + 1)), genMs: 60000 });
  ok(r.res.body.sent === 18 && r.res.body.skipped === 0, '18 same-hour brands, 60s batches: all 18 pushed (' + r.res.body.sent + ')');
  const big = await run({ subs: Array.from({ length: 30 }, (_, k) => mkSub(k + 1)), genMs: 60000 });
  ok(big.res.body.sent + big.res.body.skipped === 30 && big.res.body.skipped > 0 && big.res.body.ranOut === true &&
     big.heartbeats[0].status === 'partial', '30 brands: ' + big.res.body.sent + ' pushed, ' + big.res.body.skipped + ' counted as skipped, run reported partial');
  ok(big.heartbeats[0].at <= 290000, '  … and the heartbeat is still written in time (' + big.heartbeats[0].at + 'ms)');
  const lateStart = Math.max(...big.gens.map(g => g.at));
  ok(lateStart <= num('RUN_BUDGET_MS') - num('MIN_SLICE_MS') + 60000, '  … no unit was started without its reserve');
}
// 12. ONE generation per brand: two devices and a teammate on one brand
{
  const subs = [Object.assign({}, SUB, { id: 'phone' }), Object.assign({}, SUB, { id: 'laptop', subscription: { endpoint: 'https://push/e2' } }),
                Object.assign({}, SUB, { id: 'mate', user_id: 'U2', subscription: { endpoint: 'https://push/e3' } })];
  const r = await run({ subs });
  ok(r.gens.length === 1 && r.inserts.length === 1, 'three subscriptions on one brand → ONE generate call, ONE insert (' + r.gens.length + '/' + r.inserts.length + ')');
  ok(r.pushes.length === 3 && r.pushes.every(x => x.payload.title === "7 new ideas ready — pick today's post" && x.payload.url === IDEAS_URL),
    '  … and all three get the same "7 new ideas ready" push');
  const t = await run({ subs: subs.slice(0, 2), gen: () => 'hang' });
  ok(t.gens.length === 1, 'two devices, batch times out: still only ONE generate call (' + t.gens.length + ')');
  const mixed = await run({ subs: [subs[0], Object.assign({}, subs[2], { user_id: 'U-GONE' })],
    access: async (u, b) => u !== 'U-GONE' && b === 'B-OK' });
  ok(mixed.gens.length === 1 && mixed.pushes.length === 1 && mixed.gens[0].body.forUserId === 'U1' && mixed.heartbeats[0].detail.brandDenied === 1,
    'a removed teammate on the same brand: no push for them, the owner is billed and pushed');
}
// 13. the generate cap: a batch that never answers is cut at GEN_TIMEOUT_MS, recorded, paused 20h
{
  const r = await run({ gen: () => 'hang' });
  const hb = r.heartbeats[0].detail;
  ok(Number(r.gens[0].timeout) === num('GEN_TIMEOUT_MS') && r.inserts.length === 0 && pl(r).title === 'Time to make something',
    'a batch that never answers: cut at ' + r.gens[0].timeout + 'ms, nothing saved, the plain push');
  ok(hb.genTimedOut === 1 && hb.genTimeouts && hb.genTimeouts['B-OK'], 'recorded: genTimedOut 1 and the brand in genTimeouts');
  const next = await run({ hbDetail: hb });
  ok(next.gens.length === 0 && next.heartbeats[0].detail.genBlocked === 1 && next.heartbeats[0].detail.genTimeouts['B-OK'],
    'the next hourly run: NO second generate call for that brand (no second charge); the memory is carried forward');
  const old = await run({ hbDetail: { genTimeouts: { 'B-OK': new Date(Date.now() - 21 * 3600000).toISOString() } } });
  ok(old.gens.length === 1 && !(old.heartbeats[0].detail.genTimeouts || {})['B-OK'], 'after 20h the pause ends and the old entry is dropped');
  const other = await run({ hbDetail: hb, subs: [mkSub(5)] });
  ok(other.gens.length === 1, 'a timeout pauses only THAT brand');
  const unread = await run({ hbFail: true });
  ok(unread.gens.length === 1 && unread.heartbeats[0].detail.genTimeoutsRead === false, 'an unreadable memory is reported (genTimeoutsRead: false), not hidden');
}
// 14. too little time left for a batch: not started (no charge)
{
  // six first-wave batches take 126s; brand 7 then starts with ~144s left (just over MIN_SLICE_MS),
  // and its reads crawl (two ~20s activity reads on a database without gen_flow + a 20s brand load),
  // so it reaches its generate step with under MIN_GEN_MS left.
  const subs = Array.from({ length: 7 }, (_, k) => mkSub(k + 1));
  const slow = (b) => b === 'B7';
  const r = await run({ subs, genMs: 126000, dbMs: (b) => slow(b) ? 19900 : 5, noGenFlowCol: slow, ctxMs: (b) => slow(b) ? 19900 : 0 });
  const d = r.heartbeats[0].detail;
  ok(d.genNoTime === 1 && r.gens.length === 6 && !r.gens.some(g => g.body.forBrandId === 'B7'),
    'a unit left with < MIN_GEN_MS for its batch does NOT start it (no charge): genNoTime ' + d.genNoTime + ', generate calls ' + r.gens.length);
  ok(r.res.body.sent === 7 && r.pushes.some(x => x.sub.endpoint === 'https://push/e7' && x.payload.title === 'Time to make something'),
    '  … and that subscriber still gets the plain push');
  ok(r.gens.every(g => Number(g.timeout) >= num('MIN_GEN_MS')) && r.heartbeats[0].at <= 290000, '  … no call below the minimum; heartbeat at ' + r.heartbeats[0].at + 'ms');
}
// 15. nothing can hold the run past maxDuration: everything hangs
{
  const r = await run({ subs: Array.from({ length: 8 }, (_, k) => mkSub(k + 1)), access: () => new Promise(() => {}) });
  ok(r.heartbeats.length === 1 && r.heartbeats[0].at <= num('RUN_BUDGET_MS') + 1000 && r.res.statusCode === 200,
    'access checks that never answer: units abandoned at the budget, heartbeat at ' + r.heartbeats[0].at + 'ms, 200 returned');
  ok(r.res.body.skipped === 8 && r.heartbeats[0].status !== 'ok', '  … all 8 counted as not reached, run not reported ok');
}
// 16. the budget arithmetic (numbers from the file)
{
  const DB = num('DB_TIMEOUT_MS');
  const pre = 2 * DB /* access */ + 2 * DB /* activity + gen_flow retry */ + DB /* brand */;
  const post = num('INSERT_TIMEOUT_MS') + num('PUSH_TIMEOUT_MS') + DB;
  ok(num('MIN_SLICE_MS') >= pre + post, 'MIN_SLICE_MS (' + num('MIN_SLICE_MS') + ') covers a unit\'s worst case outside the batch (' + (pre + post) + ')');
  ok(num('RUN_BUDGET_MS') + 20000 <= 300000, 'RUN_BUDGET_MS + the heartbeat write fit maxDuration 300s');
  ok(3 * DB + num('MIN_SLICE_MS') <= num('RUN_BUDGET_MS'), 'the first wave always starts (start-up reads ' + 3 * DB + ' + ' + num('MIN_SLICE_MS') + ' <= ' + num('RUN_BUDGET_MS') + ')');
  ok(num('CONCURRENCY') >= 2 && num('CONCURRENCY') <= 10, 'bounded concurrency: ' + num('CONCURRENCY'));
  ok(num('GEN_TIMEOUT_MS') >= 186666 && num('GEN_TIMEOUT_MS') <= num('RUN_BUDGET_MS') - post,
    'the generate cap (' + num('GEN_TIMEOUT_MS') + ') covers generate-ideas\' main call + its retry (2 x 93.3s) and fits the budget');
}

// ═════ hashtags (api/_write.js) ═════
let calls = [], plan = () => '';
stub('_llm.js', {
  callLLM: async (opts) => { calls.push(opts); return plan(calls.length - 1, opts); },
  aiUnavailable: () => null, callGrokSearch: async () => null,
});
const W = require_(path.join(API, '_write.js'));
const SRC = { kind: 'note', text: 'People think magnesium fixes sleep.' };
const ANGLE = { belief: 'Magnesium is not a sleep cure' };
const DRAFT = "Magnesium won't cure your insomnia. It just helps some people relax before bed. Good sleep habits do the heavy lifting.";
const SHAPE = JSON.stringify({ title: 'Magnesium is not a cure', hook: "Magnesium won't cure your insomnia.", caption: 'Sleep habits first.',
  onScreen: ['Not a cure'], shots: ['Desk'], emphasis: ['relax before bed'], hashtags: ['#cureinsomnia', '#magnesiumcures', '#nike'] });
const BCT = { brandName: 'Calm Co', tones: ['dry'], communities: ['Evening routines', 'Sleep habits', 'General', 'Magnesium basics'] };
{
  calls = []; plan = (i) => [DRAFT, DRAFT, SHAPE][i];
  const out = await W.runWrite({ bc: BCT, source: SRC, angle: ANGLE, deadlineMs: 200000 });
  const H = out.hashtags;
  ok(calls.length === 3 && !/hashtag/i.test((calls[2].messages || [])[0].content), 'no AI call and no prompt asks for hashtags (still 3 calls)');
  ok(Array.isArray(H) && H === out.idea.hashtags, 'runWrite returns hashtags: string[] (also on the idea, like caption)');
  ok(!H.some(t => /cure|nike/.test(t)), 'model-written tags are never used — no #cureinsomnia, no #nike (' + H.join(' ') + ')');
  ok(JSON.stringify(H) === JSON.stringify(['#sleephabits', '#magnesiumbasics', '#eveningroutines', '#calmco']),
    'themes ranked by overlap with the idea, then the brand name; "General" skipped (' + H.join(' ') + ')');
  ok(H.length >= 3 && H.length <= 6 && H.every(t => /^#[\p{Ll}\p{N}]+$/u.test(t)), '3-6 lowercase #word tags');
  calls = []; plan = (i) => [DRAFT, DRAFT, SHAPE][i];
  const again = await W.runWrite({ bc: BCT, source: SRC, angle: ANGLE, deadlineMs: 200000 });
  ok(JSON.stringify(again.hashtags) === JSON.stringify(H), 'deterministic: the same idea gets the same tags');
}
{
  calls = []; plan = (i) => [DRAFT, DRAFT, SHAPE][i];
  const out = await W.runWrite({ bc: { brandName: 'Calm Co', tones: ['dry'] }, source: SRC, angle: ANGLE, deadlineMs: 200000 });
  ok(Array.isArray(out.hashtags) && out.hashtags.length === 0, 'a brand with no themes gets [] — never the brand name alone, never invented');
}
{
  const h = W._internals.hashtagsFor;
  const many = { brandName: 'Acme Studio', communities: ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'] };
  const t = h(many, { script: 'nothing matches' });
  ok(t.length === 6 && t[5] === '#acmestudio' && t[0] === '#one', 'capped at 6 (5 themes in the brand\'s order + the brand name): ' + t.join(' '));
  ok(h({ brandName: 'Bar Co', communities: 'Monday: Real food, Tuesday: Protein myths' }, { script: 'protein bar myths' }).join(' ') === '#proteinmyths #realfood #barco',
    'a day-map string of themes works too');
  ok(h({ brandName: 'X', communities: ['Café & Küche!'] }, {}).join(' ') === '#caféküche #x', 'spaces and punctuation removed, letters kept, lowercased');
  ok(h({ brandName: 'Boring Electrolytes', dayRotation: { Monday: 'Hydration myths', Tuesday: 'General', Bonus: 'All' } }, {}).join(' ') === '#hydrationmyths #boringelectrolytes',
    'a brand whose themes live only in its day rotation still gets them ("General"/"All" skipped)');
}

clearTimeout(WALL);
if (failed) { console.log('fix7-server: ' + failed + ' failed, ' + passed + ' passed'); process.exit(1); }
console.log('FIX7 SERVER OK — ' + passed + ' checks: daily batch (target 7, one credit per brand, verified brand, app row shape, dedupe, failure-safe, 402-safe, inactive user charged at most once) + units run 6 at a time (all same-hour users pushed, timed-out brand paused 20h) + hashtags (brand themes only)');
