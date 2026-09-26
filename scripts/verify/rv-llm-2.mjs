#!/usr/bin/env node
// GATE rv-llm-2 (v690 review): api/_llm.js keeps the promises its callers rely on.
//
// It RUNS the real callLLM / callGrokSearch with node:https replaced by an in-memory server whose
// sockets behave like real ones (the idle timer re-arms on every byte and dies with the socket).
// Every arm has its opposite, and every arm is raced against a wall clock so a regression FAILS
// here instead of hanging the gate.
//   A  deadlineMs caps the FIRST attempt (settings-examples: 10s deadline, 22s attempts)
//   B  with no timeoutMs, a deadline still allows a retry when there is room (was: never under 240s)
//   C  timeoutMs is a TOTAL limit: a reply that trickles bytes forever still ends on time
//   D  a connection dropped mid-body is retried instead of hanging the call forever
//   E  a multi-byte letter split across two network chunks survives intact
//   F  two replies finishing in the same tick keep their own "truncated" flag
//   G  a final SSE event without a trailing newline is not dropped
//   H  a refused search account (401/402/403) is recorded on opts.meta and named in the log
//   I  a search stream that drops mid-way returns now, not at the end of its budget
//   J  the search stream decodes split multi-byte letters too
//   (v690 round 2)
//   N  a successful call leaves no timer behind (the absolute limit is cleared on 'end')
//   K  a RETRY is also cut at the deadline (first attempt fails late, the retry would hang)
//   L  after a long failed attempt, a doomed short retry is not started
//   M  after the 4th failure the call gives up at once — no 4th backoff sleep (HTTP and network)
//   H  loops over 401, 402 and 403
//   O  (round 3) a late mid-reply drop counts its duration too: no doomed short retry
// RUN: node scripts/verify/rv-llm-2.mjs     EXPECT: "PASS" and exit 0.
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.XAI_API_KEY = 'test-only-not-a-real-key';
// fake clock: an attempt can "take" 14s without the gate waiting 14s. Timers stay real.
const realNow = Date.now.bind(Date); let skew = 0; Date.now = () => realNow() + skew;
const WALL = setTimeout(() => { console.log('FAIL: rv-llm-2 wall clock (60s) — something hung'); process.exit(1); }, 60000);

let failed = 0;
const ok = (c, m) => { if (c) console.log('ok: ' + m); else { console.log('FAIL: ' + m); failed++; } };
const https = require_('https');
let calls = 0, plan = null;
https.request = (opts, cb) => {
  const n = ++calls;
  const req = new EventEmitter();
  let idle = null, idleFn = null, idleMs = 0, dead = false;
  const arm = () => { if (idle) clearTimeout(idle); idle = (idleFn && !dead) ? setTimeout(idleFn, idleMs) : null; };
  const kill = () => { dead = true; if (idle) clearTimeout(idle); idle = null; };
  req.setTimeout = (ms, fn) => { idleMs = ms; idleFn = fn; arm(); return req; };
  req.write = () => {};
  req.destroy = (e) => { if (dead) return; kill(); if (e) setImmediate(() => req.emit('error', e)); };
  req.end = () => setTimeout(() => { if (!dead) plan(n, { req, cb, arm, kill, dead: () => dead, limit: idleMs }); }, 1);
  return req;
};
// A response. chunks: Buffers/strings sent `gap` ms apart (each re-arms the idle timer).
// end: emit 'end' after the last chunk; drop: kill the socket mid-body (no 'end', 'close' with complete=false).
function respond(ctx, { status = 200, type = 'application/json', chunks = [], gap = 5, end = true, drop = false, forever = null }) {
  const resp = new EventEmitter();
  resp.statusCode = status; resp.headers = { 'content-type': type }; resp.complete = false;
  ctx.cb(resp);
  let t = 0;
  chunks.forEach(c => { t += gap; setTimeout(() => { if (ctx.dead()) return; ctx.arm(); resp.emit('data', Buffer.isBuffer(c) ? c : Buffer.from(c)); }, t); });
  if (forever) {
    const h = setInterval(() => { if (ctx.dead()) return clearInterval(h); ctx.arm(); resp.emit('data', Buffer.from(forever)); }, gap);
    return;
  }
  setTimeout(() => {
    if (ctx.dead()) return;
    if (drop) { ctx.kill(); resp.emit('close'); return; }
    if (end) { resp.complete = true; resp.emit('end'); resp.emit('close'); ctx.kill(); }
  }, t + gap);
}
const chat = (content, finish = 'stop') => JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }], usage: {} });
const within = (ms, p) => Promise.race([p, new Promise(r => setTimeout(() => r('__HUNG__'), ms))]);
const attempt = async (fn) => { const t0 = Date.now(); let out, err = null; try { out = await fn(); } catch (e) { err = e; } return { out, err, ms: Date.now() - t0 }; };

const { callLLM, callGrokSearch } = require_(path.join(ROOT, 'api', '_llm.js'));
const msgs = [{ role: 'user', content: 'hi' }];
const timeoutsNow = () => process.getActiveResourcesInfo().filter(x => x === 'Timeout').length;

// ── N. no timer survives a successful call ────────────────────────────────────
{
  await new Promise(r => setImmediate(r));
  const before = timeoutsNow();
  plan = (n, ctx) => respond(ctx, { chunks: [chat('done')] });
  const t = await callLLM({ messages: msgs, timeoutMs: 30000 });
  plan = (n, ctx) => respond(ctx, { type: 'text/event-stream', chunks: ['data: {"delta":"x"}\n\n', 'data: [DONE]\n\n'] });
  const g = await callGrokSearch('q', { maxTokens: 50, timeoutMs: 30000 });
  await new Promise(r => setTimeout(r, 20)); await new Promise(r => setImmediate(r));
  const after = timeoutsNow();
  ok(t === 'done' && g === 'x' && after <= before, 'N: successful calls leave no timer running (Timeouts before ' + before + ', after ' + after + ') — a leaked 30s limit keeps the function alive and fires later');
}

// ── A. the deadline caps the first attempt ────────────────────────────────────
{
  plan = () => {};                              // accepts, never answers
  calls = 0;
  const r = await within(4000, attempt(() => callLLM({ messages: msgs, deadlineMs: 1200, timeoutMs: 5000 })));
  ok(r !== '__HUNG__' && r.err && r.ms < 2500, 'A: deadline 1.2s with 5s attempts ends by the deadline (' + (r === '__HUNG__' ? 'hung' : r.ms + 'ms') + ') — the first attempt used to run its full timeoutMs');
  plan = (n, ctx) => respond(ctx, { chunks: [chat('fine')], gap: 300 });
  const r2 = await within(4000, attempt(() => callLLM({ messages: msgs, deadlineMs: 5000, timeoutMs: 4000 })));
  ok(r2 !== '__HUNG__' && r2.out === 'fine', 'A opposite: a reply that arrives inside the deadline is returned untouched');
}
// ── B. no timeoutMs: a retry still fits a deadline under 240s ────────────────
{
  plan = (n, ctx) => respond(ctx, n === 1 ? { status: 429, chunks: ['{"error":"slow down"}'] } : { chunks: [chat('second time lucky')] });
  calls = 0;
  const r = await within(8000, attempt(() => callLLM({ messages: msgs, deadlineMs: 60000 })));
  ok(r !== '__HUNG__' && r.out === 'second time lucky' && calls === 2, 'B: deadline 60s, no timeoutMs, a fast 429 is retried (calls=' + calls + ', ' + (r.err ? r.err.message : r.out) + ') — it demanded a 240s attempt, so no retry could ever fit');
  plan = () => {};
  const r2 = await within(4000, attempt(() => callLLM({ messages: msgs, deadlineMs: 1200 })));
  ok(r2 !== '__HUNG__' && r2.err && r2.ms < 2500, 'B: deadline 1.2s with no timeoutMs ends by the deadline (' + (r2 === '__HUNG__' ? 'hung' : r2.ms + 'ms') + ') — it used to wait 240s');
}
// ── C. timeoutMs is total, not idle ───────────────────────────────────────────
{
  plan = (n, ctx) => respond(ctx, { forever: ' ', gap: 100 });   // headers, then a byte every 100ms
  calls = 0;
  const r = await within(4000, attempt(() => callLLM({ messages: msgs, timeoutMs: 1200 })));
  ok(r !== '__HUNG__' && r.err && r.ms < 2500, 'C: a reply trickling bytes forever ends at timeoutMs 1.2s (' + (r === '__HUNG__' ? 'hung' : r.ms + 'ms') + ') — the idle timer alone never fires');
}
// ── D. mid-body drop is an error, and is retried ──────────────────────────────
{
  plan = (n, ctx) => respond(ctx, n === 1 ? { chunks: ['{"choices":[{"mess'], drop: true } : { chunks: [chat('after the drop')] });
  calls = 0;
  const r = await within(4000, attempt(() => callLLM({ messages: msgs, timeoutMs: 5000, deadlineMs: 60000 })));
  ok(r !== '__HUNG__' && r.out === 'after the drop' && calls === 2, 'D: a connection dropped mid-body is retried and the retry answers (' + (r === '__HUNG__' ? 'hung' : (r.err ? r.err.message : r.out) + ', calls=' + calls) + ')');
}
// ── E. multi-byte letters split across chunks ─────────────────────────────────
{
  const whole = Buffer.from(chat('Tõnu ütles: ära 😀'));
  const cut = whole.indexOf(Buffer.from('õ')) + 1;               // inside the two bytes of "õ"
  plan = (n, ctx) => respond(ctx, { chunks: [whole.subarray(0, cut), whole.subarray(cut)] });
  const r = await within(3000, attempt(() => callLLM({ messages: msgs, timeoutMs: 3000 })));
  ok(r !== '__HUNG__' && r.out === 'Tõnu ütles: ära 😀', 'E: a letter split across two chunks arrives intact (' + JSON.stringify(r.out) + ')');
}
// ── F. truncated flag is per call ─────────────────────────────────────────────
{
  const held = [];
  plan = (n, ctx) => { held.push(ctx); if (held.length === 2) {
    const [a, b] = held;
    const ra = new EventEmitter(); ra.statusCode = 200; ra.headers = {}; a.cb(ra);
    const rb = new EventEmitter(); rb.statusCode = 200; rb.headers = {}; b.cb(rb);
    ra.emit('data', Buffer.from(chat('cut off mid-sent', 'length'))); rb.emit('data', Buffer.from(chat('complete', 'stop')));
    ra.emit('end'); rb.emit('end');                                  // both finish in the SAME tick
  } };
  const [A, B] = await within(3000, Promise.all([
    callLLM({ messages: msgs, timeoutMs: 3000, wantMeta: true }),
    callLLM({ messages: msgs, timeoutMs: 3000, wantMeta: true }),
  ])).then(v => v === '__HUNG__' ? [null, null] : v);
  ok(A && A.truncated === true && B && B.truncated === false, 'F: two replies finishing together keep their own truncated flag (A=' + (A && A.truncated) + ', B=' + (B && B.truncated) + ') — a shared flag let a cut-off rewrite through expand-field');
}
// ── G. SSE final event without trailing newline ───────────────────────────────
const completed = (t) => 'data: ' + JSON.stringify({ type: 'response.completed', response: { output: [{ content: [{ type: 'output_text', text: t }] }] } });
{
  plan = (n, ctx) => respond(ctx, { type: 'text/event-stream', chunks: [completed('last event wins')] });
  const r = await within(4000, callGrokSearch('q', { maxTokens: 50, timeoutMs: 8000 }));
  ok(r === 'last event wins', 'G: a final event with no trailing newline is read (' + JSON.stringify(r) + ')');
  plan = (n, ctx) => respond(ctx, { type: 'text/event-stream', chunks: [completed('with newline') + '\n\n'] });
  const r2 = await within(4000, callGrokSearch('q', { maxTokens: 50, timeoutMs: 8000 }));
  ok(r2 === 'with newline', 'G opposite: the ordinary newline-terminated stream still works');
}
// ── H. refused search account is recorded and named ──────────────────────────
{
  const logs = []; const orig = console.error; console.error = (...a) => { logs.push(a.join(' ')); };
  let r = null; const meta = {};
  for (const st of [401, 402, 403]) {
    const m = {};
    plan = (n, ctx) => respond(ctx, { status: st, chunks: ['{"error":"used all available credits"}'] });
    const x = await within(4000, callGrokSearch('q', { maxTokens: 50, timeoutMs: 8000, meta: m }));
    ok(x === null && m.refused === st, 'H: http ' + st + ' falls back (null) and records meta.refused=' + st + ' (' + m.refused + ')');
    if (st === 403) { r = x; meta.refused = m.refused; }
  }
  const meta2 = {};
  plan = (n, ctx) => respond(ctx, { status: 429, chunks: ['{"error":"rate"}'] });
  const r2 = await within(4000, callGrokSearch('q', { maxTokens: 50, timeoutMs: 8000, meta: meta2 }));
  const r3 = await within(4000, callGrokSearch('q', { maxTokens: 50, timeoutMs: 8000 }));   // no meta: must not throw
  console.error = orig;
  ok(r === null && meta.refused === 403, 'H: a 403 still falls back (null) and records meta.refused=403 (' + meta.refused + ')');
  ok(logs.some(l => /REFUSED our account/.test(l)), 'H: and the log names the refusal instead of only "http 403"');
  ok(r2 === null && meta2.refused === undefined, 'H opposite: a 429 is not reported as a refused account');
  ok(r3 === null, 'H: callers that pass no meta are unaffected');
}
// ── I. search stream dropping mid-way ─────────────────────────────────────────
{
  plan = (n, ctx) => respond(ctx, { type: 'text/event-stream', chunks: ['data: {"delta":"half"}\n\n'], drop: true });
  const r = await within(4000, attempt(() => callGrokSearch('q', { maxTokens: 50, timeoutMs: 20000 })));
  ok(r !== '__HUNG__' && r.out === null && r.ms < 2500, 'I: a stream that drops mid-way returns null now (' + (r === '__HUNG__' ? 'hung' : r.ms + 'ms') + '), not at the end of its 20s budget');
}
// ── J. search stream utf8 ─────────────────────────────────────────────────────
{
  const ev = Buffer.from('data: ' + JSON.stringify({ delta: 'Pärnu õhtu' }) + '\n\n');
  const cut = ev.indexOf(Buffer.from('ä')) + 1;
  plan = (n, ctx) => respond(ctx, { type: 'text/event-stream', chunks: [ev.subarray(0, cut), ev.subarray(cut), 'data: [DONE]\n\n'] });
  const r = await within(4000, callGrokSearch('q', { maxTokens: 50, timeoutMs: 8000 }));
  ok(r === 'Pärnu õhtu', 'J: the search stream decodes a split letter intact (' + JSON.stringify(r) + ')');
}

// ── K. the retry is cut at the deadline too ───────────────────────────────────
{
  const seen = [];
  let callStart = 0;
  plan = (n, ctx) => {
    seen.push({ n, at: Date.now() - callStart, limit: ctx.limit });
    if (n === 1) { skew += 14000; respond(ctx, { status: 500, chunks: ['{"error":"upstream"}'] }); }
    else respond(ctx, { chunks: [chat('retry ok')] });
  };
  calls = 0; callStart = Date.now();
  const r = await within(6000, attempt(() => callLLM({ messages: msgs, deadlineMs: 31000 })));
  const s2 = seen.find(x => x.n === 2);
  ok(r !== '__HUNG__' && r.out === 'retry ok' && s2 && s2.at + s2.limit <= 31000 + 50,
     'K: first attempt failed at 14s under a 31s deadline — the retry must end by the deadline (starts ' + (s2 && s2.at) + 'ms, limit ' + (s2 && s2.limit) + 'ms)');
}
// ── L. no doomed short retry after a long failed attempt ─────────────────────
{
  plan = (n, ctx) => { if (n === 1) { skew += 20000; respond(ctx, { status: 500, chunks: ['{"error":"upstream"}'] }); } else respond(ctx, { chunks: [chat('late')] }); };
  calls = 0;
  const r = await within(6000, attempt(() => callLLM({ messages: msgs, deadlineMs: 40000 })));
  ok(r !== '__HUNG__' && r.err && calls === 1, 'L: a 20s attempt failed with 20s left of 40s — no retry that needs 20s again (calls=' + calls + ')');
  plan = (n, ctx) => { if (n === 1) { skew += 2000; respond(ctx, { status: 500, chunks: ['{"error":"upstream"}'] }); } else respond(ctx, { chunks: [chat('second')] }); };
  calls = 0;
  const r2 = await within(6000, attempt(() => callLLM({ messages: msgs, deadlineMs: 40000 })));
  ok(r2 !== '__HUNG__' && r2.out === 'second' && calls === 2, 'L opposite: a 2s failure with 38s left is retried (calls=' + calls + ')');
}
// ── O. (v690 r3) a LATE mid-reply drop is not followed by a doomed short retry ─
{
  plan = (n, ctx) => { if (n === 1) { skew += 30000; respond(ctx, { chunks: ['{"choices":[{"mess'], drop: true }); } else respond(ctx, { chunks: [chat('too late')] }); };
  calls = 0;
  const r = await within(6000, attempt(() => callLLM({ messages: msgs, deadlineMs: 60000 })));
  ok(r !== '__HUNG__' && r.err && calls === 1, 'O: connection dropped mid-reply after 30s of a 60s deadline — no second request that needs 30s again (calls=' + calls + ')');
  plan = (n, ctx) => { if (n === 1) { skew += 2000; respond(ctx, { chunks: ['{"choices":[{"mess'], drop: true }); } else respond(ctx, { chunks: [chat('after early drop')] }); };
  calls = 0;
  const r2 = await within(6000, attempt(() => callLLM({ messages: msgs, deadlineMs: 60000 })));
  ok(r2 !== '__HUNG__' && r2.out === 'after early drop' && calls === 2, 'O opposite: an early drop (2s) is retried and answers (calls=' + calls + ')');
}
// ── M. no backoff sleep after the last attempt ────────────────────────────────
{
  const realST = globalThis.setTimeout;
  for (const kind of ['http 500', 'network error']) {
    let sleeps = 0;
    const guard = new Promise(res => realST(() => res('__HUNG__'), 6000));   // made BEFORE the patch
    globalThis.setTimeout = (fn, ms, ...a) => { if (ms >= 850 && ms <= 4400) { sleeps++; return realST(fn, 1, ...a); } return realST(fn, ms, ...a); };
    plan = kind === 'http 500'
      ? (n, ctx) => respond(ctx, { status: 500, chunks: ['{"error":"upstream"}'] })
      : (n, ctx) => { ctx.kill(); ctx.req.emit('error', new Error('socket hang up')); };
    calls = 0;
    const r = await Promise.race([attempt(() => callLLM({ messages: msgs, timeoutMs: 20000 })), guard]);
    globalThis.setTimeout = realST;
    ok(r !== '__HUNG__' && r.err && calls === 4 && sleeps === 3, 'M: ' + kind + ' x4 — 4 attempts and exactly 3 backoff sleeps (calls=' + calls + ', sleeps=' + sleeps + ') — a 4th sleep only delays giving up by ~4s');
  }
}

clearTimeout(WALL);
if (failed) { console.log(failed + ' failure(s)'); process.exit(1); }
console.log('PASS — rv-llm-2: deadlines bound every attempt, drops and trickles cannot hang a call, text is decoded whole, refusals are named');
process.exit(0);
