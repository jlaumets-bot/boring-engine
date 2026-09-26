#!/usr/bin/env node
// GATE: beat text is cut to the COLUMN, never to a character count, and never silently.
//
// WHY THIS EXISTS
//   The two sub lines in spRenderBeat were cut with .slice(0,42) and .slice(0,44) against a
//   server cap of 110 (api/video-beats.js:19), so up to 66 characters were thrown away mid-word
//   with no ellipsis — the sentence simply stopped. Measured with a real canvas at the render's
//   own font and column (x=54, W=720 → 612px):
//       "We tested nine best-sellers and only two matched the dose printed on the tub."
//       old slice(0,44) → 686px wide, right edge 740 on a 720px canvas — chopped AGAIN by the
//                         bitmap edge, so the card ended mid-letter
//       new spFitLine   → 577px, right edge 631, ends "and only…"
//   A character count is the wrong unit in both directions: all-caps ran off the canvas, while
//   ordinary prose lost 33 characters that would have fitted.
//
//   spWrap had the matching bug: it returned out.slice(0, 4) and dropped everything after,
//   while api/video-beats.js:104 *instructs* contrast beats to "put the flip in headline using a
//   line break" — so the punchline of a before/after card could vanish with no trace.
//
//   And a chips beat's sub was drawn in the PREVIEW (brollBeatHtml, app.html:9675) and never in
//   the video: the person approved a sentence the export did not contain.
//
// HOW IT CHECKS
//   It RUNS the real spFitLine and spWrap against stub contexts with known metrics — including a
//   deliberately wide one standing in for all-caps — and asserts the property that matters: what
//   is drawn never exceeds the column. The opposite arm matters just as much: text that already
//   fits must come back untouched, or every card would end in an ellipsis.
//
// RUN:    node scripts/verify/beat-text-fits.mjs
// EXPECT: prints "PASS" and exits 0.
import fs from 'node:fs'; import vm from 'node:vm';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
setTimeout(() => { console.log('FAIL: wall clock (60s) exceeded'); process.exit(2); }, 60000).unref();
let fail = 0; const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fail++; } else console.log('ok:', m); };
const grab = n => { const i = html.indexOf('\nfunction ' + n + '('); if (i < 0) throw new Error('no ' + n);
  return html.slice(i + 1, html.indexOf('\n}', i) + 2); };

const ctxv = { Math, String, Array, Intl };
vm.createContext(ctxv);
vm.runInContext(grab('spGraphemes') + '\n' + grab('spFitLine') + '\n' + grab('spWrap'), ctxv);
const spFitLine = vm.runInContext('spFitLine', ctxv);
const spWrap = vm.runInContext('spWrap', ctxv);

// The render's real geometry, read from the source so it cannot drift.
const beat = grab('spRenderBeat');
const X = Number((/const x = (\d+), maxW = W - x\*2;/.exec(beat) || [])[1]);
ok(X > 0, 'the column inset is read from spRenderBeat (x=' + X + ')');
const W = 720, MAXW = W - X * 2;

// Stub metrics. `per` is px per character — 11 is close to the real 26px prose measure, 15.6
// stands in for all-caps, which is what ran off the canvas.
const mkCtx = (per) => ({ measureText: (t) => ({ width: String(t).length * per }) });

for (const [label, per] of [['prose-ish (11px/char)', 11], ['all-caps-ish (15.6px/char)', 15.6], ['very wide (24px/char)', 24]]) {
  const ctx = mkCtx(per);
  const long = 'We tested nine best sellers and only two matched the dose printed on the tub and it shows';
  const out = spFitLine(ctx, long, MAXW);
  const w = ctx.measureText(out).width;
  ok(w <= MAXW,
     label + ': the drawn sub fits the ' + MAXW + 'px column (' + w.toFixed(0) + 'px). A character ' +
     'count cut all-caps text to 686px on a 720px canvas, so it ran off the edge and was chopped again.');
  ok(/…$/.test(out), label + ': and it ends with an ellipsis, so the card reads as cut rather than as finished');
  ok(out.length < long.length, label + ': something was actually removed');
}
// the opposite arm: text that fits is untouched
{
  const ctx = mkCtx(11);
  const shortLine = 'Per scoop, third-party verified.';
  ok(spFitLine(ctx, shortLine, MAXW) === shortLine,
     'a sub that already fits comes back byte-identical — no ellipsis, nothing trimmed. Cutting ' +
     'everything would be a different bug.');
  ok(spFitLine(ctx, '', MAXW) === '' && spFitLine(ctx, null, MAXW) === '', 'empty and null are safe');
}
// a word boundary is preferred, but a single huge word still gets cut
{
  const ctx = mkCtx(11);
  const out = spFitLine(ctx, 'We tested nine best sellers and only two matched the dose printed', MAXW);
  ok(!/\s…$/.test(out) && out.indexOf(' ') > 0, 'the cut lands at a word, not mid-word: ' + JSON.stringify(out));
  const oneWord = 'A'.repeat(300);
  const cut = spFitLine(ctx, oneWord, MAXW);
  ok(ctx.measureText(cut).width <= MAXW, 'a single unbroken 300-character word is still cut to the column');
}
// ── spWrap: a fifth line is marked, not silently dropped ────────────────────
{
  const ctx = mkCtx(11);
  const five = 'Cheap tub\nEmpty scoop\nOur tub\nFull scoop\nEvery time';
  const lines = spWrap(five, ctx, MAXW);
  ok(lines.length === 4, 'spWrap still returns at most four lines (' + lines.length + ')');
  /* The property that matters is NO WORD DISAPPEARS. Either the tail survives in the fourth line
     (it fitted after all) or that line is marked with an ellipsis to say it was cut. The old code
     satisfied neither: it returned out.slice(0,4) and the fifth line was simply gone. Asserting
     the ellipsis alone was wrong — this gate caught that on its first run against narrow text,
     where the tail fits and no mark is needed. */
  const joined = lines.join(' ');
  const tailKept = /Every\s*time/.test(joined);
  ok(tailKept || /\u2026$/.test(lines[3]),
     'the fifth line is either kept or marked as cut, never silently dropped (' +
     JSON.stringify(lines[3]) + '). api/video-beats.js INSTRUCTS contrast beats to use line breaks, ' +
     'so the punchline of a before/after card used to vanish without trace.');
  ok(ctx.measureText(lines[3]).width <= MAXW, 'and the fourth line still fits the column');
  const wide = mkCtx(40);   // wide enough that the merged tail genuinely cannot fit
  const wideLines = spWrap(five, wide, MAXW);
  ok(/\u2026$/.test(wideLines[3]),
     'with wide text the tail cannot fit, so the fourth line is marked (' +
     JSON.stringify(wideLines[3]) + ') rather than dropped');
  ok(wide.measureText(wideLines[3]).width <= MAXW, 'and it is still inside the column');
  const four = 'One\nTwo\nThree\nFour';
  const kept = spWrap(four, ctx, MAXW);
  ok(kept.length === 4 && !/…/.test(kept[3]),
     'exactly four lines are returned unmarked (' + JSON.stringify(kept) + ') — marking a headline ' +
     'that was never cut would be its own lie');
}
// ── no character-count cut survives in the beat renderer ────────────────────
{
  ok(!/String\(b\.sub\)\.slice\(0,\s*\d+\)/.test(beat),
     'neither sub draw cuts by character count any more (slice(0,42) / slice(0,44))');
  ok((beat.match(/spFitLine\(ctx, b\.sub, maxW\)/g) || []).length >= 3,
     'all three kinds — number, chips and statement/contrast — draw the sub through the fitter. ' +
     'The chips branch had NO sub draw at all, so the preview showed a sentence the export did not.');
}

// ── v690: emoji are cut whole, never split into a half that draws as a box ───
{
  const fire = String.fromCodePoint(0x1F525);
  const text = 'Hot take ' + fire.repeat(80);
  const unitCtx = mkCtx(11);   // width by UTF-16 unit, as a canvas roughly does for astral glyphs
  const lone = (s) => { for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) { const d = s.charCodeAt(i + 1); if (!(d >= 0xDC00 && d <= 0xDFFF)) return true; i++; }
    else if (c >= 0xDC00 && c <= 0xDFFF) return true; } return false; };
  const bad = [];
  for (const mw of [600, 611, 589, 578, 567, 300, 123]) {
    const out = spFitLine(unitCtx, text, mw);
    if (lone(out) || unitCtx.measureText(out).width > mw) bad.push(mw);
  }
  ok(bad.length === 0,
     'a line of emoji is cut between characters, never inside one (bad widths: ' + bad.join(',') + '). ' +
     'slice() by UTF-16 unit split a surrogate pair and the lone half drew as a replacement box before the ellipsis');
  ok(spFitLine(unitCtx, 'Plain words ' + fire, 612) === 'Plain words ' + fire, 'and an emoji line that fits is untouched');
}
// ── v690: a word wider than the column is broken, not drawn off the canvas ───
{
  const ctx = mkCtx(11);
  const url = 'contentshrimp.com/' + 'a'.repeat(110);
  const lines = spWrap('See ' + url, ctx, MAXW);
  const widest = Math.max(...lines.map(l => ctx.measureText(l).width));
  ok(widest <= MAXW,
     'a 128-character link wraps inside the ' + MAXW + 'px column (widest line ' + widest + 'px). A line only ' +
     'ever broke between words, so this was one line drawn straight off the 720px canvas');
  ok(lines.join('') === 'See' + url,
     'and no character of it is lost (' + lines.length + ' lines)');
  const cjk = String.fromCodePoint(0x6211).repeat(120);
  const wide = mkCtx(26);
  const cl = spWrap(cjk, wide, MAXW);
  ok(cl.length === 4 && cl.every(l => wide.measureText(l).width <= MAXW),
     'text with no spaces at all (Chinese / Japanese) wraps to four in-column lines (' + cl.map(l => wide.measureText(l).width).join('/') + ')');
  const plain = spWrap('Short words only here', ctx, MAXW);
  ok(plain.length === 1 && plain[0] === 'Short words only here', 'the opposite arm: ordinary words wrap exactly as before');
}
// ── v690: the highlight and a number beat's headline are actually DRAWN ─────
{
  const draws = [];
  const mkCanvasCtx = () => {
    const st = { font: '10px x', fillStyle: '', letterSpacing: '0px' };
    const size = () => Number((/(\d+)px/.exec(st.font) || [0, 10])[1]);
    return new Proxy(st, { get(t, k) {
      if (k === 'measureText') return (s) => ({ width: String(s).length * size() * 0.55 });
      if (k === 'fillText') return (s, x, y) => draws.push({ s: String(s), fill: t.fillStyle, font: t.font, x, y });
      if (k in t) return t[k];
      return () => {};
    }, set(t, k, v) { t[k] = v; return true; } });
  };
  const c = { Math, String, Number, Array, Proxy, Intl, SP_SS: 2,
    document: { createElement: () => ({ width: 0, height: 0, getContext: () => mkCanvasCtx() }) } };
  vm.createContext(c);
  for (const n of ['spRoundRect', 'spGraphemes', 'spHighlightSpans', 'spFitLine', 'spWrap', 'spRenderBeat']) vm.runInContext(grab(n), c);
  const pal = { panel: 'P', text: 'T', muted: 'M', eyebrow: 'E', accent: 'A', accentText: 'HI', chipBg: 'C', duotone: 'D', seam: 'S' };
  const render = (b) => { draws.length = 0; c.B = b; c.PAL = pal; vm.runInContext('spRenderBeat(B, 720, 640, PAL)', c); return draws.slice(); };
  const hi = (d) => d.filter(x => x.fill === 'HI').map(x => x.s);

  const caseMiss = render({ kind: 'statement', headline: 'Only two scoops matched', highlight: 'Two Scoops' });
  ok(hi(caseMiss).join(' ') === 'two scoops',
     'a highlight whose case differs from the headline is still painted (' + JSON.stringify(hi(caseMiss)) + '). The server ' +
     'accepts it case-insensitively and the preview shows it; the render looked for it case-SENSITIVELY and drew nothing');
  const straddle = render({ kind: 'statement', headline: 'We tested nine best sellers today', highlight: 'best sellers' });
  const lines = straddle.filter(x => /52px/.test(x.font) && x.fill === 'T').map(x => x.s);
  ok(lines.length >= 2 && hi(straddle).join(' ') === 'best sellers',
     'a highlight split by the wrap is painted on BOTH lines (' + JSON.stringify(hi(straddle)) + ' across ' + JSON.stringify(lines) + ')');
  const absent = render({ kind: 'statement', headline: 'Nothing to mark here', highlight: 'elsewhere' });
  ok(hi(absent).length === 0, 'the opposite arm: a highlight that is not in the headline paints nothing');
  const exact = render({ kind: 'statement', headline: 'Only two scoops', highlight: 'two' });
  ok(JSON.stringify(hi(exact)) === '["two"]', 'and an exact-case highlight is painted once, as before (' + JSON.stringify(hi(exact)) + ')');

  const num = render({ kind: 'number', value: '34g', headline: 'of protein', sub: 'per scoop, nothing else' });
  const texts = num.map(x => x.s);
  ok(texts.includes('of protein'),
     "a number beat's headline is drawn (" + JSON.stringify(texts) + '). The prompt lets the model send one ("very short") ' +
     'and it was drawn nowhere — "34g" with the words that give it meaning thrown away');
  const numY = (s) => (num.find(x => x.s === s) || {}).y;
  ok(numY('34g') < numY('of protein') && numY('of protein') < numY('per scoop, nothing else'),
     'in order: figure, headline, sub — nothing drawn on top of anything else');
  const bare = render({ kind: 'number', value: '34g', sub: 'per scoop' });
  ok(bare.map(x => x.s).join('|') === '34g|per scoop', 'the opposite arm: a number beat with no headline draws exactly what it did before');
}

// ── v690 r2: cut and wrap by GRAPHEME — flags, joined emoji, combining accents ─
{
  const cp = (...a) => String.fromCodePoint(...a);
  const unitCtx = mkCtx(11);
  const flag = cp(0x1F1EA, 0x1F1EA);                                  // two regional indicators = one flag
  const family = cp(0x1F468, 0x200D, 0x1F469, 0x200D, 0x1F467);      // three people joined by U+200D
  const ZWJ = cp(0x200D), ACUTE = String.fromCharCode(0x301);
  const seg = (s) => Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s), x => x.segment);
  const badFlag = [], badFam = [];
  for (const mw of [600, 611, 589, 578, 567, 556, 300, 123]) {
    const f = spFitLine(unitCtx, 'Go ' + flag.repeat(60), mw).replace(/…$/, '');
    if (!seg(f).slice(1).every(g => g === flag || g === 'Go' || g === ' ' || g === 'G' || g === 'o')) badFlag.push(mw);
    const m = spFitLine(unitCtx, 'Us ' + family.repeat(30), mw).replace(/…$/, '');
    if (m.endsWith(ZWJ) || !seg(m).every(g => g === family || /^[Us ]$/.test(g))) badFam.push(mw);
  }
  ok(badFlag.length === 0, 'a row of flags is cut between flags, never through one (bad widths: ' + badFlag.join(',') + ') — half a flag draws as a stray letter box');
  ok(badFam.length === 0, 'a joined family emoji is never cut mid-sequence or left ending on a joiner (bad widths: ' + badFam.join(',') + ')');
  const acc = ('e' + ACUTE).repeat(12);
  const wl = spWrap(acc, unitCtx, 33);
  ok(wl.every(l => l.charCodeAt(0) !== 0x301),
     'a combining accent never starts a line — it stays on its letter (' + JSON.stringify(wl.map(l => l.length)) + ' units per line)');
  // the fallback: an engine with no Intl.Segmenter still never splits a surrogate pair
  const cf = { Math, String, Array, Intl: {} };
  vm.createContext(cf);
  vm.runInContext(grab('spGraphemes'), cf);
  const fb = vm.runInContext('spGraphemes', cf)(flag + 'a');
  ok(fb.length === 3 && fb[0] === cp(0x1F1EA) && fb[2] === 'a',
     'without Intl.Segmenter it falls back to whole code points (' + fb.length + ' pieces), not UTF-16 halves');
  const ce = { Math, String, Array, Intl };
  vm.createContext(ce);
  vm.runInContext(grab('spGraphemes'), ce);
  ok(vm.runInContext('spGraphemes', ce)(flag + family + 'e' + ACUTE).length === 3, 'with it, a flag, a family and an accented letter are three characters');
}
// ── v690 r2: a highlight inside a word that the wrap had to split ────────────
{
  const hctx = { Math, String, Number, Array };
  vm.createContext(hctx);
  for (const n of ['spGraphemes', 'spFitLine', 'spWrap', 'spHighlightSpans']) vm.runInContext(grab(n), hctx);
  const wrapH = vm.runInContext('spWrap', hctx), spans = vm.runInContext('spHighlightSpans', hctx);
  const ctx = mkCtx(11);
  const url = 'contentshrimp.com/' + Array.from({ length: 36 }, (_, i) => String(i + 100)).join('');   // no repeated runs
  const lines = wrapH('See ' + url, ctx, MAXW);
  const hl = url.slice(48, 62);   // straddles the character split after 55
  ok(url.indexOf(hl) === url.lastIndexOf(hl), 'the test highlight occurs once in the link');
  const sp = spans(lines, hl);
  const got = sp.map((s, i) => (s ? lines[i].slice(s[0], s[1]) : '')).join('');
  ok(got === hl && sp.filter(Boolean).length === 2,
     'a highlight inside a link the wrap split by character is found and painted on both lines (' + JSON.stringify(sp) + '). ' +
     'Joining the lines with a space put a space in the middle of the word, so it never matched');
  ok(spans(lines, 'not in here').every(x => x === null), 'the opposite arm: text that is not there is not painted');
  const plain = wrapH('We tested nine best sellers today and only two matched the dose on the tub', ctx, 150);
  const ps = spans(plain, 'best sellers');
  ok(ps.filter(Boolean).length >= 1 && ps.map((s, i) => (s ? plain[i].slice(s[0], s[1]) : '')).filter(Boolean).join(' ') === 'best sellers',
     'and an ordinary between-words wrap still keeps its space (' + JSON.stringify(plain) + ')');
}

if (fail === 0) console.log('\nPASS — beat-text-fits: nothing is cut by character count, nothing runs off the canvas, and nothing vanishes without a mark.');
else { console.log('\n' + fail + ' failure(s)'); process.exitCode = 1; }
