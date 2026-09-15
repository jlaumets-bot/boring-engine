// Shared brand-brain context blocks.
// Goal: every generation surface (ideas, remix, viral, meme) uses the SAME taught
// signals, so what the user teaches in one place shows up everywhere. Wording here
// mirrors api/generate-ideas.js so behaviour stays consistent across the app.

function trendsBlock(bc) {
  bc = bc || {};
  if (bc.recentTrends && (Array.isArray(bc.recentTrends) ? bc.recentTrends.length : bc.recentTrends)) {
    const trends = Array.isArray(bc.recentTrends) ? bc.recentTrends : [bc.recentTrends];
    return '\nCURRENT TRENDS TO RIDE (the user flagged these as working RIGHT NOW from real viral videos — translate the MECHANIC into brand-true content, do NOT copy the original topics; weight these but do not force them):\n- ' + trends.join('\n- ');
  }
  return '';
}

function painBlock(bc) {
  bc = bc || {};
  return bc.painPoints ? '\nCUSTOMER PAIN POINTS (use for hooks — they stop the scroll):\n' + bc.painPoints : '';
}

function vocabBlock(bc) {
  bc = bc || {};
  return bc.brandVocab ? '\nBRAND VOCABULARY — use these phrases/words naturally:\n' + bc.brandVocab : '';
}

function avoidBlock(bc) {
  bc = bc || {};
  return bc.avoidWords ? '\nWORDS & PHRASES TO AVOID (never use these):\n' + bc.avoidWords : '';
}

// Full gap-filler for surfaces that currently include NONE of these (e.g. remix).
function brainExtras(bc) {
  return [painBlock(bc), vocabBlock(bc), avoidBlock(bc), trendsBlock(bc)].filter(Boolean).join('\n');
}

// ── THE brand renderer ───────────────────────────────────────────────────────
// THERE IS EXACTLY ONE OF THESE, ON PURPOSE. There used to be two: this, and a second, older
// renderer (`buildMasterPrompt`) living inside generate-ideas.js — which powers Ideas, Quick Post,
// Idea Catcher, Notebook-develop, PAA and auto-refill, i.e. nearly all output. They had drifted
// apart and each silently dropped fields the other kept: the old one dropped approvedExamples,
// learnedSignals, competitors, channels and visualStyle (measured: 7 populated fields never
// reached the model at all); this one dropped reviewInsights, categoryGripes, competitorMoves,
// webMentions, website and dayMap. This function is the UNION of both. Never fork it again —
// a second renderer is how a brand's own data goes missing without anyone noticing.
//
// The heading below is load-bearing: rulePrecedence() points at it BY NAME, so the model can
// resolve "the brand section wins" no matter which message the block ends up in.
const BRAND_HEADING = 'BRAND PROFILE';

// ── The weekly calendar, from EITHER key the app can send ────────────────────
// app.html's getBrandContext() returns the rotation as `dayRotation` (an OBJECT keyed by day)
// and _brandctx.js hydrates the same key server-side — but this renderer only ever read
// `bc.dayMap`, a STRING that only generateNewIdeas, autoRefillCheck and the Quick Post lanes
// hand-build before sending. So every other generator (sharpen, remix, viral-twist,
// viral-rewrite, meme, brand-voice-chat) rendered NO "Weekly content calendar" section at all,
// and lost the 60/40 variety rule that lives in its note — silently, because both files looked
// correct on their own.
// Reading both keys fixes it in one place. The `dayMap` STRING path is returned verbatim, so the
// callers that already send it are byte-identical.
const CAL_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'Bonus'];
function dayMapText(bc) {
  bc = bc || {};
  const str = v => (typeof v === 'string' && v.trim()) ? v.trim() : '';
  if (str(bc.dayMap)) return str(bc.dayMap);
  const obj = v => (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
  const dr = obj(bc.dayMap) || obj(bc.dayRotation);
  if (dr) {
    // Same shape app.html builds by hand: `DAYS.map(d => d + ' = ' + dc[d]).join(', ')`.
    return CAL_DAYS
      .filter(d => dr[d] != null && String(dr[d]).trim())
      .map(d => d + ' = ' + String(dr[d]).trim())
      .join(', ');
  }
  return str(bc.dayRotation);
}

// Approved winners are the strongest voice signal there is, so they get their own renderer:
// callers with long prompts place this LAST (recency), not buried 16k characters up top.
// The old flat 300-char cut turned a 120-word spoken script into a third of itself — a useless
// exemplar. Spoken formats get room to show their actual rhythm.
const SPOKEN_EX_FORMATS = ['video', 'micro', 'qna'];
// Non-spoken winners were capped at 600, which is under what the app itself writes for them: a
// carousel winner runs ~900 chars across its slides, so the exemplar handed back to the model
// stopped mid-slide — the same "a third of a script is a useless exemplar" bug the spoken cap
// already fixed, just one format later. 1000 clears a real carousel with headroom and still bounds
// four examples at 4k, well inside the block's own budget.
const exampleCap = fmt => (SPOKEN_EX_FORMATS.indexOf(String(fmt || '').trim().toLowerCase()) >= 0 ? 1400 : 1000);

function approvedWinnersBlock(bc) {
  bc = bc || {};
  const ex = (Array.isArray(bc.approvedExamples) ? bc.approvedExamples : [])
    .filter(e => e && String(e.text == null ? '' : e.text).trim());
  if (!ex.length) return '';
  // v640 — SAY WHAT THESE ACTUALLY ARE.
  // This block used to call every one of them "the truest statement of the voice… it beats every
  // description of the voice above". But an "approved" post is one tap on a card, and the text is
  // something THIS APP generated — so that sentence told the model its own prior output outranked
  // the brand's hand-written fields. Feeding a model its own average back, at the strongest
  // position in the prompt, is homogenisation by construction: it converges on the model's
  // default voice and gets worse the longer the app is used, which is exactly the shape of the
  // "output feels generic" complaint that survived every field-coverage fix.
  // A post the user REWROTE is different in kind — those words are genuinely theirs. Rank and
  // label the two separately, and only let the rewritten ones claim to outrank the description.
  const edited = ex.filter(e => e.edited), plain = ex.filter(e => !e.edited);
  const head = edited.length
    ? "THE BRAND'S OWN WORDS — the user took our draft and rewrote it into this. This is the single best evidence of how they actually write: it beats every description of the voice above, and it outranks the general writing rules. Study how these open, how long the sentences run, where they land."
    : "POSTS THIS BRAND APPROVED — the brand accepted these, so they are in-bounds for voice and subject. Treat them as a floor, not a target: they were written by this same system, so matching them too closely just repeats it. The brand description above is the stronger signal.";
  const tail = (edited.length && plain.length)
    ? "\nAlso approved, but not rewritten by the user — in-bounds, weaker evidence, do not imitate closely:"
    : '';
  const line = (e, i) => {
    const fmt = String(e.format == null ? '' : e.format).trim();
    const title = String(e.title == null ? '' : e.title).trim();
    const text = String(e.text).trim().replace(/\s+/g, ' ').slice(0, exampleCap(fmt));
    return `${i + 1}. ${fmt ? '[' + fmt + '] ' : ''}${title ? title + ' — ' : ''}${text}`;
  };
  const ordered = edited.concat(plain).slice(0, 4);
  return head + "\nThen write the next one so it BELONGS with these — match the voice and rhythm, never copy the wording.\n" +
    ordered.slice(0, edited.length || ordered.length).map(line).join('\n') +
    (tail ? tail + '\n' + ordered.slice(edited.length).map(line).join('\n') : '');
}

// COMPLETE brand profile — every field the user set in Settings, in one block.
// Every generation surface uses THIS so nothing the user teaches is ever dropped.
// opts.examples === false → omit the approved winners so the caller can place them at the END of
// a long prompt (see approvedWinnersBlock).
//
// NOTE ON CONTENT: everything in here is BRAND-SPECIFIC — this brand's facts, or an instruction
// about what to do with this brand's field. Generic voice prescriptions ("sound like a
// knowledgeable friend", "mix tones to keep the feed dynamic") must NEVER live in this block:
// they sit under a "BRAND VOICE" heading pretending to be the brand's own rule, and they actively
// contradict brands whose real voice is deadpan, technical or blunt.
function fullBrandBlock(bc, opts) {
  bc = bc || {};
  opts = opts || {};
  // ── WHAT THE TOTAL CAP GIVES UP FIRST ───────────────────────────────────────
  // Sections are collected with an explicit KEEP rank, not as a flat array, because the total cap
  // below used to be a blind `body.slice(0, TOTAL_CAP)` over a FIXED ORDER — so it discarded the
  // TAIL, and the tail is where the strongest signal lives. Measured on this renderer with nine
  // free-text fields at ~2,500 chars each (well inside what the app's own writers produce —
  // api/reviews.js alone emits 1,100-1,500), the loss order was: the taste signal, then ALL the
  // approved winners, then the example content, then the voice memory, then "topics to avoid",
  // then "words to avoid", then the brand vocabulary, then the customer reviews — while tagline,
  // website, origin story and visual style were never touched once. That is the exact inverse of
  // the value hierarchy this product sells.
  // Worse than dropping: the cut landed INSIDE a section. Measured, the prompt ended
  // "...THE BRAND'S OWN WORDS — the user took our draft and rewrote it into this. This is the
  // single best evidence of how they actually write: it beats every d" — a heading promising the
  // brand's own posts with ZERO posts beneath it.
  //
  // KEEP bands (higher survives longer). Whole sections are dropped, lowest rank first, so a
  // section can never be cut in half and a dangling heading is structurally impossible.
  //   96-100  identity + the brand's own words: name, held voice, approved winners
  //   93-95   hard rules the user typed by hand: voice memory, avoid-words, banned topics
  //   80-86   what the user explicitly taught: example content, vocabulary, taste signal, audience
  //   60-70   this brand's own facts and its customers' words: USPs, product, pain, reviews, CTA
  //   40-55   context: themes, calendar, category gripes, rivals, reputation, proof
  //   22-30   presentation detail the model writes well without: origin, channels, visuals, tagline, website
  // RENDER ORDER IS UNCHANGED — the winners still sit at the block's tail where every recency gate
  // measures them. Only the DROP order is ranked.
  const S = [];
  // Trim-and-drop is the ONLY way a value gets in. A whitespace-only textarea must never render a
  // bare "Customer pain points:" label — that teaches the model the brand has nothing to say there.
  // Every field here is CLIENT-SUPPLIED (getBrandContext posts the whole brand snapshot), and Grok's
  // context window is enormous — so an uncapped field is an unbounded bill. One crafted request could
  // cost more than a month of honest use. Cap per field AND on the total; both are far above any real
  // brand's content, so a legitimate user can never notice.
  const FIELD_CAP = 4000;
  const clean = v => {
    if (v == null) return '';
    const s = Array.isArray(v)
      ? v.filter(x => x != null && String(x).trim()).map(x => String(x).trim()).join(', ')
      : String(v).trim();
    return s.length > FIELD_CAP ? s.slice(0, FIELD_CAP) : s;
  };
  const add = (label, val, note, keep) => {
    const s = clean(val);
    if (!s) return;
    S.push({ keep: keep, text: label + ': ' + s + (note ? '\n   -> ' + note : '') });
  };
  const block = (label, val, note, keep) => { // multi-line fields read better starting on their own line
    const s = clean(val);
    if (!s) return;
    S.push({ keep: keep, text: label + ':\n' + s + (note ? '\n   -> ' + note : '') });
  };

  add('Brand', bc.brandName, '', 100);
  add('Tagline', bc.tagline, '', 24);
  add('Website', bc.website, '', 22);
  add('Target audience', bc.targetAudience, 'Write as if speaking directly to this person — their language, their situation, their pain.', 80);
  add('Voice / tones (NEVER contradict)', bc.tones, 'Hold this voice consistently in everything you write. It is this brand\'s voice, not a style to rotate through — never soften it toward a neutral, friendly explainer.', 99);
  block('What the brand is / key facts (use ONLY these — never invent products, prices, or ingredients)', bc.usps, '', 70);
  block('Product details (name the real product, never "our product")', bc.productDetails, '', 68);
  add('Content themes / communities', bc.communities, 'Every piece of content should connect to one of these.', 55);
  block('Weekly content calendar (each day has a LEAD theme)', dayMapText(bc), 'Use the day\'s theme as the LEAD angle, but do NOT make every post that day the same topic — roughly 60% on the lead theme and 40% from other days\' themes or evergreen brand angles, so one day still feels varied.', 54);
  add('Competitors', bc.competitors, '', 44);
  block('Recent competitor moves (what rivals just did — products, pricing, campaigns, posts)', bc.competitorMoves, 'Differentiate from, counter, or ride the same wave better than them.', 46);
  add('CTA style (how this brand asks for action)', bc.ctaStyle, '', 60);
  block('Origin story', bc.originStory, '', 30);
  block('Social proof (real numbers / press only — weave in for credibility)', bc.socialProof, '', 40);
  add('Active channels (where the brand shows up — tailor content to these)', bc.channels, '', 28);
  add('Visual style', bc.visualStyle, '', 26);
  block('Customer pain points (great for hooks — they stop the scroll)', bc.painPoints, '', 66);
  block('Market complaints — what people gripe about across this WHOLE category, not just this brand', bc.categoryGripes, 'Name the frustration, then show how this brand is different. It earns instant trust.', 50);
  block('Customer reviews — what real customers praise, complain about, and the exact phrases they use', bc.reviewInsights, 'Echo their real language, lead with the praise, answer the complaints head on.', 64);
  block('What the web says about this brand (reputation)', bc.webMentions, 'Amplify the real strengths, pre-empt the criticisms.', 42);
  add('Brand vocabulary — use these distinctive phrases/words naturally', bc.brandVocab, '', 84);
  add('Words & phrases to AVOID (never use)', bc.avoidWords, '', 94);
  add('Topics to AVOID', bc.bannedTopics, '', 93);
  block('Voice memory — durable brand rules learned from the user (obey ALL)', bc.coachNotes, '', 95);
  block('Example content the brand loved (MATCH this voice and rhythm — never copy verbatim)', bc.exampleContent, '', 86);
  if (opts.examples !== false) {
    const winners = approvedWinnersBlock(bc);
    if (winners) S.push({ keep: 96, text: winners });
  }
  // Raw taste signal — favor what was recently approved, avoid what was dismissed.
  const signals = clean(bc.learnedSignals);
  if (signals) S.push({ keep: 82, text: 'Recent taste signal (favor the approved, avoid the dismissed): ' + signals.slice(0, 500) });

  const TOTAL_CAP = 30000; // ~20 capped fields could still stack; bound the sum too.
  // Drop WHOLE sections, cheapest first, until the body fits. Never a mid-section slice: the old
  // blind slice left a heading claiming "the user took our draft and rewrote" with nothing under it.
  // Ties break toward dropping the LATER-rendered section, so the result is deterministic.
  const size = s => s.text.length + 1; // + the '\n' that joins it to the next section
  let total = S.reduce((n, s) => n + size(s), 0);
  if (total > TOTAL_CAP) {
    const cheapestFirst = S.map((s, i) => [s, i]).sort((a, b) => (a[0].keep - b[0].keep) || (b[1] - a[1]));
    let alive = S.length;
    for (const [s] of cheapestFirst) {
      if (total <= TOTAL_CAP || alive <= 1) break; // always render at least one section
      s.dropped = true; alive--; total -= size(s);
    }
  }
  let body = S.filter(s => !s.dropped).map(s => s.text).join('\n');
  // Belt and braces: only reachable if ONE section is itself larger than the whole cap (every field
  // is already capped at FIELD_CAP, and the winners block is capped by exampleCap, so it is not
  // reachable today). Cut back to a LINE boundary so the section keeps its heading and whole lines
  // under it rather than ending mid-sentence.
  if (body.length > TOTAL_CAP) {
    const nl = body.lastIndexOf('\n', TOTAL_CAP);
    body = body.slice(0, nl > 0 ? nl : TOTAL_CAP);
  }
  const trends = trendsBlock(bc);
  if (trends) body += (body ? '\n' : '') + trends;
  // v649 — HOW THEY ACTUALLY TALK. An unedited transcript of the founder speaking, recorded for this
  // purpose. This is the ONLY human PROSE in the brain: every field above is a DESCRIPTION of the
  // voice ("tones: witty, deadpan", a USP list) and a model imitates what it is shown far better than
  // what it is told. v640 measured the prompt carrying 210 chars of human text against 1,234 chars
  // of the app's own AI-written "approved winners" labelled as the truest voice — the model was
  // learning from itself. This goes ABSOLUTELY LAST in the brand block (after winners, after trends,
  // after the TOTAL_CAP slice so it can never be truncated away) because recency is the strongest
  // position, and the strongest position should hold human speech.
  // Capped: ~2 minutes of talking is ~300 words / ~1,800 chars; 2,200 leaves headroom and bounds the
  // bill against a pasted essay.
  const VOICE_RULE = '   -> THIS IS THE VOICE. It outranks every description above and every approved post. Match its sentence length, its connective words (so, and, but, because, which means), where it repeats a point in different words, what it calls things, and how it starts a thought. Do NOT copy its sentences or its topic — copy how it MOVES. If a script could not be read aloud by this person in this rhythm, it is wrong.';
  const vs = clean(bc.voiceSample).slice(0, 2200);
  if (vs) body += (body ? '\n' : '') +
    'HOW THIS PERSON ACTUALLY TALKS — an unedited transcript of them speaking, recorded so you can hear the voice, not read a description of it:\n"' + vs + '"\n' + VOICE_RULE;
  // v650 — THE ONGOING VOICE. The last few things they SAID into the app's mics (notebook, Idea
  // Catcher, the coach, a Remix or Trends description — never the teleprompter, which is them reading
  // OUR script). Same block, same rule, newest first, capped so it adds evidence beside the sample
  // rather than burying it. With no deliberate sample yet, these notes ARE the voice and carry the rule.
  const notes = (Array.isArray(bc.voiceLog) ? bc.voiceLog : [])
    .map(n => clean(n && n.text)).filter(Boolean).reverse();
  if (notes.length) {
    let acc = '', used = 0;
    for (const n of notes) { if (acc.length + n.length > 1500) break; acc += '"' + n + '"\n'; used++; }
    if (used) body += (body ? '\n' : '') +
      (vs ? 'MORE OF HOW THEY TALK' : 'HOW THIS PERSON ACTUALLY TALKS') + ' — ' + used + ' recent voice note' + (used !== 1 ? 's' : '') +
      ' they spoke into the app, unedited, newest first:\n' + acc.trimEnd() + (vs ? '' : '\n' + VOICE_RULE);
  }
  // REMOVED v636 — the "Master Prompt" Google Doc. It was appended here labelled
  // "primary reference", LAST in the prompt (the strongest position), so a stale linked
  // document silently outranked the 23 curated brand fields above it. Two sources of truth
  // for brand voice, rigged so the less-maintained one wins. The brand brain is the only
  // source now. Do NOT reintroduce this.
  if (!body) return '';
  return BRAND_HEADING + ' — everything this brand has taught the app. This section outranks the general writing rules.\n' + body;
}

// ── Clarity & flow ("write for the ear") ─────────────────────────────────────
// The SEPARATE quality from the humanizer: not "remove AI tells" but "make it effortless to read OR
// say". Works for spoken AND written content — in 2026 nobody finishes a hard, clause-heavy sentence on
// a phone. This is the SHARED CORE; generate-ideas appends it directly (it doesn't call writingCraft),
// so the core reaches every surface. Substantive on purpose — a one-line version doesn't change output.
function clarityFlow() {
  return `CLARITY & FLOW (write so it's effortless to read out loud OR skim on a phone — most readers quit on the first hard sentence):
- One idea per sentence. If a sentence carries two ideas, split it in two.
- Short sentences by default, then VARY the length — a long line followed by a short punch has rhythm; sentences all the same length drone.
- Plain words over clever ones. If a smart 12-year-old wouldn't say it, don't write it.
- Active voice, subject and verb up front — don't make the reader wait through three clauses to reach the point.
- Use contractions (you're, don't, it's, that's) — it's how people actually talk.
- Lead with the point, then support it. Never bury the payoff at the end.
- Cut every word that isn't working — read it back and delete anything you can lose without changing the meaning.
- Say each line in your head: if you'd stumble or run out of breath, rewrite it.`;
}

// ── Spoken-script shape ("write it to be said, not read") ────────────────────
// WHY THIS IS ITS OWN EXPORT: it used to live ONLY inside writingCraft's opts.spoken branch, and
// generate-ideas.js — the surface that writes every Quick Post / Ideas / Idea Catcher video script —
// does NOT call writingCraft. So the one rule in the codebase describing how a spoken script should
// FLOW never reached the generator that writes the scripts people actually film. Measured on the real
// assembled prompt: 0 flow rules present, 4 compression rules present (clarityFlow's "one idea per
// sentence" + "cut every word that isn't working", the video spec's "short sentences", and "never
// pad"). With cutting pressure and no counterweight the model strips every sentence to a noun phrase
// — "Sales follow-ups eating hours. Tools that don't talk." — which is unreadable into a camera.
//
// It is written MECHANICALLY on purpose. The old version was metaphor ("beats, not bullet points",
// "natural talk-track with real rhythm"); a model can satisfy a metaphor and still emit telegraph
// fragments. Grammar, connectives and a countable floor are checkable by the model against its own
// draft; vibes are not.
function spokenShape() {
  return `SPOKEN-SCRIPT SHAPE (mandatory for any script a person reads aloud to camera — video, micro-lecture, Q&A):
This is written to be SAID, not read. It is performed by a human looking down a lens, so it must survive being spoken at normal pace by someone who is not a presenter.
- Write COMPLETE SENTENCES with a subject and a verb. "Sales follow-ups eat hours" is speakable; "Sales follow-ups eating hours." is a caption fragment and nobody talks like that. Fragments are for the HOOK and the on-screen text only — in the body they read as a robot reciting a slide.
- Keep the CONNECTIVE TISSUE. Speech is carried by the small joining words written copy strips out: so, and, but, because, which means, that's why, the way it works is, here's what happens. Two facts side by side are notes; two facts joined by "because" is someone talking. If a line starts with a noun, check whether it needs a connector in front of it.
- The listener cannot re-read. Name a thing before you comment on it, and say the one line that matters twice in different words. That restatement is not padding — on a page it is redundant, out loud it is the only reason the point lands.
- Vary the length AND the construction like a person does: a couple of longer flowing lines, then a short one that lands. Do not start three sentences the same way, and never run a column of identical subject-verb-object lines ("You do this. You do that. It does the other."). A parade of same-shape sentences is a machine reciting a list, however grammatical each one is.
- Say the whole thing out loud in your head at speaking pace before you finish. Anywhere you'd stumble, run out of breath, or hear a list instead of a person — rewrite that line.
- LENGTH IS A FEATURE. Count the words in the finished script. If it is under the minimum for its format you did not write a tight script, you wrote notes — go back and restore the sentences and connectors you compressed out.
- OVERRIDES THE COMPRESSION RULES FOR SPOKEN SCRIPTS: "one idea per sentence", "cut every word that isn't working" and "short sentences" are written-copy rules. They must NEVER be applied to a spoken script to the point of fragments, dropped verbs or missing connectors. Between two drafts, prefer the one a real person could say out loud without sounding like they are reading bullet points.`;
}

// ── Worked example of spoken shape (a FLOOR, not a template) ─────────────────
// WHY IT IS CONDITIONAL: models copy demonstrations far more reliably than they follow
// instructions, which is the whole point AND the whole risk. A single worked example shown to every
// brand forever is structurally the same mistake as the hardcoded "Alex Hormozi style" removed in
// v640 — one mould pressed onto every voice. So this fires ONLY when the brand has no approved
// winner in a spoken format, i.e. exactly when approvedWinnersBlock() returns '' and the prompt
// would otherwise carry rules with no demonstration of shape at all (measured: a brand with no
// approved posts gets 0 chars of exemplar — that was AI WILLO's configuration when the fragment
// scripts appeared). The moment the user approves a script of their own, their post replaces this
// and the example never renders again for that brand.
//
// The example is deliberately bland in VOICE and set in a domain (a plumbing quote) unrelated to
// any real brand here, so what is copyable is the grammar and the flow, not a persona or a topic.
function spokenExample(bc) {
  bc = bc || {};
  const ex = Array.isArray(bc.approvedExamples) ? bc.approvedExamples : [];
  // A stub or one-liner is not a demonstration of flow, so require some real body text.
  const hasSpokenWinner = ex.some(e =>
    e && SPOKEN_EX_FORMATS.indexOf(String(e.format || '').trim().toLowerCase()) >= 0
      && String(e.text || '').trim().length > 80);
  if (hasSpokenWinner) return '';

  // THREE variants with deliberately DIFFERENT architectures (a lived situation, a hard number, a
  // correction), one picked at random per request. A single fixed example would teach one arc to
  // every brand that has no winners yet — the convergence risk that makes an example dangerous.
  // Rotating them means the constant being taught is the GRAMMAR (verbs, connectives, varied
  // construction), while the STRUCTURE stays a free choice, which is the distinction that keeps
  // brands sounding different. Each is set in a mundane domain unrelated to any real brand here.
  const VARIANTS = [
    { bad: `"Stop calling three plumbers. Photo of the leak in. Turned into a job spec. Someone checks it. Two quotes back. Prices hidden until you choose."`,
      good: `"You've had a leak and called three plumbers, and all three gave you a different number for the same job. So you're not really choosing a plumber, you're guessing which one is overcharging you the least. That's the bit that's broken. You send one photo, someone who knows the trade writes the actual job down, and the quotes that come back are all for the same piece of work."`,
      note: `this one happens to start in a situation the listener has lived through` },
    { bad: `"40% of stock never sells. Dead inventory. Cash locked up. Reorder anyway. Same mistake next season."`,
      good: `"About 40% of what a small shop orders never sells at full price, and most owners don't find that out until the season is over. So the money that should have gone into the things people actually wanted is sitting in a box in the stockroom. The fix isn't ordering less, it's ordering later, because the longer you leave it the more you actually know."`,
      note: `this one happens to start with a hard number` },
    { bad: `"Watering schedules kill plants. Not underwatering. Roots rot. Soil stays wet. Ignore the calendar."`,
      good: `"Most houseplants that die aren't thirsty, they're drowning, which is the opposite of what nearly everyone assumes. The problem is watering on a schedule, because a plant doesn't care what day of the week it is, it cares whether the soil has dried out. So the habit worth having isn't a calendar reminder, it's putting a finger in the pot before you reach for the watering can."`,
      note: `this one happens to start by correcting something the listener believes` },
  ];
  const V = VARIANTS[Math.floor(Math.random() * VARIANTS.length)];

  return `WORKED EXAMPLE — the same content written two ways. It is here only because this brand has not approved a spoken script yet, so there is no sample of its own to learn from.

TOO COMPRESSED (never write like this — noun phrases with full stops, no connectors, nothing a person could actually say):
${V.bad}

SPOKEN (write like this):
${V.good}

WHAT TO COPY — the GRAMMAR AND FLOW ONLY: every sentence has a subject and a verb; "and / so / because / which / that's" carry the thought from one line into the next; the sentences are different lengths and different shapes instead of a column of identical ones.
WHAT NOT TO COPY — THE STRUCTURE, THE TOPIC, THE VOICE. ${V.note}, but that is one way in among many and NOT a template: a script can just as well open on a blunt claim, a number, a question someone actually asked you, a thing you noticed this week, or a belief worth correcting. Do not reuse this example's opening move, its subject matter, or its plain register — it is written flat on purpose so that only its sentence mechanics are worth borrowing. The brand's own subject, the brand's own voice, this grammar.`;
}

// ── Shared WRITING CRAFT ─────────────────────────────────────────────────────
// The proven copy rules (hooks, AI-tell blacklist, human voice, clarity/flow, spoken/scan shape,
// self-check) that used to live only inside generate-ideas. Every copywriting surface (remix, blog,
// meme, viral, quick post…) should include this so they all write to the SAME bar. Improve it here →
// every generator improves.
// opts.hooks (default true) — include the hook rules (skip for blog/meme where there's no scroll hook).
// opts.spoken (default false) — the spoken/video script shape (video/reel/qna scripts).
// opts.scan  (default false) — the written scannability layer (blog / long written content).
// Rhythm/drama AI tells + the brand-wins precedence rule. Exported separately because
// generate-ideas.js and sharpen.js keep their own tuned prompts and do NOT call writingCraft.
function antiSlopRhythm() {
  return `RHYTHM & DRAMA TELLS (the ones that survive a word-level clean-up and still read as AI):
- No manufactured punchlines: a run of clipped fragments for drama ("It had no preference. No prior. No nostalgia."). One short sentence lands; three in a row is a bot doing gravitas.
- No aphorism formulas — invented wisdom that sounds profound and says nothing ("Symmetry is the language of trust", "Speed is a feature, not a promise"). State the actual claim instead.
- No fake-candid openers ("Honestly?", "Look,", "Here's the truth:", "Let me be real with you"). Start with the thing itself.
- No signposting the reader can see for themselves ("Let's dive in", "Here's what you need to know", "But here's the kicker"). Just say it.
- No significance inflation ("marking a turning point", "a defining moment for the industry"). Report what happened.
- No vague attribution ("experts say", "studies show", "people are realising") unless you can name the actual source. Otherwise cut the claim.
- No synonym cycling — if it's a customer, call it a customer every time. Rotating through "client / buyer / consumer" to avoid repetition is a tell.
- No sycophancy or hedging stacks ("great question", "could potentially possibly", "it may be worth considering").`;
}

// POINTS AT THE BRAND SECTION BY NAME, NOT BY POSITION. The old wording said "the BRAND section at
// the top of this prompt" — but in every generator that splits system/user messages the brand block
// is BELOW this text, in a later message, so the sentence pointed at nothing and the generic rules
// silently won. Naming the heading works wherever the block lands.
// Callers SHOULD also place this LAST (writingCraft appends it; pass precedence:false and append
// it yourself when more text follows writingCraft) — but the text must not CLAIM to be last,
// because in generate-ideas.js it is not: the brand block, the approved winners and the whole
// ~3800-char JSON schema follow it (measured at 83.3% of that prompt). "Read this last" was
// therefore false in the one generator that carries the most weight, and a model that checks the
// claim against what it can see has no reason to trust the rest of the sentence. The rule is
// stated positionally-neutrally instead, so it is true wherever it lands.
function rulePrecedence() {
  return `RULE PRECEDENCE (this outranks every writing rule in this conversation, wherever it appears — including any rule stated after it): the section headed "${BRAND_HEADING}" wins any conflict with the general writing rules, wherever that section appears (it may be in an earlier message, not above this line). Those rules exist to strip generic AI slop, NOT to overwrite a voice this brand has actually earned. Where the brand's voice memory, its approved winners, or its stated style contradict a general rule — it genuinely writes in threes, uses a dash, opens a certain way, repeats a signature phrase — follow the ${BRAND_HEADING} and ignore the rule. Apply a general rule only where the brand profile says nothing.`;
}

function writingCraft(opts) {
  opts = opts || {};
  const P = [];
  if (opts.hooks !== false) {
    P.push(`HOOK (the first line decides if anyone sees the rest — it matters MORE than the body):
- Max ~8 words. Shorter wins. Fragments beat full sentences. The first word creates tension, curiosity, or a pattern interrupt.
- It must work as SILENT on-screen text (read before any audio).
- Vary the pattern — never reuse one formula: contrarian ("Everything you know about X is wrong"), before/after ("I stopped X. Here's what happened"), specificity ("3 parts. One price. Zero fluff"), challenge ("Your doctor won't tell you this"), confession ("I was wrong about X for years"), problem-callout ("If your X has more Y than Z, we need to talk"), result ("30 days of X. Never going back"), tribal ("This separates serious X from the rest").
- Test: would a real person actually STOP SCROLLING for this? If not, rewrite it.`);
  }
  P.push(`NEVER open with these AI tells (they instantly read as bot copy): "Did you know", "In this video", "Hey guys", "Today we're going to", "Let me tell you", "Have you ever wondered", "Welcome back", "Here's the thing", "Here's the wild part", "Let's dive in", "I'm excited to share", "This is a game-changer", "Revolutionary", "Quick question", "Most people don't realize", "Imagine a world", "In today's fast-paced world".`);
  P.push(`WORD-LEVEL HUMANIZER (mandatory — these are the tells that scream "AI wrote this"):
- No em dashes (—). Use commas, periods, or parentheses.
- Never use "not just X, it's Y" / "not only X, but Y".
- No rule-of-three lists to sound thorough — use two items or four, never three.
- Don't tack -ing phrases on for fake depth (highlighting, showcasing, ensuring, fostering, underscoring).
- Never use these words: delve, enhance, foster, garner, showcase, vibrant, tapestry, testament, pivotal, crucial, landscape (abstract), interplay, intricate, leverage, elevate, cornerstone, multifaceted, nuanced, paradigm, robust, seamless, synergy, holistic.
- No "serves as" / "stands as" / "represents" — just say "is". No false ranges ("from X to Y, from A to B").
- No "In today's..." / "In the world of..." openers. No filler ("It's important to note", "At the end of the day", "When it comes to"). No generic closers ("The future looks bright").
- Vary sentence length (monotone rhythm is an AI tell); straight quotes not curly; a number beats an adjective.`);
  P.push(antiSlopRhythm());
  P.push(`VOICE: write like a specific person telling a friend something urgent at a bar — not a presenter opening a webinar. Concrete over abstract, short sentences, no corporate filler, no hype adjectives, no emoji unless the brand itself uses them. A dry brand stays dry — dry AND compelling.`);
  P.push(clarityFlow());
  if (opts.spoken) {
    // Delegates to the shared spokenShape() so writingCraft callers (viral-rewrite) and the
    // direct callers (generate-ideas, which never calls writingCraft) can never drift apart.
    P.push(`ARC: open COLD on a relatable moment or tension (no intro, no "hey"), turn on ONE specific insight or story beat, then land a payoff or takeaway the viewer feels.\n\n${spokenShape()}`);
  }
  if (opts.scan) {
    P.push(`MAKE IT SCANNABLE (written): short paragraphs — 1 to 3 sentences each, never a wall of text. Use white space. Front-load the answer in the first line of each section. If it runs long, break it with plain, specific subheads (not clever ones). Someone skimming only the first line of each paragraph should still get the gist.`);
  }
  P.push(`SELF-CHECK before you finish (silently; output only the final result): is it unmistakably THIS brand's voice, built on the brand's REAL specifics (pain points, facts, vocabulary) not generic filler, about the READER's situation rather than a product pitch, and would it genuinely stop the scroll? Rewrite anything that reads generic, salesy, off-voice, or interchangeable with a random competitor.`);
  if (opts.format) { const fs = formatSpec(opts.format); if (fs) P.push('SHAPE & TARGET LENGTH (do not over- or under-write): ' + fs); }
  // PRECEDENCE — must end up LAST in the whole prompt. Everything above is a universal anti-slop
  // FLOOR: it strips the patterns nobody should write. The brand block (voice memory, approved
  // winners, learned edits) is this brand's IDENTITY and it is what the app exists to learn.
  // Without this line the generic rules sit closest to the task and silently override the brain —
  // so a brand whose real voice uses a three-beat rhythm or an em dash gets flattened back to
  // neutral by its own guardrails.
  // opts.precedence === false → the caller has more text after writingCraft (a user message, a JSON
  // schema) and appends rulePrecedence() itself at the very end, so "read this last" stays true.
  if (opts.precedence !== false) P.push(rulePrecedence());
  return P.join('\n\n');
}

// Per-format length + shape spec, so nothing over- or under-writes. Shared by every generator.
const FORMAT_SPEC = {
  video: 'Vertical reel/TikTok, ~30-60s. script = 90-150 SPOKEN words in full, varied-length sentences (90 is a floor). shots = 4-8 concrete phone shots. screen = 3-6 short overlays.',
  micro: '10-15s single-fact video. script = 30-60 spoken words: one surprising fact + why it matters.',
  qna: 'A real audience question + filmed answer under 30s. script = the answer; first sentence answers directly (no wind-up), MAX ~60 words.',
  statement: 'Bold text graphic. boldText = the full statement (2-5 short sentences, setup + payoff, stands alone). script = 2-3 delivery-tip lines only.',
  carousel: 'Instagram carousel. boldText = numbered slide texts; slide 1 forces the swipe. caption = the post caption.',
  static: 'Single image post. caption = 1-3 sentences in brand voice — this IS the writing.',
  blog: 'Answer-first article: the first 1-2 sentences answer the question directly, THEN supporting depth. Natural headers, real specifics, no fluff intro.',
  // "One DEADPAN line" prescribed a register to every brand, including the warm and the playful
  // ones — the same class of default persona as the hardcoded "Alex Hormozi style" removed in v640,
  // and it sat in SHAPE & TARGET LENGTH, the position closest to the task, where it outranked the
  // brand's own stated tone. The SHAPE (one line, point first, no setup) is the real spec; the
  // voice belongs to the brand.
  meme: 'One line baked into the image — plain-language point first, no setup, no explanation. Deliver it in the brand\'s own voice from the BRAND PROFILE; do not default to deadpan or any other register the brand has not asked for.',
};
function formatSpec(fmt) { return FORMAT_SPEC[fmt] || ''; }

// ── Post-generation guardrail ────────────────────────────────────────────────
// Detect HARD brand-rule violations in generated text — an avoid-word used, or a banned topic mentioned.
// Word-boundary matched (so "ai" won't match "email"). Returns [] when clean. Cheap + deterministic;
// a generator can regenerate once when this is non-empty. Never throws.
function outputViolations(text, bc) {
  bc = bc || {};
  const t = ' ' + String(text || '').toLowerCase().replace(/\s+/g, ' ') + ' ';
  const hits = [];
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A FULL STOP IS A SEPARATOR TOO. People write these lists as sentences, not as comma-separated
  // tokens. `Don't say "game changer". Don't say "hack".` used to split into ONE entry, which
  // matched nothing — so a brand that typed its hardest rule in the most natural way got no
  // enforcement at all, silently.
  // AND PREFER WHAT THEY PUT IN QUOTES. Split or not, `don't say "game changer"` is still a clause,
  // and a whole clause never appears in a draft. Where the user quoted the actual words, those
  // words ARE the rule: use them and drop the sentence around them. The opening quote must follow
  // a space or start the entry and the closing one must end it or be followed by punctuation, so
  // the apostrophe in "don't" can never be read as a quote mark.
  const listFrom = v => {
    const QUOTED = /(?:^|\s)["“‘']([^"“”‘']{3,60})["”’'](?=$|[\s.,;:!?])/g;
    const out = [];
    for (const part of String(v == null ? '' : v).split(/[\n,;|.]+/)) {
      const s = part.trim().toLowerCase();
      if (s.length < 3) continue;
      const quoted = [];
      let m;
      while ((m = QUOTED.exec(s))) { const w = m[1].trim(); if (w.length >= 3) quoted.push(w); }
      QUOTED.lastIndex = 0;
      if (quoted.length) out.push.apply(out, quoted); else out.push(s);
    }
    return out.slice(0, 60);
  };
  const scan = (v, type) => {
    for (const w of listFrom(v)) {
      try { if (new RegExp('\\b' + esc(w) + '\\b', 'i').test(t)) hits.push({ type, hit: w }); } catch (e) {}
    }
  };
  scan(bc.avoidWords, 'avoid-word');
  scan(bc.bannedTopics, 'banned-topic');
  return hits;
}

// Robust JSON extraction — handles models (esp. Claude) that wrap JSON in prose
// or code fences. Tries a direct parse, then slices the first {...} / [...] block.
function extractJson(text) {
  if (!text) return null;
  let s = String(text).replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(s); } catch (e) {}
  const firstObj = s.indexOf('{'), firstArr = s.indexOf('[');
  let start = -1, closeCh = '}';
  if (firstObj >= 0 && (firstArr < 0 || firstObj < firstArr)) { start = firstObj; closeCh = '}'; }
  else if (firstArr >= 0) { start = firstArr; closeCh = ']'; }
  if (start < 0) return null;
  const end = s.lastIndexOf(closeCh);
  if (end > start) {
    const cand = s.slice(start, end + 1);
    try { return JSON.parse(cand); } catch (e) {}
    // Salvage: some models emit an OBJECT using array brackets, e.g.
    // ["day": "Saturday", "format": "video", ...]. Detect object-entries wrapped
    // in [] (a quoted key immediately followed by a colon) and re-parse as an
    // object. This never fires for real arrays like ["a","b"] or [{...}].
    if (cand[0] === '[' && /^\[\s*"[^"]*"\s*:/.test(cand)) {
      try {
        const obj = JSON.parse('{' + cand.slice(1, -1) + '}');
        if (obj && typeof obj === 'object') return obj;
      } catch (e) {}
    }
  }
  return null;
}

module.exports = { antiSlopRhythm, rulePrecedence, dayMapText, trendsBlock, painBlock, vocabBlock, avoidBlock, brainExtras, fullBrandBlock, approvedWinnersBlock, BRAND_HEADING, clarityFlow, spokenShape, spokenExample, writingCraft, formatSpec, outputViolations, extractJson };
