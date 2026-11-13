#!/usr/bin/env node
// GATE v711 — the creator feed (api/creator-feed.js, contract .unlazy/creator-feed/CONTRACT.md).
//
// WHAT IT PROVES, by running the REAL handler against a fake database (PostgREST filter rules for the
// queries this file makes), a stubbed Apify, a stubbed transcriber and a stubbed usage meter. No network,
// no Apify, no AI and no Groq calls:
//   - signed out / not your brand / bad input are refused, and nothing is pulled;
//   - no followed creators -> no_creators; no TikTok creator -> not_tiktok; nothing is pulled;
//   - creators come from the bookmarks blob: TikTok only, handle from profile OR video links, deduped, max 5;
//   - 'list' with a fresh cache never calls Apify; a cache older than 24 h makes exactly ONE run;
//   - 'refresh' inside 6 h never calls Apify; after 6 h it makes one run;
//   - a brand already being pulled (live lock) is not pulled again; a stale lock is taken over;
//   - score = views / that creator's median in the pull, 1 decimal; missing fields are null;
//   - a cached transcript is free; a new one is charged ONCE and only when words came back;
//   - free weekly winners: <= 2 per pull, <= 3 tries per brand per ISO week, never charged, skipped when
//     the request is short of time, never older than 14 days;
//   - a failed pull answers in plain words (never provider text), waits 30 min, keeps the cache;
//   - a run we stopped waiting for is picked up later, not bought twice;
//   - the cost fuse stops a non-paying owner's pulls;
//   - api/transcribe-url.js still answers {transcript} and charges once, and exports transcribeVideo.
// RUN: node scripts/verify/creator-feed-v711.mjs   EXPECT: "PASS" and exit 0.
import { createRequire } from 'node:module';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
const require_ = createRequire(import.meta.url);
const Module = require_('module');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = path.join(ROOT, 'api');
const WALL = setTimeout(() => { console.log('FAIL: creator-feed-v711 wall clock (60s) — something hung'); process.exit(1); }, 60000);
let failed = 0, passed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('ok: ' + m); } else { failed++; console.log('FAIL: ' + m); } };
// Re-entrant: two concurrent handler calls must not leave the console silenced.
const REAL = { error: console.error, warn: console.warn, log: console.log };
let quietDepth = 0;
const quiet = async (fn) => { if (quietDepth++ === 0) console.error = console.warn = console.log = () => {}; try { return await fn(); } finally { if (--quietDepth === 0) Object.assign(console, REAL); } };

process.env.SUPABASE_URL = 'https://stub.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
process.env.APIFY_API_TOKEN = 'stub-apify';
process.env.GROQ_API_KEY = 'stub-groq';
function stub(rel, exports) {
  const file = require_.resolve(path.join(API, rel));
  const m = new Module(file); m.filename = file; m.loaded = true; m.exports = exports; require_.cache[file] = m;
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const HOUR = 3600 * 1000, DAY = 24 * HOUR, MIN = 60000;
const iso = (t) => new Date(t).toISOString();

// ── the fake database ──
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
let accessAllowed = true, accessThrows = false;
stub('_publish/store.js', {
  rest, setRequestBudget() {}, heartbeat: async () => {},
  userCanAccessBrand: async () => { if (accessThrows) { const e = new Error('brand access check could not be completed'); e.accessCheckFailed = true; throw e; } return accessAllowed; },
});
let currentUser = { id: 'user-1' };
stub('_requireUser.js', async () => currentUser);

// ── the fake usage meter ──
const U = { checks: [], logs: [], holdsAttached: 0, gateOk: true, status: { plan: 'pro', cost: 0 } };
stub('_usage.js', {
  COST_CAP_EUR: 25, ACTION_COST: { creatorfeed: 0.15, transcribeurl: 0.06 },
  // v712: a link read is 0 credits (bounded by the daily read cap; scripts/verify/free-read-v712.mjs owns that).
  creditsFor: (a) => (a === 'transcribeurl' ? 0 : a === 'creatorfeed' ? 0 : 1),
  dailyReadCheck: async () => ({ ok: true, used: 0, limit: 20, plan: 'pro' }),
  dailyReadDeny: (res, c) => res.status(429).json({ error: 'You have read your videos for today.', code: 'daily_read_limit' }),
  useApifyFallback: async () => ({ ok: true }),
  claimedBrandId: () => null,
  billingUserFor: async (uid) => 'owner-1',
  checkLimit: async (uid, credits, action) => { U.checks.push({ uid, credits, action }); return U.gateOk ? { ok: true, hold: { token: 'h' + U.checks.length } } : { ok: false, reason: 'limit', plan: 'free', used: 40, limit: 40 }; },
  attachHoldRelease: () => { U.holdsAttached++; },
  denyResponse: (res, g) => res.status(402).json({ error: 'limit_reached', reason: g.reason }),
  logUsage: async (evt) => { U.logs.push(clone(evt)); },
  getStatus: async () => U.status,
  guard: async () => ({ user: { id: 'tu-user' }, over: false, billingUserId: 'tu-user' }),
});

const CF = require_(path.join(API, 'creator-feed.js'));
let clock = Date.UTC(2026, 10, 4, 10, 0, 0);      // Wednesday; its ISO week starts Monday 2 Nov
CF._deps.now = () => clock;

// ── the fake Apify ──
const A = { calls: [], items: () => [], onStart: null, onPoll: null, onDataset: null };
let runN = 0;
CF._deps.apify = async (method, p, body) => {
  A.calls.push({ method, p, body: body ? clone(body) : null });
  if (method === 'POST' && /\/runs\?/.test(p)) {
    if (A.onStart) return A.onStart(p, body);
    runN++; return { status: 201, data: { data: { id: 'run' + runN, status: 'SUCCEEDED', defaultDatasetId: 'ds' + runN } } };
  }
  if (method === 'GET' && p.startsWith('/v2/actor-runs/')) return A.onPoll ? A.onPoll(p) : { status: 200, data: { data: { id: 'x', status: 'SUCCEEDED', defaultDatasetId: 'dsX' } } };
  if (method === 'GET' && p.startsWith('/v2/datasets/')) return A.onDataset ? A.onDataset(p) : { status: 200, data: A.items() };
  return { status: 404, data: null };
};
const runs = () => A.calls.filter(c => c.method === 'POST').length;
const anyApify = () => A.calls.length;

// ── the fake transcriber ──
const T = { calls: [], answer: async () => 'these are the spoken words' };
CF._deps.transcribe = async (url, opts) => { T.calls.push({ url, opts: clone(opts || {}) }); return T.answer(url, opts); };

const errors = [];   // every error body, checked for provider text at the end
function mkRes() {
  const r = { statusCode: 200, body: undefined, headers: {} };
  r.status = (c) => { r.statusCode = c; return r; };
  // 402 limit_reached is _usage.denyResponse's app-wide shape (the app's upgrade modal reads it), not this file's.
  r.json = (b) => { r.body = b; if (r.statusCode >= 400 && !(b && b.error === 'limit_reached')) errors.push(b); return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = () => r;
  return r;
}
async function call(body, method) {
  const res = mkRes();
  await quiet(() => CF({ method: method || 'POST', headers: { origin: 'https://contentshrimp.com', authorization: 'Bearer x' }, body }, res));
  return res;
}

// ── fixtures ──
const B1 = '11111111-1111-4111-8111-111111111111', B2 = '22222222-2222-4222-8222-222222222222',
  B3 = '33333333-3333-4333-8333-333333333333', B4 = '44444444-4444-4444-8444-444444444444',
  B5 = '55555555-5555-4555-8555-555555555555', B6 = '66666666-6666-4666-8666-666666666666',
  B7 = '77777777-7777-4777-8777-777777777777';
const ent = (name, links, note) => ({ id: 'e_' + name, name, links, note });
const bookmarks = (entries) => [{ notes: JSON.stringify([{ id: 'c1', name: 'Creators', entries }]), created_at: iso(clock) }];
const FOLLOWS = [
  ent('Alpha', { tt: 'tiktok.com/@Alpha' }, 'great   hooks'),
  ent('Beta', { tt: 'https://www.tiktok.com/@beta/video/123456789' }),
  ent('Alpha again', { web: 'https://tiktok.com/@alpha' }),
  ent('Insta only', { ig: 'https://instagram.com/someone' }),
  ent('Gamma', { tt: 'http://tiktok.com/@gamma' }),
  ent('Delta', { tt: 'https://www.tiktok.com/@delta' }),
  ent('Epsilon', { tt: 'https://www.tiktok.com/@epsilon' }),
  ent('Zeta', { tt: 'https://www.tiktok.com/@zeta' }),
  ent('Short link', { tt: 'https://vm.tiktok.com/ZMabc/' }),
  ent('tt decides', { tt: 'https://vm.tiktok.com/ZZq/', web: 'https://www.tiktok.com/@shouldnotwin' }),
];
for (const b of [B1, B4, B5, B6, B7]) db.comp[b] = bookmarks(FOLLOWS);
db.comp[B2] = [];
const B8 = '88888888-8888-4888-8888-888888888888', B9 = '99999999-9999-4999-8999-999999999999',
  B10 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B11 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
for (const b of [B9, B10, B11]) db.comp[b] = bookmarks(FOLLOWS);
db.comp[B8] = bookmarks([ent('Alpha', { tt: 'https://www.tiktok.com/@alpha' }), ent('Beta', { yt: 'https://youtube.com/@beta', web: 'https://tiktok.com/@beta' })]);
db.comp[B3] = bookmarks([ent('Insta only', { ig: 'https://instagram.com/someone' })]);

const item = (h, id, views, daysAgo, extra) => Object.assign({
  id: String(id), authorMeta: { name: h }, playCount: views, diggCount: 7, commentCount: 3, shareCount: 2,
  createTimeISO: iso(clock - daysAgo * DAY), videoMeta: { duration: 31, coverUrl: 'https://p16.tiktokcdn.com/c' + id + '.jpg' },
  webVideoUrl: 'https://www.tiktok.com/@' + h + '/video/' + id, text: 'caption ' + id,
}, extra || {});
// Pull 1: alpha 100/200/300/1000 (median 250); beta 50/50/500 + one with no numbers (median 50);
// gamma 10/100/10 (median 10) with the 100 posted 20 days ago (too old for a free transcript);
// an item for a creator nobody follows (dropped); a duplicate id (dropped).
const PULL1 = () => [
  item('alpha', 1000001, 100, 1), item('alpha', 1000002, 200, 2), item('alpha', 1000003, 300, 3), item('alpha', 1000004, 1000, 4),
  item('beta', 2000001, 50, 1), item('beta', 2000002, 50, 2), item('beta', 2000003, 500, 2),
  { id: '2000004', authorMeta: { name: 'beta' } },
  item('gamma', 3000001, 10, 1), item('gamma', 3000002, 100, 20), item('gamma', 3000003, 10, 3),
  item('stranger', 4000001, 99999, 1),
  item('alpha', 1000001, 100, 1),
];
A.items = PULL1;

const vid = (r, id) => (r.body && r.body.videos || []).find(v => v.videoId === String(id));
const PLAIN = /^[A-Z][^{}<>]*[.!]$/;
const RAW = /HTTP|apify|groq|whisper|payment|sk-|stack|undefined|null|\[object|ECONN|status/i;

// ── 1. refusals ──
{
  currentUser = null;
  let r = await call({ brandId: B1, action: 'list' });
  ok(r.statusCode === 401 && r.body.code === 'signed_out', '1a signed out -> 401 signed_out (' + r.statusCode + ')');
  currentUser = { id: 'user-1' };
  accessAllowed = false;
  r = await call({ brandId: B1, action: 'list' });
  ok(r.statusCode === 403 && r.body.code === 'forbidden', '1b not your brand -> 403 forbidden (' + r.statusCode + ' ' + (r.body && r.body.code) + ')');
  accessAllowed = true; accessThrows = true;
  r = await call({ brandId: B1, action: 'refresh' });
  ok(r.statusCode === 503 && r.body.code === 'unavailable', '1c access check that could not run -> 503, not a pass');
  accessThrows = false;
  r = await call({ brandId: 'not-a-uuid', action: 'list' });
  ok(r.statusCode === 400 && r.body.code === 'bad_request', '1d a malformed brand id -> 400');
  r = await call({ brandId: B1, action: 'nuke' });
  ok(r.statusCode === 400, '1e an unknown action -> 400');
  r = await call({ brandId: B1, action: 'list' }, 'GET');
  ok(r.statusCode === 405, '1f GET -> 405');
  ok(anyApify() === 0 && T.calls.length === 0, '1g no refusal reached Apify or the transcriber');
}

// ── 2. who is followed ──
{
  let r = await call({ brandId: B2, action: 'list' });
  ok(r.statusCode === 422 && r.body.code === 'no_creators', '2a no bookmarks -> no_creators (' + r.statusCode + ' ' + (r.body && r.body.code) + ')');
  r = await call({ brandId: B3, action: 'refresh' });
  ok(r.statusCode === 422 && r.body.code === 'not_tiktok', '2b only an Instagram creator -> not_tiktok');
  db.missing = true;
  r = await call({ brandId: B1, action: 'list' });
  ok(r.statusCode === 503 && r.body.code === 'not_set_up', '2c before sql/creator-feed.sql -> 503 not_set_up, no crash');
  db.missing = false;
  ok(anyApify() === 0, '2d none of these called Apify');
  const f = CF.followedCreators(JSON.parse(db.comp[B1][0].notes));
  ok(JSON.stringify(f.handles) === JSON.stringify(['alpha', 'beta', 'gamma', 'delta', 'epsilon']),
    '2e TikTok only, handle from profile AND video links, lowercased, deduped, max 5: ' + JSON.stringify(f.handles));
  const broken = f.creators.find(c => !c.handle);
  ok(broken && broken.error && /tiktok\.com\/@name/.test(broken.error), '2f a share link with no name is listed with a plain fix-it note');
  ok(f.creators[0].note === 'great hooks', '2g the "why I follow them" note rides along, cleaned');
  ok(f.more === true && !f.handles.includes('zeta') && !f.handles.includes('shouldnotwin') && f.creators.filter(c => !c.handle).length === 2,
    '2h one rule: links.tt decides when it is a TikTok link (a nameless tt is NOT replaced by another field); 6th creator dropped, more=true');
  const f8 = CF.followedCreators(JSON.parse(db.comp[B8][0].notes));
  ok(JSON.stringify(f8.handles) === '["alpha","beta"]' && f8.more === false, '2i no tt: the first tiktok.com link in any other field counts');
}

// ── 3. first list: no cache -> ONE run ──
let r1;
{
  r1 = await call({ brandId: B1, action: 'list', tzOffsetMin: -120 });
  ok(r1.statusCode === 200 && r1.body.ok === true, '3a list with no cache -> 200 (' + r1.statusCode + ' ' + JSON.stringify(r1.body).slice(0, 160) + ')');
  ok(runs() === 1, '3b exactly one Apify run (' + runs() + ')');
  const start = A.calls.find(c => c.method === 'POST');
  const inp = start && start.body;
  ok(start && /\/v2\/acts\/clockworks~tiktok-profile-scraper\/runs\?/.test(start.p), '3c the profile-scraper actor is the one run');
  ok(inp && JSON.stringify(inp.profiles) === JSON.stringify(['alpha', 'beta', 'gamma', 'delta', 'epsilon']) && inp.resultsPerPage === 10 &&
    inp.shouldDownloadVideos === false && inp.shouldDownloadCovers === false && inp.commentsPerPost === 0 &&
    inp.downloadSubtitlesOptions === 'NEVER_DOWNLOAD_SUBTITLES' && !('oldestPostDateUnified' in inp) && !('mostDiggs' in inp),
    '3d input: 5 profiles, 10 each, no downloads / comments / subtitles / paid filters');
  ok(/maxTotalChargeUsd=0\.2/.test(start.p), '3e the run carries a hard charge cap');
  const v = (id) => vid(r1, id);
  ok(v(1000004) && v(1000004).score === 4 && v(1000001).score === 0.4 && v(1000003).score === 1.2,
    '3f score = views / creator median (alpha median 250): 1000->4, 100->0.4, 300->1.2 (' + [1000004, 1000001, 1000003].map(i => v(i) && v(i).score) + ')');
  ok(v(2000003) && v(2000003).score === 10 && v(2000001).score === 1, '3g a second creator has its OWN median (beta 50): 500->10, 50->1');
  const empty = v(2000004);
  ok(empty && empty.views === null && empty.likes === null && empty.durationSec === null && empty.cover === null && empty.postedAt === null && empty.score === 0,
    '3h missing fields are null (score 0), never invented: ' + JSON.stringify(empty));
  ok(!vid(r1, 4000001), '3i a video from a creator nobody follows is dropped');
  ok(r1.body.videos.length === 11 && new Set(r1.body.videos.map(x => x.videoId)).size === 11, '3j duplicates dropped (' + r1.body.videos.length + ' videos)');
  const s = r1.body.videos.map(x => x.score);
  ok(s.every((x, i) => i === 0 || s[i - 1] >= x), '3k sorted by score, highest first');
  ok(v(1000001).url === 'https://www.tiktok.com/@alpha/video/1000001' && v(1000001).views === 100 && v(1000001).likes === 7 && v(1000001).comments === 3 && v(1000001).shares === 2 && v(1000001).durationSec === 31 && /^https:\/\/p16/.test(v(1000001).cover) && v(1000001).caption === 'caption 1000001',
    '3l fields mapped: url, views, likes, comments, shares, duration, cover, caption');
  const logs = U.logs.filter(l => l.action === 'creatorfeed');
  ok(logs.length === 1 && logs[0].userId === 'owner-1' && logs[0].brandId === B1, '3m the pull is logged ONCE as creatorfeed, on the brand owner');
  ok(U.checks.length === 0, '3n the pull reserved no credits (platform cost)');
  const cr = r1.body.creators;
  ok(cr.length === 7 && cr.filter(c => !c.handle).length === 2 && cr.find(c => c.handle === 'delta').error && !cr.find(c => c.handle === 'alpha').error, '3o creators: 5 + the 2 nameless links; one with no videos says so (' + cr.map(c => c.handle + ':' + !!c.error).join(',') + ')');
  ok(r1.body.fetchedAt === iso(clock) && r1.body.nextRefreshAt === iso(clock + 6 * HOUR), '3p fetchedAt = now, nextRefreshAt = now + 6 h');
  ok(db.state[B1].lock_until == null && db.state[B1].fetched_at, '3q the lock is released and the pull is marked');
  // free weekly winners
  const autos = r1.body.videos.filter(x => x.auto);
  ok(T.calls.length === 2 && autos.length === 2, '3r 2 free transcripts after the pull (calls ' + T.calls.length + ', auto ' + autos.length + ')');
  ok(autos.every(x => x.score >= 2 && x.transcriptStatus === 'ready' && x.transcript), '3s winners have score >= 2 and a transcript');
  ok(!autos.find(x => x.videoId === '3000002') && !T.calls.find(c => /3000002/.test(c.url)), '3t a 20-day-old winner is never auto-transcribed');
  ok(T.calls.every(c => c.opts.apifyFallback === false && c.opts.deadline > clock), '3u free transcripts skip the paid Apify fallback and carry a deadline');
  ok(U.checks.length === 0 && !U.logs.some(l => l.action === 'transcribeurl'), '3v free transcripts are not charged');
}

// ── 4. cache rules ──
{
  const t0 = clock;
  clock = t0 + HOUR;
  let r = await call({ brandId: B1, action: 'list' });
  ok(r.statusCode === 200 && runs() === 1 && r.body.videos.length === 11, '4a list with a fresh cache: no Apify call, cached videos back');
  ok(r.body.note === 'Updated 1 hour ago. Showing your first 5 creators.', '4b note says how old it is, and that only the first 5 show (' + r.body.note + ')');
  r = await call({ brandId: B1, action: 'refresh', tzOffsetMin: -120 });
  ok(r.statusCode === 200 && runs() === 1, '4c refresh inside 6 h: no Apify call');
  ok(/^Fresh already \u2014 next refresh after 18:00\. Showing your first 5 creators\.$/.test(r.body.note || ''), '4d note "Fresh already — next refresh after HH:MM" in the viewer\'s time (' + r.body.note + ')');
  clock = t0 + 7 * HOUR;
  r = await call({ brandId: B1, action: 'list' });
  ok(runs() === 1, '4e list after 7 h still uses the cache (24 h rule)');
  A.items = () => PULL1().concat([item('alpha', 1000005, 5000, 0.5), item('beta', 2000005, 1000, 0.5)]);
  const tBefore = T.calls.length;
  r = await call({ brandId: B1, action: 'refresh' });
  ok(r.statusCode === 200 && runs() === 2, '4f refresh after 6 h: one run (' + runs() + ')');
  ok(vid(r, 1000005) && vid(r, 1000005).score === 16.7, '4g the new pull rescored against the new median (5000/300 = 16.7: ' + (vid(r, 1000005) && vid(r, 1000005).score) + ')');
  ok(vid(r, 1000004) && vid(r, 1000004).auto === true && vid(r, 1000004).transcript && vid(r, 2000003) && vid(r, 2000003).auto === true, '4h the earlier free transcripts survive the re-pull (the upsert keeps them)');
  ok(T.calls.length - tBefore === 1, '4i weekly cap: 2 tried already, so only 1 more this week (' + (T.calls.length - tBefore) + ')');
  r = await call({ brandId: B1, action: 'refresh' });
  ok(runs() === 2, '4j a second refresh right after: no call');
  clock = clock + 25 * HOUR;                       // Thursday — same ISO week
  const tB = T.calls.length;
  r = await call({ brandId: B1, action: 'list' });
  ok(runs() === 3, '4k list with a cache older than 24 h: one run');
  ok(T.calls.length === tB, '4l the 3-per-week cap holds: no 4th free transcript (' + (T.calls.length - tB) + ')');
  ok(Object.values(db.videos[B1]).filter(x => x.auto_tried_at).length === 3, '4m exactly 3 free tries recorded this week');
}

// ── 5. the lock ──
{
  clock += 25 * HOUR;
  db.state[B1].lock_until = iso(clock + MIN);
  let r = await call({ brandId: B1, action: 'list' });
  ok(r.statusCode === 200 && runs() === 3 && /check back in a minute/.test(r.body.note || '') && r.body.videos.length > 0,
    '5a a brand mid-pull is not pulled twice: cache + "check back" (' + runs() + ', ' + r.body.note + ')');
  db.state[B1].lock_until = iso(clock - 1000);
  r = await call({ brandId: B1, action: 'list' });
  ok(runs() === 4 && db.state[B1].lock_until == null, '5b a stale lock (killed function) is taken over and released');
}

// ── 6. transcripts ──
{
  const ready = Object.values(db.videos[B1]).find(x => x.transcript_status === 'ready');
  const c0 = U.checks.length, t0 = T.calls.length, l0 = U.logs.length;
  let r = await call({ brandId: B1, action: 'transcript', videoId: ready.video_id });
  ok(r.statusCode === 200 && vid(r, ready.video_id).transcript === ready.transcript && T.calls.length === t0 && U.checks.length === c0 && U.logs.length === l0,
    '6a a cached transcript is free: no transcriber, no reservation, no usage row');
  T.answer = async () => '  hello from the video  ';
  r = await call({ brandId: B1, action: 'transcript', videoId: '1000001' });
  const v = vid(r, 1000001);
  ok(r.statusCode === 200 && v && v.transcript === 'hello from the video' && v.transcriptStatus === 'ready' && v.auto === false, '6b a new transcript comes back in the payload (' + JSON.stringify(v && v.transcript) + ')');
  ok(U.checks.length === c0 + 1 && U.checks[c0].action === 'transcribeurl' && U.checks[c0].credits === 0 && U.checks[c0].uid === 'owner-1' && U.holdsAttached >= 1,
    '6c it reserves the transcribeurl read (v712: 0 credits) on the brand owner, with the refund attached');
  ok(U.logs.filter(l => l.action === 'transcribeurl').length === 1, '6d charged exactly once');
  ok(T.calls[T.calls.length - 1].url === 'https://www.tiktok.com/@alpha/video/1000001', '6e the transcriber gets the canonical TikTok link');
  r = await call({ brandId: B1, action: 'transcript', videoId: '1000001' });
  ok(U.checks.length === c0 + 1 && U.logs.filter(l => l.action === 'transcribeurl').length === 1, '6f asking again is free');
  T.answer = async () => { throw new Error('Groq said: invalid_api_key sk-live-123 (HTTP 401)'); };
  r = await call({ brandId: B1, action: 'transcript', videoId: '1000002' });
  ok(r.statusCode === 502 && r.body.code === 'transcribe_failed', '6g a failed transcript -> 502 transcribe_failed');
  ok(U.logs.filter(l => l.action === 'transcribeurl').length === 1, '6h a failed transcript is NOT charged');
  ok(db.videos[B1]['1000002'].transcript_status === 'failed', '6i and is marked failed');
  T.answer = async () => '   ';
  r = await call({ brandId: B1, action: 'transcript', videoId: '1000003' });
  ok(r.statusCode === 502 && U.logs.filter(l => l.action === 'transcribeurl').length === 1, '6j an empty transcript counts as a failure, not charged');
  U.gateOk = false;
  const tc = T.calls.length;
  r = await call({ brandId: B1, action: 'transcript', videoId: '2000001' });
  ok(r.statusCode === 402 && T.calls.length === tc, '6k over the plan limit -> 402, nothing transcribed');
  ok(db.videos[B1]['2000001'].transcript_status === 'none', '6k2 and the claim is given back (status none again)');
  U.gateOk = true;
  r = await call({ brandId: B1, action: 'transcript', videoId: '999999999' });
  ok(r.statusCode === 404 && r.body.code === 'not_found', '6l an unknown video -> 404');
  r = await call({ brandId: B1, action: 'transcript', videoId: 'abc' });
  ok(r.statusCode === 400, '6m a malformed video id -> 400');
  T.answer = async () => 'these are the spoken words';
}

// ── 7. a failed pull ──
{
  const before = runs();
  A.onStart = () => ({ status: 402, data: { error: { type: 'not-enough-usage', message: 'Payment required: monthly usage hard limit exceeded' } } });
  let r = await call({ brandId: B4, action: 'list' });
  ok(r.statusCode === 502 && r.body.code === 'apify_failed' && runs() === before + 1, '7a no cache + Apify refusal -> 502 apify_failed');
  ok(db.state[B4].failed_at && db.state[B4].lock_until == null && !db.state[B4].fetched_at, '7b failure recorded, lock released, nothing marked as pulled');
  ok(!U.logs.some(l => l.action === 'creatorfeed' && l.brandId === B4), '7c a failed pull logs no usage');
  r = await call({ brandId: B4, action: 'refresh' });
  ok(runs() === before + 1 && r.statusCode === 502 && /Try again after/.test(r.body.error), '7d within 30 min of a failure: no new run');
  clock += 31 * MIN;
  A.onStart = null;
  r = await call({ brandId: B4, action: 'list' });
  ok(r.statusCode === 200 && runs() === before + 2 && !db.state[B4].failed_at, '7e after 30 min it tries again and succeeds');
  clock += 25 * HOUR;
  A.onStart = () => ({ status: 500, data: { error: { message: 'internal actor crash at line 42' } } });
  r = await call({ brandId: B1, action: 'list' });
  ok(r.statusCode === 200 && r.body.videos.length > 0 && /Couldn't reach TikTok/.test(r.body.note || ''), '7f with a cache, a failed pull keeps showing the cache with a plain note');
  A.onStart = null;
}

// ── 8. a run we stopped waiting for is picked up, not bought again ──
{
  const before = runs();
  let polls = 0;
  A.onStart = () => ({ status: 201, data: { data: { id: 'slow-run', status: 'RUNNING', defaultDatasetId: 'ds-slow' } } });
  A.onPoll = (p) => { polls++; clock += 61 * 1000; return { status: 200, data: { data: { id: 'slow-run', status: 'RUNNING', defaultDatasetId: 'ds-slow' } } }; };
  let r = await call({ brandId: B5, action: 'list' });
  ok(r.statusCode === 200 && /Still loading/.test(r.body.note || '') && db.state[B5].run_id === 'slow-run' && db.state[B5].lock_until == null,
    '8a a run that outlives the request: "Still loading", run id kept, lock released (' + (r.body && r.body.note) + ')');
  A.onStart = () => { throw new Error('a second run was bought'); };
  A.onPoll = (p) => ({ status: 200, data: { data: { id: 'slow-run', status: 'SUCCEEDED', defaultDatasetId: 'ds-slow' } } });
  clock += 25 * MIN;                               // past the 20 min "still waiting" window
  r = await call({ brandId: B5, action: 'list' });
  ok(r.statusCode === 200 && runs() === before + 1 && r.body.videos.length > 0 && db.state[B5].run_id == null && A.calls.some(c => /\/v2\/actor-runs\/slow-run/.test(c.p)),
    '8b 25 min later the next request checks the SAME run first and gets its videos — one run bought (' + (runs() - before) + ')');
  ok(U.logs.filter(l => l.action === 'creatorfeed' && l.brandId === B5).length === 1, '8c its cost is logged once');
  A.onStart = null; A.onPoll = null;
}

// ── 9. short on time: the free transcripts are skipped ──
{
  const t0 = T.calls.length;
  A.onDataset = () => { clock += 130 * 1000; return { status: 200, data: PULL1() }; };
  const r = await call({ brandId: B6, action: 'list' });
  ok(r.statusCode === 200 && r.body.videos.length === 11 && T.calls.length === t0, '9a a pull that used most of the time budget skips the free transcripts (' + (T.calls.length - t0) + ')');
  A.onDataset = null;
}

// ── 10. the cost fuse ──
{
  const before = runs();
  U.status = { plan: 'trial', cost: 24.95 };
  const r = await call({ brandId: B7, action: 'list' });
  ok(r.statusCode === 200 && runs() === before && /paused/.test(r.body.note || '') && db.state[B7].lock_until == null, '10a a trial owner over the cost fuse is not pulled for');
  U.status = { plan: 'pro', cost: 0 };
}

// ── 10b. B8 has 2 creators: no "first 5" note ──
{
  const r = await call({ brandId: B8, action: 'list' });
  ok(r.statusCode === 200 && !/first 5/.test(r.body.note || ''), '10b 5 or fewer creators: no "first 5" note (' + r.body.note + ')');
}

// ── 13. a run that SUCCEEDED but could not be read / saved is re-read, never re-bought, logged once ──
{
  let before = runs();
  A.onDataset = () => ({ status: 503, data: null });
  let r = await call({ brandId: B9, action: 'list' });
  ok(r.statusCode === 502 && r.body.code === 'apify_failed' && runs() === before + 1, '13a dataset read fails after the run SUCCEEDED -> 502');
  ok(U.logs.filter(l => l.action === 'creatorfeed' && l.brandId === B9).length === 1, '13b the SUCCEEDED run is logged once anyway (it was paid for)');
  ok(db.state[B9].run_id && db.state[B9].fail_count === 1 && db.state[B9].lock_until == null, '13c its run id is kept for a re-read');
  A.onDataset = null;
  clock += 31 * MIN;
  r = await call({ brandId: B9, action: 'list' });
  ok(r.statusCode === 200 && r.body.videos.length === 13 && runs() === before + 1, '13d next pull re-reads the SAME run: no new run (' + (runs() - before) + ')');
  ok(U.logs.filter(l => l.action === 'creatorfeed' && l.brandId === B9).length === 1 && db.state[B9].run_id == null && db.state[B9].fail_count === 0,
    '13e still logged once; run id and failure count cleared');
  before = runs();
  db.failUpsert = true;
  r = await call({ brandId: B10, action: 'list' });
  db.failUpsert = false;
  ok(r.statusCode === 502 && runs() === before + 1 && db.state[B10].run_id && U.logs.filter(l => l.action === 'creatorfeed' && l.brandId === B10).length === 1,
    '13f our save fails: run kept, cost logged once');
  clock += 31 * MIN;
  r = await call({ brandId: B10, action: 'list' });
  ok(r.statusCode === 200 && runs() === before + 1 && U.logs.filter(l => l.action === 'creatorfeed' && l.brandId === B10).length === 1,
    '13g the re-read saves it: no second run, no second log');
}

// ── 14. two failed pulls in a row: 6 h wait ──
{
  const before = runs();
  A.onStart = () => ({ status: 402, data: null });
  await call({ brandId: B11, action: 'list' });
  clock += 31 * MIN;
  let r = await call({ brandId: B11, action: 'list' });
  ok(runs() === before + 2 && db.state[B11].fail_count === 2, '14a two failed pulls, 30 min apart (' + (runs() - before) + ')');
  clock += 31 * MIN;
  r = await call({ brandId: B11, action: 'refresh' });
  ok(runs() === before + 2 && r.statusCode === 502, '14b after 2 failures in a row, 31 min later: still waiting');
  clock += 5 * HOUR;
  r = await call({ brandId: B11, action: 'refresh' });
  ok(runs() === before + 2, '14c 5.5 h later: still waiting (6 h)');
  A.onStart = null;
  clock += 31 * MIN;
  r = await call({ brandId: B11, action: 'refresh' });
  ok(runs() === before + 3 && r.statusCode === 200 && db.state[B11].fail_count === 0, '14d after 6 h it tries again; success resets the count');
}

// ── 15. one transcript job per video ──
{
  const id = '2000002';
  const c0 = U.checks.length, t0 = T.calls.length, l0 = U.logs.filter(l => l.action === 'transcribeurl').length;
  T.answer = () => new Promise(res => setTimeout(() => res('slow words'), 40));
  const [a, b] = await Promise.all([call({ brandId: B1, action: 'transcript', videoId: id }), call({ brandId: B1, action: 'transcript', videoId: id })]);
  const won = [a, b].find(x => vid(x, id) && vid(x, id).transcriptStatus === 'ready');
  const lost = [a, b].find(x => x !== won);
  ok(won && lost && T.calls.length === t0 + 1 && U.checks.length === c0 + 1 && U.logs.filter(l => l.action === 'transcribeurl').length === l0 + 1,
    '15a a double tap: one transcriber run, one reservation, one charge (' + (T.calls.length - t0) + '/' + (U.checks.length - c0) + ')');
  ok(lost && lost.statusCode === 200 && vid(lost, id) && vid(lost, id).transcriptStatus === 'working' && /being transcribed/.test(lost.body.note || ''), '15b the other tap gets the row as "working", no charge');
  const row = db.videos[B1]['3000001'];
  Object.assign(row, { transcript_status: 'working', transcribed_at: iso(clock - MIN) });
  let r = await call({ brandId: B1, action: 'transcript', videoId: '3000001' });
  ok(T.calls.length === t0 + 1 && vid(r, '3000001').transcriptStatus === 'working', '15c a claim 1 min old is respected');
  Object.assign(row, { transcribed_at: iso(clock - 4 * MIN) });
  T.answer = async () => 'taken over';
  r = await call({ brandId: B1, action: 'transcript', videoId: '3000001' });
  ok(T.calls.length === t0 + 2 && vid(r, '3000001').transcript === 'taken over', '15d a claim 4 min old (killed request) is taken over');
  const row2 = db.videos[B1]['3000003'];
  T.answer = async () => { Object.assign(row2, { transcript: 'written elsewhere', transcript_status: 'ready' }); throw new Error('boom'); };
  r = await call({ brandId: B1, action: 'transcript', videoId: '3000003' });
  ok(r.statusCode === 502 && row2.transcript_status === 'ready' && row2.transcript === 'written elsewhere', '15e a failure never overwrites a ready transcript');
  T.answer = async () => 'these are the spoken words';
}

// ── 11. no raw provider text, ever ──
{
  const bad = errors.filter(b => !b || typeof b.error !== 'string' || !b.code || !PLAIN.test(b.error) || RAW.test(b.error));
  ok(errors.length >= 12 && bad.length === 0, '11a all ' + errors.length + ' error bodies are plain words with a code: ' + JSON.stringify(bad).slice(0, 300));
  const codes = new Set(errors.map(b => b.code));
  ok(['signed_out', 'forbidden', 'no_creators', 'not_tiktok', 'apify_failed', 'transcribe_failed'].every(c => codes.has(c)), '11b the contract codes all occur: ' + [...codes].join(','));
}

// ── 12. api/transcribe-url.js: same endpoint, plus the exported pipeline ──
{
  const https = require_('https');
  stub('_safeurl.js', { assertPublicHttpUrl: async () => true, safeLookup: function () {}, urlRefusalMessage: (e, d) => d });
  const TU = require_(path.join(API, 'transcribe-url.js'));
  ok(typeof TU === 'function' && typeof TU.transcribeVideo === 'function', '12a transcribe-url still exports the handler, plus transcribeVideo');
  const prevReq = https.request, prevGet = https.get;
  let groqStatus = 200, seen = [];
  const reply = (cb, status, body) => setImmediate(() => {
    const resp = new EventEmitter(); resp.statusCode = status; resp.headers = {}; resp.resume = () => resp; resp.destroy = () => {};
    cb(resp); resp.emit('data', Buffer.from(body)); resp.emit('end');
  });
  const fakeReq = () => { const q = new EventEmitter(); q.write = () => {}; q.setTimeout = () => q; q.destroy = () => {}; return q; };
  https.request = (opts, cb) => {
    const q = fakeReq(); seen.push(opts.hostname);
    q.end = () => opts.hostname === 'api.groq.com'
      ? reply(cb, groqStatus, groqStatus === 200 ? 'words from groq\n' : '{"error":{"message":"invalid_api_key"}}')
      : reply(cb, 200, JSON.stringify({ data: { play: 'https://cdn.tikwm.test/v.mp4' } }));
    return q;
  };
  https.get = (url, opts, cb) => { const q = fakeReq(); seen.push('get:' + new URL(url).hostname); reply(cb, 200, 'AUDIOBYTES'); return q; };
  try {
    let out = null, err = null;
    try { out = await quiet(() => TU.transcribeVideo('https://www.tiktok.com/@alpha/video/1000001', { deadline: Date.now() + 20000, apifyFallback: false })); } catch (e) { err = e; }
    ok(out === 'words from groq' && seen.join(',') === 'www.tikwm.com,get:cdn.tikwm.test,api.groq.com', '12b transcribeVideo: tikwm -> download -> Groq -> the words (' + (err ? err.message : out) + ' via ' + seen + ')');
    ok(!U.logs.some(l => l.userId === 'tu-user'), '12c transcribeVideo itself charges nothing');
    const res = mkRes();
    await quiet(() => TU({ method: 'POST', headers: {}, body: { url: 'https://www.tiktok.com/@alpha/video/1000001' } }, res));
    const logged = U.logs.filter(l => l.userId === 'tu-user' && l.action === 'transcribeurl');
    ok(res.statusCode === 200 && res.body && res.body.transcript === 'words from groq' && logged.length === 1, '12d POST /api/transcribe-url unchanged: {transcript} and one transcribeurl row');
    groqStatus = 401;
    const res2 = mkRes();
    await quiet(() => TU({ method: 'POST', headers: {}, body: { url: 'https://www.tiktok.com/@alpha/video/1000001' } }, res2));
    ok(res2.statusCode === 500 && U.logs.filter(l => l.userId === 'tu-user').length === 1, '12e a Whisper failure there is still 500 and still not charged');
  } finally { https.request = prevReq; https.get = prevGet; }
}

// ── 16. v723: Apify refuses OUR key (401/403) — waiting will not fix it, so no "Try again after HH:MM" ──
{
  const B12 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  db.comp[B12] = bookmarks(FOLLOWS);
  const OFF = /offline on our side/;
  const before = runs();
  A.onStart = () => ({ status: 401, data: { error: { type: 'user-or-token-not-found', message: 'User was not found or authentication token is not valid' } } });
  let r = await call({ brandId: B12, action: 'list', tzOffsetMin: -120 });
  ok(r.statusCode === 502 && OFF.test(r.body.error) && !/Try again after/.test(r.body.error) && runs() === before + 1, '16a no cache + key refused -> the plain "offline" message, no retry time (' + (r.body && r.body.error) + ')');
  r = await call({ brandId: B12, action: 'refresh', tzOffsetMin: -120 });
  ok(runs() === before + 1 && r.statusCode === 502 && OFF.test(r.body.error), '16b inside the wait: no new run, still the "offline" message');
  clock += 31 * MIN;
  db.state[B12].fetched_at = iso(clock - 30 * HOUR);   // an old cache: the user still sees the last videos, with the honest note
  A.onStart = () => ({ status: 403, data: null });
  r = await call({ brandId: B12, action: 'list', tzOffsetMin: -120 });
  ok(r.statusCode === 200 && OFF.test(JSON.stringify(r.body)) && runs() === before + 2, '16c with a cache + 403 -> 200 with the last videos and the "offline" note');
  A.onStart = () => ({ status: 402, data: null });
  clock += 7 * HOUR;
  r = await call({ brandId: B12, action: 'refresh', tzOffsetMin: -120 });
  ok(!OFF.test(JSON.stringify(r.body)), '16d other failures (402 out of credits) keep their own message');
  A.onStart = null;
}

clearTimeout(WALL);
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAIL: creator-feed-v711'); process.exit(1); }
console.log('PASS — creator-feed-v711: guards, lock, scores, transcripts and auto winners behave as the contract says');
process.exit(0);
