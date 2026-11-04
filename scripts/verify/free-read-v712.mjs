#!/usr/bin/env node
// GATE v712 — free link reads, capped per UTC day; the paid Apify fallback capped per day.
// Owner: Remix is the main feature — reading a video must not cost credits before the user picks a twist.
//
// WHAT IT PROVES, by running the REAL api/_usage.js, api/transcribe-url.js and api/creator-feed.js against an
// in-memory PostgREST (usage_events, user_plans, brands at the https level; creator tables through a stubbed
// store), a scripted tikwm, a scripted Groq, a scripted Apify and a fake audio host. No network, no AI, no
// Groq and no Apify calls:
//   1 a read costs 0 credits, logs a 'transcribeurl' row, and its real cost reaches the cost fuse;
//   2 the 6th read of a free account in one UTC day -> 429 daily_read_limit, nothing fetched (yesterday's do not count);
//   3 a paid plan gets 20;
//   4 a read that returns no words is not charged and not counted;
//   5 the 4th Apify fallback of a day -> fallback_limit, Apify is NOT called; each fallback is its own costed row;
//   6 a creator-feed tap counts toward the same cap and gets the same 429; its Apify fallback shares the cap;
//   7 a cached transcript and the automatic weekly-winner transcripts are free and NOT counted (and never use Apify);
//   8 the remix twist charge is unchanged (1 credit, gated in api/remix.js);
//   9 api/transcribe.js: a YouTube LINK read is free, logged as 'transcribeurl' and counted toward the same cap
//     (429 daily_read_limit), a failed one is not counted; an uploaded audio file keeps its 2-credit charge;
//  10 PARALLEL: 10 reads at once on a free plan -> exactly 5 succeed; 6 parallel Apify fallbacks -> exactly 3 runs;
//  11 one read pool per brand: a member's reads with brandId count on the owner's pool; a non-member's brandId is
//     ignored (own pool); without brandId a member uses their own pool; the feed tap shares the owner's pool;
//  12 api/health.js allows creator_feed_state (server-only, RLS on, no policy by design).
// RUN: node scripts/verify/free-read-v712.mjs   EXPECT: "PASS" and exit 0.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
const require_ = createRequire(import.meta.url);
const Module = require_('module');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = path.join(ROOT, 'api');
const WALL = setTimeout(() => { console.log('FAIL: free-read-v712 wall clock (60s) — something hung'); process.exit(1); }, 60000);
let failed = 0, passed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('ok: ' + m); } else { failed++; console.log('FAIL: ' + m); } };
const REAL = { error: console.error, warn: console.warn, log: console.log };
const quiet = async (fn) => { console.error = console.warn = console.log = () => {}; try { return await fn(); } finally { Object.assign(console, REAL); } };

process.env.SUPABASE_URL = 'https://free-read.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only-not-a-real-key';
process.env.APIFY_API_TOKEN = 'test-only-apify';
process.env.GROQ_API_KEY = 'test-only-groq';
process.env.COST_CAP_EUR = '25';
delete process.env.USAGE_RESERVATIONS; delete process.env.RATE_LIMIT_PER_MIN;
function stub(rel, exports) {
  const file = require_.resolve(path.join(API, rel));
  const m = new Module(file); m.filename = file; m.loaded = true; m.exports = exports; require_.cache[file] = m;
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const iso = (t) => new Date(t).toISOString();

// ── the fake creator-feed tables (copied from scripts/verify/creator-feed-v711.mjs: PostgREST filter rules) ──
const db = { comp: {}, state: {}, videos: {}, missing: false, failUpsert: false };
const TS = /(_at|_until)$/;
function cmp(row, k, v) {
  if (v === 'is.null') return row[k] == null;
  const m = /^(eq|neq|lt|gt)\.([\s\S]*)$/.exec(v);
  if (!m) return true;
  const a = row[k];
  if (a == null) return false;                                   // SQL: NULL compared to anything is not true
  const A = TS.test(k) ? Date.parse(a) : String(a), B = TS.test(k) ? Date.parse(m[2]) : m[2];
  if (m[1] === 'eq') return A === B;
  if (m[1] === 'neq') return A !== B;
  if (m[1] === 'lt') return A < B;
  return A > B;
}
function filt(p) {
  const q = p.indexOf('?') < 0 ? '' : p.slice(p.indexOf('?') + 1);
  const fs = [];
  for (const part of q.split('&').filter(Boolean)) {
    const j = part.indexOf('=');
    const k = decodeURIComponent(part.slice(0, j)), v = decodeURIComponent(part.slice(j + 1));
    if (['select', 'order', 'limit', 'on_conflict'].includes(k)) continue;
    if (k === 'or' || k === 'and') fs.push(logic(k, v.replace(/^\(|\)$/g, '')));
    else fs.push((row) => cmp(row, k, v));
  }
  return (row) => fs.every(f => f(row));
}
// PostgREST logic trees: or=(a.eq.1,and(b.eq.2,c.lt.3)) — split at top-level commas only.
function splitTop(s) {
  const out = []; let depth = 0, cur = '';
  for (const ch of s) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch; }
  if (cur) out.push(cur);
  return out;
}
function logic(op, inner) {
  const parts = splitTop(inner).map(t => {
    const m = /^(and|or)\(([\s\S]*)\)$/.exec(t);
    if (m) return logic(m[1], m[2]);
    const d = t.indexOf('.'); const kk = t.slice(0, d), vv = t.slice(d + 1);
    return (row) => cmp(row, kk, vv);
  });
  return op === 'or' ? (row) => parts.some(f => f(row)) : (row) => parts.every(f => f(row));
}
const brandOf = (p) => (/brand_id=eq\.([^&]+)/.exec(p) || [])[1];
const VIDEO_DEFAULTS = { caption: null, transcript: null, transcript_status: 'none', auto: false, transcribed_at: null, auto_tried_at: null, score: 0 };
const missingTable = () => ({ status: 404, data: { code: 'PGRST205', message: "Could not find the table 'public.creator_feed_state' in the schema cache" }, raw: 'PGRST205 creator_feed_state' });
async function rest(method, p, opts) {
  const o = opts || {};
  const b = decodeURIComponent(brandOf(p) || '');
  if (p.startsWith('/competitors')) return { status: 200, data: clone(db.comp[b] || []) };
  if (p.startsWith('/creator_feed_state')) {
    if (db.missing) return missingTable();
    if (method === 'POST') { const id = o.body.brand_id; if (!db.state[id]) db.state[id] = { brand_id: id, fetched_at: null, handles: [], lock_until: null, run_id: null, run_started_at: null, failed_at: null, fail_count: 0, logged_run_id: null, last_error: null }; return { status: 201, data: null }; }
    const rows = Object.values(db.state).filter(r => r.brand_id === b).filter(filt(p));
    if (method === 'GET') return { status: 200, data: clone(rows) };
    if (method === 'PATCH') { for (const r of rows) Object.assign(r, clone(o.body)); return { status: 200, data: clone(rows) }; }
  }
  if (p.startsWith('/creator_videos')) {
    if (db.missing) return missingTable();
    const all = db.videos[b] || (db.videos[b] = {});
    if (method === 'POST') {
      if (db.failUpsert) return { status: 500, data: { message: 'boom' }, raw: 'boom' };
      for (const r of o.body) { const t = db.videos[r.brand_id] || (db.videos[r.brand_id] = {}); t[r.video_id] = Object.assign({}, VIDEO_DEFAULTS, t[r.video_id] || {}, clone(r)); }
      return { status: 201, data: null };
    }
    const rows = Object.values(all).filter(filt(p));
    if (method === 'GET') return { status: 200, data: clone(rows.sort((x, y) => Date.parse(y.fetched_at) - Date.parse(x.fetched_at))) };
    if (method === 'PATCH') { for (const r of rows) Object.assign(r, clone(o.body)); return { status: 200, data: rows.map(r => ({ video_id: r.video_id })) }; }
    if (method === 'DELETE') { for (const r of rows) delete all[r.video_id]; return { status: 204, data: null }; }
  }
  return { status: 404, data: null, raw: 'unknown path ' + p };
}

// ── the fake network: Supabase (usage_events / user_plans / brands), tikwm, Groq, Apify, the audio host ──
const https = require_('node:https');
const ev = [];                         // usage_events
const plans = new Map();
const NET = { tikwm: 0, groq: 0, apify: 0, apifyRuns: 0, download: 0, tikwmFail: () => false, groqFail: false };
const sp = (p) => new URL('https://h' + p).searchParams;
const eqv = (s, k) => { const v = s.get(k); return v && v.startsWith('eq.') ? v.slice(3) : null; };
function evMatch(s) {
  const uid = eqv(s, 'user_id'), av = s.get('action'), gte = s.get('created_at');
  const since = gte && gte.startsWith('gte.') ? Date.parse(gte.slice(4)) : null;
  let actOk = () => true;
  if (av && av.startsWith('eq.')) actOk = (a) => a === av.slice(3);
  else if (av && av.startsWith('like.')) { const re = new RegExp('^' + av.slice(5).split('*').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'); actOk = (a) => re.test(a); }
  return (r) => r.user_id === uid && actOk(r.action) && (since == null || Date.parse(r.created_at) >= since);
}
// Postgres stamps created_at at commit: strictly increasing here, so insert order IS time order.
let lastStamp = 0;
const stampNow = () => { lastStamp = Math.max(Date.now(), lastStamp + 1); return iso(lastStamp); };
const BRAND_OWNER = {};            // brand id -> owner user id (default: the caller owns it)
const NO_ACCESS = new Set();       // user ids that are NOT members of any foreign brand
function route(opts, payload) {
  const host = String(opts.hostname || '');
  if (host === 'www.tikwm.com') {
    NET.tikwm++;
    const url = decodeURIComponent((/url=([^&]*)/.exec(payload) || [])[1] || '');
    return NET.tikwmFail(url) ? { status: 200, body: JSON.stringify({ code: -1, msg: 'Url parsing is failed' }) }
      : { status: 200, body: JSON.stringify({ data: { play: 'https://cdn.tikwm.test/v.mp4' } }) };
  }
  if (host === 'api.groq.com') {
    NET.groq++;
    return NET.groqFail ? { status: 401, body: '{"error":{"message":"invalid_api_key"}}' } : { status: 200, body: 'these are the spoken words\n' };
  }
  if (host === 'api.apify.com') {
    NET.apify++;
    if (opts.method === 'POST') { NET.apifyRuns++; return { status: 201, body: JSON.stringify({ data: { defaultDatasetId: 'ds-one' } }) }; }
    return { status: 200, body: JSON.stringify([{ mediaUrls: ['https://cdn.apify.test/v.mp4'] }]) };
  }
  const table = opts.path.split('?')[0], s = sp(opts.path);
  if (table === '/rest/v1/user_plans') {
    if (opts.method === 'GET') { const r = plans.get(eqv(s, 'user_id')); return { status: 200, body: JSON.stringify(r ? [r] : []) }; }
    if (opts.method === 'POST') { const b = JSON.parse(payload); if (!plans.has(b.user_id)) plans.set(b.user_id, Object.assign({ plan: 'trial' }, b)); return { status: 201, body: '' }; }
    return { status: 204, body: '' };
  }
  if (table === '/rest/v1/brands' && opts.method === 'GET') return { status: 200, body: JSON.stringify([{ user_id: BRAND_OWNER[eqv(s, 'id')] || currentUser.id }]) };
  if (table === '/rest/v1/usage_events') {
    if (opts.method === 'GET') {
      const asc = /created_at\.asc/.test(s.get('order') || '');
      const all = ev.filter(evMatch(s)).sort((a, b) => (asc ? 1 : -1) * (Date.parse(a.created_at) - Date.parse(b.created_at)));
      const off = Number(s.get('offset') || 0), lim = Number(s.get('limit') || 1000);
      const page = all.slice(off, off + lim);
      const h = { 'content-range': page.length ? off + '-' + (off + page.length - 1) + '/' + all.length : '*/' + all.length };
      return { status: 200, headers: h, body: JSON.stringify(page) };
    }
    if (opts.method === 'POST') {
      const b = JSON.parse(payload);
      ev.push(Object.assign({ created_at: stampNow() }, b));
      return { status: 201, body: JSON.stringify([ev[ev.length - 1]]) };
    }
    if (opts.method === 'PATCH') {
      const uid = eqv(s, 'user_id'), act = eqv(s, 'action'), b = JSON.parse(payload);
      const hit = ev.filter(r => r.user_id === uid && r.action === act); hit.forEach(r => Object.assign(r, b));
      return { status: 200, body: JSON.stringify(hit) };
    }
    if (opts.method === 'DELETE') {
      const uid = eqv(s, 'user_id'), act = eqv(s, 'action');
      for (let i = ev.length - 1; i >= 0; i--) if (ev[i].user_id === uid && ev[i].action === act) ev.splice(i, 1);
      return { status: 204, body: '' };
    }
  }
  return { status: 404, body: '{}' };
}
const fakeReq = () => { const q = new EventEmitter(); q.setTimeout = () => q; q.destroy = () => q; q.setHeader = () => q; return q; };
const answer = (cb, out) => setImmediate(() => {
  const resp = new EventEmitter(); resp.statusCode = out.status; resp.headers = out.headers || {}; resp.resume = () => resp; resp.destroy = () => {};
  cb(resp); setImmediate(() => { if (out.body) resp.emit('data', Buffer.from(out.body)); resp.emit('end'); });
});
https.request = function (opts, cb) {
  const q = fakeReq(); let payload = '';
  q.write = (c) => { payload += c; return true; };
  q.end = () => { setImmediate(() => { let out; try { out = route(opts, payload); } catch (e) { q.emit('error', e); return; } answer(cb, out); }); return q; };
  return q;
};
https.get = function (url, opts, cb) {
  const u = String(url), q = fakeReq(); q.end = () => q;
  if (u.includes('youtube.com/api/timedtext')) { NET.yt++; answer(cb, { status: 200, body: '<transcript><text start="0">hello from</text><text start="1">youtube</text></transcript>' }); return q; }
  if (u.includes('youtube.com/watch')) { NET.yt++; answer(cb, { status: 200, body: '<html>no captions here</html>' }); return q; }
  NET.download++; answer(cb, { status: 200, body: 'AUDIOBYTES' }); return q;
};
// YouTube's innertube player API (api/transcribe.js calls the global fetch for it)
NET.yt = 0; NET.ytCaptions = true;
globalThis.fetch = async (url) => { NET.yt++; return { json: async () => (NET.ytCaptions && String(url).includes('youtubei/v1/player'))
  ? { captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en', baseUrl: 'https://www.youtube.com/api/timedtext?v=abcdefghijk' }] } } } : {} }; };

let currentUser = { id: 'U-FREE' };
stub('_requireUser.js', async () => currentUser);
stub('_safeurl.js', { assertPublicHttpUrl: async () => true, safeLookup: function () {}, urlRefusalMessage: (e, d) => d });
stub('_publish/store.js', { rest, setRequestBudget() {}, heartbeat: async () => {}, userCanAccessBrand: async (uid) => !NO_ACCESS.has(uid) });

const usage = require_(path.join(API, '_usage.js'));
const TU = require_(path.join(API, 'transcribe-url.js'));
const CF = require_(path.join(API, 'creator-feed.js'));
const TR = require_(path.join(API, 'transcribe.js'));

function mkRes() {
  const r = { statusCode: 200, body: undefined, headers: {} };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = () => r;
  return r;
}
const TT = (n) => 'https://www.tiktok.com/@alpha/video/' + n;
async function read(uid, url, brandId) {
  currentUser = { id: uid };
  const res = mkRes();
  await quiet(() => TU({ method: 'POST', headers: {}, body: Object.assign({ url: url || TT(1000001) }, brandId ? { brandId } : {}) }, res));
  return res;
}
async function feed(uid, body) {
  currentUser = { id: uid };
  const res = mkRes();
  await quiet(() => CF({ method: 'POST', headers: {}, body }, res));
  return res;
}
const rowsOf = (uid, act) => ev.filter(r => r.user_id === uid && r.action === act);
const holdsOf = (uid) => ev.filter(r => r.user_id === uid && String(r.action).startsWith('hold:'));
const PLAIN = /^[A-Z][^{}<>]*[.!]$/;
const RAW = /HTTP|apify|groq|whisper|sk-|stack|undefined|null|\[object|ECONN|status/i;
const future = iso(Date.now() + 5 * DAY);

// ── 1. a read costs 0 credits and logs its cost ──
{
  plans.set('U-FREE', { user_id: 'U-FREE', plan: 'free' });
  const r = await read('U-FREE');
  ok(r.statusCode === 200 && r.body && r.body.transcript === 'these are the spoken words', '1a a link read answers {transcript} (' + r.statusCode + ' ' + JSON.stringify(r.body) + ')');
  const row = rowsOf('U-FREE', 'transcribeurl');
  ok(row.length === 1 && row[0].credits === 0 && holdsOf('U-FREE').length === 0, '1b one transcribeurl row, 0 credits, no hold left (' + JSON.stringify(row) + ')');
  const s = await quiet(() => usage.getStatus('U-FREE'));
  ok(s.used === 0 && usage.creditsFor('transcribeurl') === 0, '1c the account has used 0 credits after a read (used ' + s.used + ')');
  ok(Math.abs(s.cost - usage.ACTION_COST.transcribeurl) < 1e-9 && usage.ACTION_COST.transcribeurl > 0, '1d its real cost (' + usage.ACTION_COST.transcribeurl + ') reaches the cost fuse (' + s.cost + ')');
}

// ── 2. free plan: 5 a UTC day ──
{
  // three reads from YESTERDAY (UTC) must not count
  const y = Date.parse(usage.utcDayStartISO(Date.now())) - 3600 * 1000;
  for (let i = 0; i < 3; i++) ev.push({ user_id: 'U-FREE', action: 'transcribeurl', credits: 0, created_at: iso(y - i * 60000) });
  let okCount = 1;
  for (let i = 0; i < 4; i++) { const r = await read('U-FREE'); if (r.statusCode === 200) okCount++; }
  ok(okCount === 5, '2a reads 2-5 of the day pass, yesterday\'s reads do not count (' + okCount + ' ok)');
  const t0 = NET.tikwm, g0 = NET.groq;
  const r = await read('U-FREE');
  ok(r.statusCode === 429 && r.body && r.body.code === 'daily_read_limit', '2b the 6th read -> 429 daily_read_limit (' + r.statusCode + ' ' + JSON.stringify(r.body) + ')');
  ok(PLAIN.test(r.body && r.body.error) && !RAW.test(r.body && r.body.error), '2c in plain words: ' + JSON.stringify(r.body && r.body.error));
  ok(NET.tikwm === t0 && NET.groq === g0 && rowsOf('U-FREE', 'transcribeurl').length === 8 && holdsOf('U-FREE').length === 0,
    '2d nothing was fetched, nothing logged, and the reservation was handed back');
  ok(Number(r.headers['Retry-After']) > 0 && Number(r.headers['Retry-After']) <= 86400, '2e Retry-After points at the next UTC midnight (' + r.headers['Retry-After'] + ')');
  // a trial counts as the free tier
  plans.set('U-TRIAL', { user_id: 'U-TRIAL', plan: 'trial', trial_ends_at: future });
  let n = 0; for (let i = 0; i < 6; i++) { const q = await read('U-TRIAL'); if (q.statusCode === 200) n++; }
  ok(n === 5, '2f a trial also gets 5 (' + n + ')');
}

// ── 3. paid plan: 20 a UTC day ──
{
  plans.set('U-PRO', { user_id: 'U-PRO', plan: 'pro', current_period_end: future });
  let n = 0; for (let i = 0; i < 20; i++) { const r = await read('U-PRO'); if (r.statusCode === 200) n++; }
  ok(n === 20, '3a a pro account reads 20 in a day (' + n + ')');
  const r = await read('U-PRO');
  ok(r.statusCode === 429 && r.body.code === 'daily_read_limit', '3b the 21st -> 429 daily_read_limit');
}

// ── 4. a failed read is not counted ──
{
  plans.set('U-FAIL', { user_id: 'U-FAIL', plan: 'free' });
  NET.groqFail = true;
  for (let i = 0; i < 3; i++) await read('U-FAIL');
  const f = await read('U-FAIL');
  NET.groqFail = false;
  ok(f.statusCode === 500 && rowsOf('U-FAIL', 'transcribeurl').length === 0 && holdsOf('U-FAIL').length === 0, '4a a read with no words -> 500, no row, no hold (' + f.statusCode + ')');
  let n = 0; for (let i = 0; i < 6; i++) { const r = await read('U-FAIL'); if (r.statusCode === 200) n++; }
  ok(n === 5, '4b after 4 failed reads the full 5 are still there (' + n + ')');
}

// ── 5. the paid Apify fallback: 3 a UTC day ──
{
  plans.set('U-APIFY', { user_id: 'U-APIFY', plan: 'pro', current_period_end: future });
  NET.tikwmFail = () => true;
  let n = 0;
  for (let i = 0; i < 3; i++) { const r = await read('U-APIFY'); if (r.statusCode === 200 && r.body.transcript) n++; }
  ok(n === 3 && NET.apifyRuns === 3, '5a tikwm fails -> the Apify fallback reads it, 3 times (' + n + ' ok, ' + NET.apifyRuns + ' runs)');
  const fb = rowsOf('U-APIFY', 'apifyfallback');
  ok(fb.length === 3 && fb.every(r => r.credits === 0), '5b each fallback is its own apifyfallback row at 0 credits (' + fb.length + ')');
  const s = await quiet(() => usage.getStatus('U-APIFY'));
  const want = 3 * usage.ACTION_COST.apifyfallback + 3 * usage.ACTION_COST.transcribeurl;
  ok(usage.ACTION_COST.apifyfallback > 0 && Math.abs(s.cost - want) < 1e-9, '5c the fallback cost reaches the fuse (' + s.cost + ' = ' + want + ')');
  const a0 = NET.apify;
  const r = await read('U-APIFY');
  ok(r.statusCode === 500 && r.body && r.body.code === 'fallback_limit', '5d the 4th fallback -> fallback_limit with the usual "couldn\'t read" status (' + r.statusCode + ' ' + JSON.stringify(r.body) + ')');
  ok(NET.apify === a0 && rowsOf('U-APIFY', 'apifyfallback').length === 3, '5e and Apify was NOT called, nothing more logged');
  ok(PLAIN.test(r.body.error) && !RAW.test(r.body.error), '5f in plain words: ' + JSON.stringify(r.body.error));
  ok(rowsOf('U-APIFY', 'transcribeurl').length === 3 && holdsOf('U-APIFY').length === 0, '5g the capped read is not counted as a read either');
  NET.tikwmFail = () => false;
}

// ── 6. the creator feed's tap-to-transcribe: same cap, same 429; its fallback shares the Apify cap ──
const BF = 'f0000000-0000-4000-8000-000000000001', BA = 'f0000000-0000-4000-8000-000000000002';
function seedBrand(b, vids) {
  db.comp[b] = [{ notes: JSON.stringify([{ id: 'c', name: 'Creators', entries: [{ id: 'e', name: 'Alpha', links: { tt: 'https://www.tiktok.com/@alpha' } }] }]), created_at: iso(Date.now()) }];
  db.state[b] = { brand_id: b, fetched_at: iso(Date.now() - HOUR), handles: ['alpha'], lock_until: null, run_id: null, run_started_at: null, failed_at: null, fail_count: 0, logged_run_id: null, last_error: null };
  db.videos[b] = {};
  for (const v of vids) db.videos[b][v.id] = Object.assign({}, VIDEO_DEFAULTS, { brand_id: b, video_id: v.id, handle: 'alpha', url: TT(v.id), views: 100, fetched_at: iso(Date.now() - HOUR), posted_at: iso(Date.now() - DAY) }, v.extra || {});
}
{
  plans.set('U-FEED', { user_id: 'U-FEED', plan: 'free' });
  seedBrand(BF, [{ id: '5000001' }, { id: '5000002' }, { id: '5000003', extra: { transcript: 'already here', transcript_status: 'ready' } },
    { id: '5000004', extra: { transcript: 'auto words', transcript_status: 'ready', auto: true } }]);
  for (let i = 0; i < 4; i++) await read('U-FEED');
  let r = await feed('U-FEED', { brandId: BF, action: 'transcript', videoId: '5000001' });
  const v = r.body && r.body.videos && r.body.videos.find(x => x.videoId === '5000001');
  ok(r.statusCode === 200 && v && v.transcript === 'these are the spoken words', '6a a feed tap (5th read of the day) transcribes (' + r.statusCode + ')');
  ok(rowsOf('U-FEED', 'transcribeurl').length === 5 && rowsOf('U-FEED', 'transcribeurl').every(x => x.credits === 0), '6b it is logged as a 0-credit transcribeurl read and counted (5)');
  r = await read('U-FEED');
  ok(r.statusCode === 429 && r.body.code === 'daily_read_limit', '6c after it, a link read is over the cap -> 429');
  const t0 = NET.tikwm;
  r = await feed('U-FEED', { brandId: BF, action: 'transcript', videoId: '5000002' });
  ok(r.statusCode === 429 && r.body && r.body.code === 'daily_read_limit' && NET.tikwm === t0, '6d a feed tap over the cap -> the same 429, nothing fetched (' + r.statusCode + ' ' + JSON.stringify(r.body) + ')');
  ok(db.videos[BF]['5000002'].transcript_status === 'none' && holdsOf('U-FEED').length === 0, '6e the video claim and the reservation are handed back');

  // the feed's Apify fallback shares the 3-a-day cap with /api/transcribe-url (U-APIFY used 3 already)
  seedBrand(BA, [{ id: '6000001' }]);
  NET.tikwmFail = () => true;
  const a0 = NET.apify;
  r = await feed('U-APIFY', { brandId: BA, action: 'transcript', videoId: '6000001' });
  NET.tikwmFail = () => false;
  ok(r.statusCode === 502 && r.body && r.body.code === 'fallback_limit' && NET.apify === a0, '6f a feed tap past the fallback cap -> 502 fallback_limit, Apify NOT called (' + r.statusCode + ' ' + JSON.stringify(r.body) + ')');
  ok(PLAIN.test(r.body.error) && !RAW.test(r.body.error) && db.videos[BA]['6000001'].transcript_status === 'none', '6g plain words, and the video can be tapped again tomorrow');
}

// ── 7. cached and automatic transcripts are free and not counted ──
{
  const before = rowsOf('U-FEED', 'transcribeurl').length, t0 = NET.tikwm;
  let r = await feed('U-FEED', { brandId: BF, action: 'transcript', videoId: '5000003' });
  const v = r.body && r.body.videos && r.body.videos.find(x => x.videoId === '5000003');
  ok(r.statusCode === 200 && v && v.transcript === 'already here' && NET.tikwm === t0, '7a a cached transcript is returned even at the cap, nothing fetched');
  r = await feed('U-FEED', { brandId: BF, action: 'transcript', videoId: '5000004' });
  ok(r.statusCode === 200 && rowsOf('U-FEED', 'transcribeurl').length === before, '7b a cached automatic transcript too; neither is counted');

  // a real pull: two weekly winners are transcribed automatically (one through tikwm, one where tikwm fails)
  const BW = 'f0000000-0000-4000-8000-000000000003';
  plans.set('U-AUTO', { user_id: 'U-AUTO', plan: 'free' });
  seedBrand(BW, []);
  db.state[BW].fetched_at = null;
  const now = Date.now();
  const item = (id, views) => ({ id, authorMeta: { name: 'alpha' }, playCount: views, createTimeISO: iso(now - DAY), text: 'v' + id });
  const items = [item('7000001', 5000), item('7000002', 4000), item('7000003', 100), item('7000004', 100), item('7000005', 100)];
  CF._deps.apify = async (method, p) => {
    if (method === 'POST') return { status: 201, data: { data: { id: 'run1', status: 'SUCCEEDED', defaultDatasetId: 'ds1' } } };
    if (p.startsWith('/v2/datasets/')) return { status: 200, data: items };
    return { status: 200, data: { data: { id: 'run1', status: 'SUCCEEDED', defaultDatasetId: 'ds1' } } };
  };
  NET.tikwmFail = (u) => u.includes('7000002');
  const a0 = NET.apify, g0 = NET.groq;
  r = await feed('U-AUTO', { brandId: BW, action: 'list' });
  NET.tikwmFail = () => false;
  const w1 = db.videos[BW]['7000001'], w2 = db.videos[BW]['7000002'];
  ok(r.statusCode === 200 && w1 && w1.transcript_status === 'ready' && w1.auto === true && NET.groq === g0 + 1, '7c the pull transcribes a weekly winner automatically (' + (w1 && w1.transcript_status) + ')');
  ok(rowsOf('U-AUTO', 'transcribeurl').length === 0 && holdsOf('U-AUTO').length === 0, '7d the automatic transcript is NOT counted as a read');
  ok(w2 && w2.transcript_status === 'failed' && NET.apify === a0 && rowsOf('U-AUTO', 'apifyfallback').length === 0, '7e a winner tikwm cannot read never falls back to Apify');
  const cap = await quiet(() => usage.dailyReadCheck('U-AUTO'));
  ok(cap.ok && cap.used === 0 && cap.limit === 5, '7f the owner still has all 5 reads (' + JSON.stringify(cap) + ')');
}

// ── 8. the remix twist keeps its charge ──
{
  ok(usage.creditsFor('remix') === 1 && usage.creditsFor('write') === 1 && usage.creditsFor('angles') === 0.5, '8a remix 1, write 1, angles 0.5 credits — unchanged');
  const src = fs.readFileSync(path.join(API, 'remix.js'), 'utf8');
  ok(/require\('\.\/_usage'\)\.guard\(req, 'remix', res\)/.test(src) && /logUsage\(/.test(src), '8b api/remix.js still gates and logs the remix action');
  plans.set('U-REMIX', { user_id: 'U-REMIX', plan: 'free' });
  currentUser = { id: 'U-REMIX' };
  const res = mkRes();
  const g = await quiet(() => usage.guard({ method: 'POST', headers: {}, body: {} }, 'remix', res));
  await quiet(() => usage.logUsage({ userId: g.billingUserId, action: 'remix' }));
  const s = await quiet(() => usage.getStatus('U-REMIX'));
  ok(g.user && !g.over && s.used === 1 && rowsOf('U-REMIX', 'remix')[0].credits === 1, '8c one twist still costs the free account 1 credit (used ' + s.used + ')');
  // a free account over its allowance (rounding can reach 41/40) can still READ (free) but not twist
  for (let i = 0; i < 40; i++) ev.push({ user_id: 'U-REMIX', action: 'remix', credits: 1, created_at: iso(Date.now() - 2 * HOUR) });
  const g2 = await quiet(() => usage.guard({ method: 'POST', headers: {}, body: {} }, 'remix', mkRes()));
  const rd = await read('U-REMIX');
  ok(g2.over && g2.gate.reason === 'limit' && rd.statusCode === 200, '8d over the allowance (41/40) the twist is refused (402 path) while the read is still free');
}

// ── 9. api/transcribe.js: the YouTube link read is free and capped; an uploaded file keeps its charge ──
{
  const YT = 'https://www.youtube.com/watch?v=abcdefghijk';
  const yt = async (uid) => { currentUser = { id: uid }; const res = mkRes(); await quiet(() => TR({ method: 'POST', headers: {}, body: { url: YT, mode: 'youtube' } }, res)); return res; };
  plans.set('U-YT', { user_id: 'U-YT', plan: 'free' });
  NET.ytCaptions = false;
  const bad = await yt('U-YT');
  NET.ytCaptions = true;
  ok(bad.statusCode === 400 && rowsOf('U-YT', 'transcribeurl').length === 0 && rowsOf('U-YT', 'transcribe').length === 0 && holdsOf('U-YT').length === 0,
    '9a a YouTube read with no captions -> 400, not charged, not counted (' + bad.statusCode + ')');
  let r = await yt('U-YT');
  ok(r.statusCode === 200 && r.body && r.body.text === 'hello from youtube', '9b a YouTube link read answers {text} (' + r.statusCode + ' ' + JSON.stringify(r.body) + ')');
  const row = rowsOf('U-YT', 'transcribeurl');
  const s = await quiet(() => usage.getStatus('U-YT'));
  ok(row.length === 1 && row[0].credits === 0 && rowsOf('U-YT', 'transcribe').length === 0 && s.used === 0 && s.cost > 0,
    '9c it is a 0-credit transcribeurl row with its cost logged (used ' + s.used + ', cost ' + s.cost + ')');
  await read('U-YT'); await read('U-YT');                     // 2 TikTok reads share the same cap
  await yt('U-YT'); await yt('U-YT');
  ok(rowsOf('U-YT', 'transcribeurl').length === 5, '9d TikTok and YouTube reads count toward ONE cap (5)');
  const y0 = NET.yt;
  r = await yt('U-YT');
  ok(r.statusCode === 429 && r.body && r.body.code === 'daily_read_limit' && NET.yt === y0 && holdsOf('U-YT').length === 0,
    '9e the 6th read (YouTube) -> 429 daily_read_limit, nothing fetched (' + r.statusCode + ' ' + JSON.stringify(r.body) + ')');
  // an uploaded audio file is NOT a link read: still 'transcribe', still 2 credits, never blocked by the read cap
  currentUser = { id: 'U-YT' };
  const up = mkRes();
  await quiet(() => TR({ method: 'POST', headers: {}, body: { audio: Buffer.from('AUDIO').toString('base64'), filename: 'clip.mp4', mimeType: 'video/mp4' } }, up));
  const s2 = await quiet(() => usage.getStatus('U-YT'));
  const tr = rowsOf('U-YT', 'transcribe');
  ok(up.statusCode === 200 && up.body && up.body.transcript === 'these are the spoken words' && tr.length === 1 && tr[0].credits === 2 && s2.used === 2,
    '9f an uploaded file (at the read cap) still transcribes and still costs 2 credits (' + up.statusCode + ', used ' + s2.used + ')');
}

// ── 10. parallel reads cannot get past the caps ──
{
  plans.set('U-BURST', { user_id: 'U-BURST', plan: 'free' });
  const rs = await Promise.all(Array.from({ length: 10 }, () => read('U-BURST')));
  const okN = rs.filter(r => r.statusCode === 200).length, capped = rs.filter(r => r.statusCode === 429 && r.body.code === 'daily_read_limit').length;
  ok(okN === 5 && capped === 5, '10a 10 parallel reads on a free plan: exactly 5 succeed, 5 get 429 (' + okN + ' ok, ' + capped + ' capped)');
  ok(rowsOf('U-BURST', 'transcribeurl').length === 5 && holdsOf('U-BURST').length === 0, '10b 5 rows logged, every reservation settled or handed back');
  plans.set('U-PAPIFY', { user_id: 'U-PAPIFY', plan: 'pro', current_period_end: future });
  NET.tikwmFail = () => true;
  const r0 = NET.apifyRuns;
  const ps = await Promise.all(Array.from({ length: 6 }, () => read('U-PAPIFY')));
  NET.tikwmFail = () => false;
  const lim = ps.filter(r => r.statusCode === 500 && r.body && r.body.code === 'fallback_limit').length;
  ok(NET.apifyRuns - r0 === 3 && lim === 3, '10c 6 parallel Apify fallbacks: exactly 3 runs, 3 fallback_limit (' + (NET.apifyRuns - r0) + ' runs, ' + lim + ' capped)');
  ok(rowsOf('U-PAPIFY', 'apifyfallback').length === 3 && holdsOf('U-PAPIFY').length === 0, '10d 3 apifyfallback rows; the refused markers are gone');
}

// ── 11. one read pool per brand ──
{
  const BO = 'f0000000-0000-4000-8000-0000000000aa';
  BRAND_OWNER[BO] = 'U-OWN';
  plans.set('U-OWN', { user_id: 'U-OWN', plan: 'free' });
  plans.set('U-MEM', { user_id: 'U-MEM', plan: 'free' });
  plans.set('U-OUT', { user_id: 'U-OUT', plan: 'free' });
  NO_ACCESS.add('U-OUT');
  for (let i = 0; i < 3; i++) await read('U-OWN');
  const m1 = await read('U-MEM', null, BO), m2 = await read('U-MEM', null, BO);
  ok(m1.statusCode === 200 && m2.statusCode === 200 && rowsOf('U-OWN', 'transcribeurl').length === 5 && rowsOf('U-MEM', 'transcribeurl').length === 0,
    '11a a member\'s reads with the brand id are logged on the brand owner\'s pool (owner rows ' + rowsOf('U-OWN', 'transcribeurl').length + ')');
  const m3 = await read('U-MEM', null, BO);
  ok(m3.statusCode === 429 && m3.body.code === 'daily_read_limit', '11b the shared pool is full: the member\'s next brand read -> 429');
  const own = await read('U-MEM');
  ok(own.statusCode === 200 && rowsOf('U-MEM', 'transcribeurl').length === 1, '11c without a brand id the member reads on their own pool');
  const out = await read('U-OUT', null, BO);
  ok(out.statusCode === 200 && rowsOf('U-OUT', 'transcribeurl').length === 1 && rowsOf('U-OWN', 'transcribeurl').length === 5,
    '11d a non-member\'s brand id is NOT trusted: counted on their own pool');
  seedBrand(BO, [{ id: '8000001' }]);
  BRAND_OWNER[BO] = 'U-OWN';
  const t = await feed('U-MEM', { brandId: BO, action: 'transcript', videoId: '8000001' });
  ok(t.statusCode === 429 && t.body && t.body.code === 'daily_read_limit', '11e the member\'s feed tap on that brand shares the same full pool -> 429');
}

// ── 12. health: creator_feed_state is server-only by design ──
{
  const h = fs.readFileSync(path.join(API, 'health.js'), 'utf8');
  const m = /const ZERO_POLICY_ALLOWED = \[([^\]]*)\]/.exec(h);
  const list = m ? m[1].split(',').map(x => x.trim().replace(/^'|'$/g, '')) : [];
  const sql = fs.readFileSync(path.join(ROOT, 'sql', 'creator-feed.sql'), 'utf8');
  ok(list.includes('creator_feed_state') && /alter table public\.creator_feed_state enable row level security/.test(sql) && !/create policy[^;]*on public\.creator_feed_state/i.test(sql),
    '12a ZERO_POLICY_ALLOWED lists creator_feed_state, which really is RLS-on with no policy (' + list.join(',') + ')');
}

clearTimeout(WALL);
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAIL: free-read-v712'); process.exit(1); }
console.log('PASS — free-read-v712: reads cost 0 credits, are capped per UTC day (5 free / 20 paid), the Apify fallback is capped at 3 and logged, the feed tap shares the cap, cached/auto transcripts are free, remix keeps its charge, YouTube link reads share the cap and uploads keep their charge');
process.exit(0);
