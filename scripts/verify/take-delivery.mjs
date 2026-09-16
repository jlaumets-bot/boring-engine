#!/usr/bin/env node
// GATE: a take that was filmed must reach the person who filmed it — v660's
//       delivery path (take guards, stop watchdog salvage, byte floor, rescue
//       sheet, and the paywall suppression that used to navigate the take away).
//
// WHY THIS EXISTS
//   Someone stands in front of their phone, reads a script off the teleprompter,
//   and performs for three minutes. That performance is the single most expensive
//   thing this app ever holds, and it lives nowhere but in memory. Five separate
//   ways of losing it shipped before v660, and every one of them ended with the
//   app telling the person something cheerful:
//
//     1. They tapped Retake. Take two filmed with no guards on the camera track,
//        because the flag that marks a track as guarded was never cleared and the
//        retake reuses the very same track objects. Then take one's leftover
//        handler fired, said "the take up to that point is saved", and saved
//        nothing — it was reading the old, dead recorder.
//     2. The camera stopped answering while they closed the prompter. After eight
//        seconds the app gave up, tore the camera down, and said nothing could be
//        saved — while a complete, playable file sat in memory, because the
//        recorder hands over a chunk every second.
//     3. The recorder wrote a container header and no frames. A few hundred bytes
//        is not zero, so it counted as a take: "Filmed ✓", then a review card
//        playing a black rectangle they could not keep, share or retake past.
//     4. They opened the app from a link inside Instagram. They filmed, tapped
//        "Keep it", and landed on a screen with no share sheet (that webview has
//        none) and no download that does anything. The app closed the prompter,
//        showed a toast telling them to "use Share", and revoked the video two
//        minutes later. There was no Share button on the screen.
//     5. They were out of posts this month. Building the split screen hit the
//        paywall, the upgrade modal opened over their finished take, and its
//        Upgrade button sent the browser to Stripe. The page died and took the
//        recording with it. They paid and came back to nothing.
//
//   Each of those is a person losing a performance they cannot repeat, told by
//   the app that it went fine. This gate is here so none of the five comes back.
//
// HOW IT CHECKS
//   Three arms run the real code, three cannot and say so:
//
//   BEHAVIOURAL — the source is lifted out of app.html, compiled with
//   new Function, and executed against stubs:
//     * tpCanDeliver + _tpDownloadsInert together, over four devices (iPhone with
//       a file share sheet, desktop Chrome, an Instagram webview with no share,
//       an Instagram webview whose share sheet does take files). The Instagram-
//       with-no-share device MUST come back "cannot deliver".
//     * tpHoldTake / tpReleaseTake, with stub timers: the flag must go up, the
//       failsafe must be a real timer that puts it back down, and release must
//       both clear the flag and cancel the timer.
//     * the 402 branch of the global fetch wrapper, run four times (held/not held
//       x limit_reached/feature_locked). While a take is held it must toast and
//       must NOT reach showUpgrade or showFeatureLock; with nothing held it must
//       still reach them, or the paywall is simply broken.
//     * tpReview's entry guard, compiled and run against a 0-byte blob, a
//       512-byte header-only blob and a real one. A truthiness test passes 512.
//     * TP_MIN_TAKE_BYTES is parsed out of the source and checked to be a floor
//       that a header-only take actually falls under.
//
//   STRUCTURAL — items 1, 2 and the wiring of 4 are lifecycle code buried inside
//   a 1.4MB HTML document: closures over a live MediaRecorder, DOM teardown,
//   timers. There is no honest way to execute them here, so those arms slice the
//   ENCLOSING function (or arrow, or timer callback) out of app.html by brace
//   matching and then assert on relationships INSIDE that slice — "_unbind's body
//   both nulls onended and deletes the flag", "tpCanDeliver is called at a lower
//   index than closeTeleprompter inside tpShareOrSave". No bare string search
//   over the whole file: a check that would pass because the word appears in a
//   comment two thousand lines away is not a check.
//
//   Deliberately NOT duplicated here — scripts/verify/filming-fixes.mjs already
//   owns: tpEndTake's blur/camera teardown, the review Keep-vs-Retake handlers
//   and their tpEndTake ordering, the no-review fallback order in
//   startTpRecord.onstop, the window.MediaRecorder guard, tpRecordTap's
//   record-engine takeover, renderSplitScreen's drift-probe revoke and wake-lock
//   re-acquire, and the _spCancel checks in tpOfferSplit. This gate covers only
//   what v660 added on top.
//
// RUN:    node scripts/verify/take-delivery.mjs
// EXPECT: prints "PASS" and exits 0.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = process.argv[2] ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../app.html');
const src = fs.readFileSync(APP, 'utf8');

const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };

/* ── slicing app.html ───────────────────────────────────────────────────────────
   Brace matching that steps over strings, template literals and comments, so a
   brace inside prose or markup cannot close a function early. (The functions this
   gate slices contain no regex literal holding a brace or a quote; if one is ever
   added here, this matcher is the thing to fix.) */
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

// Strip // and /* */ comments while leaving string literals intact, so an ORDER
// assertion cannot be satisfied (or defeated) by prose. tpShareOrSave's header
// comment mentions closeTeleprompter() long before the call, which is exactly the
// kind of thing that makes a raw indexOf comparison meaningless.
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

// Whole source text of a top-level `function NAME(...) { ... }`, braces included.
function fnSource(name) {
  const re = new RegExp('(?:^|\\n)(?:async\\s+)?function\\s+' + name + '\\s*\\(', 'g');
  const m = re.exec(src);
  if (!m) return null;
  const paren = src.indexOf(')', m.index + m[0].length);
  const brace = src.indexOf('{', paren);
  const end = matchBrace(src, brace);
  return end < 0 ? null : decomment(src.slice(m.index, end + 1));
}

// The `{ ... }` block that follows `marker` inside `slice` (arrow bodies, timer
// callbacks, if-blocks) — used to scope an assertion to one closure.
function blockAfter(slice, marker, from = 0) {
  const at = slice.indexOf(marker, from);
  if (at === -1) return null;
  const brace = slice.indexOf('{', at + marker.length - 1);
  if (brace === -1) return null;
  const end = matchBrace(slice, brace);
  return end < 0 ? null : decomment(slice.slice(brace, end + 1));
}

// "a comes strictly before b inside slice", with both required to exist.
function order(slice, a, b) {
  const ia = slice.indexOf(a), ib = slice.indexOf(b);
  return ia !== -1 && ib !== -1 && ia < ib;
}

const FAKE_BLOB = { size: 940000, type: 'video/webm' };

/* ══ ITEM 1 — take guards RELEASE on unbind (structural) ══════════════════════
   A retake reuses the same MediaStreamTrack objects. If _tpEndBound is permanent,
   take two films unguarded and take one's stale onended lies about saving. */
{
  const rec = fnSource('startTpRecord');
  ok(rec, 'ITEM1: startTpRecord() is not in app.html at all — nothing below this can be checked.');
  if (rec) {
    ok(/const\s+_marked\s*=\s*\[\s*\]/.test(rec),
       'ITEM1: startTpRecord no longer keeps a list of the tracks it guarded, so the guard flag is ' +
       'permanent again — a retake films with no track guard, and a camera seized during take two ' +
       'loses the take while take one’s leftover handler says it was saved.');

    const mark = blockAfter(rec, 'const _mark = (t) =>');
    ok(mark, 'ITEM1: the _mark helper that binds a track’s onended is gone from startTpRecord.');
    if (mark) {
      ok(/t\._tpEndBound\s*=\s*true/.test(mark),
         'ITEM1: _mark no longer marks the track, so the same track is bound again on every retake ' +
         'and each old handler fires claiming a take was saved.');
      ok(/_marked\.push\(\s*t\s*\)/.test(mark),
         'ITEM1: _mark marks a track but never records it, so nothing can unmark it later — the ' +
         'retake films with no track guard and a seized camera loses the take silently.');
      ok(/t\.onended\s*=/.test(mark),
         'ITEM1: _mark does not bind onended, so a camera or mic stolen by another app mid-take ' +
         'goes unnoticed and the timer keeps counting on a recorder that is already dead.');
    }

    const unbind = blockAfter(rec, 'const _unbind = () =>');
    ok(unbind, 'ITEM1: the _unbind helper is gone from startTpRecord, so nothing releases the take’s guards.');
    if (unbind) {
      ok(/_marked\.forEach/.test(unbind),
         'ITEM1: _unbind does not walk the guarded tracks, so take one’s handlers stay live on the ' +
         'tracks take two is filming with, and fire against a dead recorder.');
      ok(/onended\s*=\s*null/.test(unbind),
         'ITEM1: _unbind never clears onended. Take one’s handler survives onto take two’s track: ' +
         'when the camera is seized it shows "the take up to that point is saved" and saves nothing.');
      ok(/delete\s+t\._tpEndBound/.test(unbind) || /_tpEndBound\s*=\s*false/.test(unbind),
         'ITEM1: _unbind never clears the _tpEndBound flag, so _mark skips those tracks forever — ' +
         'a retake films with no track guard at all.');
      ok(/_marked\.length\s*=\s*0/.test(unbind),
         'ITEM1: _unbind does not empty the guarded-track list, so it grows across retakes and ' +
         'later unbinds walk tracks belonging to takes that are long gone.');
    }

    const bail = blockAfter(rec, 'const _bail = (why, force) =>');
    ok(bail, 'ITEM1: the _bail helper is gone from startTpRecord.');
    if (bail) ok(/_unbind\(\)/.test(bail),
       'ITEM1: _bail no longer releases the guards, so the guards are never released at all in the ' +
       'one place that ends a take — the retake films unguarded.');

    // Releasing on _bail alone is not enough. A Retake is the ORDINARY end of a take:
    // the person taps Stop, then Retake, and nothing bailed. _unbind has to be reachable
    // from the deliberate stop too, which is what this handle is for. Without the handle
    // the release code above is dead and every mark is permanent again.
    ok(/window\._tpUnbindTakeGuards\s*=\s*_unbind/.test(rec),
       'ITEM1: startTpRecord keeps its release code to itself — nothing outside the take can call ' +
       'it, so stopping take one never unmarks its tracks. Take two films with no track guard, and ' +
       'take one\u2019s leftover handler claims to save a take it does not save.');
    ok(/window\._tpUnbindTakeGuards\s*=\s*null/.test(unbind || ''),
       'ITEM1: _unbind does not withdraw itself after running, so a finished take’s release ' +
       'function stays published and a later stop releases the guards of the take being filmed now.');
  }

  // The two deliberate ends of a take must both call it.
  for (const [fn, why] of [
    ['stopTpRecord', 'tapping Stop, which is what happens immediately before every Retake,'],
    ['closeTeleprompter', 'closing the teleprompter']
  ]) {
    const f = fnSource(fn);
    ok(f, 'ITEM1: ' + fn + '() is not in app.html.');
    if (f) ok(/window\._tpUnbindTakeGuards\s*\(\s*\)/.test(f),
       'ITEM1: ' + fn + ' does not release the take guards, so ' + why + ' leaves every track ' +
       'still marked. The next take films with no track guard at all, and the previous take’s ' +
       'handler is still attached to the track it is filming with.');
  }
}

/* ══ ITEM 2 — the stop watchdog SALVAGES instead of giving up (structural) ════
   start(1000) means the chunks are already in memory when the watchdog fires. */
{
  const close = fnSource('closeTeleprompter');
  ok(close, 'ITEM2: closeTeleprompter() is not in app.html.');
  if (close) {
    const wd = blockAfter(close, 'const _tpStopWd = setTimeout(');
    ok(wd, 'ITEM2: the stop watchdog is gone from closeTeleprompter — a recorder that never fires ' +
           'stop leaves the person stuck on "Saving video..." with no way out.');
    if (wd) {
      ok(/new Blob\(\s*tpRecordedChunks/.test(wd),
         'ITEM2: the watchdog gives up without assembling the chunks it already has. The recorder ' +
         'hands over a chunk every second, so a three-minute take is sitting in memory, playable, ' +
         'and this throws it away and tells them nothing could be saved.');
      ok(/TP_MIN_TAKE_BYTES/.test(wd),
         'ITEM2: the watchdog does not weigh what it salvaged, so an empty container gets handed ' +
         'over as if it were the take.');
      ok(/_tpSalvaged\s*=\s*true/.test(wd),
         'ITEM2: the watchdog salvages the take but does not record that it did, so onstop delivers ' +
         'the same recording a second time — two share sheets, two files, for one take.');
      ok(/tpShareOrSave\(/.test(wd),
         'ITEM2: the watchdog assembles the take and then never hands it to the person.');
      ok(order(wd, 'new Blob(', '_tpSalvaged = true') && order(wd, '_tpSalvaged = true', 'tpShareOrSave('),
         'ITEM2: the watchdog’s salvage runs out of order — it must assemble the take, mark it ' +
         'salvaged, and only then deliver it, or onstop races it and delivers the take twice.');
      ok(order(wd, 'tpShareOrSave(', "Couldn't finish saving"),
         'ITEM2: the watchdog reports the take as lost before or instead of trying to salvage it — ' +
         'which is the exact lie this change was made to stop telling.');
    }

    const onstop = blockAfter(close, 'tpMediaRecorder.onstop = async () =>');
    ok(onstop, 'ITEM2: closeTeleprompter no longer installs an onstop handler.');
    if (onstop) {
      ok(/clearTimeout\(\s*_tpStopWd\s*\)/.test(onstop),
         'ITEM2: onstop does not cancel the watchdog, so a recorder that stops at second seven gets ' +
         'delivered once by onstop and again by the watchdog at second eight.');
      ok(/if\s*\(\s*_tpSalvaged\s*\)\s*return/.test(onstop),
         'ITEM2: onstop does not stand down when the watchdog already salvaged the take, so the ' +
         'same recording is delivered twice.');
      ok(order(onstop, '_tpSalvaged', 'new Blob('),
         'ITEM2: onstop checks the salvage flag too late — it has already re-assembled and started ' +
         'delivering a take the watchdog handed over.');
    }
  }
}

/* ══ ITEM 3 — the byte floor (behavioural where it can be) ════════════════════ */
{
  const m = /const\s+TP_MIN_TAKE_BYTES\s*=\s*(\d+)\s*;/.exec(src);
  ok(m, 'ITEM3: TP_MIN_TAKE_BYTES is gone. Without a floor, a container header with no frames is ' +
        'truthy and counts as a take: "Filmed ✓" and a review card playing a black rectangle.');
  if (m) {
    const floor = Number(m[1]);
    // A header-only WebM/MP4 is a few hundred bytes. At 20 Mbps a real take is
    // hundreds of KB per second, so anything under a couple of KB is not a take.
    ok(floor >= 2048,
       `ITEM3: TP_MIN_TAKE_BYTES is ${floor}, which a header-only file of a few hundred bytes sails ` +
       'past. The person is told they filmed something and handed a black rectangle.');

    // tpReview's entry guard is small enough to lift and RUN.
    const head = decomment(src.slice(src.indexOf('\nfunction tpReview('), src.indexOf('\nfunction tpReview(') + 1200));
    const g = /if\s*\(([^)]*TP_MIN_TAKE_BYTES[^)]*)\)\s*return false;/.exec(head.slice(0, 900));
    ok(g, 'ITEM3: tpReview no longer refuses a take on size at its entry, so the review card opens ' +
          'over a video that shows black and will not play, with "Keep it" as its only exit.');
    if (g) {
      let guard;
      try { guard = new Function('blob', 'TP_MIN_TAKE_BYTES', 'return !!(' + g[1] + ');'); }
      catch (e) { fails.push('ITEM3: tpReview’s size guard does not compile on its own: ' + e.message); }
      if (guard) {
        const refuses = (size) => guard(size === null ? null : { size, type: 'video/webm' }, floor);
        ok(refuses(null), 'ITEM3: tpReview opens a review card when there is no blob at all.');
        ok(refuses(0), 'ITEM3: tpReview opens a review card on a take that recorded nothing.');
        ok(refuses(512),
           'ITEM3: tpReview accepts a 512-byte take. That is a container header with no frames — ' +
           'the review card plays a black rectangle and calls it the take they just performed.');
        ok(!refuses(940000),
           'ITEM3: tpReview now refuses a real take as well. This went too far: a take that filmed ' +
           'fine never gets its review card, so nobody can keep it.');
      }
    }
  }

  // The other three sites must weigh the blob, not merely ask whether it exists.
  const rec = fnSource('startTpRecord');
  if (rec) {
    const onstop = blockAfter(rec, 'tpMediaRecorder.onstop = async () =>');
    ok(onstop, 'ITEM3: startTpRecord no longer installs an onstop handler.');
    if (onstop) {
      ok((onstop.match(/blob\.size\s*[<>]=?\s*TP_MIN_TAKE_BYTES/g) || []).length >= 2,
         'ITEM3: startTpRecord.onstop is back to testing whether the blob is merely non-empty. A ' +
         'header-only file is non-empty, so it fires the "Filmed ✓" celebration and then offers ' +
         'the split screen over a take that does not exist.');
      ok(!/if\s*\(\s*!\s*blob\.size\s*\)/.test(onstop),
         'ITEM3: the bare `!blob.size` test is back in startTpRecord.onstop — it only catches an ' +
         'exactly zero-byte take and waves a header-only one through.');
    }
  }
  const close = fnSource('closeTeleprompter');
  if (close) {
    const onstop = blockAfter(close, 'tpMediaRecorder.onstop = async () =>');
    if (onstop) {
      ok(/blob\.size\s*<=\s*TP_MIN_TAKE_BYTES/.test(onstop),
         'ITEM3: the close-teleprompter onstop no longer weighs the take, so "Video shared!" is ' +
         'said over a file with no frames in it.');
      ok(!/if\s*\(\s*!\s*blob\.size\s*\)/.test(onstop),
         'ITEM3: the bare `!blob.size` test is back in the close-teleprompter onstop.');
    }
  }
}

/* ══ ITEM 4 — nothing dead-ends: tpCanDeliver first, tpRescueTake as the floor ══ */
{
  // BEHAVIOURAL: run tpCanDeliver together with the real _tpDownloadsInert.
  const inertSrc = fnSource('_tpDownloadsInert');
  const canSrc = fnSource('tpCanDeliver');
  ok(inertSrc, 'ITEM4: _tpDownloadsInert() is gone — nothing can tell whether a download on this ' +
               'device does anything at all.');
  ok(canSrc, 'ITEM4: tpCanDeliver() is gone. Without it the app cannot know, before it tears the ' +
             'screen down, that this browser has no way to hand over the file.');
  if (inertSrc && canSrc) {
    let canDeliver;
    try {
      canDeliver = new Function('navigator', 'document', 'window', 'File',
        inertSrc + '\n' + canSrc + '\nreturn tpCanDeliver;');
    } catch (e) {
      fails.push('ITEM4: tpCanDeliver does not compile in isolation: ' + e.message);
    }
    if (canDeliver) {
      const FileStub = function (parts, name, opts) { this.name = name; this.type = opts && opts.type; };
      const doc = { createElement: () => ({ download: '', href: '', click() {}, setAttribute() {} }) };
      const win = { matchMedia: () => ({ matches: false }) };
      const run = (nav, label) => {
        try { return canDeliver(nav, doc, win, FileStub)(FAKE_BLOB, 'take.webm'); }
        catch (e) { fails.push('ITEM4: tpCanDeliver threw on ' + label + ': ' + e.message); return null; }
      };
      const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1';
      const IG = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Instagram 302.0.0.23.109 (iPhone14,2; iOS 17_0)';
      const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';

      const share = { userAgent: IPHONE, standalone: false, share() {}, canShare: () => true };
      const desktop = { userAgent: DESKTOP };
      const igDead = { userAgent: IG, standalone: false };
      const igShares = { userAgent: IG, standalone: false, share() {}, canShare: () => true };

      ok(run(share, 'an iPhone with a file share sheet') === true,
         'ITEM4: a phone that has a working share sheet is being told it cannot deliver the take, ' +
         'so a perfectly normal iPhone gets shoved into the last-resort rescue screen after every take.');
      ok(run(desktop, 'desktop Chrome') === true,
         'ITEM4: desktop Chrome, where the download plainly works, is being told it cannot deliver ' +
         'the take — every desktop user now lands on the rescue screen instead of their Downloads.');
      ok(run(igDead, 'an Instagram in-app webview with no share sheet') === false,
         'ITEM4: an Instagram in-app browser — no share sheet, no download that does anything — is ' +
         'reported as able to deliver the take. That is exactly the dead end: the prompter closes, a ' +
         'toast says "use Share" with no Share button on screen, and the video is revoked two minutes later.');
      ok(run(igShares, 'an in-app webview whose share sheet does accept files') === true,
         'ITEM4: an in-app browser that CAN share files is being sent to the rescue screen anyway, ' +
         'making people long-press a video when one tap would have done it.');
    }
  }

  // STRUCTURAL: the check has to happen while the take is still reachable.
  const sos = fnSource('tpShareOrSave');
  ok(sos, 'ITEM4: tpShareOrSave() is gone.');
  if (sos) {
    ok(/tpCanDeliver\(/.test(sos),
       'ITEM4: tpShareOrSave never asks whether this device can take the file, so on an in-app ' +
       'browser it closes the prompter and the take is unreachable.');
    ok(order(sos, 'tpCanDeliver(', 'closeTeleprompter('),
       'ITEM4: tpShareOrSave tears the teleprompter down BEFORE it works out whether this device ' +
       'can receive the file. By the time it finds out there is nothing left holding the video.');
    const branch = blockAfter(sos, 'if (!tpCanDeliver(');
    ok(branch, 'ITEM4: the "this device cannot take the file" branch is gone from tpShareOrSave.');
    if (branch) {
      ok(/tpRescueTake\(/.test(branch),
         'ITEM4: the undeliverable branch does not put the video back on screen, so a finished take ' +
         'on an in-app browser ends as a toast and nothing else.');
      ok(/return\s*;/.test(branch),
         'ITEM4: the undeliverable branch falls through into the normal share path, so the rescue ' +
         'screen is immediately buried under a share that this browser cannot perform.');
    }
  }

  const dl = fnSource('tpDownloadBlob');
  ok(dl, 'ITEM4: tpDownloadBlob() is gone.');
  if (dl) {
    const inert = blockAfter(dl, 'if (_inert)');
    ok(inert, 'ITEM4: tpDownloadBlob no longer has a branch for a download that does nothing, so it ' +
              'says "Sent to your Downloads" on devices where nothing was written.');
    if (inert) ok(/tpRescueTake\(/.test(inert),
       'ITEM4: when the download is inert, tpDownloadBlob only shows a toast again. A toast is not a ' +
       'recovery — the take has to go back on screen where it can still be saved.');
  }

  const resc = fnSource('tpRescueTake');
  ok(resc, 'ITEM4: tpRescueTake() is gone, so there is no last resort at all — a take that cannot be ' +
           'shared or downloaded is simply lost.');
  if (resc) {
    ok(/createObjectURL\(\s*blob\s*\)/.test(resc) && /createElement\('video'\)/.test(resc),
       'ITEM4: the rescue screen no longer puts the actual video on screen, which is the only thing ' +
       'that makes it a rescue — press-and-hold is the one gesture that works in those webviews.');
    ok(!/setTimeout\([^)]*revokeObjectURL/.test(resc),
       'ITEM4: the rescue screen revokes the video on a timer again. That is the original bug: the ' +
       'recording becomes unreachable while it is still on the person’s screen.');
  }
}

/* ══ ITEM 5 — nothing may navigate the page while a take is in hand ═══════════ */
{
  // BEHAVIOURAL: run tpHoldTake / tpReleaseTake against stub timers.
  const holdSrc = fnSource('tpHoldTake');
  const relSrc = fnSource('tpReleaseTake');
  ok(holdSrc && relSrc,
     'ITEM5: tpHoldTake()/tpReleaseTake() are gone, so nothing knows a take is in memory and the ' +
     'upgrade modal is free to send the browser to Stripe and destroy it.');
  if (holdSrc && relSrc) {
    let api;
    try {
      api = new Function('window', 'setTimeout', 'clearTimeout',
        holdSrc + '\n' + relSrc + '\nreturn { hold: tpHoldTake, release: tpReleaseTake };');
    } catch (e) {
      fails.push('ITEM5: the hold/release pair does not compile in isolation: ' + e.message);
    }
    if (api) {
      const win = {};
      const timers = [];
      const cleared = [];
      const st = (fn, ms) => { timers.push({ fn, ms, id: timers.length + 1 }); return timers.length; };
      const ct = (id) => { cleared.push(id); };
      const { hold, release } = api(win, st, ct);

      hold();
      ok(win._tpBlobInHand === true,
         'ITEM5: tpHoldTake does not actually raise the flag, so the paywall modal still opens over ' +
         'a finished take and its Upgrade button navigates the recording away.');
      ok(timers.length === 1,
         'ITEM5: tpHoldTake sets no failsafe timer. A flag that gets stuck up silently disables the ' +
         'upgrade prompt for the rest of the session, so nobody can ever pay.');
      if (timers.length === 1) {
        ok(timers[0].ms >= 300000,
           `ITEM5: the failsafe releases the take after ${timers[0].ms}ms. That is short enough to fire ` +
           'while someone is still deciding what to do with their video, and then the upgrade modal ' +
           'opens over it after all.');
        timers[0].fn();
        ok(win._tpBlobInHand === false,
           'ITEM5: the failsafe timer fires without lowering the flag, so upgrade prompts stay ' +
           'suppressed forever and the person can never buy more posts.');
      }
      hold();
      release();
      ok(win._tpBlobInHand === false,
         'ITEM5: tpReleaseTake does not lower the flag. Once one take is delivered the paywall stays ' +
         'suppressed, so someone out of posts is told to "save this video first" with no video in hand.');
      ok(cleared.length > 0,
         'ITEM5: tpReleaseTake does not cancel the failsafe timer, so a stale timer can lower the flag ' +
         'in the middle of a LATER take and let the upgrade modal navigate that one away.');
    }
  }

  // BEHAVIOURAL: run the 402 branch of the global fetch wrapper.
  const at402 = src.indexOf('_resp.status === 402');
  ok(at402 !== -1, 'ITEM5: the global fetch wrapper no longer handles 402 at all.');
  if (at402 !== -1) {
    const body = blockAfter(src, '.json().then(function(d)', at402);
    ok(body, 'ITEM5: the 402 handler body could not be sliced out of the fetch wrapper.');
    if (body) {
      let run;
      try {
        run = new Function('d', 'window', 'showToast', 'showUpgrade', 'showFeatureLock',
          body.slice(1, -1));
      } catch (e) {
        fails.push('ITEM5: the 402 handler does not compile in isolation: ' + e.message);
      }
      if (run) {
        const fire = (held, error) => {
          const calls = { toast: 0, upgrade: 0, lock: 0 };
          run({ error, feature: 'splitScreen' }, { _tpBlobInHand: held },
              () => calls.toast++, () => calls.upgrade++, () => calls.lock++);
          return calls;
        };
        const heldLimit = fire(true, 'limit_reached');
        ok(heldLimit.upgrade === 0,
           'ITEM5: hitting the post limit while a filmed take is in hand still opens the upgrade ' +
           'modal. Its Upgrade button sets window.location.href to Stripe, the page dies, and the ' +
           'recording — which lives only in a closure — dies with it.');
        ok(heldLimit.toast > 0,
           'ITEM5: the upgrade modal is suppressed while a take is held and nothing is said instead, ' +
           'so the split screen just stops with no explanation.');

        const heldLock = fire(true, 'feature_locked');
        ok(heldLock.lock === 0,
           'ITEM5: a feature-locked 402 still opens the feature-lock modal over a held take, and ' +
           'that modal can navigate the page away and take the recording with it.');

        const freeLimit = fire(false, 'limit_reached');
        ok(freeLimit.upgrade === 1,
           'ITEM5: with no take in hand the post limit no longer opens the upgrade modal. The ' +
           'suppression has swallowed the paywall entirely — nobody is ever asked to upgrade.');

        const freeLock = fire(false, 'feature_locked');
        ok(freeLock.lock === 1,
           'ITEM5: with no take in hand a locked feature no longer explains itself — the request ' +
           'just fails quietly.');
      }
    }
  }

  // STRUCTURAL: the hold has to be taken at the two places a take is held in a closure,
  // and given back on each of the three ways it can leave.
  const review = decomment(src.slice(src.indexOf('\nfunction tpReview('), src.indexOf('\nfunction tpReview(') + 900));
  ok(/tpHoldTake\(\)/.test(review),
     'ITEM5: tpReview does not take the hold, so the paywall can open over the review card and ' +
     'navigate away the take being reviewed.');
  const offer = decomment(src.slice(src.indexOf('\nfunction tpOfferSplit('), src.indexOf('\nfunction tpOfferSplit(') + 400));
  ok(/tpHoldTake\(\)/.test(offer),
     'ITEM5: tpOfferSplit does not take the hold — and the split-screen build is the one path that ' +
     'fetches six stock photos and therefore the one most likely to hit the paywall mid-take.');

  const sos = fnSource('tpShareOrSave');
  if (sos) {
    const then = blockAfter(sos, '.then(() =>');
    ok(then && /tpReleaseTake\(\)/.test(then),
       'ITEM5: a successful share never gives the hold back, so upgrade prompts stay suppressed for ' +
       'the rest of the session and someone out of posts can never buy more.');
  }
  const dl = fnSource('tpDownloadBlob');
  if (dl) ok(/tpReleaseTake\(\)/.test(dl),
     'ITEM5: a successful download never gives the hold back, so upgrade prompts stay suppressed ' +
     'for the rest of the session.');
  const resc = fnSource('tpRescueTake');
  if (resc) {
    const closeBtn = blockAfter(resc, 'cb.onclick = function()');
    ok(closeBtn && /tpReleaseTake\(\)/.test(closeBtn),
       'ITEM5: dismissing the rescue screen never gives the hold back, so after the one case where ' +
       'delivery was hardest the paywall stays suppressed for good.');
  }
}

if (fails.length) {
  console.error('TAKE DELIVERY GATE FAILED (' + fails.length + '):');
  fails.forEach(f => console.error('  - ' + f));
  process.exit(1);
}
console.log('take delivery verified: guards released on retake, stop-watchdog salvage, ' +
            'byte floor honoured at all four sites, rescue path before teardown, paywall held ' +
            'off while a take is in memory');
console.log('PASS');
