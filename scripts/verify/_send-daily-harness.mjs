// Shared harness for the send-daily gates (fix7-server.mjs, daily-push-timing.mjs). Not a gate itself
// (the leading underscore keeps it out of the suite).
//
// Runs api/send-daily.js's REAL handler with only the edges stubbed — https.request (Supabase and
// /api/generate-ideas answer from a per-scenario plan, zero network), web-push, the store (access
// check + heartbeat) and the brand-context loader — on a VIRTUAL CLOCK: Date.now, setTimeout and
// clearTimeout are replaced while a scenario runs, every stubbed reply is a virtual timer, and the
// driver jumps the clock to the next timer whenever the handler is waiting. So "six batches that
// each take 190 seconds" runs in milliseconds, and the times the gate checks are the times the
// handler itself saw.
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

export function createHarness(ROOT) {
  const require_ = createRequire(path.join(ROOT, 'scripts', 'verify', 'x.mjs'));
  const Module = require_('module');
  const API = path.join(ROOT, 'api');
  const stubFile = (file, exports) => { const m = new Module(file); m.filename = file; m.loaded = true; m.exports = exports; require_.cache[file] = m; };
  const stub = (rel, exports) => stubFile(require_.resolve(path.join(API, rel)), exports);

  // ── virtual clock ──
  const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, setImmediate: globalThis.setImmediate, now: Date.now };
  let vnow = 0, timers = [], seq = 0;
  const vSet = (fn, ms) => { const t = { id: ++seq, at: vnow + Math.max(0, Number(ms) || 0), fn }; timers.push(t); return t; };
  const vClear = (t) => { timers = timers.filter(x => x !== t); };
  const flush = async () => { for (let k = 0; k < 40; k++) await new Promise(r => real.setImmediate(r)); };
  async function drive(promise) {
    let done = false;
    promise.then(() => { done = true; }, () => { done = true; });
    for (let guard = 0; guard < 200000; guard++) {
      await flush();
      if (done) return;
      if (!timers.length) throw new Error('harness deadlock: the handler is waiting and no timer is pending');
      timers.sort((a, b) => (a.at - b.at) || (a.id - b.id));
      const t = timers.shift();
      vnow = Math.max(vnow, t.at);
      t.fn();
    }
    throw new Error('harness: too many steps');
  }

  // ── the edges ──
  let S = null;   // the running scenario's state
  stubFile(require_.resolve('web-push', { paths: [API] }), {
    setVapidDetails() {},
    sendNotification: (sub, payload) => new Promise((resolve) => {
      S.pushes.push({ sub, payload: JSON.parse(payload), at: vnow });
      vSet(() => resolve({ statusCode: 201 }), S.o.pushMs || 5);
    }),
  });
  stub('_publish/store.js', {
    setRequestBudget() {},
    userCanAccessBrand: (u, b) => S.access(u, b),
    heartbeat: async (job, status, detail) => { S.heartbeats.push({ job, status, detail, at: vnow }); },
  });
  stub('_brandctx.js', { loadBrandContext: async (id, opts) => { S.ctxCalls++;
    if (S.o.ctxMs) await new Promise(r => vSet(r, typeof S.o.ctxMs === 'function' ? S.o.ctxMs(id) : S.o.ctxMs));
    return { ok: true, bc: {
    brandName: 'Acme Studio', brandId: id, communities: ['Founders', 'Posting less'],
    dayRotation: { Monday: 'Founders', Tuesday: 'Posting less', Wednesday: 'Founders', Thursday: 'Posting less',
                   Friday: 'Founders', Saturday: 'Posting less', Sunday: 'Founders', Bonus: 'All' } }, trusted: opts && opts.trusted }; } });

  const https = require_('https');
  https.request = (opts, cb) => {
    const r = new EventEmitter();
    let body = '';
    r.write = (d) => { body += d; };
    r.destroy = () => { r._dead = true; };
    r.end = () => {
      let parsed = null; try { parsed = body ? JSON.parse(body) : null; } catch (e) {}
      const rec = { method: opts.method, host: opts.hostname, path: opts.path, headers: opts.headers || {}, timeout: opts.timeout, body: parsed, at: vnow };
      S.reqs.push(rec);
      const out = S.route(rec);
      const ms = out === 'hang' ? Infinity : (out && out.ms != null ? out.ms : 5);
      if (opts.timeout && ms > opts.timeout) { vSet(() => r.emit('timeout'), opts.timeout); return; }
      if (ms === Infinity) return;   // no timeout armed: it never answers
      vSet(() => {
        if (r._dead) return;
        const resp = new EventEmitter(); resp.statusCode = out.status;
        cb(resp);
        const raw = out.body == null ? '' : (typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
        if (raw) resp.emit('data', raw);
        resp.emit('end');
      }, ms);
    };
    return r;
  };

  Object.assign(process.env, {
    CRON_SECRET: 'cron-test', VAPID_PUBLIC_KEY: 'vp', VAPID_PRIVATE_KEY: 'vk', VAPID_SUBJECT: 'mailto:t@t',
    SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'svc-test-key', VERCEL_URL: 'app.test',
  });
  const sendDaily = require_(path.join(API, 'send-daily.js'));
  const sdSrc = fs.readFileSync(path.join(API, 'send-daily.js'), 'utf8');

  // ── fixtures ──
  const NOW = new Date();
  const WK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const ago = (days) => new Date(NOW.getTime() - days * 86400000).toISOString();
  const SUB = { id: 'sub1', user_id: 'U1', brand_id: 'B-OK', subscription: { endpoint: 'https://push/e1' },
    send_hour: NOW.getUTCHours(), tz_offset_min: 0, tz_name: null, last_sent_at: null, motivation_on: true };
  const mkSub = (k, extra) => Object.assign({}, SUB, { id: 'sub' + k, user_id: 'U' + k, brand_id: 'B' + k,
    subscription: { endpoint: 'https://push/e' + k } }, extra || {});
  const mkIdea = (title, day) => ({ title, hook: 'Everyone posts every day.', script: 'Everyone posts every day. The fix is boring.',
    caption: 'Post less.', shots: 'desk', tags: '#acme', format: 'video', community: 'Founders', day,
    emphasis: ['The fix is boring', 'not in the text'], belief: 'Posting less grows faster', reelTitle: 'Post less' });
  const genOf = (body, prefix) => ({ ideas: (body.gaps || []).map((g, k) => mkIdea((prefix || 'Idea') + ' ' + (k + 1), g.day)) });
  const ACTIVE = [{ created_at: ago(0.2), status: 'done', title: 'Shipped yesterday', format: 'video', day: 'Monday' },
                  { created_at: ago(0.3), status: 'dismissed', title: 'Nope idea', format: 'micro', day: 'Tuesday', dismiss_reason: 'too salesy' }];
  const pendingRows = (n, extra) => Array.from({ length: n }, (_, k) => Object.assign({ created_at: ago(0.5), status: 'pending', title: 'Waiting ' + k }, extra || {}));
  const quiet = { log() {}, error() {}, warn() {} };

  // o: { subs, rows (array | fn(brandId)), access, gen(rq) -> {status, body, ms} | 'hang', genMs (n | fn(brandId)),
  //      insert(n, rq), noGenFlowCol (bool | fn(brandId)), dbMs (n | fn(brandId)), ctxMs (n | fn(brandId)),
  //      hbDetail, hbFail, pushMs, prefix, verbose }
  async function run(o) {
    o = o || {};
    S = { o, pushes: [], heartbeats: [], reqs: [], inserts: [], gens: [], ctxCalls: 0,
      access: o.access || (async (u, b) => b === 'B-OK' || /^B\d+$/.test(String(b))) };
    let insertN = 0;
    S.route = (rq) => {
      if (rq.host === 'app.test' && rq.path === '/api/generate-ideas') {
        S.gens.push(rq);
        if (o.gen) return o.gen(rq);
        return { status: 200, body: genOf(rq.body, (o.prefix || 'Idea') + ' ' + rq.body.forBrandId),
                 ms: typeof o.genMs === 'function' ? o.genMs(rq.body.forBrandId) : (o.genMs || 5) };
      }
      if (rq.method === 'GET' && rq.path.startsWith('/rest/v1/job_heartbeats')) {
        if (o.hbFail) return { status: 500, body: { message: 'down' } };
        return { status: 200, body: o.hbDetail === undefined ? [] : [{ detail: o.hbDetail }] };
      }
      if (rq.method === 'GET' && rq.path.startsWith('/rest/v1/push_subscriptions')) return { status: 200, body: o.subs || [SUB] };
      if (rq.method === 'GET' && rq.path.startsWith('/rest/v1/ideas')) {
        const b = decodeURIComponent((rq.path.match(/brand_id=eq\.([^&]+)/) || [])[1] || '');
        const dms = typeof o.dbMs === 'function' ? o.dbMs(b) : (o.dbMs || 5);
        const noCol = typeof o.noGenFlowCol === 'function' ? o.noGenFlowCol(b) : o.noGenFlowCol;
        if (noCol && /gen_flow/.test(rq.path)) return { status: 400, body: { code: '42703', message: 'column ideas.gen_flow does not exist' }, ms: dms };
        let rows = (typeof o.rows === 'function' ? o.rows(b) : (o.rows || ACTIVE)).slice().sort((a, c) => (a.created_at < c.created_at ? 1 : -1));
        if (noCol) rows = rows.map(r => { const c = Object.assign({}, r); delete c.gen_flow; return c; });
        return { status: 200, body: rows, ms: dms };
      }
      if (rq.method === 'POST' && rq.path === '/rest/v1/ideas') {
        S.inserts.push(rq);
        return o.insert ? o.insert(insertN++, rq) : { status: 201, body: null };
      }
      if (rq.method === 'PATCH' || rq.method === 'DELETE') return { status: 204, body: null };
      return { status: 404, body: null };
    };
    const res = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    const saved = { log: console.log, error: console.error, warn: console.warn };
    vnow = 0; timers = [];
    globalThis.setTimeout = vSet; globalThis.clearTimeout = vClear; Date.now = () => vnow;
    if (!o.verbose) Object.assign(console, quiet);
    try { await drive(sendDaily({ headers: { authorization: 'Bearer cron-test' } }, res)); }
    finally {
      globalThis.setTimeout = real.setTimeout; globalThis.clearTimeout = real.clearTimeout; Date.now = real.now;
      Object.assign(console, saved);
    }
    return { res, inserts: S.inserts, gens: S.gens, pushes: S.pushes, heartbeats: S.heartbeats, reqs: S.reqs, ctxCalls: S.ctxCalls, endAt: vnow };
  }
  return { run, sdSrc, stub, require_, API, NOW, WK, ago, SUB, mkSub, mkIdea, genOf, ACTIVE, pendingRows };
}
