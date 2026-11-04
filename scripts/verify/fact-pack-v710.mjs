#!/usr/bin/env node
// GATE v710 — a FAILED fact search must not lock a brand out for a week (deep-audit G #4).
//
// WHY: claimSearch stamps lastSearchAt BEFORE the search runs (the stamp is also the lock). With the xAI
// key disabled every search came back empty, yet each brand counted as "searched this week": one run used
// up the weekly slot of every brand it touched, the next day nothing was due and the heartbeat went 'ok'.
// NOW: only a search that really ran keeps the stamp. A refused/empty/unparseable search, zero facts
// because every page fetch failed, or a crash after the claim gives the slot back (lastSearchAt restored,
// failedAt = a 12 h cooldown), so the next daily run tries again. When every brand tried failed the
// heartbeat says 'error' and does NOT advance last_success_at.
//
// HOW: runs the REAL api/fact-pack.js handler against a fake database (the same PostgREST filter rules
// as scripts/verify/fact-pack.mjs), a stubbed search and a stubbed web. No network, no AI calls.
// RUN: node scripts/verify/fact-pack-v710.mjs   EXPECT: "PASS" and exit 0.
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require_ = createRequire(import.meta.url);
const Module = require_('module');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = path.join(ROOT, 'api');
const WALL = setTimeout(() => { console.log('FAIL: fact-pack-v710 wall clock (60s) — something hung'); process.exit(1); }, 60000);
let failed = 0, passed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('ok: ' + m); } else { failed++; console.log('FAIL: ' + m); } };
const quiet = async (fn) => { const q = console.error, w = console.warn, l = console.log; console.error = console.warn = console.log = () => {}; try { return await fn(); } finally { console.error = q; console.warn = w; console.log = l; } };

process.env.CRON_SECRET = 'gate-cron-secret';
process.env.SUPABASE_URL = 'https://stub.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
process.env.XAI_API_KEY = 'stub';
function stub(rel, exports) {
  const file = require_.resolve(path.join(API, rel));
  const m = new Module(file); m.filename = file; m.loaded = true; m.exports = exports; require_.cache[file] = m;
}

// ── the fake database ──
const DAY = 24 * 3600 * 1000;
const REAL_NOW = Date.now();
const db = { brands: [], ideas: {}, usage: {}, hbOk: [], hbPosts: [], patches: [], failPatch: null };
const qp = (p) => { const i = p.indexOf('?'); return i < 0 ? '' : p.slice(i + 1); };
const param = (p, k) => { for (const part of qp(p).split('&')) { const j = part.indexOf('='); if (decodeURIComponent(part.slice(0, j)) === k) return decodeURIComponent(part.slice(j + 1)); } return null; };
const clone = (x) => JSON.parse(JSON.stringify(x));
const match = (cur, f) => f == null || (f === 'is.null' ? cur == null : String(cur) === f.replace(/^eq\./, ''));
function rest(method, p, opts) {
  const o = opts || {};
  if (p.startsWith('/job_heartbeats')) { db.hbPosts.push({ method, body: clone(o.body), prefer: (o.headers || {}).Prefer }); return Promise.resolve({ status: 201, data: null }); }
  if (p.startsWith('/brands')) {
    const idEq = param(p, 'id');
    const rows = db.brands.filter(b => !idEq || idEq === 'eq.' + b.id);
    if (method === 'GET') return Promise.resolve({ status: 200, data: clone(rows) });
    if (method === 'PATCH') {
      db.patches.push({ path: p, body: clone(o.body) });
      if (db.failPatch && db.failPatch(p, o.body)) return Promise.resolve({ status: 500, data: { message: 'boom' }, raw: '{"message":"boom"}' });
      const isNull = param(p, 'fact_pack') === 'is.null';
      const lsa = param(p, 'fact_pack->>lastSearchAt'), rv = param(p, 'fact_pack->>rev');
      const hit = rows.filter(b => !(isNull && b.fact_pack != null) && match(b.fact_pack && b.fact_pack.lastSearchAt, lsa) && match(b.fact_pack && b.fact_pack.rev, rv));
      for (const b of hit) Object.assign(b, clone(o.body));
      return Promise.resolve({ status: 200, data: hit.map(b => ({ id: b.id })) });
    }
  }
  if (p.startsWith('/ideas')) { const id = (param(p, 'brand_id') || '').replace(/^eq\./, ''); return Promise.resolve({ status: 200, data: clone(db.ideas[id] || []) }); }
  if (p.startsWith('/usage_events')) return Promise.resolve({ status: 200, data: [] });
  return Promise.resolve({ status: 200, data: [] });
}
stub('_publish/store.js', {
  rest, setRequestBudget() {},
  heartbeat: async (job, status, detail) => { db.hbOk.push({ job, status, detail }); },
  userCanAccessBrand: async () => true,
});
let searches = [];
let searchAnswer = () => null;
stub('_llm.js', {
  callGrokSearch: async (prompt, opts) => { searches.push({ prompt, opts }); return searchAnswer(prompt); },
  callLLM: async () => { throw new Error('no model calls in this gate'); },
  aiUnavailable: () => null, claudeConfigured: () => false,
});
stub('_usage.js', { COST_CAP_EUR: 25, getStatus: async () => ({ plan: 'pro', cost: 0 }) });
let currentUser = null;
stub('_requireUser.js', async () => currentUser);

const FP = require_(path.join(API, 'fact-pack.js'));
let clock = REAL_NOW;
FP._deps.now = () => clock;

// ── the fake web (5+ facts verify) ──
const PAGES = {};
let webDown = false;
FP._deps.lookup = async (host) => [{ address: net.isIP(host) ? host : '93.184.216.34', family: 4 }];
FP._deps.httpGet = async (url) => {
  if (webDown) throw new Error('ECONNRESET');
  const pg = PAGES[url];
  if (!pg) throw new Error('ECONNREFUSED');
  return { status: pg.status || 200, headers: Object.assign({ 'content-type': 'text/html' }, pg.headers || {}), body: pg.body || '' };
};
const html = (t) => '<html><body><p>' + t + '</p></body></html>';
PAGES['https://www.cdc.gov/heat/sweat.html'] = { body: html('During exercise in hot weather, adults can lose 1,000 milligrams of sodium per hour through sweat, the agency says.') };
PAGES['https://www.nih.gov/water'] = { body: html('About 60 percent of the adult human body is water, according to the institute.') };
PAGES['https://www.reuters.com/science/marathons'] = { body: html('More than 1.1 million runners finished a marathon worldwide in 2019, a study of race results found.') };
PAGES['https://redirector.org/to-good'] = { status: 302, headers: { location: 'https://www.nih.gov/water' } };
const goodAnswer = (tag) => JSON.stringify([
  { text: 'Adults can lose 1000 milligrams of sodium per hour through sweat during exercise in hot weather.', url: 'https://www.cdc.gov/heat/sweat.html', title: 'CDC', topic: tag },
  { text: 'About 60% of the adult human body is water.', url: 'https://www.nih.gov/water', title: 'NIH', topic: tag },
  { text: 'More than 1.1 million runners finished a marathon worldwide in 2019.', url: 'https://www.reuters.com/science/marathons', title: 'Reuters', topic: tag },
  { text: 'About 60% of the adult human body is water, the institute notes.', url: 'https://redirector.org/to-good', title: 'NIH', topic: tag },
  { text: 'Adults lose 1000 milligrams of sodium per hour through sweat in hot weather, the agency says.', url: 'https://www.cdc.gov/heat/sweat.html', title: 'CDC', topic: tag },
]);
const oneFact = () => JSON.stringify([{ text: 'About 60% of the adult human body is water.', url: 'https://www.nih.gov/water', title: 'NIH', topic: 't' }]);

const recent = (days) => new Date(clock - days * DAY).toISOString();
const mk = (id, pack) => ({ id, user_id: 'own-' + id, brand_name: 'Brand ' + id, website: '', competitors_text: '', communities: ['topic-' + id], target_audience: 'runners', voice_extra: {}, fact_pack: pack === undefined ? null : pack });
const OLD = REAL_NOW - 9 * DAY;
function reset(brands) {
  clock = REAL_NOW; webDown = false; db.failPatch = null;
  db.brands = brands; db.ideas = {}; for (const b of brands) db.ideas[b.id] = [{ created_at: recent(1), status: 'done' }];
  db.hbOk = []; db.hbPosts = []; db.patches = []; searches = [];
}
const fakeRes = () => ({ statusCode: 0, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } });
async function cron() { const res = fakeRes(); await quiet(() => FP({ method: 'GET', headers: { authorization: 'Bearer ' + process.env.CRON_SECRET } }, res)); return res; }
async function post(body) { const res = fakeRes(); await quiet(() => FP({ method: 'POST', headers: { authorization: 'Bearer t' }, body }, res)); return res; }
const pack = (id) => (db.brands.find(b => b.id === id) || {}).fact_pack;
const searchedFor = (id) => searches.filter(s => s.prompt.indexOf('topic-' + id) >= 0).length;
const errBeat = () => db.hbPosts.filter(h => h.body && h.body.job === 'fact-pack-cron' && h.body.last_status === 'error');

// ═════ 1. a refused search (the live case: key disabled → null) gives the slot back ═════
reset([mk('a', { lastSearchAt: OLD, updatedAt: OLD, facts: [{ id: 'F1', text: 'Kept old fact.', url: 'https://x.gov/k', title: 'X', fetchedAt: OLD }] }), mk('b')]);
searchAnswer = () => null;
let r = await cron();
ok(r.statusCode === 200 && searches.length === 2, 'refused: both due brands were tried once (' + searches.length + ')');
ok(pack('a').lastSearchAt === OLD && pack('a').facts.length === 1 && pack('a').facts[0].text === 'Kept old fact.', 'refused: brand a keeps its OLD lastSearchAt and its facts (not stamped as searched)');
ok(pack('b') && pack('b').lastSearchAt == null, 'refused: a never-searched brand is still never-searched (lastSearchAt null)');
ok(pack('a').failedAt > 0 && pack('b').failedAt > 0, 'refused: failedAt marks the short cooldown');
ok(r.body && r.body.searchFailed === 2 && r.body.ok === false, 'refused: the run counts searchFailed=2 and answers ok:false (' + JSON.stringify(r.body && { sf: r.body.searchFailed, ok: r.body.ok }) + ')');
ok(errBeat().length === 1 && db.hbOk.length === 0, 'refused: heartbeat is ONE \'error\' upsert and store.heartbeat (which advances last_success_at) is NOT called');
ok(errBeat().length === 1 && !('last_success_at' in errBeat()[0].body) && /merge-duplicates/.test(String(errBeat()[0].prefer)), 'refused: the error upsert carries no last_success_at (it stays at the last real success)');
// same day again: the cooldown stops a duplicate run from hammering it
r = await cron();
ok(searches.length === 2, 'cooldown: a second run the same day searches nobody again');
// next day: due again, the search works, the pack is saved, cooldown cleared, heartbeat ok
clock = REAL_NOW + DAY - 60 * 1000;
searchAnswer = (p) => goodAnswer((p.match(/topic-(\w+)/) || [])[1] || 't');
db.ideas.a = [{ created_at: recent(1), status: 'done' }]; db.ideas.b = [{ created_at: recent(1), status: 'done' }];
db.hbOk = []; db.hbPosts = [];
r = await cron();
ok(searchedFor('a') === 2 && searchedFor('b') === 2, 'next daily run: both brands are due again and searched (not a week later)');
ok(pack('a').facts.length >= 5 && pack('a').lastSearchAt > REAL_NOW && !pack('a').failedAt, 'next daily run: a saved a fresh pack, lastSearchAt stamped, failedAt gone');
ok(db.hbOk.length === 1 && db.hbOk[0].status === 'ok' && errBeat().length === 0, 'next daily run: heartbeat ok via store.heartbeat');
// and THEN it is done for the week
clock = REAL_NOW + 2 * DAY;
r = await cron();
ok(searchedFor('a') === 2, 'after a real search the brand is not due again the next day');

// ═════ 2. an unparseable answer and an all-unreachable web are failures too ═════
reset([mk('c', { lastSearchAt: OLD, updatedAt: OLD, facts: [] })]);
searchAnswer = () => 'I could not find anything useful, sorry.';
r = await cron();
ok(searches.length === 1 && pack('c').lastSearchAt === OLD && r.body.searchFailed === 1, 'unparseable answer: slot given back');
reset([mk('d', { lastSearchAt: OLD, updatedAt: OLD, facts: [] })]);
searchAnswer = () => goodAnswer('d'); webDown = true;
r = await cron();
ok(searches.length === 1 && pack('d').lastSearchAt === OLD && r.body.searchFailed === 1, 'every page fetch failed (0 facts because of an error): slot given back');
ok(errBeat().length === 1 && db.hbOk.length === 0, 'every page fetch failed: heartbeat error, last_success_at not advanced');

// ═════ 3. a REAL search that finds little is still this week's search ═════
reset([mk('e', { lastSearchAt: OLD, updatedAt: OLD, facts: [{ id: 'F1', text: 'Kept fact.', url: 'https://x.gov/k', title: 'X', fetchedAt: OLD }] })]);
searchAnswer = () => oneFact();
r = await cron();
ok(searches.length === 1 && pack('e').lastSearchAt > REAL_NOW - 1000 && pack('e').facts[0].text === 'Kept fact.' && !pack('e').failedAt, 'too few facts after a real search: old pack kept, the week is used (stamped)');
ok(db.hbOk.length === 1 && db.hbOk[0].status === 'ok', 'too few facts: heartbeat ok');
clock = REAL_NOW + DAY;
r = await cron();
ok(searches.length === 1, 'too few facts: not searched again the next day');

// ═════ 4. a crash after the claim (save PATCH 500) gives the slot back ═════
reset([mk('f', { lastSearchAt: OLD, updatedAt: OLD, facts: [] })]);
searchAnswer = () => goodAnswer('f');
db.failPatch = (p, body) => !!(body && body.fact_pack && Array.isArray(body.fact_pack.facts) && body.fact_pack.facts.length >= 5);
r = await cron();
ok(searches.length === 1 && r.body.failed === 1 && pack('f').lastSearchAt === OLD && pack('f').failedAt > 0, 'save failed after the search: slot given back (' + JSON.stringify(pack('f')) + ')');
ok(errBeat().length === 1 && db.hbOk.length === 0, 'save failed for the only brand: heartbeat error');

// ═════ 5. mixed run: one fails, one succeeds → ok; the failed one is due tomorrow ═════
reset([mk('g', { lastSearchAt: OLD, updatedAt: OLD, facts: [] }), mk('h', { lastSearchAt: OLD, updatedAt: OLD, facts: [] })]);
searchAnswer = (p) => (p.indexOf('topic-g') >= 0 ? null : goodAnswer('h'));
r = await cron();
ok(pack('g').lastSearchAt === OLD && pack('h').facts.length >= 5, 'mixed: g given back, h saved');
ok(db.hbOk.length === 1 && db.hbOk[0].status === 'ok' && errBeat().length === 0, 'mixed: not every brand failed → heartbeat ok');

// ═════ 6. the lock still holds: two runs at once search each brand once ═════
reset([mk('i', { lastSearchAt: OLD, updatedAt: OLD, facts: [] })]);
searchAnswer = () => null;
await Promise.all([cron(), cron()]);
ok(searchedFor('i') === 1, 'two runs at once: one search for the brand, the other run is refused by the claim (' + searchedFor('i') + ')');
ok(pack('i').lastSearchAt === OLD, 'two runs at once: the failed search still gave the slot back');

// ═════ 7. manual refresh that fails does not cost the brand its week ═════
reset([mk('m', { lastSearchAt: REAL_NOW - 8 * DAY, updatedAt: REAL_NOW - 8 * DAY, facts: [] })]);
db.brands[0].user_id = 'owner'; currentUser = { id: 'owner' };
searchAnswer = () => null;
r = await post({ brandId: 'm', action: 'refresh' });
ok(r.statusCode === 200 && r.body.updated === false && searches.length === 1 && pack('m').lastSearchAt === REAL_NOW - 8 * DAY, 'manual refresh refused by the provider: 200 updated:false, lastSearchAt NOT moved');
r = await post({ brandId: 'm', action: 'refresh' });
ok(r.statusCode === 429 && searches.length === 1, 'manual refresh again at once: still rate-limited (6 h from the failed attempt)');
clock = REAL_NOW + DAY - 60 * 1000;
db.ideas.m = [{ created_at: recent(1), status: 'done' }];
r = await cron();
ok(searchedFor('m') === 2, 'after a failed manual refresh the next daily cron run tries the brand');

// ═════ 8. (r2) BACKOFF: failures in a row wait 12 h × 2^(n−1), capped at 7 days; healthy brands go first ═════
ok(FP.failCooldownMs(1) === 12 * 3600e3 && FP.failCooldownMs(2) === 24 * 3600e3 && FP.failCooldownMs(3) === 48 * 3600e3 && FP.failCooldownMs(4) === 96 * 3600e3,
  'backoff: 12 h, 24 h, 48 h, 96 h for 1..4 failures in a row');
ok(FP.failCooldownMs(5) === 7 * DAY && FP.failCooldownMs(30) === 7 * DAY && FP.failCooldownMs(0) === 0, 'backoff: capped at 7 days; no failure = no wait');
reset([mk('k', { lastSearchAt: OLD, updatedAt: OLD, facts: [] })]);
searchAnswer = () => null;
const ranOn = [];
for (let day = 0; day < 16; day++) {
  clock = REAL_NOW + day * DAY;
  db.ideas.k = [{ created_at: recent(1), status: 'done' }];
  const before = searches.length;
  await cron();
  if (searches.length > before) ranOn.push(day);
}
ok(ranOn.join(',') === '0,1,2,4,8,15', 'a brand that keeps failing is searched on days ' + ranOn.join(',') + ' (want 0,1,2,4,8,15 — not every day)');
ok(pack('k').failCount === 6 && pack('k').lastSearchAt === OLD, 'its failCount counts the failures in a row (6) and lastSearchAt is still the old one');
// a successful search ends the streak
clock = REAL_NOW + 30 * DAY; db.ideas.k = [{ created_at: recent(1), status: 'done' }];
searchAnswer = () => goodAnswer('k');
await cron();
ok(pack('k').facts.length >= 5 && !(pack('k').failCount > 0), 'a successful search resets failCount');
// a real search that finds too few also ends the streak (it was not a failure)
reset([mk('t', { lastSearchAt: OLD, updatedAt: OLD, failedAt: REAL_NOW - 3 * DAY, failCount: 2, facts: [] })]);
searchAnswer = () => oneFact();
await cron();
ok(searches.length === 1 && pack('t').failCount === 0 && pack('t').lastSearchAt > REAL_NOW - 1000, 'too few facts after a real search: failCount reset, week used');
// healthy due brands get the CRON_CAP slots first, even when the failing brand's lastSearchAt is older
const cap = FP.C.CRON_CAP; FP.C.CRON_CAP = 1;
try {
  reset([mk('sick', { lastSearchAt: OLD - 30 * DAY, updatedAt: OLD, failedAt: REAL_NOW - 3 * DAY, failCount: 2, facts: [] }),
         mk('well', { lastSearchAt: OLD, updatedAt: OLD, facts: [] })]);
  searchAnswer = (q) => goodAnswer((q.match(/topic-(\w+)/) || [])[1] || 't');
  await cron();
  ok(searchedFor('well') === 1 && searchedFor('sick') === 0, 'CRON_CAP=1: the healthy brand is searched before the backed-off one (well=' + searchedFor('well') + ', sick=' + searchedFor('sick') + ')');
} finally { FP.C.CRON_CAP = cap; }
// manual refresh may still try during the backoff (only the 6 h rule applies)
reset([mk('mb', { lastSearchAt: OLD, updatedAt: OLD, failedAt: REAL_NOW - 7 * 3600e3, failCount: 4, facts: [] })]);
db.brands[0].user_id = 'owner'; currentUser = { id: 'owner' };
searchAnswer = () => goodAnswer('mb');
r = await post({ brandId: 'mb', action: 'refresh' });
ok(r.statusCode === 200 && r.body.updated === true && searches.length === 1, 'manual refresh during a 4-day backoff (7 h after the failure): allowed, searched, saved');
reset([mk('mc', { lastSearchAt: OLD, updatedAt: OLD, failedAt: REAL_NOW - 3600e3, failCount: 4, facts: [] })]);
db.brands[0].user_id = 'owner';
r = await post({ brandId: 'mc', action: 'refresh' });
ok(r.statusCode === 429 && searches.length === 0, 'manual refresh 1 h after a failure: still the 6 h rule');

clearTimeout(WALL);
if (failed) { console.log('fact-pack-v710: ' + failed + ' failed, ' + passed + ' passed'); process.exit(1); }
console.log('PASS — fact-pack-v710: ' + passed + ' checks');
