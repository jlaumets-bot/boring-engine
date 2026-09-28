'use strict';
/* v693 — THE CONTENT-V2 WRITING PIPELINE (.unlazy/content-v2/PLAN.md, contract C-LIB).

   Why it exists: the old flow asked one low-effort call for five finished ideas at once, squeezed
   into boxes, clipped by rules ("max ~8 words", "a number beats an adjective" -> invented prices),
   fed a 9-tone profile and ad-like USPs. The owner's own process is: idea -> a few beliefs -> pick
   one -> write only that one, with [your story: ...] slots where proof belongs -> say it out loud.
   That is this file:

     runAngles  source -> 5-8 beliefs the audience does NOT share yet (one JSON call)
     runWrite   one belief -> (1) a plain-text spoken draft
                             -> (2) a spoken pass in the person's own speech rhythm
                             -> (3) a small JSON call that derives title/hook/caption/etc AROUND the
                                    script without being allowed to change it

   Words first, boxes after. Every call passes `provider` and `effort` straight to callLLM (leaf-T
   implements them; callLLM ignores options it does not know). Nothing here meters or logs usage:
   the endpoints (api/angles.js, api/write.js) and the blind test decide that. */

const crypto = require('crypto');
const { fullBrandBlock, v2Tones, extractJson, toStr, NO_INVENTION_RULE } = require('./_brain');

// v693 — looked up at CALL time, not destructured at load: a harness or the blind test that swaps
// ./_llm in the require cache after this file loaded must still be the one that gets called.

/* v693 r3 — THE WRITERS' DEPTH AND PROVIDER, tunable without a deploy.
   The owner asked to remove every restraint that hurts quality. Reasoning depth was one: every
   writer ran at xAI effort 'low' because on 2026-08-27 an unset effort (xAI default 'high') spent
   its whole max_tokens thinking and returned nothing ("completion_tokens: 0, reasoning_tokens:
   2533"). That bug was NOT depth, it was depth without room: _llm.js's withThinkingHeadroom() adds
   the thinking allowance on top of max_tokens (low +2k, medium +6k, high +12k), so writerCall runs
   every writer call inside it. Rule (reasoning-effort.mjs): effort above 'low' only ever travels
   with headroom.
     WRITER_EFFORT_ANGLES  default 'medium'  one JSON call, 90 s budget
     WRITER_EFFORT_DRAFT   default 'medium'  the words themselves; up to half of write's 270 s
                                             (r4: 'high' at ~48 tok/s + 12k headroom can outrun it)
     WRITER_EFFORT_SPOKEN  default 'medium'  a rewrite, not new thinking
     WRITER_EFFORT_BATCH   default 'medium'  generate-ideas (5 ideas per call, 93 s per call)
     WRITER_EFFORT_EDIT    default 'medium'  viral-rewrite / viral-twist / viral-analyze / sharpen
   The shape call stays 'low' (bookkeeping). An invalid value falls back to the default and is logged
   once. WRITER_PROVIDER = 'grok' (default) | 'claude': with 'claude' and no ANTHROPIC_API_KEY the
   writers fall back to Grok and log once, so flipping the switch can never fail a user request. */
const EFFORT_LEVELS = ['low', 'medium', 'high'];
const WRITER_EFFORT = {
  angles: ['WRITER_EFFORT_ANGLES', 'medium'],
  draft:  ['WRITER_EFFORT_DRAFT', 'medium'],   // r4: 'high' + 12k headroom can outrun the 135 s draft share
  spoken: ['WRITER_EFFORT_SPOKEN', 'medium'],
  batch:  ['WRITER_EFFORT_BATCH', 'medium'],
  edit:   ['WRITER_EFFORT_EDIT', 'medium'],
  shape:  [null, 'low'],
};
const _warned = new Set();
const warnOnce = (key, msg) => { if (_warned.has(key)) return; _warned.add(key); console.warn(msg); };
function writerEffort(kind) {
  const spec = WRITER_EFFORT[kind];
  if (!spec) return 'low';
  const [env, def] = spec;
  const raw = env ? String(process.env[env] == null ? '' : process.env[env]).trim().toLowerCase() : '';
  if (!raw) return def;
  if (EFFORT_LEVELS.indexOf(raw) >= 0) return raw;
  warnOnce('effort:' + env + ':' + raw, 'writer: ' + env + '="' + raw + '" is not low|medium|high — using "' + def + '"');
  return def;
}
function writerProvider() {
  const raw = String(process.env.WRITER_PROVIDER == null ? '' : process.env.WRITER_PROVIDER).trim().toLowerCase();
  if (raw === 'claude') {
    let ok = false;
    try { const L = require('./_llm'); ok = typeof L.claudeConfigured === 'function' && L.claudeConfigured(); } catch (e) {}
    if (ok) return 'claude';
    warnOnce('provider:claude-missing', 'writer: WRITER_PROVIDER=claude but Claude is not configured (no ANTHROPIC_API_KEY) — writing with Grok');
    return 'grok';
  }
  if (raw && raw !== 'grok') warnOnce('provider:' + raw, 'writer: WRITER_PROVIDER="' + raw + '" is not grok|claude — writing with Grok');
  return 'grok';
}
// Every writer call goes through here: a call that names an effort runs inside the thinking headroom,
// so the model always has room to think AND to write. A call with no effort is sent exactly as before.
function writerCall(opts) {
  const L = require('./_llm');
  const run = () => L.callLLM(opts);
  if (opts && opts.effort && typeof L.withThinkingHeadroom === 'function') return L.withThinkingHeadroom(run);
  return run();
}
// v693 r3 — START a usage row's brand attribution before the AI work, await it after. It was awaited
// AFTER the model answered in every writer (two Supabase reads for a member, 8 s each), which could
// push a request past maxDuration — and a killed function delivers nothing. Started early, it runs
// while the model thinks. Never rejects: a check that cannot run leaves the row unattributed,
// never unlogged (same rule as before).
function startBrandAttribution(userId, brandId) {
  if (!userId || !brandId) return Promise.resolve(null);
  return Promise.resolve()
    .then(() => require('./_publish/store').userCanAccessBrand(userId, brandId))
    .then((ok) => (ok ? brandId : null), () => null);
}

/* v693 r4 — ONE RETRY THAT CAN SAVE A REQUEST, never one that can overrun it.
   (a) PROVIDER FALLBACK: when the provider came from WRITER_PROVIDER (production, not the blind test's
       explicit arm) and Claude fails for any reason other than declining the content (a bad
       ANTHROPIC_MODEL = 400, an outage, a refused key), the same call is retried once on Grok inside
       the time that is left, and "WRITER FALLBACK claude→grok" is logged. The switch must never be
       why a user gets an error.
   (b) LOWER EFFORT (opt-in: ctx.effortRetry, used for the draft, the ideas batch and the sharpen
       critique): deeper thinking can run out of time; a failed call is retried once one level lower
       (high→medium→low) when ctx.room() still leaves at least 40 s, and "WRITER RETRY" is logged.
   An AI-account refusal on Grok is never retried (ai-unavailable-honest: one refused request is the
   whole story). ctx.room defaults to what is left of the call's own deadlineMs, so a retry can never
   end later than the first call was allowed to. */
const LOWER_EFFORT = { high: 'medium', medium: 'low' };
const MIN_EFFORT_RETRY_MS = 40000;
const MIN_PROVIDER_FALLBACK_MS = 10000;
async function writerCallResilient(opts, ctx) {
  const c = ctx || {};
  const t0 = Date.now();
  try {
    return await writerCall(opts);
  } catch (e) {
    if (e && e.code === 'MODEL_REFUSAL') throw e;
    const room = typeof c.room === 'function' ? c.room() : (Number(opts && opts.deadlineMs) || 0) - (Date.now() - t0);
    const why = (e && (e.code || e.message) || 'error');
    if (opts && opts.provider === 'claude' && c.providerFromEnv === true) {
      if (!(room >= MIN_PROVIDER_FALLBACK_MS)) throw e;
      console.warn('WRITER FALLBACK claude→grok (' + (c.label || 'writer') + '): ' + String(why).slice(0, 160));
      return await writerCall(Object.assign({}, opts, { provider: 'grok', deadlineMs: Math.floor(room) }));
    }
    if (e && e.code === 'AI_UNAVAILABLE') throw e;
    const lower = c.effortRetry === true ? LOWER_EFFORT[opts && opts.effort] : null;
    if (!lower || !(room >= MIN_EFFORT_RETRY_MS)) throw e;
    console.warn('WRITER RETRY (' + (c.label || 'writer') + ') at effort ' + lower + ' after: ' + String(why).slice(0, 160));
    return await writerCall(Object.assign({}, opts, { effort: lower, deadlineMs: Math.floor(room) }));
  }
}

// v693 r4 — what a usage row records as its model, so the cost fuse can price a Claude-written row
// (api/_usage.js ACTION_COST_CLAUDE). Taken from the env switch: if the call fell back to Grok the row
// is priced as Claude — an overestimate, the safe side for a fuse.
function usageModel(bc) { return writerProvider() === 'claude' ? 'claude' : ((bc && bc.engine) || 'grok'); }

// The provider/effort a writer uses: an explicit caller choice (the blind test) wins; else the env.
const pickProvider = (p) => (p === 'claude' || p === 'grok') ? p : writerProvider();
const pickEffort = (e, kind) => (EFFORT_LEVELS.indexOf(e) >= 0 ? e : writerEffort(kind));
// true when the provider was NOT chosen by the caller, i.e. it came from WRITER_PROVIDER.
const providerFromEnv = (p) => !(p === 'claude' || p === 'grok');

const SOURCE_KINDS = ['remix', 'question', 'trend', 'note', 'idea'];
const FORMATS = ['talking', 'statement', 'micro', 'carousel'];
const MAX_SOURCE = 12000;
const MAX_BELIEF = 140;
const MAX_WHY = 200;

// v693 — the budget split for runWrite. The draft may use up to half; the spoken pass gets what is
// left minus a reserve for the shape call; the shape call gets the rest. A call that finishes early
// hands its unused time to the next one. Below MIN_SPOKEN_MS the spoken pass is skipped (the draft
// is returned); below MIN_SHAPE_MS the shape fields are derived locally.
const DRAFT_SHARE = 0.5;
const SHAPE_SHARE = 0.15;
const MIN_SPOKEN_MS = 15000;
const MIN_SHAPE_MS = 8000;
const ANGLES_DEFAULT_MS = 90000;
const WRITE_DEFAULT_MS = 270000;
const RETRY_MIN_MS = 15000;
const ANGLES_MIN_SURVIVORS = 3;     // v693 r4 — below this, runAngles re-asks once          // a clean-JSON retry of runAngles is only started with this much left
const SHAPE_EFFORT = 'low';
// v693 r3 — room to WRITE (thinking room is added on top by writerCall's headroom). A 160-word script
// is ~250 tokens; 3000 means a normal answer is never cut, and a cut one is retried with double.
const DRAFT_MAX_TOKENS = 3000;
const SPOKEN_MAX_TOKENS = 3000;
const ANGLES_MAX_TOKENS = 4000;
const SHAPE_MAX_TOKENS = 1200;
/* v693 r5 — THE WORST-CASE CALL PLAN each writer can make, for the Claude cost fuse (api/_usage.js
   claudeCeiling). Every call that CAN run is listed — retries included — with its own max_tokens:
     angles  first ask + the one re-ask (under 3 survivors)
     write   draft, its lower-effort retry, the one draft retry (truncation doubles max_tokens; the fact
             correction uses the normal size — the larger is counted), that retry's lower-effort retry,
             the spoken pass, the shape call
     ideas   the batch, its lower-effort retry, the guardrail regeneration
     sharpen critique, its lower-effort retry, the rewrite
     viral / expand / settingsexamples / voicechat — one call each (a Claude failure falls back to
             Grok, which the Claude price does not cover)
   `in` is an estimated prompt size in tokens; `kind` is the WRITER_EFFORT kind (null = no effort, which
   callClaude sends with 'medium' headroom); `lower` = the retry one effort level down.
   rv2-write-2 checks each max against the numbers in the endpoint sources. */
const CLAUDE_CALL_PLAN = {
  angles: [{ in: 7000, max: ANGLES_MAX_TOKENS, kind: 'angles' }, { in: 7500, max: ANGLES_MAX_TOKENS, kind: 'angles' }],
  write: [
    { in: 9000, max: DRAFT_MAX_TOKENS, kind: 'draft' }, { in: 9000, max: DRAFT_MAX_TOKENS, kind: 'draft', lower: true },
    { in: 10000, max: DRAFT_MAX_TOKENS * 2, kind: 'draft' }, { in: 10000, max: DRAFT_MAX_TOKENS * 2, kind: 'draft', lower: true },
    { in: 3500, max: SPOKEN_MAX_TOKENS, kind: 'spoken' }, { in: 2500, max: SHAPE_MAX_TOKENS, kind: 'shape' },
  ],
  ideas: [{ in: 10000, max: 16000, kind: 'batch' }, { in: 10000, max: 16000, kind: 'batch', lower: true }, { in: 10500, max: 16000, kind: 'batch' }],
  sharpen: [{ in: 5000, max: 1500, kind: 'edit' }, { in: 5000, max: 1500, kind: 'edit', lower: true }, { in: 6000, max: 4000, kind: 'edit' }],
  viral: [{ in: 6000, max: 4000, kind: 'edit' }],
  expand: [{ in: 3000, max: 1600, kind: null }],
  settingsexamples: [{ in: 2500, max: 900, kind: null }],
  voicechat: [{ in: 9000, max: 1200, kind: null }],
};
// Mirrors api/_llm.js THINKING_HEADROOM (checked equal by rv2-write-2) so the plan can be priced
// without loading the network module.
const CLAUDE_THINKING_HEADROOM = { low: 2000, medium: 6000, high: 12000 };          // the shape call is bookkeeping, not writing: always cheap

// The slot marker is a contract with the app: exactly `[your story: <what to tell>]`.
// v693 r2 — detected case- and spacing-insensitively ([Your  Story: x] is still a slot).
const SLOT_RE = /\[\s*your\s+story\s*:[ \t]*([^\]\n]{1,300}?)[ \t]*\]/gi;

const SOURCE_LABEL = {
  remix: 'a video or post someone else made (transcript or summary)',
  question: 'a question people are asking',
  trend: 'a trend or headline',
  note: 'a note the creator wrote down',
  idea: 'an idea the creator had',
};

const FORMAT_RULES = {
  // v693 r3 — GUIDANCE, not caps: the model is told "usually", and nothing in code trims to these.
  talking:   { min: 60, max: 160, what: 'a talking video, said to camera in one take' },
  micro:     { min: 25, max: 70,  what: 'a short video: the belief and the reason behind it' },
  statement: { min: 15, max: 60,  what: 'a bold text post: a few sentences that stand alone on screen' },
  carousel:  { min: 70, max: 220, what: 'a swipe carousel: 5 to 8 slides, one slide per paragraph, slide 1 makes people swipe' },
};

// ── STYLE GUIDE ──────────────────────────────────────────────────────────────
// v693 — SHORT ON PURPOSE (< 1,200 chars). The old writingCraft is ~6,000 chars of rules; the model
// obeyed the loudest ones (compression) and wrote telegraph fragments. This keeps the AI-tell
// openers, the worst words, one rhythm rule and the one hard rule.
function styleGuide() {
  return [
    'STYLE GUIDE (short on purpose):',
    '- Write like one person talking to one person across a table. First person, plain words, contractions.',
    '- One idea per sentence, with natural rhythm: some short lines, some longer ones joined by "and", "so", "because". Never a run of clipped fragments.',
    '- Start with the thing itself. Never open with "Did you know", "Have you ever wondered", "Here\'s the thing", "Let me tell you", "Imagine", "Most people don\'t realize", "Hey guys", "In this video".',
    '- Never use: delve, leverage, elevate, unlock, game-changer, seamless, robust, journey. No em dashes. No "not just X, it\'s Y". No lists of three for show.',
    '- No hype, no pitch. Talk about the viewer\'s problem, not the brand\'s features.',
    '- HARD RULE. ' + NO_INVENTION_RULE,
  ].join('\n');
}

// ── small helpers ────────────────────────────────────────────────────────────
function badInput(msg) { const e = new Error(msg); e.code = 'BAD_INPUT'; return e; }
// v693 r2 — callLLM({wantMeta:true}) answers {text, truncated}; a stub or an older build may answer
// a plain string. Both are read the same way.
function metaOf(r) {
  if (r && typeof r === 'object') return { text: toStr(r.text), truncated: r.truncated === true };
  return { text: toStr(r), truncated: false };
}
function truncatedResult() { const e = new Error('The AI reply was cut off before it finished'); e.code = 'TRUNCATED'; return e; }
function emptyResult(msg) { const e = new Error(msg || 'The AI reply was empty or unusable'); e.code = 'EMPTY_RESULT'; return e; }
const posNum = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };

// Clip on a word boundary to at most n characters; never ends on a dangling comma or dash.
function clip(v, n) {
  let s = toStr(v).replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  s = s.slice(0, n);
  const sp = s.lastIndexOf(' ');
  if (sp > n * 0.6) s = s.slice(0, sp);
  return s.replace(/[\s,;:\-]+$/, '');
}

function normSource(source) {
  const s = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const kind = SOURCE_KINDS.indexOf(s.kind) >= 0 ? s.kind : 'note';
  const text = toStr(s.text).trim().slice(0, MAX_SOURCE);
  return {
    kind, text,
    url: toStr(s.url).trim().slice(0, 600),
    creator: toStr(s.creator).trim().slice(0, 120),
    platform: toStr(s.platform).trim().slice(0, 60),
  };
}

function normAngle(angle) {
  const a = angle && typeof angle === 'object' && !Array.isArray(angle) ? angle : {};
  return { belief: clip(a.belief, 300), why: clip(a.why, 400), hookSeed: clip(a.hookSeed, 200) };
}

function normStories(list) {
  const out = [];
  for (const s of (Array.isArray(list) ? list : [])) {
    if (!s || typeof s !== 'object') continue;
    const id = toStr(s.id).trim().slice(0, 80);
    const text = toStr(s.text).trim().slice(0, 600);
    if (id && text) out.push({ id, text });
    if (out.length >= 30) break;
  }
  return out;
}

// Up to 5 samples, newest first (C-BC order), each <= 800 chars, <= 3,000 chars together.
function speechSamplesFor(bc) {
  const out = []; let used = 0;
  for (const s of (Array.isArray(bc && bc.speechSamples) ? bc.speechSamples : [])) {
    const t = toStr(s && typeof s === 'object' ? s.text : s).trim().slice(0, 800);
    if (!t) continue;
    if (used + t.length > 3000) break;
    out.push(t); used += t.length;
    if (out.length >= 5) break;
  }
  return out;
}

function warningsFor(bc) { return v2Tones(bc || {}).overLimit ? ['tones_over_limit'] : []; }

// v693 r4 — WHAT A FACT MAY COME FROM: only what a person wrote or chose. The rendered brand block
// also carries approved AI-written posts the user never edited and titles of AI ideas; an invented
// "$15,000 / Sarah" in one of those would otherwise become a permanent "brand fact". So the allowed
// material is built from the user's brand FIELDS, the user's own speech, user-EDITED examples only,
// plus the source, the story bank and the picked belief/why.
// v693 r5 — and NOT from fields an AI fills from the web: webMentions, categoryGripes (crawl-brand's
// Grok web search), reviewInsights (api/reviews.js web search), competitorMoves (pull-trends' competitor
// pulse), recentTrends (auto-trends merged with hand-taught ones on the client, not separable here).
// socialProof and painPoints are EXCLUDED TOO: crawl-brand appends AI web-search text to them with a
// plain newline (crawl-brand.js "socialProofWeb" / "customerVoice"), so the user's own lines cannot be
// told apart from the AI's. Cost: a real proof number the user typed there is treated as unverified
// (it becomes a story slot) until crawl-brand marks its appends. competitors and channels stay: they
// are names the user reviews in Settings, not claims.
const USER_FACT_FIELDS = ['brandName', 'tagline', 'website', 'usps', 'productDetails', 'targetAudience',
  'brandVocab', 'originStory', 'communities', 'competitors', 'ctaStyle', 'exampleContent',
  'channels', 'coachNotes', 'voiceSample', 'visualStyle', 'dayMap'];
const AI_FILLED_FIELDS = ['webMentions', 'categoryGripes', 'reviewInsights', 'competitorMoves', 'recentTrends', 'socialProof', 'painPoints'];
function userFacts(bc) {
  const b = bc || {};
  const parts = USER_FACT_FIELDS.map(k => toStr(b[k]));
  if (Array.isArray(b.beliefs)) parts.push(b.beliefs.map(x => toStr(x && typeof x === 'object' ? x.text : x)).join('\n'));
  if (Array.isArray(b.voiceLog)) parts.push(b.voiceLog.map(n => toStr(n && n.text)).join('\n'));
  if (Array.isArray(b.speechSamples)) parts.push(b.speechSamples.map(x => toStr(x && typeof x === 'object' ? x.text : x)).join('\n'));
  if (Array.isArray(b.approvedExamples)) parts.push(b.approvedExamples.filter(e => e && e.edited === true).map(e => toStr(e.title) + '\n' + toStr(e.text)).join('\n'));
  return parts.filter(Boolean).join('\n');
}
function allowedMaterial(bc, src, angle, stories) {
  return [src.text, src.creator, src.platform, userFacts(bc),
    stories.map(s => s.text).join('\n'), angle.belief, angle.why].join('\n');
}

function correctionNote(previous, invented) {
  return 'CORRECTION: your previous draft invented facts that are in none of the material above: ' +
    invented.slice(0, 12).map(t => '"' + t.replace(/^(?:money|q):/, '') + '"').join(', ') +
    '. Write the script again without them. Where a claim needs proof, write a [your story: <what to tell>] slot instead.' +
    '\nPREVIOUS DRAFT:\n<<<\n' + previous + '\n>>>';
}

function brandBlockV2(bc) {
  const b = fullBrandBlock(bc || {}, { v2: true });
  return b && b.trim() ? b : '(No brand profile yet. Keep it general and do not invent any specifics.)';
}

function sourceBlock(src, cap) {
  const who = (src.creator ? ' by @' + src.creator : '') + (src.platform ? ' on ' + src.platform : '');
  return 'SOURCE (' + SOURCE_LABEL[src.kind] + who + '):\n<<<\n' + src.text.slice(0, cap) + '\n>>>' +
    (src.url ? '\nLink: ' + src.url : '');
}

function slotsOf(text) {
  const out = [], seen = new Set();
  const s = toStr(text);
  SLOT_RE.lastIndex = 0;
  let m;
  while ((m = SLOT_RE.exec(s))) {
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    out.push({ marker: m[0], ask: m[1].trim() });
  }
  SLOT_RE.lastIndex = 0;
  return out;
}

// ── THE FACT GUARD ───────────────────────────────────────────────────────────
// v693 r2 — "never invent facts" is checked in CODE, not only asked for in the prompt. An
// independent attack showed the old digit-only check let through "$200 a month", "my client Sarah
// Jones", "two hundred dollars", "2 million brands", "Harvard study". inventedFacts(text, allowed)
// lists every fact-shaped token in `text` that the `allowed` material does not contain:
//   numbers   digits (with k/m/bn/x/% or hundred/thousand/million suffixes, so "2 million" is not
//             "2" and "2x" is not "2"), spelled numbers ("fifteen thousand" = 15000, "ninety-nine"
//             = 99), and quantity words (dozen(s), twice, triple(d), doubled, halved, "by half")
//   money     $, €, £, dollars, euros, pounds, bucks, cents
//   names     capitalised person / company / institution names: "Dr. Mark Lee", a mid-sentence
//             capital ("my client Anna"), a two-capital run ("Sarah Jones"), or a sentence-initial
//             capital followed by a person verb ("Anna saved", "Harvard study")
// It deliberately ALLOWS: any of these that appear in the allowed material (the source, the brand
// facts actually rendered, the stories, the belief), "one" on its own, ordinary sentence-initial
// capitals ("Hydration matters"), days and months, platform names, and Title Case headlines.
const NUM_SMALL = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const NUM_MAG = { hundred: 100, hundreds: 100, thousand: 1e3, thousands: 1e3, million: 1e6, millions: 1e6, billion: 1e9, billions: 1e9, trillion: 1e12 };
// v693 r4 — multiplier words map to the SAME key as their digit form, so the brand's "2x" allows
// "twice"/"doubled" and its "50%" allows "half"/"halved" (and the other way round).
const QTY_WORDS = { dozen: 'q:dozen', dozens: 'q:dozen', doubled: '2x', tripled: '3x', quadrupled: '4x', halved: '50%' };
const MONEY_RE = /[$€£¥]|\b(?:dollars?|euros?|pounds?|bucks|(?<!per\s)cents?|usd|eur|gbp)\b/gi;
const MONEY_CANON = (w) => /^[$]|dollar|bucks|usd/i.test(w) ? 'dollar' : /^€|euro|eur/i.test(w) ? 'euro' : /^£|pound|gbp/i.test(w) ? 'pound' : /^¥/.test(w) ? 'yen' : 'cent';
// v693 r4 — capitals that are never an invented person or institution: days, months, titles, and a
// sensible allowlist of common brands, platforms, tools, places, diets and events. Naming Amazon or
// Europe is ordinary speech, and flagging it turned good sentences into story slots.
const NOT_NAMES = new Set(('i,i\'m,i\'ve,i\'ll,i\'d,monday,tuesday,wednesday,thursday,friday,saturday,sunday,january,february,march,april,may,june,july,august,september,october,november,december,' +
  'dr,mr,mrs,ms,prof,professor,doctor,ok,okay,god,internet,wifi,' +
  'instagram,tiktok,youtube,facebook,linkedin,google,twitter,x,reddit,whatsapp,pinterest,threads,snapchat,shorts,reels,telegram,discord,twitch,substack,medium,' +
  'amazon,alibaba,aliexpress,etsy,ebay,shopify,walmart,costco,ikea,temu,shein,stripe,paypal,klarna,wix,squarespace,wordpress,woocommerce,' +
  'excel,word,powerpoint,outlook,gmail,notion,canva,figma,slack,zoom,teams,trello,asana,hubspot,salesforce,mailchimp,zapier,airtable,chatgpt,openai,claude,gemini,grok,copilot,midjourney,' +
  'apple,iphone,ipad,mac,android,samsung,windows,microsoft,netflix,spotify,uber,airbnb,tesla,nike,adidas,starbucks,mcdonald,coca,cola,pepsi,gatorade,whole,foods,lidl,aldi,tesco,rimi,prisma,' +
  'keto,paleo,vegan,vegetarian,atkins,whole30,crossfit,pilates,yoga,peloton,strava,fitbit,garmin,oura,ozempic,' +
  'europe,european,eu,america,american,americans,us,usa,uk,britain,british,england,english,canada,canadian,mexico,china,chinese,india,indian,japan,japanese,korea,korean,germany,german,france,french,spain,spanish,italy,italian,' +
  'estonia,estonian,finland,finnish,sweden,swedish,norway,denmark,poland,polish,latvia,lithuania,baltic,baltics,nordic,nordics,scandinavia,netherlands,dutch,ireland,irish,australia,australian,africa,african,asia,asian,brazil,russia,ukraine,' +
  'london,paris,berlin,tallinn,tartu,pärnu,narva,viljandi,rakvere,kuressaare,haapsalu,saaremaa,hiiumaa,jõhvi,paide,valga,võru,lmnt,nuun,pedialyte,powerade,hydralyte,helsinki,stockholm,riga,new,york,la,dubai,shenzhen,guangzhou,shanghai,hong,kong,silicon,valley,' +
  'christmas,easter,halloween,thanksgiving,ramadan,black,cyber,valentine,valentine\'s,new,year,gen,z,millennials,boomers,' +
  'research,science,data,experts,doctors,scientists,studies,study,mom,mum,dad,grandma,grandpa,granny,nan,nana,summer,winter,spring,autumn,fall,' +
  // common nouns that open sentences ("Sales went up", "Coffee made me tired") — never a person
  'sales,revenue,profit,profits,margin,margins,cost,costs,price,prices,orders,traffic,growth,business,results,numbers,money,time,work,life,' +
  'sleep,energy,health,hydration,water,coffee,tea,salt,sugar,food,diet,protein,powder,powders,supplements,vitamins,electrolytes,' +
  'customers,clients,people,brands,suppliers,buyers,users,everyone,things,content,posts,videos,ads,marketing').split(','));
// A sentence-initial capital followed by one of these reads as a person or institution making a claim.
// v693 r5 — person signals only (said/told/asked/called/wrote/texted/emailed/runs/founded) and
// institution words. Result verbs ("showed", "found", "saved", "lost") are NOT a signal on their own:
// "Summer showed me the problem" is writing; "Harvard found" is caught through NAMES_LEX instead.
const NAME_NEXT = /^(?:said|says|told|tells|asked|asks|wrote|writes|called|calls|texted|emailed|messaged|who|runs|owns|founded|university|institute|researchers|scientists|professors|inc|ltd|llc|labs?|clinic|hospital|foundation|college|journal)$/i;
const IRREGULAR_PAST = new Set('quit,found,said,told,went,ran,lost,made,got,saw,took,left,built,sold,grew,wrote,came,bought,paid,spent,won,began,brought,fell,felt,kept,knew,met,put,sent,sat,stood,thought,threw,woke,drove,ate,drank,gave,hit,led,read,rode,rose,shut,slept,spoke,swam,taught,understood,became'.split(','));
const NOT_PAST_ED = new Set('need,feed,seed,speed,weed,breed,bleed,proceed,exceed,succeed,indeed,bed,red,shed,wed'.split(','));
const isPastVerb = (w) => { const l = String(w || '').toLowerCase(); return IRREGULAR_PAST.has(l) || (/^[a-z]{3,}ed$/.test(l) && !NOT_PAST_ED.has(l)); };
const STARTERS = new Set('why,what,when,where,who,how,so,and,but,or,if,then,the,a,an,my,our,your,his,her,their,this,that,these,those,most,every,all,some,many,no,yes,not,just,here,there,now,today,stop,start,do,don\'t,is,are,was,it,it\'s,we,you,they,he,she,let,let\'s,last,next,first,after,before,because,with,for,at,in,on,to,from,by,of,as,dear,hey,hi,meet,ask,tell,maybe,even,only,never,always,imagine,look,try,think,remember,forget,every,each,one,take,call,text,grab,drink,eat,add,mix,pour,check,watch,read,listen,picture,consider,see,notice,compare,skip,swap,pack,carry,keep,put,pick,everyone,everybody,nobody,someone,somebody,anyone,anybody,people,none,nothing,everything,something'.split(','));
const TITLE_RE = /\b(?:Dr|Mr|Mrs|Ms|Prof|Professor|Doctor)\.?\s+\p{Lu}\p{L}+/gu;
// Nouns that make a small count a claim about real customers or a real business.
const PEOPLE_NOUN = /^(?:clients?|customers?|users?|members?|stockists?|stores?|shops?|gyms?|locations?|brands?|suppliers?|partners?|buyers?|subscribers?|patients?|students?|employees?|staff|hires?|people|friends?|dentists?|doctors?|coaches|founders?|companies|businesses|retailers?|distributors?|investors?|testers?|reviewers?)$/;
const CLAIM_VERB = /^(?:told|said|asked|switched|quit|signed|left|reordered|came|agree|agreed|bought|paid|returned|stayed|cancelled|canceled|joined|replied|wrote|called|loved|hated|complained|emailed|messaged|ordered|stopped|started|doubled|tripled|confirmed|reported)$/;

// Slot-looking text in ANY spelling (case, spacing, full-width brackets). Used wherever a field must
// never carry a slot, and to strip slots before a fact check (a slot is a question, not a fact).
const SLOT_LIKE_RE = /[\[［]\s*your\s+story\s*[:：][^\]］\n]*[\]］]?/gi;
const stripSlots = (x) => toStr(x).replace(SLOT_LIKE_RE, ' . ');

const pct = (f) => Math.round(f * 100) + '%';
// v693 r6 — measurable things a fraction can be a claim about ("a quarter of your sweat loss is salt").
const MEASURABLE_NOUNS = 'body|sweat|water|salt|sodium|potassium|magnesium|intake|loss|weight|calories|energy|sleep|hydration|fluid|fluids|blood|muscle|muscles|budget|income|profit|profits|revenue|sales|margin|market|traffic|time';
// v693 r5 — who a fraction or "half" can be a statistic about.
const POP_NOUNS = 'people|adults|americans|europeans|estonians|runners|athletes|men|women|kids|children|teens|workers|employees|users|customers|clients|buyers|gym|gym-goers|gymgoers|population|country|world|sales|revenue|orders|patients|doctors|nurses|students|parents|moms|dads|seniors|smokers|drinkers|founders|brands|companies|businesses|stores|shops|members|subscribers|followers|fans|women|office|desk|americans|everyone|us|them|you';

function numberTokens(text) {
  // v693 r3/r4 — ONLY CLAIM-SHAPED NUMBERS are facts. Relaxed (never reported): integers up to 12 with
  // an ordinary noun ("three steps", "two questions"), durations up to 60 units that are rhetoric
  // ("give it two minutes", "after 30 days"), ordinals, "a few / many / most". Strict: money,
  // percentages ("12%", "half my customers"), multipliers ("3x", "5 times faster", "went up 3 times",
  // "twice as", doubled/tripled/halved), "N out of M", k/m/bn and thousand/million amounts, decimals,
  // numbers above 12 (counts, years), small numbers on a measured result ("5 kg", "7 followers"),
  // small counts that are claims ("our 7 stockists", "our first 10 customers", "12 clients told
  // me", "3 of my clients"), and durations that are results ("sold out in 48 hours", "saved 8
  // hours a week", "took me 11 years").
  const t = stripSlots(text).toLowerCase();
  const out = [];
  const toks = t.match(/[$€£¥×]|\d[\d,]*(?:\.\d+)?|[a-z]+(?:['’][a-z]+)?|%|[.!?]/g) || [];
  const DUR = /^(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|nights?|weeks?|months?|years?|yrs?)$/;
  const MEASURED = /^(?:kg|kilos?|kilograms?|lbs?|grams?|g|mg|ml|litres?|liters?|km|miles?|calories?|kcal|cm|inches|feet|foot|points?|stars?|followers?|views?|likes?|subscribers?|sales|leads?|signups?|downloads?|reviews?|orders?|comments?|shares?|clicks?)$/;
  const MONEY_WORD = /^(?:dollars?|euros?|pounds?|bucks|cents?|usd|eur|gbp)$/;
  const MAG = { k: 1e3, thousand: 1e3, thousands: 1e3, m: 1e6, million: 1e6, millions: 1e6, bn: 1e9, b: 1e9, billion: 1e9, billions: 1e9, trillion: 1e12, hundred: 100, hundreds: 100 };
  const COMPARATIVE = /^(?:as|the|more|faster|better|higher|bigger|lower|less|over|cheaper|stronger|longer|larger|smaller|quicker|what)$/;
  const GROWTH = /^(?:up|grew|grow|grown|increased|rose|jumped|multiplied|climbed|doubled|tripled)$/;
  const RESULT_BEFORE = /^(?:saved|save|saves|lost|grew|sold|shipped|earned|built|launched)$/;
  // Read a number starting at i: a digit token, or a run of number words ("two hundred" = 200).
  const readNum = (i) => {
    const w = toks[i];
    if (w == null) return null;
    if (/^\d/.test(w)) {
      const v = Number(w.replace(/,/g, '').replace(/\.$/, ''));
      return Number.isFinite(v) ? { value: v, end: i + 1, decimal: /\.\d/.test(w), mag: false } : null;
    }
    if (NUM_SMALL[w] == null && NUM_MAG[w] == null) return null;
    if (w === 'one' && NUM_MAG[toks[i + 1]] == null) return { value: 1, end: i + 1, one: true };
    let total = 0, cur = 0, j = i, mag = false;
    while (j < toks.length && (NUM_SMALL[toks[j]] != null || NUM_MAG[toks[j]] != null)) {
      const x = toks[j];
      if (NUM_SMALL[x] != null) cur += NUM_SMALL[x];
      else { const v = NUM_MAG[x]; mag = true; if (v === 100) cur = (cur || 1) * 100; else { total += (cur || 1) * v; cur = 0; } }
      j++;
    }
    return { value: total + cur, end: j, decimal: false, mag };
  };
  const before = (i, n) => toks.slice(Math.max(0, i - n), i).filter(x => !/^[.!?]$/.test(x));
  for (let i = 0; i < toks.length; i++) {
    const n0 = readNum(i);
    if (!n0) {
      if (QTY_WORDS[toks[i]]) out.push(QTY_WORDS[toks[i]]);
      continue;
    }
    const s0 = i;
    let { value, end } = n0;
    let mag = n0.mag;
    const currency = /^[$€£¥]$/.test(toks[i - 1] || '');
    if (/^\d/.test(toks[i]) && MAG[toks[end]] != null) { value = Math.round(value * MAG[toks[end]] * 1000) / 1000; end++; mag = true; }
    const next = toks[end], next2 = toks[end + 1];
    const prev = before(s0, 5);
    const key = String(value);
    i = end - 1;
    // "N out of M" — a statistic, always
    // v693 r5 — "N out of M" and "N in M" are the same statistic, keyed as a percentage so the brand's
    // own "75%" allows "3 in 4" (and the other way round).
    // r6: "1 in every 3 adults", "three of every four runners"; plain "N in M" only when a people/group
    // noun follows ("3 in 4 people") — "Step 2 in 5 is the hard one" / "1 in 500 ml" are not statistics.
    if ((next === 'out' && next2 === 'of') || next === 'in' || (next === 'of' && next2 === 'every')) {
      const every = next2 === 'every' || (next === 'in' && next2 === 'every') || (toks[end + 2] === 'every');
      const at = next === 'in' ? (next2 === 'every' ? end + 2 : end + 1) : (next === 'of' ? end + 2 : (toks[end + 2] === 'every' ? end + 3 : end + 2));
      const m2 = readNum(at);
      const after = m2 ? String(toks[m2.end] || '') : '';
      const people = new RegExp('^(?:' + POP_NOUNS + ')$').test(after);
      const statOk = next === 'out' || every || people;
      if (m2 && statOk && m2.value >= 2 && m2.value <= 1000 && value < m2.value && !DUR.test(after)) { out.push(pct(value / m2.value)); i = m2.end - 1; continue; }
      // a dosage ("drop 1 in 500 ml of water") is an instruction, not a claim
      if (m2 && next === 'in' && /^(?:ml|l|litres?|liters?|g|grams?|mg|oz|ounces?|cups?|glass(?:es)?|bottles?|tbsp|tsp)$/.test(after)) { i = m2.end; continue; }
    }
    // "8 per cent" is a percentage, not money
    if (next === 'per' && next2 === 'cent') { out.push(value + '%'); i = end + 1; continue; }
    if (next === 'x' || next === '×') { out.push(value + 'x'); i = end; continue; }
    if (next === 'times' && (COMPARATIVE.test(next2 || '') || prev.some(p => GROWTH.test(p)) || /^[.!?]?$/.test(next2 || ''))) { out.push(value + 'x'); i = end; continue; }
    if (next === '%' || next === 'percent') { out.push(value + '%'); continue; }
    if (currency || MONEY_WORD.test(next || '') || mag || MEASURED.test(next || '')) { out.push(key); continue; }
    if (DUR.test(next || '')) {
      // a result, not rhetoric: "saved 8 hours", "sold out in 48 hours", "it took me 11 years"
      if (value > 60 || prev.some(p => RESULT_BEFORE.test(p)) || /\btook (?:me|us)\b/.test(prev.join(' '))) out.push(key);
      continue;
    }
    if (n0.decimal || value > 12) { out.push(key); continue; }
    if (n0.one) continue;
    // small counts that are claims about real customers or a real business
    const pre = before(s0, 3);
    const peopleNext = PEOPLE_NOUN.test(next || '') || PEOPLE_NOUN.test(next2 || '');
    if ((next === 'of' && /^(?:my|our)$/.test(next2 || ''))
      || pre.some(p => /^(?:first|biggest|largest|top)$/.test(p))
      || (pre.some(p => /^(?:our|my|had)$/.test(p)) && peopleNext)
      || (PEOPLE_NOUN.test(next || '') && (CLAIM_VERB.test(next2 || '') || CLAIM_VERB.test(toks[end + 2] || '')))) out.push(key);
  }
  // "twice as fast" is a claim; "I was twice as tired" is a feeling, not a result.
  if (/\b(?:twice|double)\s+(?:as|the|more|faster|better|higher|bigger|what)\b/.test(t)
      && !/\b(?:was|were|felt|feel|am|i'm|seemed|looked)\s+(?:twice|double)\s+as\b/.test(t)) out.push('2x');
  if (/\btriple\s+(?:as|the|more|what)\b/.test(t)) out.push('3x');
  // v693 r5 — "half" is a statistic about people or results ("half my customers", "half the people at my
  // gym", "cut it by half"), never in "half of this is habit" or "half the battle".
  if (new RegExp('\\b(?:by|in|than)\\s+half\\b|\\bhalf\\s+(?:price|as\\s+(?:much|many))\\b|\\bhalf\\s+(?:of\\s+)?(?:(?:the|my|our|all|your|these|those)\\s+)?(?:' + POP_NOUNS + ')\\b').test(t)) out.push('50%');
  // fractions of people or results ("two thirds of gym-goers", "a quarter of the gym", "sales went up by a
  // third", "cuts focus by a fifth"), keyed as percentages
  const FRAC = { half: 0.5, third: 1 / 3, thirds: 1 / 3, quarter: 0.25, quarters: 0.25, fifth: 0.2, fifths: 0.2, tenth: 0.1, tenths: 0.1 };
  const fracRe = new RegExp('\\b(by\\s+)?(a|an|one|two|three|four|nine)\\s+(thirds?|quarters?|fifths?|tenths?)\\b(\\s+of\\s+(?:(?:the|my|our|all|your|these|those)\\s+)?(?:' + POP_NOUNS + '|' + MEASURABLE_NOUNS + ')\\b)?', 'g');
  let fm;
  while ((fm = fracRe.exec(t))) {
    if (!fm[1] && !fm[4]) continue;
    const k = (fm[2] === 'a' || fm[2] === 'an') ? 1 : NUM_SMALL[fm[2]];
    out.push(pct(k * FRAC[fm[3]]));
  }
  // "six figures", "a 7-figure year", "eight figures" — a revenue claim
  const figRe = /\b(six|seven|eight|nine|6|7|8|9)[\s-]+figures?\b/g;
  while ((fm = figRe.exec(t))) out.push('figures:' + (NUM_SMALL[fm[1]] || fm[1]));
  const money = t.match(MONEY_RE) || [];
  for (const w of money) out.push('money:' + MONEY_CANON(w));
  return out;
}

// v693 r5 — names a sentence OPENER may carry without any other signal: common first names and the
// institutions people cite. Everything else at the start of a sentence ("Stress wrecked my sleep",
// "Walking helped", "Magnesium fixed it") is ordinary writing and is NOT a name unless a person signal
// follows (said/told/asked/called/wrote/texted/emailed/runs/founded, a surname-like second capital, or an
// institution word). Ambiguous first names that are also everyday words (Will, Grace, Mark, Hope, Rose,
// Bill, Frank, Jack, Summer, May...) are deliberately left out: in person context they are still caught.
const NAMES_LEX = new Set(('anna,anne,ann,maria,mary,sarah,sara,emma,olivia,sophie,sophia,laura,lisa,julia,kate,katie,emily,jessica,jennifer,jen,amy,rachel,rebecca,hannah,helen,claire,clara,elena,eva,lena,nina,maya,mia,zoe,chloe,lucy,ella,alice,natalie,nicole,michelle,linda,susan,karen,diana,monica,paula,rita,tina,vera,kristina,kadri,kati,liis,mari,maarja,triin,piret,kersti,tiina,' +
  'john,james,jim,jimmy,tom,tommy,mike,michael,david,dave,chris,paul,peter,pete,steve,steven,stephen,andrew,andy,matt,matthew,dan,daniel,tim,timothy,alex,sam,ben,jake,josh,joshua,ryan,kevin,brian,eric,adam,nick,tony,luke,sean,jason,jeff,greg,scott,mario,marco,thomas,martin,markus,marko,joe,joey,jonas,jaan,juhan,priit,andres,toomas,tanel,rain,kristjan,siim,margus,jüri,jörgen,' +
  'harvard,stanford,yale,oxford,cambridge,princeton,berkeley,mayo,cleveland,johns,hopkins,mckinsey,gallup,nielsen,deloitte,gartner,forbes,nasa,nih,nhs,cdc,who,fda,efsa,mit,ucla').split(','));
const PERSON_CTX = /^(?:client|clients|customer|customers|friend|friends|coach|buddy|mate|colleague|coworker|co-worker|neighbou?r|trainer|nurse|doctor|dr|patient|brother|sister|cousin|uncle|aunt|auntie|wife|husband|boyfriend|girlfriend|partner|boss|founder|co-founder|cofounder|ceo|son|daughter|mentor|student|teammate|roommate|athlete|runner|member|guy|girl|lady|dude)$/i;
const KNOWN_PAIRS = new Set(['trader joe', 'whole foods', 'black friday', 'cyber monday', 'new york', 'hong kong', 'red bull', 'coca cola', 'silicon valley', 'gen z', 'new year', 'tour de', 'de france', 'liquid iv', 'drip drop']);
// v693 r6 — actions only a PERSON takes, for sentence openers that are not in NAMES_LEX.
const PERSON_ACTION = /^(?:fainted|switched|cut|quit|lost|gained|started|stopped|tried|bought|ordered|drank|ate|ran|came|went|called|texted|emailed|messaged|wrote|told|said|asked|signed|joined|left|sent|booked|paid|cried|laughed|decided|noticed|realized|realised|cramped|collapsed|moved|married|trained|finished|dropped|swore|swears)$/i;
const COMM_VERB = /^(?:called|texted|emailed|messaged|wrote|told|said|asked|swore)$/i;

// Each entry: { name, kind } — kind 'person' (after client/friend/coach/...: the allowlist does not
// apply and the name must appear capitalised mid-sentence in the material), 'caps' (an ALL-CAPS
// institution: must appear in capitals), or 'plain'.
function nameEntries(text) {
  const s = stripSlots(text);
  const out = [];
  for (const m of s.match(TITLE_RE) || []) { const last = m.split(/\s+/).pop().toLowerCase(); if (!NOT_NAMES.has(last)) out.push({ name: m.replace(/\s+/g, ' '), kind: 'person' }); }
  const words = s.match(/[\p{L}\p{N}'’\-]+|[.!?:\n"“”]/gu) || [];
  const content = words.filter(w => /\p{L}/u.test(w) && w.length >= 3);
  const caps = content.filter(w => /^\p{Lu}/u.test(w)).length;
  // A Title Case headline capitalises every word; a capital there is no signal.
  const titleCase = content.length >= 3 && caps / content.length >= 0.8;
  const low0 = (x) => String(x || '').toLowerCase().replace(/['’]s$/, '');
  const known = (x) => NOT_NAMES.has(low0(x));
  let start = true;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^[.!?:\n"“”]$/.test(w)) { start = true; continue; }
    const prev = words[i - 1] || '', next = words[i + 1] || '';
    // ALL-CAPS institutions ("the FDA", "The WHO says", "a study from MIT") — only where a name would
    // stand, so shouted emphasis ("STOP doing this") is never read as an institution.
    if (/^\p{Lu}{2,5}s?$/u.test(w) && !titleCase && !(known(w) && !NAMES_LEX.has(low0(w))) &&
        (/^(?:the|from|by|at|of|with|a|an|says|per)$/i.test(prev) || /^(?:says|said|found|finds|study|studies|research|researchers|report|reports|approved|recommends|recommend|data|proved|shows|showed|guidelines)$/i.test(next))) {
      out.push({ name: w.replace(/s$/, ''), kind: 'caps' }); start = false; continue;
    }
    const isCap = /^\p{Lu}\p{Ll}/u.test(w) || /^\p{Lu}\p{Ll}*\p{Lu}/u.test(w) && /\p{Ll}/u.test(w);
    const possessive = /['’]s$/i.test(w);
    const bare = w.replace(/['’]s$/i, '');
    const low = bare.toLowerCase();
    const inPair = KNOWN_PAIRS.has(low0(prev) + ' ' + low) || KNOWN_PAIRS.has(low + ' ' + low0(next));
    if (isCap && !titleCase && !inPair) {
      // "My client Joe", "my buddy Tom", "Coach Mike": a person, whatever the allowlist says.
      if (PERSON_CTX.test(prev) && !STARTERS.has(low)) { out.push({ name: bare, kind: 'person' }); start = false; continue; }
      if (!known(bare)) {
        if (!start) out.push({ name: bare, kind: 'plain' });
        else if ((!possessive || NAMES_LEX.has(low)) && !STARTERS.has(low)) {
          // "Water's cheaper" is a contraction, never a name. An opener is a name when it is a known
          // first name or institution ("Anna quit", "John quit coffee", "Harvard found"), or a person
          // signal follows: another capital ("Sarah Jones"), or a person/institution word ("Anna said",
          // "Stanford researchers"). A past-tense verb alone is NOT a signal ("Stress wrecked my sleep").
          const nextCap = /^\p{Lu}\p{Ll}/u.test(next) && !known(next) && !KNOWN_PAIRS.has(low + ' ' + low0(next));
          // r6: a name not in the list still reads as a person when it opens with a PERSON action
          // ("Kelly fainted…", "Priya switched to…", "Marcus cut sugar…") or "and her/his/their" — unless
          // the opener looks like a common noun (-ing/-ness/-tion/-ment/-ity, a plural) or the action
          // lands on the writer ("Sugar cut my energy", "Salt stopped my cramps").
          const next2 = words[i + 2] || '';
          const nounish = /(?:ing|ness|tion|sion|ment|ity|ism)$/i.test(low) || /(?:[^aeiousy]s|es)$/i.test(low);
          const actsOnWriter = /^(?:my|me|our|us)$/i.test(next2) && !COMM_VERB.test(next);
          const personAct = PERSON_ACTION.test(next) && !actsOnWriter;
          const andPron = /^and$/i.test(next) && /^(?:her|his|their)$/i.test(next2);
          if (NAMES_LEX.has(low) || nextCap || NAME_NEXT.test(next) || (!nounish && (personAct || andPron))) out.push({ name: bare, kind: PERSON_CTX.test(bare) ? 'plain' : 'plain' });
        }
      }
    }
    start = false;
  }
  return out;
}
function nameTokens(text) { return nameEntries(text).map(e => e.name); }

const BRAND_CLAIM_VERB = /^(?:sponsored|sponsors|sponsoring|stocks|stocked|stock|ranked|ranks|partnered|partners|featured|features|picked|carries|carried|carry|sells|sold|uses|used|chose|chooses|listed|lists|approved|backed|invested|recommends|recommended|named|hired|bought)$/i;
// v693 r5/r6 — CLAIMS WITHOUT NUMBERS that a health brand must never make up. r6: only claims ABOUT US
// count — ordinary advice ("Doctors recommend eating less salt", "Recommended by experts? Not really",
// "The number one mistake in summer is plain water", "a best-selling book") is writing, not a claim.
// A claim is allowed when the same claim (same label) is in the material, or the retailer it names is.
//   always a claim:   clinically proven/tested/studied/shown/validated, proven in clinical trials,
//                     scientifically proven, doctor-recommended / dermatologist-tested / -approved,
//                     award-winning, America's favorite, Amazon's Choice, #1 new release,
//                     fastest-growing … brand, the most popular <product> in <place>
//   about us only:    <professionals> recommend/love/trust/use/approve/endorse/swear by it|this|us|our …
//                     (or a capitalised product name); most doctors agree it works; research proves it
//                     works; <passive> recommended/trusted/used by <professionals> in a statement (not a
//                     question); "we are (the) number one", "our … is the #1 …"; best-selling/top-selling
//                     next to a product word (electrolyte, powder, drink, brand, supplement, formula…)
//   retail/brands:    <Brand> sponsored/stocks/ranked/featured/uses/carries … us/our; we are sold/stocked/
//                     featured in <Brand>; stocked/endorsed/recommended by <Brand>; find/buy/get us at
//                     <Retailer>; we (just) landed / got into / are on the shelves at <Retailer>; now in
//                     every <Retailer> store; our customers/partners/stockists include <Name>
const CLAIM_RES = [
  ['clinically proven', /\bclinically\s+(?:proven|tested|studied|shown|validated)\b|\bproven\s+in\s+clinical\s+(?:trials?|studies)\b/i],
  ['scientifically proven', /\bscientifically\s+proven\b/i],
  ['doctor-approved', /\b(?:doctor|dermatologist|dentist|physician|nurse|expert|nutritionist)[\s-](?:recommended|approved|tested|endorsed)\b/i],
  ['award-winning', /\baward[\s-]winning\b/i],
  ['favorite', /\bamerica['’]s\s+favou?rite\b|\bamazon['’]s\s+choice\b|#\s?1\s+new\s+release\b/i],
  ['fastest-growing', /\bfastest[\s-]growing\s+(?:[\w-]+\s+){0,2}(?:brand|company|electrolytes?|supplements?|products?)\b/i],
  ['most popular', /\bthe\s+most\s+popular\s+(?:[\w-]+\s+){0,2}(?:electrolytes?|powders?|drinks?|brands?|supplements?|products?)\s+in\b/i],
  ['number one', /\b(?:we(?:['’]re|\s+are)(?:\s+now)?|it['’]s|it\s+is|our\s+[\w-]+(?:\s+[\w-]+)?\s+(?:is|are))\s+(?:still\s+)?(?:the\s+|an?\s+)?(?:[\w-]+\s+)?(?:number\s+one|#\s?1|no\.?\s?1)\b/i],
  ['best-selling', /\b(?:best[\s-]?sell(?:ing|ers?)|bestsell(?:ing|ers?)|top[\s-]?selling)\s+(?:[\w-]+\s+){0,1}(?:electrolytes?|powders?|drinks?|brands?|supplements?|formulas?|products?|sticks?|tabs?|mix(?:es)?)\b|\b(?:we(?:['’]re|\s+are)|it['’]s|it\s+is|our\s+[\w-]+\s+(?:is|are))\s+(?:the\s+|a\s+)?(?:[\w-]+\s+)?(?:best[\s-]?seller|bestseller)\b/i],
];
const PROS = /^(?:doctors?|physicians?|nurses?|dentists?|dermatologists?|nutritionists?|dietitians?|pharmacists?|experts?|coaches|trainers|scientists|researchers|athletes|pros|olympians)$/;
const PRO_VERBS = /^(?:recommend|recommends|recommended|love|loves|trust|trusts|use|uses|approve|approves|endorse|endorses|prescribe|prescribes|drink|drinks|choose|chooses|rely)$/;
const RETAILERS = /^(?:costco|walmart|target|lidl|aldi|rimi|prisma|selver|maxima|coop|tesco|kroger|sainsbury['’]?s|boots|cvs|walgreens|ica|konsum|apotheka|benu|amazon|whole|trader|ikea|decathlon|zalando|bolt|wolt)$/i;
function claimTokens(text) {
  const s = stripSlots(text);
  const out = [];
  for (const [label, re] of CLAIM_RES) if (re.test(s)) out.push('claim:' + label);
  // professionals endorsing US (never generic advice). Checked per sentence so a question is exempt.
  for (const sent of maskDots(s).split(/(?<=[.!?\n])/)) {
    const words = unmaskDots(sent).match(/[\p{L}\p{N}#'’\-]+/gu) || [];
    const lw = words.map(w => w.toLowerCase());
    const isObj = (k) => {
      const w = lw[k];
      if (w == null) return false;
      if (/^(?:it|this|these|them|us|ours|our)$/.test(w)) return true;
      if (w === 'that') return !/^(?:you|we|people|everyone|adults|athletes|kids|children|most|all)$/.test(lw[k + 1] || '');
      return /^\p{Lu}/u.test(words[k]) && !NOT_NAMES.has(w);
    };
    const question = /\?\s*$/.test(sent.trim());
    for (let i = 0; i < lw.length; i++) {
      if (PROS.test(lw[i])) {
        let j = i + 1;
        if (/^(?:all|really|now|often|actually|also|already|always)$/.test(lw[j] || '')) j++;
        if (PRO_VERBS.test(lw[j] || '') && (isObj(j + 1) || (lw[j] === 'rely' && lw[j + 1] === 'on' && isObj(j + 2)))) out.push('claim:pros endorse us');
        if (lw[j] === 'swear' && lw[j + 1] === 'by' && isObj(j + 2)) out.push('claim:pros endorse us');
        if (/^(?:agree|say|says|confirm)$/.test(lw[j] || '') && (/^(?:it|this)$/.test(lw[j + 1] || '') || (lw[j + 1] === 'that' && /^(?:it|this|our)$/.test(lw[j + 2] || ''))) && /^(?:works?|helps?|is)$/.test(lw[j + (lw[j + 1] === 'that' ? 3 : 2)] || '')) out.push('claim:pros endorse us');
      }
      // "recommended/trusted/used by (pro|elite|Olympic) doctors/athletes…" in a statement
      if (!question && /^(?:recommended|trusted|used|loved|approved|endorsed|chosen|tested)$/.test(lw[i]) && lw[i + 1] === 'by' &&
          (PROS.test(lw[i + 2] || '') || (/^(?:pro|professional|elite|olympic|top|real)$/.test(lw[i + 2] || '') && PROS.test(lw[i + 3] || '')))) out.push('claim:pros endorse us');
      if (/^(?:research|studies|science|data|a|the)$/.test(lw[i]) && /^(?:proves?|shows?|confirms?)$/.test(lw[i + 1] || '') && /^(?:it|this|our)$/.test(lw[i + 2] || '')) out.push('claim:research proves it');
      if (/^(?:studies|study)$/.test(lw[i]) && /^(?:prove|proves|show|shows|confirm|confirms)$/.test(lw[i + 1] || '') && /^(?:it|this|our)$/.test(lw[i + 2] || '')) out.push('claim:research proves it');
    }
  }
  const words = s.match(/[\p{L}\p{N}'’&\-]+|[.!?:\n]/gu) || [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!/^\p{Lu}/u.test(w)) continue;
    const low = w.toLowerCase().replace(/['’]s$/, '');
    if (!NOT_NAMES.has(low) && !RETAILERS.test(low) && !KNOWN_PAIRS.has(low + ' ' + String(words[i + 1] || '').toLowerCase())) continue;
    // "<Brand> sponsored/stocks/ranked ... us/our/we"
    let j = i + 1;
    if (KNOWN_PAIRS.has(low + ' ' + String(words[j] || '').toLowerCase())) j++;
    if (BRAND_CLAIM_VERB.test(words[j] || '') && words.slice(j + 1, j + 4).some(x => /^(?:us|our|we)$/i.test(x))) out.push('claim:' + w);
  }
  const CAP = '(\\p{Lu}[\\p{L}\'’&]*)';
  const RES = [
    // "we are sold/stocked/featured in <Brand>", "stocked/endorsed/recommended by <Brand>"
    new RegExp("\\b(?:[Ww]e(?:'re|’re|\\s+are|\\s+were|\\s+got)?(?:\\s+now)?|[Oo]ur\\s+\\w+\\s+(?:is|are))\\s+(?:now\\s+)?(?:sold|stocked|listed|featured|available|carried)\\s+(?:in|at|by|on)\\s+(?:the\\s+)?" + CAP, 'gu'),
    new RegExp("\\b(?:[Ss]tocked|[Ss]old|[Ff]eatured|[Ss]ponsored|[Bb]acked|[Cc]arried|[Uu]sed|[Rr]ecommended|[Ee]ndorsed)\\s+by\\s+(?:the\\s+)?" + CAP, 'gu'),
    // "find/buy/get/grab us at <Retailer>"
    new RegExp("\\b(?:[Ff]ind|[Bb]uy|[Gg]et|[Gg]rab|[Ss]pot)\\s+us\\s+(?:at|in|on)\\s+(?:the\\s+|any\\s+|your\\s+local\\s+)?" + CAP, 'gu'),
    // "we (just) landed / got into / are on the shelves at / are now in <Retailer>"
    new RegExp("\\b[Ww]e(?:['’]ve|['’]re|\\s+have|\\s+are|\\s+just|\\s+finally)*\\s+(?:just\\s+)?(?:landed|got\\s+into|signed(?:\\s+with)?|launched\\s+(?:in|at|with)|(?:now\\s+)?in|on\\s+the\\s+shelves\\s+(?:at|of|in))\\s+(?:every\\s+|all\\s+)?(?:the\\s+)?" + CAP, 'gu'),
    // "Now in every Rimi store", "available at <Retailer>"
    new RegExp("\\b(?:[Nn]ow\\s+(?:in|at)|[Aa]vailable\\s+(?:in|at))\\s+(?:every\\s+|all\\s+|selected\\s+)?" + CAP, 'gu'),
    // "Our customers/partners/stockists include <Name>"
    new RegExp("\\b[Oo]ur\\s+(?:customers|clients|partners|stockists|retailers|buyers)\\s+include\\s+" + CAP, 'gu'),
  ];
  for (const re of RES) { let m; while ((m = re.exec(s))) if (!STARTERS.has(m[1].toLowerCase())) out.push('claim:' + m[1]); }
  return out;
}

// allowed: the material a fact may come from (a string). Returns the invented tokens, unique.
function inventedFacts(text, allowed) {
  const A = toStr(allowed);
  const As = stripSlots(A);
  const haveNums = new Set(numberTokens(A));
  // v693 r5 — names are matched CASE-SENSITIVELY: "will" in "who will train hard" is not the name Will.
  const capsAny = new Set(), capsInner = new Set();
  for (const sent of maskDots(As).split(/[.!?\n]+/)) {
    const ws = sent.match(/[\p{L}\p{N}'’\-]+/gu) || [];
    ws.forEach((x, k) => {
      const b = x.replace(/['’]s$/, '');
      if (!/^\p{Lu}/u.test(b)) return;
      capsAny.add(b);
      // part of a known brand pair ("Trader Joe's") is not a person's name
      const pair = KNOWN_PAIRS.has(String(ws[k - 1] || '').toLowerCase() + ' ' + b.toLowerCase()) || KNOWN_PAIRS.has(b.toLowerCase() + ' ' + String(ws[k + 1] || '').toLowerCase().replace(/['’]s$/, ''));
      if (!pair && (k > 0 || /^\p{Lu}/u.test(ws[k + 1] || ''))) capsInner.add(b);
    });
  }
  const bad = [];
  for (const n of numberTokens(text)) if (!haveNums.has(n)) bad.push(n);
  for (const e of nameEntries(text)) {
    const parts = e.name.replace(/^(?:Dr|Mr|Mrs|Ms|Prof|Professor|Doctor)\.?\s+/, '').split(/\s+/);
    const set = e.kind === 'person' ? capsInner : capsAny;
    if (parts.some(p => !set.has(p))) bad.push(e.name);
  }
  // a claim is allowed when the material makes the same claim, or names the retailer/brand it cites
  const haveClaims = new Set(claimTokens(As));
  for (const c of claimTokens(text)) {
    const label = c.slice(6);
    if (!haveClaims.has(c) && !capsAny.has(label)) bad.push(c);
  }
  return [...new Set(bad)];
}

// v693 r5 — a sentence split must never break inside "2.5", "$4.99", "e.g.", "i.e.", "vs.", "Dr.",
// "Mr.", "Mrs.", "Ms.", "St.", "Prof.", "etc.": those dots are masked while splitting, then restored.
const DOT_MASK = '\u0001';
const maskDots = (x) => toStr(x).replace(/(\d)\.(?=\d)/g, '$1' + DOT_MASK)
  .replace(/\b(e\.g|i\.e)\./gi, (m) => m.replace(/\./g, DOT_MASK))
  .replace(/\b(vs|Dr|Mr|Mrs|Ms|St|Prof|etc|approx|No)\.(?=\s)/g, '$1' + DOT_MASK);
const unmaskDots = (x) => String(x).split(DOT_MASK).join('.');
const SENTENCE_RE = /[^.!?\n]+[.!?]*/g;

// v693 r4 — for short explanatory text (an angle's `why`): keep the sentences that invent nothing.
function dropInventedSentences(text, allowed) {
  return (maskDots(text).match(SENTENCE_RE) || []).map(unmaskDots).filter(x => x.trim() && !inventedFacts(x, allowed).length).join(' ').replace(/\s+/g, ' ').trim();
}

// Replace every sentence that carries an invented fact with a story slot, so nothing made up ships.
// v693 r4 — the ask QUOTES the original sentence intact ("your real version of: ...") instead of a
// "... 's cheaper" fragment; the slot is a question to the creator, never shipped copy. Existing slots
// are protected first so a sentence split can never cut one in half.
function slotifyInvented(script, allowed) {
  const kept = [];
  let s = maskDots(script).replace(SLOT_LIKE_RE, (m) => { kept.push(m); return '\u0000' + (kept.length - 1) + '\u0000'; });
  s = s.replace(SENTENCE_RE, (sentence) => {
    const plain = unmaskDots(sentence.replace(/\u0000\d+\u0000/g, ' '));
    if (!plain.trim() || !inventedFacts(plain, allowed).length) return sentence;
    const lead = (sentence.match(/^\s*/) || [''])[0];
    const slotsInside = (sentence.match(/\u0000\d+\u0000/g) || []).join(' ');
    const quote = clip(plain.replace(/[\[\]［］\n]/g, ' ').replace(/\s+/g, ' ').trim(), 180);
    return lead + (slotsInside ? slotsInside + ' ' : '') + '[your story: your real version of "' + quote + '"]';
  });
  return unmaskDots(s.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[+i]));
}

// A spoken pass may reword the sentences around a slot, never add a new one there
// ("[your story: x] Last Tuesday my coworker Jim fainted"): the words next to each slot must
// mostly already be in the draft.
const STOP4 = new Set('that,this,with,have,from,your,they,what,when,then,than,just,like,really,because,about,there,their,them,been,were,will,would,could,should,into,over,only,also,some,more,most,much,very,here,it\'s,that\'s,don\'t,doesn\'t,isn\'t,you\'re,we\'re,they\'re,i\'m,which,where,even,still,every,thing,things,know,think,want,make,said,does,doing,going,being'.split(','));
function slotNeighbourNovelty(draft, spoken) {
  const draftWords = new Set((stripSlots(draft).toLowerCase().match(/[\p{L}'’]+/gu) || []));
  const s = toStr(spoken);
  SLOT_RE.lastIndex = 0;
  let m, worst = 0;
  const segs = [];
  while ((m = SLOT_RE.exec(s))) {
    const after = s.slice(m.index + m[0].length).replace(/^[\s.,;:!?]+/, '').match(/^[^.!?\n]*/)[0];
    const beforeAll = s.slice(0, m.index).replace(/[\s,;:]+$/, '');
    const before = (beforeAll.match(/[^.!?\n]*[.!?]?$/) || [''])[0];
    segs.push(after, before);
  }
  SLOT_RE.lastIndex = 0;
  for (const seg of segs) {
    const content = (seg.replace(SLOT_LIKE_RE, ' ').toLowerCase().match(/[\p{L}'’]+/gu) || []).filter(w => w.length >= 4 && !STOP4.has(w));
    const novel = content.filter(w => !draftWords.has(w));
    // A reworded sentence reuses most of its words; a NEW one (an anecdote) does not.
    if (novel.length >= 3 && novel.length / content.length >= 0.6) worst = Math.max(worst, novel.length);
  }
  return worst;
}

const words = (s) => (toStr(s).match(/\S+/g) || []).length;

// Strip what models wrap plain text in: code fences, a leading "Script:" label, surrounding quotes.
function cleanScript(raw) {
  let s = toStr(raw).replace(/\r\n?/g, '\n');
  s = s.replace(/^\s*```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '');
  s = s.replace(/^\s*(?:\*\*)?(?:script|spoken script|rewritten script)(?:\*\*)?\s*:\s*/i, '');
  s = s.trim();
  // v693 r2 — a slot in any case, spacing or full-width brackets becomes the contract spelling
  // `[your story: ...]`, so the app (and the checks below) find it.
  s = s.replace(/[\[［]\s*your\s+story\s*[:：]\s*([^\]］\n]{1,300}?)\s*[\]］]/gi, '[your story: $1]');
  if (s.length > 1 && /^["“]/.test(s) && /["”]$/.test(s) && !/["“”]/.test(s.slice(1, -1))) s = s.slice(1, -1).trim();
  return s.replace(/\n{3,}/g, '\n\n');
}

// The draft ends with "USED STORIES: <ids>" when stories were offered. Only ids that really exist
// in the story bank are reported; the trailer line never reaches the script.
function parseDraft(raw, stories) {
  let text = cleanScript(raw);
  const known = new Set(stories.map(s => s.id));
  let ids = [];
  const TRAILER = /^[ \t]*(?:\*\*)?USED STORIES(?:\*\*)?[ \t]*:[ \t]*(.*)$/gim;
  let m, last = null;
  while ((m = TRAILER.exec(text))) last = m[1];
  if (last != null) {
    ids = [...new Set(last.split(/[,\s]+/).map(x => x.replace(/[\[\]().]/g, '').trim()).filter(x => known.has(x)))];
    text = text.replace(TRAILER, '').trim().replace(/\n{3,}/g, '\n\n');
  }
  return { script: text, usedStories: ids };
}

// Why a spoken-pass rewrite must be thrown away, or '' when it is fine. The pass may change HOW
// things are said, never WHAT: every slot stays, no slot is added, no new number appears, and the
// length stays in the same range.
const paragraphs = (s) => toStr(s).split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);

function spokenRejects(draft, spoken, format) {
  if (!spoken || !spoken.trim()) return 'empty';
  // v693 — a carousel's paragraphs ARE its slides: a rewrite that merges or splits them changed
  // the post, not just its wording.
  if (format === 'carousel' && paragraphs(spoken).length !== paragraphs(draft).length) return 'layout_changed';
  const a = slotsOf(draft).map(s => s.marker).sort(), b = slotsOf(spoken).map(s => s.marker).sort();
  if (a.length !== b.length || a.some((x, i) => x !== b[i])) return 'slots_changed';
  // v693 r2 — the full fact guard, against the draft: a number, money word or new name is a new fact.
  const added = inventedFacts(spoken, draft);
  if (added.some(t => /^[\d]|^q:|^money:/.test(t))) return 'new_number';
  if (added.length) return 'new_name';
  if (slotNeighbourNovelty(draft, spoken)) return 'slot_adjacent';
  const dw = words(draft), sw = words(spoken);
  if (sw < dw * 0.5 || sw > dw * 2 + 10) return 'length';
  return '';
}

// The first line a person actually says: slots are skipped (a slot is not a line anyone can say yet).
function firstSpokenLine(script) {
  const line = toStr(script).split('\n').map(l => l.replace(SLOT_RE, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean)[0] || '';
  const sentence = (line.match(/^[^.!?]*[.!?]/) || [line])[0].trim();
  return clip(sentence || line, 200);
}

function listOf(v, max, each) {
  const arr = Array.isArray(v) ? v : (v == null || v === '' ? [] : toStr(v).split('\n'));
  return arr.map(x => clip(x, each)).filter(Boolean).slice(0, max);
}

// ── HASHTAGS (fix7, round 2) ─────────────────────────────────────────────────
// ONLY the brand's own words. Round 1 let the model (and then the script's words) build tags, and a
// review showed why that cannot be made safe: a tag drops the sentence around it, so a script that
// says "magnesium won't cure your insomnia" still yields #cureinsomnia — the denial turned into the
// claim. So no model-written hashtag is used at all. A tag is one of:
//   * a Content Theme the brand set itself (bc.communities — "Content Themes & Keywords" in
//     Settings — then its day rotation), lowercased with spaces and punctuation removed:
//     "Morning routines" -> #morningroutines
//   * the brand name, the same way: "Acme Studio" -> #acmestudio
// Deterministic: themes are ranked by how many of their words appear in this idea, ties keep the
// brand's own order. At most 5 themes + the brand name = 6. A brand with no themes gets [] (the app
// shows no tags) — nothing is ever made up to reach a count.
const HASHTAG_MAX = 6;
const TAG_MAX_LEN = 40;
function brandThemes(bc) {
  const c = bc && bc.communities;
  const list = Array.isArray(c) ? c.slice() : (typeof c === 'string' ? c.split(/[,\n;]+/) : []);
  // the day rotation holds themes too (a brand can set those without the Content Themes list)
  const dr = bc && bc.dayRotation;
  if (dr && typeof dr === 'object' && !Array.isArray(dr)) for (const v of Object.values(dr)) list.push(v);
  // a day-map string ("Monday: Morning routines") keeps only the theme
  const out = [], seen = new Set();
  for (const x of list) {
    const t = toStr(x).replace(/^\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday|bonus)\s*[:=]\s*/i, '').trim();
    if (!t || /^(general|all)$/i.test(t) || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase()); out.push(t);
  }
  return out;
}
function tagOf(text) {
  const t = toStr(text).normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return (t && t.length <= TAG_MAX_LEN) ? '#' + t : '';
}
function hashtagsFor(bc, idea) {
  const themes = brandThemes(bc);
  if (!themes.length) return [];
  const i = idea && typeof idea === 'object' ? idea : {};
  const words = new Set(toStr([i.title, i.hook, i.script, i.caption, i.belief].map(toStr).join(' '))
    .toLowerCase().normalize('NFC').split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3));
  const score = (theme) => theme.toLowerCase().normalize('NFC').split(/[^\p{L}\p{N}]+/u)
    .filter(w => w.length >= 3 && words.has(w)).length;
  const ranked = themes.map((t, ix) => ({ t, ix, sc: score(t) })).sort((a, b) => (b.sc - a.sc) || (a.ix - b.ix));
  const out = [];
  for (const r of ranked) {
    const tag = tagOf(r.t);
    if (tag && out.indexOf(tag) < 0 && out.length < HASHTAG_MAX - 1) out.push(tag);
  }
  const brandTag = tagOf(bc && bc.brandName);
  if (brandTag && out.indexOf(brandTag) < 0) out.push(brandTag);
  return out.slice(0, HASHTAG_MAX);
}

// ── THE IDEA OBJECT ──────────────────────────────────────────────────────────
// v693 — built from an explicit WHITELIST. `script` is the argument, never a field of the shape
// reply: the shape call can suggest a title or a hook, it cannot touch the words the person says.
// Every shape field that brings a number the script does not have, or a slot, falls back locally.
function buildIdea(script, shaped, angle, format, allowedExtra) {
  const sh = shaped && typeof shaped === 'object' && !Array.isArray(shaped) ? shaped : {};
  // v693 r2 — a field is refused when it looks like a slot in ANY spelling or brings a fact (number,
  // money, name) the script does not have. The brand's own name is always allowed.
  const allowed = script + '\n' + toStr(allowedExtra);
  const bad = (x) => { SLOT_LIKE_RE.lastIndex = 0; const hit = SLOT_LIKE_RE.test(x || ''); SLOT_LIKE_RE.lastIndex = 0; return !x || hit || /your\s+story\s*[:：]/i.test(x) || inventedFacts(x, allowed).length > 0; };
  const first = firstSpokenLine(script);
  let hook = clip(sh.hook, 200); if (bad(hook)) hook = first;
  let title = clip(sh.title, 90); if (bad(title)) title = clip(angle.belief, 60);
  let caption = clip(sh.caption, 600); if (bad(caption)) caption = angle.belief;
  const onScreen = listOf(sh.onScreen, 6, 120).filter(x => !bad(x));
  const shots = listOf(sh.shots, 8, 200).filter(x => !bad(x));
  // Emphasis must be words the person actually says: keep only phrases found in the script, and
  // return the script's own spelling of them.
  const low = script.toLowerCase();
  const emphasis = [];
  for (const p of listOf(sh.emphasis, 12, 80)) {
    const i = low.indexOf(p.toLowerCase());
    if (p.length < 2 || i < 0) continue;
    const exact = script.slice(i, i + p.length);
    if (emphasis.indexOf(exact) < 0) emphasis.push(exact);
    if (emphasis.length >= 6) break;
  }
  return {
    title, hook, script,
    storySlots: slotsOf(script),
    // A carousel's on-screen text is its slides: taken from the script itself, never re-worded.
    onScreen: format === 'carousel' ? paragraphs(script).map(p => clip(p, 300)).slice(0, 10)
      : (onScreen.length ? onScreen : (hook ? [hook] : [])),
    caption, shots, format, emphasis,
    hashtags: [],   // fix7 — filled by runWrite from the brand's own themes (see hashtagsFor)
    belief: angle.belief,
    genFlow: 'v2',
  };
}

// ── PROMPTS ──────────────────────────────────────────────────────────────────
function anglesPrompt(bc, src, count) {
  const name = toStr(bc.brandName).trim() || 'this brand';
  return [
    'You help ' + name + ' decide what to SAY before anything gets written.',
    '',
    sourceBlock(src, MAX_SOURCE),
    '',
    'STEP 1 (silently): find the underlying idea or principle in the source. Never reuse the creator\'s wording, examples or structure.',
    'STEP 2: write ' + count + ' beliefs ' + name + ' could hold about that idea that most of its audience does NOT share yet. Each belief:',
    '- is contrarian but defensible: the person could argue it on camera and be right;',
    '- is about the viewer\'s problem or situation, never about the brand\'s product or features;',
    '- is one plain sentence, at most ' + MAX_BELIEF + ' characters;',
    '- has a "why": at most ' + MAX_WHY + ' characters on why most people believe the opposite;',
    '- may have a "hookSeed": a first spoken line that could open a video on it.',
    'Make them genuinely different beliefs, not one belief reworded. Stay consistent with the beliefs the brand already holds and do not repeat them.',
    NO_INVENTION_RULE,
    '',
    brandBlockV2(bc),
    '',
    'Reply with ONLY this JSON, no prose, no code fences:',
    '{"angles":[{"belief":"...","why":"...","hookSeed":"..."}]}',
  ].join('\n');
}

function draftPrompt(bc, src, angle, format, stories) {
  const name = toStr(bc.brandName).trim() || 'the brand';
  const f = FORMAT_RULES[format];
  const said = format !== 'statement' && format !== 'carousel';
  const P = [
    said ? 'Write ONE script for ' + name + ', to be said out loud by the person behind it.'
      : 'Write ONE ' + format + ' post for ' + name + ', in the words of the person behind it.',
    '',
    'THE BELIEF TO ARGUE (the viewer probably disagrees):',
    '"' + angle.belief + '"',
  ];
  if (angle.why) P.push('Why most people disagree: ' + angle.why);
  if (angle.hookSeed) P.push('A possible first line (use it, improve it, or ignore it): ' + angle.hookSeed);
  if (src.text) P.push('', sourceBlock(src, 6000), 'Use the source for the idea only. Never copy its wording.');
  P.push('',
    'SHAPE: ' + f.what + '. Usually about ' + f.min + ' to ' + f.max + ' words: a guide, not a limit. Take the words the idea needs.',
    'Move through three beats without labelling them: why people believe the opposite, what goes wrong because of it, then the reframe.',
    'Where proof would help (a number, a customer, a result, a moment from real work), write a slot exactly like [your story: <what to tell>] instead of making it up. One or two slots is normal. None is fine if the argument stands on its own.');
  if (stories.length) {
    let acc = 0; const lines = [];
    for (const s of stories) { if (acc + s.text.length > 6000) break; acc += s.text.length; lines.push('[' + s.id + '] ' + s.text); }
    P.push('',
      'REAL STORIES THIS PERSON HAS TOLD BEFORE. Use one ONLY if it genuinely fits this belief; never force one in. Retell it briefly in their words, do not paste it:',
      lines.join('\n'));
  }
  P.push('', styleGuide(), '', brandBlockV2(bc), '',
    'Write ONLY the script, as plain text: no title, no labels, no stage directions, no hashtags, no markdown.' +
    (stories.length ? ' Then, on its own last line, write USED STORIES: followed by the ids you used, or USED STORIES: none' : ''));
  return P.join('\n');
}

// v693 — talking and micro are SAID, so pass 2 rewrites for the ear. statement and carousel are
// READ, so the same pass rewrites them in the person's own voice but keeps the written layout.
function spokenPrompt(bc, draft, samples, format) {
  const vt = v2Tones(bc);
  const said = format !== 'statement' && format !== 'carousel';
  const P = [
    said ? 'Rewrite this script so it sounds like the person SAYING it, not like writing.'
      : 'Rewrite this ' + format + ' so it sounds like the person wrote it themselves, not like marketing copy.',
    '',
    'RULES:',
    '- Same meaning, same order, same argument. Do not add any fact, number, name, example or claim that is not already in the script.',
    '- Keep every [your story: ...] slot exactly as written, character for character. Do not add new slots.',
    said ? '- First person. Short lines, one thought per line, and a few natural pauses where a person would breathe. Contractions.'
      : '- First person, plain words, contractions. Keep the paragraphs exactly as they are: the same number, in the same order' + (format === 'carousel' ? ' (each paragraph is one slide).' : '.'),
    '- Keep it about the same length.',
  ];
  if (samples.length) {
    P.push('',
      'HOW THIS PERSON ACTUALLY TALKS (transcripts of them speaking). Copy how they move: sentence length, the joining words they use, how they start a thought. Never copy their sentences or topics:',
      samples.map(s => '"' + s + '"').join('\n'));
  } else if (!said) {
    P.push('', 'HOW IT SHOULD READ: complete, plain sentences a person would actually write to a friend. No slogans, no fragments for effect.');
  } else {
    P.push('',
      'HOW SPOKEN SCRIPTS SOUND: complete sentences with a subject and a verb, the small joining words people use when talking (so, and, but, because), the point that matters said twice in different words, never bullet-point fragments.');
  }
  if (vt.tones.length) P.push('', 'Voice: ' + vt.tones.join(', ') + '.');
  const avoid = toStr(bc.avoidWords).trim().slice(0, 1500);
  if (avoid) P.push('', 'Never use these words or phrases: ' + avoid);
  P.push('', 'SCRIPT:', '<<<', draft, '>>>', '', 'Reply with ONLY the rewritten script, as plain text.');
  return P.join('\n');
}

function shapePrompt(script, format) {
  return [
    'Below is a finished ' + format + ' script. Do NOT rewrite it. Derive the fields around it.',
    '',
    'SCRIPT:',
    '<<<',
    script,
    '>>>',
    '',
    'Reply with ONLY this JSON, no prose, no code fences:',
    '{"title":"a plain 4-8 word working title","hook":"the first spoken line of the script, or a tighter version with the same meaning","onScreen":["2-5 short text overlays taken from the script"],"caption":"1-3 sentences for the post caption, same voice","shots":["3-6 simple shots one person can film on a phone"],"emphasis":["up to 6 phrases copied EXACTLY from the script: the words to stress when saying it"]}',
    'Never invent numbers, names or results. Keep [your story: ...] slots out of every field.',
  ].join('\n');
}

// ── runAngles ────────────────────────────────────────────────────────────────
function anglesFrom(parsed, count) {
  let list = [];
  if (Array.isArray(parsed)) list = parsed;
  else if (parsed && typeof parsed === 'object') {
    const a = parsed.angles || parsed.beliefs;
    list = Array.isArray(a) ? a : (a && typeof a === 'object' ? Object.values(a) : []);
  }
  const out = [], seen = new Set();
  for (const item of list) {
    const it = item && typeof item === 'object' ? item : { belief: item };
    const belief = clip(it.belief || it.angle || it.text, MAX_BELIEF);
    if (!belief) continue;
    const key = belief.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const a = {
      id: 'ang_' + crypto.createHash('sha1').update(belief).digest('hex').slice(0, 10),
      belief,
      why: clip(it.why, MAX_WHY),
    };
    const hs = clip(it.hookSeed, 200);
    if (hs) a.hookSeed = hs;
    out.push(a);
    if (out.length >= count) break;
  }
  return out;
}

async function runAngles(opts) {
  const o = opts || {};
  const bc = o.bc && typeof o.bc === 'object' ? o.bc : {};
  const src = normSource(o.source);
  if (!src.text) throw badInput('source.text is required');
  const c = Math.floor(Number(o.count));
  const count = Number.isFinite(c) ? Math.max(5, Math.min(8, c)) : 6;
  const t0 = Date.now();
  const total = posNum(o.deadlineMs) || ANGLES_DEFAULT_MS;
  const prompt = anglesPrompt(bc, src, count);
  // v693 r4 — an angle is dropped ONLY when its belief invents a fact (a picked belief becomes allowed
  // material for the draft). An inventing `why` loses just the offending sentence(s) and an inventing
  // hookSeed is removed, instead of losing a good belief over its explanation. Fewer than 3 survivors
  // (or an unparseable reply) → ONE re-ask, merged in, when at least 15 s remain.
  const allowedA = [src.text, src.creator, src.platform, userFacts(bc)].join('\n');
  let angles = [], rejected = [];
  for (let attempt = 0; attempt < 2 && angles.length < ANGLES_MIN_SURVIVORS; attempt++) {
    const left = total - (Date.now() - t0);
    if (attempt > 0 && left < RETRY_MIN_MS) break;
    const note = !attempt ? '' : (rejected.length
      ? '\n\nIMPORTANT: these beliefs were rejected because they state numbers, names or results that are in none of the material: ' + rejected.slice(0, 6).map(b => '"' + b + '"').join('; ') + '. Write fresh beliefs that need no such facts. Reply with ONLY the JSON object described above.'
      : '\n\nIMPORTANT: reply with ONLY the JSON object described above.');
    const content = await writerCallResilient({
      messages: [{ role: 'user', content: prompt + note }],
      model: 'grok', engine: bc.engine || 'grok', max_tokens: ANGLES_MAX_TOKENS, temperature: 0.9,
      deadlineMs: Math.max(1000, left),
      provider: pickProvider(o.provider), effort: pickEffort(o.effort, 'angles'),
    }, { providerFromEnv: providerFromEnv(o.provider), label: 'angles' });
    for (const a of anglesFrom(extractJson(content), count)) {
      if (inventedFacts(a.belief, allowedA).length) { rejected.push(a.belief); continue; }
      if (a.why && inventedFacts(a.why, allowedA).length) a.why = dropInventedSentences(a.why, allowedA);
      if (a.hookSeed && inventedFacts(a.hookSeed, allowedA).length) delete a.hookSeed;
      if (angles.length < count && !angles.some(x => x.belief.toLowerCase() === a.belief.toLowerCase())) angles.push(a);
    }
  }
  if (!angles.length) throw emptyResult('No usable angles came back');
  return { angles, warnings: warningsFor(bc) };
}

// ── runWrite ─────────────────────────────────────────────────────────────────
async function runWrite(opts) {
  const o = opts || {};
  const bc = o.bc && typeof o.bc === 'object' ? o.bc : {};
  const src = normSource(o.source);
  const angle = normAngle(o.angle);
  if (!angle.belief) throw badInput('angle.belief is required');
  const format = FORMATS.indexOf(o.format) >= 0 ? o.format : 'talking';
  const t0 = Date.now();
  const total = posNum(o.deadlineMs) || WRITE_DEFAULT_MS;
  const left = () => total - (Date.now() - t0);
  const stories = normStories(bc.stories);
  const passes = { draft: 'done', spoken: 'skipped_deadline', shape: 'skipped_deadline' };

  // 1 — the draft. Plain text only. A failure here (including an AI refusal) is the whole answer.
  // v693 r2 — wantMeta: a reply cut off at max_tokens is not a finished script.
  const basePrompt = draftPrompt(bc, src, angle, format, stories);
  const draftCall = async (content, maxTokens, deadlineMs) => metaOf(await writerCallResilient({
    messages: [{ role: 'user', content }],
    model: 'grok', engine: bc.engine || 'grok', max_tokens: maxTokens, temperature: 0.8,
    deadlineMs: Math.max(1000, deadlineMs),
    provider: pickProvider(o.provider), effort: pickEffort(o.effort, 'draft'), wantMeta: true,
  }, { providerFromEnv: providerFromEnv(o.provider), label: 'draft', effortRetry: true,
       room: () => left() - Math.floor(total * SHAPE_SHARE) }));
  // A retry may only use time that still leaves the spoken pass its minimum and the shape its reserve.
  const retryRoom = () => Math.min(Math.floor(total * DRAFT_SHARE), left() - Math.floor(total * SHAPE_SHARE));
  let r = await draftCall(basePrompt, DRAFT_MAX_TOKENS, Math.min(Math.floor(total * DRAFT_SHARE), left()));
  let retried = false;
  if (r.truncated) {
    if (retryRoom() < MIN_SPOKEN_MS) throw truncatedResult();
    r = await draftCall(basePrompt, DRAFT_MAX_TOKENS * 2, retryRoom());
    retried = true; passes.draft = 'retried_truncated';
    if (r.truncated) throw truncatedResult();
  }
  let draft = parseDraft(r.text, stories);
  if (!draft.script) throw emptyResult('The draft came back empty');

  // v693 r2 — THE DRAFT'S FACTS ARE CHECKED against the material it was allowed to use: the source,
  // the brand facts actually rendered, the story bank, the belief. Anything else is invented: one
  // retry with the exact correction, then every sentence still carrying one becomes a story slot.
  const allowed = allowedMaterial(bc, src, angle, stories);
  let invented = inventedFacts(draft.script, allowed);
  if (invented.length && !retried && retryRoom() >= MIN_SPOKEN_MS) {
    retried = true;
    try {
      const r2 = await draftCall(basePrompt + '\n\n' + correctionNote(draft.script, invented), DRAFT_MAX_TOKENS, retryRoom());
      const d2 = r2.truncated ? null : parseDraft(r2.text, stories);
      if (d2 && d2.script) { draft = d2; invented = inventedFacts(draft.script, allowed); }
    } catch (e) { /* the first draft is slotted below instead */ }
    passes.draft = 'retried_facts';
  }
  if (invented.length) {
    draft.script = slotifyInvented(draft.script, allowed);
    passes.draft = retried ? 'retried_then_slotted' : 'slotted';
  }
  passes.inventedRemoved = invented.slice(0, 20);

  // 2 — the spoken pass. Best effort: any failure or a rewrite that changed WHAT is said keeps the draft.
  let script = draft.script, usedSpeechSamples = 0;
  const samples = speechSamplesFor(bc);
  const spokenBudget = left() - Math.floor(total * SHAPE_SHARE);
  if (spokenBudget >= MIN_SPOKEN_MS) {
    try {
      const sp = metaOf(await writerCallResilient({
        messages: [{ role: 'user', content: spokenPrompt(bc, draft.script, samples, format) }],
        model: 'grok', engine: bc.engine || 'grok', max_tokens: SPOKEN_MAX_TOKENS, temperature: 0.7,
        deadlineMs: spokenBudget,
        provider: pickProvider(o.provider), effort: pickEffort(o.effort, 'spoken'), wantMeta: true,
      }, { providerFromEnv: providerFromEnv(o.provider), label: 'spoken' }));
      const out = cleanScript(sp.text);
      // v693 r2 — a cut-off rewrite is refused; the finished draft stands.
      const why = sp.truncated ? 'truncated' : spokenRejects(draft.script, out, format);
      if (!why) { script = out; usedSpeechSamples = samples.length; passes.spoken = 'done'; }
      else passes.spoken = 'rejected_' + why;
    } catch (e) { passes.spoken = 'failed'; }
  }

  // 3 — the shape. Cheap JSON around the finished script; buildIdea never lets it touch `script`.
  let shaped = null;
  const shapeBudget = left();
  if (shapeBudget >= MIN_SHAPE_MS) {
    try {
      const rawShape = await writerCallResilient({
        messages: [{ role: 'user', content: shapePrompt(script, format) }],
        model: 'grok', engine: bc.engine || 'grok', max_tokens: SHAPE_MAX_TOKENS, temperature: 0.4,
        deadlineMs: shapeBudget,
        provider: pickProvider(o.provider), effort: SHAPE_EFFORT,
      }, { providerFromEnv: providerFromEnv(o.provider), label: 'shape' });
      const p = extractJson(rawShape);
      if (p && typeof p === 'object' && !Array.isArray(p)) { shaped = p; passes.shape = 'done'; }
      else passes.shape = 'unparsed';
    } catch (e) { passes.shape = 'failed'; }
  }

  const idea = buildIdea(script, shaped, angle, format, bc.brandName);
  idea.hashtags = hashtagsFor(bc, idea);   // fix7 — the brand's own themes + name, never the model's
  // fix7 — also at the top level (the contract names runWrite's `hashtags: string[]`); same array.
  return { idea, hashtags: idea.hashtags, usedStories: draft.usedStories, usedSpeechSamples, warnings: warningsFor(bc), passes };
}

module.exports = {
  styleGuide, runAngles, runWrite, FORMATS, SOURCE_KINDS,
  usageModel, writerCall, writerCallResilient, CLAUDE_CALL_PLAN, CLAUDE_THINKING_HEADROOM, LOWER_EFFORT, DRAFT_MAX_TOKENS, SPOKEN_MAX_TOKENS, ANGLES_MAX_TOKENS, SHAPE_MAX_TOKENS, writerEffort, writerProvider, WRITER_EFFORT, startBrandAttribution,
  _internals: {
    normSource, normAngle, slotsOf, inventedFacts, hashtagsFor, numberTokens, nameTokens, claimTokens, slotifyInvented, slotNeighbourNovelty, spokenRejects, parseDraft, buildIdea, cleanScript,
    brandBlockV2, allowedMaterial, userFacts, USER_FACT_FIELDS, AI_FILLED_FIELDS, metaOf, warningsFor, speechSamplesFor, normStories, anglesFrom,
    DRAFT_SHARE, SHAPE_SHARE, MIN_SPOKEN_MS, MIN_SHAPE_MS, SHAPE_EFFORT,
  },
};
