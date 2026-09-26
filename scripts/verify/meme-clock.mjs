#!/usr/bin/env node
// GATE: api/meme.js answers its OWN JSON inside its platform limit, whatever the legs cost.
//
// WHY THIS EXISTS (v692)
//   generate did ~7 Supabase reads (up to 8s each), then an LLM leg with a fixed 50s deadline,
//   then a Gemini leg whose `timeout: 50000` is a socket IDLE timer — it fires only after 50s of
//   silence, so a reply that trickles bytes never trips it. Nothing added those up: stacked they
//   ran past vercel.json's maxDuration (120s), Vercel killed the function, the app got Vercel's
//   own 504 page instead of our JSON, and the credit hold was not released by our answer.
//   The fix is one request clock: each leg gets only the time that is left, the image leg's limit
//   is TOTAL, and a leg that cannot start in time is skipped with an honest error, uncharged.
//
// HOW IT CHECKS
//   It RUNS the real api/meme.js handler with the real api/_llm.js and api/_usage.js against a
//   scripted https (x.ai, Gemini and PostgREST — no network), with meme.js's clock scaled down to
//   a few seconds (TIMING is exported for this) and, where an arm needs it, Date.now jumped
//   forward (a controllable clock). Arms:
//     A  slow Supabase + slow LLM, then a Gemini reply that TRICKLES BYTES FOREVER: the image leg
//        is cut at the time LEFT (an idle timer never would be), our JSON 504 arrives inside the
//        budget, the hold is released and nothing is charged.
//     B  slow Supabase + an LLM that never answers: the LLM leg is cut at the time left minus the
//        room kept for the image — sooner than its own ceiling — and our JSON arrives in budget.
//     C  too little time left before the LLM: no x.ai call, no image call, 503, nothing charged.
//     D  too little time left before the image: no image call, 503, nothing charged.
//     E  brandimage uses the same clock: a silent Gemini is cut at the time left; too little
//        time → no image call.
//     H  (r2) x.ai answering 5xx again and again under a short room: every attempt that starts can
//        finish by budget − image room, so the leg never runs past it (a deadline of the LLM's
//        own 50s would let retries run on).
//     I  (r2) the clock is read right after checkLimit: a brownout in the reads up front answers
//        OUT_OF_TIME before the key read, the LLM or the image.
//     J  (r2) an LLM that finishes right at the end of its room still leaves the image enough time,
//        so the paid x.ai call is used, not thrown away.
//     K  (r2) no timeout / failure message contains a word app.html's meme handler reads as "your
//        Gemini key is missing" (/key|gemini|401|unauthor/i), and each carries its documented code;
//        a real key rejection from Google still does.
//     G  a Gemini connection that breaks mid-body is answered at once with our JSON (a response
//        'error' with no listener would crash the function instead).
//     F  the opposite arm: a normal fast request still returns the meme and is charged ONCE, and
//        after the budget has passed its finished image request was never cut (the total timer
//        was cleared when it settled).
//     S  static: the clock's numbers fit vercel.json's maxDuration with room for the post-work
//        Supabase writes.
// RUN:    node scripts/verify/meme-clock.mjs
// EXPECT: prints "MEME CLOCK OK" and exits 0.
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Wall clock: a handler that never answers FAILS this gate (exit 1) instead of hanging it.
const _wall = setTimeout(() => { console.log('FAIL: wall clock — meme-clock did not finish in 60s'); process.exit(1); }, 60000);
_wall.unref();

process.env.SUPABASE_URL = 'https://meme-clock-gate.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only-not-a-real-key';
process.env.XAI_API_KEY = 'test-only-not-a-real-key';
process.env.COST_CAP_EUR = '25';

let fail = 0, passed = 0;
// Stops at the FIRST failed check (exit 1), so mutation runs stay fast; MEME_CLOCK_ALL=1 runs every arm.
const ALL = process.env.MEME_CLOCK_ALL === '1';
const ok = (c, m) => {
  if (!c) { console.log('FAIL:', m); fail++; if (!ALL) { console.log('\nFAIL — stopped at the first failed check (MEME_CLOCK_ALL=1 runs every arm)'); process.exit(1); } }
  else { console.log('ok:', m); passed++; }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const perf = () => performance.now();

// ── a controllable clock ──────────────────────────────────────────────────────
const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;

// ── scripted https ────────────────────────────────────────────────────────────
const rows = [];                 // usage_events
const plans = new Map();
const sp = (p) => new URL('https://h' + p).searchParams;
const eq = (s, k) => { const v = s.get(k); return v && v.startsWith('eq.') ? v.slice(3) : null; };
// Per-arm script. xai / gemini: (log) -> behaviour { delay, status, body } | { hang:true } | { trickle:true }
const S = { sbDelay: 0, xai: null, gemini: null, onXai: null, log: [] };
function supabase(opts, payload) {
  const table = opts.path.split('?')[0], s = sp(opts.path);
  if (table === '/rest/v1/user_plans') {
    if (opts.method === 'GET') { const r = plans.get(eq(s, 'user_id')); return { status: 200, body: JSON.stringify(r ? [r] : []) }; }
    if (opts.method === 'POST') { const b = JSON.parse(payload); plans.set(b.user_id, Object.assign({ plan: 'free' }, b)); return { status: 201, body: '[]' }; }
    return { status: 204, body: '' };
  }
  if (table === '/rest/v1/brands' && opts.method === 'GET') return { status: 200, body: JSON.stringify([{ user_id: 'USER-1' }]) };
  if (table === '/rest/v1/usage_events') {
    if (opts.method === 'GET') {
      const page = rows.filter(r => r.user_id === eq(s, 'user_id')); const h = {};
      if (String((opts.headers || {}).Prefer || '').includes('count=exact')) h['content-range'] = page.length ? `0-${page.length - 1}/${page.length}` : '*/0';
      return { status: 200, headers: h, body: JSON.stringify(page) };
    }
    if (opts.method === 'POST') { const b = JSON.parse(payload); if (String(b.action || '').startsWith('hold:') && S.onHold) S.onHold(); rows.push(Object.assign({ created_at: new Date().toISOString() }, b)); return { status: 201, body: JSON.stringify([rows[rows.length - 1]]) }; }
    if (opts.method === 'PATCH') { const b = JSON.parse(payload); const hit = rows.filter(r => r.user_id === eq(s, 'user_id') && r.action === eq(s, 'action')); hit.forEach(r => Object.assign(r, b)); return { status: 200, body: JSON.stringify(hit) }; }
    if (opts.method === 'DELETE') { for (let i = rows.length - 1; i >= 0; i--) if (rows[i].user_id === eq(s, 'user_id') && rows[i].action === eq(s, 'action')) rows.splice(i, 1); return { status: 204, body: '' }; }
  }
  return { status: 404, body: '{}' };
}
const https = require_('node:https');
https.request = function (opts, cb) {
  const host = String(opts.hostname || '');
  const kind = /(^|\.)x\.ai$/.test(host) ? 'xai' : /generativelanguage\.googleapis\.com$/.test(host) ? 'gemini' : 'sb';
  const req = new EventEmitter(); let payload = ''; let dead = false;
  const timers = new Set();
  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); if (!dead) fn(); }, ms); timers.add(t); return t; };
  // A faithful IDLE timer: re-armed by every byte, exactly what `timeout:` / req.setTimeout are.
  let idleMs = Number(opts.timeout) > 0 ? Number(opts.timeout) : 0, idleCb = null, idleT = null;
  const kick = () => { if (idleT) { clearTimeout(idleT); timers.delete(idleT); } if (idleMs > 0) idleT = later(() => { if (idleCb) idleCb(); req.emit('timeout'); }, idleMs); };
  // holdsAtCall: how many credit holds existed when a provider was called, so an arm whose
  // "nothing charged" would pass trivially (no reservation ever written) fails instead.
  const entry = { kind, t0: perf(), tEnd: null, destroyed: null, holdsAtCall: rows.filter(r => String(r.action || '').startsWith('hold:')).length };
  if (kind !== 'sb') S.log.push(entry);
  req.write = c => { payload += c; return true; };
  req.setHeader = () => req;
  req.setTimeout = (ms, fn) => { idleMs = ms; idleCb = fn || null; kick(); return req; };
  req.destroy = (err) => {
    if (dead) return req; dead = true; entry.destroyed = perf();
    for (const t of timers) clearTimeout(timers.has(t) ? t : 0); timers.clear();
    if (err) setImmediate(() => req.emit('error', err));
    return req;
  };
  req.end = () => {
    kick();
    later(() => {
      let b;
      if (kind === 'sb') { b = supabase(opts, payload); b.delay = 0; }
      else {
        const fn = kind === 'xai' ? S.xai : S.gemini;
        if (kind === 'xai' && S.onXai) S.onXai();
        b = fn ? fn() : { status: 500, body: '{}' };
      }
      const go = () => {
        if (b.hang) return;                      // accepts, then total silence
        const resp = new EventEmitter(); resp.statusCode = b.status || 200; resp.headers = b.headers || {}; resp.complete = false;
        cb(resp);
        if (b.trickle) {                          // one byte every 40ms, forever
          const tick = () => { if (dead) return; kick(); resp.emit('data', Buffer.from(' ')); later(tick, 40); };
          later(tick, 40); return;
        }
        if (b.midError) {                         // some bytes, then the connection breaks
          later(() => { kick(); resp.emit('data', Buffer.from('{"candi')); later(() => resp.emit('error', new Error('socket hang up')), 30); }, 20); return;
        }
        later(() => { kick(); if (b.body) resp.emit('data', Buffer.from(b.body)); resp.complete = true; entry.tEnd = perf(); resp.emit('end'); }, 1);
      };
      if (b.delay > 0) later(go, b.delay); else go();
    }, kind === 'sb' ? (S.sbDelay || 0) : 1);
    return req;
  };
  return req;
};

// ── the handler, with its store / crypto stubbed and _usage + _llm real ─────────
const cacheSet = (rel, exp) => { const k = require_.resolve(ROOT + rel); require_.cache[k] = { id: k, filename: k, loaded: true, exports: exp }; };
const storeDelay = { ms: 0, onKeyRead: null };
cacheSet('/api/_publish/store.js', {
  getUser: async () => { await sleep(storeDelay.ms); return { id: 'USER-1' }; },
  userCanAccessBrand: async () => { await sleep(storeDelay.ms); return true; },
  rest: async (m, p) => {
    await sleep(storeDelay.ms);
    if (/gemini_key_enc/.test(p)) { S.holdsAtKey = rows.filter(r => String(r.action || '').startsWith('hold:')).length; if (storeDelay.onKeyRead) storeDelay.onKeyRead(); return { status: 200, data: [{ gemini_key_enc: 'sealed' }] }; }
    return { status: 200, data: [] };
  },
  setRequestBudget: () => 8000,
});
cacheSet('/api/_publish/crypto.js', { encrypt: (o) => JSON.stringify(o), decrypt: () => ({ key: 'test-only-gemini-key' }) });
for (const rel of ['/api/_requireUser.js', '/api/_usage.js', '/api/_llm.js', '/api/meme.js']) delete require_.cache[require_.resolve(ROOT + rel)];
// Observe the deadline meme.js hands callLLM (the real one still runs).
{
  const llmKey = require_.resolve(ROOT + '/api/_llm.js');
  const real = require_(llmKey);
  const wrapped = Object.assign({}, real, { callLLM: (o) => { S.llmDeadlines.push(o && o.deadlineMs); return real.callLLM(o); } });
  require_.cache[llmKey] = { id: llmKey, filename: llmKey, loaded: true, exports: wrapped };
}
const meme = require_(ROOT + '/api/meme.js');
const T = meme._timing;

// ── S: the real numbers fit the platform limit ────────────────────────────────
{
  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const md = ((vercel.functions || {})['api/meme.js'] || {}).maxDuration;
  ok(T && typeof T.budgetMs === 'number', 'S: meme.js exports its request clock (TIMING)');
  ok(meme._FN_MAX_MS === md * 1000, 'S: FN_MAX_MS (' + meme._FN_MAX_MS + ') is vercel.json maxDuration for api/meme.js (' + md + 's)');
  // After the work: logUsage's PATCH and its fallback INSERT, 8s Supabase timeout each.
  ok(T.budgetMs + 16000 <= md * 1000, 'S: budget ' + T.budgetMs + 'ms + 16s of post-work Supabase writes fits ' + md + 's');
  ok(T.llmMaxMs <= 50000 && T.llmAttemptMs <= T.llmMaxMs && T.minImageMs > 0 && T.minLlmMs > 0 && T.imageSlackMs >= 500, 'S: the LLM leg keeps its 50s ceiling, the legs have floors, and the image floor has slack (' + T.imageSlackMs + 'ms)');
}

// Scale the clock down: every ratio kept, seconds become milliseconds-ish.
const SCALED = { budgetMs: 3000, llmMaxMs: 1500, llmAttemptMs: 1400, minLlmMs: 200, minImageMs: 400, imageSlackMs: 100 };
Object.assign(T, SCALED);
const B = T.budgetMs, SLACK = 220;          // timer slack on a loaded laptop
const POST = 600;                           // scaled room for the post-work writes

const XAI_OK = () => ({ status: 200, body: JSON.stringify({ model: 'grok', choices: [{ finish_reason: 'stop', message: { role: 'assistant',
  content: '{"headline":"Mondays, again","imagePrompt":"a sleepy office","caption":"same"}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) });
const GEMINI_OK = () => ({ status: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }] } }] }) });
// app.html's meme error handler: a message matching this is shown as "Add your free Google Gemini
// key first" and opens the key form. No timeout / failure message of ours may match it.
const APP_KEY_RE = /key|gemini|401|unauthor/i;
const holds = () => rows.filter(r => String(r.action || '').startsWith('hold:')).length;
const charged = () => rows.filter(r => !String(r.action || '').startsWith('hold:')).length;
const mkRes = () => { const r = { statusCode: 200, sent: null, headers: {}, status(c) { r.statusCode = c; return r; }, json(b) { r.sent = b; return b; }, setHeader(k, v) { r.headers[k] = v; }, end() { return r; } }; return r; };

async function run(name, body, setup) {
  rows.length = 0; plans.clear(); plans.set('USER-1', { user_id: 'USER-1', plan: 'pro' });
  S.sbDelay = 0; S.xai = null; S.gemini = null; S.onXai = null; S.onHold = null; S.log = []; S.holdsAtKey = -1; S.llmDeadlines = [];
  storeDelay.ms = 0; storeDelay.onKeyRead = null; skew = 0;
  setup();
  const res = mkRes();
  const t0 = perf();
  const req = { method: 'POST', headers: { authorization: 'Bearer t', origin: 'https://contentshrimp.com' }, body };
  // Race the handler against a hard per-arm limit: an unbounded leg must FAIL, never hang the gate.
  const LIMIT = B + POST + 1500;
  const done = await Promise.race([Promise.resolve(meme(req, res)).then(() => true, (e) => { console.log(name + ': handler threw', e); return true; }), sleep(LIMIT).then(() => false)]);
  const elapsed = perf() - t0;
  for (let i = 0; i < 20 && holds(); i++) await sleep(5);    // let the release settle
  const xai = S.log.filter(e => e.kind === 'xai'), gem = S.log.filter(e => e.kind === 'gemini');
  return { res, elapsed, done, t0, xai, gem };
}
const gen = { action: 'generate', brandId: 'b1', brandContext: {}, topic: 'mondays' };

// ── A: slow Supabase + slow LLM, then a Gemini reply that trickles forever ───────
{
  const r = await run('A', gen, () => {
    storeDelay.ms = 150; S.sbDelay = 80;
    S.xai = () => ({ ...XAI_OK(), delay: 1200 });
    S.gemini = () => ({ trickle: true, status: 200 });
  });
  const g = r.gem[0];
  ok(r.done, 'A: the handler answered (a trickling Gemini did not hang it) — ' + Math.round(r.elapsed) + 'ms');
  ok(r.xai.length === 1 && r.xai[0].tEnd && g && g.holdsAtCall === 1, 'A: the LLM answered and the image leg started with the meme credit on hold (holds then: ' + (g && g.holdsAtCall) + ')');
  const left = g ? B - (g.t0 - r.t0) : NaN;
  ok(g && left < T.llmMaxMs && left > T.minImageMs, 'A: the image leg started with only ' + Math.round(left) + 'ms of the budget left (a stacked worst case)');
  ok(g && g.destroyed && Math.abs((g.destroyed - r.t0) - B) <= SLACK,
    'A: the trickling image request was cut at the TOTAL time left — ' + (g && g.destroyed ? Math.round(g.destroyed - r.t0) : 'never') + 'ms vs budget ' + B + 'ms (its idle timer never fires while bytes trickle)');
  ok(r.elapsed <= B + POST, 'A: the whole handler answered inside budget + post-work room (' + Math.round(r.elapsed) + 'ms ≤ ' + (B + POST) + 'ms)');
  ok(r.res.statusCode === 504 && r.res.sent && r.res.sent.code === 'OUT_OF_TIME' && /nothing was charged/i.test(r.res.sent.error || '') && !APP_KEY_RE.test(r.res.sent.error || ''),
    'A: the caller got OUR JSON 504 that says nothing was charged, with no word the app reads as a key problem: ' + r.res.statusCode + ' ' + JSON.stringify(r.res.sent));
  ok(holds() === 0 && charged() === 0, 'A: the hold is released and nothing is charged (holds=' + holds() + ' charged=' + charged() + ')');
}

// ── B: slow Supabase + an LLM that never answers ────────────────────────────────
{
  const r = await run('B', gen, () => {
    storeDelay.ms = 250; S.sbDelay = 120;
    S.xai = () => ({ hang: true });
    S.gemini = GEMINI_OK;
  });
  const x = r.xai[0];
  ok(r.done && x, 'B: the handler answered after the LLM hung — ' + Math.round(r.elapsed) + 'ms');
  const cutAt = x && x.destroyed ? x.destroyed - r.t0 : Infinity;
  const ranFor = x && x.destroyed ? x.destroyed - x.t0 : Infinity;
  const ROOM_END = B - T.minImageMs - T.imageSlackMs;
  ok(x && x.destroyed && cutAt <= ROOM_END + SLACK,
    'B: the LLM leg was cut by the time LEFT (at ' + Math.round(cutAt) + 'ms, ≤ budget − image room ' + ROOM_END + 'ms)');
  ok(ranFor < T.llmMaxMs - 150, 'B: which is sooner than its own ' + T.llmMaxMs + 'ms ceiling (it ran ' + Math.round(ranFor) + 'ms)');
  ok(r.xai.length === 1 && r.gem.length === 0 && x.holdsAtCall === 1, 'B: one x.ai attempt with the credit on hold, no image call (x.ai=' + r.xai.length + ' gemini=' + r.gem.length + ' holds then=' + (x && x.holdsAtCall) + ')');
  ok(r.elapsed <= B + POST && r.res.statusCode >= 500 && r.res.sent && typeof r.res.sent.error === 'string',
    'B: OUR JSON error arrived inside the budget: ' + r.res.statusCode + ' ' + JSON.stringify(r.res.sent) + ' in ' + Math.round(r.elapsed) + 'ms');
  ok(holds() === 0 && charged() === 0, 'B: nothing charged (holds=' + holds() + ' charged=' + charged() + ')');
}

// ── C: too little time left before the LLM leg ─────────────────────────────────
{
  const r = await run('C', gen, () => {
    storeDelay.onKeyRead = () => { skew += B - T.minImageMs - T.minLlmMs + 50; };   // the reads ate the budget
    S.xai = XAI_OK; S.gemini = GEMINI_OK;
  });
  ok(r.done && r.xai.length === 0 && r.gem.length === 0, 'C: with too little time left, neither x.ai nor Gemini is called (x.ai=' + r.xai.length + ' gemini=' + r.gem.length + ')');
  ok(r.res.statusCode === 503 && r.res.sent && r.res.sent.code === 'OUT_OF_TIME' && /nothing was charged/i.test(r.res.sent.error || ''),
    'C: honest 503 OUT_OF_TIME: ' + r.res.statusCode + ' ' + JSON.stringify(r.res.sent));
  ok(S.holdsAtKey === 1 && holds() === 0 && charged() === 0, 'C: the credit that was on hold (' + S.holdsAtKey + ') is released, nothing charged (holds=' + holds() + ' charged=' + charged() + ')');
}

// ── D: too little time left before the image leg ───────────────────────────────
{
  const r = await run('D', gen, () => {
    S.onXai = () => { skew += B - T.minImageMs + 50; };   // the LLM leg (as seen by the clock) ran long
    S.xai = XAI_OK; S.gemini = GEMINI_OK;
  });
  ok(r.done && r.xai.length === 1 && r.xai[0].holdsAtCall === 1 && r.gem.length === 0, 'D: the LLM ran (credit on hold), but with too little time left the image is NOT started (gemini=' + r.gem.length + ')');
  ok(r.res.statusCode === 503 && r.res.sent && r.res.sent.code === 'OUT_OF_TIME' && /nothing was charged/i.test(r.res.sent.error || ''),
    'D: honest 503 OUT_OF_TIME: ' + r.res.statusCode + ' ' + JSON.stringify(r.res.sent));
  ok(holds() === 0 && charged() === 0, 'D: nothing charged (holds=' + holds() + ' charged=' + charged() + ')');
}

// ── E: brandimage runs on the same clock ───────────────────────────────────────
{
  const bi = { action: 'brandimage', brandId: 'b1', prompt: 'a product on a table' };
  const r = await run('E1', bi, () => { storeDelay.ms = 150; S.sbDelay = 80; S.gemini = () => ({ hang: true }); });
  const g = r.gem[0];
  ok(r.done && g && g.holdsAtCall === 1 && g.destroyed && Math.abs((g.destroyed - r.t0) - B) <= SLACK,
    'E: a silent Gemini on brandimage is cut at the time left (' + (g && g.destroyed ? Math.round(g.destroyed - r.t0) : 'never') + 'ms vs budget ' + B + 'ms), not after 50s of idle');
  ok(r.res.statusCode === 504 && r.res.sent && r.res.sent.code === 'OUT_OF_TIME' && !APP_KEY_RE.test(r.res.sent.error || '') && holds() === 0 && charged() === 0,
    'E: our JSON 504 (no key words), nothing charged: ' + r.res.statusCode + ' ' + JSON.stringify(r.res.sent));
  const r2 = await run('E2', bi, () => { storeDelay.onKeyRead = () => { skew += B - T.minImageMs + 50; }; S.gemini = GEMINI_OK; });
  ok(r2.done && S.holdsAtKey === 1 && r2.gem.length === 0 && r2.res.statusCode === 503 && r2.res.sent && r2.res.sent.code === 'OUT_OF_TIME' && holds() === 0 && charged() === 0,
    'E: too little time → no image call, honest 503, nothing charged: ' + r2.res.statusCode + ' gemini=' + r2.gem.length);
}

// ── G: a Gemini connection that breaks mid-body ─────────────────────────────────
{
  const r = await run('G', gen, () => { S.xai = XAI_OK; S.gemini = () => ({ midError: true, status: 200 }); });
  ok(r.done && r.elapsed < B / 2 && r.res.statusCode === 502 && r.res.sent && r.res.sent.code === 'IMAGE_FAILED' && !APP_KEY_RE.test(r.res.sent.error || ''),
    'G: a broken image response is answered at once with our JSON 502 (' + Math.round(r.elapsed) + 'ms): ' + r.res.statusCode + ' ' + JSON.stringify(r.res.sent));
  ok(holds() === 0 && charged() === 0, 'G: nothing charged (holds=' + holds() + ' charged=' + charged() + ')');
}

// ── H: repeated x.ai 5xx under a short room ─────────────────────────────────────
{
  const saved = Object.assign({}, T);
  Object.assign(T, { llmMaxMs: 2500, llmAttemptMs: 400 });   // the LLM's own ceiling is NOT what binds here
  try {
    const r = await run('H', gen, () => {
      storeDelay.ms = 250; S.sbDelay = 120;                     // the reads up front eat most of the budget
      S.xai = () => ({ status: 503, delay: 200, body: JSON.stringify({ error: 'overloaded (test)' }) });
      S.gemini = GEMINI_OK;
    });
    const ROOM_END = B - T.minImageMs - T.imageSlackMs;
    const dl = S.llmDeadlines[0];
    ok(r.done && r.xai.length >= 1 && dl < T.llmMaxMs, 'H: the LLM leg was given the time left (' + dl + 'ms), not its own ' + T.llmMaxMs + 'ms ceiling');
    const late = r.xai.filter(a => (a.t0 - r.t0) + T.llmAttemptMs > ROOM_END + SLACK);
    ok(late.length === 0, 'H: only attempts that can finish by budget − image room (' + ROOM_END + 'ms) are started — attempts at ' +
      r.xai.map(a => Math.round(a.t0 - r.t0) + 'ms').join(', '));
    const lastEnd = Math.max(...r.xai.map(a => (a.tEnd || a.destroyed || perf()) - r.t0));
    ok(lastEnd <= ROOM_END + SLACK, 'H: the LLM leg ended by ' + Math.round(lastEnd) + 'ms (≤ ' + ROOM_END + 'ms)');
    ok(r.gem.length === 0 && r.elapsed <= B + POST && r.res.sent && typeof r.res.sent.error === 'string' && holds() === 0 && charged() === 0,
      'H: our JSON inside the budget, no image call, nothing charged: ' + r.res.statusCode + ' in ' + Math.round(r.elapsed) + 'ms');
  } finally { Object.assign(T, saved); }
}

// ── I: the clock is read right after checkLimit ─────────────────────────────────
{
  const r = await run('I', gen, () => {
    S.onHold = () => { skew += B - (T.minLlmMs + T.minImageMs + T.imageSlackMs) + 50; };   // a brownout up front
    S.xai = XAI_OK; S.gemini = GEMINI_OK;
  });
  ok(r.done && S.holdsAtKey === -1 && r.xai.length === 0 && r.gem.length === 0,
    'I: out of time right after checkLimit → the key is not even read, no x.ai, no Gemini (key read=' + (S.holdsAtKey !== -1) + ' x.ai=' + r.xai.length + ' gemini=' + r.gem.length + ')');
  ok(r.res.statusCode === 503 && r.res.sent && r.res.sent.code === 'OUT_OF_TIME' && holds() === 0 && charged() === 0,
    'I: honest 503 OUT_OF_TIME, the hold released, nothing charged: ' + r.res.statusCode + ' ' + JSON.stringify(r.res.sent));
  const r2 = await run('I2', { action: 'brandimage', brandId: 'b1', prompt: 'a product' }, () => {
    S.onHold = () => { skew += B - T.minImageMs + 50; }; S.gemini = GEMINI_OK;
  });
  ok(r2.done && S.holdsAtKey === -1 && r2.gem.length === 0 && r2.res.statusCode === 503 && r2.res.sent && r2.res.sent.code === 'OUT_OF_TIME' && holds() === 0 && charged() === 0,
    'I: brandimage too — 503 OUT_OF_TIME before the key read (key read=' + (S.holdsAtKey !== -1) + ' gemini=' + r2.gem.length + ')');
}

// ── J: an LLM that finishes right at the end of its room ─────────────────────────
{
  const r = await run('J', gen, () => {
    // the reads up front leave less than the LLM's own ceiling, so the ROOM is what binds …
    storeDelay.onKeyRead = () => { skew += B - T.llmMaxMs; };
    // … then the clock sees the LLM use ALL of that room and overrun it by a hair (30ms ≈ 0.3s at scale)
    S.onXai = () => { skew += (S.llmDeadlines[0] || 0) + 30; };
    S.xai = XAI_OK; S.gemini = GEMINI_OK;
  });
  ok(S.llmDeadlines[0] < T.llmMaxMs, 'J: the LLM leg was bound by its room (' + S.llmDeadlines[0] + 'ms < ' + T.llmMaxMs + 'ms)');
  ok(r.done && r.xai.length === 1 && r.gem.length === 1 && r.res.statusCode === 200 && r.res.sent && r.res.sent.imageBase64,
    'J: the image still ran after an LLM that used its whole room, so the paid x.ai call was not wasted (gemini=' + r.gem.length + ', ' + r.res.statusCode + ')');
  ok(holds() === 0 && charged() === 1, 'J: and it is charged once (charged=' + charged() + ')');
}

// ── K: messages the app cannot mistake for "your key is missing" ───────────────
{
  const seen = [];
  const cases = [
    ['broken body → 502', 502, 'IMAGE_FAILED', () => { S.xai = XAI_OK; S.gemini = () => ({ midError: true, status: 200 }); }, gen],
    ['Google 503 → 502', 502, 'IMAGE_FAILED', () => { S.xai = XAI_OK; S.gemini = () => ({ status: 503, body: JSON.stringify({ error: { message: 'The model is overloaded. API key quota (test)' } }) }); }, gen],
    ['Google 429 → 502', 502, 'IMAGE_BUSY', () => { S.xai = XAI_OK; S.gemini = () => ({ status: 429, body: JSON.stringify({ error: { message: 'Quota exceeded for consumer api_key:xyz (test)' } }) }); }, gen],
    ['200, no image → 502', 502, 'IMAGE_EMPTY', () => { S.xai = XAI_OK; S.gemini = () => ({ status: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'blocked' }] } }] }) }); }, gen],
    ['no time before LLM → 503', 503, 'OUT_OF_TIME', () => { storeDelay.onKeyRead = () => { skew += B; }; }, gen],
    ['no time before image → 503', 503, 'OUT_OF_TIME', () => { S.onXai = () => { skew += B; }; S.xai = XAI_OK; }, gen],
    ['no time after checkLimit → 503', 503, 'OUT_OF_TIME', () => { S.onHold = () => { skew += B; }; }, gen],
    ['brandimage socket error → 502', 502, 'IMAGE_FAILED', () => { S.gemini = () => ({ midError: true, status: 200 }); }, { action: 'brandimage', brandId: 'b1', prompt: 'p' }],
  ];
  for (const [label, st, code, setup, body] of cases) {
    const r = await run('K ' + label, body, setup);
    const msg = String((r.res.sent && r.res.sent.error) || '');
    seen.push(label);
    ok(r.done && r.res.statusCode === st && r.res.sent && r.res.sent.code === code && msg && !APP_KEY_RE.test(msg) && /nothing was charged/i.test(msg) && charged() === 0,
      'K: ' + label + ' — ' + r.res.statusCode + ' ' + (r.res.sent && r.res.sent.code) + ' "' + msg + '" (no key words, says nothing was charged, and nothing was)');
  }
  // the opposite: a real key rejection from Google still reads as a key problem
  const r = await run('K key', gen, () => { S.xai = XAI_OK; S.gemini = () => ({ status: 400, body: JSON.stringify({ error: { message: 'API key not valid. Please pass a valid API key.' } }) }); });
  ok(r.res.statusCode === 502 && r.res.sent && r.res.sent.code === 'IMAGE_PROVIDER_ERROR' && APP_KEY_RE.test(r.res.sent.error || '') && charged() === 0,
    'K: a real key rejection (Google 400) still carries Google\'s words, so the app opens the key form: ' + JSON.stringify(r.res.sent));
  // r3: 401 and 403 are key rejections too (a revoked key, a key reported as leaked). Dropping them to
  // IMAGE_FAILED ("try again") would have the user retry a dead key forever.
  for (const [st, words, keyish] of [
    [401, 'API key expired. Please renew the API key.', true],
    [403, 'Your API key was reported as leaked. Please use another API key.', true],
    // Decision: EVERY 400/401/403 is passed on in Google's words with IMAGE_PROVIDER_ERROR — the fix
    // is on the user's Google side, not a retry. A 403 that is not about the key keeps that code and
    // Google's words; whether the app then opens the key form is the app's regex, not ours.
    [403, 'Requests from referer <empty> are blocked.', false],
  ]) {
    const rr = await run('K ' + st, gen, () => { S.xai = XAI_OK; S.gemini = () => ({ status: st, body: JSON.stringify({ error: { message: words } }) }); });
    const m = String((rr.res.sent && rr.res.sent.error) || '');
    ok(rr.res.statusCode === 502 && rr.res.sent && rr.res.sent.code === 'IMAGE_PROVIDER_ERROR' && m.includes(words) && APP_KEY_RE.test(m) === keyish && charged() === 0,
      'K: Google ' + st + ' "' + words + '" → IMAGE_PROVIDER_ERROR in Google\'s words' + (keyish ? ' (the app opens the key form)' : ' (not a key problem: no key form, still not a blind retry)') + ': ' + JSON.stringify(rr.res.sent));
  }
}

// ── F: the opposite — a normal request still works and is charged once ─────────
{
  const r = await run('F', gen, () => { S.xai = XAI_OK; S.gemini = () => ({ ...GEMINI_OK(), delay: 100 }); });
  ok(r.done && r.res.statusCode === 200 && r.res.sent && r.res.sent.imageBase64 && r.res.sent.headline === 'Mondays, again',
    'F: a normal fast request returns the meme: ' + r.res.statusCode + ' ' + JSON.stringify(r.res.sent).slice(0, 100));
  ok(r.gem.length === 1 && !r.gem[0].destroyed, 'F: the image call ran to completion (not cut)');
  ok(holds() === 0 && charged() === 1 && rows[0].action === 'meme', 'F: charged exactly once (holds=' + holds() + ' charged=' + charged() + ')');
  // r2: the image leg's TOTAL timer must be cleared when it settles — or it fires later and cuts a
  // socket that already finished (harmless today, a live bug the day that socket is reused).
  await sleep(Math.max(0, B + 300 - (perf() - r.t0)));
  ok(r.gem[0] && !r.gem[0].destroyed, 'F: past the budget, the finished image request was never cut by a stale total timer');
  const r2 = await run('F2', { action: 'brandimage', brandId: 'b1', prompt: 'a product' }, () => { S.gemini = GEMINI_OK; });
  ok(r2.res.statusCode === 200 && r2.res.sent && r2.res.sent.imageBase64 && charged() === 1 && rows[0].action === 'brandimage',
    'F: a normal brandimage request still works and is charged once: ' + r2.res.statusCode);
}

clearTimeout(_wall);
const EXPECTED = 55;
if (!fail && passed !== EXPECTED) { console.log('FAIL: ran ' + passed + ' checks, expected ' + EXPECTED + ' (an arm stopped part-way)'); fail++; }
console.log(fail ? '\nFAIL — ' + fail + ' check(s) failed' : '\nMEME CLOCK OK — every leg gets only the time left, the image limit is total, and the answer is always our own JSON');
process.exit(fail ? 1 : 0);
