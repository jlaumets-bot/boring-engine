#!/usr/bin/env node
// GATE: the nightly trends cron must fit in its own budget, and each lane must say why it is empty.
//
// WHY THIS EXISTS — production was failing every night and the health check said so.
//   /api/health on 2026-09-18 reported cron_pull-trends-cron_fresh FAILING, status "error",
//   heartbeat 212 minutes old. The run's own logs (the v670/v672 diagnostics) named all three
//   causes, and every one of them was in this repo:
//
//   1. THE GROK LANE WAS UNBOUNDED AND ATE THE WHOLE RUN. pullAllTrends' 4th and 6th arguments
//      are the X and Grok lane timeouts; the cron passed `undefined` for both, and `bound()`
//      only races a lane when ms > 0 — so the lane ran until callGrokSearch's own 90s SOCKET
//      timeout. That is longer than WORST_BATCH_MS (75s), the reserve the batch loop sets aside
//      to decide whether it may start another batch, so the reserve could not bind. The
//      competitor pulse was a SECOND unbounded 90s grok call on the same clock, with a comment
//      saying "no timeout here, the cron has the full 120s budget" — true when it ran alone.
//      Live result: "ran out of budget after 270000ms — updated 0, 8 left for the next run",
//      "lanes this run — grok=0 news=0 x=0", twelve brands, nothing written, every night.
//
//   2. THE X LANE COUNTED THE ACTOR'S "I FOUND NOTHING" MARKER AS TEN TWEETS. Every brand logged
//      "10 raw, 0 kept — TEXT FIELD NOT FOUND", which had already sent three rounds of
//      field-name guessing after a parser bug that was never there: the dataset held ten copies
//      of {"noResults":true}. The SHAPE diagnostic printed it plainly; the count and the note
//      did not. A diagnostic that names the wrong cause is worse than none.
//
//   3. THE NEWS LANE EXITED IN SILENCE. fetchNewsRss resolved an empty list on a redirect, a
//      transport error and a timeout with no log at all, so news=0 for every brand was
//      indistinguishable from a quiet news day.
//
// HOW IT CHECKS
//   The X-lane counter is lifted out of _trends.js and RUN on the exact payload production
//   logged, plus a genuinely-broken-parser case that must STILL be reported as such. The budget
//   arithmetic is the REAL expression from the cron, evaluated at three points in a run, and the
//   worst case is compared against the loop's own WORST_BATCH_MS.
//
// RUN:    node scripts/verify/trend-lane-budget.mjs
// EXPECT: prints "PASS" and exits 0.
import fs from 'node:fs'; import vm from 'node:vm';
const tr = fs.readFileSync('api/_trends.js','utf8'), cr = fs.readFileSync('api/pull-trends-cron.js','utf8');
let fail=0; const ok=(c,m)=>{ if(!c){console.log('FAIL:',m);fail++;} else console.log('ok:',m); };

// ── A. the X-lane counter, run on the EXACT payload production logged ──────────
const i = tr.indexOf('  const _all = (Array.isArray(items) ? items : []);');
const seg = tr.slice(i, tr.indexOf('return out;', i));
const run = (items, out) => {
  const logs=[]; const c={ console:{log:(...a)=>logs.push(a.join(' '))}, items, out, JSON, Object, Array, String };
  vm.createContext(c); const v = vm.runInContext(seg + '\n;({ raw: raw, markers: _markers });', c);
  return { logs, raw: v.raw, markers: v.markers };
};
// production, verbatim: ten copies of the actor's no-result sentinel
let r = run(Array.from({length:10},()=>({noResults:true})), []);
ok(r.raw === 0, 'ten {"noResults":true} markers count as 0 raw tweets (was 10) — got ' + r.raw);
ok(r.markers === 10, 'and are reported as 10 markers');
ok(/NO MATCHING TWEETS/.test(r.logs.join(' ')), 'the log now says the query found nothing');
ok(!/TEXT FIELD NOT FOUND/.test(r.logs.join(' ')), 'and no longer blames a missing text field');
console.log('   live line:', r.logs[0]);
// a genuinely broken parser must STILL be reported as such
r = run([{full_text:'a real tweet with plenty of words in it'},{full_text:'another one here'}], []);
ok(/TEXT FIELD NOT FOUND/.test(r.logs.join(' ')), 'real tweets that all got dropped still report a parser problem');
ok(r.raw === 2, 'and still count as 2 raw');
// a healthy lane
r = run([{full_text:'x'},{full_text:'y'}], [{eng:{hasData:true}},{eng:{hasData:false}}]);
ok(/2 raw, 2 kept, 1 with engagement/.test(r.logs.join(' ')), 'a healthy lane still reports plainly: ' + r.logs[0]);
// mixed: markers alongside real tweets
r = run([{noResults:true},{full_text:'a real tweet with plenty of words'}], [{eng:{hasData:true}}]);
ok(r.raw === 1, 'markers are excluded from the raw count when real tweets are also present');

// ── B. the news lane must now SAY why it is empty ─────────────────────────────
const news = tr.slice(tr.indexOf('function fetchNewsRss('), tr.indexOf('// Google News, windowed'));
for (const [label, rx] of [['a redirect', /news RSS redirected/], ['a non-200', /news RSS http /],
                           ['a transport error', /news RSS request failed/], ['a timeout', /news RSS timed out/]])
  ok(rx.test(news), 'the news lane logs ' + label);
ok((news.match(/resolve\(\{ items: \[\] \}\)/g)||[]).length === (news.match(/console\.error\('_trends: news RSS/g)||[]).length,
  'every empty-list exit in fetchNewsRss has a log beside it (' +
  (news.match(/resolve\(\{ items: \[\] \}\)/g)||[]).length + ' exits, ' +
  (news.match(/console\.error\('_trends: news RSS/g)||[]).length + ' logs)');

// ── C. the grok lane must be bounded by the time the run actually has ─────────
const call = cr.match(/const items = await pullAllTrends\(([^)]*)\)/);
ok(!!call, 'the pullAllTrends call is gone from the cron');
const args = call[1].split(',').map(s=>s.trim());
ok(args[3] !== 'undefined' && args[5] && args[5] !== 'undefined',
  'the X (arg 4) and Grok (arg 6) lane timeouts are passed, not undefined — got [' + args.join(' | ') + ']');
const laneExpr = cr.match(/const _laneMs = ([^;]+);/);
ok(!!laneExpr, '_laneMs is gone');
{ // run the real expression against the real constants
  const c = { Math }; vm.createContext(c);
  const BUDGET=270000, WORST=75000;
  for (const [leftMs, label] of [[270000,'start of run'],[80000,'last batch the reserve allows'],[76000,'the very edge']]) {
    c._left = () => leftMs;
    const ms = vm.runInContext(laneExpr[1], c);
    ok(ms > 0 && ms <= leftMs - 20000, 'with ' + leftMs + 'ms left (' + label + ') the lane gets ' + ms + 'ms, leaving room to write');
    ok(ms <= 45000, '  and never more than 45s (the old lane ran to callGrokSearch\'s 90s socket timeout)');
  }
  // the reserve must now be honest: worst lane + worst pulse <= WORST_BATCH_MS
  c._left = () => 270000;
  const lane = vm.runInContext(laneExpr[1], c);
  const pulseExpr = cr.match(/timeoutMs: (Math\.max\([^)]*\)[^}]*)\s*\}/);
  ok(!!pulseExpr, 'the competitor pulse timeout is gone');
  const pulse = vm.runInContext(pulseExpr[1].replace(/\s*$/,''), c);
  ok(lane + pulse <= WORST, 'worst-case brand = lane ' + lane + 'ms + pulse ' + pulse + 'ms = ' + (lane+pulse) +
     'ms, within the ' + WORST + 'ms the loop reserves (before the fix: 90000 + 90000 = 180000)');
}
// MUTATION: the old call really was unbounded
{ const c={Math}; vm.createContext(c);
  ok(/bound = \(p, ms\) => \(ms && ms > 0\)/.test(tr),
    'MUTATION ANCHOR: pullAllTrends still only races a lane when ms > 0, which is why undefined meant unbounded'); }

console.log(fail ? '\nFAIL \u2014 ' + fail + ' check(s) failed' : '\nPASS \u2014 every lane is bounded by the run\u0027s real budget and says why it came back empty');
process.exit(fail?1:0);
