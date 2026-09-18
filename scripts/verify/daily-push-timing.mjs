#!/usr/bin/env node
// GATE: the daily push must reach everyone it is due to reach, once, on the right day.
//
// WHY THIS EXISTS — four defects in one cron, all invisible to the person who misses their ping.
//
//   1. THE RUN BUDGET WAS ARITHMETICALLY SHORT, SO THE FUNCTION COULD BE KILLED MID-LOOP.
//      The only guard refused to START a subscriber with less than MIN_SLICE_MS left — 30s —
//      against a per-subscriber worst case of ~125s, every number of which is declared in the
//      file: the access check makes TWO sequential requests at the 20s request budget (40s),
//      then getBrandActivity 20s, loadBrandContext 20s, the generate floor 10s, the push 15s,
//      and the last_sent_at PATCH 20s. Starting one with 30s left finishes near 340s against
//      maxDuration 300. The platform kills the function, store.heartbeat() is NEVER reached,
//      and every subscriber the loop had not got to MISSES THAT DAY — the due filter matches
//      each of them at exactly one UTC hour, and the code says outright they are not retried.
//      pull-trends-cron took exactly this 504-before-heartbeat in production and was given TWO
//      guards; this file's comment claimed "same shape as pull-trends-cron" while having one.
//
//   2. THE 20-HOUR DEDUPE SWALLOWED A WHOLE DAY AFTER EASTWARD TRAVEL. The app corrects
//      tz_offset_min when next opened; moving east makes the next send EARLIER, so the gap from
//      the previous one is (24 - delta) hours. Any eastward hop over 4h lands inside the 20h
//      window and is suppressed outright, with no retry. New York → London: no daily idea at
//      all on the first London morning. The dedupe's real question is "have we already sent for
//      this person's LOCAL DAY", so it asks that now — which also makes the clocks-back Sunday
//      (a 23-hour gap) safe.
//
//   3. THREE BRANDS MEANT THREE NOTIFICATIONS ON ONE PHONE. enableDailyPush writes one row per
//      BRAND for the same push endpoint, and the only dedupe was per row, under copy promising
//      "One notification a day". One per endpoint per local day now, plus a tag in sw.js so any
//      that do overlap replace each other instead of stacking.
//
//   4. THE PUSH SAID "TODAY'S POST" AND ASKED FOR NO PARTICULAR DAY. generate-ideas only pins a
//      day when `gaps` is supplied, so the model chose freely from validDays (which includes
//      'Bonus') while the app's Today screen derives the day from the browser clock — tapping
//      the notification could open a different day's plan than the brief was written for. The
//      day is now named, in the SUBSCRIBER's local time. (The gap template also printed
//      "- Monday / undefined (currently undefined ideas)" for a day-only gap; it renders only
//      the parts a caller supplied.)
//
// HOW IT CHECKS
//   The real due filter is lifted verbatim out of api/send-daily.js and RUN against travel, a
//   DST changeover, a same-day repeat, three brands on one device, two devices, and five
//   offsets. The budget arithmetic is computed from the constants IN THE FILE, not copied here,
//   so changing a timeout re-derives the worst case. Two arms are mutation checks: the travel
//   gap must really fall inside the old 20h window, and the old 30s reserve must really be
//   short of the measured worst case — so a green result cannot come from a dead test.
//
// RUN:    node scripts/verify/daily-push-timing.mjs
// EXPECT: prints "PASS" and exits 0.
import fs from 'node:fs'; import vm from 'node:vm';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sd = fs.readFileSync(path.join(ROOT,'api','send-daily.js'),'utf8');
const sw = fs.readFileSync(path.join(ROOT,'sw.js'),'utf8');
let fail=0; const ok=(c,m)=>{ if(!c){console.log('FAIL:',m);fail++;} else console.log('ok:',m); };

// ── the REAL due filter, lifted verbatim ──────────────────────────────────────
// v678: the due filter calls offsetFor() to get the subscriber's REAL offset for today
// (see push-timezone-truth.mjs), so lift from there — a slice that starts at localDayKey
// leaves the helper behind and the filter throws.
const i = sd.indexOf('    const offsetFor = (sub, when) =>');
const seg = sd.slice(i, sd.indexOf('    });', sd.indexOf('const due = (subs || []).filter')) + 7);
const runDue = (subs, nowUtc) => {
  const c = { console, subs, nowUtc, Date, Number, Set, Math, Intl };
  vm.createContext(c);
  return vm.runInContext(seg + '\n;due;', c);
};
const sub = (o) => Object.assign({ id:'s1', send_hour:9, tz_offset_min:0, last_sent_at:null,
  subscription:{ endpoint:'https://push/e1' } }, o);
const at = (iso) => new Date(iso);

// 1. eastward travel must NOT swallow a day  (NY -> London, delta 5h)
{
  // yesterday's send happened at 14:00 UTC = 09:00 New York
  const s = sub({ tz_offset_min: 0, last_sent_at: '2026-09-21T14:00:00Z' });  // now in London
  const d = runDue([s], at('2026-09-22T09:00:00Z'));                          // 09:00 London
  ok(d.length === 1, 'after NY->London the first London morning STILL gets a push (was suppressed by the 20h window)');
  // the pre-fix rule, for contrast
  const gap = at('2026-09-22T09:00:00Z') - at('2026-09-21T14:00:00Z');
  ok(gap < 20*3600*1000, 'MUTATION CHECK: the gap really is ' + (gap/3600000) + 'h, inside the old 20h window');
}
// 2. but a genuine same-day repeat must still be blocked
{
  const s = sub({ last_sent_at: '2026-09-22T09:00:00Z' });
  ok(runDue([s], at('2026-09-22T09:00:00Z')).length === 0, 'a second push on the same local day is still blocked');
}
// 3. and the next local day is allowed
{
  const s = sub({ last_sent_at: '2026-09-22T09:00:00Z' });
  ok(runDue([s], at('2026-09-23T09:00:00Z')).length === 1, 'the next local day is allowed through');
}
// 4. clocks-back Sunday: the 23h gap must not suppress
{
  const s = sub({ tz_offset_min:-60, last_sent_at:'2026-10-24T08:00:00Z' });
  ok(runDue([s], at('2026-10-25T08:00:00Z')).length === 1, 'the clocks-back Sunday still gets its push');
}
// 5. three brands, one device -> ONE push
{
  const rows = ['b1','b2','b3'].map((b,ix)=>sub({ id:'s'+ix, brand_id:b }));
  const d = runDue(rows, at('2026-09-22T09:00:00Z'));
  ok(d.length === 1, 'three brands on one device now produce ONE push, not ' + rows.length + ' (got ' + d.length + ')');
}
// 6. two different devices still both get one
{
  const rows = [sub({id:'a', subscription:{endpoint:'https://push/phone'}}),
                sub({id:'b', subscription:{endpoint:'https://push/laptop'}})];
  ok(runDue(rows, at('2026-09-22T09:00:00Z')).length === 2, 'two separate devices each still get their push');
}
// 7. the hour match itself is unchanged across offsets
{
  const cases = [[0,'2026-09-22T09:00:00Z',1],[300,'2026-09-22T14:00:00Z',1],[-330,'2026-09-22T04:00:00Z',1],
                 [0,'2026-09-22T10:00:00Z',0],[-60,'2026-09-22T08:00:00Z',1]];
  let good = 0;
  for (const [tz,iso,want] of cases) if (runDue([sub({tz_offset_min:tz})], at(iso)).length === want) good++;
  ok(good === cases.length, 'the hour match is unchanged across offsets (' + good + '/' + cases.length + ')');
}
// 8. a row with no endpoint is not dropped
ok(runDue([sub({ subscription:{} })], at('2026-09-22T09:00:00Z')).length === 1, 'a row with no endpoint is still delivered');

// ── the budget must now cover the real worst case ─────────────────────────────
{
  const num = (n) => { const ix = sd.indexOf('const ' + n);
    if (ix < 0) return NaN;
    return Number((sd.slice(ix, ix + 120).match(/=\s*(\d+)/) || [])[1]); };
  const RUN = num('RUN_BUDGET_MS'), MIN = num('MIN_SLICE_MS'), DB = num('DB_TIMEOUT_MS'), PUSH = num('PUSH_TIMEOUT_MS');
  const budget = Number((sd.match(/setRequestBudget\((\d+)\)/) || [])[1]);
  // worst case, every number taken from the file
  const worst = budget*2 /* userCanAccessBrand: two sequential requests */
              + DB /* getBrandActivity */ + DB /* loadBrandContext */
              + 10000 /* the generate floor */ + PUSH + DB /* last_sent_at */;
  ok(MIN >= worst, 'MIN_SLICE_MS (' + MIN + ') now covers the measured worst case (' + worst + 'ms)');
  ok(RUN + 0 <= 300000, 'RUN_BUDGET_MS stays inside maxDuration 300000');
  ok(30000 < worst, 'MUTATION CHECK: the old 30000ms reserve was far short of ' + worst + 'ms');
  // guard 2 must exist and must be a race, not another reserve
  ok(/Promise\.race\(\[\s*_subWork/.test(sd), 'guard 2 races the in-flight subscriber against the time left');
  ok(/const _subWork = \(async \(\) => \{/.test(sd), 'the per-subscriber work is wrapped so it CAN be raced');
  ok(/heartbeat\('send-daily'/.test(sd), 'the heartbeat is still written at the end');
  const raceAt = sd.indexOf('Promise.race([\n        _subWork');
  const hbAt = sd.indexOf("heartbeat('send-daily'");
  ok(raceAt > -1 && raceAt < hbAt, 'the race happens BEFORE the heartbeat, which is the whole point');
}

// ── the brief must be asked for on the subscriber's local day ─────────────────
{
  ok(/gaps: \[\{ day: _dayName \}\]/.test(sd), 'send-daily now names the day it wants');
  const m = sd.match(/const _localNow = ([^;]+);/);
  ok(!!m, '_localNow is gone');
  // v678: _localNow now resolves the offset through offsetFor(), so the helper must be in scope.
  const offSeg = sd.slice(sd.indexOf('    const offsetFor = (sub, when) =>'), sd.indexOf('\n    };', sd.indexOf('    const offsetFor = (sub, when) =>')) + 7);
  const c = { Date, Number, Intl }; vm.createContext(c); vm.runInContext('var ' + offSeg.trim().replace(/^const /, ''), c);
  for (const [tz, iso, want] of [[0,'2026-09-22T09:00:00Z','Tuesday'], [300,'2026-09-22T02:00:00Z','Monday'],
                                 [-660,'2026-09-22T22:00:00Z','Wednesday']]) {
    c.nowUtc = new Date(iso); c.sub = { tz_offset_min: tz };
    const got = vm.runInContext("var _localNow = " + m[1] + ";['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][_localNow.getUTCDay()]", c);
    ok(got === want, 'tz ' + tz + ' at ' + iso + ' is locally ' + got + ' (expected ' + want + ')');
  }
  // the prompt line must not print "undefined" for a day-only gap
  const gi = fs.readFileSync(path.join(ROOT,'api','generate-ideas.js'),'utf8');
  const gm = gi.slice(gi.indexOf('gapInstruction = `'), gi.indexOf(".join('\\n')}`;") + 16);
  const g = { gaps: [{ day: 'Tuesday' }, { day: 'Friday', format: 'video', count: 0 }] };
  vm.createContext(g);
  const out = vm.runInContext('let gapInstruction=""; ' + gm + ' gapInstruction;', g);
  ok(!/undefined/.test(out), 'a day-only gap no longer writes "undefined" into the prompt:\n     ' + out.trim().split('\n').slice(1).join(' | '));
  ok(/Friday \/ video \(currently 0 ideas\)/.test(out), 'a full gap still renders exactly as before');
}

// ── notifications must collapse ──────────────────────────────────────────────
ok(/tag: d\.tag \|\| 'cs-daily'/.test(sw), 'sw.js tags the daily notification so duplicates replace rather than stack');

console.log(fail ? '\nFAIL \u2014 ' + fail + ' check(s) failed' : '\nPASS \u2014 every due subscriber is reachable within the budget, once per local day, on the right day');
process.exit(fail?1:0);
