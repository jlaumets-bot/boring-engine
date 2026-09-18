#!/usr/bin/env node
// GATE: the daily ping arrives at the hour the person chose, on the day DST changes too.
//
// WHY THIS EXISTS
//   push_subscriptions.tz_offset_min is a SNAPSHOT taken the last time the app was open, and
//   it is only refreshed inside a successful /api/usage call. So on a changeover Sunday the row
//   still carries Saturday's offset — and Sunday morning is exactly when nobody has opened the
//   app. Measured against the real Europe/London zone: on 2026-10-25 a 09:00 ping lands at
//   08:00; on 2026-03-29 it lands at 10:00. Twice a year, for every EU/US/AU subscriber.
//   A zone NAME does not go stale, so the row carries one (sql/v678-push-tz-name.sql) and
//   send-daily works out the real offset for the day it is actually sending. Every fallback is
//   pinned here too: a row with no name, an unknown name, and a database where the column has
//   not been added yet must all behave exactly as v677 did rather than throwing or sending
//   nothing.
//
// HOW IT CHECKS
//   offsetFor and the due filter are lifted out of api/send-daily.js and RUN against Node's
//   real IANA zone database — both London switches, New York, Kolkata (half-hour), Kathmandu
//   (quarter-hour) and Tallinn — then swept across all 365 days of 2026 to prove the ping
//   still fires exactly once a day. Two arms are mutation checks: the SAME row with tz_name
//   removed must still fire at 08:00 and 10:00 on those Sundays, so a green result cannot come
//   from a test that no longer tests anything.
//
// RUN:    node scripts/verify/push-timezone-truth.mjs
// EXPECT: prints "PASS" and exits 0.
import fs from 'node:fs'; import vm from 'node:vm';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sd = fs.readFileSync(path.join(ROOT,'api','send-daily.js'),'utf8');
let fail=0; const ok=(c,m)=>{ if(!c){console.log('FAIL:',m);fail++;} else console.log('ok:',m); };

// lift the REAL offsetFor + due filter
const a = sd.indexOf('    const offsetFor = (sub, when) =>');
const b = sd.indexOf('    });', sd.indexOf('const due = (subs || []).filter'));
const seg = sd.slice(sd.indexOf('    const localDayKey ='), b + 7);
const offSeg = sd.slice(a, sd.indexOf('\n    };', a) + 7);

const ctx = { console, Date, Number, Set, Math, Intl };
vm.createContext(ctx);
vm.runInContext(offSeg, ctx);
const off = (sub, iso) => { ctx.sub = sub; ctx.when = new Date(iso);
  return vm.runInContext('offsetFor(sub, when)', ctx); };

// ── the real Europe/London zone across both switches ─────────────────────────
ok(off({tz_name:'Europe/London'}, '2026-07-01T12:00:00Z') === -60, 'London in summer is -60 (BST): ' + off({tz_name:'Europe/London'}, '2026-07-01T12:00:00Z'));
ok(off({tz_name:'Europe/London'}, '2026-12-01T12:00:00Z') === 0,   'London in winter is 0 (GMT)');
ok(off({tz_name:'America/New_York'}, '2026-12-01T12:00:00Z') === 300, 'New York in winter is 300');
ok(off({tz_name:'America/New_York'}, '2026-07-01T12:00:00Z') === 240, 'New York in summer is 240');
ok(off({tz_name:'Asia/Kolkata'}, '2026-07-01T12:00:00Z') === -330, 'Kolkata is -330 (half-hour zone)');
ok(off({tz_name:'Asia/Kathmandu'}, '2026-07-01T12:00:00Z') === -345, 'Kathmandu is -345 (quarter-hour zone)');
ok(off({tz_name:'Europe/Tallinn'}, '2026-12-01T12:00:00Z') === -120, 'Tallinn in winter is -120');
// fallbacks
ok(off({tz_offset_min: 300}, '2026-07-01T12:00:00Z') === 300, 'a row with no tz_name falls back to the stored offset');
ok(off({tz_name:'Not/AZone', tz_offset_min: 120}, '2026-07-01T12:00:00Z') === 120, 'an unknown zone name falls back, it does not throw');
ok(off({}, '2026-07-01T12:00:00Z') === 0, 'an empty row is 0, not NaN');

// ── the due filter must now fire at the right WALL CLOCK hour across DST ─────
const runDue = (subs, nowIso) => {
  const c = { console, subs, nowUtc: new Date(nowIso), Date, Number, Set, Math, Intl };
  vm.createContext(c); vm.runInContext(offSeg + '\n' + seg + '\n;due;', c); return vm.runInContext('due', c);
};
const wall = (iso, zone) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour:'2-digit', minute:'2-digit', hour12:false }).format(new Date(iso));

// clocks BACK, Sunday 2026-10-25: a 09:00 ping must land at 09:00 local, not 08:00
{
  const s = { id:'s', send_hour:9, tz_name:'Europe/London', tz_offset_min:-60, last_sent_at:'2026-10-24T08:00:00Z', subscription:{endpoint:'e'} };
  const hits = ['2026-10-25T08:00:00Z','2026-10-25T09:00:00Z'].filter(t => runDue([s], t).length === 1);
  ok(hits.length === 1, 'exactly one slot fires on the clocks-back Sunday (' + hits.length + ')');
  ok(wall(hits[0], 'Europe/London') === '09:00', 'and it is 09:00 London wall clock, not ' + wall(hits[0],'Europe/London'));
  // the pre-fix behaviour, for contrast: the stale -60 offset would have fired at 08:00 UTC = 08:00 local
  const stale = { ...s, tz_name: null };
  const preHit = ['2026-10-25T08:00:00Z','2026-10-25T09:00:00Z'].filter(t => runDue([stale], t).length === 1)[0];
  ok(wall(preHit, 'Europe/London') === '08:00',
    'MUTATION CHECK: without tz_name the same row still fires at ' + wall(preHit,'Europe/London') + ' — the bug is real and the fix is what changed it');
}
// clocks FORWARD, Sunday 2026-03-29: must be 09:00, not 10:00
{
  const s = { id:'s', send_hour:9, tz_name:'Europe/London', tz_offset_min:0, last_sent_at:'2026-03-28T09:00:00Z', subscription:{endpoint:'e'} };
  const hits = ['2026-03-29T08:00:00Z','2026-03-29T09:00:00Z'].filter(t => runDue([s], t).length === 1);
  ok(hits.length === 1, 'exactly one slot fires on the clocks-forward Sunday');
  ok(wall(hits[0], 'Europe/London') === '09:00', 'and it is 09:00 London wall clock, not ' + wall(hits[0],'Europe/London'));
  const stale = { ...s, tz_name: null };
  const preHit = ['2026-03-29T08:00:00Z','2026-03-29T09:00:00Z'].filter(t => runDue([stale], t).length === 1)[0];
  ok(wall(preHit,'Europe/London') === '10:00', 'MUTATION CHECK: without tz_name it fires at ' + wall(preHit,'Europe/London'));
}
// a year of ordinary days must still fire exactly once each
{
  const s = { id:'s', send_hour:9, tz_name:'Europe/London', subscription:{endpoint:'e'} };
  let bad = 0, days = 0;
  for (let d = 0; d < 365; d++) {
    const day = new Date(Date.UTC(2026,0,1) + d*86400000);
    let hits = 0, last = null;
    for (let h = 0; h < 24; h++) {
      const t = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h));
      const row = { ...s, last_sent_at: last };
      if (runDue([row], t.toISOString()).length) { hits++; last = t.toISOString(); }
    }
    days++; if (hits !== 1) bad++;
  }
  ok(bad === 0, 'across all ' + days + ' days of 2026 the ping fires exactly once a day (' + bad + ' bad days)');
}
// the fallback path must still be read correctly by the select
ok(/select=\$\{_cols\},tz_name/.test(sd), 'the subscriber read asks for tz_name');
ok(/falling back to the stored offset/.test(sd), 'and falls back to the old column list if the column is missing');
ok(fs.existsSync(path.join(ROOT,'sql','v678-push-tz-name.sql')), 'the SQL to add the column exists');
ok(/add column if not exists tz_name/.test(fs.readFileSync(path.join(ROOT,'sql','v678-push-tz-name.sql'),'utf8')), 'and it is idempotent');

console.log(fail ? '\nFAIL \u2014 ' + fail + ' check(s) failed' : '\nPASS \u2014 the ping holds its wall-clock hour through both DST switches, and every fallback still works');
process.exit(fail?1:0);
