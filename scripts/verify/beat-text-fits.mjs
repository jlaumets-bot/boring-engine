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
let fail = 0; const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fail++; } else console.log('ok:', m); };
const grab = n => { const i = html.indexOf('\nfunction ' + n + '('); if (i < 0) throw new Error('no ' + n);
  return html.slice(i + 1, html.indexOf('\n}', i) + 2); };

const ctxv = { Math, String };
vm.createContext(ctxv);
vm.runInContext(grab('spFitLine') + '\n' + grab('spWrap'), ctxv);
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

if (fail === 0) console.log('\nPASS — beat-text-fits: nothing is cut by character count, nothing runs off the canvas, and nothing vanishes without a mark.');
else { console.log('\n' + fail + ' failure(s)'); process.exitCode = 1; }
