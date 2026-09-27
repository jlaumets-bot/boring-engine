#!/usr/bin/env node
// GATE rv2-lab-1 (v693 content-v2, leaf-T): the Claude provider, the Content Lab blind test and the
// filmed-rate metrics RUN correctly — real modules, zero network.
//
//   L  api/_llm.js with node:https replaced by an in-memory server:
//      L1 Claude request shape (host, path, x-api-key, anthropic-version, model, system/messages,
//         no temperature, effort → output_config, images) — and the key is never logged
//      L2 text comes from the text blocks only; wantMeta.truncated = stop_reason 'max_tokens'
//      L3 retries on 529 / 5xx / plain 429 only; other 4xx are not retried
//      L4 refusal → AI_UNAVAILABLE: 401/402/403, low credit (400), spend cap (429), no key
//      L5 deadline respected (never-answering server, and a 529 storm)
//      L6 Grok stays the default; `effort` overrides reasoning_effort for one call only
//   B  api/blind-test.js with store/_requireUser/_brandctx/remix/_write stubbed:
//      access (missing/empty env, other user, other brand), labels shuffled per input, runCell per
//      arm, arm_unavailable, arms hidden until every input has a pick, pick/reveal tally
//   M  api/content-metrics.js: counts per flow via the grouped function, via rows, and with the
//      gen_flow column missing
// RUN: node scripts/verify/rv2-lab-1.mjs     EXPECT: "CONTENT LAB OK", exit 0.
import { EventEmitter } from 'node:events';
import Module, { createRequire } from 'node:module';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = path.join(ROOT, 'api');
const WALL = setTimeout(() => { console.log('FAIL: rv2-lab-1 wall clock (100s) — something hung'); process.exit(1); }, 100000);

let failed = 0;
const ok = (c, m) => { if (c) console.log('ok: ' + m); else { console.log('FAIL: ' + m); failed++; } };
const within = (ms, p) => Promise.race([p, new Promise(r => setTimeout(() => r('__HUNG__'), ms))]);
const attempt = async (fn) => { const t0 = Date.now(); let out, err = null; try { out = await fn(); } catch (e) { err = e; } return { out, err, ms: Date.now() - t0 }; };

// ─────────────────────────────── L: api/_llm.js ───────────────────────────────
const KEY = 'sk-ant-test-only-NOT-A-REAL-KEY-7f3a';
delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_MODEL; delete process.env.XAI_REASONING_EFFORT;
process.env.XAI_API_KEY = 'xai-test-only';
const https = require_('https');
let reqs = [], plan = null;
https.request = (opts, cb) => {
  const req = new EventEmitter();
  const rec = { opts, body: '' };
  let dead = false;
  req.setTimeout = () => req;
  req.write = (b) => { rec.body += b; };
  req.destroy = (e) => { if (dead) return; dead = true; if (e) setImmediate(() => req.emit('error', e)); };
  req.end = () => { reqs.push(rec); const n = reqs.length; setTimeout(() => {
    if (dead) return;
    const a = plan(n, rec);
    if (!a) return;                                     // never answers
    const resp = new EventEmitter(); resp.statusCode = a.status || 200; resp.headers = { 'content-type': 'application/json' }; resp.complete = false;
    cb(resp); resp.emit('data', Buffer.from(typeof a.body === 'string' ? a.body : JSON.stringify(a.body)));
    resp.complete = true; resp.emit('end'); resp.emit('close');
  }, 1); };
  return req;
};
const logs = [];
const origLog = console.log, origErr = console.error;
let capDepth = 0;   // counted, so overlapping handler calls cannot switch capture off under each other
const capture = (on) => { capDepth = Math.max(0, capDepth + (on ? 1 : -1)); if (capDepth) { console.log = (...a) => logs.push(a.join(' ')); console.error = (...a) => logs.push(a.join(' ')); } else { console.log = origLog; console.error = origErr; } };
const claudeOk = (blocks, stop = 'end_turn') => ({ status: 200, body: { type: 'message', role: 'assistant', content: blocks, stop_reason: stop, usage: { output_tokens: 12 } } });
const claudeErr = (status, type, message, details) => ({ status, body: { type: 'error', error: Object.assign({ type, message }, details ? { details } : {}) } });
const lastBody = () => JSON.parse(reqs[reqs.length - 1].body);

const llm = require_(path.join(API, '_llm.js'));
const { callLLM, aiUnavailable } = llm;
const msgs = [{ role: 'system', content: 'SYS-ONE' }, { role: 'system', content: 'SYS-TWO' }, { role: 'user', content: 'hello' }, { role: 'user', content: 'again' }];

capture(true);
// L1 — request shape
{
  process.env.ANTHROPIC_API_KEY = KEY;
  reqs = []; plan = () => claudeOk([{ type: 'text', text: 'hi there' }]);
  const out = await callLLM({ messages: msgs, provider: 'claude', effort: 'high', max_tokens: 900, temperature: 0.9 });
  const r = reqs[0], b = JSON.parse(r.body), h = r.opts.headers || {};
  capture(false);
  ok(out === 'hi there', 'L1: a Claude call returns the reply text (' + JSON.stringify(out) + ')');
  ok(r.opts.hostname === 'api.anthropic.com' && r.opts.path === '/v1/messages' && r.opts.method === 'POST', 'L1: POST api.anthropic.com/v1/messages (' + r.opts.hostname + r.opts.path + ')');
  ok(h['x-api-key'] === KEY && h['anthropic-version'] === '2023-06-01' && /application\/json/.test(h['content-type'] || ''), 'L1: headers x-api-key, anthropic-version 2023-06-01, content-type json');
  ok(!h.Authorization && !h.authorization, 'L1: no Bearer Authorization header is sent to Anthropic');
  ok(b.model === 'claude-opus-5-5', 'L1: default model is the verified current id claude-opus-5-5 (' + b.model + ')');
  ok(b.system === 'SYS-ONE\n\nSYS-TWO', 'L1: system messages become the top-level system field (' + JSON.stringify(b.system) + ')');
  ok(Array.isArray(b.messages) && b.messages.length === 1 && b.messages[0].role === 'user' && b.messages[0].content === 'hello\n\nagain', 'L1: messages carry only user/assistant turns, consecutive turns merged (' + JSON.stringify(b.messages) + ')');
  ok(!('temperature' in b) && !('top_p' in b), 'L1: temperature is never sent (Opus 5.5 rejects a non-default value)');
  ok(b.output_config && b.output_config.effort === 'high', 'L1: effort high becomes output_config.effort (' + JSON.stringify(b.output_config) + ')');
  ok(b.max_tokens >= 900 && b.max_tokens <= 64000, 'L1: max_tokens keeps the caller budget plus thinking room (' + b.max_tokens + ')');
  capture(true);
  process.env.ANTHROPIC_MODEL = 'claude-sonnet-5';
  reqs = [];
  await callLLM({ messages: [{ role: 'system', content: 'only instructions' }], provider: 'claude', effort: 'turbo', images: [{ mime: 'image/png', data: 'AAAA' }, { mime: 'image/tiff', data: 'BBBB' }] });
  const b2 = lastBody();
  delete process.env.ANTHROPIC_MODEL;
  reqs = [];
  await callLLM({ messages: [{ role: 'user', content: 'look' }], provider: 'claude', images: [{ mime: 'image/png', data: 'AAAA' }, { mime: 'image/tiff', data: 'BBBB' }] });
  const b3 = lastBody();
  capture(false);
  ok(b2.model === 'claude-sonnet-5', 'L1 opposite: ANTHROPIC_MODEL overrides the default (' + b2.model + ')');
  ok(!b2.output_config, 'L1 opposite: an effort outside low/medium/high is ignored, not sent');
  ok(!b2.system && b2.messages.length === 1 && b2.messages[0].role === 'user' && /only instructions/.test(JSON.stringify(b2.messages[0].content)), 'L1: a system-only call becomes one user turn (the API needs one)');
  const blocks = Array.isArray(b3.messages[0].content) ? b3.messages[0].content : [];
  ok(blocks.length === 2 && blocks[0].type === 'image' && blocks[0].source.type === 'base64' && blocks[0].source.media_type === 'image/png' && blocks[1].type === 'text' && blocks[1].text === 'look',
    'L1: a png is attached as a base64 image block, an unsupported tiff is dropped (' + JSON.stringify(blocks).slice(0, 160) + ')');
  ok(!logs.some(l => l.indexOf(KEY) !== -1), 'L1: the API key never appears in any log line');
}
// L2 — text extraction + truncation flag
{
  capture(true);
  reqs = []; plan = () => claudeOk([{ type: 'thinking', thinking: 'secret reasoning' }, { type: 'text', text: 'Hello ' }, { type: 'web_search_tool_result', text: 'NOT-A-TEXT-BLOCK' }, { type: 'text', text: 'world' }]);
  const t = await callLLM({ messages: msgs, provider: 'claude' });
  plan = () => claudeOk([{ type: 'text', text: 'cut' }], 'max_tokens');
  const m1 = await callLLM({ messages: msgs, provider: 'claude', wantMeta: true });
  plan = () => claudeOk([{ type: 'text', text: 'whole' }], 'end_turn');
  const m2 = await callLLM({ messages: msgs, provider: 'claude', wantMeta: true });
  capture(false);
  ok(t === 'Hello world', 'L2: only blocks of type text are returned, joined; thinking and other block types are dropped (' + JSON.stringify(t) + ')');
  ok(m1 && m1.truncated === true && m1.text === 'cut', 'L2: stop_reason max_tokens → wantMeta truncated:true');
  ok(m2 && m2.truncated === false, 'L2 opposite: end_turn → truncated:false');
}
// L3 — which failures are retried
{
  capture(true);
  const run = async (first) => { reqs = []; plan = (n) => n === 1 ? first : claudeOk([{ type: 'text', text: 'second' }]); return attempt(() => callLLM({ messages: msgs, provider: 'claude', deadlineMs: 20000 })); };
  const r529 = await run(claudeErr(529, 'overloaded_error', 'Overloaded')); const n529 = reqs.length;
  const r500 = await run(claudeErr(500, 'api_error', 'boom')); const n500 = reqs.length;
  const r429 = await run(claudeErr(429, 'rate_limit_error', 'slow down')); const n429 = reqs.length;
  const r400 = await run(claudeErr(400, 'invalid_request_error', 'messages: bad shape')); const n400 = reqs.length;
  const r404 = await run(claudeErr(404, 'not_found_error', 'model not found')); const n404 = reqs.length;
  capture(false);
  ok(r529.out === 'second' && n529 === 2, 'L3: 529 overloaded is retried (calls=' + n529 + ')');
  ok(r500.out === 'second' && n500 === 2, 'L3: 500 is retried (calls=' + n500 + ')');
  ok(r429.out === 'second' && n429 === 2, 'L3: a plain 429 rate limit is retried (calls=' + n429 + ')');
  ok(r400.err && n400 === 1 && r400.err.code !== 'AI_UNAVAILABLE', 'L3 opposite: an ordinary 400 is not retried and is not "unavailable" (calls=' + n400 + ')');
  ok(r404.err && n404 === 1, 'L3 opposite: 404 is not retried (calls=' + n404 + ')');
}
// L4 — refusals
{
  capture(true);
  const refusal = async (a) => { reqs = []; plan = () => a; const r = await attempt(() => callLLM({ messages: msgs, provider: 'claude', deadlineMs: 20000 })); return { r, n: reqs.length }; };
  const res = {
    401: await refusal(claudeErr(401, 'authentication_error', 'invalid x-api-key')),
    402: await refusal(claudeErr(402, 'billing_error', 'payment issue')),
    403: await refusal(claudeErr(403, 'permission_error', 'no permission')),
    credit: await refusal(claudeErr(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.')),
    cap: await refusal(claudeErr(429, 'rate_limit_error', 'You have reached your API usage limits', { error_code: 'enforced_spend_limit_reached' })),
  };
  delete process.env.ANTHROPIC_API_KEY;
  reqs = [];
  const nokey = await attempt(() => callLLM({ messages: msgs, provider: 'claude' }));
  const nokeyCalls = reqs.length;
  process.env.ANTHROPIC_API_KEY = KEY;
  capture(false);
  for (const [k, { r, n }] of Object.entries(res)) ok(r.err && r.err.code === 'AI_UNAVAILABLE' && n === 1 && aiUnavailable(r.err) && aiUnavailable(r.err).status === 503,
    'L4: ' + k + ' → AI_UNAVAILABLE after one call, 503 via aiUnavailable (code=' + (r.err && r.err.code) + ', calls=' + n + ')');
  ok(nokey.err && nokey.err.code === 'AI_UNAVAILABLE' && nokey.err.refused === 'no-key' && nokeyCalls === 0, 'L4: no ANTHROPIC_API_KEY → AI_UNAVAILABLE refused no-key, zero requests');
  ok(aiUnavailable(nokey.err) && /isn't available/.test(aiUnavailable(nokey.err).body.error), 'L4: the no-key message says "not available", not "hit a limit"');
}
// L5 — deadline
{
  capture(true);
  reqs = []; plan = () => null;
  const r = await within(6000, attempt(() => callLLM({ messages: msgs, provider: 'claude', deadlineMs: 1200, timeoutMs: 5000 })));
  plan = () => claudeErr(529, 'overloaded_error', 'Overloaded');
  reqs = [];
  const s = await within(9000, attempt(() => callLLM({ messages: msgs, provider: 'claude', deadlineMs: 2500 })));
  const storm = reqs.length;
  capture(false);
  ok(r !== '__HUNG__' && r.err && r.ms < 2500, 'L5: a Claude call that never answers ends by its 1.2s deadline (' + (r === '__HUNG__' ? 'hung' : r.ms + 'ms') + ')');
  ok(s !== '__HUNG__' && s.err && s.ms < 3500 && storm >= 1 && storm < 4, 'L5: a 529 storm stops retrying inside a 2.5s deadline (' + (s === '__HUNG__' ? 'hung' : s.ms + 'ms, calls=' + storm) + ')');
}
// L7 — a Claude safety refusal is a failure, never a reply (v693 r2)
{
  capture(true);
  reqs = []; plan = () => claudeOk([{ type: 'text', text: 'Here is the scr' }], 'refusal');
  const part = await attempt(() => callLLM({ messages: msgs, provider: 'claude', deadlineMs: 20000 }));
  const nPart = reqs.length;
  reqs = []; plan = () => claudeOk([], 'refusal');
  const empty = await attempt(() => callLLM({ messages: msgs, provider: 'claude', deadlineMs: 20000 }));
  const nEmpty = reqs.length;
  capture(false);
  ok(part.err && part.err.code === 'MODEL_REFUSAL' && !aiUnavailable(part.err) && nPart === 1 && part.out === undefined, 'L7: stop_reason refusal with partial text → MODEL_REFUSAL error, not returned as text, not retried, not AI_UNAVAILABLE (' + (part.err ? part.err.code : JSON.stringify(part.out)) + ')');
  ok(empty.err && empty.err.code === 'MODEL_REFUSAL' && nEmpty === 1, 'L7: a refusal with no text → the same MODEL_REFUSAL error, one call (' + (empty.err && empty.err.code) + ')');
}
// L8 — equal thinking headroom inside the lab only (v693 r2)
{
  capture(true);
  plan = (n, rec) => rec.opts.hostname === 'api.anthropic.com' ? claudeOk([{ type: 'text', text: 'c' }]) : { status: 200, body: { choices: [{ message: { content: 'g' }, finish_reason: 'stop' }], usage: {} } };
  const mt = async (o) => { reqs = []; await callLLM(Object.assign({ messages: msgs, max_tokens: 1500 }, o)); return JSON.parse(reqs[0].body).max_tokens; };
  const gOut = await mt({ effort: 'high' });
  const gIn = await llm.withThinkingHeadroom(() => mt({ effort: 'high' }));
  const cIn = await llm.withThinkingHeadroom(() => mt({ effort: 'high', provider: 'claude' }));
  const gInMed = await llm.withThinkingHeadroom(() => mt({ effort: 'medium' }));
  const gDefault = await mt({});
  const flagIn = await llm.withThinkingHeadroom(async () => llm.inThinkingHeadroom());
  capture(false);
  ok(gOut === 1500 && gDefault === 1500, 'L8: outside the lab Grok sends the caller max_tokens unchanged (' + gOut + ', ' + gDefault + ')');
  ok(gIn === cIn && gIn === 1500 + 12000 && gInMed === 1500 + 6000, 'L8: inside the lab Grok high gets the same room as Claude high (' + gIn + ' vs ' + cIn + ', medium ' + gInMed + ')');
  ok(flagIn === true && llm.inThinkingHeadroom() === false, 'L8: the headroom context is scoped to the wrapped call only');
}
// L6 — Grok default + effort override
{
  capture(true);
  const grok = (content) => ({ status: 200, body: { choices: [{ message: { content }, finish_reason: 'stop' }], usage: {} } });
  plan = () => grok('from grok');
  const sent = async (o) => { reqs = []; const out = await callLLM(Object.assign({ messages: msgs }, o)); return { out, host: reqs[0].opts.hostname, b: JSON.parse(reqs[0].body) }; };
  const d = await sent({});
  const hi = await sent({ effort: 'high' });
  const bad = await sent({ effort: 'xhigh' });
  const typo = await sent({ provider: 'Claude' });
  process.env.XAI_REASONING_EFFORT = 'medium';
  const envOnly = await sent({});
  const envHi = await sent({ effort: 'high' });
  delete process.env.XAI_REASONING_EFFORT;
  capture(false);
  ok(d.out === 'from grok' && d.host === 'api.x.ai' && d.b.reasoning_effort === 'low' && d.b.temperature === 0.7, 'L6: no provider → Grok at api.x.ai, effort low, temperature kept (' + d.host + ', ' + d.b.reasoning_effort + ')');
  ok(hi.b.reasoning_effort === 'high', 'L6: effort high overrides the xAI reasoning_effort for that call (' + hi.b.reasoning_effort + ')');
  ok(bad.b.reasoning_effort === 'low', 'L6 opposite: an invalid effort is ignored (' + bad.b.reasoning_effort + ')');
  ok(typo.host === 'api.x.ai', 'L6 opposite: only exactly "claude" switches provider (' + typo.host + ')');
  ok(envOnly.b.reasoning_effort === 'medium' && envHi.b.reasoning_effort === 'high', 'L6: the env level still applies without an override, and the override beats it for one call');
}

// ─────────────────────────────── B: api/blind-test.js ───────────────────────────────
// In-memory Supabase for the handlers.
const db = { before: {}, blind_tests: [], ideas: [], rpc: { set_cell: true, set_pick: true, metrics: true, reset: true, reveal: true }, genFlowCol: true, paths: [] };
let nextId = 1;
const access = { owner: ['brand-1'], other: ['brand-1'] };
const qs = (p) => { const q = {}; const i = p.indexOf('?'); if (i < 0) return q; for (const kv of p.slice(i + 1).split('&')) { const j = kv.indexOf('='); q[decodeURIComponent(kv.slice(0, j))] = decodeURIComponent(kv.slice(j + 1)); } return q; };
const clone = (x) => JSON.parse(JSON.stringify(x));
const fakeStore = {
  async userCanAccessBrand(uid, bid) { return (access[uid] || []).indexOf(bid) !== -1; },
  async rest(method, p, opts = {}) {
    db.paths.push(method + ' ' + p);
    if (db.slowMs && (p.startsWith('/rpc/content_metrics') || p.startsWith('/ideas'))) await new Promise(r => setTimeout(r, db.slowMs));
    const body = opts.body;
    if (p.startsWith('/rpc/')) {
      const fn = p.slice(5);
      if (db.before && db.before[fn]) { const h = db.before[fn]; db.before[fn] = null; await h(body); }   // one-shot race hook
      const allPickedRow = (row) => row.inputs.length > 0 && row.inputs.every((_, i) => !!(row.picks || {})[String(i)]);
      if (fn === 'blind_test_reset') {
        if (!db.rpc.reset) return { status: 404, data: { code: 'PGRST202' } };
        const row = db.blind_tests.find(r => r.id === body.p_id); if (!row) return { status: 200, data: null };
        const fresh = row.cells.some(c => c.status === 'running' && (c.startedAt || 0) >= Date.now() - 330000);
        if ((row.generation || 0) !== body.p_generation || JSON.stringify(row.cells) !== JSON.stringify(body.p_old_cells) || fresh) return { status: 200, data: null };
        Object.assign(row, { cells: clone(body.p_new_cells), picks: {}, revealed_at: null, generation: (row.generation || 0) + 1 });
        return { status: 200, data: row.generation };
      }
      if (fn === 'blind_test_reveal') {
        if (!db.rpc.reveal) return { status: 404, data: { code: 'PGRST202' } };
        const row = db.blind_tests.find(r => r.id === body.p_id); if (!row) return { status: 200, data: null };
        if (row.revealed_at || (row.generation || 0) !== body.p_generation || !allPickedRow(row)) return { status: 200, data: null };
        row.revealed_at = new Date().toISOString(); return { status: 200, data: true };
      }
      if (fn === 'blind_test_set_cell' && body.p_claim === true) {   // the claim mode (same function)
        if (!db.rpc.set_cell) return { status: 404, data: { code: 'PGRST202' } };
        const row = db.blind_tests.find(r => r.id === body.p_id); if (!row) return { status: 200, data: null };
        const c = row.cells[body.p_index]; if (!c) return { status: 200, data: null };
        if (body.p_cell && (c.inputIndex !== body.p_cell.inputIndex || c.arm !== body.p_cell.arm)) return { status: 200, data: null };   // identity guard
        const st = c.status || 'pending';
        const can = st === 'pending' || st === 'error' || (body.p_force && st === 'done') || (st === 'running' && (c.startedAt || 0) < Date.now() - 330000);
        if (!can) return { status: 200, data: null };
        Object.assign(c, { status: 'running', startedAt: Date.now() }); return { status: 200, data: true };
      }
      if (fn === 'blind_test_set_cell') {
        if (!db.rpc.set_cell) return { status: 404, data: { code: 'PGRST202' } };
        const row = db.blind_tests.find(r => r.id === body.p_id); if (!row || db.rpc.gone) return { status: 200, data: null };
        const cur = row.cells[body.p_index];
        if (!cur || cur.inputIndex !== body.p_cell.inputIndex || cur.arm !== body.p_cell.arm) return { status: 200, data: null };   // identity guard
        row.cells[body.p_index] = Object.assign(clone(body.p_cell), { index: cur.index, label: cur.label }); return { status: 200, data: true };
      }
      if (fn === 'blind_test_set_pick') {
        if (!db.rpc.set_pick) return { status: 404, data: { code: 'PGRST202' } };
        const row = db.blind_tests.find(r => r.id === body.p_id); if (!row) return { status: 200, data: null };
        if ((row.generation || 0) !== body.p_generation || row.revealed_at || allPickedRow(row)) return { status: 200, data: null };
        row.picks[String(body.p_input)] = body.p_label; return { status: 200, data: true };
      }
      if (fn === 'content_metrics') {
        if (!db.rpc.metrics) return { status: 404, data: { code: 'PGRST202' } };
        const g = {};
        for (const r of db.ideas) { if (r.brand_id !== body.p_brand_id || r.is_generated !== true) continue;
          const f = r.gen_flow || 'v1'; g[f] = g[f] || { flow: f, generated: 0, filmed: 0 }; g[f].generated++; if (r.status === 'filming' || r.status === 'done') g[f].filmed++; }
        return { status: 200, data: Object.values(g) };
      }
      return { status: 404, data: { code: 'PGRST202' } };
    }
    const table = p.slice(1).split('?')[0];
    const q = qs(p);
    if (table === 'blind_tests') {
      if (method === 'POST') { const row = Object.assign({ id: 'bt-' + (nextId++), created_at: new Date().toISOString() }, clone(body)); db.blind_tests.push(row); return { status: 201, data: [clone(row)] }; }
      let rows = db.blind_tests;
      if (q.id) rows = rows.filter(r => 'eq.' + r.id === q.id);
      if (q.created_by) rows = rows.filter(r => 'eq.' + r.created_by === q.created_by);
      if (method === 'GET') return { status: 200, data: clone(rows) };
      if (method === 'PATCH') { for (const r of rows) Object.assign(r, clone(body)); return { status: 200, data: clone(rows) }; }
    }
    if (table === 'ideas' && method === 'GET') {
      if (/gen_flow/.test(q.select || '') && !db.genFlowCol) return { status: 400, data: { code: '42703', message: 'column ideas.gen_flow does not exist' } };
      let rows = db.ideas.filter(r => 'eq.' + r.brand_id === q.brand_id && (q.is_generated !== 'is.true' || r.is_generated === true));
      const off = +q.offset || 0, lim = +q.limit || 1000;
      rows = rows.slice(off, off + lim).map(r => { const o = {}; for (const c of String(q.select).split(',')) o[c] = r[c]; return o; });
      return { status: 200, data: rows };
    }
    return { status: 500, data: { message: 'fake: unhandled ' + method + ' ' + p } };
  },
};
const calls = { legacy: [], angles: [], write: [] };
let writeBehaviour = null;
const STUBS = {
  './_publish/store': fakeStore,
  './_requireUser': async (req) => { const t = (req.headers.authorization || '').replace(/^Bearer\s+/, ''); return t ? { id: t } : null; },
  './_brandctx': { loadBrandContext: async (bid, o) => ({ ok: true, bc: { brandName: 'Test Brand', brandId: bid }, fields: 9 }) },
  './remix': { _legacyRemix: async (a) => { calls.legacy.push(Object.assign({ headroom: llm.inThinkingHeadroom() }, a)); return { remixTitle: 'Old title', remixHook: 'OLD-HOOK', remixScript: 'old script body', remixCaption: 'old caption' }; } },
  './_write': {
    runAngles: async (a) => { calls.angles.push(Object.assign({ headroom: llm.inThinkingHeadroom() }, a)); return { angles: [{ id: 'a1', belief: 'FIRST-BELIEF', why: 'w' }, { id: 'a2', belief: 'SECOND-BELIEF', why: 'w' }] }; },
    runWrite: async (a) => { calls.write.push(Object.assign({ headroom: llm.inThinkingHeadroom() }, a)); if (writeBehaviour) return writeBehaviour(a);
      return { idea: { title: 'New title ' + a.provider, hook: 'NEW-HOOK', script: 'I think ' + a.angle.belief + ' [your story: the day it broke]', caption: 'new caption', genFlow: 'v2' }, usedStories: [], usedSpeechSamples: 0 }; },
  },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && parent.filename && path.dirname(parent.filename) === API && Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
  return origLoad.apply(this, arguments);
};
const blind = require_(path.join(API, 'blind-test.js'));
const metrics = require_(path.join(API, 'content-metrics.js'));
const call = async (handler, user, body) => {
  const out = { code: 0, body: null };
  const res = { statusCode: 200, setHeader() {}, status(c) { out.code = c; this.statusCode = c; return this; }, json(b) { out.body = b; return b; }, end() { return this; } };
  const req = { method: 'POST', headers: user ? { authorization: 'Bearer ' + user, origin: 'https://contentshrimp.com' } : {}, body };
  capture(true);
  try { await handler(req, res); } finally { capture(false); }
  if (!out.code) out.code = 200;
  return out;
};
const ARMNAMES = /baseline|grok-high|"claude"|claude-/;

// B1 — access
{
  delete process.env.CONTENT_LAB_USER_IDS;
  const a = await call(blind, 'owner', { action: 'list' });
  process.env.CONTENT_LAB_USER_IDS = '';
  const b = await call(blind, 'owner', { action: 'list' });
  process.env.CONTENT_LAB_USER_IDS = ' owner , someone-else ';
  const c = await call(blind, 'other', { action: 'list' });
  const d = await call(blind, 'owner', { action: 'list' });
  const e = await call(blind, null, { action: 'list' });
  ok(a.code === 403 && a.body.code === 'not_allowed', 'B1: CONTENT_LAB_USER_IDS missing → 403 not_allowed (' + a.code + ')');
  ok(b.code === 403 && b.body.code === 'not_allowed', 'B1: CONTENT_LAB_USER_IDS empty → 403 not_allowed (' + b.code + ')');
  ok(c.code === 403 && c.body.code === 'not_allowed', 'B1: a user not on the list → 403 not_allowed (' + c.code + ')');
  ok(d.code === 200 && d.body.allowed === true && Array.isArray(d.body.tests), 'B1 opposite: a listed user (spaces trimmed) → 200 allowed (' + d.code + ')');
  ok(e.code === 401, 'B1: no sign-in → 401 (' + e.code + ')');
}
// B2 — create: validation, brand access, labels shuffled per input
let test = null;
{
  const inputs = [{ kind: 'remix', text: 'input zero' }, { kind: 'question', text: 'input one' }, { kind: 'bogus', text: 'input two' }];
  const noBrand = await call(blind, 'owner', { action: 'create', brandId: 'brand-9', inputs });
  const none = await call(blind, 'owner', { action: 'create', brandId: 'brand-1', inputs: [] });
  const six = await call(blind, 'owner', { action: 'create', brandId: 'brand-1', inputs: Array(6).fill({ kind: 'note', text: 'x' }) });
  const badArm = await call(blind, 'owner', { action: 'create', brandId: 'brand-1', inputs, arms: ['baseline', 'gpt'] });
  const r = await call(blind, 'owner', { action: 'create', brandId: 'brand-1', inputs });
  ok(noBrand.code === 403 && noBrand.body.code === 'forbidden', 'B2: a brand the user cannot access → 403 forbidden (' + noBrand.code + ')');
  ok(none.code === 400 && six.code === 400 && badArm.code === 400, 'B2: 0 inputs, 6 inputs and an unknown arm are 400 (' + [none.code, six.code, badArm.code] + ')');
  ok(r.code === 200 && r.body.id && r.body.cells.length === 9, 'B2: create with 3 inputs → id + 9 cells (' + r.code + ', ' + (r.body.cells || []).length + ')');
  ok(!ARMNAMES.test(JSON.stringify(r.body)), 'B2: the create response names no arm');
  test = db.blind_tests.find(x => x.id === r.body.id);
  let perInputOk = true;
  for (let i = 0; i < 3; i++) {
    const cs = test.cells.filter(c => c.inputIndex === i);
    perInputOk = perInputOk && cs.map(c => c.label).sort().join('') === 'ABC' && cs.map(c => c.arm).sort().join(',') === 'baseline,claude,grok-high';
  }
  ok(perInputOk, 'B2: every input has labels A/B/C, each arm exactly once');
  ok(test.cells.every((c, k) => c.index === k) && test.cells.every((c, k) => k % 3 === 0 || c.label > test.cells[k - 1].label), 'B2: cells are numbered in label order, so the index does not give the arm away');
  ok(test.inputs[2].kind === 'note' && test.inputs[0].kind === 'remix', 'B2: an unknown input kind falls back to note');
  // shuffled: over many creates the arm behind label A must vary (identity order would always be baseline)
  const seen = new Set(), perms = new Set();
  for (let k = 0; k < 30; k++) {
    const x = await call(blind, 'owner', { action: 'create', brandId: 'brand-1', inputs: inputs.slice(0, 2) });
    const row = db.blind_tests.find(t => t.id === x.body.id);
    for (let i = 0; i < 2; i++) { const cs = row.cells.filter(c => c.inputIndex === i); seen.add(cs[0].arm); perms.add(cs.map(c => c.arm).join('>')); }
  }
  ok(seen.size === 3 && perms.size >= 4, 'B2: label order is random per input (arms seen behind A: ' + seen.size + ', orders: ' + perms.size + ' of 6)');
}
// B3 — runCell per arm (outputs read from the stored row: before the reveal the runCell answer is blind)
const stored = (idx) => db.blind_tests.find(x => x.id === test.id).cells[idx];
const cellOf = (inputIndex, arm) => test.cells.find(c => c.inputIndex === inputIndex && c.arm === arm);
{
  delete process.env.ANTHROPIC_API_KEY;
  const base = await call(blind, 'owner', { action: 'runCell', id: test.id, index: cellOf(0, 'baseline').index });
  const grok = await call(blind, 'owner', { action: 'runCell', id: test.id, index: cellOf(0, 'grok-high').index });
  const cNo = await call(blind, 'owner', { action: 'runCell', id: test.id, index: cellOf(0, 'claude').index });
  const anglesAfterNoKey = calls.angles.length;
  const sb = stored(cellOf(0, 'baseline').index), sg = stored(cellOf(0, 'grok-high').index), sc = stored(cellOf(0, 'claude').index);
  ok(base.code === 200 && sb.status === 'done' && /OLD-HOOK/.test(sb.text) && /old script body/.test(sb.text), 'B3: baseline runs _legacyRemix and stores readable text (' + JSON.stringify(sb.text).slice(0, 80) + ')');
  const la = calls.legacy[0] || {};
  ok(la.source && la.source.kind === 'remix' && la.source.text === 'input zero' && la.bc && la.bc.brandName === 'Test Brand' && la.deadlineMs > 30000 && la.deadlineMs <= 260000, 'B3: _legacyRemix gets bc, the input as source, and a deadline inside the budget (' + la.deadlineMs + ')');
  ok(la.headroom === false, 'B3: the baseline runs exactly like production — no extra thinking room');
  const ga = calls.angles[0] || {}, gw = calls.write[0] || {};
  ok(ga.count === 6 && ga.provider === 'grok' && ga.effort === 'medium' && ga.headroom === true, 'B3: grok-high asks runAngles for 6 angles on Grok, effort medium, inside the thinking-headroom context (' + JSON.stringify({ c: ga.count, p: ga.provider, e: ga.effort, h: ga.headroom }) + ')');
  ok(gw.angle && gw.angle.belief === 'FIRST-BELIEF' && gw.effort === 'high' && gw.provider === 'grok' && gw.headroom === true && gw.source && gw.source.text === 'input zero', 'B3: grok-high writes the TOP angle with effort high, with thinking headroom');
  ok(sg.status === 'done' && /NEW-HOOK/.test(sg.text) && /\[your story: the day it broke\]/.test(sg.text), 'B3: the written idea is stored as readable text, story slot kept in storage');
  ok(sc.status === 'error' && sc.error === 'arm_unavailable' && anglesAfterNoKey === 1, 'B3: claude with no ANTHROPIC_API_KEY → stored error arm_unavailable, nothing spent (' + sc.error + ')');
  ok(JSON.stringify(base.body) === JSON.stringify({ cell: { index: cellOf(0, 'baseline').index, inputIndex: 0, label: cellOf(0, 'baseline').label, status: 'finished' } }) && cNo.body.cell.status === 'finished' && !('text' in grok.body.cell) && !('error' in cNo.body.cell),
    'B3: before the reveal runCell answers only "finished" — no text, no error, no arm, no timing (' + JSON.stringify(cNo.body) + ')');
  process.env.ANTHROPIC_API_KEY = KEY;
  const c1 = await call(blind, 'owner', { action: 'runCell', id: test.id, index: cellOf(1, 'claude').index });
  const ca = calls.angles[calls.angles.length - 1], cw = calls.write[calls.write.length - 1];
  ok(c1.code === 200 && stored(cellOf(1, 'claude').index).status === 'done' && ca.provider === 'claude' && cw.provider === 'claude' && ca.effort === 'medium' && cw.effort === 'high' && cw.headroom === true, 'B3: claude with a key runs the same flow on provider claude (angles medium, write high, same headroom)');
  writeBehaviour = () => { const e = new Error('refused'); e.code = 'AI_UNAVAILABLE'; e.refused = 402; throw e; };
  await call(blind, 'owner', { action: 'runCell', id: test.id, index: cellOf(2, 'claude').index });
  writeBehaviour = () => { throw new Error('parse failed'); };
  const gFail = await call(blind, 'owner', { action: 'runCell', id: test.id, index: cellOf(2, 'grok-high').index });
  writeBehaviour = null;
  ok(stored(cellOf(2, 'claude').index).error === 'arm_unavailable', 'B3: a provider refusal during the write → arm_unavailable');
  ok(gFail.code === 200 && /^failed: parse failed/.test(stored(cellOf(2, 'grok-high').index).error), 'B3 opposite: an ordinary failure is a cell error, not arm_unavailable, and not a crash');
  const sg2 = stored(cellOf(0, 'grok-high').index);
  ok(sg2.status === 'done' && sg2.arm === 'grok-high' && Number.isFinite(sg2.ms) && sg2.text, 'B3: the stored cell keeps arm, ms and text');
  // re-running a finished cell spends nothing unless forced
  const spent = calls.write.length + calls.legacy.length;
  const again = await call(blind, 'owner', { action: 'runCell', id: test.id, index: cellOf(0, 'grok-high').index });
  const spentAfter = calls.write.length + calls.legacy.length;
  const forced = await call(blind, 'owner', { action: 'runCell', id: test.id, index: cellOf(0, 'grok-high').index, force: true });
  ok(again.code === 409 && again.body.code === 'already_done' && spentAfter === spent, 'B3: runCell on a finished cell → 409 already_done, nothing spent (' + again.code + ')');
  ok(forced.code === 200 && calls.write.length + calls.legacy.length === spent + 1, 'B3 opposite: the forced run spent exactly one more write');
  // two requests for the same pending cell: only one runs
  let release; const gate = new Promise(r => { release = r; });
  writeBehaviour = async (a) => { await gate; return { idea: { title: 'T', hook: 'H', script: 'S', caption: 'C' } }; };
  const writesBefore = calls.write.length;
  // Both start together, so both READ the cell as pending: only the atomic claim can stop the second.
  const p1 = call(blind, 'owner', { action: 'runCell', id: test.id, index: cellOf(1, 'grok-high').index });
  const p2 = call(blind, 'owner', { action: 'runCell', id: test.id, index: cellOf(1, 'grok-high').index });
  setTimeout(release, 50);
  const [first, second] = await Promise.all([p1, p2]).then(rs => rs[0].code === 200 ? rs : [rs[1], rs[0]]);
  writeBehaviour = null;
  ok(first.code === 200 && second.code === 409 && second.body.code === 'already_running' && calls.write.length === writesBefore + 1, 'B3: two runCell requests for the same cell run it once; the second gets 409 already_running (' + first.code + ', ' + second.code + ')');
  // a claim that dies leaves 'running'; a request after the function limit can reclaim it
  const stale = stored(cellOf(1, 'grok-high').index);
  const saved = Object.assign({}, stale);
  Object.assign(stale, { status: 'running', startedAt: Date.now() - 400000 });
  const reclaim = await call(blind, 'owner', { action: 'runCell', id: test.id, index: cellOf(1, 'grok-high').index });
  Object.assign(stale, saved);
  ok(reclaim.code === 200, 'B3: a cell stuck "running" past the function limit can be run again (' + reclaim.code + ')');
  // fallback write path (functions not created yet) still claims and saves the cell
  db.rpc.set_cell = false;
  await call(blind, 'owner', { action: 'runCell', id: test.id, index: cellOf(1, 'baseline').index });
  const again2 = await call(blind, 'owner', { action: 'runCell', id: test.id, index: cellOf(1, 'baseline').index });
  db.rpc.set_cell = true;
  ok(stored(cellOf(1, 'baseline').index).status === 'done' && again2.code === 409, 'B3: without the SQL functions the cell is still claimed and saved (read-merge-write)');
  // the row vanished between claim and write: the function answers null, and that is NOT a save
  const keep = Object.assign({}, stored(cellOf(1, 'grok-high').index));
  db.rpc.gone = true;
  const lost = await call(blind, 'owner', { action: 'runCell', id: test.id, index: cellOf(1, 'grok-high').index, force: true });
  db.rpc.gone = false;
  Object.assign(stored(cellOf(1, 'grok-high').index), keep);
  ok(lost.code === 503 && lost.body.code === 'save_failed', 'B3: a write that matched no row is reported as save_failed, not as success (' + lost.code + ')');
  const bad = await call(blind, 'owner', { action: 'runCell', id: test.id, index: 99 });
  access.stranger = []; access.colleague = ['brand-1']; process.env.CONTENT_LAB_USER_IDS = 'owner,stranger,colleague';
  const otherBrand = await call(blind, 'stranger', { action: 'get', id: test.id });
  const notMine = {};
  for (const a of ['get', 'pick', 'reveal', 'runCell', 'reset']) notMine[a] = (await call(blind, 'colleague', { action: a, id: test.id, index: 0, inputIndex: 0, label: 'A' })).code;
  ok(bad.code === 400 && otherBrand.code === 403, 'B3: an index out of range is 400; a listed user without brand access is 403 (' + bad.code + ', ' + otherBrand.code + ')');
  access.owner = []; const lostAccess = await call(blind, 'owner', { action: 'get', id: test.id }); access.owner = ['brand-1'];
  ok(lostAccess.code === 403, 'B3: the creator who has since lost access to the brand gets 403 (' + lostAccess.code + ')');
  ok(Object.values(notMine).every(c => c === 403), 'B3: a listed user WITH brand access who did not create the test gets 403 on get/pick/reveal/runCell/reset (' + JSON.stringify(notMine) + ')');
}
// B4 — blind display until the explicit reveal; picks final; reveal tally
const G = () => db.blind_tests.find(x => x.id === test.id).generation || 0;
{
  // input 1 has a pending cell still (grok-high re-run above restored 'done'); make input 2 incomplete on purpose
  const c2base = stored(cellOf(2, 'baseline').index);
  const g0 = await call(blind, 'owner', { action: 'get', id: test.id });
  const inp = (b, i) => b.cells.filter(c => c.inputIndex === i);
  ok(g0.code === 200 && g0.body.cells.length === 9 && g0.body.cells.every(c => !('arm' in c) && !('model' in c) && !('ms' in c) && !('startedAt' in c)) && !ARMNAMES.test(JSON.stringify(g0.body)), 'B4: get with no picks shows no arm, model, timing or arm name anywhere');
  ok(c2base.status === 'pending' && inp(g0.body, 2).every(c => c.status === 'waiting' && c.text === null && c.error === null) && g0.body.progress[2].ready === false && g0.body.progress[2].finished === 2,
    'B4: an input with an unfinished cell shows no text and no per-cell status, only a count (' + JSON.stringify(g0.body.progress[2]) + ')');
  const i0 = inp(g0.body, 0);
  ok(i0.some(c => /I think FIRST-BELIEF …/.test(c.text || '')) && !/your story|\[story\]/i.test(JSON.stringify(g0.body)), 'B4: story slots are shown as "…" before the reveal — no bracketed marker at all');
  ok(i0.some(c => c.status === 'error' && c.error === 'not_available') && !/arm_unavailable/.test(JSON.stringify(g0.body)), 'B4: an error shows only as not_available before the reveal');
  await call(blind, 'owner', { action: 'runCell', id: test.id, index: c2base.index });
  const labelOf = (i, arm) => test.cells.find(c => c.inputIndex === i && c.arm === arm).label;
  const early = await call(blind, 'owner', { action: 'reveal', id: test.id });
  const badPick = await call(blind, 'owner', { action: 'pick', id: test.id, generation: G(), inputIndex: 0, label: 'Z' });
  const deadPick = await call(blind, 'owner', { action: 'pick', id: test.id, generation: G(), inputIndex: 2, label: labelOf(2, 'claude') });
  await call(blind, 'owner', { action: 'pick', id: test.id, generation: G(), inputIndex: 0, label: labelOf(0, 'baseline') });
  await call(blind, 'owner', { action: 'pick', id: test.id, generation: G(), inputIndex: 0, label: labelOf(0, 'grok-high') });   // change of mind before completion is fine
  await call(blind, 'owner', { action: 'pick', id: test.id, generation: G(), inputIndex: 1, label: labelOf(1, 'grok-high') });
  const g1 = await call(blind, 'owner', { action: 'get', id: test.id });
  db.rpc.set_pick = false;
  const noFn = await call(blind, 'owner', { action: 'pick', id: test.id, generation: G(), inputIndex: 2, label: labelOf(2, 'baseline') });
  db.rpc.set_pick = true;
  ok(noFn.code === 503 && noFn.body.code === 'lab_not_ready' && !db.blind_tests.find(x => x.id === test.id).picks['2'], 'B4: without the pick function a pick fails closed (503 lab_not_ready), nothing stored');
  const last = await call(blind, 'owner', { action: 'pick', id: test.id, generation: G(), inputIndex: 2, label: labelOf(2, 'baseline') });
  const repick = await call(blind, 'owner', { action: 'pick', id: test.id, generation: G(), inputIndex: 2, label: 'none' });
  const g2 = await call(blind, 'owner', { action: 'get', id: test.id });
  const rc = await call(blind, 'owner', { action: 'runCell', id: test.id, index: cellOf(0, 'grok-high').index, force: true });
  const rv = await call(blind, 'owner', { action: 'reveal', id: test.id });
  const g2r = await call(blind, 'owner', { action: 'get', id: test.id });
  ok(early.code === 409 && early.body.code === 'picks_incomplete', 'B4: reveal before every input has a pick → 409 (' + early.code + ')');
  ok(badPick.code === 400 && deadPick.code === 400, 'B4: a pick of an unknown label or of a failed cell is 400 (' + badPick.code + ', ' + deadPick.code + ')');
  ok(g1.body.cells.every(c => !('arm' in c)) && g1.body.complete === false, 'B4: with 2 of 3 picks, arms are still hidden');
  ok(last.code === 200 && last.body.complete === true, 'B4: the last pick completes the test');
  ok(repick.code === 409 && repick.body.code === 'picks_final' && db.blind_tests.find(x => x.id === test.id).picks['2'] === labelOf(2, 'baseline'), 'B4: once every input has a pick, a new pick is refused with 409 picks_final (' + repick.code + ')');
  ok(g2.body.complete === true && g2.body.revealed === false && g2.body.cells.every(c => !('arm' in c) && !('ms' in c)) && !/your story|arm_unavailable/.test(JSON.stringify(g2.body)) && !ARMNAMES.test(JSON.stringify(g2.body)),
    'B4: every input picked but reveal NOT pressed → get is still blind (complete:true, revealed:false)');
  ok(rc.code === 200 && JSON.stringify(Object.keys(rc.body.cell).sort()) === JSON.stringify(['index', 'inputIndex', 'label', 'status']), 'B4: runCell stays blind too until the explicit reveal (' + JSON.stringify(rc.body) + ')');
  ok(g2r.body.revealed === true && g2r.body.cells.every(c => typeof c.arm === 'string') && /your story/.test(JSON.stringify(g2r.body)) && /arm_unavailable/.test(JSON.stringify(g2r.body)) && !!db.blind_tests.find(x => x.id === test.id).revealed_at,
    'B4 opposite: after reveal, get shows the arms, the real slots and the real errors, and revealed_at is stored');
  const t = rv.body && rv.body.tally;
  ok(rv.code === 200 && t && t.wins['grok-high'] === 2 && t.wins.baseline === 1 && t.wins.claude === 0 && t.perInput[0].arm === 'grok-high' && t.perInput[2].arm === 'baseline',
    'B4: reveal tallies wins per arm (' + JSON.stringify(t && t.wins) + ')');
  ok(Array.isArray(rv.body.arms) && rv.body.arms.length === 3 && t.avgMs && 'claude' in t.avgMs, 'B4: reveal lists the arms and average time per arm');
}
// B5 — reset reshuffles; create refuses unrunnable arms; stale progress; identity-guarded writes (v693 r3)
{
  const row = () => db.blind_tests.find(x => x.id === test.id);
  const mapping = () => JSON.stringify(row().cells.map(c => c.inputIndex + ':' + c.label + '=' + c.arm));
  const textsByIdentity = () => JSON.stringify(row().cells.map(c => [c.inputIndex, c.arm, c.status, c.text]).sort());
  const before = mapping(), texts = textsByIdentity();
  const rs = await call(blind, 'owner', { action: 'reset', id: test.id });
  const g3 = await call(blind, 'owner', { action: 'get', id: test.id });
  const shapeOk = row().cells.every((c, k) => c.index === k) && [0, 1, 2].every(i => { const cs = row().cells.filter(c => c.inputIndex === i); return cs.map(c => c.label).join('') === 'ABC' && cs.map(c => c.arm).sort().join(',') === 'baseline,claude,grok-high'; });
  ok(rs.code === 200 && rs.body.labelsChanged === true && rs.body.revealed === false && rs.body.complete === false && Array.isArray(rs.body.cells) && rs.body.cells.every(c => !('arm' in c)) && !row().revealed_at && JSON.stringify(row().picks) === '{}',
    'B5: reset clears picks and revealed_at, says labelsChanged, and answers the new blind cells (' + rs.code + ')');
  ok(shapeOk && textsByIdentity() === texts, 'B5: after reset every input still has A/B/C in label order, and every writer keeps its own output');
  ok(g3.body.revealed === false && g3.body.cells.every(c => !('arm' in c)) && !/your story/.test(JSON.stringify(g3.body)), 'B5: after reset get is blind again');
  let changed = mapping() !== before, n = 0;
  while (!changed && n++ < 20) { await call(blind, 'owner', { action: 'reset', id: test.id }); changed = mapping() !== before; }
  const seenA = new Set();
  for (let k = 0; k < 24; k++) { await call(blind, 'owner', { action: 'reset', id: test.id }); seenA.add(row().cells.filter(c => c.inputIndex === 0)[0].arm); }
  ok(changed && seenA.size === 3, 'B5: reset reshuffles — the label→writer mapping changes and any writer can land on A (' + seenA.size + ' of 3 seen)');
  // reset refused while a cell is being written; a dead one does not block it
  const c0 = row().cells[0], keep = Object.assign({}, c0);
  Object.assign(c0, { status: 'running', startedAt: Date.now() });
  const busy = await call(blind, 'owner', { action: 'reset', id: test.id });
  const gl = await call(blind, 'owner', { action: 'get', id: test.id });
  Object.assign(c0, { startedAt: Date.now() - 400000 });
  const gs = await call(blind, 'owner', { action: 'get', id: test.id });
  const deadReset = await call(blind, 'owner', { action: 'reset', id: test.id });
  const revived = row().cells.find(c => c.inputIndex === keep.inputIndex && c.arm === keep.arm);
  ok(busy.code === 409 && busy.body.code === 'cells_running', 'B5: reset while a cell is being written → 409 cells_running (' + busy.code + ')');
  ok(gl.body.progress[keep.inputIndex].stale === false && gs.body.progress[keep.inputIndex].stale === true && gs.body.progress.filter(p => p.stale).length === 1, 'B5: progress[i].stale is true only for a cell running longer than the function can live');
  ok(deadReset.code === 200 && revived.status === 'pending', 'B5: a dead "running" cell does not block reset and comes back as pending');
  Object.assign(revived, { status: keep.status, text: keep.text, error: keep.error, ms: keep.ms });
  // identity guard: the cells are renumbered while a cell runs → the write fails, never lands in another slot
  const target = row().cells.find(c => c.inputIndex === 0 && c.arm === 'grok-high');
  // (a real reset is refused while this cell runs, so the renumbering is done directly, as a racing reset would)
  writeBehaviour = async () => { row().cells = row().cells.slice().reverse().map((c, k) => Object.assign(c, { index: k })); return { idea: { title: 'MOVED', hook: 'h', script: 's', caption: 'c' } }; };
  const moved = await call(blind, 'owner', { action: 'runCell', id: test.id, index: target.index, force: true });
  writeBehaviour = null;
  const landed = row().cells.filter(c => /MOVED/.test(c.text || ''));
  ok(moved.code === 503 && moved.body.code === 'save_failed' && landed.length === 0, 'B5: renumbered mid-run → save_failed, the output lands in no slot (' + moved.code + ', landed ' + landed.length + ')');
  // renumbered between the read and the claim → the claim is refused (409), nothing is spent — with and without the SQL function
  for (const fnOn of [true, false]) {
    db.rpc.set_cell = fnOn;
    const tIdx = row().cells.find(c => c.inputIndex === 2 && c.arm === 'grok-high').index;
    const origCtx = STUBS['./_brandctx'].loadBrandContext;
    STUBS['./_brandctx'].loadBrandContext = async (...a) => { const cs = row().cells; const i2 = cs.filter(c => c.inputIndex === 2); const pos = i2.map(c => c.index);
      i2.slice(1).concat(i2[0]).forEach((c, k) => { c.index = pos[k]; });   /* rotate: every cell moves */ const next = cs.slice(); i2.forEach(c => { next[c.index] = c; }); row().cells = next; return origCtx(...a); };
    const spentW = calls.write.length + calls.legacy.length;
    const r = await call(blind, 'owner', { action: 'runCell', id: test.id, index: tIdx, force: true });
    STUBS['./_brandctx'].loadBrandContext = origCtx; db.rpc.set_cell = true;
    const middleMoved = row().cells[tIdx] && row().cells[tIdx].arm !== 'grok-high';
    ok(middleMoved && r.code === 409 && calls.write.length + calls.legacy.length === spentW && row().cells.every(c => c.status !== 'running' || c.inputIndex !== 2),
      'B5: a cell renumbered before its claim is not claimed or run (' + (fnOn ? 'function' : 'fallback') + ': ' + r.code + ', moved ' + middleMoved + ', spent ' + (calls.write.length + calls.legacy.length - spentW) + ', ' + JSON.stringify(row().cells.filter(c => c.inputIndex === 2).map(c => [c.index, c.arm, c.status])) + ')');
  }
  // the fallback (no SQL function) finds the cell by identity and keeps its current label/index
  const t2 = row().cells.find(c => c.inputIndex === 1 && c.arm === 'baseline');
  db.rpc.set_cell = false;
  const orig = STUBS['./remix']._legacyRemix;
  STUBS['./remix']._legacyRemix = async (a) => { const cs = row().cells; const r = cs.slice(1).concat(cs[0]); /* rotate: every cell moves */ r.forEach((c, k) => { c.index = k; }); row().cells = r; return { remixTitle: 'FALLBACK', remixHook: 'h', remixScript: 's', remixCaption: 'c' }; };
  const fb = await call(blind, 'owner', { action: 'runCell', id: test.id, index: t2.index, force: true });
  STUBS['./remix']._legacyRemix = orig; db.rpc.set_cell = true;
  const fbCell = row().cells.find(c => /FALLBACK/.test(c.text || ''));
  ok(fb.code === 200 && fbCell && fbCell.inputIndex === 1 && fbCell.arm === 'baseline' && row().cells.indexOf(fbCell) === fbCell.index && new Set(row().cells.map(c => c.inputIndex + ':' + c.arm)).size === 9, 'B5: without the SQL function the result is saved to the SAME writer\'s cell at its new position, and no other writer\'s cell is overwritten');
  // create refuses a writer that cannot run
  delete process.env.ANTHROPIC_API_KEY;
  const inputs = [{ kind: 'note', text: 'x' }];
  const noClaude = await call(blind, 'owner', { action: 'create', brandId: 'brand-1', inputs });
  const without = await call(blind, 'owner', { action: 'create', brandId: 'brand-1', inputs, arms: ['baseline', 'grok-high'] });
  process.env.ANTHROPIC_API_KEY = KEY;
  const all = await call(blind, 'owner', { action: 'create', brandId: 'brand-1', inputs });
  ok(noClaude.code === 400 && noClaude.body.code === 'arm_unavailable' && noClaude.body.arm === 'claude' && JSON.stringify(noClaude.body.arms) === '["claude"]', 'B5: create with the claude writer and no key → 400 arm_unavailable, arm claude (' + JSON.stringify(noClaude.body) + ')');
  ok(without.code === 200 && without.body.cells.length === 2, 'B5 opposite: the same create without that writer → 200');
  ok(all.code === 200 && all.body.cells.length === 3, 'B5 opposite: with the Anthropic key set, all three writers are accepted');
}

// B6 — races and order leaks (v693 r4): reset/claim/save/pick/reveal are single database steps
{
  const mk = await call(blind, 'owner', { action: 'create', brandId: 'brand-1', inputs: [{ kind: 'note', text: 'six-a' }, { kind: 'note', text: 'six-b' }], arms: ['baseline', 'grok-high'] });
  const id = mk.body.id;
  const R = () => db.blind_tests.find(x => x.id === id);
  const g0 = await call(blind, 'owner', { action: 'get', id });
  ok(mk.body.generation === 0 && g0.body.generation === 0, 'B6: create and get report generation 0');
  // order leak: input 0 half finished → every letter answers the same 409 input_not_ready
  const i0 = R().cells.filter(c => c.inputIndex === 0);
  await call(blind, 'owner', { action: 'runCell', id, index: i0[0].index });
  const pDone = await call(blind, 'owner', { action: 'pick', id, generation: 0, inputIndex: 0, label: i0[0].label });
  const pPend = await call(blind, 'owner', { action: 'pick', id, generation: 0, inputIndex: 0, label: i0[1].label });
  ok(pDone.code === 409 && pPend.code === 409 && pDone.body.code === 'input_not_ready' && JSON.stringify(pDone.body) === JSON.stringify(pPend.body),
    'B6: while an input is unfinished, a pick of a finished and of an unfinished letter get the SAME 409 input_not_ready (' + pDone.code + '/' + pPend.code + ')');
  for (const c of R().cells) if (c.status === 'pending') await call(blind, 'owner', { action: 'runCell', id, index: c.index });
  // generation is required and must match
  const noGen = await call(blind, 'owner', { action: 'pick', id, inputIndex: 0, label: 'A' });
  const badGen = await call(blind, 'owner', { action: 'pick', id, generation: 7, inputIndex: 0, label: 'A' });
  ok(noGen.code === 400 && noGen.body.code === 'generation_required' && badGen.code === 409 && badGen.body.code === 'labels_changed' && badGen.body.generation === 0 && Object.keys(R().picks).length === 0,
    'B6: a pick without generation is 400, with a wrong one 409 labels_changed, nothing stored (' + noGen.code + ', ' + badGen.code + ')');
  // a pick in flight while a reset lands → refused, never stored on the new letters
  db.before.blind_test_set_pick = async () => { await call(blind, 'owner', { action: 'reset', id }); };
  const racing = await call(blind, 'owner', { action: 'pick', id, generation: 0, inputIndex: 0, label: 'A' });
  ok(racing.code === 409 && racing.body.code === 'labels_changed' && R().generation === 1 && Object.keys(R().picks).length === 0, 'B6: a pick that races a reset is refused (409 labels_changed), not tallied on the reshuffled letters (' + racing.code + ')');
  // reset vs a claim that lands after reset read the row → reset refuses, the claim survives, nothing runs twice
  const tgt = R().cells[0];
  db.before.blind_test_reset = async () => { Object.assign(tgt, { status: 'running', startedAt: Date.now() }); };
  const r1 = await call(blind, 'owner', { action: 'reset', id });
  const kept = R().cells.find(c => c.inputIndex === tgt.inputIndex && c.arm === tgt.arm);
  ok(r1.code === 409 && r1.body.code === 'test_changed' && kept.status === 'running' && R().generation === 1, 'B6: a claim landing between reset\'s read and write → reset 409 test_changed, the claim is kept (' + r1.code + ')');
  const spent = calls.write.length + calls.legacy.length;
  const dup = await call(blind, 'owner', { action: 'runCell', id, index: kept.index });
  ok(dup.code === 409 && calls.write.length + calls.legacy.length === spent, 'B6: so the same writer is not run (and paid) a second time');
  Object.assign(kept, { status: 'done' }); delete kept.startedAt;
  // a result that finishes between reset's read and write → reset refuses, the result is not wiped
  db.before.blind_test_reset = async () => { R().cells[1].text = 'LATE RESULT'; };
  const r2 = await call(blind, 'owner', { action: 'reset', id });
  ok(r2.code === 409 && R().cells.some(c => c.text === 'LATE RESULT'), 'B6: a result saved between reset\'s read and write is kept (reset 409)');
  // fail closed without the functions
  db.rpc.reset = false;
  const before = JSON.stringify(R().cells);
  const r3 = await call(blind, 'owner', { action: 'reset', id });
  db.rpc.reset = true;
  ok(r3.code === 503 && r3.body.code === 'lab_not_ready' && JSON.stringify(R().cells) === before && R().generation === 1, 'B6: without the reset function, reset fails closed (503 lab_not_ready) — no blind overwrite');
  const r4 = await call(blind, 'owner', { action: 'reset', id });
  const g4 = await call(blind, 'owner', { action: 'get', id });
  ok(r4.code === 200 && r4.body.generation === 2 && R().generation === 2 && g4.body.generation === 2, 'B6 opposite: a clean reset bumps the generation and returns it (' + r4.body.generation + ')');
  // reveal overlapping a reset → refused, the fresh round stays unrevealed
  for (const i of [0, 1]) await call(blind, 'owner', { action: 'pick', id, generation: 2, inputIndex: i, label: 'none' });
  db.before.blind_test_reveal = async () => { await call(blind, 'owner', { action: 'reset', id }); };
  const rv1 = await call(blind, 'owner', { action: 'reveal', id });
  ok(rv1.code === 409 && rv1.body.code === 'test_changed' && !R().revealed_at && R().generation === 3, 'B6: a reveal that races a reset is refused and the fresh round is not marked revealed (' + rv1.code + ')');
  for (const i of [0, 1]) await call(blind, 'owner', { action: 'pick', id, generation: 3, inputIndex: i, label: 'none' });
  const oldGenReveal = await call(blind, 'owner', { action: 'reveal', id, generation: 2 });
  db.rpc.reveal = false;
  const rv2 = await call(blind, 'owner', { action: 'reveal', id });
  db.rpc.reveal = true;
  const rv3 = await call(blind, 'owner', { action: 'reveal', id });
  ok(oldGenReveal.code === 409 && oldGenReveal.body.code === 'labels_changed' && rv2.code === 503 && rv2.body.code === 'lab_not_ready' && rv3.code === 200 && !!R().revealed_at,
    'B6: reveal with an old generation is 409, without the function it fails closed, and a clean reveal works (' + [oldGenReveal.code, rv2.code, rv3.code] + ')');
}

// B7 — skip a cell that could not start (v693 r5)
{
  const mk = await call(blind, 'owner', { action: 'create', brandId: 'brand-1', inputs: [{ kind: 'note', text: 'seven' }, { kind: 'note', text: 'seven-b' }], arms: ['baseline', 'grok-high'] });
  const id = mk.body.id;
  const R = () => db.blind_tests.find(x => x.id === id);
  const [a, b] = R().cells.filter(c => c.inputIndex === 0);
  await call(blind, 'owner', { action: 'runCell', id, index: a.index });
  const spent = calls.write.length + calls.legacy.length;
  const before = await call(blind, 'owner', { action: 'pick', id, generation: 0, inputIndex: 0, label: 'none' });
  const noGen = await call(blind, 'owner', { action: 'skip', id, index: b.index });
  const badGen = await call(blind, 'owner', { action: 'skip', id, index: b.index, generation: 5 });
  const onDone = await call(blind, 'owner', { action: 'skip', id, index: a.index, generation: 0 });
  const sk = await call(blind, 'owner', { action: 'skip', id, index: b.index, generation: 0 });
  const stored = R().cells.find(c => c.inputIndex === 0 && c.arm === b.arm);
  ok(before.code === 409 && before.body.code === 'input_not_ready', 'B7: with one cell never started, even "none" is 409 input_not_ready (the stuck state)');
  ok(noGen.code === 400 && badGen.code === 409 && badGen.body.code === 'labels_changed', 'B7: skip needs the current generation (' + noGen.code + ', ' + badGen.code + ')');
  ok(onDone.code === 409 && onDone.body.code === 'already_done' && R().cells[a.index].status === 'done', 'B7: skip refuses a cell that has an output (409 already_done)');
  ok(sk.code === 200 && JSON.stringify(sk.body) === JSON.stringify({ cell: { index: b.index, inputIndex: 0, label: b.label, status: 'finished' } }), 'B7: skip answers blind — only "finished" (' + JSON.stringify(sk.body) + ')');
  ok(stored.status === 'error' && stored.error === 'skipped' && stored.text === null && calls.write.length + calls.legacy.length === spent, 'B7: the skipped cell is stored as error "skipped", with no AI call and no charge');
  const g = await call(blind, 'owner', { action: 'get', id });
  ok(g.body.progress[0].ready === true && g.body.cells.filter(c => c.inputIndex === 0).some(c => c.error === 'not_available') && !/skipped/.test(JSON.stringify(g.body)), 'B7: the input is now ready, and the skip shows only as not_available before the reveal');
  const pk = await call(blind, 'owner', { action: 'pick', id, generation: 0, inputIndex: 0, label: 'none' });
  ok(pk.code === 200, 'B7: picking works again after the skip (' + pk.code + ')');
  // a cell being written cannot be skipped; a dead one can; an errored one can
  const [c, d] = R().cells.filter(x => x.inputIndex === 1);
  Object.assign(c, { status: 'running', startedAt: Date.now() });
  const live = await call(blind, 'owner', { action: 'skip', id, index: c.index, generation: 0 });
  ok(live.code === 409 && live.body.code === 'already_running' && R().cells[c.index].status === 'running', 'B7: skip refuses a cell that is being written (409 already_running)');
  Object.assign(c, { startedAt: Date.now() - 400000 });
  const dead = await call(blind, 'owner', { action: 'skip', id, index: c.index, generation: 0 });
  Object.assign(d, { status: 'error', error: 'failed: x' });
  const err = await call(blind, 'owner', { action: 'skip', id, index: d.index, generation: 0 });
  ok(dead.code === 200 && err.code === 200 && R().cells[c.index].error === 'skipped' && R().cells[d.index].error === 'skipped', 'B7: a dead running cell and a failed cell can be skipped (' + dead.code + ', ' + err.code + ')');
  // a skip racing a claim: the claim step refuses, nothing is overwritten
  const e = R().cells.find(x => x.inputIndex === 0 && x.arm === a.arm);
  Object.assign(e, { status: 'error', error: 'failed: y' });
  db.before.blind_test_set_cell = async () => { Object.assign(e, { status: 'running', startedAt: Date.now() }); };
  const race = await call(blind, 'owner', { action: 'skip', id, index: e.index, generation: 0 });
  db.before.blind_test_set_cell = null;
  ok(race.code === 409 && e.status === 'running', 'B7: a skip that races a run is refused (409) and does not overwrite the running cell (' + race.code + ')');
  const other = (process.env.CONTENT_LAB_USER_IDS = 'owner,colleague', await call(blind, 'colleague', { action: 'skip', id, index: e.index, generation: 0 }));
  ok(other.code === 403, 'B7: only the creator can skip (' + other.code + ')');
}

// ─────────────────────────────── M: api/content-metrics.js ───────────────────────────────
{
  const add = (n, o) => { for (let i = 0; i < n; i++) db.ideas.push(Object.assign({ brand_id: 'brand-1', is_generated: true, created_at: new Date().toISOString() }, o)); };
  add(6, { gen_flow: null, status: 'new' }); add(2, { gen_flow: null, status: 'done' }); add(1, { gen_flow: null, status: 'approved' });
  add(3, { gen_flow: 'v2', status: 'filming' }); add(1, { gen_flow: 'v2', status: 'new' });
  add(5, { gen_flow: null, status: 'done', is_generated: false }); add(4, { brand_id: 'brand-2', gen_flow: 'v2', status: 'done' });
  const pick = (b, f) => (b.flows || []).find(x => x.flow === f) || {};
  const viaFn = await call(metrics, 'owner', { brandId: 'brand-1' });
  db.rpc.metrics = false;
  db.paths = [];
  const viaRows = await call(metrics, 'owner', { brandId: 'brand-1' });
  const rowPath = db.paths.find(p => p.startsWith('GET /ideas')) || '';
  db.genFlowCol = false;
  const noCol = await call(metrics, 'owner', { brandId: 'brand-1' });
  const forbidden = await call(metrics, 'owner', { brandId: 'brand-2' });
  const anon = await call(metrics, null, { brandId: 'brand-1' });
  const want = (b) => pick(b, 'v1').generated === 9 && pick(b, 'v1').filmed === 2 && pick(b, 'v2').generated === 4 && pick(b, 'v2').filmed === 3 && pick(b, 'v2').rate === 0.75;
  ok(viaFn.code === 200 && want(viaFn.body) && viaFn.body.genFlowColumn === true && typeof viaFn.body.since === 'string', 'M: grouped function → v1 9 gen / 2 filmed, v2 4 gen / 3 filmed, rate 0.75 (' + JSON.stringify(viaFn.body.flows) + ')');
  ok(viaRows.code === 200 && want(viaRows.body) && /is_generated=is\.true/.test(rowPath) && /brand_id=eq\.brand-1/.test(rowPath), 'M: without the function the row count gives the same numbers, generated rows of this brand only');
  ok(noCol.code === 200 && noCol.body.genFlowColumn === false && noCol.body.flows.length === 1 && pick(noCol.body, 'v1').generated === 13 && pick(noCol.body, 'v1').filmed === 5 && /gen_flow/.test(noCol.body.note || ''),
    'M: gen_flow column missing → everything counted as v1 and the response says so (' + JSON.stringify(noCol.body.flows) + ')');
  ok(forbidden.code === 403 && anon.code === 401, 'M: another brand → 403, no sign-in → 401 (' + forbidden.code + ', ' + anon.code + ')');
  // v693 r5 — the request deadline: a slow database gets 503 timeout, not a killed function
  {
    const L = metrics._limits, keep = Object.assign({}, L);
    Object.assign(L, { budgetMs: 400, minCallMs: 100 });
    db.rpc.metrics = false; db.genFlowCol = true;
    db.slowMs = 250; db.paths = [];
    const slow = await call(metrics, 'owner', { brandId: 'brand-1' });
    const pagesTried = db.paths.filter(p => p.startsWith('GET /ideas')).length;
    db.slowMs = 320; db.paths = [];
    const noRoom = await call(metrics, 'owner', { brandId: 'brand-1' });
    const pagesTried2 = db.paths.filter(p => p.startsWith('GET /ideas')).length;
    db.slowMs = 0;
    const fast = await call(metrics, 'owner', { brandId: 'brand-1' });
    Object.assign(L, keep);
    ok(slow.code === 503 && slow.body.code === 'timeout' && pagesTried === 1, 'M: the fallback page that overruns the budget is abandoned → 503 {code:timeout} (' + slow.code + ')');
    ok(noRoom.code === 503 && noRoom.body.code === 'timeout' && pagesTried2 === 0, 'M: a call with less than the minimum time left is not started at all');
    ok(fast.code === 200 && L.budgetMs === 50000 && L.minCallMs === 9000, 'M opposite: the same request with a fast database answers 200; production limits are 50s / 9s');
  }
}

clearTimeout(WALL);
if (failed) { console.log(failed + ' failure(s)'); process.exit(1); }
console.log('CONTENT LAB OK');
