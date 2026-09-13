#!/usr/bin/env node
// Prompt-contract verification.
//
// THE CLASS THIS GATE CLOSES: a generator asks the model for something nobody consumes, tells it
// two contradictory things, or gets one half of a rule pair while its sibling gets both. Every one
// of those is invisible in the source — each file reads fine on its own — and shows up only in the
// ASSEMBLED prompt or in what actually reaches the client. Found this way, in one round:
//
//   • `emphasis` requested with a ~250-char instruction, then dropped by cleanIdeas — while four
//     live call sites in app.html feed idea.emphasis into the teleprompter, so its preferred
//     branch had been dead since the field was added.
//   • `screen` requested by viral-rewrite after generate-ideas retired it in v609 and app.html
//     lost its last render site.
//   • the tone instruction saying "not a style to rotate through" (brand block, 84%) and
//     "one of the tone options" (JSON schema, 94% — the last thing read) in the same prompt.
//   • `tone: idea.tone || 'witty'` three lines under a comment explaining that exact fallback had
//     been removed for inventing a voice — read by Settings, which tallied "N ideas" per tone.
//   • the weekly calendar rendered from `bc.dayMap`, a key only three call sites hand-build, while
//     getBrandContext() and _brandctx both emit `dayRotation` — so six generators lost it.
//   • spokenShape(), which exists as the counterweight to clarityFlow's compression rules and says
//     so in its own text, reaching generate-ideas but not sharpen, which also carries clarityFlow.
//   • rulePrecedence() opening "read this last" in the one generator where ~4000 chars follow it.
//
// SO THIS GATE ASSEMBLES THE REAL PROMPT (stubbing only the LLM and auth, the technique
// brand-prompt.mjs uses) and reads the REAL returned object. A file-level grep passes on an
// unwired import and cannot see a field the response map drops.
//
// It asserts BEHAVIOUR and CONCEPTS, never marketing phrasing. Where a rule's text is checked at
// all, the expected text is DERIVED AT RUNTIME from the function that produces it — so the copy
// can be rewritten freely and only its DELIVERY is ratcheted (an assertion coupled to wording
// punishes improving the wording: the v619 lesson).
//
//   node scripts/verify/prompt-contract.mjs

import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const API = join(ROOT, 'api');
const require = createRequire(import.meta.url);

const fails = [];
const passes = [];
const check = (cond, label, detail) => (cond ? passes : fails).push(detail && !cond ? `${label} — ${detail}` : label);

// ── stub plumbing ────────────────────────────────────────────────────────────
function stub(relPath, exports) {
  const resolved = require.resolve(join(API, relPath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
}

let captured = [];
let nextReplies = [];
stub('_llm.js', {
  callLLM: async (opts) => {
    captured.push(opts);
    const r = nextReplies.shift();
    if (r == null) throw new Error('prompt-contract: handler made more callLLM calls than queued');
    return r;
  },
  callGrokSearch: async () => null,
});
stub('_usage.js', {
  guard: async () => ({ user: { id: 'u1' }, over: false, gate: {} }),
  checkLimit: async () => ({ ok: true }),
  creditsFor: () => 1, costFor: () => 0, logUsage: async () => {},
});
stub('_requireUser.js', async () => ({ id: 'u1' }));
stub('_publish/store.js', {
  getUser: async () => ({ id: 'u1' }),
  userCanAccessBrand: async () => true,
  rest: async () => ({ data: [{ gemini_key_enc: 'enc' }] }),
});
stub('_publish/crypto.js', { encrypt: () => 'enc', decrypt: () => ({ key: 'fake' }) });
process.env.CRON_SECRET = 'contract-secret';
const CRON = { authorization: 'Bearer contract-secret' };

function mkRes() {
  const res = {
    _status: 0, _json: null,
    setHeader() { return res; },
    status(c) { res._status = c; return res; },
    json(o) { res._json = o; return res; },
    end() { return res; },
  };
  return res;
}

async function run(handlerFile, body, replies, headers = {}) {
  captured = [];
  nextReplies = replies.slice();
  const handler = require(join(API, handlerFile));
  const req = { method: 'POST', headers: { origin: 'https://contentshrimp.com', ...headers }, body };
  const res = mkRes();
  await handler(req, res);
  return { res, calls: captured.slice(), prompt: captured.map(c => (c.messages || []).map(m => m.content).join('\n')).join('\n') };
}

// ── the fake brand ───────────────────────────────────────────────────────────
// tones are real TONE_OPTIONS ids from app.html, because the whole point of the tone field is that
// Settings can match it against one (`IDEAS.filter(i => i.tone === t.id)`).
const BC = {
  brandId: 'brand-1',
  brandName: 'Boring Electrolytes',
  tagline: 'Three ingredients. No marketing.',
  usps: 'Sodium 1000mg, potassium 200mg, magnesium 60mg per stick.',
  targetAudience: 'Endurance runners aged 25 to 45 who read the label first.',
  tones: ['deadpan', 'authoritative'],
  communities: ['marathon training', 'shift work'],
  painPoints: 'Cramping at mile eighteen. Paying premium money for sugar water.',
  brandVocab: 'dose, stick, label, the actual numbers',
  coachNotes: 'Name the dose in the first two lines.',
  approvedExamples: [], recentTrends: [], engine: 'grok',
};
const CAL_SENTINEL = 'ZCONTRACT_CALENDAR_THEME';
const DAY_ROTATION_OBJ = {   // the shape app.html getBrandContext() and api/_brandctx.js both emit
  Monday: CAL_SENTINEL, Tuesday: 'training', Wednesday: 'shift work', Thursday: 'myths',
  Friday: 'founder', Saturday: 'long run', Sunday: 'recovery', Bonus: 'All',
};

const brain = require(join(API, '_brain.js'));

// ── helpers ──────────────────────────────────────────────────────────────────
// Pull the top-level keys out of a JSON-shaped schema block inside a prompt.
function schemaKeys(prompt, afterMarker) {
  const at = prompt.indexOf(afterMarker);
  if (at < 0) return null;
  const open = prompt.indexOf('{', at);
  if (open < 0) return null;
  let depth = 0, end = -1;
  for (let i = open; i < prompt.length; i++) {
    if (prompt[i] === '{') depth++;
    else if (prompt[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return null;
  const block = prompt.slice(open, end + 1);
  const keys = [];
  const re = /^\s{2}"([^"]+)"\s*:/gm;
  let m;
  while ((m = re.exec(block))) keys.push(m[1]);
  return keys;
}

// ═════════════════════════════════════════════════════════════════════════════
// 1 · EVERY FIELD THE SCHEMA ASKS FOR SURVIVES TO THE CLIENT
//     Written generically on purpose: this is the CLASS behind `emphasis` and `screen`, so a field
//     added to the schema and forgotten in the response map goes red on its own, with no new
//     assertion to write.
// ═════════════════════════════════════════════════════════════════════════════
const IDEAS_BODY = { brandContext: BC, count: 1, learningContext: '' };
const probe = await run('generate-ideas.js', IDEAS_BODY, ['[]'], CRON);
const GI_KEYS = schemaKeys(probe.prompt, 'Each idea:');

check(Array.isArray(GI_KEYS) && GI_KEYS.length >= 10,
  'generate-ideas: the JSON schema block is locatable and non-trivial',
  `parsed ${GI_KEYS ? GI_KEYS.length : 'null'} keys — if the schema was restructured, teach this parser about it rather than dropping the check`);

if (GI_KEYS) {
  // A schema key must be a FIELD NAME, not an instruction wearing a key's clothes. The prompt
  // carried `"emphasisNote — how to fill \"emphasis\"": "..."` — ~250 tokens the model was invited
  // to echo back as a key nothing reads.
  const oddKeys = GI_KEYS.filter(k => !/^[A-Za-z][A-Za-z0-9_]*$/.test(k));
  check(oddKeys.length === 0,
    'generate-ideas: every schema key is a plain field name, not an instruction',
    `instruction-shaped key(s): ${oddKeys.join(' | ').slice(0, 120)}`);

  // Fields whose value is legitimately coerced (a whitelist, or the tone clamp). Everything else
  // must come back byte-identical, which is what proves it was not silently dropped.
  const validDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'Bonus'];
  const validFormats = ['video', 'carousel', 'static', 'statement', 'micro', 'bonus', 'qna'];
  const CONSTRAINED = {
    day: v => validDays.includes(v),
    format: v => validFormats.includes(v),
    tone: v => BC.tones.includes(v),
  };
  const reply = {};
  for (const k of GI_KEYS) {
    if (k === 'day') reply[k] = 'Monday';
    else if (k === 'format') reply[k] = 'video';
    else if (k === 'tone') reply[k] = 'deadpan';
    else if (k === 'emphasis') reply[k] = ['ZCONTRACT_EMPHASIS_ONE', 'ZCONTRACT_EMPHASIS_TWO'];
    else reply[k] = 'ZCONTRACT_' + k.toUpperCase();
  }
  const full = await run('generate-ideas.js', IDEAS_BODY, [JSON.stringify([reply])], CRON);
  const got = (full.res._json && full.res._json.ideas && full.res._json.ideas[0]) || null;
  check(full.res._status === 200 && got,
    'generate-ideas: a fully-populated model reply comes back as one idea',
    'status ' + full.res._status);

  if (got) {
    for (const k of GI_KEYS) {
      const has = Object.prototype.hasOwnProperty.call(got, k);
      check(has, `generate-ideas: schema field "${k}" is not dropped before the client sees it`,
        `the prompt spends tokens asking for it and cleanIdeas() never copies it — either return it or stop asking`);
      if (!has) continue;
      if (CONSTRAINED[k]) {
        check(CONSTRAINED[k](got[k]), `generate-ideas: "${k}" comes back as a legal value`, `got ${JSON.stringify(got[k])}`);
      } else {
        const same = JSON.stringify(got[k]) === JSON.stringify(reply[k]);
        check(same, `generate-ideas: "${k}" reaches the client with its value intact`,
          `sent ${JSON.stringify(reply[k]).slice(0, 60)} got ${JSON.stringify(got[k]).slice(0, 60)}`);
      }
    }
  }
}

// The same class on the other side of the wire: viral-rewrite returns the model object verbatim,
// so its drop point is the FRONTEND. app.html's `_RWK` is the list of keys it actually applies —
// a schema key missing from it is a field written for nobody (that was `screen`).
const REWRITE_REPLY = JSON.stringify({ title: 't', hook: 'h', script: 's', shots: '', boldText: '', caption: '', tags: '#a' });
const vr = await run('viral-rewrite.js', {
  idea: { title: 't', hook: 'h', script: 's', format: 'video' },
  angle: { angle: 'Contrarian', hook: 'h' }, brandContext: BC,
}, [REWRITE_REPLY]);
const VR_KEYS = schemaKeys(vr.prompt, 'Respond with EXACTLY this JSON');
const appSrc = readFileSync(join(ROOT, 'app.html'), 'utf8');
const rwkMatch = appSrc.match(/_RWK\s*=\s*\[([^\]]*)\]/);
check(!!rwkMatch, 'viral-rewrite: app.html\'s _RWK apply-list is locatable',
  'without it this check cannot tell a consumed field from a dead one — fix the parser, do not delete the check');
check(Array.isArray(VR_KEYS) && VR_KEYS.length >= 5, 'viral-rewrite: its JSON schema block is locatable',
  `parsed ${VR_KEYS ? VR_KEYS.length : 'null'} keys`);
if (rwkMatch && VR_KEYS) {
  const consumed = rwkMatch[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  const orphans = VR_KEYS.filter(k => !consumed.includes(k));
  check(orphans.length === 0,
    'viral-rewrite: every field its schema asks for is applied by the frontend',
    `nothing reads: ${orphans.join(', ')} — either wire a consumer or stop asking the model for it`);
}

// ═════════════════════════════════════════════════════════════════════════════
// 2 · NO INVENTED DEFAULT FOR A FIELD THE BRAND DID NOT SET
// ═════════════════════════════════════════════════════════════════════════════
const noTones = await run('generate-ideas.js',
  { ...IDEAS_BODY, brandContext: { ...BC, tones: [] } },
  [JSON.stringify([{ day: 'Monday', format: 'video', title: 't', hook: 'h', script: 's' }])], CRON);
const noToneIdea = (noTones.res._json && noTones.res._json.ideas && noTones.res._json.ideas[0]) || {};
check(!String(noToneIdea.tone || '').trim(),
  'a brand that set no tones gets no invented tone on its ideas',
  `got ${JSON.stringify(noToneIdea.tone)} — Settings tallies this field, so an invented value is a wrong number on screen`);

// And a value the brand never chose is never passed through either: it is pulled back to one of
// the brand's OWN tones, so the Settings counter always counts something real.
const offList = await run('generate-ideas.js', IDEAS_BODY,
  [JSON.stringify([{ day: 'Monday', format: 'video', tone: 'whimsical-pirate', title: 't', hook: 'h', script: 's' }])], CRON);
const offIdea = (offList.res._json && offList.res._json.ideas && offList.res._json.ideas[0]) || {};
check(BC.tones.includes(offIdea.tone),
  'a tone the brand never chose is clamped to one of the brand\'s own tones',
  `got ${JSON.stringify(offIdea.tone)}`);

// ═════════════════════════════════════════════════════════════════════════════
// 3 · THE TONE INSTRUCTION DOES NOT BOTH FORBID ROTATION AND REQUEST A PER-ITEM PICK
//     Concept-level. The brand rule lives in fullBrandBlock; the offer lived in the schema, which
//     sits later in the prompt and therefore won.
// ═════════════════════════════════════════════════════════════════════════════
const P = probe.prompt;
const forbidsRotation = /not a style to rotate through|not a menu|do not give different ideas different tones/i.test(P);
check(forbidsRotation,
  'the prompt states that the brand tone is one held voice, not a rotation',
  'the brand block rule went missing — that rule is the reason the schema may not offer a choice');
// "one of the ...", "pick a tone", "choose a tone", "a different tone for each" all present the
// field as a menu. Any of them alongside the rule above is the contradiction.
const offersMenu = /one of the tone|pick (a|one) tone|choose (a|one) tone|different tone for each|vary the tone/i.test(P);
check(!offersMenu,
  'the prompt never offers the tone as a per-idea menu while forbidding rotation',
  'found a per-item tone choice in the same prompt as the "hold one voice" rule — the later one wins on position');
// The schema value must be the brand's actual tone, so the model copies a label rather than making
// a selection (and so Settings can match it).
const toneLine = (P.match(/^\s*"tone"\s*:\s*"([^"]*)"/m) || [])[1] || '';
check(toneLine.toLowerCase().includes(BC.tones[0]),
  'the schema shows the brand\'s own tone as the value to copy',
  `schema tone value is ${JSON.stringify(toneLine)}`);

// ═════════════════════════════════════════════════════════════════════════════
// 4 · THE WEEKLY CALENDAR RENDERS FOR A CALLER SENDING THE KEY THE FRONTEND ACTUALLY SENDS
//     getBrandContext() returns `dayRotation`; only three call sites hand-build the `dayMap`
//     string. sharpen is one of the six that do not, so it is the honest probe.
// ═════════════════════════════════════════════════════════════════════════════
const SHARPEN_BODY = (extra, format) => ({
  kind: 'post', format: format || 'video',
  content: { hook: 'Turn the packet over.', script: 'Find the sodium number on the back of whatever you are drinking.' },
  brandContext: { ...BC, ...extra },
});
const CRITIQUE = 'The hook buries the number.';
const SHARP_REPLY = JSON.stringify({ hook: 'Turn the packet over.', script: 'Find the sodium number.' });

const withRotation = await run('sharpen.js', SHARPEN_BODY({ dayRotation: DAY_ROTATION_OBJ }), [CRITIQUE, SHARP_REPLY]);
check(withRotation.prompt.includes(CAL_SENTINEL),
  'a generator that sends `dayRotation` (what getBrandContext actually returns) gets the weekly calendar',
  'the renderer read only `dayMap`, a key three call sites hand-build — so six generators rendered no calendar at all');
check(/60%/.test(withRotation.prompt),
  'the calendar carries its 60/40 variety rule',
  'the anti-repetition half of the calendar is what makes it worth rendering');

// The legacy `dayMap` STRING path must keep working byte-for-byte for the callers that use it.
const withDayMap = await run('sharpen.js',
  SHARPEN_BODY({ dayMap: `Monday = ${CAL_SENTINEL}, Tuesday = training` }), [CRITIQUE, SHARP_REPLY]);
check(withDayMap.prompt.includes(`Monday = ${CAL_SENTINEL}, Tuesday = training`),
  'the pre-existing `dayMap` string is still rendered verbatim');

// Negative control — proves the two checks above can actually fail.
const noCalendar = await run('sharpen.js', SHARPEN_BODY({}), [CRITIQUE, SHARP_REPLY]);
check(!/Weekly content calendar/i.test(noCalendar.prompt),
  'a brand with no rotation at all renders no empty calendar section',
  'a bare label teaches the model the brand has nothing to say there');

// ═════════════════════════════════════════════════════════════════════════════
// 5 · EVERY SPOKEN-SCRIPT SURFACE CARRIES THE COMPRESSION COUNTERWEIGHT
//     The rule pair is clarityFlow (compress) + spokenShape (override for speech). Receiving one
//     without the other is what produced verbless fragment scripts. The expected text is derived
//     from the functions themselves, so both may be rewritten freely.
// ═════════════════════════════════════════════════════════════════════════════
const SHAPE = brain.spokenShape();
const compressed = s => /cut every word|one idea per sentence/i.test(s);

const spokenSurfaces = [
  ['generate-ideas.js', probe.prompt],
  ['sharpen.js (video)', withRotation.prompt],
  ['viral-rewrite.js', vr.prompt],
];
for (const [label, text] of spokenSurfaces) {
  check(compressed(text), `${label}: carries the compression rules (the half that was never missing)`,
    'if this went red the pairing changed — re-derive what the counterweight is counterweighting');
  check(text.includes(SHAPE),
    `${label}: carries the spoken-script counterweight alongside them`,
    'compression pressure with no override strips every sentence to a noun phrase — unreadable into a lens');
}

// Scoped, not sprayed: a carousel is not read to camera, and sharpen has a deliberate
// same-length rule the spoken block must not be allowed to argue with on a written format.
const carousel = await run('sharpen.js', SHARPEN_BODY({}, 'carousel'), [CRITIQUE, SHARP_REPLY]);
check(!carousel.prompt.includes(SHAPE),
  'sharpen applies the spoken counterweight only to a spoken format',
  'proves the check above discriminates rather than passing on everything');

// ═════════════════════════════════════════════════════════════════════════════
// 6 · THE PRECEDENCE BLOCK'S SELF-DESCRIPTION MATCHES ITS REAL POSITION
//     It opened "read this last" — true in five generators, false in generate-ideas, where the
//     brand block, the winners and a ~3800-char JSON schema all follow it.
// ═════════════════════════════════════════════════════════════════════════════
const PRECEDENCE = brain.rulePrecedence().trim();
const claimsLast = /read (this|me) last|the last thing you (will )?read|read last/i.test(PRECEDENCE);
check(/outrank/i.test(PRECEDENCE) && PRECEDENCE.includes(brain.BRAND_HEADING),
  'the precedence block still asserts precedence and names the brand section',
  'gutting it would make every check below pass for the wrong reason');

const precedenceUsers = [
  ['generate-ideas.js', IDEAS_BODY, ['[]'], CRON],
  ['sharpen.js', SHARPEN_BODY({}), [CRITIQUE, SHARP_REPLY], {}],
  ['viral-rewrite.js', { idea: { title: 't', hook: 'h', script: 's', format: 'video' }, angle: { angle: 'a', hook: 'h' }, brandContext: BC }, [REWRITE_REPLY], {}],
  ['viral-twist.js', { idea: { title: 't', hook: 'h', script: 's', format: 'video' }, brandContext: BC }, [JSON.stringify({ angles: [{ angle: 'a', hook: 'h', why: 'w' }], spicy: { hook: 'h', why: 'w' }, tip: 't' })], {}],
  ['remix.js', { postDescription: 'a viral label video', creatorName: 'someone', platform: 'tiktok', remixMode: 'remix', brandContext: BC }, [JSON.stringify({ originalSummary: 's', remixTitle: 't', remixHook: 'h', remixScript: 'sc', remixFormat: 'video', remixCaption: 'c', remixHashtags: '#a', whyItWorks: 'w' })], {}],
  ['meme.js', { action: 'generate', brandId: 'brand-1', topic: 'labels', brandContext: BC }, ['not json — stop before the image call'], {}],
];
for (const [file, body, replies, headers] of precedenceUsers) {
  const r = await run(file, body, replies, headers);
  // Search EVERY call, not just the first: sharpen's precedence lives in its second (rewrite)
  // pass, and its first (critique) pass legitimately has none. Reading calls[0] only reported
  // that as a missing block — a broken oracle, caught by running it.
  const joined = r.calls
    .map(c => (c.messages || []).map(m => m.content).join('\n'))
    .find(t => t.includes(PRECEDENCE)) || '';
  if (!joined) {
    check(false, `${file}: uses the precedence block`, 'not found in its assembled prompt');
    continue;
  }
  const trailing = joined.slice(joined.indexOf(PRECEDENCE) + PRECEDENCE.length).trim();
  const isLast = trailing.length === 0;
  check(!claimsLast || isLast,
    `${file}: the precedence block does not claim a position it does not hold`,
    `it says it is read last, but ${trailing.length} chars follow it here — either move it or stop claiming it`);
}

// ── report ───────────────────────────────────────────────────────────────────
for (const p of passes) console.log('  ok   ' + p);
for (const f of fails) console.log('  FAIL ' + f);
console.log(`\nprompt-contract: ${passes.length} passed, ${fails.length} failed`);
if (fails.length) {
  console.error('prompt contract verification FAILED');
  process.exit(1);
}
console.log('prompt contract verification passed');
