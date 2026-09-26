#!/usr/bin/env node
// GATE (v690 review, front 3): the split-screen RENDER, executed — memory is bounded, a phone that
//       will not report the take's length still renders the whole take, and an empty file never
//       ships.
//
// WHY THIS EXISTS
//   1. The render wrote its output at a fixed 20 Mbps whatever the length. The take is also
//      recorded at 20 Mbps, so a three-minute take held ~450 MB of footage plus ~450 MB of render at
//      once — the 858 MB peak measured on a 180 s take, which is what gets a phone tab reaped (and
//      the take lives only in that tab).
//   2. When the phone would not report the take's length, the render guessed beats x 3.25 s (at most
//      19.5 s) and stopped there, so a three-minute take came out 19.5 s long. v687 made the sheet
//      admit it; it was still cut. The wall-clock take length was already known.
//   3. Stock photos were decoded at full size (large2x, ~1880 px) six at once and kept for the
//      session, though the photo band is never drawn larger than 1440 x 1112 px.
//   4. (v687, re-proven here by execution) a header-only output must be refused, with the wake lock
//      and every track released before the rejection.
//
// HOW IT CHECKS
//   It RUNS the real renderSplitScreen, lifted from app.html, against a fake <video>, canvas,
//   MediaRecorder and wake lock that behave like a phone's: frames advance, the recorder emits the
//   bytes we choose, the duration is reported or withheld. And it runs the real spFetchBeatPhotos /
//   spDecodePhoto against a fake network and a fake createImageBitmap. Every arm has its opposite.
//
// RUN:    node scripts/verify/rv-front-3.mjs      (takes ~5 s: the real 4 s "measuring the take" wait)
// EXPECT: prints "PASS" and exits 0.
import fs from 'node:fs'; import vm from 'node:vm';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
setTimeout(() => { console.log('FAIL: wall clock (90s) exceeded'); process.exit(2); }, 90000).unref();
let fail = 0; const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fail++; } else console.log('ok:', m); };
const grab = n => {
  let i = html.indexOf('\nfunction ' + n + '('); if (i < 0) i = html.indexOf('\nasync function ' + n + '(');
  if (i < 0) throw new Error('no function ' + n + ' in app.html — re-anchor this gate');
  return html.slice(i + 1, html.indexOf('\n}', i) + 2);
};
const constLine = (name) => { const m = new RegExp('^const ' + name + ' = [^\\n]*$', 'm').exec(html);
  if (!m) throw new Error('no const ' + name); return m[0].replace(/^const /, 'var '); };

function renderWorld({ realLen = 10, reportDuration = true, outBytes = 50000, takeSecs, beats = 3,
                      endAt, holdAt = Infinity, manualWatch = false } = {}) {
  // endAt: where the stream REALLY ends (defaults to the reported length). holdAt: frames stop
  // advancing there until rec.holdAt is raised. manualWatch: the test drives the render watchdog.
  const END = (endAt == null) ? realLen : endAt;
  const rec = { opts: [], painted: [], stops: 0, wlReleased: 0, holdAt, vid: null, watch: null, vis: null };
  const track = (kind) => ({ kind, stop() { rec.stops++; } });
  const audio = track('audio');
  let videos = 0;
  const mkVideo = () => {
    videos++;
    if (videos > 1) {   // the drift probe
      const p = { preload: '', duration: NaN };
      Object.defineProperty(p, 'src', { set() { setTimeout(() => { p.duration = END; p.onloadedmetadata && p.onloadedmetadata(); }, 0); } });
      return p;
    }
    const v = { readyState: 1, duration: reportDuration ? realLen : Infinity, currentTime: 0, ended: false,
      muted: false, volume: 1, playsInline: false, videoWidth: 0, src: '',
      paused: true,
      play() { v.paused = false; if (v._waiting) { const w = v._waiting; v._waiting = null; setTimeout(w, 0); } return Promise.resolve(); },
      pause() { v.paused = true; },
      captureStream() { return { getAudioTracks: () => [audio], getTracks: () => [audio] }; },
      // Like Chromium: after the LAST frame there is no further frame callback — the element just
      // reports ended. (A fake that kept calling back hid the 6 s stall-watchdog ending.)
      // A paused element delivers no frames; a held one waits for the test to let it go on.
      requestVideoFrameCallback(cb) { const tick = () => {
        if (v.paused) { v._waiting = tick; return; }
        if (v.currentTime >= rec.holdAt) { setTimeout(tick, 5); return; }
        if (v._started) v.currentTime = Math.min(v.currentTime + 1, END);   // the first frame is t = 0
        v._started = true;
        if (v.currentTime >= END) { v.ended = true; return; }
        cb(); }; setTimeout(tick, 0); },
      addEventListener() {}, removeEventListener() {} };
    rec.vid = v;
    return v;
  };
  const mkCanvas = () => {
    const vtrack = track('video');
    const stream = { list: [vtrack], addTrack(t) { this.list.push(t); },
      getAudioTracks() { return this.list.filter(t => t.kind === 'audio'); }, getTracks() { return this.list.slice(); } };
    return { width: 0, height: 0, captureStream: () => stream,
      getContext: () => new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } }) };
  };
  class FakeRecorder {
    constructor(stream, opts) { rec.opts.push(opts); this.mimeType = opts.mimeType; this.state = 'inactive'; }
    static isTypeSupported(m) { return m.indexOf('mp4') !== -1; }
    start() { this.state = 'recording'; }
    pause() { this.state = 'paused'; } resume() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; setTimeout(() => { this.ondataavailable({ data: new Blob([new Uint8Array(outBytes)]) }); this.onstop(); }, 0); }
  }
  const c = { console, Math, String, Number, Array, Object, Promise, Date, Error, Blob, isFinite,
    setTimeout, clearTimeout,
    setInterval: manualWatch ? ((fn) => { rec.watch = fn; return 1; }) : setInterval,
    clearInterval: manualWatch ? (() => { rec.watch = null; }) : clearInterval,
    MediaRecorder: FakeRecorder, SP_SS: 2,
    TP_MIN_TAKE_BYTES: Number((/const TP_MIN_TAKE_BYTES = (\d+)/.exec(html) || [])[1]),
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    navigator: { wakeLock: { request: async () => ({ released: false, release() { this.released = true; rec.wlReleased++; } }) } },
    document: { hidden: false, addEventListener(ev, fn) { if (ev === 'visibilitychange') rec.vis = fn; }, removeEventListener() {},
      createElement: (tag) => (tag === 'video' ? mkVideo() : mkCanvas()) },
    spBrandPalette: () => ({}), spRenderBeat: () => ({ base: {} }), tpBeatTimes: () => null,
    spComposite: (ctx, vid, layer, W, H, half, t) => rec.painted.push(t) };
  c.window = c; c.window._tpLastTakeSecs = takeSecs;
  vm.createContext(c);
  vm.runInContext(constLine('SP_OUT_MAX_BYTES'), c);
  for (const n of ['_spReleaseRender', 'spRenderBitrate', 'spEstimateDur', 'renderSplitScreen']) vm.runInContext(grab(n), c);
  c.BEATS = Array.from({ length: beats }, (_, i) => ({ cue: 'b' + i }));
  const run = () => vm.runInContext('renderSplitScreen(new Blob([new Uint8Array(20000)]), BEATS, null)', c);
  return { c, rec, run, audio };
}

// ── 1. output bitrate is bounded by the length of the take ──────────────────
{
  const long = renderWorld({ realLen: 6, takeSecs: 180 });
  await long.run();
  const bps = long.rec.opts[0] && long.rec.opts[0].videoBitsPerSecond;
  ok(bps >= 6000000 && bps <= 8000000,
     'a 180 s take is rendered at ' + (bps / 1e6).toFixed(1) + ' Mbps, so the file is ~' + Math.round(bps * 182 / 8 / 1048576) +
     ' MB, not the ~450 MB a fixed 20 Mbps wrote on top of the ~450 MB take (the measured 858 MB peak)');
  const short = renderWorld({ realLen: 6, takeSecs: 30 });
  await short.run();
  ok(short.rec.opts[0] && short.rec.opts[0].videoBitsPerSecond === 20000000,
     'the opposite arm: a 30 s take keeps the full 20 Mbps — nobody\'s ordinary video gets softer');
  const f = vm.runInContext('spRenderBitrate', short.c);
  ok(f(undefined) === 20000000 && f(0) === 20000000 && f(10000) === 6000000,
     'an unknown length keeps 20 Mbps, and no length ever goes below the 6 Mbps floor');
}
// ── 2. a phone that will not report the length still renders the whole take ─
{
  const w = renderWorld({ realLen: 30, reportDuration: false, takeSecs: 30, beats: 3 });
  const out = await w.run();
  const last = Math.max(...w.rec.painted);
  ok(last >= 28,
     'with the duration withheld, a 30 s take is rendered to the end (last frame painted at ' + last + ' s). The guess was ' +
     'beats x 3.25 = 9.75 s and the frame loop stops at the guess, so it came out a third as long');
  ok(out.estSec >= 30 && w.c.window._spDurEstimated === true,
     'and it is still marked as a guess (' + out.estSec + ' s), so the sheet still asks them to check it');
  const m = renderWorld({ realLen: 30, reportDuration: true, takeSecs: 30 });
  const mo = await m.run();
  ok(mo.estSec === 0 && m.c.window._spDurEstimated === false && Math.max(...m.rec.painted) >= 28,
     'the opposite arm: a reported duration is used as-is and nothing is marked as a guess');
}
// ── 3. (v687) a header-only output is refused, and everything is released first
{
  const w = renderWorld({ realLen: 4, outBytes: 400, takeSecs: 4 });
  let err = null; try { await w.run(); } catch (e) { err = e; }
  ok(err && /empty video file/.test(err.message), 'a 400-byte output is refused, not shipped as "ready to post" (' + (err && err.message) + ')');
  ok(w.rec.wlReleased === 1 && w.rec.stops >= 2,
     'and the wake lock and every track are released before the refusal (wake lock ' + w.rec.wlReleased + ', tracks stopped ' + w.rec.stops + ')');
  const g = renderWorld({ realLen: 4, outBytes: 50000, takeSecs: 4 });
  const out = await g.run();
  ok(out && out.blob && out.blob.size === 50000 && g.rec.wlReleased === 1, 'the opposite arm: a real output is delivered, and released once');
}
// ── 4. stock photos are decoded one at a time and shrunk to what can be shown ─
{
  let live = 0, peak = 0, closed = 0;
  const mkBmp = (w, h) => ({ width: w, height: h, close() { closed++; } });
  const c = { console, Math, String, Number, Promise, AbortController, setTimeout, clearTimeout, encodeURIComponent,
    fetch: async () => new Response(new Uint8Array(1000), { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    createImageBitmap: async (src, opts) => {
      live++; peak = Math.max(peak, live);
      await new Promise(r => setTimeout(r, 5)); live--;
      if (opts) return mkBmp(opts.resizeWidth, opts.resizeHeight);
      return src.size === 1000 ? mkBmp(1880, 1253) : mkBmp(900, 600);
    } };
  c.window = c;
  vm.createContext(c);
  vm.runInContext(constLine('SP_PHOTO_MAX_W'), c);
  for (const n of ['_spPhotoMiss', 'spDecodePhoto', 'spFetchBeatPhotos']) vm.runInContext(grab(n), c);
  c.B = [1, 2, 3, 4, 5, 6].map(i => ({ imageQuery: 'q' + i, headline: 'h' }));
  await vm.runInContext('spFetchBeatPhotos(B)', c);
  const sizes = c.B.map(b => b._img && (b._img.width + 'x' + b._img.height));
  const px = c.B.reduce((a, b) => a + (b._img ? b._img.width * b._img.height : 0), 0);
  ok(c.B.every(b => b._img && b._img.width >= 1440 && b._img.height >= 1112),
     'every photo still covers the largest band it can be drawn into (1440 x 1112), so nothing gets softer: ' + sizes.join(', '));
  ok(px < 6 * 1880 * 1253 * 0.85 && closed === 6,
     'and holds ' + Math.round(px * 4 / 1048576) + ' MB of pixels instead of ' + Math.round(6 * 1880 * 1253 * 4 / 1048576) +
     ' MB, with each full-size bitmap closed (' + closed + ' closed)');
  ok(peak === 1, 'decoded one at a time, not six full-size decodes at once (peak ' + peak + ')');
  // opposite arm: a photo already small enough is used as-is
  const c2 = Object.assign({}, c); vm.createContext(c2);
  vm.runInContext(constLine('SP_PHOTO_MAX_W'), c2);
  vm.runInContext(grab('spDecodePhoto'), c2);
  closed = 0;
  const small = await vm.runInContext('spDecodePhoto({ size: 5 })', c2);
  ok(small.width === 900 && small.height === 600 && closed === 0, 'the opposite arm: a photo smaller than the band is not resized or closed');
}

// ── v690 r2: an estimated length with NO known take length stays a number ────
{
  const w = renderWorld({ realLen: 20, reportDuration: false, takeSecs: undefined, beats: 3 });
  const out = await w.run();
  ok(out.estSec === 9.75 && w.c.window._spDurEstimated === true,
     'with the length withheld and no take length known, the guess is the old beats x 3.25 = 9.75 s (got ' + out.estSec + '). ' +
     'Without the finite-number guard it was NaN: a NaN render length, a NaN deadline that never fires, and a "NaN-second guess" on the sheet');
  const f = vm.runInContext('spEstimateDur', w.c);
  ok(f(9.75, undefined) === 9.75 && f(9.75, NaN) === 9.75 && f(9.75, 0) === 9.75 && f(9.75, 30) === 31,
     'spEstimateDur: unknown / NaN / zero take length keep the guess; a real one wins');
}
// ── v690 r2: the render ends when the video ends, not 6 s later ──────────────
{
  const w = renderWorld({ realLen: 4, reportDuration: true, takeSecs: 4 });
  const t0 = Date.now();
  const out = await w.run();
  const took = Date.now() - t0;
  ok(took < 3000,
     'a 4 s take finishes rendering ' + took + ' ms after its last frame, not after the 6 s stall watchdog. Chromium sends no ' +
     'frame callback after the last frame, so step() never saw vid.ended');
  ok(out && out.partial === false && Math.max(...w.rec.painted) >= 3,
     'the opposite arm: ending on `ended` does not cut the take short — it is not flagged partial and every frame was drawn');
}
// ── v690 r2: the take length belongs to THIS take ────────────────────────────
{
  const start = grab('startTpRecord');
  const line = (/^\s*tpRecStartTime = Date\.now\(\);[^\n]*$/m.exec(start) || [''])[0];
  ok(!!line, 'the line that starts the take clock is identifiable in startTpRecord');
  const c = { Date, Math, window: null, tpRecStartTime: null };
  c.window = c; c._tpLastTakeSecs = 180;   // the PREVIOUS take was three minutes
  vm.createContext(c);
  vm.runInContext(line, c);
  ok(c._tpLastTakeSecs === 0,
     'starting a take clears the previous take\'s length (' + c._tpLastTakeSecs + '). It was only ever written at stopTpRecord, so a ' +
     'recorder that stopped by itself left the render sizing its bitrate and length guess from the last take');
  vm.runInContext(grab('tpNoteTakeSecs'), c);
  c.tpRecStartTime = Date.now() - 42000;
  vm.runInContext('tpNoteTakeSecs()', c);
  ok(c._tpLastTakeSecs === 42, 'a recorder that stopped on its own still records this take\'s length (' + c._tpLastTakeSecs + ' s)');
  c._tpLastTakeSecs = 30;
  vm.runInContext('tpNoteTakeSecs()', c);
  ok(c._tpLastTakeSecs === 30, 'the opposite arm: a length stopTpRecord already wrote is left alone');
  const onstopAt = start.indexOf('tpMediaRecorder.onstop = async () => {');
  const noteAt = start.indexOf('tpNoteTakeSecs()', onstopAt), offerAt = start.indexOf('tpOfferSplit(', onstopAt);
  ok(onstopAt > 0 && noteAt > onstopAt && noteAt < offerAt, 'and the take\'s own onstop notes it before the split offer can use it');
}

// ── v690 r3: `ended` is the ONLY early finish — a background pause is not the end ─
const waitFor = async (cond, ms = 5000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) return false; await new Promise(r => setTimeout(r, 5)); } return true; };
{
  const w = renderWorld({ realLen: 6, takeSecs: 6, manualWatch: true, holdAt: 2 });
  let settled = false;
  const p = w.run().then(v => { settled = true; return v; });
  await waitFor(() => w.rec.watch && w.rec.painted.length && Math.max(...w.rec.painted) >= 2);
  w.c.document.hidden = true; w.rec.vis();                 // they glance at a notification: onVis pauses the take
  w.rec.holdAt = Infinity;
  for (let i = 0; i < 4; i++) { if (w.rec.watch) w.rec.watch(); await new Promise(r => setTimeout(r, 5)); }
  ok(!settled && w.rec.vid.paused === true,
     'while the page is hidden and the take is paused, the render does NOT finish (a watchdog that took "paused" for "ended" ' +
     'would ship a video cut at the moment they looked away)');
  w.c.document.hidden = false; w.rec.vis();                // back in the app: playback resumes
  await waitFor(() => w.rec.vid.ended);
  const tick = w.rec.watch; if (tick) tick();
  const out = await Promise.race([p, new Promise(r => setTimeout(() => r(null), 1000))]);
  ok(out && out.partial === false && Math.max(...w.rec.painted) >= 5,
     'after resuming, the whole take is drawn (last frame ' + Math.max(...w.rec.painted) + ' s of 6) and nothing is flagged partial');
  ok(!!out, 'the opposite arm: a real `ended` still finishes the render on the very next watchdog tick');
}
// ── v690 r3: finishing on `ended` records WHERE it ended ─────────────────────
{
  const w = renderWorld({ realLen: 6, takeSecs: 6, manualWatch: true, holdAt: 5 });
  const p = w.run();
  await waitFor(() => w.rec.watch && w.rec.painted.length && Math.max(...w.rec.painted) >= 5);
  w.rec.watch();                                           // an ordinary tick records progress at 5 s
  w.rec.holdAt = Infinity;
  await waitFor(() => w.rec.vid.ended);
  w.rec.watch();                                           // the tick that sees `ended`
  const out = await p;
  ok(out.partial === false && Math.abs(out.drift) <= 0.05,
     'ending on `ended` records the true end of the 6 s take (partial ' + out.partial + ', drift ' + out.drift + ' s). Finishing ' +
     'without recording it keeps the last tick\'s position — up to 0.7 s short — and raises a false "this build stopped early"');
  // opposite arm: a stream that genuinely ends early (says 6 s, has 4 s) is still caught
  const s2 = renderWorld({ realLen: 6, endAt: 4, takeSecs: 6, manualWatch: true });
  const p2 = s2.run();
  await waitFor(() => s2.rec.watch && s2.rec.vid && s2.rec.vid.ended);
  s2.rec.watch();
  const o2 = await p2;
  ok(o2.partial === true, 'the opposite arm: a take whose stream really stops at 4 of a reported 6 s is flagged partial (' + o2.partial + ')');
}

if (fail === 0) console.log('\nPASS — rv-front-3: the render is bounded in memory, renders the whole take, and never ships an empty file.');
else { console.log('\n' + fail + ' failure(s)'); process.exitCode = 1; }
