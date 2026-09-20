#!/usr/bin/env node
// GATE: a graphics cue may not claim a time the phone never heard.
//
// WHY THIS EXISTS
//   tpVoiceWords is built from the SCRIPT DOM — what the person was meant to say — while
//   _tpVoiceTimeline holds only the words speech recognition actually caught, and recognition
//   routinely drops the tail (tpBeatTimesFromVoice's own v563 comment says so). So a cue sitting
//   in the unheard tail still matched a script word, counted toward `ok`, and was handed
//   timeAtWord's final fallback — `tl[tl.length-1].t`, the SAME timestamp for every one of them.
//   The min-spacing pass then pushed them 0.70s apart and the clamp pulled them back to the clip
//   end, piling them up there.
//
//   Measured against the real function, 45-second take, recognition dying at 5 seconds:
//       before: starts 0.00, 3.33, 5.00, 5.70  → on screen 3.33 | 1.67 | 0.70 | 39.30
//   Cards two and three flash past faster than anyone can read; card four is frozen for 39 of the
//   45 seconds. The result sheet then reported "matched 4/4 beats" — the diagnostic actively said
//   the timing was perfect. The whole point of the feature is graphics that follow the speech.
//
//   Two fixes, both required. (1) timeAtWord returns null past the last heard word, so those beats
//   are UNMATCHED — which is what they are — and the pace extension written for exactly this case
//   takes over, and `matched N/M` becomes a true statement. (2) trailing beats share the clip that
//   is left instead of extrapolating avgGap, which is measured only from the matched anchors: when
//   those span five seconds, multiplying that across a whole take put every trailing beat in the
//   first few seconds and left the last card frozen for the rest.
//
// HOW IT CHECKS
//   It RUNS the real tpBeatTimesFromVoice, lifted from app.html, against two timelines: one where
//   recognition heard everything and one where it died early. The good case must be unchanged —
//   an over-correction that spreads every beat evenly would break the feature just as thoroughly.
//
// RUN:    node scripts/verify/beat-timing-honest.mjs
// EXPECT: prints "PASS" and exits 0.
import fs from 'node:fs'; import vm from 'node:vm';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
let fail = 0; const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fail++; } else console.log('ok:', m); };
const grab = n => { const i = html.indexOf('\nfunction ' + n + '('); if (i < 0) throw new Error('no ' + n);
  return html.slice(i + 1, html.indexOf('\n}', i) + 2); };

const SP_MIN_BEAT = Number((/const SP_MIN_BEAT\s*=\s*([\d.]+)/.exec(html) || [])[1]);
ok(SP_MIN_BEAT > 0, 'SP_MIN_BEAT read from the source (' + SP_MIN_BEAT + 's)');

const SCRIPT = ('Most founders never charge enough for their time. '
  + 'We tested nine best sellers and only two matched the dose. '
  + 'That is the whole difference right there. '
  + 'Nobody warned us about the boring middle. '
  + 'It took forty months to fix it properly. '
  + 'And that is why we built this thing.').split(/\s+/);
const BEATS = [
  { cue: 'Most founders never charge' },
  { cue: 'We tested nine best sellers' },
  { cue: 'That is the whole difference' },
  { cue: 'It took forty months' },
];
const DUR = 45;

function place(timeline) {
  const ctx = { console, Math, Array, String, window: { _tpVoiceTimeline: timeline }, SP_MIN_BEAT, BEATS, DUR };
  ctx.tpNormWords = s => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  ctx.tpVoiceWords = SCRIPT.map(w => ({ key: w.toLowerCase().replace(/[^a-z0-9]/g, '') }));
  vm.createContext(ctx);
  vm.runInContext(grab('tpBeatTimesFromVoice'), ctx);
  const times = vm.runInContext('tpBeatTimesFromVoice(BEATS, DUR)', ctx);
  if (!times) return null;
  const on = times.map((t, i) => +(((i + 1 < times.length ? times[i + 1] : DUR) - t)).toFixed(2));
  return { times, on, matched: ctx.window._tpBeatMatched };
}
const mkTl = (lastWord, lastT) => { const tl = []; for (let w = 0; w <= lastWord; w += 3) tl.push({ w, t: +(lastT * (w / lastWord)).toFixed(2) }); return tl; };

// ── 1. recognition died early: no unreadable flash, no frozen card, honest count ──
{
  const r = place(mkTl(12, 5));
  ok(!!r, 'the early-death case still produces a placement (it must not fall through to nothing)');
  if (r) {
    const flashes = r.on.filter(x => x <= SP_MIN_BEAT + 0.01);
    ok(flashes.length === 0,
       'no beat is on screen for the bare minimum spacing (' + r.on.join(' | ') + '). Those are the ' +
       'cards that flash past unreadably when several cues collapse onto the same timestamp.');
    const frozen = r.on.filter(x => x > DUR * 0.5);
    ok(frozen.length === 0,
       'no single card holds more than half the clip (' + r.on.join(' | ') + '). Extrapolating avgGap ' +
       'from anchors that span five seconds left the last card up for 39 of 45 seconds.');
    ok(r.matched < BEATS.length,
       'and the reported match count is HONEST (' + r.matched + '/' + BEATS.length + '). A cue found ' +
       'in the script but never heard is not a match, and reporting 4/4 told the person the timing ' +
       'was perfect while the graphics were ruined.');
    ok(r.matched >= 1, 'the cues that WERE heard still count (' + r.matched + ')');
  }
}
// ── 2. recognition heard everything: unchanged, cues still followed ──────────
{
  const r = place(mkTl(35, 44));
  ok(!!r, 'the good case still places beats');
  if (r) {
    ok(r.matched === BEATS.length,
       'every cue matches when the phone heard the whole take (' + r.matched + '/' + BEATS.length +
       ') — the fix must not discard real matches');
    ok(r.times[1] > 5 && r.times[2] > r.times[1] && r.times[3] > r.times[2],
       'and the beats still land WHERE THE WORDS WERE, not spread evenly: ' +
       r.times.map(t => t.toFixed(1)).join(', ') + '. An over-correction that spaced every beat ' +
       'equally would break the feature just as thoroughly as the bug.');
    const spread = r.times[3] - r.times[1];
    ok(spread > 20, 'the matched beats span the take rather than bunching (' + spread.toFixed(1) + 's)');
  }
}
// ── 3. the source still refuses to guess from an unusable timeline ───────────
{
  ok(place([{ w: 0, t: 0 }]) === null,
     'a timeline too short to interpolate returns null so the caller falls through to the scroll ' +
     'and script-position strategies, rather than inventing times');
}
// ── 4. the two fixes are present and load-bearing ────────────────────────────
{
  const fn = grab('tpBeatTimesFromVoice');
  ok(/if \(idx > lastHeardWord\) return null;/.test(fn),
     'timeAtWord returns null past the last word that was actually heard');
  ok(/const tailCount = times\.length - 1 - prev;/.test(fn),
     'trailing beats share the remaining clip instead of extrapolating a pace from a short sample');
}

if (fail === 0) console.log('\nPASS — beat-timing-honest: unheard cues are not claimed as matches, and no card flashes or freezes.');
else { console.log('\n' + fail + ' failure(s)'); process.exitCode = 1; }
