#!/usr/bin/env node
// GATE v722 — the PUBLIC landing reader POST /api/try-transcript (.unlazy/landing/CONTRACT.md).
// Runs the REAL api/try-transcript.js, api/transcribe-url.js and api/_usage.js against an in-memory store
// (try_read_slots with its PRIMARY KEY, try_transcript_cache), a scripted tikwm / cobalt / Groq / Apify, a fake media
// host and an in-memory PostgREST for usage_events. NO network, NO AI, NO Groq, NO Apify calls. Proves:
//   1 a bad link -> 400 bad_link, nothing fetched, nothing stored; tracking parameters never travel on;
//   2 same origin only: another site / no Origin+Referer -> 403; contentshrimp.com, Referer, own host pass; no CORS header;
//   3 3 reads a visitor a UTC day; the 4th -> 429 limit_reached (Retry-After), nothing fetched; each paid read is a
//     global 'done' row carrying the cost estimate; failed reads (Groq down, no words) are not counted;
//   4 PARALLEL: 10 at once from one visitor -> exactly 3; 12 visitors at once against a global cap of 4 -> exactly 4,
//     the rest 503 busy with their visitor slot handed back; a read in flight counts; a dead (stale) hold is taken over;
//   5 the global cap defaults to 300 -> busy;
//   6 too long: tikwm length (before any download), MP4 header -> 422 too_long; YOUTUBE reads its captions
//     (api/transcribe.js youtubeCaptions — never cobalt, never Whisper): length from the player API or the last
//     caption, too long -> too_long, no captions -> no_words; captions still count toward the caps;
//   7 a cache hit is free and fast: no provider call, outside the caps, its own 30/day limit;
//   8 signed-in /api/transcribe-url fills the cache and uses it (by link id and by a short link's tikwm id), uncounted;
//   9 Apify is never called, even when tikwm fails;
//  10 no raw IP is stored or logged (salted daily hash only; IPv6 counted per /64); no salt -> busy;
//  12 failures: a failure AFTER a provider call keeps its global slot (and real cost), counts in the visitor's 10/day
//     and the global 200/day failure buckets; a video that failed for its own reason (no words, too long, removed) is
//     remembered 24 h and answered free (a looped dead video calls the provider ONCE); a provider hiccup is not.
// RUN: node scripts/verify/try-transcript-v722.mjs   EXPECT: "PASS" and exit 0.
import { createRequire } from 'node:module';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
const require_ = createRequire(import.meta.url);
const Module = require_('module');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = path.join(ROOT, 'api');
const WALL = setTimeout(() => { console.log('FAIL: try-transcript-v722 wall clock (60s) — something hung'); process.exit(1); }, 60000);
let failed = 0, passed = 0;
const REAL = { error: console.error, warn: console.warn, log: console.log };
const ok = (c, m) => { if (c) { passed++; REAL.log('ok: ' + m); } else { failed++; REAL.log('FAIL: ' + m); } };
const LOGS = [];
// EVERY console line of the whole run is kept (parallel requests overlap, so it is never switched back on).
console.error = console.warn = console.log = (...a) => LOGS.push(a.map(x => (x && x.stack) ? x.stack : (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
const capture = async (fn) => fn();

process.env.SUPABASE_URL = 'https://try-v722.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only-not-a-real-key';
process.env.APIFY_API_TOKEN = 'test-only-apify';        // set on purpose: the reader must still never use it
process.env.GROQ_API_KEY = 'test-only-groq';
process.env.COST_CAP_EUR = '25';
delete process.env.TRY_DAILY_GLOBAL; delete process.env.USAGE_RESERVATIONS; delete process.env.RATE_LIMIT_PER_MIN;
delete process.env.COBALT_API_KEY; delete process.env.COBALT_API_URL;
function stub(rel, exports) {
  const file = require_.resolve(path.join(API, rel));
  const m = new Module(file); m.filename = file; m.loaded = true; m.exports = exports; require_.cache[file] = m;
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const iso = (t) => new Date(t).toISOString();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);

// ── the fake store: try_read_slots (PRIMARY KEY day,bucket,slot) and try_transcript_cache ──
const SLOTS = new Map();     // 'day|bucket|slot' -> row
const CACHE = new Map();     // video_id -> row
const MISSES = new Map();    // video_id -> row
const STORE = { failSlots: false, calls: 0 };
const sk = (r) => r.day + '|' + r.bucket + '|' + r.slot;
function params(p) {
  const q = p.indexOf('?') < 0 ? '' : p.slice(p.indexOf('?') + 1);
  const out = [];
  for (const part of q.split('&').filter(Boolean)) {
    const j = part.indexOf('='); const k = decodeURIComponent(part.slice(0, j)), v = decodeURIComponent(part.slice(j + 1));
    if (['select', 'order', 'limit', 'on_conflict'].includes(k)) continue;
    out.push([k, v]);
  }
  return out;
}
function match(row, fs) {
  return fs.every(([k, v]) => {
    const m = /^(eq|lt|gt)\.([\s\S]*)$/.exec(v); if (!m) return true;
    const a = row[k]; if (a == null) return false;
    if (m[1] === 'eq') return String(a) === m[2];
    const A = k.endsWith('_at') ? Date.parse(a) : String(a), B = k.endsWith('_at') ? Date.parse(m[2]) : m[2];
    return m[1] === 'lt' ? A < B : A > B;
  });
}
async function rest(method, p, opts) {
  STORE.calls++;
  await sleep(Math.floor(Math.random() * 3));             // interleave parallel requests for real
  const o = opts || {}, table = p.split('?')[0], fs = params(p);
  const prefer = String((o.headers && o.headers.Prefer) || '');
  if (table === '/try_read_slots') {
    if (STORE.failSlots || (STORE.failG && /bucket=eq\.g(&|$)/.test(p))) return { status: 500, data: { message: 'down' }, raw: 'down' };
    if (method === 'GET') return { status: 200, data: clone([...SLOTS.values()].filter(r => match(r, fs)).sort((a, b) => a.slot - b.slot)) };
    if (method === 'POST') {
      const row = clone(o.body), k = sk(row);
      if (SLOTS.has(k) && !/merge-duplicates/.test(prefer)) return { status: 409, data: { code: '23505', message: 'duplicate key value violates unique constraint "try_read_slots_pkey"' }, raw: '23505' };
      SLOTS.set(k, Object.assign({ cost_eur: 0, video_id: null }, row)); return { status: 201, data: null };
    }
    const hit = [...SLOTS.values()].filter(r => match(r, fs));
    if (method === 'PATCH') { for (const r of hit) Object.assign(r, clone(o.body)); return { status: 200, data: /representation/.test(prefer) ? clone(hit) : null }; }
    if (method === 'DELETE') { for (const r of hit) SLOTS.delete(sk(r)); return { status: 204, data: null }; }
  }
  if (table === '/try_transcript_cache') {
    if (method === 'GET') return { status: 200, data: clone([...CACHE.values()].filter(r => match(r, fs))) };
    if (method === 'POST') { const b = clone(o.body); CACHE.set(b.video_id, Object.assign({}, CACHE.get(b.video_id) || {}, b)); return { status: 201, data: null }; }
  }
  if (table === '/try_transcript_misses') {
    if (method === 'GET') return { status: 200, data: clone([...MISSES.values()].filter(r => match(r, fs))) };
    if (method === 'POST') { const b = clone(o.body); MISSES.set(b.video_id, b); return { status: 201, data: null }; }
  }
  return { status: 404, data: null, raw: 'unknown ' + p };
}
// 'v:' / 'f:' / 'h:' = every bucket of that kind; anything else = that exact bucket ('g' is not 'gf')
const slotsOf = (b) => [...SLOTS.values()].filter(r => r.day === today() && (b.endsWith(':') ? r.bucket.startsWith(b) : r.bucket === b));

// ── fake media files ──
function mp4(sec) {          // ftyp + moov/mvhd (version 0, timescale 1000)
  const b = Buffer.alloc(200); b.write('ftypisom', 4, 'latin1'); b.writeUInt32BE(108, 40); b.write('mvhd', 44, 'latin1');
  b.writeUInt32BE(1000, 44 + 16); b.writeUInt32BE(Math.round(sec * 1000), 44 + 20); return b;
}
function mp3(sec) {          // MPEG-1 Layer III, 128 kbps, 44.1 kHz, CBR: 16000 bytes a second
  const b = Buffer.alloc(Math.round(sec * 16000)); b[0] = 0xff; b[1] = 0xfb; b[2] = 0x90; b[3] = 0x00; return b;
}

// ── the fake network ──
const https = require_('node:https');
const NET = { tikwm: 0, groq: 0, apify: 0, cobalt: 0, download: 0, dur: 30, noDur: false, tikwmFail: false, groqMode: 'ok', audio: mp4(30), shortId: {}, tikIds: [] };
const ev = []; const plans = new Map();
let currentUser = { id: 'U-1' };
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
let lastStamp = 0;
const stampNow = () => { lastStamp = Math.max(Date.now(), lastStamp + 1); return iso(lastStamp); };
function route(opts, payload) {
  const host = String(opts.hostname || '');
  if (host === 'www.tikwm.com') {
    NET.tikwm++;
    const url = decodeURIComponent((/url=([^&]*)/.exec(payload) || [])[1] || '');
    NET.tikUrls = (NET.tikUrls || []).concat(url);
    if (NET.tikwmFail) return { status: 200, body: JSON.stringify({ code: -1, msg: 'Url parsing is failed' }) };
    const id = (/\/video\/(\d+)/.exec(url) || [])[1] || NET.shortId[url] || null;
    const data = { id, play: 'https://cdn.tikwm.test/v.mp4', author: { unique_id: 'alpha', nickname: 'Alpha' } };
    if (!NET.noDur) data.duration = NET.dur;
    return { status: 200, body: JSON.stringify({ code: 0, data }) };
  }
  if (host === 'api.groq.com') {
    NET.groq++;
    if (NET.groqMode === 'fail') return { status: 401, body: '{"error":{"message":"invalid_api_key"}}' };
    if (NET.groqMode === 'empty') return { status: 200, body: '  \n' };
    return { status: 200, body: 'these are the spoken words\n' };
  }
  if (host === 'api.cobalt.tools') { NET.cobalt++; return { status: 200, body: JSON.stringify({ status: 'tunnel', url: 'https://cdn.cobalt.test/a.mp3' }) }; }
  if (host === 'api.apify.com') { NET.apify++; return { status: 500, body: '{}' }; }
  if (host !== 'try-v722.invalid') return { status: 599, body: 'unexpected host ' + host };
  const table = opts.path.split('?')[0], s = sp(opts.path);
  if (table === '/rest/v1/user_plans') {
    if (opts.method === 'GET') { const r = plans.get(eqv(s, 'user_id')); return { status: 200, body: JSON.stringify(r ? [r] : []) }; }
    if (opts.method === 'POST') { const b = JSON.parse(payload); if (!plans.has(b.user_id)) plans.set(b.user_id, Object.assign({ plan: 'trial' }, b)); return { status: 201, body: '' }; }
    return { status: 204, body: '' };
  }
  if (table === '/rest/v1/brands' && opts.method === 'GET') return { status: 200, body: JSON.stringify([{ user_id: currentUser.id }]) };
  if (table === '/rest/v1/usage_events') {
    if (opts.method === 'GET') {
      const asc = /created_at\.asc/.test(s.get('order') || '');
      const all = ev.filter(evMatch(s)).sort((a, b) => (asc ? 1 : -1) * (Date.parse(a.created_at) - Date.parse(b.created_at)));
      const off = Number(s.get('offset') || 0), lim = Number(s.get('limit') || 1000), page = all.slice(off, off + lim);
      return { status: 200, headers: { 'content-range': page.length ? off + '-' + (off + page.length - 1) + '/' + all.length : '*/' + all.length }, body: JSON.stringify(page) };
    }
    if (opts.method === 'POST') { const b = JSON.parse(payload); ev.push(Object.assign({ created_at: stampNow() }, b)); return { status: 201, body: JSON.stringify([ev[ev.length - 1]]) }; }
    if (opts.method === 'PATCH') { const uid = eqv(s, 'user_id'), act = eqv(s, 'action'), b = JSON.parse(payload); const hit = ev.filter(r => r.user_id === uid && r.action === act); hit.forEach(r => Object.assign(r, b)); return { status: 200, body: JSON.stringify(hit) }; }
    if (opts.method === 'DELETE') { const uid = eqv(s, 'user_id'), act = eqv(s, 'action'); for (let i = ev.length - 1; i >= 0; i--) if (ev[i].user_id === uid && ev[i].action === act) ev.splice(i, 1); return { status: 204, body: '' }; }
  }
  return { status: 404, body: '{}' };
}
const fakeReq = () => { const q = new EventEmitter(); q.setTimeout = () => q; q.destroy = () => q; q.setHeader = () => q; return q; };
const answer = (cb, out) => setImmediate(() => {
  const resp = new EventEmitter(); resp.statusCode = out.status; resp.headers = out.headers || {}; resp.resume = () => resp; resp.destroy = () => {};
  cb(resp); setImmediate(() => { if (out.body != null && out.body.length) resp.emit('data', Buffer.isBuffer(out.body) ? out.body : Buffer.from(out.body)); resp.emit('end'); });
});
https.request = function (opts, cb) {
  const q = fakeReq(); let payload = '';
  q.write = (c) => { payload += typeof c === 'string' ? c : (c.length > 4096 ? '[binary]' : c.toString('latin1')); return true; };
  q.end = () => { setImmediate(() => { let out; try { out = route(opts, payload); } catch (e) { q.emit('error', e); return; } answer(cb, out); }); return q; };
  return q;
};
// YouTube captions (api/transcribe.js): the innertube player via global fetch, the caption XML via https.get
NET.yt = 0; NET.ytLen = 120; NET.ytCaptions = true;
NET.ytXml = '<transcript><text start="0" dur="2">hello from</text><text start="2" dur="3">youtube &amp; friends</text></transcript>';
https.get = function (url, opts, cb) {
  const u = String(url), q = fakeReq(); q.end = () => q;
  if (u.includes('youtube.com/api/timedtext')) { NET.yt++; answer(cb, { status: 200, body: NET.ytXml }); return q; }
  if (u.includes('youtube.com/watch')) { NET.yt++; answer(cb, { status: 200, body: '<html>no captions here</html>' }); return q; }
  NET.download++; answer(cb, { status: 200, body: NET.audio }); return q;
};
globalThis.fetch = async (url) => {
  if (!String(url).includes('youtubei/v1/player')) throw new Error('no real network in this gate');
  NET.yt++;
  return { json: async () => Object.assign(NET.ytLen ? { videoDetails: { lengthSeconds: String(NET.ytLen) } } : {},
    NET.ytCaptions ? { captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en', baseUrl: 'https://www.youtube.com/api/timedtext?v=x' }] } } } : {}) };
};

const SAFE = { calls: 0 };
stub('_requireUser.js', async () => currentUser);
stub('_safeurl.js', { assertPublicHttpUrl: async (u) => { SAFE.calls++; if (/blocked/.test(String(u))) throw new Error('URL host not allowed'); return new URL(u); }, safeLookup: function () {}, urlRefusalMessage: (e, d) => d });
stub('_publish/store.js', { rest, setRequestBudget() {}, heartbeat: async () => {}, userCanAccessBrand: async () => true });

const TT = require_(path.join(API, 'try-transcript.js'));
const TU = require_(path.join(API, 'transcribe-url.js'));
const TR = require_(path.join(API, 'transcribe.js'));

function mkRes() {
  const r = { statusCode: 200, body: undefined, headers: {} };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = () => r;
  return r;
}
const IPS = [];
let ipN = 0;
const newIp = () => { const ip = '203.0.113.' + (++ipN); IPS.push(ip); return ip; };
let vid = 7100000000;
const TTV = () => 'https://www.tiktok.com/@alpha/video/' + (++vid) + '?is_from_webapp=1&sender_device=pc&_r=1';
const ALL_RES = [];
async function tryRead(url, o) {
  const opt = o || {};
  const headers = Object.assign({ host: 'contentshrimp.com', origin: 'https://contentshrimp.com', 'x-forwarded-for': (opt.ip || newIp()) + ', 10.1.2.3' }, opt.headers || {});
  for (const k of Object.keys(headers)) if (headers[k] == null) delete headers[k];
  const res = mkRes();
  const t0 = Date.now();
  await capture(() => TT({ method: opt.method || 'POST', headers, body: opt.body !== undefined ? opt.body : { url } }, res));
  res.ms = Date.now() - t0;
  ALL_RES.push(res);
  return res;
}
async function appRead(uid, url) {
  currentUser = { id: uid };
  const res = mkRes();
  await capture(() => TU({ method: 'POST', headers: { origin: 'https://contentshrimp.com' }, body: { url } }, res));
  return res;
}
const net0 = () => ({ t: NET.tikwm, g: NET.groq, d: NET.download, c: NET.cobalt });
const sameNet = (a) => NET.tikwm === a.t && NET.groq === a.g && NET.download === a.d && NET.cobalt === a.c;
const PLAIN = /^[A-Z][^{}<>]*[.!]$/;
const RAW = /HTTP|apify|groq|whisper|tikwm|cobalt|supabase|stack|undefined|null|\[object|ECONN|status|23505/i;

// ── 1. bad links ──
{
  const bad = ['https://evil.example/@a/video/1234567', 'https://www.tiktok.com.evil.example/@a/video/1234567', 'ftp://www.tiktok.com/@a/video/1234567',
    'javascript:alert(1)', 'https://www.instagram.com/reel/abc123', 'https://www.youtube.com/watch?v=short', 'https://user:pw@www.tiktok.com/@a/video/1234567',
    'https://www.tiktok.com:8443/@a/video/1234567', 'https://www.tiktok.com/', 'www.tiktok.com/@a/video/1234567', '', 'x'.repeat(3000)];
  const n = net0(), s0 = SLOTS.size;
  let allBad = true, plain = true;
  for (const u of bad) { const r = await tryRead(u); if (!(r.statusCode === 400 && r.body && r.body.code === 'bad_link')) { allBad = false; REAL.log('   not bad_link: ' + u.slice(0, 60) + ' -> ' + r.statusCode + ' ' + JSON.stringify(r.body)); } if (!PLAIN.test(r.body && r.body.error)) plain = false; }
  const noBody = await tryRead(null, { body: null });
  ok(allBad && noBody.statusCode === 400 && noBody.body.code === 'bad_link', '1a every non-TikTok/YouTube or malformed link (and no body) -> 400 bad_link');
  ok(plain, '1b in plain words: ' + JSON.stringify(noBody.body.error));
  ok(sameNet(n) && SLOTS.size === s0 && NET.apify === 0, '1c nothing fetched, nothing stored');
  const p = TT.parseLink('https://www.tiktok.com/@a.b/video/7123456789?is_from_webapp=1&sender_device=pc');
  ok(p && p.url === 'https://www.tiktok.com/@a.b/video/7123456789' && p.key === 'tt:7123456789', '1d tracking parameters are dropped from a TikTok link (' + JSON.stringify(p) + ')');
  const y = ['https://youtu.be/dQw4w9WgXcQ?si=track', 'https://www.youtube.com/shorts/dQw4w9WgXcQ', 'http://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share'].map(TT.parseLink);
  ok(y.every(x => x && x.key === 'yt:dQw4w9WgXcQ' && x.url === 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'), '1e youtu.be / shorts / http m.youtube all read as one clean YouTube link');
  const sh = TT.parseLink('Look at this https://vm.tiktok.com/ZMabc123/ #fyp');
  ok(sh && sh.key === null && sh.url === 'https://vm.tiktok.com/ZMabc123/', '1f a share-sheet paste with a vm.tiktok.com short link is accepted (key from tikwm later)');
}

// ── 2. same origin only ──
{
  const n = net0();
  const evil = await tryRead(TTV(), { headers: { origin: 'https://evil.example' } });
  const none = await tryRead(TTV(), { headers: { origin: null } });
  const http = await tryRead(TTV(), { headers: { origin: 'http://contentshrimp.com' } });
  const nul = await tryRead(TTV(), { headers: { origin: 'null' } });
  const refEvil = await tryRead(TTV(), { headers: { origin: null, referer: 'https://contentshrimp.com.evil.example/x' } });
  ok([evil, none, http, nul, refEvil].every(r => r.statusCode === 403 && r.body && r.body.code === 'failed'), '2a another site, no Origin/Referer, http://, "null", a look-alike Referer -> 403 (' + [evil, none, http, nul, refEvil].map(r => r.statusCode).join(',') + ')');
  ok(sameNet(n) && PLAIN.test(evil.body.error), '2b nothing fetched; in plain words: ' + JSON.stringify(evil.body.error));
  const ref = await tryRead('https://evil.example/x', { headers: { origin: null, referer: 'https://contentshrimp.com/' } });
  const www = await tryRead('https://evil.example/x', { headers: { origin: 'https://www.contentshrimp.com' } });
  const own = await tryRead('https://evil.example/x', { headers: { origin: 'https://boring-engine.vercel.app', host: 'boring-engine.vercel.app' } });
  ok([ref, www, own].every(r => r.statusCode === 400 && r.body.code === 'bad_link'), '2c contentshrimp.com Referer, www.contentshrimp.com and the deployment\'s own host get past the origin check');
  const get = await tryRead(TTV(), { method: 'GET' });
  ok(get.statusCode === 405, '2d GET -> 405');
}

// ── 3. three reads a visitor a day; failures are not counted ──
const A = newIp();
{
  const r1 = await tryRead(TTV(), { ip: A });
  ok(r1.statusCode === 200 && r1.body.ok === true && r1.body.transcript === 'these are the spoken words' && r1.body.creator === 'alpha' &&
     r1.body.durationSec === 30 && /^tt:\d+$/.test(r1.body.videoId) && r1.body.cached === false, '3a a read answers the contract shape (' + JSON.stringify(r1.body) + ')');
  ok(NET.tikUrls[NET.tikUrls.length - 1] === 'https://www.tiktok.com/@alpha/video/' + vid, '3b tikwm got the CLEAN link (no tracking parameters)');
  const r2 = await tryRead(TTV(), { ip: A }), r3 = await tryRead(TTV(), { ip: A });
  ok(r2.statusCode === 200 && r3.statusCode === 200, '3c reads 2 and 3 pass');
  const n = net0();
  const r4 = await tryRead(TTV(), { ip: A });
  ok(r4.statusCode === 429 && r4.body.code === 'limit_reached' && Number(r4.headers['Retry-After']) > 0 && Number(r4.headers['Retry-After']) <= 86400, '3d the 4th read in a day -> 429 limit_reached + Retry-After (' + r4.statusCode + ' ' + JSON.stringify(r4.body) + ')');
  ok(sameNet(n) && PLAIN.test(r4.body.error) && !RAW.test(r4.body.error), '3e nothing fetched; in plain words: ' + JSON.stringify(r4.body.error));
  const g = slotsOf('g');
  ok(g.length === 3 && g.every(r => r.status === 'done' && r.cost_eur === TT.COST_EUR && /^tt:/.test(r.video_id)) && TT.COST_EUR > 0, '3f each paid read is one global done row carrying its cost estimate (' + TT.COST_EUR + ')');
  // failures hand their slots back
  const F = newIp();
  NET.groqMode = 'fail';
  let fails = 0; for (let i = 0; i < 3; i++) { const r = await tryRead(TTV(), { ip: F }); if (r.statusCode === 502 && r.body.code === 'failed' && PLAIN.test(r.body.error) && !RAW.test(r.body.error)) fails++; }
  NET.groqMode = 'empty';
  const nw = await tryRead(TTV(), { ip: F });
  NET.groqMode = 'ok';
  ok(fails === 3 && nw.statusCode === 422 && nw.body.code === 'no_words', '3g Groq down -> 502 failed in plain words; no words -> 422 no_words (' + nw.statusCode + ' ' + JSON.stringify(nw.body) + ')');
  let after = 0; for (let i = 0; i < 4; i++) { const r = await tryRead(TTV(), { ip: F }); if (r.statusCode === 200) after++; }
  ok(after === 3, '3h after 4 failed reads the visitor still gets exactly 3 SUCCESSFUL reads (' + after + ')');
  const fh = TT.visitorHash(F, today());
  ok(slotsOf('f:' + fh).length === 4 && slotsOf('f:' + fh).every(r => r.status === 'done') && slotsOf('g').length === 10 &&
     slotsOf('g').filter(r => r.cost_eur === TT.COST_EUR).length === 10, '3i the 4 failures (Whisper was paid) keep their global slot at full cost and count in the visitor\'s failure bucket');
}

// ── 4. parallel bursts and in-flight reads ──
{
  const P = newIp();
  const rs = await Promise.all(Array.from({ length: 10 }, () => tryRead(TTV(), { ip: P })));
  const okN = rs.filter(r => r.statusCode === 200).length, lim = rs.filter(r => r.statusCode === 429 && r.body.code === 'limit_reached').length;
  ok(okN === 3 && lim === 7, '4a 10 parallel reads from one visitor -> exactly 3 succeed, 7 limit_reached (' + okN + '/' + lim + ')');
  const before = slotsOf('g').length;
  process.env.TRY_DAILY_GLOBAL = String(before + 4);
  const vis = Array.from({ length: 12 }, () => newIp());
  const gs = await Promise.all(vis.map(ip => tryRead(TTV(), { ip })));
  const gOk = gs.filter(r => r.statusCode === 200).length, busy = gs.filter(r => r.statusCode === 503 && r.body.code === 'busy');
  ok(gOk === 4 && busy.length === 8 && slotsOf('g').length === before + 4, '4b 12 visitors at once against 4 global slots left -> exactly 4 read, 8 busy (' + gOk + '/' + busy.length + ')');
  ok(busy.every(r => PLAIN.test(r.body.error) && Number(r.headers['Retry-After']) > 0), '4c busy is in plain words with Retry-After: ' + JSON.stringify(busy[0] && busy[0].body.error));
  ok(slotsOf('v:').filter(r => r.status === 'held').length === 0 && vis.filter(ip => slotsOf('v:' + TT.visitorHash(ip, today())).length).length === 4,
    '4d only the 4 visitors who got a read keep a visitor slot; none is left held');
  const vb = slotsOf('v:').length;
  process.env.TRY_DAILY_GLOBAL = String(before + 4);
  const B2 = newIp();
  const again = await tryRead(TTV(), { ip: B2 });
  ok(again.statusCode === 503 && slotsOf('v:').length === vb, '4e a busy answer hands the visitor slot back (no visitor slot kept: ' + (slotsOf('v:').length - vb) + ')');
  // the cap LOWERED mid-day below the rows already there: still no new read
  process.env.TRY_DAILY_GLOBAL = String(Math.max(1, before - 2));
  const low = await tryRead(TTV());
  ok(low.statusCode === 503 && low.body.code === 'busy', '4e2 a cap lowered below today\'s reads admits nothing more (' + low.statusCode + ')');
  delete process.env.TRY_DAILY_GLOBAL;
  // in-flight reads count; a dead hold is taken over
  const S = newIp();
  const vh = TT.visitorHash(S, today());
  for (let i = 1; i <= 3; i++) SLOTS.set(today() + '|v:' + vh + '|' + i, { day: today(), bucket: 'v:' + vh, slot: i, status: 'held', token: 'other' + i, held_at: iso(Date.now() - 1000), done_at: null, cost_eur: 0, video_id: null });
  const n = net0();
  const live = await tryRead(TTV(), { ip: S });
  ok(live.statusCode === 429 && live.body.code === 'limit_reached' && sameNet(n), '4f three reads still IN FLIGHT count: a 4th -> limit_reached, nothing fetched');
  for (let i = 1; i <= 3; i++) SLOTS.get(today() + '|v:' + vh + '|' + i).held_at = iso(Date.now() - TT.HOLD_TTL_MS - 60000);
  const take = await tryRead(TTV(), { ip: S });
  ok(take.statusCode === 200, '4g a hold older than its TTL (a killed function) is taken over (' + take.statusCode + ')');
}

// ── 4h. a big burst with room left: nobody is wrongly turned away ──
{
  const big = await Promise.all(Array.from({ length: 40 }, () => tryRead(TTV())));
  const n = big.filter(r => r.statusCode === 200).length;
  ok(n === 40, '4h 40 visitors at once with room under the cap -> all 40 read (' + n + ')');
}

// ── 5. the global cap defaults to 300 ──
{
  delete process.env.TRY_DAILY_GLOBAL;
  ok(TT.globalCap() === 300 && TT.DEFAULT_GLOBAL_DAILY === 300, '5a the global cap is 300 a day by default');
  const taken = new Set(slotsOf('g').map(r => r.slot)), added = [];
  for (let i = 1; i <= 300 && taken.size + added.length < 299; i++) if (!taken.has(i)) { const k = today() + '|g|' + i; SLOTS.set(k, { day: today(), bucket: 'g', slot: i, status: 'done', token: 'fill', held_at: iso(Date.now()), done_at: iso(Date.now()), cost_eur: 0.06, video_id: null }); added.push(k); }
  const last = await tryRead(TTV()), over = await tryRead(TTV());
  ok(last.statusCode === 200 && over.statusCode === 503 && over.body.code === 'busy', '5b read 300 of the day passes, 301 -> 503 busy (' + last.statusCode + ', ' + over.statusCode + ')');
  for (const k of added) SLOTS.delete(k);
  for (const r of slotsOf('g')) if (r.slot > 290) SLOTS.delete(sk(r));
}

// ── 6. too long ──
{
  let V = newIp(), n = net0();
  NET.dur = 200;
  const a = await tryRead(TTV(), { ip: V });
  NET.dur = 30;
  ok(a.statusCode === 422 && a.body.code === 'too_long' && NET.download === n.d && NET.groq === n.g, '6a tikwm says 200 s -> 422 too_long BEFORE any download or Whisper (' + a.statusCode + ' ' + JSON.stringify(a.body) + ')');
  ok(PLAIN.test(a.body.error) && slotsOf('v:' + TT.visitorHash(V, today())).length === 0, '6b in plain words, and the visitor\'s slot was handed back');
  n = net0(); NET.noDur = true; NET.audio = mp4(200);
  const b = await tryRead(TTV(), { ip: V });
  ok(b.statusCode === 422 && b.body.code === 'too_long' && NET.groq === n.g, '6c no length from tikwm, the MP4 header says 200 s -> too_long, Whisper not paid');
  NET.audio = mp4(170);
  const b2 = await tryRead(TTV(), { ip: V });
  NET.noDur = false; NET.audio = mp4(30);
  ok(b2.statusCode === 200 && b2.body.durationSec === null, '6d a 170 s MP4 with no tikwm length reads fine (' + b2.statusCode + ')');
  // YouTube = captions
  ok(typeof TR.youtubeCaptions === 'function', '6e0 api/transcribe.js exports youtubeCaptions');
  n = net0(); NET.ytLen = 200;
  const Y1 = newIp();
  const c = await tryRead('https://www.youtube.com/watch?v=AAAAAAAAAA1&t=3', { ip: Y1 });
  ok(c.statusCode === 422 && c.body.code === 'too_long' && sameNet(n) && slotsOf('v:' + TT.visitorHash(Y1, today())).length === 0, '6e a 200 s YouTube video -> too_long, no cobalt / download / Whisper, the read not counted (' + c.statusCode + ')');
  NET.ytLen = 120;
  const Y2 = newIp(), y0 = NET.yt;
  const d = await tryRead('https://youtu.be/AAAAAAAAAA2?si=tracking', { ip: Y2 });
  ok(d.statusCode === 200 && d.body.videoId === 'yt:AAAAAAAAAA2' && d.body.transcript === 'hello from youtube & friends' && d.body.durationSec === 120 && d.body.cached === false,
    '6f a 2-minute YouTube video reads through its CAPTIONS (' + d.statusCode + ' ' + JSON.stringify(d.body) + ')');
  ok(sameNet(n) && NET.yt > y0, '6f2 no cobalt, no download, no Whisper — only the YouTube captions path');
  const yg = [...SLOTS.values()].find(r => r.bucket === 'g' && r.video_id === 'yt:AAAAAAAAAA2');
  ok(yg && yg.status === 'done' && yg.cost_eur === 0 && slotsOf('v:' + TT.visitorHash(Y2, today())).length === 1 && CACHE.get('yt:AAAAAAAAAA2'),
    '6f3 a captions read still takes a visitor and a global slot (cost 0) and fills the cache');
  NET.ytLen = null; NET.ytXml = '<transcript><text start="0" dur="2">one</text><text start="150" dur="5">two</text></transcript>';
  const e1 = await tryRead('https://www.youtube.com/shorts/AAAAAAAAAA3');
  NET.ytXml = '<transcript><text start="0" dur="2">one</text><text start="300" dur="5">two</text></transcript>';
  const e2 = await tryRead('https://www.youtube.com/shorts/AAAAAAAAAA4');
  ok(e1.statusCode === 200 && e1.body.durationSec === 155 && e2.statusCode === 422 && e2.body.code === 'too_long', '6f4 no length from the player: the last caption decides (155 s reads, 305 s -> too_long)');
  NET.ytLen = 120; NET.ytCaptions = false;
  const Y3 = newIp();
  const nc = await tryRead('https://www.youtube.com/watch?v=AAAAAAAAAA5', { ip: Y3 });
  NET.ytCaptions = true;
  ok(nc.statusCode === 422 && nc.body.code === 'no_words' && PLAIN.test(nc.body.error) && slotsOf('v:' + TT.visitorHash(Y3, today())).length === 0, '6f5 no captions -> 422 no_words in plain words, not counted as a read: ' + JSON.stringify(nc.body.error));
  const yb = NET.yt;
  const nc2 = await tryRead('https://www.youtube.com/watch?v=AAAAAAAAAA5');
  ok(nc2.statusCode === 422 && nc2.body.code === 'no_words' && NET.yt === yb, '6f5b and remembered: asked again, YouTube is not called');
  NET.ytXml = '<transcript><text start="0" dur="2">hello from</text><text start="2" dur="3">youtube &amp; friends</text></transcript>';
  const Y4 = newIp(); let yok = 0;
  for (let i = 6; i <= 8; i++) if ((await tryRead('https://youtu.be/AAAAAAAAA' + i + 'Z', { ip: Y4 })).statusCode === 200) yok++;
  const n4 = net0(), yy = NET.yt;
  const y4 = await tryRead('https://youtu.be/AAAAAAAAAA9', { ip: Y4 });
  ok(yok === 3 && y4.statusCode === 429 && y4.body.code === 'limit_reached' && NET.yt === yy && sameNet(n4), '6f6 YouTube reads count toward the 3 a day: the 4th -> limit_reached, nothing fetched');
  ok(Math.abs(TT.audioSeconds(mp3(120)) - 120) < 1 && Math.abs(TT.audioSeconds(mp4(61.5)) - 61.5) < 0.01 && TT.audioSeconds(Buffer.from('AUDIOBYTES-UNKNOWN')) === null, '6g the header readers measure MP3 / MP4 lengths, unknown -> null');
}

// ── 7. a cache hit is free, fast and outside the caps ──
{
  const url = TTV(), key = 'tt:' + vid;
  const first = await tryRead(url);
  ok(first.statusCode === 200 && CACHE.get(key) && CACHE.get(key).transcript === 'these are the spoken words' && CACHE.get(key).source === 'try', '7a a read fills the cache by video id');
  const n = net0(), g0 = slotsOf('g').length;
  const hitA = await tryRead(url + '&utm_source=x', { ip: A });      // A is at 3/3 for the day
  ok(hitA.statusCode === 200 && hitA.body.cached === true && hitA.body.transcript === 'these are the spoken words' && hitA.body.videoId === key && hitA.body.creator === 'alpha', '7b a visitor at the daily cap still gets a cached video (' + hitA.statusCode + ' ' + JSON.stringify(hitA.body) + ')');
  ok(sameNet(n) && slotsOf('g').length === g0 && hitA.ms < 500, '7c no provider call, no global slot, answered in ' + hitA.ms + ' ms');
  const H = newIp();
  let hits = 0; for (let i = 0; i < 5; i++) if ((await tryRead(url, { ip: H })).statusCode === 200) hits++;
  let paid = 0; for (let i = 0; i < 3; i++) if ((await tryRead(TTV(), { ip: H })).statusCode === 200) paid++;
  ok(hits === 5 && paid === 3, '7d 5 cache hits do not use up a visitor\'s 3 reads (' + hits + ' hits, then ' + paid + ' reads)');
  const C = newIp();
  let c = 0; for (let i = 0; i < 30; i++) if ((await tryRead(url, { ip: C })).statusCode === 200) c++;
  const h31 = await tryRead(url, { ip: C });
  ok(c === 30 && h31.statusCode === 429 && h31.body.code === 'limit_reached', '7e cache hits have their own generous cap: 30 a day, the 31st -> limit_reached');
  // a short link whose tikwm id is cached: no download, no Whisper, the visitor slot handed back
  NET.shortId['https://vm.tiktok.com/ZMabc123/'] = String(vid - 3 >= 7100000001 ? vid : vid);
  NET.shortId['https://vm.tiktok.com/ZMabc123/'] = key.slice(3);
  const Q = newIp(), n2 = net0();
  const s = await tryRead('https://vm.tiktok.com/ZMabc123/?_t=8kz', { ip: Q });
  ok(s.statusCode === 200 && s.body.cached === true && s.body.videoId === key && NET.download === n2.d && NET.groq === n2.g, '7f a short link resolving to a cached video is served from the cache (no download, no Whisper)');
  ok(slotsOf('v:' + TT.visitorHash(Q, today())).length === 0, '7g and it did not use up a read');
}

// ── 8. signed-in /api/transcribe-url fills and uses the same cache ──
{
  plans.set('U-1', { user_id: 'U-1', plan: 'free' });
  const url = 'https://www.tiktok.com/@alpha/video/9000000001';
  const r = await appRead('U-1', url);
  ok(r.statusCode === 200 && r.body.transcript === 'these are the spoken words', '8a a signed-in read still answers {transcript} (' + r.statusCode + ' ' + JSON.stringify(r.body) + ')');
  const row = CACHE.get('tt:9000000001');
  ok(row && row.source === 'app' && row.transcript === 'these are the spoken words' && row.creator === 'alpha' && row.duration_sec === 30, '8b and fills the shared cache (' + JSON.stringify(row) + ')');
  const n = net0();
  const anon = await tryRead(url);
  ok(anon.statusCode === 200 && anon.body.cached === true && sameNet(n), '8c the landing reader then serves it from the cache');
  const rows0 = ev.filter(e => e.user_id === 'U-1' && e.action === 'transcribeurl').length;
  const pre = await tryRead(TTV());              // the landing reader caches a video …
  const key = pre.body.videoId;
  const n2 = net0();
  const app = await appRead('U-1', 'https://www.tiktok.com/@alpha/video/' + key.slice(3));
  ok(app.statusCode === 200 && app.body.transcript === 'these are the spoken words' && sameNet(n2), '8d … and a signed-in read of it uses the cache: no provider call');
  ok(ev.filter(e => e.user_id === 'U-1' && e.action === 'transcribeurl').length === rows0 && !ev.some(e => e.user_id === 'U-1' && String(e.action).startsWith('hold:')), '8e a signed-in cache hit is not counted and leaves no hold');
  NET.shortId['https://vm.tiktok.com/ZMxyz789/'] = key.slice(3);
  const n3 = net0();
  const sh = await appRead('U-1', 'https://vm.tiktok.com/ZMxyz789/');
  ok(sh.statusCode === 200 && sh.body.transcript === 'these are the spoken words' && NET.tikwm === n3.t + 1 && NET.download === n3.d && NET.groq === n3.g, '8f a signed-in short link: tikwm names the video, the cache answers (no download, no Whisper)');
  NET.dur = 200;
  const long = await appRead('U-1', 'https://www.tiktok.com/@alpha/video/9000000002');
  NET.dur = 30;
  ok(long.statusCode === 200, '8g the signed-in reader has no length cap (behaviour unchanged)');
}

// ── 9. never Apify ──
{
  NET.tikwmFail = true;
  const r = await tryRead(TTV());
  NET.tikwmFail = false;
  ok(r.statusCode === 502 && r.body.code === 'failed' && NET.apify === 0, '9a tikwm fails -> 502 failed, Apify NOT called (APIFY_API_TOKEN is set)');
  ok(NET.apify === 0, '9b no Apify call anywhere in this run (' + NET.apify + ')');
  ok(NET.cobalt === 0, '9c no cobalt call anywhere in this run (' + NET.cobalt + ')');
}

// ── 10. no raw IP stored or logged ──
{
  const V6a = '2001:db8:1:2::a', V6b = '2001:db8:1:2:ffff::b';
  let six = 0; for (const ip of [V6a, V6b, V6a, V6b]) if ((await tryRead(TTV(), { ip })).statusCode === 200) six++;
  ok(six === 3, '10a two addresses in one IPv6 /64 share one visitor\'s 3 reads (' + six + ')');
  IPS.push(V6a, V6b, '10.1.2.3');
  const stored = JSON.stringify([...SLOTS.values(), ...CACHE.values()]);
  const logs = LOGS.join('\n');
  const leakS = IPS.filter(ip => stored.includes(ip)), leakL = IPS.filter(ip => logs.includes(ip));
  ok(leakS.length === 0, '10b no IP appears in any stored row (' + leakS.slice(0, 3).join(',') + ')');
  ok(LOGS.length > 10 && leakL.length === 0, '10c no IP appears in any of ' + LOGS.length + ' log lines (' + leakL.slice(0, 3).join(',') + ')');
  ok([...SLOTS.values()].every(r => r.bucket === 'g' || r.bucket === 'gf' || /^[vhf]:[0-9a-f]{64}$/.test(r.bucket)), '10d visitor buckets are 64-hex hashes only');
  ok(TT.visitorHash('203.0.113.9', '2026-11-08') !== TT.visitorHash('203.0.113.9', '2026-11-09') && TT.visitorHash('203.0.113.9', '2026-11-08') !== TT.visitorHash('203.0.113.10', '2026-11-08'), '10e the hash changes with the day and the address');
  ok(!logs.includes('is_from_webapp') && !logs.includes('utm_source') && !logs.includes('_t=8kz'), '10f no log line carries a tracking parameter');
  ok(ALL_RES.every(r => !Object.keys(r.headers).some(k => /access-control-allow-origin/i.test(k))), '10g no response ever sends Access-Control-Allow-Origin');
}

// ── 12. failures ──
{
  // a) a silent video looped by a script: Groq is called ONCE
  NET.groqMode = 'empty';
  const url = TTV(), n = net0();
  const loop = []; for (let i = 0; i < 6; i++) loop.push(await tryRead(url + '&x=' + i));
  NET.groqMode = 'ok';
  ok(loop.every(r => r.statusCode === 422 && r.body.code === 'no_words') && NET.groq === n.g + 1 && NET.tikwm === n.t + 1, '12a a silent video asked 6 times -> no_words every time, tikwm and Groq called ONCE (' + (NET.groq - n.g) + ')');
  // b) too long, remembered
  NET.dur = 200; const lu = TTV(); const n2 = net0();
  const l1 = await tryRead(lu), l2 = await tryRead(lu);
  NET.dur = 30;
  ok(l1.body.code === 'too_long' && l2.body.code === 'too_long' && NET.tikwm === n2.t + 1, '12b too long, asked twice -> tikwm called once');
  const lg = [...SLOTS.values()].find(r => r.bucket === 'g' && r.video_id === 'tt:' + vid);
  ok(lg && lg.status === 'done' && lg.cost_eur === 0, '12c a failure after tikwm keeps its global slot; nothing was paid to Whisper, so cost 0');
  // d) removed / private, remembered; a provider hiccup is not
  NET.tikwmFail = true; const du = TTV(); const n3 = net0();
  const d1 = await tryRead(du), d2 = await tryRead(du);
  NET.tikwmFail = false;
  ok(d1.statusCode === 502 && d2.statusCode === 502 && d2.body.code === 'failed' && NET.tikwm === n3.t + 1 && MISSES.get('tt:' + vid).outcome === 'unavailable', '12d a private/removed TikTok asked twice -> tikwm called once');
  NET.groqMode = 'fail'; const tu = TTV(); const n4 = net0();
  await tryRead(tu); await tryRead(tu);
  NET.groqMode = 'ok';
  ok(NET.groq === n4.g + 2 && !MISSES.has('tt:' + vid), '12e Groq down is a hiccup, not the video: not remembered, tried again');
  const sv = (() => { const k = 'https://vm.tiktok.com/ZMdead99/'; NET.shortId[k] = loop.length && [...MISSES.keys()][0].slice(3); return k; })();
  const n5 = net0();
  const sm = await tryRead(sv, { ip: newIp() });
  ok(sm.statusCode === 422 && sm.body.code === 'no_words' && NET.download === n5.d && NET.groq === n5.g, '12f a short link to a remembered silent video: answered without download or Whisper');
  // g) the visitor's failure cap: 10 a day
  const FF = newIp();
  NET.groqMode = 'fail';
  let f502 = 0; for (let i = 0; i < 10; i++) if ((await tryRead(TTV(), { ip: FF })).statusCode === 502) f502++;
  NET.groqMode = 'ok';
  const n6 = net0();
  const f11 = await tryRead(TTV(), { ip: FF });
  ok(f502 === 10 && f11.statusCode === 429 && f11.body.code === 'limit_reached' && sameNet(n6) && PLAIN.test(f11.body.error), '12g after 10 failed reads in a day a visitor gets limit_reached, nothing fetched: ' + JSON.stringify(f11.body.error));
  // h) the global failure ceiling (env), and success does not touch it
  const gf0 = slotsOf('gf').length;
  const okr = await tryRead(TTV());
  ok(okr.statusCode === 200 && slotsOf('gf').length === gf0, '12h a successful read hands its failure slots back');
  process.env.TRY_DAILY_FAILURES = String(gf0 + 2);
  NET.groqMode = 'fail';
  const h1 = await tryRead(TTV()), h2 = await tryRead(TTV());
  const n7 = net0();
  const h3 = await tryRead(TTV());
  NET.groqMode = 'ok';
  delete process.env.TRY_DAILY_FAILURES;
  ok(h1.statusCode === 502 && h2.statusCode === 502 && h3.statusCode === 503 && h3.body.code === 'busy' && sameNet(n7), '12i the global failure ceiling reached -> 503 busy, nothing fetched');
  // i) default ceiling 200
  ok(TT.globalFailCap() === 200, '12j the global failure ceiling is 200 a day by default');
  const taken = new Set(slotsOf('gf').map(r => r.slot)), added = [];
  for (let i = 1; i <= 200 && taken.size + added.length < 200; i++) if (!taken.has(i)) { const k = today() + '|gf|' + i; SLOTS.set(k, { day: today(), bucket: 'gf', slot: i, status: 'done', token: 'fill', held_at: iso(Date.now()), done_at: iso(Date.now()), cost_eur: 0, video_id: null }); added.push(k); }
  const n8 = net0();
  const full = await tryRead(TTV());
  ok(full.statusCode === 503 && full.body.code === 'busy' && sameNet(n8), '12k 200 failures today -> busy by default, nothing fetched');
  for (const k of added) SLOTS.delete(k);
  // j) no salt -> refuse
  const salt = process.env.SUPABASE_SERVICE_ROLE_KEY; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const s0 = SLOTS.size, n9 = net0();
  const ns = await tryRead(TTV()), nsHit = await tryRead('https://www.tiktok.com/@alpha/video/9000000001');
  process.env.SUPABASE_SERVICE_ROLE_KEY = salt;
  ok(ns.statusCode === 503 && ns.body.code === 'busy' && nsHit.statusCode === 503 && SLOTS.size === s0 && sameNet(n9), '12l no server salt -> 503 busy (even for a cached video), nothing fetched or stored');
}

// ── 11. the store down -> fail closed ──
{
  STORE.failSlots = true;
  const n = net0();
  const r = await tryRead(TTV());
  STORE.failSlots = false;
  ok(r.statusCode === 503 && r.body.code === 'busy' && sameNet(n), '11a slots unreadable -> 503 busy, nothing fetched (fail closed: this endpoint spends our money)');
  STORE.failG = true;
  const W = newIp();
  const r2 = await tryRead(TTV(), { ip: W });
  STORE.failG = false;
  ok(r2.statusCode === 503 && r2.body.code === 'busy' && sameNet(n) && slotsOf('v:' + TT.visitorHash(W, today())).length === 0, '11b only the global count unreadable -> busy, nothing fetched, visitor slot handed back');
}

{ // the IP scan again, over everything the whole run stored and logged
  const stored = JSON.stringify([...SLOTS.values(), ...CACHE.values(), ...MISSES.values()]), logs = LOGS.join('\n');
  ok(IPS.every(ip => !stored.includes(ip) && !logs.includes(ip)), '13 end of run: no IP in any stored row or any of ' + LOGS.length + ' log lines');
}
clearTimeout(WALL);
REAL.log(failed ? 'FAIL: try-transcript-v722 (' + failed + ' failed, ' + passed + ' passed)' : 'PASS: try-transcript-v722 (' + passed + ' checks)');
process.exit(failed ? 1 : 0);
