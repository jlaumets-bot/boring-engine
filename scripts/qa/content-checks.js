// content-checks.js — DETERMINISTIC measurements on generated scripts.
//
// WHY THIS EXISTS: every output defect found by hand on 2026-08-29/30 was MEASURABLE, not aesthetic:
// telegraph fragments with no finite verb, zero connective words, 44 words against a 90-150 spec,
// three sentences opening the same way, and a script that walked through the product instead of
// talking to the listener. Each of those is arithmetic. Jörgen was doing it by filming a take and
// sending a screenshot; a machine can do it on six scripts at once.
//
// THE BOUNDARY, ON PURPOSE: this measures, it does NOT judge. Nothing here decides whether writing
// is GOOD — the QA vision driver has a track record of being confidently wrong about content (it
// once decided Boring Electrolytes was a sourcing company and marked on-brand posts as off-brand).
// So every flag prints the offending sentence, and the raw script goes in the report verbatim. The
// numbers narrow where to look; the taste call stays human.
//
// Self-test:  node scripts/qa/content-checks.js
// It runs the REAL scripts from the 2026-08-30 reports (two known-bad, one known-good) and asserts
// the checks separate them. A metric that cannot fail on the known-bad script is decorative.

// ── tokenising ───────────────────────────────────────────────────────────────
const words = s => String(s || '').toLowerCase().match(/[a-z0-9']+/g) || [];

// Split on sentence enders, keeping it simple and predictable. Scripts are short and plainly
// punctuated, so a full sentence tokeniser would add failure modes without adding accuracy.
function sentences(s) {
  return String(s || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map(x => x.trim())
    .filter(x => x.length > 1);
}

// ── 1 · verbless-sentence candidates (the fragment tell) ─────────────────────
// HEURISTIC, AND LABELLED AS ONE. The observed fragments were noun phrases with a full stop —
// "Sales follow-ups eating hours." / "Tools that don't talk." / "No jargon needed." — so a sentence
// is FLAGGED when it contains no finite verb from a closed list and no obvious inflected verb.
// It will occasionally flag a valid short line, which is why the sentence itself is always printed:
// a reader confirms in one second. Never treat the count alone as a verdict.
const FINITE = new Set([
  'is','are','was','were','be','been','am','isn\'t','aren\'t','wasn\'t','weren\'t',
  'do','does','did','don\'t','doesn\'t','didn\'t','have','has','had','haven\'t','hasn\'t',
  'can','could','will','would','should','shall','may','might','must','can\'t','won\'t','wouldn\'t',
  'get','gets','got','go','goes','went','make','makes','made','take','takes','took','put','puts',
  'need','needs','want','wants','know','knows','knew','think','thinks','see','sees','saw',
  'say','says','said','give','gives','gave','come','comes','came','keep','keeps','kept',
  'start','starts','started','stop','stops','stopped','pay','pays','paid','send','sends','sent',
  'pick','picks','picked','write','writes','wrote','read','reads','find','finds','found',
  'work','works','worked','use','uses','used','call','calls','called','turn','turns','turned',
  'let','lets','tell','tells','told','feel','feels','felt','look','looks','looked','means','mean',
  'costs','cost','sells','sell','sold','buy','buys','bought','ask','asks','asked','leave','leaves',
  'eat','eats','ate','drink','drinks','drank','run','runs','ran','sit','sits','sat','die','dies',
  // CONTRACTED copulas and auxiliaries. Missing these was a real false positive in the self-test:
  // "That's the bit that's broken." is a complete sentence and was flagged as verbless, because the
  // tokeniser keeps the apostrophe and "that's" was not in the list. Speech is full of these, so
  // omitting them would flag the very writing style the checks are supposed to reward.
  'that\'s','it\'s','he\'s','she\'s','there\'s','here\'s','what\'s','who\'s','where\'s','how\'s',
  'you\'re','we\'re','they\'re','i\'m','you\'ve','we\'ve','they\'ve','i\'ve','you\'ll','we\'ll',
  'i\'d','you\'d','we\'d','they\'d','let\'s','ain\'t',
]);
// Regular inflections that are almost always a verb in these scripts.
const INFLECTED = /\b\w{3,}(?:ed|ing)\b/;

// STRUCTURAL RESCUE, because a closed verb list always leaks. "You only talk to the one you choose"
// was flagged purely because `talk` and `choose` were not listed — and no list will ever be
// complete. English requires a finite verb after a subject pronoun in a main clause, so a sentence
// opening with one, plus at least two more words, has a verb whether or not I know the word. None of
// the real fragments start this way ("Sales follow-ups eating hours", "Messy problem in", "Useful AI
// solution out"), so this removes false positives without weakening the actual signal.
const SUBJ_PRONOUN = new Set(['i', 'you', 'we', 'they', 'he', 'she', 'it', 'that', 'this', 'there', 'who', 'nobody', 'everyone', 'someone']);

function verblessCandidates(script) {
  const out = [];
  for (const s of sentences(script)) {
    const w = words(s);
    if (w.length < 2) continue;                     // "Yes." — an interjection, not the defect
    if (SUBJ_PRONOUN.has(w[0]) && w.length >= 3) continue;
    const hasFinite = w.some(x => FINITE.has(x));
    // "-ing" alone is NOT a finite verb ("Sales follow-ups eating hours" is exactly the bug), so an
    // inflected word only rescues the sentence when it ends in -ed (past tense, usually finite).
    const hasInflected = /\b\w{3,}ed\b/.test(s.toLowerCase());
    if (!hasFinite && !hasInflected) out.push(s);
  }
  return out;
}

// ── 2 · connective tissue (what makes it sound spoken) ───────────────────────
// The single clearest difference between written copy and speech. Written copy strips these;
// a person talking cannot avoid them.
const CONNECTIVES = ['because','so','but','and','which','that\'s why','which means','then','though',
  'while','since','unless','otherwise','instead','anyway','actually','the way','here\'s what'];
function connectives(script) {
  const t = ' ' + String(script || '').toLowerCase().replace(/[^a-z0-9'\s]/g, ' ') + ' ';
  let n = 0;
  const found = [];
  for (const c of CONNECTIVES) {
    const re = new RegExp('\\s' + c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s', 'g');
    const m = t.match(re);
    if (m) { n += m.length; found.push(c + '×' + m.length); }
  }
  const wc = words(script).length || 1;
  return { count: n, per100: +(n / wc * 100).toFixed(1), found };
}

// ── 3 · length against the format's own floor ────────────────────────────────
// Straight from the format specs in api/generate-ideas.js. The 44-word script that started all of
// this was less than half its stated minimum, and nothing was checking.
const FLOOR = { video: [90, 150], micro: [30, 60], qna: [25, 60], statement: [15, 40] };
function lengthCheck(script, format) {
  const wc = words(script).length;
  const f = FLOOR[format];
  if (!f) return { words: wc, ok: true, note: 'no floor defined for ' + format };
  return { words: wc, min: f[0], max: f[1], ok: wc >= f[0] && wc <= f[1] * 1.35,
    note: wc < f[0] ? `UNDER the ${f[0]}-word floor` : (wc > f[1] * 1.35 ? `well over the ${f[1]}-word target` : 'in range') };
}

// ── 4 · repeated sentence openings (monotone construction) ───────────────────
// Grammatical sentences still drone if they all start the same way. The second AI WILLO draft had
// 3 of 5 opening "You ..." and every one subject-verb-object — correct grammar, metronome rhythm.
function openings(script) {
  const heads = sentences(script).map(s => words(s).slice(0, 2).join(' ')).filter(Boolean);
  const firstWord = sentences(script).map(s => (words(s)[0] || '')).filter(Boolean);
  const tally = {};
  for (const h of firstWord) tally[h] = (tally[h] || 0) + 1;
  const worst = Object.entries(tally).sort((a, b) => b[1] - a[1])[0] || ['', 0];
  return { sentences: heads.length, heads, repeatedWord: worst[0], repeatedCount: worst[1],
    monotone: worst[1] >= 3 };
}

// ── 5 · feature-tour signal ──────────────────────────────────────────────────
// A script that names the brand repeatedly and walks its mechanism is a product tour, not content.
// This is the metric that would have caught the AI WILLO draft without anyone filming it.
// FIRST VERSION GATED ON THE BRAND NAME AND MISSED THE REAL CASE. The tour script named "Willo"
// only once and used no "then", so a brand-mention threshold scored it clean — while the earlier
// AI WILLO script, which was also a pure walkthrough, never named the brand at all. Counting brand
// mentions is not the signal.
//
// What actually separates a tour from content: a tour describes a PROCESS the product performs
// ("turns it into a brief, a person reviews it") and contains no trace of anything the listener has
// LIVED ("you've had a leak", "all three gave you a different number"). So the signal is mechanism
// verbs present AND lived-experience markers absent. Components are always printed — this narrows
// where to look, it does not pass judgement.
const MECHANISM = ['turns','turn','converts','convert','reviews','review','matches','match',
  'sends','send','returns','return','generates','generate','processes','process','creates','create',
  'builds','build','sorts','sort','filters','filter','scores','score','vets','vet','assigns','assign'];
// Perfect/past forms are how someone describes something that happened TO them.
const EXPERIENTIAL = /\b(you've|you'd|i've|we've|they've|had|was|were|ended up|used to|last (?:week|month|year)|yesterday)\b/g;

function featureTour(script, brandName) {
  const t = String(script || '').toLowerCase();
  const bn = String(brandName || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);
  let brandHits = 0;
  for (const w of bn) { const m = t.match(new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g')); if (m) brandHits += m.length; }
  let mech = 0;
  const mechFound = [];
  for (const v of MECHANISM) { const m = t.match(new RegExp('\\b' + v + '\\b', 'g')); if (m) { mech += m.length; mechFound.push(v); } }
  const exp = (t.match(EXPERIENTIAL) || []).length;
  const chain = (t.match(/\bthen\b/g) || []).length;
  const wc = words(script).length || 1;
  return { brandMentions: brandHits, per100: +(brandHits / wc * 100).toFixed(1),
    mechanismVerbs: mech, mechanismFound: mechFound, experiential: exp, chainWords: chain,
    tourSignal: mech >= 2 && exp === 0 };
}

// ── 6 · convergence: do different scripts open the same way? ─────────────────
// The risk the worked example was designed against. Compares the first four words of every script
// in the run, across brands and within a brand.
function convergence(items) {
  const key = s => words(s).slice(0, 4).join(' ');
  const seen = {};
  for (const it of items) {
    if (!it.script) continue;
    const k = key(it.script);
    (seen[k] = seen[k] || []).push(`${it.brand}/${it.format}`);
  }
  const dupes = Object.entries(seen).filter(([, v]) => v.length > 1);
  // Also: how many scripts open with the same FIRST word across the whole run.
  const firsts = {};
  for (const it of items) { if (!it.script) continue; const w = words(it.script)[0]; if (w) firsts[w] = (firsts[w] || 0) + 1; }
  const topFirst = Object.entries(firsts).sort((a, b) => b[1] - a[1])[0] || ['', 0];
  const total = items.filter(i => i.script).length || 1;
  return { identicalOpenings: dupes, topFirstWord: topFirst[0], topFirstCount: topFirst[1],
    sameFirstWordShare: +(topFirst[1] / total * 100).toFixed(0) };
}

// ── 7 · CROSS-BRAND LEAK (the one class here with real consequences) ─────────
// A customer reading another brand's facts in their own post is not a taste problem, it is a
// breach of the basic promise. This app has had the class more than once: blog posts and questions
// bleeding through a shared localStorage bucket, the coach being handed the previous brand's post,
// and switch races writing one brand's library under another's id.
//
// TWO independent detections, both deterministic:
//   (a) TERM CONTAMINATION — a term distinctive to brand A appearing in brand B's script. Distinctive
//       means: in A's own brand context, ≥5 characters, not a stopword, and NOT in B's context.
//       Requiring absence from B's context is what stops shared industry words raising false alarms.
//   (b) BRAND MISMATCH — the app reported a different active brand at generation time than the one
//       the harness switched to. That is a switch race, and it is invisible from a screenshot.
const LEAK_STOP = new Set(['their','there','these','those','which','where','while','about','after',
  'before','being','every','other','people','because','through','without','should','would','could',
  'brand','content','audience','customer','customers','product','products','something','anything',
  'really','never','always','first','still','right','things','think','thing','video','post','posts',
  'social','media','make','makes','making','know','knows','want','wants','need','needs','more','most']);

function distinctiveTerms(ctxText) {
  const out = new Set();
  for (const w of words(ctxText)) {
    if (w.length >= 5 && !LEAK_STOP.has(w) && !/^\d+$/.test(w)) out.add(w);
  }
  return out;
}

function crossBrandLeak(items, ctx) {
  const leaks = [];
  const mismatches = [];
  ctx = ctx || {};
  const brands = Object.keys(ctx);
  // Terms unique to each brand: in its own context and in no other brand's.
  const own = {};
  for (const b of brands) own[b] = distinctiveTerms(ctx[b]);
  const unique = {};
  for (const b of brands) {
    unique[b] = new Set([...own[b]].filter(t => brands.every(o => o === b || !own[o].has(t))));
  }
  for (const it of items) {
    if (it.actualBrand && it.brand && it.actualBrand !== it.brand) {
      mismatches.push({ intended: it.brand, actual: it.actualBrand, format: it.format });
    }
    if (!it.script) continue;
    const t = new Set(words(it.script + ' ' + (it.title || '') + ' ' + (it.hook || '')));
    for (const other of brands) {
      if (other === it.brand) continue;
      const hits = [...(unique[other] || [])].filter(term => t.has(term));
      if (hits.length) leaks.push({ inBrand: it.brand, format: it.format, fromBrand: other, terms: hits.slice(0, 8) });
    }
  }
  return { leaks, mismatches, checked: brands.length };
}

// ── the whole report for one harvested run ───────────────────────────────────
function analyse(items, ctx) {
  const per = items.map(it => {
    if (!it.script) return { ...it, skipped: true };
    return {
      ...it,
      verbless: verblessCandidates(it.script),
      connect: connectives(it.script),
      length: lengthCheck(it.script, it.format),
      open: openings(it.script),
      tour: featureTour(it.script, it.brand),
    };
  });
  return { per, run: convergence(items), leak: crossBrandLeak(items, ctx) };
}

module.exports = { analyse, verblessCandidates, connectives, lengthCheck, openings, featureTour, convergence, crossBrandLeak, distinctiveTerms, sentences, words };

// ── self-test: the checks must separate the REAL known-bad from the known-good ─
if (require.main === module) {
  // Verbatim from the 2026-08-30 screenshots.
  const FRAGMENTS = "Yes. Start with the messy workflow. No jargon needed. Sales follow-ups eating hours. Tools that don't talk. Briefing is free. A person reviews it, then you get 2-3 vetted experts. You pick who to talk to. Messy problem in. Useful AI solution out.";
  const TOUR = "You don't shop a freelancer feed. You put the messy problem in. Willo turns it into a brief, a person reviews it, and you get 2-3 vetted experts. Names stay hidden until you pick. You only talk to the one you choose.";
  const GOOD = "You've had a leak and called three plumbers, and all three gave you a different number for the same job. So you're not really choosing a plumber, you're guessing which one is overcharging you the least. That's the bit that's broken. You send one photo, someone who knows the trade writes the actual job down, and the quotes that come back are all for the same piece of work.";

  const fails = [];
  const t = (name, cond, detail) => { console.log((cond ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : '')); if (!cond) fails.push(name); };

  const fv = verblessCandidates(FRAGMENTS), gv = verblessCandidates(GOOD);
  t('flags the fragment script', fv.length >= 3, `${fv.length} verbless candidates: ${JSON.stringify(fv.slice(0, 3))}`);
  t('does NOT flag the flowing script', gv.length === 0, `${gv.length} flagged`);

  const fc = connectives(FRAGMENTS), gc = connectives(GOOD);
  t('flowing script has far more connective tissue', gc.per100 > fc.per100 * 1.5, `fragments ${fc.per100}/100w vs flowing ${gc.per100}/100w`);

  const fl = lengthCheck(FRAGMENTS, 'video');
  t('catches the 44-word script against the video floor', !fl.ok && fl.words < 90, `${fl.words} words, ${fl.note}`);

  const to = openings(TOUR);
  t('catches monotone openings in the tour script', to.monotone, `"${to.repeatedWord}" opens ${to.repeatedCount} sentences`);
  t('does NOT call the flowing script monotone', !openings(GOOD).monotone);

  const ft = featureTour(TOUR, 'AI Willo'), gt = featureTour(GOOD, 'AI Willo');
  t('flags the feature-tour script', ft.tourSignal,
    `mech=${ft.mechanismVerbs} ${JSON.stringify(ft.mechanismFound)} experiential=${ft.experiential}`);
  t('does NOT flag the flowing script as a tour', !gt.tourSignal,
    `mech=${gt.mechanismVerbs} experiential=${gt.experiential} — lived experience is what saves it`);
  // Honest limit, asserted so nobody assumes more coverage than exists: the FIRST AI WILLO script
  // was also a walkthrough but is too compressed to carry mechanism verbs, so this metric misses it.
  // It is caught by the verbless and length checks instead — the layers cover each other.
  t('KNOWN LIMIT: the fragment script slips past the tour check (caught by the other two)',
    !featureTour(FRAGMENTS, 'AI Willo').tourSignal
      && verblessCandidates(FRAGMENTS).length >= 3
      && !lengthCheck(FRAGMENTS, 'video').ok);

  const cv = convergence([{ brand: 'A', format: 'video', script: GOOD }, { brand: 'B', format: 'video', script: GOOD }]);
  t('detects two scripts opening identically', cv.identicalOpenings.length === 1);

  // CROSS-BRAND LEAK — the class with real consequences, so it gets a real fixture: two brands with
  // genuinely different worlds, and one script that has been contaminated with the other's facts.
  const CTX = {
    'BORING': 'Boring Electrolytes sodium 1000mg potassium magnesium unflavoured stick marathon cramping proprietary blend LMNT',
    'AI WILLO': 'AI Willo vetted experts freelancer briefing workflow automation founders sourcing shortlist',
  };
  const CLEAN = [
    { brand: 'BORING', format: 'video', actualBrand: 'BORING', script: 'You are not underhydrated, you are undersalted, so plain water just leaves faster.' },
    { brand: 'AI WILLO', format: 'video', actualBrand: 'AI WILLO', script: 'You have scrolled a freelancer site and had no idea who was any good.' },
  ];
  const LEAKED = CLEAN.concat([
    { brand: 'AI WILLO', format: 'micro', actualBrand: 'AI WILLO',
      script: 'Check the sodium number on the back, because under 1000mg of potassium is a flavoured drink.' },
  ]);
  const okLeak = crossBrandLeak(CLEAN, CTX);
  const badLeak = crossBrandLeak(LEAKED, CTX);
  t('no false alarm when each brand stays in its own world', okLeak.leaks.length === 0,
    `${okLeak.checked} brands compared`);
  t('CATCHES a brand-B script carrying brand-A facts', badLeak.leaks.length === 1,
    badLeak.leaks.length ? `${badLeak.leaks[0].fromBrand} terms in ${badLeak.leaks[0].inBrand}: ${JSON.stringify(badLeak.leaks[0].terms)}` : 'MISSED IT');

  // A switch race: the app was on a different brand than the one we asked for.
  const raced = crossBrandLeak([{ brand: 'BORING', format: 'video', actualBrand: 'AI WILLO', script: 'x' }], CTX);
  t('catches a brand mismatch at generation time', raced.mismatches.length === 1,
    raced.mismatches.length ? `intended ${raced.mismatches[0].intended}, app was on ${raced.mismatches[0].actual}` : 'MISSED IT');

  console.log(`\ncontent-checks self-test: ${fails.length ? 'FAILED — ' + fails.join(', ') : 'all checks separate known-bad from known-good'}`);
  if (fails.length) process.exitCode = 1;
}
