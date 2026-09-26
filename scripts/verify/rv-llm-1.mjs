#!/usr/bin/env node
// GATE rv-llm-1 (v690 review): endpoints that make more than one timed wait keep the WHOLE
// request inside its budget — proved by RUNNING the real handlers, not by reading numbers.
//
//   remix.js       — the clean-JSON retry used to get a second full 280s deadline (530s worst case
//                    against 300s). Both tries must now fit ONE 280s budget from handler start.
//   crawl-social.js — the AI leg's deadline was a flat 280s from after Apify, so the retry loop
//                    could run far past FN_BUDGET_MS. It must be what is LEFT of that budget.
//                    Also: captions split mid-letter across network chunks must arrive intact.
//
// The clock is faked (Date.now is offset) so "Apify took 70s" and "the first AI call took 250s"
// cost nothing in real time. callLLM is replaced by a recorder; auth and metering are stubbed.
// RUN: node scripts/verify/rv-llm-1.mjs      EXPECT: "PASS", exit 0.
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import Module from 'node:module';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = path.join(ROOT, 'api');
const WALL = setTimeout(() => { console.log('FAIL: rv-llm-1 wall clock (30s) — something hung'); process.exit(1); }, 30000);
let failed = 0;
const ok = (c, m) => { if (c) console.log('ok: ' + m); else { console.log('FAIL: ' + m); failed++; } };

// ── fake clock ──
const realNow = Date.now.bind(Date);
let skew = 0, guardCostMs = 0;
Date.now = () => realNow() + skew;

// ── stubbed modules ──
function stub(rel, exports) {
  const file = require_.resolve(path.join(API, rel));
  const m = new Module(file); m.filename = file; m.loaded = true; m.exports = exports;
  require_.cache[file] = m;
}
let llmCalls = [], llmPlan = null;
const t0Box = { t0: 0 };
stub('_llm.js', {
  callLLM: async (opts) => { const i = llmCalls.length; llmCalls.push({ at: Date.now() - t0Box.t0, deadlineMs: opts.deadlineMs, timeoutMs: opts.timeoutMs, prompt: opts.messages && opts.messages.map(m => m.content).join('\n') }); return llmPlan(i, opts); },
  aiUnavailable: (e) => (e && e.code === 'AI_UNAVAILABLE') ? { status: 503, body: { error: 'x', code: 'AI_UNAVAILABLE' } } : null,
  callGrokSearch: async () => null,
});
stub('_usage.js', {
  // v690 r2 — the guard's own Supabase reads take time BEFORE the loop; remix's budget must count
  // them (it is measured from handler start, not from the first AI call).
  guard: async () => { skew += guardCostMs; return { user: { id: 'u-test' }, over: false }; },
  denyResponse: (res) => res.status(402).json({ error: 'denied' }),
  logUsage: async () => {},
});
stub('_safeurl.js', { assertPublicHttpUrl: async () => true });

function fakeRes() {
  return { statusCode: 0, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, end() { return this; } };
}
const post = (body) => ({ method: 'POST', headers: { origin: 'https://contentshrimp.com' }, body });

// ── remix ────────────────────────────────────────────────────────────────────
const remix = require_(path.join(API, 'remix.js'));
const GOOD_REMIX = JSON.stringify({ remixTitle: 't', remixHook: 'h', remixScript: 's', remixFormat: 'video' });
async function runRemix(firstCallCostsMs, firstReply) {
  llmCalls = []; skew = 0; guardCostMs = 5000; t0Box.t0 = Date.now();
  llmPlan = (i) => { if (i === 0) { skew += firstCallCostsMs; return firstReply; } return GOOD_REMIX; };
  const res = fakeRes();
  await remix(post({ postDescription: 'a post about mornings', creatorName: 'c', platform: 'tiktok' }), res);
  return res;
}
{
  const res = await runRemix(250000, 'not json at all');
  const over = llmCalls.filter(c => c.at + c.deadlineMs > 280000 + 50);
  ok(llmCalls.length >= 1 && over.length === 0,
     'remix: first reply unparseable after 250s — every AI call ends inside ONE 280s budget (' +
     llmCalls.map(c => 'start ' + c.at + 'ms + deadline ' + c.deadlineMs + 'ms').join('; ') + ')');
  ok(llmCalls.length === 2 && res.statusCode === 200, 'remix: and the clean-JSON retry still runs when 30s are left (calls=' + llmCalls.length + ', status=' + res.statusCode + ')');
}
{
  const res = await runRemix(270000, 'still not json');
  ok(llmCalls.length === 1 && res.statusCode === 500, 'remix: with 10s left the retry is skipped and the honest parse error returns (calls=' + llmCalls.length + ', status=' + res.statusCode + ')');
}
{
  const res = await runRemix(2000, GOOD_REMIX);
  ok(llmCalls.length === 1 && res.statusCode === 200 && llmCalls[0].at + llmCalls[0].deadlineMs <= 280000 + 50 && llmCalls[0].deadlineMs > 270000,
     'remix opposite: a good first reply makes one call with (nearly) the whole budget (deadline ' + (llmCalls[0] && llmCalls[0].deadlineMs) + ')');
}

// ── crawl-social ─────────────────────────────────────────────────────────────
process.env.APIFY_API_TOKEN = 'test-only-not-a-real-token';
const https = require_('https');
let apifyCostMs = 0;
const CAPTION = 'Tõeline hommik algab kohviga ja ausa jutuga';
https.request = (opts, cb) => {
  const req = new EventEmitter();
  req.write = () => {}; req.setTimeout = () => req; req.destroy = () => {};
  req.end = () => setImmediate(() => {
    const resp = new EventEmitter(); resp.statusCode = 200; resp.headers = { 'content-type': 'application/json' };
    cb(resp);
    if (/\/runs/.test(opts.path)) {
      skew += apifyCostMs;                                  // the scrape "took" this long
      resp.emit('data', Buffer.from(JSON.stringify({ data: { id: 'run1', status: 'SUCCEEDED', defaultDatasetId: 'ds1' } })));
    } else {
      const items = Buffer.from(JSON.stringify([1, 2, 3, 4, 5].map(i => ({ caption: CAPTION + ' #' + i }))));
      const cut = items.indexOf(Buffer.from('õ')) + 1;       // inside the two bytes of "õ"
      resp.emit('data', items.subarray(0, cut)); resp.emit('data', items.subarray(cut));
    }
    resp.emit('end');
  });
  return req;
};
const cs = require_(path.join(API, 'crawl-social.js'));
const FN_BUDGET = 96000;
async function runCs(costMs) {
  llmCalls = []; skew = 0; guardCostMs = 0; apifyCostMs = costMs; t0Box.t0 = Date.now();
  llmPlan = () => JSON.stringify({ tones: ['casual'], brandVocab: 'x', ctaStyle: 'y', exampleContent: 'z' });
  const res = fakeRes();
  await cs(post({ url: 'https://www.instagram.com/someone' }), res);
  return res;
}
{
  const res = await runCs(70000);
  const c = llmCalls[0];
  ok(res.statusCode === 200 && c && c.at + c.deadlineMs <= FN_BUDGET + 50,
     'crawl-social: Apify took 70s — the AI leg\'s deadline ends by the 96s function budget (starts ' + (c && c.at) + 'ms, deadline ' + (c && c.deadlineMs) + 'ms)');
  ok(c && c.timeoutMs <= c.deadlineMs, 'crawl-social: one attempt fits its own deadline (timeout ' + (c && c.timeoutMs) + ' <= deadline ' + (c && c.deadlineMs) + ')');
  ok(c && c.prompt.indexOf(CAPTION) !== -1 && c.prompt.indexOf('�') === -1, 'crawl-social: a caption split mid-letter across network chunks reaches the model intact');
}
{
  const res = await runCs(1000);
  const c = llmCalls[0];
  ok(res.statusCode === 200 && c && c.deadlineMs > 90000 && c.deadlineMs <= FN_BUDGET, 'crawl-social opposite: a fast scrape leaves the AI leg (nearly) the whole budget (deadline ' + (c && c.deadlineMs) + ')');
}

Date.now = realNow;
clearTimeout(WALL);
if (failed) { console.log(failed + ' failure(s)'); process.exit(1); }
console.log('PASS — rv-llm-1: remix and crawl-social keep every AI call inside the request budget');
process.exit(0);
