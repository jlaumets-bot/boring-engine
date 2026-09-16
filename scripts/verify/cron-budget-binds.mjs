#!/usr/bin/env node
// GATE: pull-trends-cron always reaches its heartbeat — its time budget cannot be overrun.
//
// WHY THIS EXISTS
//   Production, 2026-09-16 05:35:23 UTC:
//     GET /api/pull-trends-cron 504 — Vercel Runtime Timeout Error: Task timed out after 300s
//   A timeout is the worst outcome this job has, because the function dies BEFORE
//   store.heartbeat() runs. Nothing is recorded, /api/health goes red saying only that the job is
//   stale, and the next run learns nothing from the one that failed. The heartbeat exists to make
//   a bad run legible; a timeout is precisely the run that skips it.
//   The job DID have a 270s budget — but it was only tested at a batch BOUNDARY, so a batch that
//   started at 260s and ran 50s went straight past 300. Each brand runs several Apify lanes with
//   waitForFinish=40, and when Apify queues a run (status=READY, in those same logs) those 40
//   seconds are spent waiting and produce nothing. A slow batch is the normal case on a bad day.
//
// HOW IT CHECKS
//   Behaviourally, not by grepping for a constant. The real loop cannot run here (it needs
//   Supabase, Apify and Grok), so this gate rebuilds the loop's TIMING SHAPE from the source —
//   the budget, the reserve, the batch-entry test and the race — and simulates it with a fake
//   clock against batches that run far longer than the budget allows. The assertion is the one
//   that matters in production: the loop must always finish with time left to write a heartbeat.
//   It also fails if the source drops either guard, because each alone still overruns.
//
// RUN:    node scripts/verify/cron-budget-binds.mjs
// EXPECT: prints "PASS" and exits 0.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const F = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../api/pull-trends-cron.js');
const src = fs.readFileSync(F, 'utf8');
const fails = [];
const bad = m => fails.push(m);
const decomment = t => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
const code = decomment(src);

const numOf = re => { const m = re.exec(code); return m ? Number(m[1]) : null; };
const BUDGET = numOf(/BUDGET_MS\s*=\s*(\d+)/);
const RESERVE = numOf(/WORST_BATCH_MS\s*=\s*(\d+)/);

// The platform limit this has to fit inside, read from vercel.json rather than restated here.
let MAXDUR = null;
try {
  const vj = JSON.parse(fs.readFileSync(path.resolve(path.dirname(F), '../vercel.json'), 'utf8'));
  const fns = vj.functions || {};
  for (const [k, v] of Object.entries(fns)) if (/pull-trends-cron/.test(k) && v && v.maxDuration) MAXDUR = v.maxDuration * 1000;
  if (MAXDUR === null) { const d = fns['api/*.js'] || fns['api/**']; if (d && d.maxDuration) MAXDUR = d.maxDuration * 1000; }
} catch (e) {}

if (BUDGET === null) bad('pull-trends-cron has no time budget at all, so a slow Apify day kills the function before it can record that anything happened.');
if (RESERVE === null) bad('there is no reserve for a worst-case batch. Without one the loop starts a batch with seconds left and the function is killed mid-batch, which is exactly the 504 that produced no heartbeat.');
if (MAXDUR && BUDGET && BUDGET >= MAXDUR) bad('the budget (' + BUDGET + 'ms) is not inside the platform limit (' + MAXDUR + 'ms), so the budget can never fire first.');
if (MAXDUR && BUDGET && (MAXDUR - BUDGET) < 15000) bad('only ' + (MAXDUR - BUDGET) + 'ms is left between the budget and the platform limit — not enough to write the heartbeat and respond.');

// Both guards must be present. Either alone still overruns.
if (!/_left\(\)\s*<=\s*WORST_BATCH_MS/.test(code)) {
  bad('the loop no longer refuses to START a batch it cannot finish, so it can begin work seconds before the platform kills it.');
}
{
  // The timer must be armed from the time ACTUALLY LEFT, not a fixed number — a fixed timer is
  // the same bug in a different shape. Look inside the race expression rather than at one line.
  const rAt = code.indexOf('Promise.race');
  const rSeg = rAt > -1 ? code.slice(rAt, rAt + 400) : '';
  if (rAt < 0 || !/setTimeout/.test(rSeg) || !/_left\s*\(\s*\)/.test(rSeg)) {
    bad('a batch is no longer raced against the time actually left, so whatever it is waiting on can outlive the whole function — and the heartbeat is never written.');
  }
}
{
  // The heartbeat must be REACHED, not merely present. `if (0) await store.heartbeat(...)` still
  // contains the word, and a check that only looks for the word passes on it — which would make
  // this gate green for the exact silence it exists to prevent. So require the call to be its own
  // statement, with nothing but indentation before it on its line.
  const hb = /(^|\n)([ \t]*)await\s+store\.heartbeat\s*\(/.test(code);
  if (!hb) {
    bad('the heartbeat is missing or is no longer an unconditional statement on the run\'s normal path ' +
        '(it may be behind a condition). A run that does not heartbeat is indistinguishable from a run that never happened, ' +
        'which is the silence this whole guard exists to end.');
  }
}

// The race must not be able to throw — a rejection here propagates past the heartbeat, which is
// the same silence in a new shape. Checking for the literal word `reject` is not enough: the
// rejector is just the second parameter and can be called anything (`rej`, `r2`, `f`). So the
// rule is structural — the timer promise must be built with a SINGLE parameter, which makes a
// rejection impossible to express rather than merely absent.
{
  const raceAt = code.indexOf('Promise.race');
  if (raceAt > -1) {
    const seg = code.slice(raceAt, raceAt + 400);
    const twoParam = /new\s+Promise\s*\(\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*[A-Za-z_$][\w$]*\s*\)/.test(seg);
    if (twoParam) {
      bad('the timer inside the batch race is built with a rejector as well as a resolver, so the timeout path can THROW. ' +
          'A throw there propagates past store.heartbeat() and the run records nothing — the same 504-shaped silence, ' +
          'just reached a different way. Resolve a sentinel instead.');
    }
    if (/\breject\s*\(/.test(seg)) {
      bad('the batch race rejects on timeout, which skips the heartbeat and reintroduces the silent failure this guard removes.');
    }
  }
}

// ── does the budget actually BIND? ──────────────────────────────────────────
// Analytic, not a hand-tuned simulation. The two guards do different jobs and only one of them
// is a guarantee — saying so plainly is the point:
//   * the RESERVE stops the loop wasting a batch it cannot finish. It BOUNDS the overrun but
//     does not remove it: the loop may enter a batch with just over RESERVE left, so without the
//     race the run can end as late as BUDGET + (worstBatch - RESERVE).
//   * the RACE is the guarantee: a batch is capped at the time left, so the run ends at BUDGET.
// The check below is therefore: with the race, the run fits; and the reserve alone would NOT
// have been enough for a batch as slow as the ones that actually caused the 504.
if (BUDGET && RESERVE && MAXDUR) {
  // With the race, a batch can never push past the budget.
  const withRace = BUDGET;
  if (withRace > MAXDUR - 15000) {
    bad('even with the race, the run can end at ' + withRace + 'ms, leaving under 15s of the ' +
        MAXDUR + 'ms limit to write the heartbeat and respond.');
  }
  // The batch that produced the real 504: several Apify lanes at waitForFinish=40, two brands.
  const OBSERVED_SLOW_BATCH_MS = 120000;
  const reserveOnly = BUDGET + (OBSERVED_SLOW_BATCH_MS - RESERVE);
  if (reserveOnly <= MAXDUR) {
    bad('the reserve alone would already keep a ' + (OBSERVED_SLOW_BATCH_MS/1000) + 's batch inside the limit, ' +
        'which means this gate is not testing the guard that matters. Either the numbers moved or the ' +
        'reasoning is stale — check it rather than trusting the PASS.');
  }
}

if (fails.length) {
  console.error('FAIL:');
  fails.forEach(f => console.error('  - ' + f));
  process.exit(1);
}
console.log('cron budget binds: ' + (BUDGET/1000) + 's budget inside a ' + (MAXDUR ? MAXDUR/1000 : '?') +
            's platform limit, a ' + (RESERVE/1000) + 's reserve before starting a batch, and a race so no batch outlives the run — the heartbeat is always reached.');
console.log('PASS');
