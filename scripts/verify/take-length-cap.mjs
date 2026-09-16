#!/usr/bin/env node
// GATE: a take has a maximum length, the person is warned before it arrives, and reaching it
//       SAVES the take rather than throwing it away.
//
// WHY THIS EXISTS
//   The recorder runs at videoBitsPerSecond: 20_000_000 — about 150 MB per minute — and there
//   was no limit of any kind on how long someone could film. Three minutes is roughly 450 MB.
//   Three things go wrong at that size, and the person only finds out at the end:
//     * the split-screen render has to flush the file through the muxer inside a 15-second
//       timeout, which a mid-range phone misses — so the build fails after they have sat
//       through it with the screen held awake;
//     * most share targets refuse a file that big;
//     * the chunks live only in memory until the take ends, so the longest take is also the one
//       most likely to be lost when the phone reclaims the tab.
//   A cap is only worth having if it behaves honestly, which is what this gate is really about:
//   it must warn first, it must stop rather than discard, and it must never be able to fire
//   against a LATER take. A cap that fires late would end someone's next take for them.
//
// HOW IT CHECKS
//   The numbers are read out of the source and reasoned about (warning before the stop, enough
//   notice to finish a sentence, a worst-case file size that is actually achievable).
//   The behaviour is checked structurally, because arming a timer inside startTpRecord cannot be
//   executed from node: the cap's own callback is sliced out and required to call the ORDINARY
//   stop and to do nothing once recording has ended.
//   The important arm is the last one, and it is DERIVED rather than a list: every place in
//   app.html that clears the recording clock is a place a take ends, so every one of them must
//   also clear the cap. A new teardown path added tomorrow that forgets shows up here by itself.
//
// RUN:    node scripts/verify/take-length-cap.mjs
// EXPECT: prints "PASS" and exits 0.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../app.html');
const src = fs.readFileSync(APP, 'utf8');
const fails = [];
const bad = m => fails.push(m);

// Comments in this file describe the very identifiers asserted on below, so strip them first —
// a check that passes on prose is a false green, which is worse than no check.
const decomment = t => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const num = (name) => {
  const m = new RegExp('const ' + name + '\\s*=\\s*(\\d+)').exec(decomment(src));
  return m ? Number(m[1]) : null;
};
const MAX = num('TP_MAX_TAKE_MS');
const WARN = num('TP_WARN_TAKE_MS');

if (MAX === null) {
  bad('there is no maximum take length. Filming is unbounded at 20 Mbps — about 150 MB a minute — ' +
      'so a long take produces a file the split screen cannot flush in time and most apps will not accept.');
} else {
  if (MAX < 60000) bad('the maximum take is ' + (MAX/1000) + 's, which will cut people off mid-script on an ordinary post.');
  const mb = (MAX / 1000) * 2.5;   // 20 Mbps ~ 2.5 MB per second
  if (mb > 500) bad('the cap allows a take of about ' + Math.round(mb) + ' MB. That is past the size where the ' +
                    'render times out flushing the file and the share sheet refuses it, so the cap is not capping the thing that hurts.');
}
if (WARN === null) {
  bad('nothing warns the person before filming is stopped for them, so the cut lands mid-sentence with no notice.');
} else if (MAX !== null) {
  if (WARN >= MAX) bad('the warning fires at or after the stop, so it is not a warning.');
  else if (MAX - WARN < 15000) bad('the warning gives only ' + ((MAX-WARN)/1000) + 's notice — not enough to finish a thought before the take ends.');
}

// The cap's own callback: it must END the take through the ordinary path, never discard it.
const capAt = src.indexOf('tpMaxTakeT = setTimeout');
if (capAt < 0) {
  bad('the maximum take length is declared but never armed, so nothing enforces it.');
} else {
  const capEnd = src.indexOf('}, TP_MAX_TAKE_MS)', capAt);
  const cap = decomment(src.slice(capAt, capEnd < 0 ? capAt + 800 : capEnd));
  if (!/stopTpRecord\s*\(/.test(cap)) {
    bad('reaching the time limit does not call the ordinary stop. Anything else loses the take: stopTpRecord is ' +
        'what runs onstop, which is what assembles the file and opens review.');
  }
  if (/tpRecordedChunks\s*=\s*\[\]/.test(cap) || /\breturn\b[^]*tpRecordedChunks\s*=\s*\[\]/.test(cap)) {
    bad('the time limit DISCARDS what was filmed. The cap exists to bound the file size, not to punish someone ' +
        'for talking too long — everything up to the limit is theirs.');
  }
  if (!/state\s*===\s*'recording'/.test(cap)) {
    bad('the cap fires without checking that a take is still rolling, so a timer left over from a finished take ' +
        'can stop a later one on its behalf.');
  }
}
if (src.indexOf('tpWarnTakeT = setTimeout') < 0) bad('the warning is declared but never armed.');

// DERIVED, not a list: every site that stops the recording clock is a place a take ends, and each
// one must also cancel the cap. This is what catches a teardown path added later that forgets.
const lines = src.split('\n');
const missing = [];
lines.forEach((ln, i) => {
  if (!/clearInterval\(tpRecTimerInterval\)/.test(ln)) return;
  if (/^\s*(\/\/|\*)/.test(ln)) return;
  const window = decomment(lines.slice(Math.max(0, i - 3), i + 5).join('\n'));
  if (!/tpClearTakeLimit\s*\(/.test(window)) missing.push(i + 1);
});
if (missing.length) {
  bad('a take ends at app.html:' + missing.join(', app.html:') + ' (the recording clock is stopped there) but the ' +
      'length cap is not cancelled. A timer left armed from a finished take fires during the NEXT one and ends ' +
      'that take for the person, with a message about a limit they never reached.');
}
if (!/function tpClearTakeLimit/.test(src)) bad('tpClearTakeLimit does not exist, so nothing can cancel an armed cap.');

if (fails.length) {
  console.error('FAIL:');
  fails.forEach(f => console.error('  - ' + f));
  process.exit(1);
}
console.log('take length cap verified: ' + (MAX/1000) + 's maximum with ' + ((MAX-WARN)/1000) +
            's notice, the take is stopped and kept rather than discarded, and every teardown path cancels the cap.');
console.log('PASS');
