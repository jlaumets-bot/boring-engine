#!/usr/bin/env node
// GATE: the desktop teleprompter "Read mode".
//
// WHY THIS EXISTS
//   The owner wants to "use the teleprompter in big format in desktop … not film in the desktop even
//   but just read and film with phone on a side". On a computer (>= 900px wide AND a fine pointer) the
//   teleprompter opens as a big black reading screen that never touches the camera. Phones and tablets
//   must keep the camera path exactly as before. If either side regresses, the person either gets a
//   camera prompt on the laptop they are only reading from, or loses their phone's camera screen.
//
// HOW IT CHECKS (executed, not grepped, wherever execution is honest)
//   The real read-mode section of app.html (between the READ MODE markers) and the real
//   openTeleprompter / tvOpenTeleprompter / brollFilmGo / rv2FilmNow / closeTeleprompter /
//   tpEnsureCamera / stopTpCamera / tpCountdown / tpAskMarkFilmed / tpFilmedAnswer are lifted into a
//   node:vm sandbox with a fake DOM, fake timers, a fake requestAnimationFrame, a stub getUserMedia
//   that records every request, and a stub Screen Wake Lock.
//     1  read mode is chosen only for wide + fine pointer (899 / 900, coarse tablets, phones);
//     2  read mode NEVER requests video — every request is logged with whether read mode was on,
//        a direct tpEnsureCamera(false) in read mode is refused, and a camera that arrives late
//        after switching to read mode is stopped;
//     3  every entry point honours read mode (pipeline video / statement / carousel, Quick Post
//        video / statement, B-roll "Film it", Remix "Film it now") — plus a SOURCE arm: the only
//        functions that open the overlay are the two that call tpOpenMode(), and no camera call
//        outside the read-mode section bypasses it;
//     4  the key bindings (Space, arrows, + = - _, R, F, M, Esc, ignored in inputs / with modifiers /
//        in camera mode / when closed), text size + mirror remembered, storage that throws survives;
//     5  wake lock acquired on open, re-acquired on visibilitychange, released on close;
//     6  close asks "Mark as filmed?" only past 60% or at the end, never for Quick Post, never auto-marks;
//     7  "Film here instead" starts the camera and is remembered; "Read mode" switches back;
//     8  phones still start the camera; the countdown, the pace (same words per minute at a bigger
//        font), the clean end, reduced motion and the voice switch (mic only, off by default).
// RUN: node scripts/verify/tp-read-mode.mjs      EXPECT: prints "TP READ MODE OK", exit 0.
import fs from 'node:fs'; import vm from 'node:vm';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
setTimeout(() => { console.log('FAIL: wall clock (60s) exceeded'); process.exit(2); }, 60000).unref();
let finished = false;
process.on('exit', (code) => { if (!finished && code === 0) { console.log('FAIL: the gate ended before all checks ran'); process.exitCode = 1; } });
let fail = 0; const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fail++; } else console.log('ok:', m); };
const grab = n => {
  let i = html.indexOf('\nfunction ' + n + '('); if (i < 0) i = html.indexOf('\nasync function ' + n + '(');
  if (i < 0) throw new Error('no ' + n + ' in app.html');
  const eol = html.indexOf('\n', i + 1), first = html.slice(i + 1, eol);
  let d = 0, seen = false; for (const ch of first) { if (ch === '{') { d++; seen = true; } else if (ch === '}') d--; }
  if (seen && d === 0) return first;
  return html.slice(i + 1, html.indexOf('\n}', i) + 2);
};
const SEC_A = '/* ══ READ MODE — the desktop teleprompter ══', SEC_B = '/* ══ END READ MODE ══ */';
const secA = html.indexOf(SEC_A), secB = html.indexOf(SEC_B, secA);
if (secA < 0 || secB < secA) { console.log('FAIL: the READ MODE section markers are missing from app.html'); process.exit(1); }
const SECTION = html.slice(secA, secB + SEC_B.length);
const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

const SCRIPT = Array.from({ length: 145 }, (_, i) => 'word' + i).join(' ');   // 145 words = 60 s at 145 wpm
const BOLD = 'Your customers are not ignoring you.';

// ── a sandbox: fake DOM, timers, rAF, media, wake lock, storage ──
function sandbox(env) {
  env = Object.assign({ w: 1440, h: 900, fine: true, reduced: false, voice: false, fs: true, wake: true, lsThrows: false }, env || {});
  const els = {};
  let now = 0, seq = 1; const timers = new Map();
  const st = (fn, ms, rep) => { const id = seq++; timers.set(id, { fn, at: now + Math.max(0, ms || 0), ms: Math.max(1, ms || 0), rep }); return id; };
  const clock = {
    advance(ms) { const end = now + ms; for (;;) { let nx = null; for (const [id, t] of timers) if (t.at <= end && (!nx || t.at < nx[1].at)) nx = [id, t];
      if (!nx) break; now = nx[1].at; if (nx[1].rep) nx[1].at += nx[1].ms; else timers.delete(nx[0]); nx[1].fn(); } now = end; } };
  const raf = new Map(); let rid = 0, rafT = 1000;
  const frames = (n, dt = 16) => { for (let i = 0; i < n; i++) { rafT += dt; const cbs = [...raf.values()]; raf.clear(); if (!cbs.length) return i; cbs.forEach(fn => fn(rafT)); } return n; };
  function mk(id, tag) {
    const cls = new Set(); const listeners = {};
    const e = { id, tagName: String(tag || 'div').toUpperCase(), style: {}, attrs: {}, dataset: {}, textContent: '', _html: '', listeners,
      classList: { add: (...c) => c.forEach(x => cls.add(x)), remove: (...c) => c.forEach(x => cls.delete(x)),
        toggle: (c, f) => { const on = f === undefined ? !cls.has(c) : !!f; if (on) cls.add(c); else cls.delete(c); return on; }, contains: c => cls.has(c) },
      get className() { return [...cls].join(' '); }, set className(v) { cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach(x => cls.add(x)); },
      get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; }, removeAttribute(k) { delete this.attrs[k]; },
      addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); }, removeEventListener() {},
      querySelector() { return null; }, querySelectorAll() { return []; }, focus() {}, appendChild(ch) { return ch; },
      remove() { if (els[this.id] === this) delete els[this.id]; this.removed = true; } };
    return e;
  }
  const put = (id, tag) => (els[id] = mk(id, tag));
  ['teleprompterOverlay', 'tpTitle', 'tpDoneBtn', 'tpVoiceBtn', 'tpCountdown', 'tpRmPlay', 'tpRmSpeedVal', 'tpRmMirror', 'tpRmVoice',
   'tpRmFull', 'tpRmHint', 'tpRmFlash', 'tpPlayBtn', 'tpRecBtn', 'tpRecordLbl', 'tpRecTimer'].forEach(id => put(id, id === 'tpRmPlay' ? 'button' : 'div'));
  put('tpCameraFeed', 'video'); put('tpSpeed', 'input').value = '2';
  // tpBody: a scroller whose content height follows the script's font size and its paddings
  const body = put('tpBody');
  body.clientHeight = env.h; body._top = 0; body.sc = null;
  const px = v => parseFloat(v) || 0;
  const scaleOf = sc => { const f = String(sc.style.fontSize || ''); const m = /\*\s*([\d.]+)\)\s*$/.exec(f); if (m) return parseFloat(m[1]) * 1.9; return px(f) / 32 || 1; };
  const contentH = sc => Math.max(60, sc._words * 9) * scaleOf(sc);
  Object.defineProperty(body, 'innerHTML', { get() { return this._html; }, set(v) {
    this._html = String(v); this._top = 0;
    if (/class="tp-script"/.test(v)) {
      const sc = mk('', 'div'); sc.className = 'tp-script'; sc.offsetTop = 80;
      const fm = /class="tp-script" style="font-size:([\d.]+)px"/.exec(v); if (fm) sc.style.fontSize = fm[1] + 'px';
      sc.textContent = String(v).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      sc._words = (sc.textContent.match(/\S+/g) || []).length; this.sc = sc;
    } else this.sc = null;
  } });
  Object.defineProperty(body, 'scrollHeight', { get() { const sc = this.sc; if (!sc) return this.clientHeight; return sc.offsetTop + px(sc.style.paddingTop) + contentH(sc) + px(sc.style.paddingBottom); } });
  Object.defineProperty(body, 'scrollTop', { get() { return this._top; }, set(v) { const max = Math.max(0, this.scrollHeight - this.clientHeight); this._top = Math.max(0, Math.min(max, Number(v) || 0)); } });
  body.querySelector = sel => (/tp-script/.test(sel) ? body.sc : null);
  const ov = els.teleprompterOverlay;
  ov.contains = el => el === ov || !!(el && el._inOverlay);
  body.scrollTo = o => { body.scrolledTo = o && o.top; };
  const doc = {
    listeners: {}, fullscreenElement: null, visibilityState: 'visible', exits: 0,
    getElementById: id => els[id] || null,
    querySelector: sel => (/tp-script/.test(sel) ? body.sc : null),
    querySelectorAll: () => [],
    createElement: tag => mk('', tag),
    addEventListener(t, f, cap) { (this.listeners[t] = this.listeners[t] || []).push(f); },
    removeEventListener() {},
    exitFullscreen() { this.exits++; this.fullscreenElement = null; return Promise.resolve(); },
    body: { style: {}, appendChild(e) { if (e.id) els[e.id] = e; e.inBody = true; return e; } },
  };
  doc.fire = (t, ev) => (doc.listeners[t] || []).forEach(f => f(ev || {}));
  if (env.fs) ov.requestFullscreen = function () { ov.fsReq = (ov.fsReq || 0) + 1; doc.fullscreenElement = ov; return Promise.resolve(); };
  // media + wake lock
  const gum = [];
  const mkStream = () => { const tr = [{ kind: 'video', readyState: 'live', stop() { this.readyState = 'ended'; tr.stopped = (tr.stopped || 0) + 1; } }, { kind: 'audio', readyState: 'live', stop() {} }];
    return { tracks: tr, getTracks: () => tr, getAudioTracks: () => [tr[1]], getVideoTracks: () => [tr[0]] }; };
  let deferred = null;
  const wake = { requests: 0, releases: 0, locks: [], reject: false };
  const ls = new Map();
  const c = {
    console, Promise, Math, Date, JSON, Object, Array, String, Number, RegExp, Error, Set, Map, parseFloat, parseInt, isFinite,
    document: doc, els, body, clock, frames, gum, wake, ls, env,
    setTimeout: (fn, ms) => st(fn, ms, false), setInterval: (fn, ms) => st(fn, ms, true),
    clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id),
    requestAnimationFrame: fn => { const id = ++rid; raf.set(id, fn); return id; },
    cancelAnimationFrame: id => raf.delete(id),
    innerWidth: env.w,
    matchMedia: q => ({ matches: /pointer\s*:\s*fine/.test(q) ? !!env.fine : (/reduced-motion/.test(q) ? !!env.reduced : false) }),
    localStorage: env.lsThrows ? { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } }
                               : { getItem: k => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: k => ls.delete(k) },
    navigator: {
      mediaDevices: { getUserMedia: (cons) => { gum.push({ video: !!(cons && cons.video), audio: !!(cons && cons.audio), readMode: !!vm.runInContext('typeof _tpRm !== "undefined" && !!_tpRm', c) });
        if (c._holdCamera) return new Promise(r => { deferred = () => { const s = mkStream(); c._lateStream = s; r(s); }; });
        return Promise.resolve(mkStream()); } },
      wakeLock: env.wake ? { request: (type) => { wake.requests++; wake.type = type; if (wake.reject) return Promise.reject(new Error('NotAllowed'));
        const l = { released: false, release() { this.released = true; wake.releases++; return Promise.resolve(); } }; wake.locks.push(l); return Promise.resolve(l); } } : undefined,
    },
    winListeners: {}, addEventListener(t, f) { (c.winListeners[t] = c.winListeners[t] || []).push(f); }, removeEventListener() {},
    toasts: [], showToast(m) { c.toasts.push(String(m)); },
    // collaborators that are not under test
    tpFormatScript: (t) => '<div class="tp-blk">' + String(t) + '</div>', nl2br: t => String(t), tpPrimer: () => '<details class="tp-primer"></details>',
    tpVoiceEnabled: () => true, tpApplyBlurPreference: async () => {}, tpBlur: { stop() {} },
    stopTpScroll() { c.stopScrolls = (c.stopScrolls || 0) + 1; },
    startTpVoiceFollow() { c.voiceStarts = (c.voiceStarts || 0) + 1; vm.runInContext('tpVoiceRec = {}', c); return true; },
    stopTpVoiceFollow() { c.voiceStops = (c.voiceStops || 0) + 1; vm.runInContext('tpVoiceRec = null', c); },
    saveState() {}, renderNav() {}, refreshCurrentView() {}, closeBroll() {}, reindexIdeas() {},
    moveStage(id, st) { c.state[id].status = st; c.moved = (c.moved || 0) + 1; },
    tvNoIdea() { c.noIdea = (c.noIdea || 0) + 1; }, tvActiveIdea: () => c._tvIdea,
    currentBrand: { id: 'b1' },
  };
  c.window = c; c.self = c;
  c.release = () => { if (deferred) { const d = deferred; deferred = null; d(); } };
  vm.createContext(c);
  vm.runInContext('var tpMediaRecorder = null, tpCameraStream = null, tpScrolling = false, tpFontSize = 32, tpVoiceRec = null, tpVoiceHeardAt = 0,'
    + ' tpVoiceCursor = 0, tpVoiceLastAdvanceDone = false, tpVoiceLastAdvance = 0, tpVoiceBridge = null, tpRecStartTime = 0, tpVoiceWords = [], tpRecTimerInterval = null, tpScrollTrackIv = null, _tpIdeaId = null;'
    + ' var TP_VOICE_SUPPORTED = ' + (env.voice ? 'true' : 'false') + '; var state = [];', c);
  for (const n of ['escHtml', 'tpReadFrac', 'tpSetSmartSpeed', 'tpSyncDoneBtn', 'tpCountdown', 'tpStreamLive', 'tpEnsureCamera', 'stopTpCamera',
    'closeTeleprompter', 'openTeleprompter', 'tvOpenTeleprompter', 'brollFilmGo', 'rv2FilmNow', 'rv2FilmNowClose', 'tpAskMarkFilmed', 'tpFilmedAnswer', 'tpWordTop', 'tpVoiceScrollTo'])
    vm.runInContext(grab(n), c);
  vm.runInContext(SECTION, c);
  c.run = src => vm.runInContext(src, c);
  c._mk = mk;
  c.rm = () => vm.runInContext('_tpRm', c);
  c.ideas = () => { c.state = [
    { id: 0, title: 'Pending one', status: 'pending', format: 'video', script: SCRIPT },
    { id: 1, title: 'Video in Pipeline', status: 'filming', format: 'video', script: SCRIPT },
    { id: 2, title: 'Statement', status: 'filming', format: 'statement', boldText: BOLD, script: '' },
    { id: 3, title: 'Carousel', status: 'filming', format: 'carousel', script: 'slide one slide two slide three' },
  ]; vm.runInContext('state = window.state', c); };
  c.key = (k, extra) => { const ev = Object.assign({ key: k, target: c.els.tpBody, dp: false, preventDefault() { this.dp = true; }, stopPropagation() {} }, extra || {});
    (doc.listeners.keydown || []).forEach(f => f(ev)); return ev; };
  c.open = (id) => { c.ideas(); c.openTeleprompter(id); };
  c.isOpen = () => ov.classList.contains('open');
  c.isRead = () => ov.classList.contains('read-mode');
  c.videoAsks = () => gum.filter(g => g.video).length;
  c.videoInRead = () => gum.filter(g => g.video && g.readMode).length;
  c.ov = ov;
  return c;
}

(async () => {
  // ═════════ 1 — read mode only for wide + fine pointer ═════════
  {
    const cases = [[1440, true, true], [900, true, true], [899, true, false], [1024, false, false], [1366, false, false], [390, false, false], [390, true, false]];
    for (const [w, fine, want] of cases) {
      const c = sandbox({ w, fine });
      ok(c.run('tpReadEligible()') === want, `1 ${w}px ${fine ? 'fine' : 'coarse'} pointer → ${want ? 'read mode' : 'camera'}`);
    }
    const c = sandbox({ w: 1440, fine: true });
    c.matchMedia = undefined; c.run('void 0');
    ok(c.run('tpReadEligible()') === false, '1 no matchMedia at all → camera (never guess desktop)');
  }

  // ═════════ 2 + 3 — every entry point honours read mode, and read mode never asks for video ═════════
  const entries = [
    ['Pipeline video (openTeleprompter)', c => c.open(1), SCRIPT.slice(0, 20)],
    ['Pipeline statement (openTeleprompter)', c => c.open(2), BOLD],
    ['Pipeline carousel (openTeleprompter)', c => c.open(3), 'slide one slide two'],
    ['Quick Post video (tvOpenTeleprompter)', c => { c.ideas(); c._tvIdea = { title: 'QP', format: 'video', script: SCRIPT }; c.tvOpenTeleprompter(); }, SCRIPT.slice(0, 20)],
    ['Quick Post statement (tvOpenTeleprompter)', c => { c.ideas(); c._tvIdea = { title: 'QP', format: 'statement', boldText: BOLD }; c.tvOpenTeleprompter(); }, BOLD],
    ['B-roll "Film it" (brollFilmGo)', c => { c.ideas(); c.brollFilmGo(0); }, SCRIPT.slice(0, 20)],
    ['Remix "Film it now" (rv2FilmNow)', c => { c.ideas(); c._rv2FilmNowIdea = { idea: c.state[1], brandId: 'b1' }; c.rv2FilmNow(); }, SCRIPT.slice(0, 20)],
  ];
  for (const [name, go, text] of entries) {
    const d = sandbox({ w: 1440, fine: true });
    go(d); await tick();
    ok(d.isOpen() && d.isRead() && !!d.rm(), `3 desktop: ${name} opens in read mode`);
    ok(d.videoAsks() === 0, `2 desktop: ${name} never requests video (requests: ${d.videoAsks()})`);
    ok(d.body.innerHTML.includes(text), `8 desktop: ${name} shows the same text the phone shows`);
    d.closeTeleprompter();
    const p = sandbox({ w: 390, fine: false });
    go(p); await tick();
    ok(p.isOpen() && !p.isRead() && !p.rm() && p.videoAsks() === 1, `3 phone: ${name} still starts the camera, no read mode`);
  }
  // SOURCE arm: only the two openers open the overlay, both through tpOpenMode; no camera call bypasses it
  {
    const fnRe = /\n(?:async )?function ([A-Za-z_$][\w$]*)\s*\(/g; const bodies = {}; let m, last = null;
    while ((m = fnRe.exec(html))) { if (last) bodies[last.n] = html.slice(last.i, m.index); last = { n: m[1], i: m.index }; }
    if (last) bodies[last.n] = html.slice(last.i);
    const openers = Object.keys(bodies).filter(n => /teleprompterOverlay/.test(bodies[n]) && /\.classList\.add\('open'\)/.test(bodies[n]));
    ok(openers.sort().join(',') === 'openTeleprompter,tvOpenTeleprompter', '3 source: the only functions that open the teleprompter are openTeleprompter + tvOpenTeleprompter (found: ' + openers.join(',') + ')');
    for (const n of ['openTeleprompter', 'tvOpenTeleprompter']) {
      const b = bodies[n] || '';
      const camLines = b.split('\n').filter(l => /tpEnsureCamera\(/.test(l) && !/^\s*\/\//.test(l));
      ok(camLines.length >= 1 && camLines.every(l => /tpOpenMode\(\)/.test(l)), `3 source: every camera start in ${n} goes through tpOpenMode()`);
    }
    const outside = html.slice(0, secA) + html.slice(secB);
    const rawCam = (outside.match(/[^\n]*tpEnsureCamera\(true\)[^\n]*/g) || []).filter(l => !/^\s*\/\//.test(l) && !/typeof tpOpenMode === 'function'\) tpOpenMode\(\); else tpEnsureCamera\(true\)/.test(l));
    ok(rawCam.length === 0, '3 source: no tpEnsureCamera(true) outside the read-mode section skips tpOpenMode (' + rawCam.length + ')');
    const callers = ['brollFilmGo', 'rv2FilmNow'].every(n => /openTeleprompter\(id\)/.test(bodies[n] || ''));
    ok(callers, '3 source: brollFilmGo and rv2FilmNow open through openTeleprompter');
  }

  // ═════════ 2 — read mode refuses the camera even when asked directly, and kills a late one ═════════
  {
    const c = sandbox();
    c.open(1); await tick();
    const r = await c.run('tpEnsureCamera(false)');
    ok(r === false && c.videoAsks() === 0, '2 in read mode a direct tpEnsureCamera(false) (the Record path) is refused with no request');
    c.closeTeleprompter();
    // camera asked for in film mode, user switches to read mode while the permission prompt is up
    c.ls.set('tp_desktop_mode', 'film'); c._holdCamera = true;
    c.open(1); await tick();
    ok(!c.isRead() && c.videoAsks() === 1, '7 with "film" remembered the desktop opens on the camera');
    c.run('tpSwitchToRead()'); c.release(); await tick();
    ok(c.isRead() && c._lateStream && c._lateStream.tracks[0].readyState === 'ended' && c.run('tpCameraStream') === null,
       '2 a camera that arrives after switching to read mode is stopped, never shown');
    ok(c.videoInRead() === 0, '2 no video request was ever made while read mode was on');
  }

  // ═════════ 8 — countdown, pace, clean end; reduced motion ═════════
  {
    const c = sandbox();
    c.open(1);
    ok(c.rm().counting === true && c.els.tpCountdown.textContent == 3 && c.ov.classList.contains('rm-counting'), '8 opening shows a 3-2-1 countdown');
    ok(c.frames(3) === 0 && c.body.scrollTop === 0, '8 nothing scrolls during the countdown');
    c.clock.advance(2500);
    ok(c.rm().playing === true && c.rm().counting === false, '8 after the countdown the script plays');
    const max = c.body.scrollHeight - c.body.clientHeight;
    c.frames(1); c.frames(30 * 1000 / 16);       // 30 s of a 60 s script
    const half = c.body.scrollTop / max;
    ok(half > 0.42 && half < 0.58, '8 at 1.0× a 145-word script is half read after 30 s (' + half.toFixed(2) + ')');
    c.run('_tpRm.pos = 0; document.getElementById("tpBody").scrollTop = 0; _tpRm.setTop = 0;');
    c.key('='); c.key('='); c.key('=');            // much bigger text
    const max2 = c.body.scrollHeight - c.body.clientHeight;
    ok(max2 > max * 1.2, '8 bigger text makes the script taller');
    c.frames(30 * 1000 / 16);
    const half2 = c.body.scrollTop / max2;
    ok(Math.abs(half2 - half) < 0.06, '8 the words-per-minute stay the same at the bigger size (' + half2.toFixed(2) + ' vs ' + half.toFixed(2) + ')');
    c.frames(40 * 1000 / 16);
    ok(c.rm().ended === true && c.rm().playing === false && Math.abs(c.body.scrollTop - max2) < 0.01 && c.frames(5) === 0, '8 it ends cleanly at the end of the script and stops asking for frames');
    ok(c.els.tpRmPlay.textContent === 'Replay', '8 at the end the play button offers Replay');
    c.closeTeleprompter();
    const r = sandbox({ reduced: true });
    r.open(1);
    ok(r.rm().playing === true && r.rm().counting === false && !r.els.tpCountdown.classList.contains('show'), '9 reduced motion: no countdown animation, it starts scrolling');
    r.frames(1); r.frames(60);
    ok(r.body.scrollTop > 0, '9 reduced motion still scrolls');
  }

  // ═════════ 4 — key bindings ═════════
  {
    const c = sandbox({ voice: true });
    c.open(1); c.clock.advance(2500);
    let e = c.key(' ');
    ok(e.dp && c.rm().playing === false, '4 Space pauses (and the page does not scroll)');
    e = c.key(' ');
    ok(c.rm().playing === true, '4 Space plays again');
    c.key('ArrowUp'); c.key('ArrowUp');
    ok(Math.abs(c.rm().mult - 1.2) < 1e-9 && c.ls.get('tp_read_speed') === '1.2', '4 ↑ speeds up (1.2×)');
    e = c.key('ArrowDown');
    ok(e.dp && Math.abs(c.rm().mult - 1.1) < 1e-9, '4 ↓ slows down');
    c.key('+'); ok(c.ls.get('tp_read_scale') === '1.1', '4 + makes the text bigger and remembers it');
    c.key('='); ok(c.ls.get('tp_read_scale') === '1.2', '4 = also makes the text bigger');
    c.key('-'); ok(c.ls.get('tp_read_scale') === '1.1', '4 − makes the text smaller');
    c.key('_'); ok(c.ls.get('tp_read_scale') === '1' && /\* 1\.00\)$/.test(c.body.sc.style.fontSize), '4 _ also makes it smaller, and the font follows');
    c.key('m');
    ok(c.ov.classList.contains('rm-mirror') && c.ls.get('tp_read_mirror') === '1' && c.els.tpRmMirror.getAttribute('aria-pressed') === 'true', '4 M mirrors the text and remembers it');
    c.frames(1); c.frames(200);
    ok(c.body.scrollTop > 0, '4 (scrolling is under way)');
    c.key('r');
    ok(c.body.scrollTop === 0 && c.rm().counting === true && c.rm().playing === false, '4 R restarts from the top with the countdown again');
    c.clock.advance(2500);
    c.key('f');
    ok(c.ov.fsReq === 1 && c.document.fullscreenElement === c.ov, '4 F asks for full screen on the overlay');
    c.key('Escape');
    ok(c.document.exits === 1 && c.isOpen(), '4 Esc in full screen leaves full screen first, the reader stays open');
    // ignored: typing into an input, modifiers
    const before = c.rm().playing;
    e = c.key(' ', { target: { tagName: 'INPUT' } });
    ok(!e.dp && c.rm().playing === before, '4 keys typed into an input are not captured');
    e = c.key('m', { target: { tagName: 'TEXTAREA' } });
    ok(!e.dp && c.ov.classList.contains('rm-mirror'), '4 keys typed into a textarea are not captured');
    e = c.key('r', { metaKey: true });
    ok(!e.dp && c.rm().counting === false, '4 Cmd+R stays the browser\'s');
    c.key('Escape');
    ok(!c.isOpen() && !c.rm(), '4 Esc closes');
    e = c.key(' ');
    ok(!e.dp, '4 no keys are captured once it is closed');
    // reopen: mirror + size remembered
    c.open(1);
    ok(c.ov.classList.contains('rm-mirror') && /\* 1\.00\)$/.test(c.body.sc.style.fontSize), '4 mirror and text size are remembered on the next open');
    c.closeTeleprompter();
    // F with no Fullscreen API → fallback message, no throw
    const n = sandbox({ fs: false });
    n.open(1); n.key('f');
    ok(/F11/.test(n.els.tpRmFlash.textContent) && n.isOpen(), '4 F without the Fullscreen API explains the fallback and keeps reading');
    // storage that throws
    const t = sandbox({ lsThrows: true });
    let threw = false;
    try { t.open(1); t.key('+'); t.key('m'); t.key('ArrowUp'); t.clock.advance(2500); t.frames(5); } catch (err) { threw = err; }
    ok(!threw && t.isRead(), '4 storage that throws (private mode) never breaks read mode' + (threw ? ' — ' + threw.message : ''));
    // camera mode on desktop: keys are not captured
    const f = sandbox(); f.ls.set('tp_desktop_mode', 'film'); f.open(1);
    e = f.key(' ');
    ok(!e.dp && !f.isRead(), '4 in camera mode the read-mode keys are not captured');
  }

  // ═════════ 5 — wake lock ═════════
  {
    const c = sandbox();
    c.open(1); await tick();
    ok(c.wake.requests === 1 && c.wake.type === 'screen', '5 the screen wake lock is requested on open');
    c.wake.locks[0].released = true;      // the platform drops it when the tab is hidden
    c.document.visibilityState = 'hidden'; c.document.fire('visibilitychange'); await tick();
    ok(c.wake.requests === 1, '5 nothing is requested while the page is hidden');
    c.document.visibilityState = 'visible'; c.document.fire('visibilitychange'); await tick();
    ok(c.wake.requests === 2, '5 it is re-acquired when the page is visible again');
    c.closeTeleprompter(); await tick();
    ok(c.wake.locks[1].released === true, '5 it is released on close');
    c.document.fire('visibilitychange'); await tick();
    ok(c.wake.requests === 2, '5 once closed, coming back to the tab does not take it again');
    const n = sandbox({ wake: false }); let threw = false;
    try { n.open(1); await tick(); n.closeTeleprompter(); } catch (e) { threw = true; }
    ok(!threw, '5 no Wake Lock API: read mode still works');
    const r = sandbox(); r.wake.reject = true; threw = false;
    try { r.open(1); await tick(); r.closeTeleprompter(); await tick(); } catch (e) { threw = true; }
    ok(!threw && r.wake.requests === 1, '5 a refused wake lock is swallowed');
  }

  // ═════════ 6 — close → "Mark as filmed?" only for what the prompter carried them through ═════════
  {
    const auto = (c, secs) => { c.frames(1); c.frames(Math.round(secs * 1000 / 16)); };   // 145 words = 60 s at 1.0×
    const fresh = () => { const c = sandbox(); c.open(1); c.clock.advance(2500); return c; };
    const maxOf = c => c.body.scrollHeight - c.body.clientHeight;
    let c = fresh(); auto(c, 18); c.closeTeleprompter();
    ok(!c.isOpen() && !c.els.tpFilmedAsk, '6 auto-scrolled 30% then closed: no question');
    c = fresh(); auto(c, 42); c.closeTeleprompter();
    ok(!!c.els.tpFilmedAsk && /Video in Pipeline/.test(c.els.tpFilmedAsk.innerHTML), '6 auto-scrolled 70% then closed: "Mark as filmed?" for that idea');
    ok(c.state[1].status === 'filming' && !c.moved, '6 asking never auto-marks');
    c.tpFilmedAnswer(true);
    ok(c.state[1].status === 'done', '6 "Yes" moves it to Done exactly like the phone');
    c = fresh(); auto(c, 42); c.run('tpReadPause()'); c.body.scrollTop = maxOf(c) * 0.1; c.closeTeleprompter();
    ok(!!c.els.tpFilmedAsk, '6 auto-read 70% then scrolled back by hand: still counts');
    c = fresh(); auto(c, 42); c.key('Escape');
    ok(!!c.els.tpFilmedAsk, '6 Esc closes through the same path and asks');
    c = fresh(); c.run('tpReadPause()'); c.body.scrollTop = maxOf(c) * 0.7; c.closeTeleprompter();
    ok(!c.els.tpFilmedAsk, '6 scrolled to 70% by hand (paused): looking is not reading, no question');
    c = fresh(); auto(c, 2); c.body.scrollTop = maxOf(c) * 0.7; auto(c, 2); c.closeTeleprompter();
    ok(!c.els.tpFilmedAsk, '6 jumped to 70% by hand while playing: the jump is not counted');
    c = fresh(); auto(c, 2); c.body.scrollTop = maxOf(c); auto(c, 1);
    ok(c.rm() && c.rm().ended === true, '6 (End pressed while playing: the script shows its end)');
    c.closeTeleprompter();
    ok(!c.els.tpFilmedAsk, '6 pressing End is not reaching the end by auto-scroll, no question');
    c = fresh(); auto(c, 70);
    ok(c.rm().ended, '6 (script auto-scrolled to the end)');
    c.closeTeleprompter();
    ok(!!c.els.tpFilmedAsk, '6 reaching the end by auto-scroll asks');
    c = sandbox(); c.ideas(); c._tvIdea = { title: 'QP', format: 'video', script: SCRIPT }; c.tvOpenTeleprompter();
    c.clock.advance(2500); auto(c, 70); c.closeTeleprompter();
    ok(!c.els.tpFilmedAsk, '6 an unsaved Quick Post is never asked (same as the phone)');
    c = sandbox({ w: 390, fine: false }); c.open(1); await tick(); c.closeTeleprompter();
    ok(!c.els.tpFilmedAsk, '6 the phone close path is unchanged (no read-mode question)');
  }

  // ═════════ 6b — "Follow me" aims at the word's REAL place in the scrolling body ═════════
  {
    const c = sandbox({ voice: true }); c.open(1);
    const sc = c._mk('', 'div'); sc.offsetTop = 198; sc.offsetParent = c.body;
    const w1 = c._mk('', 'span'); w1.offsetTop = 400; w1.offsetParent = sc;
    const w0 = c._mk('', 'span'); w0.offsetTop = 0; w0.offsetParent = sc;
    const real = 198 + 400, want = real - c.body.clientHeight * 0.38;
    c.__w0 = w0; c.__w1 = w1;
    c.run('tpVoiceWords = [{ node: __w0 }, { node: __w1 }]; window._tpSyncOn = true; window._tpSyncTargetY = null; tpVoiceScrollTo(1)');
    ok(Math.abs(c._tpSyncTargetY - want) < 0.01, '1 read mode: a recognised word steers to its real place in the body (' + c._tpSyncTargetY + ' vs ' + want + ')');
    ok(c.run('tpWordTop(__w1, document.getElementById("tpBody"))') === real, '1 tpWordTop adds up every offset between the word and the body');
    const d = c._mk('', 'span'); d.offsetTop = real; d.offsetParent = c.body; c.__w2 = d;
    c.run('window._tpSyncOn = false; tpVoiceCursor = 0; tpVoiceWords = [{ node: __w0 }, { node: __w2 }]; tpVoiceScrollTo(1)');
    ok(Math.abs(c.body.scrolledTo - want) < 0.01, '1 phone layout (word measured straight from the body) aims at the same place as before');
    const cssA = html.indexOf('/* ══ READ MODE — the desktop teleprompter (');
    const css = html.slice(cssA, html.indexOf('</style>', cssA));
    const scRules = css.match(/[^{}]*\.tp-script[^{}]*\{[^}]*\}/g) || [];
    ok(scRules.length > 0 && scRules.every(r => !/(^|[\s;{])position\s*:/.test(r.slice(r.indexOf('{')))), '1 the read-mode script is never positioned (offsetTop stays measured from the body)');
    c.closeTeleprompter();
  }

  // ═════════ 6c — close always leaves OUR full screen, whatever the mode ═════════
  {
    let c = sandbox(); c.open(1); c.key('f');
    c.run('tpSwitchToFilm()'); await tick();
    ok(c.document.fullscreenElement === c.ov && !c.isRead(), '2 (read → F → "Film here instead": still full screen, camera mode)');
    c.closeTeleprompter();
    ok(c.document.fullscreenElement === null && c.document.exits === 1, '2 closing from camera mode leaves full screen');
    c = sandbox(); c.ls.set('tp_desktop_mode', 'film'); c.open(1); await tick();
    c.document.fullscreenElement = { _inOverlay: true };
    c.closeTeleprompter();
    ok(c.document.fullscreenElement === null, '2 a child of the overlay in full screen is left too');
    c = sandbox(); c.open(1);
    const other = { id: 'somethingElse' }; c.document.fullscreenElement = other;
    c.closeTeleprompter();
    ok(c.document.fullscreenElement === other && c.document.exits === 0, '2 someone else\'s full screen is not touched');
  }

  // ═════════ 7 — "Film here instead" and back ═════════
  {
    const c = sandbox();
    c.open(1); await tick();
    c.run('tpSwitchToFilm()'); await tick();
    ok(!c.isRead() && c.isOpen() && c.videoAsks() === 1 && c.ls.get('tp_desktop_mode') === 'film', '7 "Film here instead" starts the camera and remembers it');
    ok(c.ov.classList.contains('rm-eligible'), '7 the desktop camera screen offers the "Read mode" switch');
    ok(c.body.sc.style.fontSize === '32px' && !c.body.sc.style.paddingTop, '7 the camera screen gets its own text size back');
    c.closeTeleprompter(); c.open(1); await tick();
    ok(!c.isRead() && c.videoAsks() === 2, '7 the next open on this device goes straight to the camera');
    const stream = c.run('tpCameraStream');
    c.run('tpSwitchToRead()'); await tick();
    ok(c.isRead() && c.ls.get('tp_desktop_mode') === 'read' && c.run('tpCameraStream') === null && stream.tracks[0].readyState === 'ended',
       '7 "Read mode" switches back, stops the camera and remembers it');
    ok(c.videoAsks() === 2 && c.videoInRead() === 0, '7 switching back asks for no video');
    c.closeTeleprompter(); c.open(1); await tick();
    ok(c.isRead() && c.videoAsks() === 2, '7 and the next open is read mode again');
    c.closeTeleprompter();
    c.ls.set('tp_desktop_mode', 'film'); c.open(1); await tick();
    c.run('tpMediaRecorder = { state: "recording" }');
    ok(c.run('tpSwitchToRead()') === false && !c.isRead(), '7 no switching to read mode in the middle of a recording');
    c.run('tpMediaRecorder = null');
  }

  // ═════════ 8 — "Follow me": mic only, off by default ═════════
  {
    const c = sandbox({ voice: true });
    c.open(1); c.clock.advance(2500);
    ok(!c.voiceStarts, '8 voice-follow is off by default in read mode');
    c.run('tpReadVoiceToggle()');
    ok(c.voiceStarts === 1 && c.ls.get('tp_read_voice') === '1' && c.videoAsks() === 0 && c.gum.length === 0, '8 turning it on starts speech recognition only — no getUserMedia at all');
    c.key(' ');
    ok(c.voiceStops >= 1, '8 pausing lets go of the microphone');
    c.closeTeleprompter();
    const n = sandbox({ voice: false }); n.open(1);
    ok(n.els.tpRmVoice.style.display === 'none', '8 the switch is hidden where speech recognition does not exist');
  }

  // ═════════ 2/9/10 — the look and the accessibility contract (source arm over the markup + CSS) ═════════
  {
    const bar = (/<div class="tp-rm-bar" id="tpRmBar"[\s\S]*?\n  <\/div>/.exec(html) || [''])[0];
    const btns = bar.match(/<button\b[^>]*>/g) || [];
    ok(btns.length >= 10 && btns.every(b => /aria-label="[^"]+"/.test(b)), '9 every read-mode button has an aria-label (' + btns.length + ' buttons)');
    for (const fn of ['tpReadToggle()', 'tpReadSpeed(-1)', 'tpReadSpeed(1)', 'tpReadSize(-1)', 'tpReadSize(1)', 'tpReadRestart()', 'tpReadMirror()', 'tpReadFullscreen()', 'tpSwitchToFilm()', 'closeTeleprompter()'])
      ok(bar.includes('onclick="' + fn + '"'), '4 there is a visible button for ' + fn);
    ok(/id="tpToReadBtn"[^>]*onclick="tpSwitchToRead\(\)"|onclick="tpSwitchToRead\(\)"[^>]*id="tpToReadBtn"/.test(html) && /aria-label="Switch to read mode/.test(html), '7 the camera screen has a labelled "Read mode" switch');
    const css = html.slice(html.indexOf('/* ══ READ MODE — the desktop teleprompter ('), html.indexOf('</style>', html.indexOf('/* ══ READ MODE — the desktop teleprompter (')));
    ok(/\.read-mode \.teleprompter-body \.tp-script \{[^}]*max-width: 30ch;[^}]*margin: 0 auto;[^}]*line-height: 1\.35;/.test(css), '10 the column is 30ch, centred, line-height 1.35');
    ok(/clamp\(40px, 4\.2vw, 84px\)/.test(SECTION), '10 the default text size is clamp(40px, 4.2vw, 84px)');
    ok(/\.teleprompter-overlay\.read-mode \{[^}]*background: #000;/.test(css), '10 full-window black background');
    ok(/read-mode \.tp-camera-feed,[\s\S]*?read-mode \.teleprompter-controls,[\s\S]*?\{ display: none !important; \}/.test(css), '2 the camera feed and the Record controls are hidden in read mode');
    ok(/button:focus-visible[^{]*\{[^}]*outline: 2px solid/.test(css), '9 a visible keyboard focus ring');
    ok(/prefers-reduced-motion: reduce\)[\s\S]*tp-countdown\.pop \{ animation: none; \}/.test(css), '9 reduced motion drops the countdown animation');
    ok(/rm-idle \.tp-rm-bar:not\(:has\(:focus-visible\)\) \{[^}]*opacity: 0;/.test(css) && /}, 2500\);/.test(SECTION), '4 the buttons hide after 2.5 s without the mouse (but not while keyboard-focused)');
    ok(!/[\u{1F300}-\u{1FAFF}]/u.test(bar + css), '10 no emoji in the read-mode UI');
  }

  finished = true;
  if (fail) { console.log('TP READ MODE FAILED (' + fail + ')'); process.exit(1); }
  console.log('TP READ MODE OK');
})().catch(e => { console.log('FAIL: crashed —', e && e.stack || e); process.exit(1); });
