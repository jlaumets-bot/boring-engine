#!/usr/bin/env node
// GATE: the teleprompter must follow the person's voice to the place they are
//       actually reading, must keep working when the script is not plain English,
//       must not let a finished take steer the next one, must bold only whole
//       words, and must never contain the one regex feature that takes the whole
//       app down on an older iPhone. (v660's five prompter fixes.)
//
// WHY THIS EXISTS
//   Someone props their phone up, taps Film, and starts reading. From that moment
//   the screen is the only thing they can look at, and they cannot stop to work
//   out why it is behaving oddly — they are on camera. Five different ways of
//   ruining that shipped before v660:
//
//     1. Their script said "Your brand needs a system" near the top and again at
//        the bottom, the way every callback and every rule-of-three does. The
//        matcher only ever looked FORWARD from where it thought they were, so the
//        words they had just said could not score at the line they were on — but
//        scored perfectly at the repeat further down. The script leapt a paragraph
//        ahead, mid-sentence, at the same spot on every single take.
//     2. Their script had a hyphen in it. "co-founder" was filed in the script
//        index as one word and heard from the microphone as two, so it never
//        matched; "10,000" the same. Worse, anything with an accent — an Estonian,
//        Finnish, German or French script — had its accented letters DELETED from
//        the index, so "hädavajalik" was filed as "hdavajalik" and matched
//        nothing. On those scripts the prompter simply stopped moving while they
//        talked, and they had no idea why.
//     3. They checked their pace in preview, then hit record. The preview's
//        recogniser was stopped, not aborted, so it delivered one last result
//        AFTER the take began — into handlers that read live module state. The new
//        take opened a paragraph down the script, and a late error from the dead
//        session killed voice-follow on the live one without a word. The same
//        phantom result was written into the timeline the split-screen renderer
//        uses to cue graphics, so the graphics landed on the wrong sentence too.
//     4. They opened the app on an iPhone 7. One prompter regex used a lookbehind.
//        A regex LITERAL is parsed when the script is parsed, so on any Safari
//        below 16.4 the entire inline <script> was a SyntaxError: no ideas, no
//        sign-in, a blank white shell. Not a broken teleprompter — a broken
//        product, for a reading nicety nobody asked for.
//     5. The model marked "AI" as a word to lean on, and the prompter rendered
//        "We s(AI)d it ag(AI)n and it will f(AI)l" in bold. The one reading aid on
//        the screen was underlining random letter-pairs, which makes every OTHER
//        bold word on the page untrustworthy at the exact moment they cannot stop.
//
// HOW IT CHECKS
//   Nearly all of this is pure functions, so nearly all of it is BEHAVIOURAL —
//   the real source of tpNormWord, tpNormWords, tpWordNear, TP_CONTENT_WORD,
//   TP_STOPWORDS, TP_LEAP_MARGIN, tpVoiceMatch, tpOutsideTags, tpStressRx,
//   tpEscape and tpEmphasise is lifted out of app.html, compiled with new
//   Function, and run against real scripts and real transcripts. The word index
//   is rebuilt exactly the way tpBuildVoiceIndex builds it (split on whitespace,
//   normalise each token), so the fixtures below are what the person on camera
//   would actually get.
//
//     * the repeated-line fixtures ("Your brand needs a system ... Your brand
//       needs a system that films itself", "Stop guessing what to post ... Stop
//       guessing what works") must land on the NEAR copy;
//     * twenty distinct words with the speaker genuinely jumping to word 18 must
//       still jump — this arm exists so nobody "fixes" the leap by forbidding all
//       forward movement, which would strand every person who ad-libs;
//     * hyphens, comma-separated figures and Estonian diacritics must normalise
//       identically on both sides, and a whole Estonian sentence must follow;
//     * the emphasis marks must bold "Never" and "$24" but not the "ai" inside
//       "said", and must leave the interior of class="tp-em" alone.
//
//   STRUCTURAL where honest execution is impossible:
//     * stopTpVoiceFollow is lifecycle code over a live SpeechRecognition object.
//       Its body is sliced out by brace matching and the assertions are made
//       INSIDE that slice — no bare search over the file, which would pass on a
//       word appearing in a comment two thousand lines away.
//     * the lookbehind arm is a SOURCE arm over the whole of app.html, because
//       the defect is not located in any one function: one lookbehind anywhere in
//       this file sets the browser floor for the entire product. Comments are
//       removed first (the v660 note quotes the old pattern on purpose), and the
//       scanner proves itself on this very file before it is trusted.
//
// RUN:    node scripts/verify/prompter-follow.mjs
// EXPECT: prints "PASS" and exits 0.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = process.argv[2] ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../app.html');
const src = fs.readFileSync(APP, 'utf8');

const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };

/* ── lifting source out of app.html ──────────────────────────────────────────
   Deliberately NOT a brace matcher for the pure functions: tpNormWord and
   tpNormWords contain /[^a-z0-9']/g, and a matcher that treats that apostrophe
   as the start of a string literal runs straight past the closing brace. Every
   one of these is a top-level declaration whose closing brace is in column 0, so
   anchor on that instead — the same reasoning as scripts/verify/xss-escaping.mjs. */
function fnText(name) {
  const re = new RegExp('(?:^|\\n)(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) throw new Error('function ' + name + '() is not in app.html');
  const at = m.index + (src[m.index] === '\n' ? 1 : 0);
  const eol = src.indexOf('\n', at);
  const first = src.slice(at, eol < 0 ? src.length : eol);
  let text;
  if (first.includes('{') &&
      (first.match(/{/g) || []).length === (first.match(/}/g) || []).length) {
    text = first;                                  // single-line declaration
  } else {
    const end = src.indexOf('\n}', at);
    if (end < 0) throw new Error('no column-0 closing brace for ' + name + '()');
    text = src.slice(at, end + 2);
  }
  const decls = (text.match(/\bfunction\s+[A-Za-z_$][\w$]*\s*\(/g) || []).length;
  if (decls !== 1) throw new Error('lifting ' + name + '() captured ' + decls + ' declarations');
  return text;
}

// A whole `const NAME = ...;` line.
function constText(name) {
  const re = new RegExp('(?:^|\\n)const\\s+' + name + '\\s*=.*');
  const m = re.exec(src);
  if (!m) throw new Error('const ' + name + ' is not in app.html');
  return m[0].trim();
}

/* Brace matcher for the ONE structural slice below (stopTpVoiceFollow), which
   holds no regex literal. Steps over strings and comments so a brace in prose
   cannot close the function early. */
function matchBrace(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '/' && s[i + 1] === '/') { i = s.indexOf('\n', i); if (i < 0) return -1; continue; }
    if (c === '/' && s[i + 1] === '*') { i = s.indexOf('*/', i); if (i < 0) return -1; i++; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      for (i++; i < s.length; i++) { if (s[i] === '\\') { i++; continue; } if (s[i] === q) break; }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// Strip // and /* */ while keeping string literals, so an assertion about code
// cannot be satisfied by a sentence in a comment.
function decomment(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '/' && s[i + 1] === '/') { const n = s.indexOf('\n', i); if (n < 0) break; i = n - 1; continue; }
    if (c === '/' && s[i + 1] === '*') { const n = s.indexOf('*/', i); if (n < 0) break; i = n + 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c;
      for (i++; i < s.length; i++) { out += s[i]; if (s[i] === '\\') { i++; out += s[i]; continue; } if (s[i] === q) break; }
      continue;
    }
    out += c;
  }
  return out;
}

/* ── compile the real prompter functions ─────────────────────────────────── */
let M;
try {
  const bundle = [
    constText('TP_STRESS_A'),
    constText('TP_STRESS_B'),
    constText('TP_LEAP_MARGIN'),
    constText('TP_STOPWORDS'),
    fnText('tpOutsideTags'),
    fnText('tpNormWord'),
    fnText('tpNormWords'),
    fnText('tpStressRx'),
    fnText('tpEscape'),
    fnText('tpEmphasise'),
    fnText('tpWordNear'),
    fnText('TP_CONTENT_WORD'),
    fnText('tpVoiceMatch')
  ].join('\n');

  // tpVoiceMatch reads three module-level values. Declaring them here puts the
  // real function in the real shape of its scope.
  M = new Function(`
    let tpVoiceWords = [], tpVoiceCursor = 0, tpVoiceLastAdvanceDone = false;
    ${bundle}
    // Rebuild the index the way tpBuildVoiceIndex does: the script is split into
    // whitespace-separated tokens, each token becomes one .tp-w span, and the key
    // is tpNormWord of that span's text.
    function follow(script, cursor, heard, advanced) {
      tpVoiceWords = String(script).split(/\\s+/).filter(Boolean)
        .map(t => ({ key: tpNormWord(t) })).filter(w => w.key);
      tpVoiceCursor = cursor;
      tpVoiceLastAdvanceDone = !!advanced;
      return tpVoiceMatch(heard);
    }
    return { tpNormWord, tpNormWords, tpWordNear, TP_CONTENT_WORD, TP_STOPWORDS,
             TP_LEAP_MARGIN, tpOutsideTags, tpStressRx, tpEscape, tpEmphasise, follow };
  `)();
} catch (e) {
  console.error('PROMPTER FOLLOW GATE FAILED: the prompter functions could not be lifted out of ' +
                'app.html, so nothing about voice-follow, non-English scripts or emphasis can be ' +
                'checked at all — ' + e.message);
  process.exit(2);
}

/* ══ ITEM 1 — a repeated line must not throw the reader a paragraph ahead ════
   BEHAVIOURAL. Real tpVoiceMatch, real script index, real transcript. */
{
  const SCRIPT_A = 'Your brand needs a system Not another tool Your brand needs a system that films itself';
  const a = M.follow(SCRIPT_A, 2, 'your brand needs a system', true);
  ok(a === 5,
     'ITEM1: the prompter jumps to the LATER copy of a repeated line. The script "' + SCRIPT_A +
     '" with the reader on word 2 and "your brand needs a system" heard lands on word ' + a +
     ' instead of 5 — eleven words down the page, mid-sentence, while they are still reading ' +
     'line one. Every callback and every repeated product name does this, at the same spot, on ' +
     'every take.');

  const SCRIPT_B = 'Stop guessing what to post Stop guessing what works Just film it';
  const b = M.follow(SCRIPT_B, 2, 'stop guessing what to post', true);
  ok(b === 5,
     'ITEM1: where the reader actually is scores nothing because the words there are filler. "' +
     SCRIPT_B + '" with the reader on word 2 and "stop guessing what to post" heard lands on word ' +
     b + ' instead of 5 — the repeat further down wins on "stop" and "guessing" and skips them ' +
     'past a whole sentence. The last word they said is the best evidence of where they are and ' +
     'it is being ignored.');

  // A GENUINE skip must still work. This arm is here so nobody "fixes" the leap by
  // refusing all forward movement — that strands everyone who ad-libs or restarts.
  const NATO = ('alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima mike ' +
                'november oscar papa quebec romeo sierra tango');
  const skip = M.follow(NATO, 0, 'romeo sierra tango', false);
  ok(skip === 20,
     'ITEM1: the prompter no longer follows a reader who genuinely skips ahead. Twenty distinct ' +
     'words, the speaker is plainly on the last three, and the script stays at word ' + skip +
     ' instead of 20 — it sits frozen at the top while they talk, which is the failure the leap ' +
     'margin was supposed to be small enough to avoid.');

  const near = M.follow(NATO, 0, 'alpha bravo charlie', false);
  ok(near === 3,
     'ITEM1: reading the script from the beginning does not move the prompter — it reports word ' +
     near + ' instead of 3, so the first line never scrolls away and the reader is stuck staring ' +
     'at words they have already said.');

  // The other half of the same rule: a candidate a long way off has to clear a
  // HIGHER bar of its own, and it may not borrow the lower bar a near candidate
  // would have had. Two loose matches twenty-one words down is not evidence that
  // the speaker has moved there; it is evidence that the script repeats a word.
  const loose = M.follow(NATO + ' purple tractor', 0, 'purple tractor and', false);
  ok(loose === -1,
     'ITEM1: two stray matches twenty-one words further down the script are enough to move the ' +
     'prompter \u2014 it reports word ' + loose + ' instead of staying put. A far jump has to be ' +
     'earned by three content words, or any script that reuses a couple of words throws the ' +
     'reader down the page on a coincidence.');

  ok(M.TP_LEAP_MARGIN >= 1,
     'ITEM1: TP_LEAP_MARGIN is ' + M.TP_LEAP_MARGIN + '. With no margin a farther match needs no ' +
     'extra evidence at all to overrule the place the speaker appears to be reading, which is ' +
     'exactly the leap onto a repeated line that v660 fixed.');
}

/* ══ ITEM 2 — ONE normaliser, and it keeps accented letters ══════════════════
   BEHAVIOURAL. The bug was that the two sides disagreed, so every assertion here
   compares the two sides against each other, not against a hard-coded string. */
{
  for (const [raw, want] of [['co-founder', 'cofounder'], ['10,000', '10000'],
                             ['well-known', 'wellknown']]) {
    const one = M.tpNormWord(raw);
    const many = M.tpNormWords(raw);
    ok(one === want,
       'ITEM2: the script index files "' + raw + '" as "' + one + '". A separator inside a word ' +
       'has to be joined, not stripped differently on each side, or the prompter freezes every ' +
       'time the script says it.');
    ok(many.length === 1 && many[0] === want,
       'ITEM2: the microphone side splits "' + raw + '" into ' + JSON.stringify(many) + ' while ' +
       'the script side files it as one word "' + one + '". They can never match, so the prompter ' +
       'stops dead on any script with a hyphen or a figure like 10,000 — which is most scripts.');
    ok(many[0] === one,
       'ITEM2: "' + raw + '" normalises to "' + one + '" from the script and "' + many[0] +
       '" from the microphone. Two normalisers means the prompter can never follow this word.');
  }

  for (const [raw, want] of [['hädavajalik', 'hadavajalik'], ['jäta', 'jata'],
                             ['Ära', 'ara'], ['résumé', 'resume']]) {
    ok(M.tpNormWord(raw) === want,
       'ITEM2: "' + raw + '" is filed as "' + M.tpNormWord(raw) + '" instead of "' + want +
       '" — the accented letters are being deleted rather than folded, so every Estonian, ' +
       'Finnish, German and French script matches only on its accent-free words and the ' +
       'prompter appears to be broken to anyone not writing in English.');
    ok(M.tpNormWords(raw)[0] === want,
       'ITEM2: the microphone side turns "' + raw + '" into "' + M.tpNormWords(raw)[0] +
       '" while the script side expects "' + want + '" — voice-follow cannot work on this script.');
  }

  const EE = 'Ära kunagi jäta seda tegemata. See on hädavajalik igale asutajale.';
  const ee = M.follow(EE, 0, 'ära kunagi jäta seda tegemata see on hädavajalik', false);
  ok(ee === 8,
     'ITEM2: an Estonian script does not follow the speaker’s voice. "' + EE + '" with ' +
     '"ära kunagi jäta seda tegemata see on hädavajalik" heard reports word ' + ee +
     ' instead of 8 — the script sits still while they read it aloud.');

  const HY = 'We hired a co-founder to build 10,000 well-known systems';
  const hy = M.follow(HY, 0, 'we hired a co-founder', false);
  ok(hy === 4,
     'ITEM2: a hyphenated word stops the prompter. "' + HY + '" with "we hired a co-founder" ' +
     'heard reports word ' + hy + ' instead of 4, so the script freezes on the first compound ' +
     'word or product name in it.');

  // The whole point of item 2 is ONE normaliser. Structural, because these call
  // sites are not worth compiling on their own — but scoped to each function.
  for (const [fn, why] of [
    ['tpBuildVoiceIndex', 'the script index'],
    ['tpCueWordIndex', 'the cue lookup that places graphics on the right sentence']
  ]) {
    const f = decomment(fnText(fn));
    ok(/tpNormWords?\s*\(/.test(f),
       'ITEM2: ' + fn + ' has its own word splitter again instead of using tpNormWord/tpNormWords. ' +
       'The two sides drift apart exactly as they did before v660, and ' + why + ' silently stops ' +
       'matching hyphenated and accented words.');
  }
}

/* ══ ITEM 3 — stopping a recogniser must stop ALL of it ═════════════════════
   STRUCTURAL: this is lifecycle code over a live SpeechRecognition object. The
   body is sliced out by brace matching and every assertion is made inside that
   slice, so a mention of onresult elsewhere in a 1.4MB file proves nothing. */
{
  const at = src.search(/(?:^|\n)function\s+stopTpVoiceFollow\s*\(/);
  ok(at >= 0, 'ITEM3: stopTpVoiceFollow() is not in app.html at all — nothing tears a finished ' +
              'recogniser down, so every take carries the previous session’s listener.');
  if (at >= 0) {
    const brace = src.indexOf('{', src.indexOf(')', at));
    const end = matchBrace(src, brace);
    ok(end > 0, 'ITEM3: stopTpVoiceFollow’s body could not be read, so its teardown cannot be checked.');
    const body = end > 0 ? decomment(src.slice(brace, end + 1)) : '';

    for (const [h, consequence] of [
      ['onresult',
       'a trailing result from the session just stopped arrives after the next take has begun and ' +
       'scroll-targets it from whatever the person said while checking their pace — the take ' +
       'opens a paragraph down the script — and writes a phantom entry into the timeline the ' +
       'split-screen renderer uses, so the graphics land on the wrong sentence too'],
      ['onerror',
       'a late error from the dead session calls the fallback, which stops the NEW recogniser: ' +
       'voice-follow dies silently for the whole take and the script just scrolls on a timer'],
      ['onend',
       'the dead session restarts itself, so two recognisers listen at once and fight over where ' +
       'the reader is'],
      ['onstart',
       'the dead session announces itself as live after the new one has begun, and the prompter ' +
       'shows the listening state of a recogniser that is no longer listening to anything']
    ]) {
      ok(new RegExp('\\.' + h + '\\s*=\\s*null').test(body),
         'ITEM3: stopTpVoiceFollow does not clear ' + h + ' on the recogniser it is shutting down, so ' +
         consequence + '.');
    }

    ok(/\babort\s*\(/.test(body),
       'ITEM3: stopTpVoiceFollow never calls abort(). stop() finalises and DELIVERS what the ' +
       'recogniser heard, and nothing wants that trailing result — it lands on the next take.');
    const ai = body.indexOf('abort'), si = body.indexOf('.stop(');
    ok(si === -1 || (ai !== -1 && ai < si),
       'ITEM3: stopTpVoiceFollow reaches for stop() before abort(). stop() hands over one last ' +
       'result after the take has started, which is the whole defect abort() was chosen to avoid.');
    ok(/tpVoiceRec\s*=\s*null/.test(body),
       'ITEM3: stopTpVoiceFollow leaves the finished recogniser referenced, so a later stop or the ' +
       'watchdog can act on a session that is already gone.');
  }
}

/* ══ ITEM 4 — NO LOOKBEHIND ANYWHERE IN app.html ════════════════════════════
   SOURCE arm over the whole file. The defect is not in one function: a regex
   LITERAL with a lookbehind is parsed when the script is parsed, so on Safari
   below 16.4 the entire inline <script> is a SyntaxError and the whole app is a
   blank shell. A new lookbehind anywhere in this file re-sets the browser floor
   for the entire product, so the scan has to be the whole file, not three
   known sites. */
function lookbehinds(text) {
  // Mask comments without trying to tokenise 1.4MB of mixed HTML/CSS/JS: block
  // comments and HTML comments by range, line comments per line (and never on a
  // "://" which is a URL, not a comment).
  const masked = [];
  for (const [open, close] of [['/*', '*/'], ['<!--', '-->']]) {
    let i = 0;
    while ((i = text.indexOf(open, i)) !== -1) {
      const j = text.indexOf(close, i + open.length);
      if (j === -1) { masked.push([i, text.length]); break; }
      masked.push([i, j + close.length]);
      i = j + close.length;
    }
  }
  const inMask = i => masked.some(([a, b]) => i >= a && i < b);
  const hits = [];
  const rx = /\(\?<[=!]/g;
  let m;
  while ((m = rx.exec(text)) !== null) {
    const i = m.index;
    if (inMask(i)) continue;
    const ls = text.lastIndexOf('\n', i) + 1;
    const before = text.slice(ls, i);
    if (/(^|[^:])\/\//.test(before)) continue;          // after a // on this line
    hits.push({
      line: text.slice(0, i).split('\n').length,
      text: text.slice(ls, text.indexOf('\n', i) < 0 ? undefined : text.indexOf('\n', i)).trim().slice(0, 110)
    });
  }
  return hits;
}
{
  const found = lookbehinds(src);

  // Prove the scanner is alive against THIS file before trusting a clean result:
  // a lookbehind spliced into live code must be seen.
  const probe = lookbehinds(src + '\nvar _tpLookbehindProbe = /(?<=x)y/;\n');
  ok(probe.length === found.length + 1,
     'ITEM4: this gate’s own lookbehind scanner does not see a lookbehind added to live code in ' +
     'app.html, so its clean result means nothing and the browser floor for the whole app is ' +
     'unguarded. Fix the scanner before trusting this gate.');

  ok(found.length === 0,
     'ITEM4: app.html contains a live regex lookbehind at ' +
     found.map(h => 'line ' + h.line + ' (' + h.text + ')').join(', ') +
     '. This does NOT just break the teleprompter: a lookbehind in a regex literal is a parse ' +
     'error, so on every iPhone below Safari 16.4 the whole inline <script> fails to parse and ' +
     'the entire app is a blank white shell — no ideas, no sign-in, nothing. Walk the tag ' +
     'structure with tpOutsideTags instead.');

  // The number heuristic must stay a built regex, not a literal: a literal is the
  // form that kills the parse rather than merely throwing at call time.
  const emph = decomment(fnText('tpEmphasise'));
  ok(/new RegExp\(/.test(emph),
     'ITEM4: tpEmphasise builds its regexes as literals again. A literal is parsed when the page ' +
     'is parsed, so the next unsupported regex feature added here takes the entire app down on ' +
     'older phones instead of just failing in the prompter.');
  ok(/tpOutsideTags\(/.test(emph),
     'ITEM4: tpEmphasise no longer routes its replacements through tpOutsideTags, so it is back to ' +
     'needing a lookbehind to avoid rewriting the insides of HTML tags — or it is rewriting ' +
     'them, and the script markup is corrupt.');

  // BEHAVIOURAL: tpOutsideTags does the job the lookbehind used to do.
  const held = M.tpOutsideTags('<a href="no" title="no">know no more</a>',
                               /\bno\b/g, m => '[' + m + ']');
  ok(held.indexOf('href="no"') !== -1 && held.indexOf('title="no"') !== -1,
     'ITEM4: tpOutsideTags is rewriting the insides of HTML tags. The attributes of the script ' +
     'markup get replaced, which corrupts the rendered script — this is the job the removed ' +
     'lookbehind was doing and it has not been replaced.');
  ok(held.indexOf('[no]') !== -1,
     'ITEM4: tpOutsideTags no longer replaces anything in the visible text, so nothing on the ' +
     'teleprompter is ever emphasised.');
}

/* ══ ITEM 5 — emphasis marks are WHOLE WORDS (except where they are not) ═════
   BEHAVIOURAL: the real tpEmphasise over the real tpEscape. */
{
  const E = (s, marks) => M.tpEmphasise(M.tpEscape(s), marks);

  const ai = E('We said it again and it will fail, waiting on email.', ['AI']);
  ok(ai.indexOf('<b') === -1,
     'ITEM5: the mark "AI" is bolding letter-pairs inside unrelated words — "' + ai + '". ' +
     'Short marks are the normal case, not the edge, and a prompter that underlines random ' +
     'fragments makes every other bold word on the page untrustworthy while the person is on ' +
     'camera and cannot stop to work out why.');

  const no = E('You know another notice is normal.', ['no']);
  ok(no.indexOf('k<b') === -1 && !/know<\/b>|<b class="tp-em">no<\/b>w/.test(no) &&
     no.indexOf('<b') === -1,
     'ITEM5: the mark "no" is bolding the middle of "know", "notice" and "normal" — "' + no +
     '". The reader sees emphasis where there is none and misreads the line.');

  const never = E('Never guess what works.', ['Never']);
  ok(/<b class="tp-em">Never<\/b>/.test(never),
     'ITEM5: a real whole-word mark is no longer bolded at all — "' + never + '". The word ' +
     'the line turns on is now indistinguishable from the rest, so the reader flattens the ' +
     'delivery on the one word that mattered.');

  const money = E('It costs $24 a month.', ['$24']);
  ok(/<b class="tp-em">\$24<\/b>/.test(money),
     'ITEM5: a mark that does not start with a letter, like "$24", is never bolded — "' + money +
     '". Word boundaries have been added on both sides unconditionally, so prices, percentages ' +
     'and anything in brackets lose their emphasis entirely.');

  // Two marks, the second of which occurs ONLY inside the markup the first one just
  // wrote (class="tp-em"). Counting the marker string is NOT enough: a plain
  // .replace() splits that very attribute open and the count stays at one, so this
  // asserts the exact markup and, separately, that no tag was opened inside a tag.
  const one = E('The system works.', ['system', 'em']);
  ok(one === 'The <b class="tp-em">system</b> works.',
     'ITEM5: emphasis is being applied inside the markup it just wrote \u2014 "' + one + '". The ' +
     'class attribute of an earlier bold is rewritten, so the bold styling on the teleprompter ' +
     'silently stops working and the reader gets no emphasis at all on a line that has some.');
  ok(!/<[^>]*<[a-zA-Z]/.test(one),
     'ITEM5: a tag has been opened inside another tag \u2014 "' + one + '". The script markup is ' +
     'corrupt, so the browser prints attribute text as words on screen in the middle of the line ' +
     'the person is reading off camera.');

  const esc = E('<img src=x onerror=alert(1)> and 50% off', []);
  ok(esc.indexOf('&lt;img') === 0,
     'ITEM5: the emphasis pass is handing back unescaped markup — "' + esc.slice(0, 60) +
     '". A script containing a stray angle bracket now renders as live HTML on the prompter.');
}

if (fails.length) {
  console.error('PROMPTER FOLLOW GATE FAILED (' + fails.length + '):');
  fails.forEach(f => console.error('  - ' + f));
  process.exit(1);
}
console.log('prompter follow verified: nearest qualifying match wins and a real skip still lands, ' +
            'one normaliser folds accents and joins in-word separators on both sides, a stopped ' +
            'recogniser is fully unhooked and aborted, no live lookbehind anywhere in app.html, ' +
            'emphasis marks are word-bounded without losing "$24"');
console.log('PASS');
