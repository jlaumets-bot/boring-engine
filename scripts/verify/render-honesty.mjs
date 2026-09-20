#!/usr/bin/env node
// GATE: the split screen must be HONEST about what it hands back — v660's three
//       render-lifecycle fixes inside renderSplitScreen(): the muted-autoplay
//       retry, the non-finite duration, and releasing every track the render
//       opened.
//
// WHY THIS EXISTS
//   Content Shrimp builds the split screen entirely on the phone. There is no
//   server: a canvas, a MediaRecorder, and the person's own take playing through
//   a detached <video> element. That means every failure in here is silent by
//   construction — the app has nothing to compare the output against except
//   itself, and before v660 it was comparing itself to itself and passing.
//
//     1. A SILENT VIDEO, reported as ready to post.
//        vid.play() rejects when the user activation has expired. That is not an
//        edge case here: the tap that starts the build is followed by a beats
//        fetch and up to six photo fetches, so playback begins 20-60 seconds
//        after the gesture, and on engines that require an activation it is gone
//        by then. The old catch set vid.muted = true and played again. A muted
//        element captures a SILENT audio track — so the retry walked straight
//        around the "do not ship silence" guard twenty lines above it, which had
//        already run and which only counts tracks, never signal. The build then
//        finished normally: drift probe clean, `partial` false, "Your split
//        screen ✓ ready to post". The person posts a video of themselves talking
//        with no voice in it.
//
//     2. A VIDEO THAT STOPS A THIRD OF THE WAY THROUGH, reported as complete.
//        A MediaRecorder WebM blob has no Duration element, so vid.duration is
//        Infinity — on every device where isTypeSupported('video/mp4') is false,
//        which is not a rare device. The old fallback was beats.length * PER, at
//        most 6 * 3.25 = 19.5 seconds, and the frame loop exits on t >= dur. A
//        sixty-second take rendered nineteen and a half seconds and stopped
//        mid-sentence. BOTH honesty checks were blind to it: `partial` compares
//        dur against lastT, which equals dur on that path, and the drift probe
//        measures the output against lastT too, so drift read 0.
//
//     3. THE PAGE FILLING UP WITH LIVE TRACKS until the phone reaps the tab.
//        Neither the canvas capture track nor the audio track borrowed off the
//        <video> was ever stopped, on any path. A live track sourced from an
//        element keeps that detached <video> and its whole decode pipeline alive
//        after the object URL is revoked; a live canvas track keeps a 1440x2560
//        canvas reachable. "Try the split again" twice left three of each alive
//        for the life of the page. On a phone that is what gets the tab reaped —
//        and the tab is where the take lives, so it takes the recording with it.
//
// HOW IT CHECKS
//   One arm is BEHAVIOURAL, the rest are STRUCTURAL, and the reason is the shape
//   of the code rather than convenience:
//
//   BEHAVIOURAL — _spReleaseRender is a free function with no DOM dependency
//   beyond `srcObject`, so it is lifted out of app.html, compiled with
//   new Function, and RUN against stub streams whose tracks record their stop()
//   calls: both streams, a null cap, a getTracks() that throws, and a track whose
//   stop() throws.
//
//   STRUCTURAL — items 1 and 2 are lifecycle statements in the middle of one
//   ~320-line async function: an await, a catch, a flag, an event wait. They
//   close over a live MediaRecorder, a canvas capture stream and a decoding
//   <video>; there is no honest way to execute them from node. So those arms
//   SLICE renderSplitScreen out of app.html by brace matching, slice the specific
//   catch / if / try block out of THAT, and assert on relationships inside the
//   slice — never a bare includes() over the file. A check that passes because a
//   word appears in a comment two thousand lines away is not a check. Every
//   slice is decommented first, because the comments in this function quote the
//   very identifiers being ordered ("vid.muted", "new MediaRecorder(stream)",
//   "beats.length * PER" all appear in prose here), and an ordering assertion
//   satisfied by prose is a false green.
//
//   The brace matcher steps over strings, template literals and both comment
//   forms. It does NOT understand regex literals — a regex holding a brace or a
//   quote would break the slice — so ITEM 0 audits the sliced code and fails if
//   one is ever added.
//
//   Deliberately NOT duplicated here, because other gates already own them:
//     * scripts/verify/take-delivery.mjs — window._tpBlobInHand and the whole
//       paywall-vs-held-take hazard (tpHoldTake/tpReleaseTake, the 402 branch of
//       the fetch wrapper, tpOfferSplit taking the hold), plus take guards, the
//       stop watchdog, TP_MIN_TAKE_BYTES and the rescue path.
//     * scripts/verify/filming-fixes.mjs — renderSplitScreen's OWN drift-probe
//       URL revoke (FIX8) and the wake-lock re-acquire in onVis (FIX10), the
//       _spCancel checks after each await in tpOfferSplit (FIX11), tpEndTake's
//       camera teardown, the review Keep/Retake ordering, the no-review fallback
//       order in startTpRecord.onstop, the window.MediaRecorder guard and
//       tpRecordTap's record-engine takeover.
//   This gate covers only the three v660 render fixes above.
//
// RUN:    node scripts/verify/render-honesty.mjs [path-to-app.html]
// EXPECT: prints "PASS" and exits 0.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = process.argv[2] ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../app.html');
const src = fs.readFileSync(APP, 'utf8');

const fails = [];
import vm from 'node:vm';
const ok = (cond, msg) => { if (!cond) fails.push(msg); };

/* ── slicing app.html ────────────────────────────────────────────────────────
   Brace matching that steps over strings, template literals and comments, so a
   brace inside prose or inside 'video/mp4;codecs="avc1..."' cannot close a
   function early. REGEX LITERALS ARE NOT HANDLED: /}/ or /"/ would end the slice
   in the wrong place. ITEM 0 checks that none of the sliced code contains one. */
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

// Strip // and /* */ comments, leaving string literals intact. EVERY ordering
// assertion below runs on decommented text: this function's comments name
// vid.muted, new MediaRecorder(stream) and beats.length * PER in prose, often
// dozens of lines away from the code they describe.
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

// Whole source text of a top-level `function NAME(...) { ... }`, decommented.
function fnSource(name) {
  const re = new RegExp('(?:^|\\n)(?:async\\s+)?function\\s+' + name + '\\s*\\(', 'g');
  const m = re.exec(src);
  if (!m) return null;
  const paren = src.indexOf(')', m.index + m[0].length);
  const brace = src.indexOf('{', paren);
  const end = matchBrace(src, brace);
  return end < 0 ? null : decomment(src.slice(m.index, end + 1));
}

// The `{ ... }` block that follows `marker` inside `slice`.
function blockAfter(slice, marker, from = 0) {
  const at = slice.indexOf(marker, from);
  if (at === -1) return null;
  const brace = slice.indexOf('{', at + marker.length - 1);
  if (brace === -1) return null;
  const end = matchBrace(slice, brace);
  return end < 0 ? null : slice.slice(brace, end + 1);
}

// "a comes strictly before b inside slice", with both required to exist.
function order(slice, a, b) {
  const ia = slice.indexOf(a), ib = slice.indexOf(b);
  return ia !== -1 && ib !== -1 && ia < ib;
}

// Blank out string literals so a '/' inside 'video/mp4' is not mistaken for code.
function blankStrings(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += ' ';
      for (i++; i < s.length; i++) { if (s[i] === '\\') { i++; out += '  '; continue; } out += ' '; if (s[i] === q) break; }
      continue;
    }
    out += c;
  }
  return out;
}

// Every '/' left in code position must be a division: the previous non-space
// character must end an operand. A '/' after '=', '(', ',' or an operator would
// be the start of a regex literal, which the brace matcher above cannot survive.
function regexLiteralIn(slice) {
  const code = blankStrings(slice);
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== '/') continue;
    if (code[i + 1] === '=' ) continue;                       // /= is division-assign
    let j = i - 1;
    while (j >= 0 && /\s/.test(code[j])) j--;
    if (j < 0) return true;
    if (!/[\w$)\]]/.test(code[j])) return true;
  }
  return false;
}

/* ══ ITEM 0 — the slices exist and the matcher can be trusted on them ═══════ */
const render = fnSource('renderSplitScreen');
const release = fnSource('_spReleaseRender');
ok(render, 'ITEM0: renderSplitScreen() is not in app.html at all — the split screen cannot be ' +
           'built and nothing below this can be checked.');
ok(release, 'ITEM0: _spReleaseRender() is gone, so nothing stops the tracks the render opened: ' +
            'two more attempts at the split screen and the phone reaps the tab, taking the ' +
            'recording — which lives only in memory — with it.');
if (render) ok(!regexLiteralIn(render),
   'ITEM0: renderSplitScreen now contains a regex literal. The brace matcher this gate slices ' +
   'with does not understand them, so every structural assertion below may be reading the wrong ' +
   'region of the file and silently passing. Teach matchBrace about regex literals before ' +
   'trusting this gate again.');
if (release) ok(!regexLiteralIn(release),
   'ITEM0: _spReleaseRender now contains a regex literal — see ITEM0 above, the slice can no ' +
   'longer be trusted.');

/* Split renderSplitScreen into its success path and its outer catch, structurally:
   the first `try {` after the hoisted ref declaration, matched to its close. Doing
   it by brace matching rather than by searching for "catch (e)" means a reformat
   cannot quietly send an assertion to the wrong half. */
let successPath = null, outerCatch = null;
if (render) {
  const decl = render.indexOf('let _vid = null');
  const tryAt = decl === -1 ? -1 : render.indexOf('try {', decl);
  if (tryAt !== -1) {
    const tb = render.indexOf('{', tryAt);
    const te = matchBrace(render, tb);
    if (te > 0) {
      successPath = render.slice(tb, te + 1);
      const cAt = render.indexOf('catch', te);
      if (cAt !== -1) {
        const cb = render.indexOf('{', render.indexOf(')', cAt));
        const ce = matchBrace(render, cb);
        if (ce > 0) outerCatch = render.slice(cb, ce + 1);
      }
    }
  }
  ok(successPath && outerCatch,
     'ITEM0: renderSplitScreen no longer has the hoisted-refs + try/catch shape this gate slices ' +
     '(let _vid = null ... try { ... } catch). Either the failure path has been removed — in ' +
     'which case a failed render leaves the take playing out loud in a detached element forever — ' +
     'or the gate needs rewriting. Neither is safe to ignore.');
}

/* ══ ITEM 1 — the muted retry can no longer ship silence ════════════════════
   Structural: this is a catch around an await on vid.play(), closing over a live
   MediaRecorder and a decoding <video>. It cannot be run from node. */
if (render) {
  const playCatch = blockAfter(render, 'catch(playErr)');
  ok(playCatch,
     'ITEM1: the catch around vid.play() is gone from renderSplitScreen. Playback that fails ' +
     'because the user activation expired — which is the ORDINARY case here, 20-60 seconds of ' +
     'beats and photo fetches after the tap — now rejects straight out of the function with no ' +
     'retry at all, so the split screen simply never builds.');
  if (playCatch) {
    ok(/vid\.muted\s*=\s*false/.test(playCatch),
       'ITEM1: the playback retry no longer unmutes the element before trying again. Without ' +
       'vid.muted = false the retry is pointless, and the next thing to be added here is the ' +
       'muted retry that shipped a video of someone talking with no voice in it.');
    ok(!/vid\.muted\s*=\s*true/.test(playCatch) && !/muted\s*=\s*true/.test(playCatch),
       'ITEM1: THE MUTED RETRY IS BACK. Setting vid.muted = true makes playback succeed and makes ' +
       'the captured audio track carry silence. The "do not ship silence" guard above only counts ' +
       'tracks, so it has already passed; the drift probe compares durations; `partial` is false. ' +
       'The person is told "ready to post" and posts a video of themselves talking in silence.');
    ok(/throw\s/.test(playCatch),
       'ITEM1: the playback retry no longer throws when it fails. It falls through into the ' +
       'recorder instead, which is how a render with no sound gets built and delivered as if it ' +
       'were fine. Failing into the loud sheet — which already offers "Just save the plain ' +
       'video" — is the only honest exit.');
    // The throw must be the FAILURE path, not an unconditional one: there has to be a
    // second play() attempt, and the throw has to come after it.
    ok((playCatch.match(/vid\.play\(/g) || []).length >= 1 && order(playCatch, 'vid.play(', 'throw'),
       'ITEM1: the retry throws without ever attempting playback again, so a take that would have ' +
       'played perfectly well with the sound on is reported as unrenderable and the person loses ' +
       'the split screen for nothing.');
    // ...and the throw has to be REACHABLE. `if (!_played) { throw }` is pinned by name on
    // purpose: an unreachable throw (a condition quietly narrowed to never fire) leaves the
    // words in the file and the behaviour gone, which is the failure mode this whole gate is
    // about. Renaming the flag is fine — update this arm when you do.
    ok(/_played\s*=\s*true/.test(playCatch),
       'ITEM1: the retry no longer records whether the second play() actually succeeded, so ' +
       'nothing downstream can tell a take that played from one that did not.');
    const failBranch = blockAfter(playCatch, 'if (!_played)');
    ok(failBranch && /throw\s/.test(failBranch),
       'ITEM1: the retry\u2019s throw is no longer guarded by "the retry failed" \u2014 it is either ' +
       'unconditional (a take that plays fine never gets its split screen) or, far worse, ' +
       'unreachable, in which case playback that never started falls through into the recorder: ' +
       'six seconds of a stalled frame loop and then the wrong error, instead of the honest one ' +
       'that offers to save the plain video.');
  }

  /* The belt-and-braces guard. ORDER assertions, on decommented text. */
  const guardAt = render.indexOf('if (vid.muted)');
  ok(guardAt !== -1,
     'ITEM1: the `if (vid.muted)` guard before the recorder starts is gone. That guard is the only ' +
     'thing that catches a mute arriving by any route other than the retry — and a muted element ' +
     'means the audio track already sitting on the stream carries nothing, so the split screen ' +
     'comes out silent while every other check reports it fine.');
  if (guardAt !== -1) {
    const guardBlock = blockAfter(render, 'if (vid.muted)');
    ok(guardBlock && /throw\s/.test(guardBlock),
       'ITEM1: the `if (vid.muted)` guard no longer throws — it notices that the take can only be ' +
       'played silently and then records it anyway.');

    // rec.start() is the moment the silence becomes the file. Constructing the
    // MediaRecorder captures nothing; start() does. NOTE the shipped order is
    // construct -> play -> guard -> start, so `new MediaRecorder(` is deliberately
    // NOT the boundary asserted here — see the track-count arm below for the one
    // ordering that `new MediaRecorder(` really does govern.
    const startAt = render.indexOf('rec.start()');
    ok(startAt !== -1,
       'ITEM1: rec.start() is gone from renderSplitScreen — the recorder never starts, so the ' +
       'build hangs at 0% and no split screen is ever produced.');
    ok(startAt !== -1 && guardAt < startAt,
       'ITEM1: the `if (vid.muted)` guard now sits AFTER rec.start(). By the time it runs the ' +
       'recorder is already writing silence into the file, and throwing then throws away a render ' +
       'that is half done — or, if the throw is also gone, ships it. The guard only means ' +
       'anything before the recorder starts.');

    const catchAt = render.indexOf('catch(playErr)');
    ok(catchAt !== -1 && guardAt > catchAt,
       'ITEM1: the `if (vid.muted)` guard has been hoisted above the playback retry, so it inspects ' +
       'the element BEFORE the retry can mute it. That is exactly the blind spot the guard was ' +
       'added to close: it passes, the retry mutes, and the video comes out silent.');
  }

  // The ordering `new MediaRecorder(` genuinely does govern: tracks cannot be added
  // to a stream after the recorder is constructed, so the zero-audio-track refusal
  // has to happen before it or it is checking a stream nobody will record.
  ok(order(render, 'getAudioTracks', 'new MediaRecorder('),
     'ITEM1: the "do not ship silence" zero-audio-track refusal now runs after ' +
     'new MediaRecorder(stream). Tracks cannot be added to a stream once the recorder is ' +
     'constructed, so the check is either too late to matter or gone — and on an iPhone, where ' +
     'neither captureStream nor mozCaptureStream exists on <video>, no audio track is ever added ' +
     'and the split screen comes out silent.');
}

/* ══ ITEM 2 — a non-finite duration can no longer truncate the render ═══════
   Structural: this awaits a real `durationchange` event from a decoding element. */
if (render) {
  const iFinite = render.indexOf('isFinite(vid.duration)');
  const iWait   = render.indexOf('durationchange');
  const iFall   = render.indexOf('beats.length * PER');

  ok(iFinite !== -1,
     'ITEM2: renderSplitScreen no longer tests whether vid.duration is finite. For a take recorded ' +
     'as WebM the duration IS Infinity, and an Infinity dur makes the frame loop run until the ' +
     'watchdog kills it.');
  ok(iFall !== -1,
     'ITEM2: the beats.length * PER duration fallback is gone entirely. If the browser cannot ' +
     'report a duration there is now nothing at all to run the frame loop against.');
  ok(iWait !== -1,
     'ITEM2: the `durationchange` wait is gone. Without it a WebM take — every device where ' +
     "isTypeSupported('video/mp4') is false — falls straight to beats.length * PER, which is at " +
     'most 19.5 seconds. A sixty-second take renders nineteen seconds, stops mid-sentence, and ' +
     'BOTH honesty checks miss it: `partial` compares dur to lastT (equal on this path) and the ' +
     'drift probe measures against lastT too, so it reads zero drift and says "ready to post".');

  if (iFinite !== -1 && iWait !== -1 && iFall !== -1) {
    ok(iFinite < iWait,
       'ITEM2: the durationchange wait now runs before the isFinite(vid.duration) test, so every ' +
       'render — including the mp4 ones that report a duration immediately — pays a seek to the ' +
       'end of the clip and a four-second wait before it can start.');
    ok(iWait < iFall,
       'ITEM2: the beats.length * PER estimate is taken BEFORE the durationchange wait, so the ' +
       'wait can never change the outcome. That is the original bug with extra code around it: a ' +
       'sixty-second take still renders 19.5 seconds and still reports itself complete.');
  }

  // Measuring is worthless unless the result is USED. Scoped to the measuring block
  // (the first `if (!dur)`), not file-wide.
  const measureBlock = blockAfter(render, 'if (!dur)');
  ok(measureBlock && measureBlock.indexOf('durationchange') !== -1,
     'ITEM2: the first `if (!dur)` block is no longer the one that waits for durationchange, so ' +
     'this gate can no longer tell whether the take is measured before it is guessed at.');
  if (measureBlock && measureBlock.indexOf('durationchange') !== -1) {
    ok(/dur\s*=\s*vid\.duration/.test(measureBlock),
       'ITEM2: the render seeks to the end of the clip, waits for the browser to work out the real ' +
       'duration \u2014 and then never assigns it to dur. The measurement is decoration: every WebM ' +
       'take still falls through to the beats.length * PER estimate, so a sixty-second take still ' +
       'renders 19.5 seconds and still reports itself complete.');
  }

  // The seek is what forces the browser to compute the duration, and the playhead
  // has to come back or the frame loop starts at the end of the clip.
  ok(/vid\.currentTime\s*=\s*1e\d+/.test(render) || /vid\.currentTime\s*=\s*\d{7,}/.test(render),
     'ITEM2: nothing seeks to a huge currentTime any more, so the browser is never forced to ' +
     'compute the real duration of a stream-recorded blob and the durationchange event never ' +
     'fires. The render falls back to the 19.5-second estimate and truncates the take.');
  ok(/vid\.currentTime\s*=\s*0/.test(render),
     'ITEM2: the playhead is never restored after the seek that measures the take, so the render ' +
     'starts at the END of the clip and produces an empty or near-empty video.');

  // The estimate must announce itself. Scoped to the block that takes it, not file-wide.
  if (iFall !== -1) {
    const ifAt = render.lastIndexOf('if (!dur)', iFall);
    const fbBlock = ifAt === -1 ? null : blockAfter(render, 'if (!dur)', ifAt);
    ok(fbBlock && fbBlock.indexOf('beats.length * PER') !== -1,
       'ITEM2: the beats.length * PER fallback is no longer inside a guarded block, so it can ' +
       'overwrite a duration the browser reported correctly and truncate a take that was measured ' +
       'perfectly well.');
    if (fbBlock) ok(/_spDurEstimated\s*=\s*true/.test(fbBlock),
       'ITEM2: the render falls back to guessing the length of the take and does not set ' +
       '_spDurEstimated, so nothing on the result sheet says so. The person is shown a video that ' +
       'may stop a third of the way through their take and told it is ready to post.');
  }
  /* v687 — AND IT MUST BE READ. Setting the flag was the whole of this check for four versions,
     and the flag was written TWICE and read NOWHERE, so the sentence above described a warning the
     person could never see. A presence check on a write-only variable is worse than no check: it
     reports the bug as fixed. Assert the reader, in the function that builds the result sheet. */
  {
    const offer = fnSource('tpOfferSplit');
    /* RUN IT, don't match it. A textual check here is what let the original bug ship: the flag
       was written twice, read nowhere, and every pattern that mentioned its NAME passed. So lift
       the two real declarations and execute them with the flag set, and require a warning to come
       out the other side. `false && window._spDurEstimated` passes a regex; it fails this. */
    const encDecl  = (offer.match(/const _encMsg = [\s\S]*?;\n/) || [])[0] || '';
    const estDecl  = (offer.match(/const _estMsg = [\s\S]*?;\n/) || [])[0];
    const totDecl  = (offer.match(/const _tot = [\s\S]*?;\n/) || [])[0] || '';
    const lowDecl  = (offer.match(/const _lowMatch = [\s\S]*?;\n/) || [])[0] || '';
    const missDecl = (offer.match(/const _miss = [\s\S]*?;\n/) || [])[0] || '';
    const whyDecl  = (offer.match(/const _why = [\s\S]*?;\n/) || [])[0] || '';
    const photoDecl = (offer.match(/const _photoMsg = [\s\S]*?;\n/) || [])[0] || '';
    const warnDecl = (offer.match(/const _warn = [\s\S]*?;\n/) || [])[0];
    ok(!!estDecl && !!warnDecl, 'ITEM2: could not find the _estMsg / _warn declarations — re-anchor this arm.');
    if (estDecl && warnDecl) {
      const run = (flag, out, beats) => {
        // `const` inside runInContext does not leak onto the context object, so end the script
        // with the expression itself and take runInContext's return value.
        const b = beats || { total: 4, matched: 4 };
        const ctx = { window: { _spDurEstimated: flag, _tpBeatTotal: b.total, _tpBeatMatched: b.matched,
                                _spPhotoMisses: b.misses || 0, _spPhotoWhy: b.why || '' }, out, String, RegExp };
        vm.createContext(ctx);
        return vm.runInContext(encDecl + estDecl + totDecl + lowDecl + missDecl + whyDecl + photoDecl + warnDecl + '\n_warn', ctx);
      };
      const clean = { partial: false, drift: 0, estSec: 19.5 };
      const guessed = run(true, clean);
      ok(typeof guessed === 'string' && guessed.length > 0,
         'ITEM2: with window._spDurEstimated true the result sheet shows NO warning (got ' +
         JSON.stringify(guessed) + '). The render guessed the length of the take, so the video may ' +
         'stop a fraction of the way through it and the person is told it is ready to post.');
      ok(typeof guessed === 'string' && /19.5|guess/i.test(guessed),
         'ITEM2: the warning does not say what was guessed, so the person cannot tell whether their ' +
         'take was longer than that: ' + JSON.stringify(guessed));
      const measured = run(false, clean);
      ok(measured === '',
         'ITEM2: a render whose duration WAS measured still warns (' + JSON.stringify(measured) +
         '). A warning on every render is a warning nobody reads.');
      /* v688 — the match count only became a true statement in v688: before it, every cue matched
         against the SCRIPT whether or not the phone had heard that part, so the number was always
         high and meant nothing. Now a low count is real information and has to be readable. */
      const low = run(false, { partial: false, drift: 0 }, { total: 4, matched: 1 });
      ok(typeof low === 'string' && /1 of 4|cues/.test(low),
         'ITEM2: a run where the phone caught only 1 of 4 cues shows no warning (' + JSON.stringify(low) +
         '). The graphics are then spaced evenly rather than following the words, and only an 11px ' +
         'grey "matched 1/4" says so.');
      const fine = run(false, { partial: false, drift: 0 }, { total: 4, matched: 4 });
      ok(fine === '', 'ITEM2: a run that matched every cue must not warn (' + JSON.stringify(fine) + ')');
      /* v688 — a beat with no picture used to be indistinguishable from a beat that never wanted
         one: missing key, revoked key, 429, timeout, no match and 402 all hit the same bare
         `return`, while the sheet promised "free stock, recoloured to your brand". */
      const quota = run(false, { partial: false, drift: 0 }, { total: 4, matched: 4, misses: 4, why: 'http_429' });
      ok(typeof quota === 'string' && /rated out/i.test(quota),
         'ITEM2: four cards came back with no picture because the photo service was rated out, and ' +
         'the sheet says nothing (' + JSON.stringify(quota) + ')');
      const slow = run(false, { partial: false, drift: 0 }, { total: 4, matched: 4, misses: 3, why: 'timeout' });
      ok(typeof slow === 'string' && /did not answer in time/i.test(slow) && !/rated out/i.test(slow),
         'ITEM2: a photo timeout is not reported as a quota problem — the two need different advice: ' +
         JSON.stringify(slow));
      const onePlain = run(false, { partial: false, drift: 0 }, { total: 4, matched: 4, misses: 1, why: 'no_match' });
      ok(onePlain === '',
         'ITEM2: ONE beat with no matching stock photo is normal and must not raise a warning (' +
         JSON.stringify(onePlain) + '). Warning on every render is how a warning stops being read.');
      /* v689 — rec.onerror was never assigned, so a failed encode produced a file missing most of
         its content while `partial` stayed false (the frame loop still read currentTime to the
         end) and only the drift probe spoke up — calling it a "timing wobble". */
      const enc = run(false, { partial: false, drift: 2.2, recFailed: 'UnknownError' });
      ok(typeof enc === 'string' && /encoder/i.test(enc),
         'ITEM2: the encoder failed mid-record and the sheet does not say so (' + JSON.stringify(enc) +
         '). A file missing most of its content must not be described as a timing wobble.');
      const noEnc = run(false, { partial: false, drift: 0, recFailed: '' });
      ok(noEnc === '', 'ITEM2: a clean render must not mention the encoder (' + JSON.stringify(noEnc) + ')');
      const wobbly = run(true, { partial: false, drift: 2.2, estSec: 19.5 });
      ok(typeof wobbly === 'string' && /guess/i.test(wobbly),
         'ITEM2: when the length was guessed AND the phone reported drift, the drift text wins and ' +
         'the truncation goes unmentioned. Truncation is the worse of the two: ' + JSON.stringify(wobbly));
    }
    // The chain may grow at the FRONT (v689 put the encoder failure ahead of it, because a file
    // missing its content outranks a truncated one) — what matters is that _estMsg comes before
    // the drift text, not that it is literally first.
    const chain = (offer.match(/const _warn = [\s\S]*?;\n/) || [''])[0];
    const usesIt = /_estMsg/.test(offer) && /_estMsg\s*\|\|/.test(chain) &&
                   chain.indexOf('_estMsg') < chain.indexOf('timing wobble');
    ok(usesIt,
       'ITEM2: the estimated-duration message is not the FIRST warning on the sheet. A truncated ' +
       'video is worse than a wobbly one, so it must win over the drift text rather than be ' +
       'appended after it or dropped when drift is also set.');
  }
  // _spDurEstimated is a window flag that outlives the render, so it has to be cleared
  // on the measured path AND NOWHERE ELSE. Cleared unconditionally after the if/else it
  // wipes the warning it just raised — the file still contains both assignments and the
  // person is still shown a truncated video described as complete. So: the clear must be
  // the `else` arm of the fallback, and there must be exactly one of it.
  if (iFall !== -1) {
    const ifAt2 = render.lastIndexOf('if (!dur)', iFall);
    const fbOpen = ifAt2 === -1 ? -1 : render.indexOf('{', ifAt2);
    const fbClose = fbOpen === -1 ? -1 : matchBrace(render, fbOpen);
    const clears = (render.match(/_spDurEstimated\s*=\s*false/g) || []).length;
    ok(clears === 1,
       `ITEM2: _spDurEstimated is cleared in ${clears} places. It has to be cleared on exactly one ` +
       'path — the one where the duration was actually measured. More than one and a render that ' +
       'guessed the length of the take clears its own warning; none and every later render in the ' +
       'session is labelled a guess, which is a warning nobody reads.');
    const elseBlock = fbClose > 0 ? blockAfter(render, 'else', fbClose) : null;
    ok(fbClose > 0 && /^\s*else\s*\{/.test(render.slice(fbClose + 1, fbClose + 40)) &&
       elseBlock && /_spDurEstimated\s*=\s*false/.test(elseBlock),
       'ITEM2: _spDurEstimated is no longer cleared in the `else` arm of the fallback. Clearing it ' +
       'anywhere else — a line after the if/else, say — runs on BOTH paths and wipes the warning ' +
       'the fallback just raised, so a take that was guessed at is shown as a complete render ' +
       'again. That is bug 2 with the fix still visibly in the file.');
  }
}

/* ══ ITEM 3 — every track the render opened is stopped ══════════════════════ */
if (render && successPath && outerCatch) {
  ok(/_spReleaseRender\(/.test(successPath),
     'ITEM3: the successful render never releases its tracks. The canvas capture track keeps a ' +
     '1440x2560 canvas reachable and the audio track borrowed off the <video> keeps that detached ' +
     'element and its decode pipeline alive — two more splits and the phone reaps the tab, which ' +
     'is where the only copy of the take lives.');
  ok(order(successPath, '_spReleaseRender(', 'resolve('),
     'ITEM3: the tracks are released after (or instead of) resolving, so the caller is already ' +
     'away with the blob while the render still holds the camera-side plumbing open.');
  ok(/_spReleaseRender\(/.test(outerCatch),
     'ITEM3: the FAILURE path never releases its tracks. A failed or cancelled render is precisely ' +
     'when someone taps "Try the split again", so this is the path that stacks live tracks up — ' +
     'three canvases and three decode pipelines after two retries, on the device least able to ' +
     'afford them.');
  // The catch cannot see the locals; it must use the hoisted refs, or the call
  // throws ReferenceError into a swallowing try and releases nothing at all.
  ok(/_spReleaseRender\(\s*_stream\s*,\s*_capRef\s*,\s*_vid\s*\)/.test(outerCatch),
     'ITEM3: the catch calls _spReleaseRender with names that are not in scope there (the stream ' +
     'and capture locals live inside the try). The call throws ReferenceError into the surrounding ' +
     'try/catch, which swallows it, so the failure path looks like it releases the tracks and ' +
     'releases nothing.');
  ok(/let\s+_vid\s*=\s*null[^;]*_stream\s*=\s*null[^;]*_capRef\s*=\s*null/.test(render),
     'ITEM3: _stream and _capRef are no longer hoisted alongside _vid, so the catch path has ' +
     'nothing to release — the tracks leak on exactly the path people retry from.');
  ok(/_stream\s*=\s*stream/.test(successPath),
     'ITEM3: the canvas capture stream is never recorded into the hoisted ref, so a failed render ' +
     'leaves the canvas capture track running for the life of the page.');
  ok(/_capRef\s*=\s*_cap/.test(successPath),
     'ITEM3: the <video> capture stream is never recorded into the hoisted ref, so a failed render ' +
     'leaves the take decoding in a detached element for the life of the page.');
}

/* ══ ITEM 3b — BEHAVIOURAL: lift _spReleaseRender out and run it ════════════ */
if (release) {
  let fn = null;
  try { fn = new Function(release + '\nreturn _spReleaseRender;')(); }
  catch (e) { fails.push('ITEM3b: _spReleaseRender does not compile on its own: ' + e.message); }

  if (fn) {
    const track = (name) => ({ name, stopped: 0, stop() { this.stopped++; } });
    const streamOf = (...ts) => ({ getTracks: () => ts });

    // Normal path: canvas stream + element capture stream + the element itself.
    {
      const a = track('canvas'), b = track('canvas2'), c = track('audio-from-video');
      const vid = { srcObject: streamOf(c) };
      try { fn(streamOf(a, b), streamOf(c), vid); }
      catch (e) { fails.push('ITEM3b: _spReleaseRender threw on the ordinary case: ' + e.message); }
      ok(a.stopped === 1 && b.stopped === 1,
         'ITEM3b: _spReleaseRender leaves the canvas capture tracks running. A live canvas track ' +
         'keeps a 1440x2560 canvas reachable for the life of the page, and two more splits is ' +
         'what gets the tab reaped with the take inside it.');
      ok(c.stopped === 1,
         'ITEM3b: _spReleaseRender stops the canvas stream but NOT the capture stream taken off ' +
         'the <video>. That is the one that keeps the whole video decode pipeline and the detached ' +
         'element alive after the object URL is revoked — the heaviest thing the render holds.');
      ok(vid.srcObject === null,
         'ITEM3b: _spReleaseRender never clears vid.srcObject, so the element keeps a reference to ' +
         'the stream and the browser keeps the element, even with every track stopped.');
    }

    // cap is null on any browser without captureStream on <video> — Safari, for one.
    {
      const a = track('canvas');
      const vid = { srcObject: {} };
      try { fn(streamOf(a), null, vid); }
      catch (e) { fails.push('ITEM3b: _spReleaseRender threw when there was no <video> capture ' +
                             'stream (which is every Safari): ' + e.message); }
      ok(a.stopped === 1,
         'ITEM3b: with no <video> capture stream to release, _spReleaseRender gives up before ' +
         'stopping the canvas stream either — so on Safari the render leaks everything.');
      ok(vid.srcObject === null,
         'ITEM3b: with no <video> capture stream, vid.srcObject is left set.');
    }

    // A dead stream can throw from getTracks(); cleanup must not be what fails.
    {
      const a = track('canvas');
      const hostile = { get getTracks() { throw new Error('stream is dead'); } };
      const vid = { srcObject: {} };
      let threw = null;
      try { fn(hostile, streamOf(a), vid); } catch (e) { threw = e; }
      ok(!threw,
         'ITEM3b: _spReleaseRender propagates an error out of a dead stream. It is called from the ' +
         'outer catch, so a throw here replaces the real failure with a cleanup error and the ' +
         'person is shown the wrong reason their split screen did not build.');
      ok(a.stopped === 1,
         'ITEM3b: one unusable stream stops _spReleaseRender from releasing the other, so the ' +
         'tracks that CAN be stopped are left running.');
      ok(vid.srcObject === null,
         'ITEM3b: one unusable stream stops _spReleaseRender from clearing vid.srcObject.');
    }

    // One track refusing to stop must not shield the rest.
    {
      const bad = { stop() { throw new Error('track already ended'); } };
      const good = track('canvas');
      const vid = { srcObject: {} };
      let threw = null;
      try { fn({ getTracks: () => [bad, good] }, null, vid); } catch (e) { threw = e; }
      ok(!threw, 'ITEM3b: a track whose stop() throws takes _spReleaseRender down with it.');
      ok(good.stopped === 1,
         'ITEM3b: a track that refuses to stop stops every track after it in the list from being ' +
         'released — so one stale track leaks the whole render.');
      ok(vid.srcObject === null,
         'ITEM3b: a track that refuses to stop leaves vid.srcObject set.');
    }

    // No arguments at all (defensive: the catch path can be reached before either ref is set).
    {
      let threw = null;
      try { fn(null, null, null); } catch (e) { threw = e; }
      ok(!threw,
         'ITEM3b: _spReleaseRender throws when called before the render opened anything. The outer ' +
         'catch reaches it on an early failure — "no graphics track came back" fires before the ' +
         'stream exists — and a throw there buries the real error.');
    }
  }
}

if (fails.length) {
  console.error('RENDER HONESTY GATE FAILED (' + fails.length + '):');
  fails.forEach(f => console.error('  - ' + f));
  process.exit(1);
}
console.log('render honesty verified: the muted retry unmutes and throws instead of shipping ' +
            'silence, the real duration is measured before any estimate is taken and the estimate ' +
            'announces itself, and every track the render opened is stopped on both the success ' +
            'and the failure path');
console.log('PASS');
