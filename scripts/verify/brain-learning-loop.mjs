#!/usr/bin/env node
// GATE: the brand brain keeps learning — and never marks a lesson learned that it did not learn.
//
// WHY THIS EXISTS
//   Two failures that both END learning silently, with nothing on screen to say so.
//
//   1. THE COUNTER STOPPED GROWING. brainAutoDistill fires when `since >= 4`, where
//      `since = total - brain_last_distill_count` and `total` counts, among other things,
//      `edit_signals.length`. saveEditSignals caps that list at the newest 60. So at 60 lifetime
//      edits `total` is pinned at its ceiling, `since` can never reach 4 again, and the brain stops
//      learning FOREVER — on exactly the accounts using the app the most.
//
//   2. A FAILED DISTILL ATE THE SIGNALS. The watermark advanced as soon as a response arrived,
//      before anything checked whether it contained rules. A 402 (over the plan limit) or a 5xx
//      therefore marked those edits as already-learned and they were never revisited. The work
//      someone did while over their limit was burned.
//
// HOW IT CHECKS
//   By EXECUTING the real brainCountNewSignals, saveEditSignals and brainAutoDistill out of
//   app.html against a fake localStorage and a fake fetch — so the loop is actually run, not
//   pattern-matched. Each assertion is written to fail against the code as it was.
//
// RUN:    node scripts/verify/brain-learning-loop.mjs
// EXPECT: prints "PASS" and exits 0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const fails = [];
const bad = m => fails.push(m);

// ── pull the three real functions out of app.html ─────────────────────────────
function extractFn(name) {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in app.html`);
  const from = html.slice(Math.max(0, start - 6), start) === 'async ' ? start - 6 : start;
  let i = html.indexOf('{', start), depth = 0, q = null;
  for (; i < html.length; i++) {
    const c = html[i], p = html[i - 1];
    if (q) { if (c === q && p !== '\\') q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '/' && html[i + 1] === '/') { i = html.indexOf('\n', i); continue; }
    if (c === '/' && html[i + 1] === '*') { i = html.indexOf('*/', i) + 1; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return html.slice(from, i + 1);
  }
  throw new Error(`${name}: unbalanced braces`);
}

function makeWorld(opts) {
  opts = opts || {};
  const LS = Object.assign({}, opts.ls);
  const fetchLog = [];
  const env = {
    lsGet: k => (k in LS ? LS[k] : null),
    lsSet: (k, v) => { LS[k] = String(v); },
    state: opts.state || [],
    settings: { coachNotes: '', brandName: 'Acme' },
    currentBrand: { id: 'b1' },
    sb: null,
    brandGate: () => () => true,
    saveSettings: () => {},
    showToast: () => {},
    window: { _brainReviewOpen: false },
    console: { error() {}, log() {} },
    fetch: async (url, init) => { fetchLog.push(url); return opts.response(); },
    JSON, Date, Math, Array, String, Object, Number, Promise, setTimeout,
  };
  const src = [
    extractFn('brainCountNewSignals'),
    extractFn('saveEditSignals'),
    extractFn('brainAutoDistill'),
    'const BRAIN_RULES_SOFT_CAP = ' + (html.match(/BRAIN_RULES_SOFT_CAP\s*=\s*(\d+)/) || [, 60])[1] + ';',
    'let _brainAutoRunning = false;',
    'return { brainCountNewSignals, saveEditSignals, brainAutoDistill };',
  ].join('\n');
  const keys = Object.keys(env);
  const api = new Function(...keys, src)(...keys.map(k => env[k]));
  return { api, LS, fetchLog, env };
}

// ── 1. the counter must keep rising past the stored-list cap ──────────────────
{
  const w = makeWorld({ response: () => ({ ok: true, json: async () => ({ rules: [] }) }) });
  for (let i = 0; i < 100; i++) w.api.saveEditSignals([{ ts: i, format: 'video', field: 'script', before: 'a', after: 'b' + i }]);
  const stored = JSON.parse(w.LS.edit_signals || '[]').length;
  const counted = w.api.brainCountNewSignals().total;
  if (!(stored < 100)) bad('the fixture is not exercising the cap — the stored signal list did not saturate, so this proves nothing.');
  if (counted < 100) {
    bad(`after 100 edits the brain counts only ${counted} (the stored list holds ${stored}). ` +
        '`since` can never reach the threshold again, so auto-learning is off permanently on any ' +
        'account past that many edits.');
  }
  // And `since` must still be able to clear the threshold after a distill.
  w.LS.brain_last_distill_count = String(counted);
  for (let i = 0; i < 5; i++) w.api.saveEditSignals([{ ts: 999 + i, format: 'video', field: 'script', before: 'a', after: 'z' + i }]);
  if (w.api.brainCountNewSignals().since < 4) {
    bad('five fresh edits after a distill do not add up to a `since` of 4, so the brain will not ' +
        'run again no matter how much the person teaches it.');
  }
}

// ── 2. a distill that produced nothing must not consume the signals ───────────
const runDistill = async (response) => {
  const w = makeWorld({
    response,
    ls: { brain_edit_total: '40', brain_last_distill_count: '0', brain_last_distill_time: '0' },
    state: [],
  });
  const before = w.LS.brain_last_distill_count;
  await w.api.brainAutoDistill();
  return { w, before, after: w.LS.brain_last_distill_count, time: w.LS.brain_last_distill_time };
};

let r = await runDistill(() => ({ ok: false, status: 402, json: async () => ({ error: 'limit_reached' }) }));
if (!r.w.fetchLog.length) bad('the fixture never reached the distill call, so the checks below prove nothing.');
if (r.after !== r.before) {
  bad('a 402 (over the plan limit) still advanced the learned-up-to watermark from ' + r.before + ' to ' +
      r.after + '. Every edit made while over the limit is marked learned and never looked at again.');
}
if (r.time === '0') {
  bad('a failed distill did not advance the cooldown, so a consistently failing endpoint is ' +
      're-called on every render.');
}

r = await runDistill(() => ({ ok: true, status: 200, json: async () => ({ error: 'bad output' }) }));
if (r.after !== r.before) {
  bad('a 200 with no `rules` array still advanced the watermark from ' + r.before + ' to ' + r.after + '.');
}

r = await runDistill(() => ({ ok: true, status: 200, json: async () => ({ rules: [{ rule: 'Write short sentences.' }] }) }));
if (r.after === r.before) {
  bad('a SUCCESSFUL distill did not advance the watermark, so the same signals are distilled ' +
      'over and over and every run costs a model call.');
}

if (fails.length) {
  console.error('FAIL:');
  fails.forEach(f => console.error('  - ' + f));
  process.exit(1);
}
console.log('brand-brain learning loop verified: the signal count keeps rising past the stored-list cap, ' +
            'and only a distill that actually returned rules marks those signals as learned.');
console.log('PASS');
