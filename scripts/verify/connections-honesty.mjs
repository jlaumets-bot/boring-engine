#!/usr/bin/env node
// GATE: an outside service that goes quiet must never be reported as the user's fault, and never
//       as a healthy run.
//
// WHY THIS EXISTS
//   Three failures, all the same shape — a real breakage wearing the costume of a normal result.
//
//   1. crawl-social BLAMED THE USER'S PROFILE. `waitForFinish` is a CEILING, not a promise: Apify
//      answers after at most RUN_WAIT_S seconds whether or not the scrape finished, and the run
//      object carries `defaultDatasetId` from the moment it is CREATED. So a slow actor meant
//      reading a dataset that was empty or half-written, finding fewer than three captions, and
//      telling the person:
//          "Found fewer than 3 readable posts on that profile — is it public and active?"
//      They go and check privacy settings that were never the problem. The run's `status` field
//      says exactly what happened and nothing read it.
//
//   2. THE TRENDS CRON HEARTBEAT `ok` WITH EVERY SOURCE DEAD. `skipped` lumped together "this
//      brand has no keywords", "every source returned nothing" and "we ran out of budget". Only
//      the middle one can mean the app is broken. A run where every source failed for every brand
//      reported {ok:true, updated:0, skipped:30} and a green heartbeat, so /api/health stayed
//      green while the trends feed quietly stopped updating for everyone. `pullAllTrends` has
//      always returned per-lane counts on `items.lanes` and nothing read them.
//
//   3. THE GROK WEB-SEARCH LANE FAILED IN SILENCE. Five of six exits in callGrokSearch resolved
//      null with no log, and pullGrokTrends turned that into an empty lane — absent from the feed,
//      indistinguishable from a quiet day.
//
// HOW IT CHECKS
//   The crawl-social and cron arms are EXECUTED against stubs. The logging arm is structural but
//   DERIVED: every early `return`/`resolve(null)` in the two search functions must have a log in
//   the same statement, so a new silent exit added later fails here by itself.
//
// RUN:    node scripts/verify/connections-honesty.mjs
// EXPECT: prints "PASS" and exits 0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fails = [];
const bad = m => fails.push(m);
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ── 1. crawl-social: the error must depend on the RUN STATUS ───────────────────────────────
{
  const src = read('api/crawl-social.js');
  const blk = src.slice(src.indexOf('if (captions.length < 3)'), src.indexOf('// Voice extraction'));
  if (!blk) bad('api/crawl-social.js: the "fewer than 3 posts" branch is gone — re-point the gate.');
  else {
    // Executed: the real branch logic, with the statuses Apify actually returns.
    const decide = new Function('captions', 'runStatus', 'runId', 'platform', 'console', 'res', `
      ${blk.replace(/return res\.status\((\d+)\)\.json\(([^;]*)\);/g, 'return { code: $1, body: $2 };')}
      return { code: 200 };
    `);
    const noop = { error() {}, log() {} };
    const run = st => decide([], st, 'run1', 'instagram', noop, null);
    const blames = r => /public and active/.test(JSON.stringify(r.body || ''));

    for (const st of ['RUNNING', 'READY']) {
      const r = run(st);
      if (blames(r)) bad(`a scrape still ${st} tells the person their own profile may not be public. ` +
                         'Apify answers before the run finishes, so this is the ordinary slow case.');
      if (r.code === 404) bad(`a scrape still ${st} returns 404, which reads as "nothing there".`);
      // 503 specifically: "come back in a minute" is a different instruction from "this failed".
      // A first version accepted 502 here, and a mutation that deleted the still-running branch
      // escaped because the generic not-SUCCEEDED branch below answered 502 and looked fine.
      if (r.code !== 503) bad(`a scrape still ${st} returns ${r.code}, not 503. It has not failed — ` +
                              'it has not finished, and the person should be told to try again shortly.');
      if (!/longer than usual|try again/i.test(JSON.stringify(r.body || ''))) {
        bad(`a scrape still ${st} does not tell the person to try again: ${JSON.stringify(r.body || '')}`);
      }
    }
    for (const st of ['FAILED', 'ABORTED', 'TIMED-OUT']) {
      const r = run(st);
      if (blames(r)) bad(`a run that ended ${st} on Apify's side is reported as the user's profile being private.`);
      if (r.code === 404) bad(`a run that ended ${st} returns 404 rather than an error.`);
    }
    // ...and when the scrape genuinely finished, blaming the profile is CORRECT and must remain.
    const ok = run('SUCCEEDED');
    if (!blames(ok) || ok.code !== 404) {
      bad('a SUCCEEDED run with too few captions no longer tells the person to check that the ' +
          'profile is public — that is the one case where saying so is right.');
    }
  }
  if (!/runResult\.data\.status/.test(src) && !/data && runResult\.data\.status/.test(src)) {
    bad('api/crawl-social.js never reads the run status at all.');
  }
}

// ── 2. the trends cron: all sources silent is an error, not a skip ──────────────────────────
{
  const src = read('api/pull-trends-cron.js');
  const m = src.match(/const _triedBrands =[\s\S]*?const _health = [^;]+;/);
  if (!m) bad('api/pull-trends-cron.js no longer decides health from whether every source was silent.');
  else {
    const decide = new Function('due', 'updated', 'skipped', 'skipNoKeywords', 'skipNoItems', 'failed', 'ranOut', 'laneTotals', 'console', `
      ${m[0].replace(/due\.length/g, 'due')}
      return { health: _health, allSilent: _allSilent };
    `);
    const noop = { error() {}, log() {} };
    const L = { grok: 0, news: 0, x: 0 };
    // every brand tried, every source silent -> error
    let r = decide(30, 0, 30, 0, 30, 0, false, L, noop);
    if (r.health !== 'error') bad('a run where all 30 due brands got NOTHING from any source still heartbeats "ok". ' +
                                  '/api/health stays green while the trends feed stops updating for everyone.');
    // brands simply not set up -> not an error
    r = decide(30, 0, 30, 30, 0, 0, false, L, noop);
    if (r.health !== 'ok') bad('brands with no keywords are reported as a systematic failure. A brand that is ' +
                               'not set up yet is not evidence that anything is broken.');
    // MIXED, and the case that makes `- skipNoKeywords` load-bearing: 20 brands were not set up,
    // the 10 that WERE tried all got nothing. That is a systematic failure of the sources.
    // (A first version of this gate only tested all-or-nothing, so a mutation that dropped the
    // subtraction changed no assertion and escaped.)
    r = decide(30, 0, 30, 20, 10, 0, false, L, noop);
    if (r.health !== 'error') bad('20 brands were not set up and all 10 that were actually tried got NOTHING ' +
                                  'from any source, yet the run heartbeats "ok".');
    // a normal run -> ok
    r = decide(30, 28, 2, 1, 1, 0, false, L, noop);
    if (r.health !== 'ok') bad('an ordinary run with a couple of skips is reported as an error.');
    // nothing due -> ok
    r = decide(0, 0, 0, 0, 0, 0, false, L, noop);
    if (r.health !== 'ok') bad('a run with no brands due is reported as an error.');
    // brands failed outright and nothing updated -> error (the pre-existing rule must survive)
    r = decide(30, 0, 0, 0, 0, 30, false, L, noop);
    if (r.health !== 'error') bad('the older rule broke: brands failed, nothing updated, still "ok".');
  }
  // the per-lane counts must actually be collected and reported
  if (!/laneTotals/.test(src)) bad('api/pull-trends-cron.js still discards `items.lanes`, so nobody can tell which source died.');
  // Must be IN the object the heartbeat is given. An earlier alternation here was satisfied by the
  // heartbeat call alone, so deleting the lane counts escaped.
  const metaObj = (src.match(/const _meta = \{[\s\S]*?\};/) || [])[0] || '';
  if (!metaObj) bad('api/pull-trends-cron.js no longer builds a heartbeat meta object.');
  else if (!/lanes:/.test(metaObj)) {
    bad('the per-lane counts never reach the heartbeat, so a recorded bad run still cannot say ' +
        'WHICH source died. They are the difference between "Apify is down" and "Grok is down".');
  }
  if (!/heartbeat\('pull-trends-cron', _health, _meta\)/.test(src)) bad('the heartbeat is not given the meta object.');
}

// ── 3. DERIVED: no silent exit in either search function ────────────────────────────────────
for (const [file, fnName, sig] of [['api/_llm.js', 'callGrokSearch', 'callGrokSearch(prompt'],
                                   ['api/_trends.js', 'pullGrokTrends', 'function pullGrokTrends(']]) {
  const src = read(file);
  const start = src.indexOf(sig);
  if (start < 0) { bad(`${fnName} is gone from ${file}.`); continue; }
  const body = src.slice(start, src.indexOf('\n}', start));
  const lines = body.split('\n');
  lines.forEach((l, i) => {
    if (/^\s*(\/\/|\*)/.test(l)) return;                       // comments
    const bails = /\bresolve\(null\)|\breturn \[\]|\breturn null/.test(l);
    if (!bails) return;
    // A log in the same statement, or an explicit note that the callee already logged.
    const near = (lines[i - 1] || '') + l;
    if (!/console\.(error|log)|already (said|logged)/.test(near)) {
      bad(`${file} ${fnName}: a silent exit at line +${i} — ${l.trim().slice(0, 100)}. ` +
          'A lane that returns nothing with no log is indistinguishable from a quiet day, forever.');
    }
  });
}

if (fails.length) {
  console.error('FAIL:');
  fails.forEach(f => console.error('  - ' + f));
  process.exit(1);
}
console.log('connections honesty verified: an unfinished scrape is never reported as the user\'s profile ' +
            'being private, a run where every source went silent heartbeats "error" with per-lane counts, ' +
            'and neither search function has a silent exit left.');
console.log('PASS');
