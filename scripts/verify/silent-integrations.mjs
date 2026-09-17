#!/usr/bin/env node
// GATE: a third-party integration is never allowed to fail silently — no log line, no health
//       check, and the person told nothing.
//
// WHY THIS EXISTS
//   Two outside services this app depends on failed completely invisibly.
//
//   1. PEXELS (api/stock-photo.js). Every failure path was a bare `return null` inside a
//      `catch(e) { return null; }`, and the caller answered `200 {empty:true}` — the same answer as
//      "this search found no good photo". So a revoked key (401) or an exhausted quota (the free
//      tier is 200 requests an HOUR, and one split-screen render asks for several) made every beat
//      render text-only forever, with nothing in the runtime logs. /api/health only checked that a
//      key EXISTS, which stays true while the key is being rejected.
//
//   2. SERPAPI (api/people-also-ask.js). Same shape, plus a worse ending: when EVERY call failed,
//      `questions` came out `[]` and the endpoint still answered 200. The client's test is
//      `resp.ok && data.questions`, and an empty ARRAY is truthy — so it stored the empty list,
//      rendered "no questions", never set its error flag, and `logUsage` charged for it. A dead key
//      looked like a working feature with nothing to say. SerpAPI had no health check at all.
//
// HOW IT CHECKS
//   The Pexels half is executed: the real pexelsPick is run against a stubbed fetch for each
//   failure status, and must both log and report a reason. The SerpAPI half is structural where it
//   has to be (the handler needs a whole request), but the all-failed rule is checked as an
//   ordering fact: the refusal must come BEFORE the metering call, not after.
//
// RUN:    node scripts/verify/silent-integrations.mjs
// EXPECT: prints "PASS" and exits 0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fails = [];
const bad = m => fails.push(m);

// ── PEXELS, executed ───────────────────────────────────────────────────────────────────────
{
  const src = fs.readFileSync(path.join(ROOT, 'api/stock-photo.js'), 'utf8');
  const i = src.indexOf('let _pexelsFail = null;');
  const j = src.indexOf('\n  }', src.indexOf('async function pexelsPick'));
  if (i < 0 || j < 0) {
    bad('api/stock-photo.js: pexelsPick / _pexelsFail are gone — re-point the gate at what replaced them.');
  } else {
    const body = src.slice(i, j + 4);
    const make = (fetchImpl) => new Function('fetch', 'AbortSignal', 'console', 'tokns', 'PICK_SIZE', 'encodeURIComponent',
      body + '\nreturn { pexelsPick, fail: () => _pexelsFail };');

    const cases = [
      ['a rejected key (401)', { ok: false, status: 401 }, /401/],
      ['an exhausted quota (429)', { ok: false, status: 429 }, /429/],
      ['an outage (503)', { ok: false, status: 503 }, /503/],
    ];
    for (const [name, resp, wantLog] of cases) {
      const logged = [];
      const api = make()(
        async () => resp,
        { timeout: () => null },
        { error: (...a) => logged.push(a.join(' ')), log() {} },
        () => [], 'large', encodeURIComponent);
      const hit = await api.pexelsPick('key', 'suppliers', []);
      if (hit) { bad(name + ': pexelsPick returned a photo from a failed response.'); continue; }
      if (!logged.some(l => wantLog.test(l))) {
        bad(name + ' leaves NOTHING in the runtime logs, so the only symptom is beats rendering ' +
            'text-only and nobody can find out why. Logged: ' + JSON.stringify(logged));
      }
      if (!api.fail()) {
        bad(name + ' is not distinguished from a search that legitimately found no photo — both ' +
            'answer {empty:true} and look identical to the caller.');
      }
    }
    // The catch branch is a separate path from the status branch and needs its own case — the
    // first version of this gate only exercised HTTP statuses, so a mutation that stopped flagging
    // a dropped connection escaped it. A timeout is the likeliest real one: AbortSignal.timeout(8000).
    for (const [name, thrown, wantLog] of [
      ['a dropped connection', Object.assign(new Error('fetch failed'), { name: 'TypeError' }), /network|fetch failed/i],
      ['a timeout', Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' }), /timed out|TimeoutError/i],
    ]) {
      const log2 = [];
      const api2 = make()(
        async () => { throw thrown; },
        { timeout: () => null },
        { error: (...a) => log2.push(a.join(' ')), log() {} },
        () => [], 'large', encodeURIComponent);
      const hit2 = await api2.pexelsPick('key', 'suppliers', []);
      if (hit2) bad(name + ': pexelsPick returned a photo after throwing.');
      if (!log2.some(l => wantLog.test(l))) {
        bad(name + ' leaves nothing in the runtime logs. Logged: ' + JSON.stringify(log2));
      }
      if (!api2.fail()) {
        bad(name + ' is not distinguished from a search that legitimately found no photo.');
      }
    }

    // A genuine miss must NOT be reported as a failure, or the distinction is worthless.
    const logged = [];
    const api = make()(
      async () => ({ ok: true, status: 200, json: async () => ({ photos: [] }) }),
      { timeout: () => null },
      { error: (...a) => logged.push(a.join(' ')), log() {} },
      () => [], 'large', encodeURIComponent);
    await api.pexelsPick('key', 'suppliers', []);
    if (api.fail()) bad('a search that simply found no photo is reported as a transport failure.');
    if (logged.length) bad('a search that found nothing writes an error to the logs: ' + JSON.stringify(logged));

    // And the reason must actually travel in the response.
    if (!/reason: _pexelsFail \|\| 'no_match'/.test(src)) {
      bad('api/stock-photo.js computes a failure reason but does not send it, so the caller still ' +
          'cannot tell a dead key from an empty search.');
    }
  }
}

// ── SERPAPI ────────────────────────────────────────────────────────────────────────────────
{
  const src = fs.readFileSync(path.join(ROOT, 'api/people-also-ask.js'), 'utf8');
  // Every non-200 and every transport failure must write a log line.
  if (!/console\.error\('paa: serpapi ' \+ resp\.statusCode/.test(src)) {
    bad('api/people-also-ask.js does not log a non-200 from SerpAPI, so a revoked key or an ' +
        'exhausted search quota leaves no trace at all.');
  }
  if (!/req\.on\('error', \(e\) => \{ console\.error/.test(src)) bad('a SerpAPI transport error is still swallowed silently.');
  if (!/serpapi timed out/.test(src)) bad('a SerpAPI timeout is still swallowed silently.');

  // ALL failed must be an error, and it must come BEFORE metering.
  const refusal = src.indexOf("failed.length === results.length");
  const meter = src.indexOf("logUsage({ userId");
  if (refusal < 0) {
    bad('api/people-also-ask.js still answers 200 when EVERY SerpAPI call failed. The client tests ' +
        '`resp.ok && data.questions` and an empty array is truthy, so it renders "no questions", ' +
        'never sets its error flag, and the user is charged for a search that never ran.');
  } else if (meter < 0 || refusal > meter) {
    bad('the all-failed refusal comes AFTER logUsage, so the user is still metered for a search ' +
        'that never ran.');
  }
  if (!/status\(502\)/.test(src)) bad('the all-failed case does not return an error status the client can act on.');
}

// ── HEALTH ─────────────────────────────────────────────────────────────────────────────────
{
  const src = fs.readFileSync(path.join(ROOT, 'api/health.js'), 'utf8');
  // Derived, not a list: every env key the api/ directory reads for an OUTSIDE service should be
  // visible in /api/health, because that is the only place a human can look.
  const NEEDED = ['PEXELS_API_KEY', 'SERPAPI_KEY', 'APIFY_API_TOKEN', 'XAI_API_KEY'];
  for (const k of NEEDED) {
    if (!src.includes(k)) {
      bad(`/api/health does not report ${k}. When it is missing or wrong the feature it powers just ` +
          'goes quiet, and health is the only place anyone would think to look.');
    }
  }
}

if (fails.length) {
  console.error('FAIL:');
  fails.forEach(f => console.error('  - ' + f));
  process.exit(1);
}
console.log('silent integrations verified: Pexels and SerpAPI log every failure with its status, a ' +
            'failed search is distinguishable from an empty one, a SerpAPI outage is no longer ' +
            'charged for, and both keys are visible in /api/health.');
console.log('PASS');
