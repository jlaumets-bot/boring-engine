// v711 — CREATOR FEED: the newest TikTok videos of the creators a brand follows, for the top of Remix.
// Contract: .unlazy/creator-feed/CONTRACT.md (the API shape is fixed there; "## Server notes" has the rest).
//
// WHERE THE CREATORS COME FROM: the brand's bookmarks — ONE row in `competitors` with name '__bookmarks__'
// whose `notes` is the JSON of app.html's bookmarkCategories ([{id,name,entries:[{id,name,links:{tt,ig,..},
// note}]}], saveBookmarksToDB / loadBookmarksFromDB). Read here with the service role AFTER the
// owner-or-member check. TikTok only, max 5, deduplicated; the handle comes from a profile or video link
// (tiktok.com/@name or tiktok.com/@name/video/123), the same rule as app.html fpProfileUrl.
//
// WHERE THE VIDEOS COME FROM: ONE Apify run of clockworks~tiktok-profile-scraper for all handles
// (~10 newest each, no video download, no comments, no date/popularity filter — those are paid add-ons).
// $0.003 per result, so a full pull is about $0.15. The free tikwm user-posts API is Cloudflare-blocked.
//
// COST GUARDS (this file is the authority, never the client):
//   'list'    pulls only when there is no pull yet, or the last one is older than 24 h;
//   'refresh' pulls only when the last pull is older than 6 h;
//   a failed pull waits 30 min, and 6 h once 2 pulls in a row failed; an Apify run is never bought twice —
//   one we stopped waiting for, or one that SUCCEEDED but whose videos could not be read or saved, is
//   checked and re-read by the next pull (for 24 h); its cost is logged once, when it is seen SUCCEEDED;
//   one pull per brand at a time (creator_feed_state.lock_until, expires by itself);
//   a non-paying owner over the cost fuse gets the cache only. The pull is logged as 'creatorfeed'
//   (0 credits, its real cost in ACTION_COST), so the spend shows in usage_events and the fuse.
// TRANSCRIPTS: cached = free. Each video is claimed atomically ('working') before any transcriber runs, so a
//   double tap never charges twice and a failure never overwrites a finished transcript. A new one uses transcribe-url's own pipeline (tikwm -> Groq Whisper) and
//   logs 'transcribeurl' ONLY when words came back (v712: 0 credits, counted toward the daily read cap, the paid
//   Apify fallback capped per day). After a pull, up to 2
//   "winners" (score >= 2, posted <= 14 days ago) are transcribed for free, at most 3 tries per brand per
//   ISO week, and only while the request still has time.
// Storage: sql/creator-feed.sql (creator_videos + creator_feed_state, both server-written only).
'use strict';
const https = require('https');
const { StringDecoder } = require('string_decoder');
const store = require('./_publish/store');
const usage = require('./_usage');

const ACTOR = 'clockworks~tiktok-profile-scraper';
const PULL_ACTION = 'creatorfeed';
const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const C = {
  MAX_CREATORS: 5,
  PER_CREATOR: 10,
  MAX_VIDEOS: 50,
  LIST_STALE_MS: 24 * HOUR,
  REFRESH_GAP_MS: 6 * HOUR,
  FAIL_BACKOFF_MS: 30 * 60 * 1000,
  FAIL_LONG_BACKOFF_MS: 6 * HOUR,  // once FAIL_LONG_AFTER pulls in a row have failed
  FAIL_LONG_AFTER: 2,
  LOCK_MS: 200000,                 // > maxDuration 180 (vercel.json): a killed function frees the brand by itself
  PENDING_RUN_MAX_MS: 20 * 60 * 1000,
  RUN_KEEP_MS: 24 * HOUR,          // a run already paid for is re-read (never re-bought) for this long
  WORKING_STALE_MS: 3 * 60 * 1000, // a transcript claim older than this belongs to a killed request
  HANDLER_BUDGET_MS: 165000,       // stop before Vercel's 180 s kill
  RESERVE_MS: 30000,               // kept free after the Apify wait for the saves, the usage row and the reply
  RUN_WAIT_S: 60,                  // Apify's own maximum for waitForFinish
  AUTO_PER_PULL: 2,
  AUTO_PER_WEEK: 3,
  AUTO_MIN_SCORE: 2,
  AUTO_MAX_AGE_MS: 14 * DAY,
  AUTO_MIN_LEFT_MS: 45000,         // less than this left after the pull: skip the free transcripts this time
  AUTO_MAX_MS: 60000,
  TRANSCRIPT_BUDGET_MS: 150000,
  PRUNE_MS: 30 * DAY,
  MAX_CHARGE_USD: 0.2,
  MAX_JSON_BYTES: 4 * 1024 * 1024,
  TRANSCRIPT_MAX: 20000,
};
// Read by scripts/verify/timeout-budgets.mjs: the whole Apify wait (start + polls) and the dataset read.
// 100 s + 15 s + the Supabase writes after it (usage row, brand check) fit maxDuration 180.
const RUN_TIMEOUT_MS = 100000;
const DATASET_TIMEOUT_MS = 15000;

// Plain-word errors (never a provider's own text). Internals go to the server log only.
const MSG = {
  signedOut: 'Please sign in again.',
  badRequest: 'Something was missing from that request. Reload and try again.',
  forbidden: 'This brand is not yours.',
  unavailable: 'Could not load your creators just now. Try again in a minute.',
  notSetUp: 'The creator feed is not set up yet.',
  noCreators: "You don't follow any creators yet. Add one under “Creators you follow”.",
  notTiktok: 'Add a TikTok profile link (tiktok.com/@name) to a creator you follow.',
  notTiktokHandle: 'Save their TikTok profile link (tiktok.com/@name) so we can load their videos.',
  apifyFailed: "Couldn't load your creators' videos just now. Try again in a little while.",
  notConfigured: "Creator updates aren't switched on yet.",
  feedOffline: "The creator feed is offline on our side right now. Your creators are saved — paste a TikTok link for now.",
  transcribeFailed: "Couldn't get the words from that video. Try another one, or open it on TikTok.",
  notFound: 'That video is not in your feed any more. Refresh and try again.',
  fallbackLimit: "We couldn't read this video the quick way, and the backup reader is used up for today. Open it on TikTok and paste the spoken words instead.",
};

// Swappable edges — the gate replaces these; nothing else in this file touches the network.
const deps = {
  apify: apifyReq,
  transcribe: (url, opts) => require('./transcribe-url').transcribeVideo(url, opts),
  now: () => Date.now(),
};

// ─────────────────────────────── Apify ───────────────────────────────
// Resolves { status, data } (data = parsed JSON or null), or null on a network error / timeout. Never throws.
function apifyReq(method, path, body, timeoutMs) {
  const token = process.env.APIFY_API_TOKEN;
  return new Promise((resolve) => {
    let done = false, timer = null, req = null;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    try {
      const data = body ? JSON.stringify(body) : null;
      req = https.request({
        hostname: 'api.apify.com', path, method,
        headers: Object.assign({ Authorization: 'Bearer ' + token },
          data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      }, (res) => {
        const dec = new StringDecoder('utf8');
        let raw = '', bytes = 0;
        res.on('data', (c) => {
          if (done) return;
          bytes += c.length;
          if (bytes > C.MAX_JSON_BYTES) { try { res.destroy(); } catch (e) {} finish(null); return; }
          raw += dec.write(c);
        });
        res.on('end', () => {
          raw += dec.end();
          const code = res.statusCode || 0;
          if (code < 200 || code >= 300) {
            const why = code === 402 ? ' — OUT OF CREDITS / payment required'
              : code === 401 || code === 403 ? ' — TOKEN REJECTED (check APIFY_API_TOKEN)'
              : code === 429 ? ' — RATE LIMITED' : '';
            console.error('creator-feed: apify HTTP ' + code + ' on ' + path.split('?')[0] + why + ' · ' + String(raw).slice(0, 200));
          }
          let j = null;
          try { j = JSON.parse(raw); } catch (e) {}
          finish({ status: code, data: j });
        });
        res.on('aborted', () => finish(null));
        res.on('error', () => finish(null));
      });
      req.on('error', (e) => { console.error('creator-feed: apify ' + method + ' network error — ' + ((e && e.message) || e)); finish(null); });
      timer = setTimeout(() => { try { req.destroy(); } catch (e) {} finish(null); }, Math.max(1000, timeoutMs || 15000));
      if (data) req.write(data);
      req.end();
    } catch (e) { finish(null); }
  });
}

// The actor input. Field names checked against the actor's input schema (build 0.0.510, 2026-11-03).
function actorInput(handles) {
  return {
    profiles: handles,
    profileScrapeSections: ['videos'],
    profileSorting: 'latest',
    resultsPerPage: C.PER_CREATOR,
    excludePinnedPosts: true,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
    shouldDownloadSlideshowImages: false,
    shouldDownloadAvatars: false,
    downloadSubtitlesOptions: 'NEVER_DOWNLOAD_SUBTITLES',
    commentsPerPost: 0,
    maxFollowersPerProfile: 0,
    maxFollowingPerProfile: 0,
  };
}

const TERMINAL = { SUCCEEDED: 1, FAILED: 1, ABORTED: 1, 'TIMED-OUT': 1 };
// One run for every handle. Starts a run, or picks up `pendingRunId` — a run an earlier request started
// (still running, or finished but never saved). That one is already paid for, so its status is checked
// first and it is re-read, never bought twice. onStarted(runId) is awaited right after a start, so a request
// killed mid-wait leaves the id behind; onSucceeded(runId) is awaited the moment a run is seen SUCCEEDED —
// the cost is logged there, before the dataset read that could still fail.
// -> { ok:true, items, runId } | { pending:true, runId } | { ok:false, why, runId, keepRun }
//    keepRun: the run SUCCEEDED but its dataset could not be read — keep the id, re-read it next time.
async function runPull(handles, pendingRunId, runDeadline, onStarted, onSucceeded) {
  const left = () => runDeadline - deps.now();
  let run = null, runId = pendingRunId || null;
  if (!runId) {
    const waitS = Math.max(1, Math.min(C.RUN_WAIT_S, Math.floor((left() - 5000) / 1000)));
    const r = await deps.apify('POST', '/v2/acts/' + encodeURIComponent(ACTOR) + '/runs?waitForFinish=' + waitS +
      '&maxItems=' + (handles.length * C.PER_CREATOR) + '&maxTotalChargeUsd=' + C.MAX_CHARGE_USD,
      actorInput(handles), Math.min(left(), (waitS + 10) * 1000));
    if (!r || r.status < 200 || r.status >= 300 || !r.data || !r.data.data || !r.data.data.id) {
      return { ok: false, why: 'start ' + (r ? 'HTTP ' + r.status : 'no answer') };
    }
    run = r.data.data;
    runId = String(run.id);
    try { await onStarted(runId); } catch (e) {}
  }
  for (let polls = 0; !run || !TERMINAL[run.status]; polls++) {
    const waitS = Math.min(C.RUN_WAIT_S, Math.floor((left() - 5000) / 1000));
    if (waitS < 1 || polls >= 6) return { pending: true, runId };
    const r = await deps.apify('GET', '/v2/actor-runs/' + encodeURIComponent(runId) + '?waitForFinish=' + waitS, null,
      Math.min(left(), (waitS + 10) * 1000));
    if (!r) { if (left() < 6000) return { pending: true, runId }; continue; }
    if (r.status === 404) return { ok: false, why: 'run ' + runId + ' not found', runId };
    if (r.status < 200 || r.status >= 300 || !r.data || !r.data.data) return { ok: false, why: 'poll HTTP ' + r.status, runId, keepRun: true };
    run = r.data.data;
  }
  if (run.status !== 'SUCCEEDED') return { ok: false, why: 'run ' + run.status, runId };
  try { await onSucceeded(runId); } catch (e) {}
  const dsId = run.defaultDatasetId;
  if (!dsId) return { ok: false, why: 'no dataset', runId };
  const d = await deps.apify('GET', '/v2/datasets/' + encodeURIComponent(dsId) + '/items?clean=true&format=json&limit=' +
    (handles.length * C.PER_CREATOR + 10), null, Math.max(3000, Math.min(DATASET_TIMEOUT_MS, runDeadline + C.RESERVE_MS / 2 - deps.now())));
  if (!d || d.status < 200 || d.status >= 300 || !Array.isArray(d.data)) return { ok: false, why: 'dataset ' + (d ? 'HTTP ' + d.status : 'no answer'), runId, keepRun: true };
  return { ok: true, items: d.data, runId };
}

// ─────────────────────────────── creators ───────────────────────────────
const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
// A saved link -> { handle ('' when the link names nobody, e.g. vm.tiktok.com/xyz), url } | null when not TikTok.
function tiktokLink(raw) {
  let t = String(raw == null ? '' : raw).trim();
  if (!t || /\s/.test(t) || t.length > 500) return null;
  if (/^http:\/\//i.test(t)) t = 'https://' + t.slice(7);
  else if (!/^[a-z][a-z0-9+.\-]*:/i.test(t)) t = 'https://' + t.replace(/^\/+/, '');
  let u;
  try { u = new URL(t); } catch (e) { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
  if (!/(^|\.)tiktok\.com$/i.test(u.hostname)) return null;
  const m = /^\/@([\w.\-]{1,60})(?:\/|$)/.exec(u.pathname);
  return { handle: m ? m[1].toLowerCase() : '', url: u.href };
}
// THE ONE CREATOR RULE (the client mirrors it — CONTRACT.md "## Server notes"):
// creatorTiktokLink(links): links.tt when it is a tiktok.com link, otherwise the FIRST tiktok.com link among the
// entry's other link fields (in their saved order). Its handle is the /@name in that link ('' = no name).
function creatorTiktokLink(links) {
  const L = (links && typeof links === 'object') ? links : {};
  const tt = tiktokLink(L.tt);
  if (tt) return tt;
  for (const k of Object.keys(L)) { if (k === 'tt') continue; const t = tiktokLink(L[k]); if (t) return t; }
  return null;
}
// bookmarkCategories -> the followed TikTok creators: every entry in bookmark order, deduped by handle,
// the first MAX_CREATORS kept (`more` = there were more). Entries whose link has no @name are listed after
// (max 3, with a fix-it error) and do not count toward the 5.
function followedCreators(cats) {
  const usable = [], broken = [], seen = new Set();
  let anyEntry = false, anyTikTok = false;
  for (const cat of (Array.isArray(cats) ? cats : [])) {
    for (const e of ((cat && Array.isArray(cat.entries)) ? cat.entries : [])) {
      if (!e || typeof e !== 'object') continue;
      anyEntry = true;
      const hit = creatorTiktokLink(e.links);
      if (!hit) continue;
      anyTikTok = true;
      const name = clean(e.name, 60) || hit.handle || 'Creator';
      const note = clean(e.note, 140) || null;
      if (!hit.handle) { broken.push({ handle: '', name, profileUrl: hit.url, note, error: MSG.notTiktokHandle }); continue; }
      if (seen.has(hit.handle)) continue;
      seen.add(hit.handle);
      usable.push({ handle: hit.handle, name, profileUrl: 'https://www.tiktok.com/@' + hit.handle, note, error: null });
    }
  }
  const pick = usable.slice(0, C.MAX_CREATORS);
  return { anyEntry, anyTikTok, more: usable.length > C.MAX_CREATORS, handles: pick.map(c => c.handle), creators: pick.concat(broken.slice(0, 3)) };
}
const MORE_NOTE = 'Showing your first 5 creators.';

// ─────────────────────────────── videos ───────────────────────────────
function num(v) {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}
const ms = (v) => { if (v == null || v === '') return 0; const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : 0; };
const iso = (t) => new Date(t).toISOString();
function httpsUrl(v) {
  const s = String(v || '').trim();
  return /^https:\/\/[^\s"'<>]{4,1000}$/i.test(s) ? s : null;
}
function coverOf(it) {
  const vm = (it.videoMeta && typeof it.videoMeta === 'object') ? it.videoMeta : {};
  const c = it.covers;
  const fromCovers = Array.isArray(c) ? c.find(x => typeof x === 'string')
    : (c && typeof c === 'object' ? (c.default || c.origin || c.dynamic) : (typeof c === 'string' ? c : null));
  return httpsUrl(vm.coverUrl) || httpsUrl(fromCovers) || httpsUrl(vm.originalCoverUrl) || null;
}
// One dataset item -> a creator_videos row (without brand_id / fetched_at / score), or null.
// Every field is optional in practice; a missing number is null, never 0.
function videoFrom(it, wanted) {
  if (!it || typeof it !== 'object') return null;
  const id = String(it.id == null ? '' : it.id).trim();
  if (!/^\d{5,25}$/.test(id)) return null;
  const am = (it.authorMeta && typeof it.authorMeta === 'object') ? it.authorMeta : {};
  let h = String(am.name || am.uniqueId || '').replace(/^@/, '').trim().toLowerCase();
  const wm = /^https:\/\/(?:www\.)?tiktok\.com\/@([\w.\-]{1,60})\/video\/\d{5,25}/i.exec(String(it.webVideoUrl || ''));
  if (!wanted.has(h) && wm) h = wm[1].toLowerCase();
  if (!wanted.has(h) && typeof it.input === 'string') h = it.input.replace(/^@/, '').trim().toLowerCase();
  if (!wanted.has(h)) return null;
  const vm = (it.videoMeta && typeof it.videoMeta === 'object') ? it.videoMeta : {};
  let posted = ms(it.createTimeISO);
  if (!posted && num(it.createTime)) posted = num(it.createTime) * 1000;
  return {
    video_id: id,
    handle: h,
    url: 'https://www.tiktok.com/@' + h + '/video/' + id,
    caption: clean(it.text, 600),
    views: num(it.playCount),
    likes: num(it.diggCount),
    comments: num(it.commentCount),
    shares: num(it.shareCount),
    posted_at: posted ? iso(posted) : null,
    duration_sec: num(vm.duration),
    cover: coverOf(it),
  };
}
function median(xs) {
  const a = xs.filter(x => x != null).slice().sort((p, q) => p - q);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
// score = views ÷ the median views of THAT creator's videos in this pull, 1 decimal. No views -> 0.
function withScores(rows) {
  const by = {};
  for (const r of rows) (by[r.handle] = by[r.handle] || []).push(r.views);
  const med = {};
  for (const h of Object.keys(by)) med[h] = median(by[h]);
  return rows.map(r => Object.assign({}, r, { score: r.views != null && med[r.handle] > 0 ? Math.round((r.views / med[r.handle]) * 10) / 10 : 0 }));
}
function rowsFromItems(items, handles) {
  const wanted = new Set(handles), seen = new Set(), out = [];
  for (const it of (Array.isArray(items) ? items : [])) {
    const v = videoFrom(it, wanted);
    if (!v || seen.has(v.video_id)) continue;
    seen.add(v.video_id);
    out.push(v);
  }
  return withScores(out);
}
const CANON_URL = /^https:\/\/www\.tiktok\.com\/@[\w.\-]{1,60}\/video\/\d{5,25}$/;
// 'working' = a transcript is being made right now (a claim younger than WORKING_STALE_MS); an older claim
// belongs to a killed request and reads as 'none' (it can be retried).
const isWorking = (r, now) => r.transcript_status === 'working' && now - ms(r.transcribed_at) < C.WORKING_STALE_MS;
function outVideo(r) {
  const st = r.transcript_status === 'ready' && r.transcript ? 'ready'
    : (r.transcript_status === 'failed' ? 'failed' : (isWorking(r, deps.now()) ? 'working' : 'none'));
  return {
    videoId: String(r.video_id), handle: r.handle, url: r.url, caption: r.caption || '',
    views: num(r.views), likes: num(r.likes), comments: num(r.comments), shares: num(r.shares),
    postedAt: ms(r.posted_at) ? iso(ms(r.posted_at)) : null,
    durationSec: num(r.duration_sec), cover: r.cover || null,
    score: Number(r.score) || 0,
    transcript: st === 'ready' ? String(r.transcript) : null,
    transcriptStatus: st,
    auto: st === 'ready' && !!r.auto,
  };
}
function cleanTranscript(t) {
  const s = typeof t === 'string' ? t.trim() : '';
  return s ? s.slice(0, C.TRANSCRIPT_MAX) : null;
}

// Monday 00:00 UTC of the ISO week that holds t.
function isoWeekStart(t) {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
}

// ─────────────────────────────── storage ───────────────────────────────
const okStatus = (r) => !!r && r.status >= 200 && r.status < 300;
// PostgREST answers 404 PGRST205 ("Could not find the table") until sql/creator-feed.sql runs.
const tableMissing = (r) => !!r && r.status >= 400 && r.status < 500 &&
  /creator_videos|creator_feed_state/i.test(String(r.raw || '') + JSON.stringify(r.data || ''));
async function sb(method, path, opts) {
  try { return await store.rest(method, path, opts); }
  catch (e) { console.error('creator-feed: supabase ' + method + ' ' + path.split('?')[0] + ' failed — ' + ((e && e.message) || e)); return null; }
}
const enc = encodeURIComponent;
async function readBookmarks(brandId) {
  const r = await sb('GET', '/competitors?brand_id=eq.' + enc(brandId) + '&name=eq.__bookmarks__&select=notes,created_at&order=created_at.desc&limit=1');
  if (!okStatus(r) || !Array.isArray(r.data)) return { ok: false };
  if (!r.data[0]) return { ok: true, cats: [] };
  try { const j = JSON.parse(r.data[0].notes || '[]'); return { ok: true, cats: Array.isArray(j) ? j : [] }; }
  catch (e) { return { ok: true, cats: [] }; }
}
async function readState(brandId) {
  const r = await sb('GET', '/creator_feed_state?brand_id=eq.' + enc(brandId) + '&select=*');
  if (tableMissing(r)) return { missing: true };
  if (!okStatus(r) || !Array.isArray(r.data)) return { ok: false };
  return { ok: true, row: r.data[0] || null };
}
async function readVideos(brandId) {
  const r = await sb('GET', '/creator_videos?brand_id=eq.' + enc(brandId) + '&select=*&order=fetched_at.desc&limit=500');
  if (tableMissing(r)) return { missing: true };
  if (!okStatus(r) || !Array.isArray(r.data)) return { ok: false };
  return { ok: true, rows: r.data };
}
// Take the brand's pull slot. true only for the ONE caller whose PATCH matched (no lock, or a stale one).
async function claimLock(brandId, now) {
  await sb('POST', '/creator_feed_state', { body: { brand_id: brandId }, headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' } });
  const until = iso(now + C.LOCK_MS);
  const r = await sb('PATCH', '/creator_feed_state?brand_id=eq.' + enc(brandId) + '&or=' +
    enc('(lock_until.is.null,lock_until.lt.' + iso(now) + ')') + '&select=*',
    { body: { lock_until: until, updated_at: iso(now) }, headers: { Prefer: 'return=representation' } });
  if (okStatus(r) && Array.isArray(r.data) && r.data.length === 1) return { claimed: true, until, row: r.data[0] };
  return { claimed: false };
}
// Write under OUR lock only (lock_until still the value we set). `release` also frees the slot.
async function writeState(brandId, until, fields, release) {
  const body = Object.assign({}, fields, { updated_at: iso(deps.now()) }, release ? { lock_until: null } : {});
  const r = await sb('PATCH', '/creator_feed_state?brand_id=eq.' + enc(brandId) + '&lock_until=eq.' + enc(until) + '&select=brand_id',
    { body, headers: { Prefer: 'return=representation' } });
  if (!okStatus(r)) console.error('creator-feed: state write failed for brand ' + brandId + ' (' + ((r && r.status) || 'no response') + ')');
  return okStatus(r) && Array.isArray(r.data) && r.data.length === 1;
}
// `where` = extra PostgREST filters. true only when exactly one row was written.
async function patchVideo(brandId, videoId, body, where) {
  const r = await sb('PATCH', '/creator_videos?brand_id=eq.' + enc(brandId) + '&video_id=eq.' + enc(videoId) + (where || '') + '&select=video_id',
    { body, headers: { Prefer: 'return=representation' } });
  return okStatus(r) && Array.isArray(r.data) && r.data.length === 1;
}
// Claim ONE video for ONE transcript job, atomically: only from 'none', 'failed' or a stale 'working' (a killed
// request). Two taps, two devices or the free winners racing a tap: exactly one PATCH matches, so exactly one
// transcriber runs and at most one charge happens. -> the claim stamp (transcribed_at) or null.
async function claimVideo(brandId, videoId, now, extra) {
  const stamp = iso(now);
  const cond = '(transcript_status.eq.none,transcript_status.eq.failed,and(transcript_status.eq.working,transcribed_at.lt.' + iso(now - C.WORKING_STALE_MS) + '))';
  const won = await patchVideo(brandId, videoId, Object.assign({ transcript_status: 'working', transcribed_at: stamp }, extra || {}), '&or=' + enc(cond));
  return won ? stamp : null;
}
// Write a failure (or a give-back) only while OUR claim still stands — never over a 'ready' anybody wrote.
const whileClaimed = (stamp) => '&transcript_status=eq.working&transcribed_at=eq.' + enc(stamp);
const NOT_READY = '&transcript_status=neq.ready';

// ─────────────────────────────── cost fuse ───────────────────────────────
// Same rule as _usage.checkLimit / fact-pack overCostCap: armed when COST_CAP_EUR > 0, trial/free owners only.
async function overCostCap(ownerId) {
  const cap = Number(usage.COST_CAP_EUR) || 0;
  if (cap <= 0 || !ownerId) return false;
  try {
    const s = await usage.getStatus(ownerId);
    if (!s || s.unknown || (s.plan !== 'trial' && s.plan !== 'free')) return false;
    return (Number(s.cost) || 0) + ((usage.ACTION_COST && usage.ACTION_COST[PULL_ACTION]) || 0.15) > cap;
  } catch (e) { return false; }
}

// ─────────────────────────────── replies ───────────────────────────────
function clock(t, tz) {
  const off = Number.isFinite(Number(tz)) && Math.abs(Number(tz)) <= 840 ? Number(tz) : null;
  const d = new Date(t - (off == null ? 0 : off) * 60000);
  const hm = String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
  return off == null ? hm + ' UTC' : hm;
}
// v723: Apify refused our key (401/403) — waiting will not fix it, so never tell the user "try again after HH:MM"
function authFailed(why) { return /HTTP 40[13]\b/.test(String(why || '')); }
function ago(t, now) {
  const m = Math.max(0, Math.round((now - t) / 60000));
  if (m < 2) return 'Updated just now';
  if (m < 60) return 'Updated ' + m + ' minutes ago';
  const h = Math.round(m / 60);
  if (h < 24) return 'Updated ' + h + (h === 1 ? ' hour ago' : ' hours ago');
  const d = Math.round(h / 24);
  return 'Updated ' + d + (d === 1 ? ' day ago' : ' days ago');
}
// After a failed pull: 30 min; once FAIL_LONG_AFTER pulls in a row failed: 6 h.
const backoffMs = (s) => (Number(s && s.fail_count) || 0) >= C.FAIL_LONG_AFTER ? C.FAIL_LONG_BACKOFF_MS : C.FAIL_BACKOFF_MS;
const inBackoff = (s, now) => !!(s && ms(s.failed_at) && now - ms(s.failed_at) < backoffMs(s));
// A run still worth WAITING for: started < 20 min ago and nothing has failed since it started.
const livePending = (s, now) => !!(s && s.run_id && now - ms(s.run_started_at) < C.PENDING_RUN_MAX_MS && !(ms(s.failed_at) >= ms(s.run_started_at)));
// A run already paid for (any state) that the next pull re-reads instead of buying a new one.
const keptRun = (s, now) => (s && s.run_id && now - ms(s.run_started_at) < C.RUN_KEEP_MS) ? String(s.run_id) : null;
const isDue = (action, at, now) => action === 'refresh' ? (!at || now - at >= C.REFRESH_GAP_MS) : (!at || now - at >= C.LIST_STALE_MS);
// The earliest time a 'refresh' will really pull. null = it would pull right now.
function nextRefreshAt(state, now) {
  if (!state) return null;
  const t = Math.max(ms(state.fetched_at) ? ms(state.fetched_at) + C.REFRESH_GAP_MS : 0,
    ms(state.failed_at) ? ms(state.failed_at) + backoffMs(state) : 0);
  return t > now ? t : null;
}
function buildPayload(f, state, rows, note) {
  const now = deps.now();
  const at = ms(state && state.fetched_at);
  const pulled = new Set(Array.isArray(state && state.handles) ? state.handles.map(h => String(h).toLowerCase()) : []);
  const followed = new Set(f.handles);
  const vids = (rows || []).filter(r => r && followed.has(r.handle) && (!at || ms(r.fetched_at) >= at - 1000))
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0) || ms(b.posted_at) - ms(a.posted_at))
    .slice(0, C.MAX_VIDEOS).map(outVideo);
  const has = new Set(vids.map(v => v.handle));
  const next = nextRefreshAt(state, now);
  const creators = f.creators.map(c => {
    if (!c.handle || !at) return c;
    if (!pulled.has(c.handle)) return Object.assign({}, c, { error: 'Added after the last update — their videos show after the next refresh.' });
    if (!has.has(c.handle)) return Object.assign({}, c, { error: 'No videos came back for this creator. The account may be private.' });
    return c;
  });
  return {
    ok: true,
    fetchedAt: at ? iso(at) : null,
    nextRefreshAt: next ? iso(next) : null,
    creators,
    videos: vids,
    note: withMore(f, note == null ? (at ? ago(at, now) : null) : note),
  };
}
// More than 5 TikTok creators followed: say which ones show.
function withMore(f, note) {
  if (!f || !f.more) return note;
  return note ? String(note).replace(/[.!]?$/, '.') + ' ' + MORE_NOTE : MORE_NOTE;
}
const WORKING_NOTE = 'This video is being transcribed \u2014 check back in a minute.';
const fail = (res, status, code, error) => res.status(status).json({ error, code });

// ─────────────────────────────── the free weekly winners ───────────────────────────────
async function autoWinners(brandId, pullRows, allRows, deadline) {
  const now = deps.now();
  const week = isoWeekStart(now);
  const tried = (allRows || []).filter(r => ms(r.auto_tried_at) >= week).length;
  const room = Math.min(C.AUTO_PER_PULL, C.AUTO_PER_WEEK - tried);
  if (room <= 0) return 0;
  const picks = pullRows.filter(r => (Number(r.score) || 0) >= C.AUTO_MIN_SCORE && ms(r.posted_at) && now - ms(r.posted_at) <= C.AUTO_MAX_AGE_MS &&
      (r.transcript_status === 'none' || (r.transcript_status === 'working' && !isWorking(r, now))) && !ms(r.auto_tried_at) && CANON_URL.test(String(r.url || '')))
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
    .slice(0, room);
  if (!picks.length) return 0;
  const left = deadline - now;
  if (left < C.AUTO_MIN_LEFT_MS) { console.log('creator-feed: brand ' + brandId + ' skipped ' + picks.length + ' free transcript(s) — ' + Math.round(left / 1000) + 's left'); return 0; }
  const until = now + Math.min(C.AUTO_MAX_MS, left - 15000);
  await Promise.all(picks.map(async (r) => {
    // The try counts toward the weekly cap from the moment it is claimed (a killed request still used it).
    const tried = iso(deps.now());
    const stamp = await claimVideo(brandId, r.video_id, deps.now(), { auto_tried_at: tried });
    if (!stamp) return;
    let text = null;
    try { text = cleanTranscript(await deps.transcribe(r.url, { deadline: until, apifyFallback: false })); }
    catch (e) { console.error('creator-feed: free transcript of ' + r.video_id + ' failed — ' + ((e && e.message) || e)); }
    const body = text ? { transcript: text, transcript_status: 'ready', auto: true, transcribed_at: iso(deps.now()) } : { transcript_status: 'failed' };
    if (await patchVideo(brandId, r.video_id, body, text ? NOT_READY : whileClaimed(stamp))) Object.assign(r, body, { auto_tried_at: tried });
  }));
  return picks.length;
}

// ─────────────────────────────── the handler ───────────────────────────────
async function handler(req, res) {
  const allowed = ['https://contentshrimp.com', 'https://bettercontent.app', 'https://boring-engine.vercel.app'];
  const origin = (req.headers && req.headers.origin) || '';
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return fail(res, 405, 'bad_request', 'Method not allowed.');
  try { return await run(req, res); }
  catch (e) {
    console.error('creator-feed error:', e);
    return fail(res, 500, 'unavailable', MSG.unavailable);
  }
}

async function run(req, res) {
  const t0 = deps.now();
  const deadline = t0 + C.HANDLER_BUDGET_MS;
  const user = await require('./_requireUser')(req);
  if (!user) return fail(res, 401, 'signed_out', MSG.signedOut);
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const brandId = String(body.brandId || '').trim();
  const action = String(body.action || 'list');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(brandId)) return fail(res, 400, 'bad_request', MSG.badRequest);
  if (action !== 'list' && action !== 'refresh' && action !== 'transcript') return fail(res, 400, 'bad_request', MSG.badRequest);

  let can = false;
  try { can = await store.userCanAccessBrand(user.id, brandId); }
  catch (e) { console.error('creator-feed: access check failed — ' + e.message); return fail(res, 503, 'unavailable', MSG.unavailable); }
  if (!can) return fail(res, 403, 'forbidden', MSG.forbidden);

  const bm = await readBookmarks(brandId);
  if (!bm.ok) return fail(res, 503, 'unavailable', MSG.unavailable);
  const f = followedCreators(bm.cats);
  if (action !== 'transcript') {
    if (!f.anyEntry) return fail(res, 422, 'no_creators', MSG.noCreators);
    if (!f.anyTikTok) return fail(res, 422, 'not_tiktok', MSG.notTiktok);
    if (!f.handles.length) return fail(res, 422, 'not_tiktok', MSG.notTiktokHandle);
  }

  const st = await readState(brandId);
  if (st.missing) return fail(res, 503, 'not_set_up', MSG.notSetUp);
  if (!st.ok) return fail(res, 503, 'unavailable', MSG.unavailable);
  const vr = await readVideos(brandId);
  if (vr.missing) return fail(res, 503, 'not_set_up', MSG.notSetUp);
  if (!vr.ok) return fail(res, 503, 'unavailable', MSG.unavailable);
  let state = st.row, rows = vr.rows;

  if (action === 'transcript') return transcript(req, res, { user, brandId, body, f, state, rows, t0 });

  // ── list / refresh ──
  const now = deps.now();
  const tz = body.tzOffsetMin;
  const at = ms(state && state.fetched_at);
  const pendingRun = livePending(state, now);
  if (!pendingRun && !isDue(action, at, now)) {
    const next = nextRefreshAt(state, now);
    return res.status(200).json(buildPayload(f, state, rows,
      action === 'refresh' ? 'Fresh already — next refresh after ' + clock(next || now, tz) : null));
  }
  if (!pendingRun && inBackoff(state, now)) {
    const retry = clock(ms(state.failed_at) + backoffMs(state), tz);
    if (authFailed(state.last_error)) {
      if (!at) return fail(res, 502, 'apify_failed', MSG.feedOffline);
      return res.status(200).json(buildPayload(f, state, rows, MSG.feedOffline));
    }
    if (!at) return fail(res, 502, 'apify_failed', "Couldn't load your creators' videos just now. Try again after " + retry + '.');
    return res.status(200).json(buildPayload(f, state, rows, "Couldn't reach TikTok just now — showing your last update. Try again after " + retry + '.'));
  }
  if (!process.env.APIFY_API_TOKEN) {
    console.error('creator-feed: APIFY_API_TOKEN is not set — no pull');
    if (!at) return fail(res, 503, 'apify_failed', MSG.notConfigured);
    return res.status(200).json(buildPayload(f, state, rows, null));
  }

  const lock = await claimLock(brandId, now);
  if (!lock.claimed) {
    return res.status(200).json(buildPayload(f, state, rows, "Updating your creators' videos — check back in a minute."));
  }
  let released = false;
  const release = async (fields) => { released = true; return writeState(brandId, lock.until, fields || {}, true); };
  try {
    // Another request may have finished (or failed) a pull between our read and our claim: decide again.
    state = lock.row || state;
    const at2 = ms(state.fetched_at);
    const pending2 = livePending(state, now);
    if (!pending2 && (!isDue(action, at2, now) || inBackoff(state, now))) {
      await release();
      const fresh = await readVideos(brandId);
      return res.status(200).json(buildPayload(f, state, fresh.ok ? fresh.rows : rows, null));
    }
    const owner = await usage.billingUserFor(user.id, brandId);
    const reuse = keptRun(state, now);          // already paid for: check it, re-read it, never buy it again
    if (!reuse && await overCostCap(owner)) {
      await release();
      return res.status(200).json(buildPayload(f, state, rows, 'Creator updates are paused on this plan for now.'));
    }

    const handles = f.handles.slice();
    let runStartedAt = reuse ? state.run_started_at : null;
    let loggedRun = state.logged_run_id ? String(state.logged_run_id) : null;
    const out = await runPull(handles, reuse, deadline - C.RESERVE_MS,
      async (runId) => { runStartedAt = iso(deps.now()); await writeState(brandId, lock.until, { run_id: runId, run_started_at: runStartedAt }, false); },
      // The cost, ONCE per Apify run that SUCCEEDED — even when reading or saving its videos fails afterwards.
      async (runId) => {
        if (loggedRun === runId) return;
        loggedRun = runId;
        await writeState(brandId, lock.until, { logged_run_id: runId }, false);
        await usage.logUsage({ userId: owner, brandId, action: PULL_ACTION, model: 'apify:' + ACTOR + ' run=' + runId });
      });

    if (out.pending) {
      await release({ run_id: out.runId, run_started_at: runStartedAt || iso(now) });
      return res.status(200).json(buildPayload(f, state, rows, "Still loading your creators' videos — check back in a minute."));
    }
    // A failed pull: count it (2 in a row = a 6 h wait). A run that SUCCEEDED keeps its id so the next pull
    // re-reads the same dataset; a run that failed or vanished is dropped.
    const failedPull = (why, keep) => {
      const failedAt = iso(deps.now());
      const fields = { failed_at: failedAt, fail_count: (Number(state.fail_count) || 0) + 1, last_error: String(why).slice(0, 200),
        run_id: keep ? out.runId : null, run_started_at: keep ? (runStartedAt || iso(now)) : null };
      state = Object.assign({}, state, fields);
      return release(fields);
    };
    if (!out.ok) {
      console.error('creator-feed: pull failed for brand ' + brandId + ' — ' + out.why + (out.keepRun ? ' (run kept for a re-read)' : ''));
      await failedPull(out.why, !!(out.keepRun && out.runId));
      if (authFailed(out.why)) {
        if (!at2) return fail(res, 502, 'apify_failed', MSG.feedOffline);
        return res.status(200).json(buildPayload(f, state, rows, MSG.feedOffline));
      }
      if (!at2) return fail(res, 502, 'apify_failed', MSG.apifyFailed);
      return res.status(200).json(buildPayload(f, state, rows, "Couldn't reach TikTok just now — showing your last update."));
    }

    // ── the pull worked: save it, then mark it ──
    const pullAt = deps.now();
    const fresh = rowsFromItems(out.items, handles).map(r => Object.assign({ brand_id: brandId, fetched_at: iso(pullAt) }, r));
    if (fresh.length) {
      const up = await sb('POST', '/creator_videos?on_conflict=brand_id,video_id', { body: fresh,
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
      if (!okStatus(up)) {
        console.error('creator-feed: saving ' + fresh.length + ' videos failed for brand ' + brandId + ' (' + ((up && up.status) || 'no response') + ') — run kept for a re-read');
        await failedPull('save failed', true);
        if (!at2) return fail(res, 502, 'apify_failed', MSG.apifyFailed);
        return res.status(200).json(buildPayload(f, state, rows, "Couldn't save the new videos — showing your last update."));
      }
    }
    const marked = { fetched_at: iso(pullAt), handles, run_id: null, run_started_at: null, failed_at: null, fail_count: 0, last_error: null };
    await writeState(brandId, lock.until, marked, false);
    state = Object.assign({}, state, marked);
    console.log('creator-feed: brand ' + brandId + ' pulled ' + handles.length + ' creator(s) from run ' + out.runId + ', ' + (out.items || []).length + ' raw, ' + fresh.length + ' kept');

    const after = await readVideos(brandId);
    rows = after.ok ? after.rows : fresh;
    const pullRows = rows.filter(r => ms(r.fetched_at) >= pullAt - 1000);
    await autoWinners(brandId, pullRows, rows, deadline);
    try { await sb('DELETE', '/creator_videos?brand_id=eq.' + enc(brandId) + '&fetched_at=lt.' + enc(iso(pullAt - C.PRUNE_MS)) + '&transcript_status=neq.ready'); } catch (e) {}
    await release();
    return res.status(200).json(buildPayload(f, state, rows,
      fresh.length ? 'Updated just now' : 'Updated just now — no videos came back. Check the profile links.'));
  } finally {
    if (!released) { try { await writeState(brandId, lock.until, {}, true); } catch (e) {} }
  }
}

// ── 'transcript': cached = free; new = a free read (v712: 0 credits) counted toward the SAME daily read cap as
//    /api/transcribe-url (_usage.dailyReadCheck), logged as 'transcribeurl' only when words came back ──
async function transcript(req, res, ctx) {
  const { user, brandId, body, f, state, rows, t0 } = ctx;
  const videoId = String(body.videoId || '').trim();
  if (!/^\d{5,25}$/.test(videoId)) return fail(res, 400, 'bad_request', MSG.badRequest);
  const row = rows.find(r => String(r.video_id) === videoId);
  if (!row) return fail(res, 404, 'not_found', MSG.notFound);
  if (row.transcript_status === 'ready' && row.transcript) return res.status(200).json(buildPayload(f, state, rows, null));
  if (!CANON_URL.test(String(row.url || ''))) return fail(res, 422, 'not_tiktok', MSG.transcribeFailed);

  // One job per video: a second tap / device gets the row as it is now ("working"), never a second charge.
  const stamp = isWorking(row, deps.now()) ? null : await claimVideo(brandId, videoId, deps.now());
  if (!stamp) {
    const again = await readVideos(brandId);
    const rows2 = again.ok ? again.rows : rows;
    const cur = rows2.find(r => String(r.video_id) === videoId) || row;
    return res.status(200).json(buildPayload(f, state, rows2, cur.transcript_status === 'ready' && cur.transcript ? null : WORKING_NOTE));
  }
  const giveBack = { transcript_status: row.transcript_status === 'failed' ? 'failed' : 'none', transcribed_at: row.transcribed_at || null };

  const billingUserId = await usage.billingUserFor(user.id, brandId);
  const gate = await usage.checkLimit(billingUserId, usage.creditsFor('transcribeurl'), 'transcribeurl');
  if (!gate.ok) { await patchVideo(brandId, videoId, giveBack, whileClaimed(stamp)); return usage.denyResponse(res, gate); }
  // Nothing logged = nothing charged: a failed transcript hands the reservation back (api/_usage.js).
  if (gate.hold) usage.attachHoldRelease(res, gate.hold);
  // v712 — the daily read cap, ranked against our own reservation so parallel taps cannot all pass.
  const cap = await usage.dailyReadCheck(billingUserId, { hold: gate.hold });
  if (!cap.ok) { await patchVideo(brandId, videoId, giveBack, whileClaimed(stamp)); return usage.dailyReadDeny(res, cap); }

  let text = null, fallbackCapped = false;
  try {
    text = cleanTranscript(await deps.transcribe(row.url, { deadline: t0 + C.TRANSCRIPT_BUDGET_MS,
      // v712 — the paid Apify fallback: capped per user per UTC day and logged as its own row (_usage.js).
      apifyGate: () => usage.useApifyFallback(billingUserId, brandId) }));
  } catch (e) {
    fallbackCapped = !!(e && e.limitCode === 'fallback_limit');
    console.error('creator-feed: transcript of ' + videoId + ' failed — ' + ((e && e.message) || e));
  }
  if (!text && fallbackCapped) {
    // Not the video's fault: hand the claim back so it can be tapped again tomorrow.
    await patchVideo(brandId, videoId, giveBack, whileClaimed(stamp));
    return fail(res, 502, 'fallback_limit', MSG.fallbackLimit);
  }
  if (!text) {
    await patchVideo(brandId, videoId, { transcript_status: 'failed' }, whileClaimed(stamp));
    return fail(res, 502, 'transcribe_failed', MSG.transcribeFailed);
  }
  const saved = { transcript: text, transcript_status: 'ready', auto: false, transcribed_at: iso(deps.now()) };
  if (!(await patchVideo(brandId, videoId, saved, NOT_READY))) console.error('creator-feed: transcript of ' + videoId + ' was not saved (already ready, or the write failed) — it is still returned');
  await usage.logUsage({ userId: billingUserId, brandId, action: 'transcribeurl', model: 'groq:whisper-large-v3' });
  Object.assign(row, saved);
  return res.status(200).json(buildPayload(f, state, rows, null));
}

module.exports = handler;
Object.assign(module.exports, {
  _deps: deps, C, ACTOR, PULL_ACTION, actorInput, tiktokLink, followedCreators, videoFrom, rowsFromItems, withScores,
  median, isoWeekStart, buildPayload, nextRefreshAt, runPull, creatorTiktokLink, claimVideo, backoffMs,
});
