// Server-side brand-brain hydration for the LEAN Quick Post request.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
// getBrandContext() (app.html) posts a ~13KB snapshot of the whole brand on EVERY
// generate, plus a ~2KB learningContext. On the owner's MEASURED 0.06-0.13 KB/s mobile
// link that is ~100-220s of pure upload before the model even starts — which is why his
// phone showed "Timed out" four times while the Vercel log shows /api/generate-ideas
// returning 200 each time. The server WROTE the post; the upload outlasted the client.
//
// Almost all of that snapshot is already in the database, keyed by the brand id the
// request can carry. So: the client stops uploading it, and this module loads it.
//
// ── THE THINGS THAT ARE **NOT** IN THE DATABASE — do not "simplify" these away ───
//   1. Trends the user typed in by hand live ONLY in localStorage ('brand_trends',
//      read by getTrendStore()). They were never written to any table.
//   2. Auto-trend DISMISSALS live ONLY in localStorage ('auto_trends_dismissed').
//      getAutoTrends() filters them out; a naive server read resurrects the exact
//      off-topic headlines the user already killed.
//   3. `approveReason` ("what made this one land?") is kept in the localStorage state
//      snapshot; the `ideas` table has no column for it.
//   4. `tv_recent` (the last 12 Quick Post titles) is localStorage-only.
// So this module NEVER rebuilds recentTrends — the client still sends the final merged
// array — and it never rebuilds learningContext. Both of those would be a silent,
// invisible quality regression, which is exactly the failure this change must not cause.
//
// Everything else below is loaded from `brands` / `ideas` and is byte-equivalent to what
// the client used to upload. The column mapping is the same one settingsToBrand() /
// brandToSettings() use in app.html — if you add a brand field there, add it here.

const store = require('./_publish/store');

const clean = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

// EXACT mirror of app.html getApprovedExamples()'s per-idea mapping. The approved BODY is
// the richest voice sample in the system; the hook teaches something different, so it is
// folded in alongside rather than sent as a separate (never-read) field.
function exampleFromIdea(i) {
  const body = clean(i.script || i.boldText || i.caption || i.title || '');
  const hook = clean(i.hook || '');
  let text = body;
  if (hook && !body.toLowerCase().startsWith(hook.toLowerCase().slice(0, 40))) {
    text = body ? (hook + ' — ' + body) : hook;
  }
  return { title: clean(i.title || ''), format: (i.format || ''), text: text.slice(0, 1600) };
}

// EXACT mirror of app.html getApprovedExamples(fmt): lead with same-format winners (max 3),
// fill with the two most recent others, cap at 4, drop anything with no text.
// v640: `humanEdited` accepts the titles of posts the user actually REWROTE. That fact lives in
// the client's localStorage edit signals, so this hydration cannot derive it — and without it every
// winner is presented to the model as equal "approved" evidence, which is how the app ended up
// telling Grok that its own unedited output was the truest statement of the brand's voice.
// Rewritten posts are marked and sorted first; with no list the behaviour is exactly as before.
function approvedExamplesFrom(sameFmtIdeas, otherFmtIdeas, humanEdited) {
  const norm = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
  const human = new Set((Array.isArray(humanEdited) ? humanEdited : []).map(norm).filter(Boolean));
  const out = []
    .concat(sameFmtIdeas || [], otherFmtIdeas || [])
    .slice(0, 4)
    .map(i => Object.assign(exampleFromIdea(i), { edited: human.has(norm(i && i.title)) }))
    .filter(e => e.text)
    .slice(0, 4);
  // Rewritten first — approvedWinnersBlock renders and labels the two groups differently.
  return out.filter(e => e.edited).concat(out.filter(e => !e.edited));
}

// EXACT mirror of app.html getLearnedSignalsCompact().
function learnedSignalsFrom(approvedTitles, dismissedTitles) {
  const up = (approvedTitles || []).filter(Boolean);
  const down = (dismissedTitles || []).filter(Boolean);
  let s = '';
  if (up.length) s += 'Recently APPROVED (favor topics/angles like these): ' + up.join(' · ');
  if (down.length) s += (s ? '  |  ' : '') + 'Recently DISMISSED (avoid these): ' + down.join(' · ');
  return s.slice(0, 500);
}

// The 30 brand-context keys getBrandContext() produces, minus the four the client still
// sends (communities/dayMap/recentTrends are client-truth; approvedExamples is derived
// below from `ideas`). Kept as a list so the gate can enumerate it.
const BRAND_ROW_COLUMNS =
  'brand_name,website,tagline,usps,tones,communities,target_audience,competitors_text,banned_topics,day_rotation,voice_extra,auto_trends';

// EXACT mirror of app.html getDayCommunities(): the stored rotation merged over the
// all-"General" defaults, or auto-built from the communities list when no rotation is set.
// Nothing in the ideas prompt reads bc.dayRotation (only mode:'scenes' does), but leaving it
// raw here would make the hydrated context differ from the uploaded one, and "close enough"
// is how a field quietly stops matching.
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'Bonus'];
const DAY_COMMUNITIES_DEFAULT = {
  Monday: 'General', Tuesday: 'General', Wednesday: 'General', Thursday: 'General',
  Friday: 'General', Saturday: 'General', Sunday: 'General', Bonus: 'All',
};
function dayCommunitiesFrom(dayRotation, communities) {
  const dr = dayRotation && Object.keys(dayRotation).length > 0 ? dayRotation : null;
  if (dr) return Object.assign({}, DAY_COMMUNITIES_DEFAULT, dr);
  const comms = Array.isArray(communities) ? communities.filter(Boolean) : [];
  if (comms.length > 0) {
    const weekDays = DAYS.filter(d => d !== 'Bonus');
    const built = { Bonus: 'All' };
    weekDays.forEach((d, i) => { built[d] = comms[i % comms.length]; });
    return Object.assign({}, DAY_COMMUNITIES_DEFAULT, built);
  }
  return Object.assign({}, DAY_COMMUNITIES_DEFAULT);
}

function contextFromBrandRow(b) {
  const v = (b && b.voice_extra) || {};
  const at = (b && b.auto_trends) || {};
  return {
    brandName: b.brand_name || '',
    website: b.website || '',
    tagline: b.tagline || '',
    usps: b.usps || '',
    targetAudience: b.target_audience || '',
    tones: Array.isArray(b.tones) ? b.tones : [],
    communities: Array.isArray(b.communities) ? b.communities : [],
    competitors: b.competitors_text || '',
    bannedTopics: b.banned_topics || '',
    painPoints: v.painPoints || '',
    brandVocab: v.brandVocab || '',
    avoidWords: v.avoidWords || '',
    productDetails: v.productDetails || '',
    exampleContent: v.exampleContent || '',
    ctaStyle: v.ctaStyle || '',
    originStory: v.originStory || '',
    socialProof: v.socialProof || '',
    webMentions: v.webMentions || '',
    categoryGripes: v.categoryGripes || '',
    reviewInsights: v.reviewInsights || '',
    channels: v.channels || '',
    visualStyle: v.visualStyle || '',
    coachNotes: v.coachNotes || '',
    voiceSample: v.voiceSample || '',   // v649 — the founder's spoken transcript; the lean path must carry it or Quick Post loses the voice
    voiceLog: Array.isArray(v.voiceLog) ? v.voiceLog.slice(-8) : [],   // v650 — recent things they said into the app's mics
    competitorMoves: at.competitorMoves || '',
    dayRotation: dayCommunitiesFrom(b.day_rotation, b.communities),
    // The app is Grok-only; app.html's getEngine() hard-returns this.
    engine: 'grok',
  };
}

// How many brand fields actually carry content. The client sends the same count for its
// LOCAL settings (`bcFields`); a gross mismatch means the DB row is stale or wrong, and the
// caller re-sends the full context rather than quietly writing against a half-empty brain.
function populatedFieldCount(bc) {
  let n = 0;
  for (const k of Object.keys(bc || {})) {
    if (k === 'engine' || k === 'dayRotation') continue;
    const val = bc[k];
    if (Array.isArray(val)) { if (val.length) n++; }
    else if (val && String(val).trim()) n++;
  }
  return n;
}

function rowToIdea(r) {
  return {
    title: r.title, format: r.format, hook: r.hook,
    script: r.script, boldText: r.bold_text, caption: r.caption,
  };
}

function ideasPath(brandId, q) {
  return '/ideas?brand_id=eq.' + encodeURIComponent(brandId) + '&' + q;
}

async function getRows(path) {
  const r = await store.rest('GET', path);
  if (!r || r.status >= 300 || !Array.isArray(r.data)) return null;
  return r.data;
}

/**
 * Load the brand snapshot the client used to upload.
 *
 * @param {string} brandId
 * @param {object} opts  { userId, trusted } — a userId is REQUIRED. A caller that genuinely
 *                       has no user (an internal job acting on its own behalf) must say so
 *                       explicitly with `trusted: true`; see the fail-closed note below
 *                       before you reach for it.
 * @param {string} fmt   target content format, so approved winners are format-matched.
 * @returns {{ok:true, bc:object, avoidTitles:string[], fields:number} | {ok:false, reason:string}}
 */
async function loadBrandContext(brandId, opts = {}, fmt = '') {
  if (!brandId) return { ok: false, reason: 'no_brand_id' };
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, reason: 'no_service_key' };
  }

  // Authorize BEFORE reading anything, so an unowned brand id never pulls rows.
  //
  // FAIL CLOSED. This used to read `if (opts.userId) { ...check... }`, which made the
  // authorization OPTIONAL on the function whose entire job is the access decision: any
  // caller that passed no user id got a brand's fully rendered brain — voice, painPoints,
  // productDetails, coachNotes, approved winners — with no check whatsoever. There was
  // exactly one such call site (generate-ideas.js on its CRON_SECRET path, which passes
  // `userId: null`), and "exactly one" is the whole problem: an opt-in check is only ever
  // one forgetful caller away from being no check at all.
  //
  // `trusted: true` exists so a genuine no-user internal job can still be written, but it
  // must be typed out at the call site where a reviewer can see it. Do NOT wire it to
  // "the request carried a shared secret" — a secret proves the CALLER, never which brand
  // that caller is entitled to read, and that substitution is the hole this closes.
  if (opts.trusted !== true) {
    if (!opts.userId) return { ok: false, reason: 'no_user' };
    let allowed = false;
    try { allowed = await store.userCanAccessBrand(opts.userId, brandId); }
    catch (e) { return { ok: false, reason: 'access_check_failed' }; }
    if (!allowed) return { ok: false, reason: 'forbidden' };
  }

  const APPROVED = 'status=in.(filming,done)';
  const EX_COLS = 'select=title,format,hook,script,bold_text,caption';
  const f = String(fmt || '').trim();

  // Ordered created_at.desc + reversed == the tail of the client's `state` array, which is
  // append-ordered and re-persisted in that order. Two narrow queries (3 same-format, 2
  // other-format) reproduce getApprovedExamples' slice(-3)/slice(-2) exactly, without
  // dragging a whole idea library across the wire.
  const sameQ = f
    ? ideasPath(brandId, APPROVED + '&format=eq.' + encodeURIComponent(f) + '&' + EX_COLS + '&order=created_at.desc&limit=3')
    : ideasPath(brandId, APPROVED + '&' + EX_COLS + '&order=created_at.desc&limit=4');
  const otherQ = f
    ? ideasPath(brandId, APPROVED + '&format=neq.' + encodeURIComponent(f) + '&' + EX_COLS + '&order=created_at.desc&limit=2')
    : null;

  let brandRes, sameRows, otherRows, upRows, downRows, avoidRows;
  try {
    [brandRes, sameRows, otherRows, upRows, downRows, avoidRows] = await Promise.all([
      store.rest('GET', '/brands?id=eq.' + encodeURIComponent(brandId) + '&select=' + BRAND_ROW_COLUMNS),
      getRows(sameQ),
      otherQ ? getRows(otherQ) : Promise.resolve([]),
      getRows(ideasPath(brandId, APPROVED + '&select=title&order=created_at.desc&limit=8')),
      getRows(ideasPath(brandId, 'status=eq.dismissed&select=title&order=created_at.desc&limit=6')),
      getRows(ideasPath(brandId, 'select=title&order=created_at.desc&limit=40')),
    ]);
  } catch (e) {
    return { ok: false, reason: 'db_error' };
  }

  const row = brandRes && Array.isArray(brandRes.data) ? brandRes.data[0] : null;
  if (!row) return { ok: false, reason: 'brand_not_found' };

  const bc = contextFromBrandRow(row);

  // Winners: reverse each desc list back to oldest-first, then same+other, exactly as the
  // client does. A failed sub-query yields [] rather than a wrong exemplar set.
  const same = (sameRows || []).slice().reverse().map(rowToIdea);
  const other = (otherRows || []).slice().reverse().map(rowToIdea);
  bc.approvedExamples = approvedExamplesFrom(same, other, opts.humanEdited);

  bc.learnedSignals = learnedSignalsFrom(
    (upRows || []).slice().reverse().map(r => r.title),
    (downRows || []).slice().reverse().map(r => r.title)
  );

  // The library half of Quick Post's anti-repetition avoid-list. The client keeps sending
  // its localStorage-only `tv_recent`; these are the ~40 titles it used to re-upload.
  const avoidTitles = (avoidRows || []).slice().reverse().map(r => String(r.title || '').trim()).filter(Boolean);

  return { ok: true, bc, avoidTitles, fields: populatedFieldCount(bc) };
}

module.exports = {
  loadBrandContext,
  // exported for the gate
  contextFromBrandRow,
  approvedExamplesFrom,
  learnedSignalsFrom,
  exampleFromIdea,
  populatedFieldCount,
  dayCommunitiesFrom,
  BRAND_ROW_COLUMNS,
};
