// content-v3 F2 — how did the posted video do? (.unlazy/content-v3/PLAN.md, F2 RESULTS)
//
// POST /api/idea-result
//   {ideaId, result:'flop'|'ok'|'great', postUrl?, hookUsed?}          -> 200 {ok:true, result, resultAt, updated}
//   {brandId, title, result, postUrl?, hookUsed?}                     (same, located by brand + title)
//     postUrl   omitted = unchanged; null or '' = cleared; else https only, <= 500 characters
//     hookUsed  omitted = unchanged; null = unknown; else an integer 0..2 (and inside hook_alts
//               when the idea has them)
//   400 bad_input · 401 · 403 forbidden · 404 not_found · 503 results_not_ready (the SQL
//   sql/idea-results.sql has not run) · 503 access_check_failed / result_read_failed /
//   result_write_failed / result_write_unknown / timeout
//
// WHY BRAND + TITLE AS WELL AS AN ID: the app saves an idea by writing a fresh copy and deleting the
// old row (app.html "WRITE-BEFORE-DELETE"), so an idea's database id changes on every save, while
// brand + title is how the app itself finds a row. Both are accepted; an id is tried as given.
//
// No AI call, no credits: this records the founder's own verdict. Access is the same decision every
// brand endpoint makes (owner or member, store.userCanAccessBrand), taken from the IDEA's brand_id,
// never from a brand id the caller claims for an id lookup.
//
// A FAILED READ IS NOT AN ANSWER (same rule as api/brand-memory.js): store.rest RESOLVES on every
// HTTP status, so every read checks the status AND the array before believing it.
const store = require('./_publish/store');
const requireUser = require('./_requireUser');

const RESULTS = ['flop', 'ok', 'great'];
const URL_MAX = 500;
const TITLE_MAX = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INT_ID = /^[1-9][0-9]{0,17}$/;

const enc = encodeURIComponent;
const okRows = r => !!r && r.status >= 200 && r.status < 300 && Array.isArray(r.data);
// PGRST204 = PostgREST does not know a column in the body; 42703 = Postgres "column does not
// exist" (a select or filter naming it). Either way sql/idea-results.sql has not run.
const colsMissing = r => !!(r && r.data && typeof r.data === 'object' &&
  (r.data.code === 'PGRST204' || r.data.code === '42703'));
// A gateway page in front of PostgREST (or no reply at all): the write may already have committed.
function outcomeUnknown(r) {
  if (!r || r.status == null) return true;
  if (r.status === 502 || r.status === 503 || r.status === 504) return true;
  return r.status >= 500 && !(r.data && typeof r.data === 'object' && r.data.code);
}

// Mutable so the gate can shrink them. maxDuration is 30 s in vercel.json: 25 s of work, and no call
// starts with less than store.js's 8 s silence timeout + 1 s left; a call that overruns what is left
// is abandoned, so the function always answers before the platform kills it.
const TIMING = { deadlineMs: 25000, minCallMs: 9000 };
function deadlineError() { const e = new Error('idea-result ran out of time'); e.deadline = true; return e; }

function notReady(res) {
  return res.status(503).json({ code: 'results_not_ready',
    error: "Results aren't set up on the server yet, so nothing was saved." });
}
function bad(res, error) { return res.status(400).json({ code: 'bad_input', error }); }

// postUrl: undefined = leave as is; null = clear; string = validated https link.
function cleanUrl(v) {
  if (v === undefined) return { keep: true };
  if (v === null || (typeof v === 'string' && !v.trim())) return { value: null };
  if (typeof v !== 'string') return { error: 'postUrl must be a link.' };
  const s = v.trim();
  if (s.length > URL_MAX) return { error: 'That link is too long (max ' + URL_MAX + ' characters).' };
  if (/\s/.test(s)) return { error: 'That link has spaces in it.' };
  let u;
  try { u = new URL(s); } catch (e) { return { error: "That doesn't look like a link." }; }
  if (u.protocol !== 'https:' || !u.hostname) return { error: 'The link must start with https://' };
  return { value: s };
}

module.exports = async function handler(req, res) {
  const allowed = ['https://contentshrimp.com', 'https://bettercontent.app', 'https://boring-engine.vercel.app'];
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ONE REQUEST DEADLINE for every database call, auth included.
  const endAt = Date.now() + TIMING.deadlineMs;
  const timed = async (fn) => {
    const left = endAt - Date.now();
    if (left < TIMING.minCallMs) throw deadlineError();
    let h = null;
    try { return await Promise.race([Promise.resolve().then(fn), new Promise((_, rej) => { h = setTimeout(() => rej(deadlineError()), left); })]); }
    finally { if (h) clearTimeout(h); }
  };
  const tooSlow = (written) => res.status(503).json({ code: written ? 'result_write_unknown' : 'timeout',
    error: written ? "We couldn't confirm whether that was saved. Refresh and check the idea."
      : 'That took too long, so nothing was changed. Try again in a moment.' });
  let phase = 'before';

  try {
    const user = await timed(() => requireUser(req));
    if (!user) return res.status(401).json({ error: 'Please sign in again.' });

    // ── input ──
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    const result = typeof body.result === 'string' ? body.result.trim().toLowerCase() : '';
    if (!RESULTS.includes(result)) return bad(res, 'result must be flop, ok or great.');
    const ideaId = body.ideaId == null ? '' : String(body.ideaId).trim();
    const brandId = body.brandId == null ? '' : String(body.brandId).trim();
    const title = typeof body.title === 'string' ? body.title.replace(/\s+/g, ' ').trim() : '';
    let where;
    if (ideaId) {
      if (!UUID.test(ideaId) && !INT_ID.test(ideaId)) return bad(res, 'Invalid ideaId.');
      where = '/ideas?id=eq.' + enc(ideaId);
    } else {
      if (!UUID.test(brandId)) return bad(res, 'Send ideaId, or brandId and title.');
      if (!title || title.length > TITLE_MAX) return bad(res, 'Send ideaId, or brandId and title.');
      where = '/ideas?brand_id=eq.' + enc(brandId) + '&title=eq.' + enc(title);
    }
    const url = cleanUrl(body.postUrl);
    if (url.error) return bad(res, url.error);
    let hookUsed;                                 // undefined = unchanged
    if (body.hookUsed === null) hookUsed = null;
    else if (body.hookUsed !== undefined) {
      const n = body.hookUsed;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 2) return bad(res, 'hookUsed must be 0, 1 or 2.');
      hookUsed = n;
    }

    // ── the idea, and whose it is ──
    const found = await timed(() => store.rest('GET', where + '&select=id,brand_id,hook_alts&limit=20'));
    if (colsMissing(found)) return notReady(res);
    if (!okRows(found)) {
      return res.status(503).json({ code: 'result_read_failed', error: "Couldn't load that idea right now, so nothing was saved. Try again in a moment." });
    }
    if (!found.data.length) return res.status(404).json({ code: 'not_found', error: 'That idea was not found.' });
    const brand = String(found.data[0].brand_id || '');
    // Every row located must belong to that one brand (a brand + title lookup always does).
    if (!brand || found.data.some(r => String(r.brand_id || '') !== brand)) {
      return res.status(404).json({ code: 'not_found', error: 'That idea was not found.' });
    }
    let can = false;
    try { can = await timed(() => store.userCanAccessBrand(user.id, brand)); }
    catch (e) {
      if (e && e.deadline) throw e;
      return res.status(503).json({ code: 'access_check_failed',
        error: "Couldn't confirm your access to this brand right now, so nothing was saved. Try again in a moment." });
    }
    if (!can) return res.status(403).json({ code: 'forbidden', error: "You don't have access to this idea." });

    if (hookUsed != null) {
      const alts = found.data[0].hook_alts;
      if (Array.isArray(alts) && alts.length && hookUsed >= alts.length) {
        return bad(res, 'hookUsed must point at one of the ' + alts.length + ' hooks this idea has.');
      }
    }

    // ── the write (service role), scoped to the brand the access check just approved ──
    const resultAt = new Date().toISOString();
    const patch = { result, result_at: resultAt };
    if (!url.keep) patch.post_url = url.value;
    if (hookUsed !== undefined) patch.hook_used = hookUsed;
    // phase flips to 'writing' only once the call is really sent (timed() may refuse to start it).
    const w = await timed(() => { phase = 'writing'; return store.rest('PATCH', where + '&brand_id=eq.' + enc(brand), { body: patch }); });
    phase = 'after';
    if (colsMissing(w)) return notReady(res);
    if (outcomeUnknown(w)) return tooSlow(true);
    if (w && w.data && w.data.code === '23514') return bad(res, 'That value is not allowed.');
    if (!okRows(w)) {
      return res.status(503).json({ code: 'result_write_failed', error: "Couldn't save that right now, so nothing was changed. Try again in a moment." });
    }
    // Deleted between the read and the write (e.g. the app re-saved the idea under a new id).
    if (!w.data.length) return res.status(404).json({ code: 'not_found', error: 'That idea was not found.' });
    return res.status(200).json({ ok: true, result, resultAt, updated: w.data.length });
  } catch (e) {
    console.error('idea-result: failed (' + phase + '):', (e && e.message) || e);
    if (phase === 'writing') return tooSlow(true);
    if (e && e.deadline) return tooSlow(false);
    return res.status(503).json({ code: 'result_write_failed', error: "Couldn't save that right now, so nothing was changed. Try again in a moment." });
  }
};

module.exports.TIMING = TIMING;
module.exports.RESULTS = RESULTS;
