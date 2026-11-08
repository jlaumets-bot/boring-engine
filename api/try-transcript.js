// v722 — POST /api/try-transcript: the PUBLIC landing-page reader (.unlazy/landing/CONTRACT.md). NO sign-in.
// A TikTok / YouTube link in -> its exact spoken words out. NO AI writing anywhere: the words come from
// api/transcribe-url.js transcribeVideo (tikwm, or cobalt for YouTube, then Groq Whisper) — the same SSRF-safe
// fetchers, time budget and byte caps the signed-in reader uses. NEVER Apify (apifyFallback: false).
// YOUTUBE reads its CAPTIONS instead (api/transcribe.js youtubeCaptions — the app's own YouTube path; cobalt is
// broken in production). Captions cost no paid API (cost_eur 0) but still take a visitor and a global slot.
//
// WHAT BOUNDS THE COST OF AN ENDPOINT ANYONE CAN CALL
//   * per visitor: VISITOR_DAILY successful reads per UTC day. visitor = SHA-256(server-side salt, IP, UTC date).
//     Only the hash is stored; the IP never leaves this request (not stored, not logged). IPv6 counts per /64.
//   * global: TRY_DAILY_GLOBAL (env, default DEFAULT_GLOBAL_DAILY = 300) successful reads per UTC day, everyone.
//   * length: over MAX_SEC is refused — from tikwm's metadata BEFORE the download when it has one, otherwise from
//     the downloaded file's own header (MP4 'mvhd' / MP3 frames) BEFORE Whisper is paid.
//   * cache by video id (try_transcript_cache, also filled and read by /api/transcribe-url): one video never costs
//     twice. A hit is instant, free and outside the caps (its own generous HIT_DAILY per visitor).
//   * same origin only: Origin (or, without one, Referer) must be contentshrimp.com or this deployment's own host.
//     No Access-Control-Allow-Origin header is ever sent.
//
// CAPS ARE SLOTS, NOT COUNTS (the v712 lesson: parallel requests must not slip past a count).
// try_read_slots has PRIMARY KEY (day, bucket, slot). A read first INSERTS one free slot number in its visitor
// bucket ('v:<hash>') and one in the global bucket ('g'). The database refuses a second row with the same number
// (409), so at most `cap` rows can ever exist per bucket per day: a burst of 50 parallel requests gets exactly what
// is left, reads still in flight included. A slot is 'held' while its read runs. On success the visitor and global
// slots turn 'done'. On a failure BEFORE any provider call every slot is deleted. On a failure AFTER one, the visitor's
// success slot goes back (3 SUCCESSFUL reads a day), but the global slot stays (with its real cost), the failure is
// counted in 'f:<hash>' (10/day) and 'gf' (200/day), and a failure caused by the video itself (no words, too long,
// private/removed) is remembered for 24 h in try_transcript_misses and answered free from there. A 'held' slot older than HOLD_TTL_MS was left by a killed function
// and is taken over by a conditional PATCH (only one taker can match it).
// USAGE RECORD: anonymous reads have no user for usage_events, so the global 'done' row IS the usage record — it
// carries video_id and cost_eur (ACTION_COST.transcribeurl). Daily spend = sum(cost_eur) where bucket = 'g'.
const crypto = require('crypto');
const net = require('net');
const store = require('./_publish/store');
const TU = require('./transcribe-url');
const TR = require('./transcribe');
const { ACTION_COST } = require('./_usage');

const VISITOR_DAILY = 3;
const HIT_DAILY = 30;                       // cache hits per visitor per UTC day (free, but not unlimited)
const DEFAULT_GLOBAL_DAILY = 300;
const VISITOR_FAIL_DAILY = 10;              // failed reads per visitor per UTC day (a dead video looped by a script)
const DEFAULT_GLOBAL_FAIL_DAILY = 200;      // failed reads per UTC day, everyone (TRY_DAILY_FAILURES)
const MISS_TTL_MS = 24 * 3600 * 1000;       // a video that failed for its own reason is remembered this long
const MAX_SEC = 180;
const LENGTH_SLACK_SEC = 5;                 // a header estimate (CBR MP3) can be a few seconds off
const UNKNOWN_LENGTH_MAX_BYTES = 4 * 1024 * 1024;   // no length anywhere: ~4 min of 128 kbps audio, refuse above
const HOLD_TTL_MS = 5 * 60 * 1000;          // > vercel.json maxDuration (120 s): a live read is never taken over
const BUDGET_MS = 100000;                   // transcribeVideo deadline; the 120 s platform cap leaves 20 s for the slots
const MAX_TRANSCRIPT_CHARS = 100000;
const COST_EUR = Number(ACTION_COST && ACTION_COST.transcribeurl) || 0.06;
const COST_CAPTIONS_EUR = 0;                // YouTube captions: no paid API (still counted in the caps)
const SITE_ORIGINS = ['https://contentshrimp.com', 'https://www.contentshrimp.com'];
const KEY_RE = /^(tt:\d{5,25}|yt:[A-Za-z0-9_-]{11})$/;

const MSG = {
  bad_link: 'Paste a TikTok or YouTube video link.',
  too_long: 'That video is longer than 3 minutes. Try a shorter one.',
  limit_reached: "You've read 3 videos today. Sign up free to keep going, or come back tomorrow.",
  busy: "We've hit today's limit for free reads. Sign up free to keep going, or try again tomorrow.",
  no_words: "We couldn't hear any spoken words in that video. Try another one.",
  no_captions: "That YouTube video has no captions we can read. Try a TikTok link, or a video with subtitles.",
  failed: "We couldn't read that video right now. Check the link opens, then try again.",
  fail_limit: "We couldn't read several of your videos today. Sign up free to keep going, or come back tomorrow.",
  origin: 'This reader only works on contentshrimp.com.',
  method: 'Send the link with POST.',
};

const enc = encodeURIComponent;
const ok2 = (r) => !!r && r.status >= 200 && r.status < 300;
const coded = (c) => { const e = new Error(c); e.tryCode = c; return e; };
const utcDay = (ms) => new Date(ms == null ? Date.now() : ms).toISOString().slice(0, 10);
function secondsToUtcMidnight() {
  const now = Date.now();
  return Math.max(60, Math.ceil((Date.parse(utcDay(now) + 'T00:00:00.000Z') + 86400000 - now) / 1000));
}
function globalFailCap() {
  const raw = process.env.TRY_DAILY_FAILURES;
  const n = raw == null || raw === '' ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 1000 ? n : DEFAULT_GLOBAL_FAIL_DAILY;
}
function globalCap() {
  const raw = process.env.TRY_DAILY_GLOBAL;
  const n = raw == null || raw === '' ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 1000 ? n : DEFAULT_GLOBAL_DAILY;
}
async function sb(method, path, opts) {
  try { return await store.rest(method, path, opts); }
  catch (e) { console.error('try-transcript: supabase ' + method + ' ' + path.split('?')[0] + ' failed — ' + ((e && e.message) || e)); return null; }
}

// ── the link ─────────────────────────────────────────────────────────────────
// Same host rule as the app's link detection (app.html remixDetectKind, api/creator-feed.js tiktokLink): the HOST
// decides — (any.)tiktok.com, (any.)youtube.com, youtu.be — never a word in a query string. http(s) only, no
// credentials, no odd port. The link is rebuilt from its id, so tracking parameters never travel on (or into logs).
// -> { platform, key ('tt:<id>' | 'yt:<id>' | null for a TikTok short link), url (clean) } | null
function parseLink(raw) {
  let t = String(raw == null ? '' : raw).trim();
  if (!t || t.length > 2048) return null;
  if (/\s/.test(t)) {   // a share sheet's "caption … https://vm.tiktok.com/…/": the first link wins
    const tok = t.split(/\s+/).find((x) => /^https?:\/\//i.test(x));
    if (!tok) return null;
    t = tok.replace(/[)\].,!?'"»”]+$/, '');
  }
  if (!/^https?:\/\//i.test(t)) return null;
  let u;
  try { u = new URL(t); } catch (e) { return null; }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase().replace(/\.+$/, '');
  if (/(^|\.)tiktok\.com$/.test(host)) {
    const m = /^\/@([\w.\-]{1,60})\/(video|photo)\/(\d{5,25})(?:\/|$)/.exec(u.pathname);
    if (m) return { platform: 'tiktok', key: 'tt:' + m[3], url: 'https://www.tiktok.com/@' + m[1] + '/' + m[2] + '/' + m[3] };
    if (/^(vm|vt)\.tiktok\.com$/.test(host)) {
      const s = /^\/([A-Za-z0-9]{4,20})\/?$/.exec(u.pathname);
      return s ? { platform: 'tiktok', key: null, url: 'https://' + host + '/' + s[1] + '/' } : null;
    }
    const t2 = /^\/t\/([A-Za-z0-9]{4,20})\/?$/.exec(u.pathname);
    return t2 ? { platform: 'tiktok', key: null, url: 'https://www.tiktok.com/t/' + t2[1] + '/' } : null;
  }
  if (/(^|\.)youtube\.com$/.test(host) || host === 'youtu.be') {
    let id = null;
    if (host === 'youtu.be') id = (/^\/([A-Za-z0-9_-]{11})(?:\/|$)/.exec(u.pathname) || [])[1];
    else if (u.pathname === '/watch') id = u.searchParams.get('v');
    else id = (/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})(?:\/|$)/.exec(u.pathname) || [])[1];
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
    return { platform: 'youtube', key: 'yt:' + id, url: 'https://www.youtube.com/watch?v=' + id };
  }
  return null;
}
// The cache key a link names on its own (null = only the provider can tell, e.g. vm.tiktok.com/xyz).
function videoKey(url) { const l = parseLink(url); return l ? l.key : null; }

// ── same origin ──────────────────────────────────────────────────────────────
function sameOrigin(req) {
  const h = (req && req.headers) || {};
  const allowed = new Set(SITE_ORIGINS);
  const host = String(h['x-forwarded-host'] || h.host || '').split(',')[0].trim().toLowerCase();
  if (/^[a-z0-9.\-]+(:\d{1,5})?$/.test(host)) allowed.add('https://' + host);
  const o = String(h.origin || '').trim().toLowerCase();
  if (o) return allowed.has(o);
  const r = String(h.referer || '').trim();
  if (!r) return false;
  try { return allowed.has(new URL(r).origin.toLowerCase()); } catch (e) { return false; }
}

// ── the visitor (a salted daily hash; the IP itself is never kept) ──────────
function clientIp(req) {
  const h = (req && req.headers) || {};
  const xf = String(h['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || String(h['x-real-ip'] || '').trim() || String((req && req.socket && req.socket.remoteAddress) || '');
}
function expand6(s) {
  if (s.includes('.')) return null;
  const halves = s.toLowerCase().split('::');
  if (halves.length > 2) return null;
  const a = halves[0] ? halves[0].split(':') : [];
  const b = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - a.length - b.length : 0;
  if (fill < 0) return null;
  const w = a.concat(new Array(fill).fill('0'), b);
  return w.length === 8 && w.every((x) => /^[0-9a-f]{1,4}$/.test(x)) ? w.map((x) => parseInt(x, 16).toString(16)) : null;
}
// One phone or home network owns a whole IPv6 /64, so per-address caps would be free to dodge: IPv6 counts per /64.
function ipKey(ip) {
  let s = String(ip == null ? '' : ip).trim().replace(/^\[|\]$/g, '').split('%')[0];
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(s)) s = s.slice(7);
  if (net.isIPv4(s)) return s;
  if (net.isIPv6(s)) { const w = expand6(s); return w ? w.slice(0, 4).join(':') + '::/64' : s.toLowerCase(); }
  return 'unknown';
}
// Salt = a server-only secret that already exists (used by NAME only, never logged). Missing -> null, and the
// handler refuses to serve: a guessable constant salt would make the stored hashes reversible to IPs.
function visitorHash(ip, day) {
  const salt = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!salt) return null;
  return crypto.createHash('sha256').update(salt + '\n' + ipKey(ip) + '\n' + day).digest('hex');
}

// ── slots ────────────────────────────────────────────────────────────────────
// -> { day, bucket, slot, token } | null when the bucket is full. Throws when the store cannot answer.
// LOWEST FREE NUMBER FIRST, never a random one: numbers stay dense (1..rows), so every row sits at or under the cap
// and the primary key alone bounds the bucket — also on the day TRY_DAILY_GLOBAL is lowered. In a burst the losers
// of a number simply try the next one (409), and re-read after SLOT_TRIES collisions.
const SLOT_TRIES = 25, SLOT_ROUNDS = 3;
async function claimSlot(day, bucket, cap, opts) {
  const o = opts || {};
  const status = o.done ? 'done' : 'held';
  const token = crypto.randomBytes(8).toString('hex');
  const base = '/try_read_slots?day=eq.' + enc(day) + '&bucket=eq.' + enc(bucket);
  for (let round = 0; round < SLOT_ROUNDS; round++) {
    const r = await sb('GET', base + '&select=slot,status,held_at&order=slot.asc&limit=' + (cap + 50));
    if (!ok2(r) || !Array.isArray(r.data)) throw new Error('slot read failed (' + (r ? r.status : 'no response') + ')');
    const taken = new Set(r.data.map((x) => Number(x && x.slot)));
    const free = [];
    // rows numbered above a lowered cap still count: never more rows than the cap
    if (r.data.length < cap) for (let i = 1; i <= cap; i++) if (!taken.has(i)) free.push(i);
    const now = new Date().toISOString();
    const row = (slot) => ({ day, bucket, slot, status, token, held_at: now, done_at: o.done ? now : null });
    for (const slot of free.slice(0, SLOT_TRIES)) {
      const ins = await sb('POST', '/try_read_slots', { body: row(slot), headers: { Prefer: 'return=minimal' } });
      if (ok2(ins)) return { day, bucket, slot, token };
      if (ins && ins.status === 409) continue;   // someone else took this number first
      throw new Error('slot insert failed (' + (ins ? ins.status : 'no response') + ')');
    }
    // Full of numbers — but a 'held' one older than HOLD_TTL_MS belongs to a function that was killed.
    const staleIso = new Date(Date.now() - HOLD_TTL_MS).toISOString();
    const stale = r.data.filter((x) => x && x.status === 'held' && Number(x.slot) <= cap && Date.parse(x.held_at) < Date.parse(staleIso));
    for (const x of stale.slice(0, 3)) {
      const p = await sb('PATCH', base + '&slot=eq.' + Number(x.slot) + '&status=eq.held&held_at=lt.' + enc(staleIso),
        { body: { status, token, held_at: now, done_at: o.done ? now : null }, headers: { Prefer: 'return=representation' } });
      if (ok2(p) && Array.isArray(p.data) && p.data.length) return { day, bucket, slot: Number(x.slot), token };
    }
    if (!free.length) return null;
  }
  return null;   // every free number collided SLOT_ROUNDS times in a row: crowded right now, answer as full
}
const slotPath = (s) => '/try_read_slots?day=eq.' + enc(s.day) + '&bucket=eq.' + enc(s.bucket) + '&slot=eq.' + Number(s.slot) + '&token=eq.' + enc(s.token);
async function releaseSlot(s) {
  if (!s) return;
  const r = await sb('DELETE', slotPath(s));
  if (!ok2(r)) console.error('try-transcript: a ' + (s.bucket === 'g' ? 'global' : 'visitor') + ' slot could not be handed back — it frees itself after ' + Math.round(HOLD_TTL_MS / 60000) + ' min');
}
async function settleSlot(s, extra) {
  if (!s) return;
  const r = await sb('PATCH', slotPath(s), { body: Object.assign({ status: 'done', done_at: new Date().toISOString() }, extra || {}), headers: { Prefer: 'return=minimal' } });
  if (!ok2(r)) console.error('try-transcript: a finished read could not be marked done (' + (r ? r.status : 'no response') + ') — it stays counted until its hold expires');
}

// ── the cache (shared with /api/transcribe-url) ─────────────────────────────
const cleanCreator = (v) => { const s = String(v == null ? '' : v).replace(/[^\w.\-]/g, '').slice(0, 60); return s || null; };
async function cacheGet(key) {
  if (!KEY_RE.test(String(key || ''))) return null;
  const r = await sb('GET', '/try_transcript_cache?video_id=eq.' + enc(key) + '&select=video_id,transcript,creator,duration_sec&limit=1');
  const row = ok2(r) && Array.isArray(r.data) ? r.data[0] : null;
  return row && typeof row.transcript === 'string' && row.transcript.trim() ? row : null;
}
// Never throws; false = not stored (logged).
async function cachePut(key, v) {
  if (!KEY_RE.test(String(key || '')) || !v || typeof v.transcript !== 'string' || !v.transcript.trim()) return false;
  const d = Number(v.durationSec);
  const body = {
    video_id: key, transcript: v.transcript.trim().slice(0, MAX_TRANSCRIPT_CHARS), creator: cleanCreator(v.creator),
    duration_sec: Number.isFinite(d) && d > 0 ? Math.round(d) : null, source: v.source === 'app' ? 'app' : 'try',
    updated_at: new Date().toISOString(),
  };
  const r = await sb('POST', '/try_transcript_cache?on_conflict=video_id', { body, headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
  if (!ok2(r)) { console.error('try-transcript: transcript for ' + key + ' not cached (' + (r ? r.status : 'no response') + ')'); return false; }
  return true;
}

// ── failures remembered for MISS_TTL_MS (try_transcript_misses): no_words / no_captions / too_long / unavailable.
// Read only by this endpoint; a transient provider error is never remembered.
const MISS_OUTCOMES = new Set(['no_words', 'no_captions', 'too_long', 'unavailable']);
async function missGet(key) {
  if (!KEY_RE.test(String(key || ''))) return null;
  const r = await sb('GET', '/try_transcript_misses?video_id=eq.' + enc(key) + '&created_at=gt.' + enc(new Date(Date.now() - MISS_TTL_MS).toISOString()) + '&select=outcome&limit=1');
  const row = ok2(r) && Array.isArray(r.data) ? r.data[0] : null;
  return row && MISS_OUTCOMES.has(row.outcome) ? row.outcome : null;
}
async function missPut(key, outcome) {
  if (!KEY_RE.test(String(key || '')) || !MISS_OUTCOMES.has(outcome)) return false;
  const r = await sb('POST', '/try_transcript_misses?on_conflict=video_id', { body: { video_id: key, outcome, created_at: new Date().toISOString() },
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
  if (!ok2(r)) { console.error('try-transcript: failure for ' + key + ' not remembered (' + (r ? r.status : 'no response') + ')'); return false; }
  return true;
}

// ── the audio's own length (when no metadata said it) ───────────────────────
function mp3Seconds(buf) {
  let off = 0;
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') off = 10 + (((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f));
  const lim = Math.min(buf.length - 4, off + 65536);
  for (let i = off; i < lim; i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
    const ver = (buf[i + 1] >> 3) & 3, layer = (buf[i + 1] >> 1) & 3, bri = buf[i + 2] >> 4, sri = (buf[i + 2] >> 2) & 3;
    if (ver === 1 || layer !== 1 || bri === 0 || bri === 15 || sri === 3) continue;   // Layer III frames only
    const kbps = (ver === 3 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160])[bri];
    const rate = ({ 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] })[ver][sri];
    const spf = ver === 3 ? 1152 : 576;
    const mono = (buf[i + 3] >> 6) === 3;
    const xo = i + 4 + (ver === 3 ? (mono ? 17 : 32) : (mono ? 9 : 17));
    if (xo + 12 <= buf.length) {
      const tag = buf.toString('latin1', xo, xo + 4);
      if ((tag === 'Xing' || tag === 'Info') && (buf[xo + 7] & 1)) { const frames = buf.readUInt32BE(xo + 8); if (frames > 0) return frames * spf / rate; }
    }
    return (buf.length - i) * 8 / (kbps * 1000);
  }
  return null;
}
// Seconds of media in a downloaded file, or null when its format is not one we can read.
function audioSeconds(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
  const i = buf.indexOf('mvhd');          // MP4 / MOV movie header: timescale + duration
  if (i >= 4 && buf.length >= i + 24) {
    const v = buf[i + 4];
    let ts = 0, du = -1;
    if (v === 0) { ts = buf.readUInt32BE(i + 16); du = buf.readUInt32BE(i + 20); }
    else if (v === 1 && buf.length >= i + 36) { ts = buf.readUInt32BE(i + 24); du = Number(buf.readBigUInt64BE(i + 28)); }
    if (ts > 0 && du >= 0) return du / ts;
  }
  return mp3Seconds(buf);
}

// ── the handler ──────────────────────────────────────────────────────────────
function fail(res, status, code, error, retryTomorrow) {
  if (retryTomorrow) { try { res.setHeader('Retry-After', String(secondsToUtcMidnight())); } catch (e) {} }
  return res.status(status).json({ error, code });
}
const hitBody = (row) => ({ ok: true, transcript: row.transcript, creator: row.creator || null,
  durationSec: Number.isFinite(Number(row.duration_sec)) && row.duration_sec != null ? Number(row.duration_sec) : null,
  videoId: row.video_id, cached: true });
// A remembered failure (or a fresh one) -> its answer. Same codes and words either way.
function missAnswer(res, outcome) {
  if (outcome === 'too_long') return fail(res, 422, 'too_long', MSG.too_long);
  if (outcome === 'no_words') return fail(res, 422, 'no_words', MSG.no_words);
  if (outcome === 'no_captions') return fail(res, 422, 'no_words', MSG.no_captions);
  return fail(res, 502, 'failed', MSG.failed);   // 'unavailable'
}
// Cache hits AND remembered failures are free (no provider call) but not unlimited: HIT_DAILY a visitor a day.
async function freeAnswer(res, day, vh, send) {
  let hs = 'unknown';
  try { hs = await claimSlot(day, 'h:' + vh, HIT_DAILY, { done: true }); } catch (e) { /* a free answer fails open */ }
  if (hs === null) return fail(res, 429, 'limit_reached', MSG.limit_reached, true);
  return send();
}

async function handler(req, res) {
  const t0 = Date.now();
  try { res.setHeader('Cache-Control', 'no-store'); } catch (e) {}
  if (!sameOrigin(req)) return fail(res, 403, 'failed', MSG.origin);
  if (req.method !== 'POST') { try { res.setHeader('Allow', 'POST'); } catch (e) {} return fail(res, 405, 'failed', MSG.method); }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const link = parseLink(body && typeof body === 'object' ? body.url : null);
  if (!link) return fail(res, 400, 'bad_link', MSG.bad_link);

  const day = utcDay();
  const vh = visitorHash(clientIp(req), day);
  if (!vh) { console.error('try-transcript: no server salt (SUPABASE_SERVICE_ROLE_KEY) — refusing to serve'); return fail(res, 503, 'busy', MSG.busy); }
  const tag = 'v=' + vh.slice(0, 8);      // all a log line ever says about who asked

  // 1. Cached words, or a failure remembered for 24 h: instant and free — outside the read caps.
  if (link.key) {
    const hit = await cacheGet(link.key);
    if (hit) return freeAnswer(res, day, vh, () => res.status(200).json(hitBody(hit)));
    const miss = await missGet(link.key);
    if (miss) return freeAnswer(res, day, vh, () => missAnswer(res, miss));
  }

  // 2. The SSRF guard on the cleaned link (transcribeVideo re-checks every provider hop and the media URL).
  try { await require('./_safeurl').assertPublicHttpUrl(link.url); }
  catch (e) { return e && e.code === 'UNRESOLVED' ? fail(res, 502, 'failed', MSG.failed) : fail(res, 400, 'bad_link', MSG.bad_link); }

  // 3. Four slots, all race-safe, all BEFORE any provider call (a store failure = fail CLOSED: this spends money):
  //    v = the visitor's successful reads (3), f = the visitor's failed reads (10), gf = everyone's failed reads
  //    (200), g = everyone's paid attempts (300). The f/gf slots are handed back when the read succeeds.
  const held = {};
  const giveBack = async (names) => { await Promise.all(names.map((n) => releaseSlot(held[n]))); for (const n of names) held[n] = null; };
  const plan = [
    ['v', 'v:' + vh, VISITOR_DAILY, 'limit_reached'], ['f', 'f:' + vh, VISITOR_FAIL_DAILY, 'fail_limit'],
    ['gf', 'gf', globalFailCap(), 'busy'], ['g', 'g', globalCap(), 'busy'],
  ];
  for (const [name, bucket, cap, whenFull] of plan) {
    let s = null, broken = false;
    try { s = await claimSlot(day, bucket, cap); }
    catch (e) { broken = true; console.error('try-transcript: ' + name + ' slot unavailable — ' + ((e && e.message) || e)); }
    if (!s) {
      await giveBack(Object.keys(held));
      if (broken) return fail(res, 503, 'busy', MSG.busy);
      console.log('try-transcript: ' + whenFull + ' (' + name + ') ' + tag);
      if (whenFull === 'limit_reached') return fail(res, 429, 'limit_reached', MSG.limit_reached, true);
      if (whenFull === 'fail_limit') return fail(res, 429, 'limit_reached', MSG.fail_limit, true);
      return fail(res, 503, 'busy', MSG.busy, true);
    }
    held[name] = s;
  }

  // 4. The read. Transcript only — no AI writer, no Apify. From here a provider IS called, so a failure keeps its
  //    global slot (its cost is real) and its failure slots; only the visitor's success slot (v) goes back.
  const st = { meta: null, whisper: false, key: link.key };
  const settleFailure = async (outcome) => {
    const key = (st.meta && st.meta.videoKey) || link.key || null;
    await Promise.all([
      settleSlot(held.g, { video_id: key, cost_eur: st.whisper ? COST_EUR : 0 }),
      settleSlot(held.f, { video_id: key }), settleSlot(held.gf, { video_id: key }), releaseSlot(held.v)]);
    if (key && outcome) await missPut(key, outcome);
  };
  try {
    if (link.platform === 'youtube') return await youtubeRead(res, link, held, settleFailure, giveBack, tag, t0);
    const transcript = await TU.transcribeVideo(link.url, {
      deadline: t0 + BUDGET_MS,
      apifyFallback: false,
      onMeta: async (m) => {
        st.meta = m || null;
        if (m && Number(m.durationSec) > MAX_SEC) throw coded('too_long');
        if (m && m.videoKey && m.videoKey !== link.key) {
          const hit = await cacheGet(m.videoKey);
          if (hit) { const e = coded('cached'); e.hit = hit; throw e; }
          const miss = await missGet(m.videoKey);
          if (miss) { const e = coded('missed'); e.outcome = miss; throw e; }
        }
      },
      beforeTranscribe: async (buf) => {
        const sec = audioSeconds(buf);
        if (sec != null ? sec > MAX_SEC + LENGTH_SLACK_SEC
          : (!(st.meta && Number(st.meta.durationSec) > 0) && buf && buf.length > UNKNOWN_LENGTH_MAX_BYTES)) throw coded('too_long');
        st.whisper = true;                  // Whisper is called next: this attempt costs money
      },
    });
    const words = String(transcript == null ? '' : transcript).trim();
    if (!words) throw coded('no_words');
    const key = (st.meta && st.meta.videoKey) || link.key || '';
    const creator = cleanCreator(st.meta && st.meta.creator);
    const durationSec = st.meta && Number(st.meta.durationSec) > 0 ? Math.round(Number(st.meta.durationSec)) : null;
    await Promise.all([settleSlot(held.v, { video_id: key || null }), settleSlot(held.g, { video_id: key || null, cost_eur: COST_EUR })]);
    await giveBack(['f', 'gf']);            // it worked: not a failure
    if (key) await cachePut(key, { transcript: words, creator, durationSec, source: 'try' });
    console.log('try-transcript: read ok ' + tag + ' ' + (key || link.platform) + ' in ' + (Date.now() - t0) + 'ms');
    return res.status(200).json({ ok: true, transcript: words, creator, durationSec, videoId: key, cached: false });
  } catch (err) {
    // A short link that turned out to be a known video is a cache answer: nothing was paid, every slot goes back.
    if (err && (err.tryCode === 'cached' || err.tryCode === 'missed')) {
      await giveBack(Object.keys(held));
      return err.tryCode === 'cached' ? res.status(200).json(hitBody(err.hit)) : missAnswer(res, err.outcome);
    }
    if (err && err.tryCode === 'too_long') { await settleFailure('too_long'); console.log('try-transcript: too_long ' + tag); return missAnswer(res, 'too_long'); }
    if (err && (err.tryCode === 'no_words' || err.noWords)) { await settleFailure('no_words'); return missAnswer(res, 'no_words'); }
    // Remembered only when the video itself is the problem (private / removed); a provider hiccup is not.
    await settleFailure(err && err.unavailable ? 'unavailable' : null);
    console.error('try-transcript: read failed ' + tag + ' ' + (link.key || link.platform) + ' — ' + String((err && err.message) || err).slice(0, 160));
    return fail(res, 502, 'failed', MSG.failed);
  }
}

// YouTube: the captions the app reads (api/transcribe.js), never cobalt/Whisper. Slots are already held.
async function youtubeRead(res, link, held, settleFailure, giveBack, tag, t0) {
  let cap;
  try { cap = await TR.youtubeCaptions(link.key.slice(3)); }
  catch (e) {
    if (e && e.httpStatus === 400) { await settleFailure('no_captions'); return missAnswer(res, 'no_captions'); }
    await settleFailure(null);              // a provider hiccup: counted as a failure, not remembered
    console.error('try-transcript: captions failed ' + tag + ' ' + link.key + ' — ' + String((e && e.message) || e).slice(0, 160));
    return fail(res, 502, 'failed', MSG.failed);
  }
  const words = String((cap && cap.text) || '').trim();
  const len = Number(cap && cap.lengthSec);
  if (Number.isFinite(len) && len > MAX_SEC + LENGTH_SLACK_SEC) {
    await settleFailure('too_long');
    console.log('try-transcript: too_long ' + tag);
    return missAnswer(res, 'too_long');
  }
  if (!words) { await settleFailure('no_captions'); return missAnswer(res, 'no_captions'); }
  const durationSec = Number.isFinite(len) && len > 0 ? Math.round(len) : null;
  await Promise.all([settleSlot(held.v, { video_id: link.key }), settleSlot(held.g, { video_id: link.key, cost_eur: COST_CAPTIONS_EUR })]);
  await giveBack(['f', 'gf']);
  await cachePut(link.key, { transcript: words, creator: null, durationSec, source: 'try' });
  console.log('try-transcript: read ok ' + tag + ' ' + link.key + ' (captions) in ' + (Date.now() - t0) + 'ms');
  return res.status(200).json({ ok: true, transcript: words, creator: null, durationSec, videoId: link.key, cached: false });
}

module.exports = handler;
Object.assign(module.exports, {
  parseLink, videoKey, sameOrigin, ipKey, visitorHash, claimSlot, cacheGet, cachePut, missGet, audioSeconds, globalCap, globalFailCap,
  VISITOR_DAILY, HIT_DAILY, DEFAULT_GLOBAL_DAILY, VISITOR_FAIL_DAILY, DEFAULT_GLOBAL_FAIL_DAILY, MAX_SEC, HOLD_TTL_MS, COST_EUR,
});
