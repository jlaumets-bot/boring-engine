#!/usr/bin/env node
// GATE: when xAI REFUSES our account, the user is told the truth — once, fast, without retries.
//
// WHY THIS EXISTS
//   2026-09-25 05:35: every Grok call answered 403 "Your team ... has either used all available
//   credits or reached its monthly spending limit". callXAI treated that like any other error and
//   callLLM threw "The AI is having a moment ... Please try again in a few seconds." Retrying in
//   seconds can never fix an empty account, so every user was told to do something useless.
//
// HOW IT CHECKS
//   It RUNS the real api/_llm.js with https.request replaced by an in-memory xAI:
//   - 403 with the real credit message  → callLLM throws code AI_UNAVAILABLE after ONE request,
//     and aiUnavailable(err) gives 503 + { code:'AI_UNAVAILABLE', error: <no "few seconds"> }.
//   - 401 and 402 behave the same.
//   - 500 (a real blip) is still retried and still ends in the ordinary error (not AI_UNAVAILABLE).
//   - 200 still returns the text.
//   - aiUnavailable() of an ordinary error is null (it must not swallow other failures).
//   ENDPOINT ARM (v690): the REAL endpoint handlers, loaded with only auth/metering stubbed and
//   the same in-memory xAI, answer a refused account with 503 + code AI_UNAVAILABLE — including
//   the ones whose inner try/catch used to swallow it (hook-frame, sharpen) and reviews.js, which
//   only uses the web search. The opposite arm: an ordinary xAI error (400) is NOT reported as
//   AI_UNAVAILABLE by any of them, and people-also-ask (AI is only its filter) still answers 200.
//   Prints "ENDPOINT ARM OK" when every handler behaves.
//
// RUN:    node scripts/verify/ai-unavailable-honest.mjs
// EXPECT: prints "PASS" and exits 0.
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

process.env.XAI_API_KEY = 'test-only-not-a-real-key';
const https = require_('https');
let plan = []; let calls = 0;
// Anything that is not api.x.ai (a thumbnail, Apify, SerpAPI, a web page) gets a plausible answer,
// so an endpoint reaches its AI call exactly as it would in production.
function otherHost(opts, cb) {
  setImmediate(() => {
    const resp = new EventEmitter(); resp.statusCode = 200; resp.headers = {};
    const host = String(opts.hostname || ''), p = String(opts.path || '');
    let body;
    if (host === 'i.ytimg.com') { resp.headers['content-type'] = 'image/jpeg'; body = Buffer.alloc(4000, 7); }
    else if (host === 'api.apify.com') {
      resp.headers['content-type'] = 'application/json';
      body = /\/runs/.test(p) ? JSON.stringify({ data: { id: 'r1', status: 'SUCCEEDED', defaultDatasetId: 'd1' } })
        : JSON.stringify([1, 2, 3, 4, 5].map(i => ({ caption: 'Morning coffee done properly, post ' + i })));
    } else if (/serpapi/.test(host)) {
      resp.headers['content-type'] = 'application/json';
      body = JSON.stringify({ related_questions: [1, 2, 3, 4, 5, 6].map(i => ({ question: 'How do I brew coffee ' + i + '?' })) });
    } else {
      resp.headers['content-type'] = 'text/html';
      body = '<html><head><title>Acme Coffee</title></head><body><h1>Acme Coffee</h1>' + '<p>Acme roasts small-batch coffee for home brewers in Tallinn. </p>'.repeat(40) + '</body></html>';
    }
    let enc = null; resp.setEncoding = (e) => { enc = e; return resp; }; resp.resume = () => resp;
    cb(resp); const buf = Buffer.isBuffer(body) ? body : Buffer.from(body); resp.emit('data', enc ? buf.toString(enc) : buf); resp.emit('end');
  });
}
https.request = (opts, cb) => {
  const req = new EventEmitter();
  req.setTimeout = () => req; req.write = () => {}; req.destroy = (e) => { if (e) req.emit('error', e); };
  req.end = () => {
    if (opts && opts.hostname && opts.hostname !== 'api.x.ai') return otherHost(opts, cb);
    calls++;
    const [status, body] = plan.length > 1 ? plan.shift() : plan[0];
    setImmediate(() => {
      const resp = new EventEmitter(); resp.statusCode = status; resp.headers = { 'content-type': 'application/json' };
      cb(resp);
      resp.emit('data', JSON.stringify(body)); resp.emit('end');
    });
  };
  return req;
};
// https.get / http.* do NOT go through the exported https.request, so without these the endpoint
// arm would reach the real internet (SerpAPI, Jina). Nothing here may leave the machine.
const toOpts = (a, b) => {
  if (typeof a === 'string' || a instanceof URL) { const u = new URL(String(a)); return Object.assign({ hostname: u.hostname, path: u.pathname + u.search }, (b && typeof b === 'object') ? b : {}); }
  return a || {};
};
https.get = (a, b, c) => { const cb = typeof b === 'function' ? b : c; const r = https.request(toOpts(a, b), cb); r.end(); return r; };
const http = require_('http');
http.request = (a, b, c) => { const cb = typeof b === 'function' ? b : c; const o = toOpts(a, b); const r = new EventEmitter(); r.setTimeout = () => r; r.write = () => {}; r.destroy = () => {}; r.end = () => otherHost(o, cb); return r; };
http.get = (a, b, c) => { const r = http.request(a, b, c); r.end(); return r; };
const { callLLM, aiUnavailable } = require_(path.join(ROOT, 'api', '_llm.js'));
if (typeof aiUnavailable !== 'function') { console.log('FAIL: api/_llm.js does not export aiUnavailable'); process.exit(1); }

const fails = [];
const check = (c, m) => { if (!c) fails.push(m); };
const CREDIT_403 = { code: 'permission-denied', error: 'Your team 0000 has either used all available credits or reached its monthly spending limit.' };
const msgs = [{ role: 'user', content: 'hi' }];

for (const st of [403, 401, 402]) {
  plan = [[st, CREDIT_403]]; calls = 0;
  let err = null; const t0 = Date.now();
  try { await callLLM({ messages: msgs, deadlineMs: 60000 }); } catch (e) { err = e; }
  check(err && err.code === 'AI_UNAVAILABLE', st + ': callLLM did not throw code AI_UNAVAILABLE (got ' + (err && (err.code || err.message)) + ')');
  check(calls === 1, st + ': expected exactly 1 request (a refusal must not be retried), saw ' + calls);
  check(Date.now() - t0 < 2000, st + ': refusal took ' + (Date.now() - t0) + 'ms — it waited on backoff');
  const ai = aiUnavailable(err);
  check(ai && ai.status === 503, st + ': aiUnavailable did not give status 503');
  check(ai && ai.body && ai.body.code === 'AI_UNAVAILABLE', st + ': body.code is not AI_UNAVAILABLE');
  check(ai && typeof ai.body.error === 'string' && ai.body.error.length > 20, st + ': body.error missing');
  check(ai && !/few seconds/i.test(ai.body.error), st + ': message still says "a few seconds"');
}

plan = [[500, { error: 'upstream' }]]; calls = 0;
let e500 = null;
try { await callLLM({ messages: msgs, timeoutMs: 1000, deadlineMs: 3500 }); } catch (e) { e500 = e; }   // v690: 3.5s still allows one retry, and keeps the gate fast
check(e500 && e500.code !== 'AI_UNAVAILABLE', '500: a transient error was reported as AI_UNAVAILABLE');
check(calls >= 2, '500: a transient error was not retried (calls=' + calls + ')');
check(aiUnavailable(e500) === null, '500: aiUnavailable swallowed an ordinary error');

plan = [[200, { choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }], usage: {} }]]; calls = 0;
let txt = null; try { txt = await callLLM({ messages: msgs }); } catch (e) { txt = 'THREW ' + e.message; }
check(txt === 'hello', '200: expected "hello", got ' + JSON.stringify(txt));
check(aiUnavailable(null) === null && aiUnavailable(new Error('x')) === null, 'aiUnavailable must be null for non-refusals');

// ── ENDPOINT ARM: the real handlers ─────────────────────────────────────────
{
  const WALL = setTimeout(() => { console.log('FAIL: endpoint arm wall clock (60s) — a handler hung'); process.exit(1); }, 60000);
  const Module = require_('module');
  const API = path.join(ROOT, 'api');
  const stub = (rel, exports) => {
    const file = require_.resolve(path.join(API, rel));
    const m = new Module(file); m.filename = file; m.loaded = true; m.exports = exports; require_.cache[file] = m;
  };
  stub('_usage.js', {
    guard: async () => ({ user: { id: 'u-test' }, over: false }),
    denyResponse: (res) => res.status(402).json({ error: 'denied' }),
    logUsage: async () => {}, checkLimit: async () => ({ ok: true }), creditsFor: () => 1,
    billingUserFor: async (u) => u, attachHoldRelease: () => {},
  });
  stub('_requireUser.js', async () => ({ id: 'u-test' }));
  stub('_safeurl.js', { assertPublicHttpUrl: async () => true });
  stub('_publish/store.js', { userCanAccessBrand: async () => false });
  process.env.APIFY_API_TOKEN = 'test-only-not-a-real-token';
  process.env.SERPAPI_KEY = 'test-only-not-a-real-key';
  process.env.WEB_ENRICH = 'off';
  const bc = { brandName: 'Acme Coffee', description: 'small-batch coffee roaster', targetAudience: 'home brewers', tones: ['casual'] };
  const CASES = [
    ['distill-voice', { edits: [{ field: 'hook', before: 'a', after: 'b' }, { field: 'cta', before: 'c', after: 'd' }], brandName: 'Acme' }],
    ['remix', { postDescription: 'a video about slow mornings', brandContext: bc }],
    ['settings-examples', { brandContext: bc }],
    ['expand-field', { fieldName: 'brandVocab', currentValue: 'bold coffee, slow mornings', brandContext: bc }],
    ['viral-analyze', { content: 'transcript: here is why your coffee tastes bitter', brandContext: bc }],
    ['viral-rewrite', { idea: { title: 'why coffee tastes bitter' }, angle: { angle: 'myth-bust', hook: 'It is not the beans' }, brandContext: bc }],
    ['viral-twist', { idea: { title: 'why coffee tastes bitter' }, brandContext: bc }],
    ['video-beats', { script: 'Your coffee is bitter. Here is why. Fix the grind.', brandContext: bc }],
    ['sharpen', { content: { hook: 'Coffee tips', script: 'Grind finer. Brew cooler.' }, kind: 'idea', format: 'video', brandContext: bc }],
    ['brand-voice-chat', { messages: [{ role: 'user', content: 'help me sharpen my hook' }], brandContext: bc }],
    ['generate-ideas', { brandContext: bc, count: 1 }],
    ['hook-frame', { url: 'https://www.youtube.com/watch?v=abcdefghijk' }],
    ['crawl-social', { url: 'https://www.instagram.com/acmecoffee' }],
    ['crawl-brand', { url: 'https://acme.example' }],
    ['reviews', { brandName: 'Acme Coffee', website: 'acme.example' }],
  ];
  const run = async (name, body) => {
    const h = require_(path.join(API, name + '.js'));
    const res = { statusCode: 0, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
    try { await h({ method: 'POST', headers: { origin: 'https://contentshrimp.com' }, body }, res); }
    catch (e) { res.statusCode = -1; res.body = { threw: e.message }; }
    return res;
  };
  const before = fails.length;
  for (const [name, body] of CASES) {
    plan = [[403, CREDIT_403]]; calls = 0;
    const r = await run(name, body);
    // One refused request is the whole story: an inner catch that swallows it (sharpen's critique
    // pass, hook-frame's .catch) spends a second refused call before the user hears anything.
    check(calls === 1, 'ENDPOINT ' + name + ': a refused account must stop after ONE AI request, saw ' + calls);
    check(r.statusCode === 503 && r.body && r.body.code === 'AI_UNAVAILABLE' && !/few seconds/i.test(String(r.body.error || '')),
      'ENDPOINT ' + name + ': a refused account must answer 503 + AI_UNAVAILABLE, got ' + r.statusCode + ' ' + JSON.stringify(r.body).slice(0, 160));
    plan = [[400, { error: 'bad request' }]];
    const o = await run(name, body);
    check(!(o.body && o.body.code === 'AI_UNAVAILABLE'), 'ENDPOINT ' + name + ' opposite: an ordinary xAI 400 was reported as AI_UNAVAILABLE');
  }
  // people-also-ask: the AI is only a best-effort relevance filter over real search results, so a
  // refused account must still return the search results, not an error.
  plan = [[403, CREDIT_403]];
  const paa = await run('people-also-ask', { keywords: ['coffee'], brandContext: bc });
  check(paa.statusCode === 200 && paa.body && Array.isArray(paa.body.questions) && paa.body.questions.length > 0,
    'ENDPOINT people-also-ask: a refused filter must keep the unfiltered results (got ' + paa.statusCode + ' ' + JSON.stringify(paa.body).slice(0, 120) + ')');
  // v690 r2 — every refusal status, not only 403, on the search-only endpoint.
  for (const st of [401, 402]) {
    plan = [[st, CREDIT_403]]; calls = 0;
    const r = await run('reviews', { brandName: 'Acme Coffee', website: 'acme.example' });
    check(r.statusCode === 503 && r.body && r.body.code === 'AI_UNAVAILABLE', 'ENDPOINT reviews: http ' + st + ' must answer 503 AI_UNAVAILABLE, got ' + r.statusCode + ' ' + JSON.stringify(r.body).slice(0, 120));
  }
  // v690 r2 — NO KEY (a misconfigured deploy) is not "our account hit a limit". Same 503 + code,
  // honest words; the credit-limit wording stays for a real 401/402/403.
  {
    const saved = process.env.XAI_API_KEY; delete process.env.XAI_API_KEY;
    let err = null; try { await callLLM({ messages: msgs, deadlineMs: 5000 }); } catch (e) { err = e; }
    const ai = aiUnavailable(err);
    check(err && err.code === 'AI_UNAVAILABLE' && err.refused === 'no-key', 'no-key: callLLM throws AI_UNAVAILABLE with refused=no-key (got ' + (err && (err.code + '/' + err.refused)) + ')');
    check(ai && ai.status === 503 && ai.body.code === 'AI_UNAVAILABLE' && !/limit/i.test(ai.body.error) && /Nothing is wrong with your account/.test(ai.body.error),
      'no-key: the 503 says the writer is unavailable on our side, not that a limit was hit (' + (ai && ai.body.error) + ')');
    check(err && !/limit/i.test(err.message), 'no-key: the thrown message is honest too (' + (err && err.message) + ')');
    const { callGrokSearch } = require_(path.join(ROOT, 'api', '_llm.js'));
    const m = {}; const g = await callGrokSearch('q', { meta: m });
    check(g === null && m.refused === 'no-key', 'no-key: callGrokSearch records refused=no-key like callLLM (got ' + m.refused + ')');
    const rv = await run('reviews', { brandName: 'Acme Coffee' });
    check(rv.statusCode === 503 && rv.body && rv.body.code === 'AI_UNAVAILABLE' && !/limit/i.test(rv.body.error), 'no-key: reviews answers 503 with the no-key words (got ' + rv.statusCode + ' ' + JSON.stringify(rv.body).slice(0, 140) + ')');
    process.env.XAI_API_KEY = saved;
    plan = [[403, CREDIT_403]];
    let e2 = null; try { await callLLM({ messages: msgs, deadlineMs: 5000 }); } catch (e) { e2 = e; }
    check(aiUnavailable(e2) && /limit/i.test(aiUnavailable(e2).body.error), 'opposite: a real 403 still says our AI account hit a limit');
  }
  clearTimeout(WALL);
  if (fails.length === before) console.log('ENDPOINT ARM OK — ' + CASES.length + ' real handlers answer a refused account with 503 AI_UNAVAILABLE; ordinary errors are untouched');
}

if (fails.length) { console.log('AI-UNAVAILABLE GATE FAILED'); for (const f of fails) console.log('FAIL: ' + f); process.exit(1); }
console.log('PASS');
process.exit(0);
