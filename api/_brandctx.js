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
//
//   5. EXEMPLAR SELECTION is byte-equivalent only when the caller passes `humanEdited`. Which
//      approved posts the user REWROTE is derivable only from the client's localStorage edit
//      signals, so the client sends those titles (`humanEditedTitles`). Without them this module
//      can rank by recency alone, which is NOT what the client did — see approvedExamplesFrom.

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
//
// `humanEdited` carries the titles of posts the user actually REWROTE (the client derives them
// from its localStorage edit signals and sends them as `humanEditedTitles`). Those words are
// genuinely the founder's; every other "approved" post is one tap on text THIS APP wrote.
//
// THE BUG THIS FIXES — humanEdited used to arrive AFTER selection and only RE-ORDER the handful
// already picked, while the picking itself was pure recency. The client does the opposite: it
// moves the rewritten winners to the END of the array and then slices the TAIL, so the slice
// LANDS ON them. Measured with 6 approved video posts where post 2 was hand-rewritten: the server
// returned posts 4, 5, 6 and the founder's own words never reached the model at all; the client
// returned 5, 6 and post 2. Two-stage damage, because with no edited example surviving selection
// approvedWinnersBlock (api/_brain.js) also falls back to its WEAKER heading — the one telling the
// model these posts were machine-written and that the brand description is the stronger signal.
// So the product actively instructed the model to discount its only real voice evidence.
//
// Selection now happens HERE, on the full candidate list, exactly the way the client did it:
// human-rewritten first, recency as the tiebreak among equals, same per-bucket counts as before.
// `caps` names those counts explicitly ({same, other}) so adding candidates to the pool below can
// never silently change how many exemplars come back. With no humanEdited list every candidate
// ranks equal and the result is the plain most-recent set — byte-identical to the old behaviour.
function approvedExamplesFrom(sameFmtIdeas, otherFmtIdeas, humanEdited, caps) {
  const norm = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
  const human = new Set((Array.isArray(humanEdited) ? humanEdited : []).map(norm).filter(Boolean));
  const c = caps || {};
  const sameCap = c.same == null ? 3 : c.same;
  const otherCap = c.other == null ? 2 : c.other;
  // Candidates arrive OLDEST-FIRST (the order app.html's `state` array holds). Move the rewritten
  // ones to the end and take the TAIL — the literal shape of getApprovedExamples, so recency still
  // decides within each group and the rewritten ones are what the slice lands on.
  const pick = (rows, n) => {
    if (!(n > 0)) return [];
    const list = (rows || []).map(i => Object.assign({}, i, { _edited: human.has(norm(i && i.title)) }));
    return list.filter(i => !i._edited).concat(list.filter(i => i._edited)).slice(-n);
  };
  const out = []
    .concat(pick(sameFmtIdeas, sameCap), pick(otherFmtIdeas, otherCap))
    .slice(0, 4)
    .map(i => Object.assign(exampleFromIdea(i), { edited: !!(i && i._edited) }))
    .filter(e => e.text)
    .slice(0, 4);
  // Rewritten first — approvedWinnersBlock renders and labels the two groups differently.
  return out.filter(e => e.edited).concat(out.filter(e => !e.edited));
}

// EXACT mirror of app.html getLearnedSignalsCompact().
function learnedSignalsFrom(approvedTitles, dismissedTitles) {
  const up = (approvedTitles || []).filter(Boolean);
  const down = (dismissedTitles || []).filter(Boolean);
  /* v665: BUDGET BOTH HALVES, AND NEVER CUT MID-HEADING.
     This built APPROVED first, then DISMISSED, then blind-sliced the whole thing at 500 — so the
     approved half always won the budget and the dismissed half was always what got cut. Measured
     against titles at the length this app's own generator produces: 0 of 6 dismissed titles
     survived, and the string ended on the bare fragment "Recently DISMISSED (avoid these" with
     nothing under it. Every "no" the user had given was invisible to the gatherer, so the app
     kept proposing the angles they kept rejecting — and the prompt carried a dangling heading,
     the exact failure _brain.js was rewritten to make impossible.
     Now each half gets its own share, whole titles are dropped rather than cut in half, and a
     heading is only written if something survives to sit under it. */
  const HALF = 240;
  const packed = (arr) => {
    const out = [];
    let used = 0;
    for (const raw of arr) {
      const t = String(raw).trim();
      if (!t) continue;
      const cost = t.length + (out.length ? 3 : 0);   // ' · '
      if (used + cost > HALF) break;
      out.push(t); used += cost;
    }
    return out;
  };
  const upKeep = packed(up);
  const downKeep = packed(down);
  const parts = [];
  if (upKeep.length) parts.push('Recently APPROVED (favor topics/angles like these): ' + upKeep.join(' · '));
  if (downKeep.length) parts.push('Recently DISMISSED (avoid these): ' + downKeep.join(' · '));
  return parts.join('  |  ');
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

// The cron refreshes the competitor pulse every 7 days (COMP_STALE_MS in api/pull-trends.js and
// api/pull-trends-cron.js). This is the separate, harder limit: how old a digest may be and still
// be shown to the model as "recent".
const COMP_MAX_AGE_MS = 28 * 24 * 3600 * 1000;

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
    // v665 — "RECENT competitor moves" MUST ACTUALLY BE RECENT.
    // The cron REFRESHES this weekly but nothing ever EXPIRES it: if the refresh stops succeeding
    // — the XAI key is rotated out, the competitors field is cleared, the pulse returns '' — the
    // last digest is carried forward untouched, run after run, and rendered to the model under
    // "Recent competitor moves (what rivals just did — products, pricing, campaigns, posts)" with
    // "Differentiate from, counter, or ride the same wave better than them." A digest from months
    // ago is not just useless there, it is actively wrong: the app tells the model to counter a
    // campaign that ended. Four weeks is generous against a weekly refresh — anything older means
    // the refresh has failed roughly four times running, and silence is more honest than a stale
    // claim. `compAt` of 0 means the age is unknown, which is not evidence of freshness.
    competitorMoves: (at.competitorMoves && (Date.now() - (+at.compAt || 0)) <= COMP_MAX_AGE_MS)
      ? at.competitorMoves : '',
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
  // created_at travels so the merged candidate list below can be put back in true recency order.
  // rowToIdea ignores it, so nothing it feeds ever sees the extra column.
  const EX_COLS = 'select=title,format,hook,script,bold_text,caption,created_at';
  const f = String(fmt || '').trim();

  // Ordered created_at.desc + reversed == the tail of the client's `state` array, which is
  // append-ordered and re-persisted in that order. Two narrow queries (3 same-format, 2
  // other-format) reproduce getApprovedExamples' slice(-3)/slice(-2) exactly, without
  // dragging a whole idea library across the wire.
  //
  // HOW MANY WE RETURN IS UNCHANGED (3 same-format + 2 other, capped at 4; 4 when no format is
  // known) — `EX_CAPS` is the single place that decides it, and the two recency queries below keep
  // their original limits, so a brand with no rewritten posts issues byte-identical SQL.
  const EX_CAPS = { same: f ? 3 : 4, other: f ? 2 : 0 };
  // WHICH POSTS THE FOUNDER REWROTE — FROM THE DATABASE, NOT FROM ONE DEVICE.
  //
  // v665. This list used to arrive ONLY in the request body (`humanEditedTitles`), derived from
  // the caller's localStorage. Two consequences, both measured in the source:
  //   * api/send-daily.js has no client, so it could never send it — and that is the ONE post the
  //     app pushes unprompted every day. With no rewritten exemplar surviving selection,
  //     approvedWinnersBlock (api/_brain.js) falls back to its WEAKER heading: the one telling the
  //     model these posts were machine-written and the brand description is the stronger signal.
  //     The app's most visible output was the one actively told to discount the real voice.
  //   * a second device knew nothing about rewrites made on the first.
  // `edit_signals` has carried a durable copy of every rewrite since sql/edit-signals.sql, so the
  // knowledge was already there — nothing read it. Now it does, and ONLY when the caller sent
  // nothing, so a request that DOES carry the client's list issues byte-identical queries.
  //
  // `authored_by=is.null` keeps out signals the MODEL wrote (Sharpen and Viral twist record a
  // before/after whose `after` is the model's own rewrite). Rows written before that column
  // existed are null and count as human — the same conservative reading the client uses, and the
  // reason the query must not fail when the column is missing: getRows yields null, the second
  // read runs unfiltered, and if that fails too selection degrades to plain recency — the old
  // behaviour, never an error.
  let humanEdited = (Array.isArray(opts.humanEdited) ? opts.humanEdited : []).filter(Boolean).slice(0, 8);
  if (!humanEdited.length) {
    const sigPath = q => '/edit_signals?brand_id=eq.' + encodeURIComponent(brandId) + '&' + q;
    const COLS = 'select=title&title=not.is.null&order=created_at.desc&limit=40';
    let sigRows = await getRows(sigPath('authored_by=is.null&' + COLS));
    if (sigRows == null) sigRows = await getRows(sigPath(COLS));   // column not added yet
    const seen = new Set();
    for (const r of (sigRows || [])) {
      const t = clean(r && r.title);
      if (!t || seen.has(t)) continue;
      seen.add(t);
      if (seen.size >= 8) break;
    }
    humanEdited = Array.from(seen);
  }

  const sameQ = f
    ? ideasPath(brandId, APPROVED + '&format=eq.' + encodeURIComponent(f) + '&' + EX_COLS + '&order=created_at.desc&limit=' + EX_CAPS.same)
    : ideasPath(brandId, APPROVED + '&' + EX_COLS + '&order=created_at.desc&limit=' + EX_CAPS.same);
  const otherQ = f
    ? ideasPath(brandId, APPROVED + '&format=neq.' + encodeURIComponent(f) + '&' + EX_COLS + '&order=created_at.desc&limit=' + EX_CAPS.other)
    : null;

  // THE POSTS THE FOUNDER REWROTE, FETCHED BY NAME.
  // Ranking by human provenance is worthless if the rewritten post was never fetched — and it
  // usually is not, because the post someone took the trouble to rewrite is rarely one of the
  // three most recent. Widening the recency window to cover it would mean dragging a large slice
  // of the idea library across the wire on EVERY generate. The client already knows exactly which
  // titles they are and sends at most eight, so ask for those eight directly: one extra, tiny
  // query, and only for brands that actually have rewritten posts. Values are quoted and escaped
  // because titles are user text (a comma or a quote in a title must not become a separator).
  // If it fails, getRows() yields null -> [] and selection degrades to plain recency — the old
  // behaviour, never an error.
  const inList = vals => 'in.(' + vals
    .map(v => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(',') + ')';
  const editedQ = humanEdited.length
    ? ideasPath(brandId, APPROVED + '&' + EX_COLS + '&title=' + encodeURIComponent(inList(humanEdited)) +
        '&order=created_at.desc&limit=8')
    : null;

  let brandRes, sameRows, otherRows, editedRows, upRows, downRows, avoidRows;
  try {
    [brandRes, sameRows, otherRows, editedRows, upRows, downRows, avoidRows] = await Promise.all([
      store.rest('GET', '/brands?id=eq.' + encodeURIComponent(brandId) + '&select=' + BRAND_ROW_COLUMNS),
      getRows(sameQ),
      otherQ ? getRows(otherQ) : Promise.resolve([]),
      editedQ ? getRows(editedQ) : Promise.resolve([]),
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
  // The rewritten posts are folded into whichever bucket their format belongs to, de-duplicated
  // against the recency rows and re-sorted oldest-first, so approvedExamplesFrom sees the same
  // shape of list the client's `state` array gave getApprovedExamples.
  const merge = (recent, extra) => {
    // Each list arrives created_at.desc; reversing it is what turned it into the client's
    // oldest-first `state` order before this change, and it still is. Only when the two lists are
    // actually merged, AND every row carries a created_at, is a sort needed to interleave them —
    // so a caller (or a test double) whose rows have no timestamp keeps the old, correct order
    // instead of being silently re-ordered by a comparator with nothing to compare.
    const rows = (recent || []).slice().reverse();
    // Nothing to merge (no rewritten posts, i.e. every brand that had none before) — return the
    // reversed recency list untouched, so that path stays literally the code it always was.
    if (!(extra && extra.length)) return rows.map(rowToIdea);
    rows.push.apply(rows, (extra || []).slice().reverse());
    if (rows.every(r => r && r.created_at)) {
      rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    }
    const seen = new Set(), out = [];
    for (const r of rows) {
      const k = JSON.stringify([r.title, r.format, r.hook, r.script, r.bold_text, r.caption, r.created_at]);
      if (seen.has(k)) continue;
      seen.add(k); out.push(rowToIdea(r));
    }
    return out;
  };
  const ed = editedRows || [];
  const same = merge(sameRows, f ? ed.filter(r => r.format === f) : ed);
  const other = merge(otherRows, f ? ed.filter(r => r.format !== f) : []);
  bc.approvedExamples = approvedExamplesFrom(same, other, humanEdited, EX_CAPS);

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
