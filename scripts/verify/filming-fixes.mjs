// Oracle for the FILMING-path fixes in app.html (blur lifetime, record engine,
// blob leak, MediaRecorder guard, wake lock, cancel checks).
// Usage: node scripts/verify/filming-fixes.mjs [path-to-app.html]
// Exits 0 and prints PASS only when every fix is structurally present.
import fs from 'fs';
import path from 'path';

const file = process.argv[2] || path.join(process.cwd(), 'app.html');
const src = fs.readFileSync(file, 'utf8');
const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };

// Top-level function declarations in app.html all start at column 0, so the next
// "\nfunction " is a reliable end-of-body delimiter — no brace matching needed.
const DECL = /\n(?:async )?function ([A-Za-z_$][\w$]*)\s*\(/g;
function body(name) {
  DECL.lastIndex = 0;
  let start = -1, end = src.length, m;
  while ((m = DECL.exec(src))) {
    if (start !== -1) { end = m.index; break; }
    if (m[1] === name) start = m.index;
  }
  return start === -1 ? null : src.slice(start, end);
}

/* ── FIX 1: the take ENDS — blur pump + camera released before the render ───── */
const endTake = body('tpEndTake');
ok(endTake, 'FIX1: tpEndTake() is not defined');
if (endTake) {
  ok(/tpBlur\.stop\(\)/.test(endTake), 'FIX1: tpEndTake does not stop the blur pump (tpBlur.stop)');
  ok(/tpCameraStream\.getTracks\(\)\.forEach\(\s*t\s*=>\s*t\.stop\(\)\s*\)/.test(endTake),
     'FIX1: tpEndTake does not stop the camera/mic tracks');
  ok(/tpCameraStream\s*=\s*null/.test(endTake), 'FIX1: tpEndTake does not clear tpCameraStream');
}

const review = body('tpReview');
ok(review, 'FIX1: tpReview() not found');
if (review) {
  const keep = review.indexOf("getElementById('tpRvKeep').onclick");
  const again = review.indexOf("getElementById('tpRvAgain').onclick");
  ok(keep !== -1 && again !== -1, 'FIX1: tpReview Keep/Retake handlers not found');
  if (keep !== -1 && again !== -1) {
    const keepBlock = review.slice(keep, again);
    const againBlock = review.slice(again);
    const et = keepBlock.indexOf('tpEndTake()');
    const off = keepBlock.indexOf('tpOfferSplit(');
    ok(et !== -1, 'FIX1: the review "Keep it" handler does not call tpEndTake() — the blur pump survives into the render');
    ok(et !== -1 && off !== -1 && et < off, 'FIX1: tpEndTake() must run BEFORE tpOfferSplit() in the Keep handler');
    // Retake reuses the live camera — tearing it down there would break the retake.
    ok(!/tpEndTake\s*\(/.test(againBlock), 'FIX1: the Retake handler must NOT call tpEndTake() (retake needs the camera)');
  }
}

const startRec = body('startTpRecord');
ok(startRec, 'FIX1/FIX9: startTpRecord() not found');
if (startRec) {
  const iRev = startRec.indexOf('tpReview(blob, fname)');
  const iEnd = startRec.indexOf('tpEndTake');
  const iOff = startRec.indexOf('tpOfferSplit(blob, fname)');
  ok(iRev !== -1 && iEnd !== -1 && iOff !== -1 && iRev < iEnd && iEnd < iOff,
     'FIX1: the no-review fallback in startTpRecord.onstop must call tpEndTake() between tpReview and tpOfferSplit');

  /* ── FIX 9: MediaRecorder referenced outside its guard ───────────────────── */
  const iGuard = startRec.indexOf('if (!window.MediaRecorder)');
  const iSupp = startRec.indexOf('MediaRecorder.isTypeSupported');
  ok(iGuard !== -1, 'FIX9: startTpRecord has no `if (!window.MediaRecorder)` guard');
  ok(iGuard !== -1 && iSupp !== -1 && iGuard < iSupp,
     'FIX9: MediaRecorder.isTypeSupported is still reached before the window.MediaRecorder guard');
}

/* ── FIX 2: a preview ▶ must not disable the recording engine ───────────────── */
const recTap = body('tpRecordTap');
ok(recTap, 'FIX2: tpRecordTap() not found');
if (recTap) {
  ok(!/if\s*\(\s*!\s*tpScrolling\s*\)\s*tpStartRecordingScroll/.test(recTap),
     'FIX2: tpStartRecordingScroll is still behind `if (!tpScrolling)` — a left-running preview scroll skips the whole recording engine');
  ok(/\btpStartRecordingScroll\(\)\s*;/.test(recTap),
     'FIX2: tpRecordTap no longer calls tpStartRecordingScroll()');
  const iStop = recTap.indexOf('stopTpScroll()');
  const iStart = recTap.indexOf('tpStartRecordingScroll()');
  ok(iStop !== -1, 'FIX2: tpRecordTap does not stop a running preview scroll before taking over');
  ok(iStop !== -1 && iStart !== -1 && iStop < iStart,
     'FIX2: stopTpScroll() must run BEFORE tpStartRecordingScroll() (it clears the lead-in padding + scroll-behavior)');
  // stopTpScroll clears .tp-script padding, so it must also precede the padding write.
  const iPad = recTap.indexOf('paddingTop');
  ok(iPad === -1 || iStop < iPad, 'FIX2: stopTpScroll() must run BEFORE the lead-in padding is written, or it wipes it');
}

/* ── FIX 8 + FIX 10: inside renderSplitScreen ──────────────────────────────── */
const render = body('renderSplitScreen');
ok(render, 'FIX8/FIX10: renderSplitScreen() not found');
if (render) {
  // FIX 8 — blob URL must be revoked on the onerror AND the timeout paths.
  ok(!/probe\.onerror\s*=\s*\(\)\s*=>\s*r\(0\)/.test(render),
     'FIX8: probe.onerror still resolves without revoking the object URL');
  const revokes = (render.match(/revokeObjectURL\(_probeUrl\)/g) || []).length;
  ok(revokes >= 2,
     `FIX8: expected the drift probe URL to be revoked on both the settle and the timeout path (found ${revokes} revokeObjectURL(_probeUrl))`);
  ok(/_probeUrl\s*=\s*URL\.createObjectURL\(blob\)/.test(render),
     'FIX8: the drift probe URL is no longer captured in _probeUrl, so the timeout path cannot revoke it');

  // FIX 10 — the wake lock must be re-acquired when the document becomes visible.
  const iVis = render.indexOf('const onVis');
  const iCleanup = render.indexOf('const cleanupVis');
  ok(iVis !== -1 && iCleanup !== -1, 'FIX10: onVis/cleanupVis not found in renderSplitScreen');
  if (iVis !== -1 && iCleanup !== -1) {
    const visBlock = render.slice(iVis, iCleanup);
    ok(/wakeLock\.request\('screen'\)/.test(visBlock),
       'FIX10: onVis does not re-request the screen wake lock — the platform releases it whenever the document is hidden');
    ok(/_visLive/.test(visBlock), 'FIX10: the wake-lock re-request has no _visLive guard against the finish()/release() race');
    ok(/_visLive\s*=\s*false/.test(render.slice(iCleanup)), 'FIX10: cleanupVis does not clear _visLive');
  }
}

/* ── FIX 11: cancel must be honoured after every await in _spGo ─────────────── */
const offer = body('tpOfferSplit');
ok(offer, 'FIX11: tpOfferSplit() not found');
if (offer) {
  const iGo = offer.indexOf('const _spGo');
  ok(iGo !== -1, 'FIX11: _spGo not found');
  if (iGo !== -1) {
    const go = offer.slice(iGo);
    const iBeats = go.indexOf('await beatsForIdea(id)');
    const iPhotos = go.indexOf('await spFetchBeatPhotos(beats)');
    const iRender = go.indexOf('await renderSplitScreen(');
    const iResult = go.indexOf('tpSplitResult(');
    const cancelAfter = (from, to, label) => {
      if (from === -1 || to === -1) { fails.push('FIX11: could not locate ' + label); return; }
      ok(/if\s*\(\s*window\._spCancel\s*\)/.test(go.slice(from, to)),
         'FIX11: no window._spCancel check after ' + label);
    };
    cancelAfter(iBeats, iPhotos === -1 ? iRender : iPhotos, 'the beatsForIdea await');
    if (iPhotos !== -1) cancelAfter(iPhotos, iRender, 'the spFetchBeatPhotos await');
    cancelAfter(iRender, iResult, 'the renderSplitScreen await');
  }
}

if (fails.length) {
  console.error('FILMING FIXES FAILED:');
  fails.forEach(f => console.error('  - ' + f));
  process.exit(1);
}
console.log('filming fixes verified: blur/camera end-of-take, record-engine takeover, drift-probe revoke, MediaRecorder guard, wake-lock re-acquire, cancel checks');
console.log('PASS');
