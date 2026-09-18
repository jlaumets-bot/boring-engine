#!/usr/bin/env node
// GATE: a filmed take is work the user cannot redo. Nothing may lose it, and nothing may claim
//       to have saved something it did not save.
//
// WHY THIS EXISTS — four defects on the highest-stakes surface in the product.
//
//   1. A DISMISSED SHARE SHEET LOST THE TAKE NINE SECONDS LATER. tpShareOrSave calls
//      closeTeleprompter() BEFORE sharing, and the review card and split sheet are already
//      gone — so on a cancelled share the only thing holding the bytes was a 9-second toast's
//      closure. `window._tpLastTake` looked like the safety net and was written in two places
//      and READ IN NONE. Tapping outside a share sheet is an ordinary thing to do: wrong app,
//      changed mind. It cost a take that cannot be refilmed. The codebase already had the right
//      answer for "this device cannot take the file" — tpRescueTake, which keeps the video on
//      screen, playable, with Share and Save, and releases the hold only when the user says
//      they have it. Both torn-down paths route there now. (The split-screen result sheet was
//      already correct and is left alone — this gate checks all three.)
//
//   2. A TAKE COULD RECORD NOTHING WHILE THE UI SAID "RECORDING" FOR THE WHOLE PERFORMANCE.
//      tpEnsureCamera returned true on the mere existence of the stream object. A seized
//      camera ENDS its tracks and leaves the object in place — so after a phone call or an
//      app switch, the recorder was built on dead tracks, start() succeeded, the red Stop
//      button and the timer both ran, and the user performed the entire take against nothing.
//      The mid-take rescue cannot help: it binds track.onended AFTER the tracks already ended.
//
//   3. EVERY CANVAS DOWNLOAD CLAIMED SUCCESS WHERE <a download> DOES NOTHING. canvasDownloadPng
//      returned true the moment a.click() had been called, under a header reading "true only
//      when a file was really handed to the browser". A script-driven <a download> is INERT in
//      an iOS home-screen PWA and in the Instagram/TikTok in-app browsers — nothing written,
//      no error raised — and the app ships as an installable PWA. "Download All 8 Slides"
//      counted eight successes and said "Downloaded 8 slides!" with zero files written.
//      _tpDownloadsInert already detected exactly this and was never consulted here.
//
//   4. THE SPLIT-SCREEN SUCCESS PATH NEVER RELEASED THE TAKE, so _tpBlobInHand stayed true for
//      15 minutes and any later plan-limit 402 told the user to "save this video first" about
//      a video they had already shared — with no route to the Upgrade button.
//
// HOW IT CHECKS
//   Everything is EXECUTED. The real tpShareOrSave is driven with a share sheet that rejects
//   AbortError (the spec's "user dismissed it") and, separately, NotAllowedError, so the rescue
//   path and the genuine-failure fallback are both proved. tpEnsureCamera is run against a
//   stream whose tracks are 'ended'. canvasDownloadPng is run four ways: an iOS PWA with and
//   without a share sheet, an ordinary desktop browser, and a null blob — and the ordinary
//   browser must still behave exactly as before.
//
// RUN:    node scripts/verify/take-never-lost.mjs
// EXPECT: prints "PASS" and exits 0.
import fs from 'node:fs'; import vm from 'node:vm';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT,'app.html'),'utf8');
let fail=0; const ok=(c,m)=>{ if(!c){console.log('FAIL:',m);fail++;} else console.log('ok:',m); };
const grab = n => { let i = html.indexOf('\nfunction '+n+'('); if(i<0) i = html.indexOf('\nasync function '+n+'(');
  if(i<0) throw new Error('no '+n);
  const eol = html.indexOf('\n', i+1), first = html.slice(i+1, eol);
  let d=0,seen=false; for(const ch of first){ if(ch==='{'){d++;seen=true;} else if(ch==='}')d--; }
  if(seen && d===0) return first;
  return html.slice(i+1, html.indexOf('\n}', i)+2); };

// ── 1. a dismissed share sheet must keep the take on screen ──────────────────
{
  const c = { console, rescued: [], toasts: [], closes: 0,
    tpCanDeliver: () => true, closeTeleprompter: () => { c.closes++; },
    tpRescueTake: (b,n2) => c.rescued.push(n2), tpReleaseTake: () => { c.released = true; },
    showToast: (m,ms,tap) => c.toasts.push({m, ms, hasTap: typeof tap === 'function'}),
    tpDownloadBlob: () => { c.downloaded = true; },
    File: class { constructor(p,n2,o){ this.name=n2; this.type=(o||{}).type; } },
    navigator: { share: () => Promise.reject(Object.assign(new Error('cancel'), {name:'AbortError'})),
                 canShare: () => true },
    window: {}, Promise, setTimeout };
  vm.createContext(c);
  vm.runInContext([grab('_tpShareCancelled'), grab('tpShareOrSave')].join('\n'), c);
  vm.runInContext("tpShareOrSave({type:'video/mp4', size: 9000}, 'take.mp4')", c);
  await new Promise(r=>setTimeout(r,20));
  ok(c.rescued.length === 1, 'a dismissed share sheet opens the rescue sheet (was a 9s toast): ' + JSON.stringify(c.rescued));
  ok(c.toasts.length === 0, 'and does not rely on a toast that expires');
  ok(!c.downloaded, 'and does not silently download behind the user');
  // the write-only stash must be gone from BOTH paths
  ok(!/window\._tpLastTake = \{/.test(html), 'the write-only _tpLastTake stash is gone (it was read nowhere)');
  // Three call sites: the two that tore the UI down first (now routed to the rescue sheet)
  // and the split-screen result sheet, which was already correct — it keeps its own sheet,
  // video and buttons on screen and only shows an informational toast.
  const sites = [...html.matchAll(/_tpShareCancelled\(\w+\)\s*\)\s*\{/g)].length;
  ok(sites === 3, 'all three share-cancel paths are accounted for (' + sites + ')');
  let checked = 0;
  for (const m of html.matchAll(/_tpShareCancelled\(\w+\)/g)) {
    const body = html.slice(m.index, m.index + 1400);
    if (/function\s+$/.test(html.slice(m.index - 10, m.index))) continue;   // the definition itself
    checked++;
    const keeps = /tpRescueTake\(/.test(body) || /your video is still here/.test(body);
    ok(keeps, 'share-cancel path #' + checked + ' keeps the take reachable (no expiring-toast-only path)');
  }
  ok(checked === 3, 'all three call sites were checked (' + checked + ')');
}
// a REAL share failure must still fall back to a download
{
  const c = { console, tpCanDeliver: () => true, closeTeleprompter: () => {}, tpRescueTake: () => { c.rescued = true; },
    tpReleaseTake: () => {}, showToast: () => {}, tpDownloadBlob: () => { c.downloaded = true; },
    File: class { constructor(){} },
    navigator: { share: () => Promise.reject(Object.assign(new Error('nope'), {name:'NotAllowedError'})), canShare: () => true },
    window: {}, Promise, setTimeout };
  vm.createContext(c);
  vm.runInContext([grab('_tpShareCancelled'), grab('tpShareOrSave')].join('\n'), c);
  vm.runInContext("tpShareOrSave({type:'video/mp4'}, 'take.mp4')", c);
  await new Promise(r=>setTimeout(r,20));
  ok(c.downloaded === true && !c.rescued, 'a REAL share failure still falls back to a download');
}

// ── 2. a dead camera must not be handed to the recorder ─────────────────────
{
  const mkTrack = (state) => ({ kind:'video', readyState: state, stop(){ this.readyState='ended'; } });
  const c = { console, document: { getElementById: () => null }, showToast: () => {},
    navigator: { mediaDevices: { getUserMedia: async () => { c.acquired = (c.acquired||0)+1;
      return { getTracks: () => [mkTrack('live')] }; } } }, window: {}, Promise, setTimeout };
  vm.createContext(c);
  vm.runInContext('var tpCameraStream = null;\n' + grab('tpStreamLive') + '\n' +
                  'async function tpApplyBlurPreference(){}\n' + grab('tpEnsureCamera'), c);
  ok(vm.runInContext("tpStreamLive({getTracks:()=>[{kind:'video',readyState:'live'}]})", c) === true, 'a live stream reads as live');
  ok(vm.runInContext("tpStreamLive({getTracks:()=>[{kind:'video',readyState:'ended'}]})", c) === false, 'an ENDED stream reads as dead (this is the whole bug)');
  ok(vm.runInContext("tpStreamLive({getTracks:()=>[]})", c) === false, 'a stream with no tracks reads as dead');
  ok(vm.runInContext("tpStreamLive(null)", c) === false, 'null reads as dead, it does not throw');
  // a dead stream already in hand must be dropped and re-acquired
  vm.runInContext("tpCameraStream = { getTracks: () => [{kind:'video', readyState:'ended', stop(){} }] };", c);
  await vm.runInContext('tpEnsureCamera(true)', c);
  ok(c.acquired === 1, 'a dead camera is re-acquired, not reused (getUserMedia calls: ' + (c.acquired||0) + ')');
  // a live one must NOT be re-acquired
  c.acquired = 0;
  vm.runInContext("tpCameraStream = { getTracks: () => [{kind:'video', readyState:'live'}] };", c);
  const r = await vm.runInContext('tpEnsureCamera(true)', c);
  ok(r === true && !c.acquired, 'a live camera is reused, with no extra permission prompt');
}

// ── 3. a download that cannot happen must not say "Downloaded!" ──────────────
{
  const mk = (opts) => {
    const clicks = { n: 0 };
    const c = { console, clicks, said: [], Promise, setTimeout, URL: { createObjectURL: () => 'blob:x', revokeObjectURL(){} },
      document: { createElement: () => ({ set href(v){}, set download(v){}, click(){ clicks.n++; }, remove(){},
                                          get download(){ return ''; } }),
                  body: { appendChild(){}, removeChild(){} } },
      navigator: Object.assign({ userAgent: 'Mozilla/5.0 (iPhone)' }, opts.nav || {}),
      window: { matchMedia: () => ({ matches: true }), File: class { constructor(){} } },
      showToast: (m) => c.said.push(m) };
    c.window.File = c.File = class { constructor(){} };
    c.matchMedia = c.window.matchMedia;
    vm.createContext(c);
    vm.runInContext(grab('_tpDownloadsInert') + '\n' + grab('canvasDownloadPng'), c);
    return c;
  };
  // iOS standalone PWA, no share available -> must report FALSE and say something true
  let c = mk({ nav: { standalone: true } });
  c.canvas = { toBlob: (cb) => cb({ size: 10 }) };
  let res = await vm.runInContext("canvasDownloadPng(canvas, 'slide.png')", c);
  ok(res === false, 'on an iOS home-screen PWA with no share, the download reports FAILURE (was true)');
  ok(c.said.some(m => /press and hold/i.test(m)), 'and tells the user what will actually work: ' + JSON.stringify(c.said[0]||''));
  // same device WITH a working share sheet -> succeeds via share
  c = mk({ nav: { standalone: true, share: () => Promise.resolve(), canShare: () => true } });
  c.canvas = { toBlob: (cb) => cb({ size: 10 }) };
  res = await vm.runInContext("canvasDownloadPng(canvas, 'slide.png')", c);
  ok(res === true, 'the same device WITH a share sheet succeeds through it');
  // an ordinary desktop browser must be untouched
  c = mk({ nav: { userAgent: 'Mozilla/5.0 (Macintosh)' } });
  c.window.matchMedia = c.matchMedia = () => ({ matches: false });
  c.canvas = { toBlob: (cb) => cb({ size: 10 }) };
  res = await vm.runInContext("canvasDownloadPng(canvas, 'slide.png')", c);
  ok(res === true && c.clicks.n === 1, 'an ordinary browser still downloads exactly as before');
  // a null blob still reports honestly
  c = mk({ nav: { userAgent: 'Mozilla/5.0 (Macintosh)' } });
  c.window.matchMedia = c.matchMedia = () => ({ matches: false });
  c.canvas = { toBlob: (cb) => cb(null) };
  res = await vm.runInContext("canvasDownloadPng(canvas, 'slide.png')", c);
  ok(res === false, 'a null blob still reports failure');
}

// ── 4. the split-screen success path releases the take ──────────────────────
{
  const i = html.indexOf("showToast('Shared ✓', 'success')");
  ok(i > -1, 'the split-screen success branch is still there');
  ok(/tpReleaseTake\(\);[\s\S]{0,200}showToast\('Shared ✓'/.test(html),
    'and it now releases the take before closing (_tpBlobInHand no longer sticks for 15 minutes)');
}
console.log(fail ? '\nFAIL \u2014 ' + fail + ' check(s) failed' : '\nPASS \u2014 a cancelled share keeps the take, a dead camera is re-acquired, and no download claims a file it did not write');
process.exit(fail?1:0);
