#!/usr/bin/env node
// GATE: three silent losses on the way from a thought to a filmed take.
//
// WHY THIS EXISTS
//   1. THE IDEA CATCHER KEPT NO DRAFT — in a tool whose whole promise is not losing the idea.
//      #view-idea starts empty and renderIdeaCatcher rebuilds its entire innerHTML on every
//      entry, so the typed idea, the link and the notes died with the discarded DOM nodes, and
//      the line above them (icRefImage = null) threw the attached screenshot away separately.
//      Nothing persisted any of it: no beforeunload anywhere in the file, no sessionStorage, no
//      storage call on icIdea/icNotes/icUrl/icRefImage. Type a paragraph, tap another tab, come
//      back — empty, with no toast, no warning, no undo. The Notebook and Remix screens next to
//      it do not lose anything, and v680 had already shipped a rescue path for DICTATED words
//      after the same re-render ate a transcript. Typed words got nothing.
//   2. THE COACH MIC HAD NO LENGTH CAP, and its failures were silent. recorder.start() takes no
//      timeslice, so the whole clip is base64'd into one JSON body. Measured with ffmpeg on real
//      WebM/Opus against the ~4.5MB serverless cap this repo documents in three places: 128kbps
//      exceeds it at 3.8 min. The recording is then unrecoverable — chunks and blob are closure
//      locals, the tracks are stopped, nothing persists and nothing retries. Worse, the failure
//      path called bvVoiceUnavailable, a once-per-page flag SHARED with the text-to-speech path,
//      so one earlier /api/speak failure made the FIRST mic failure silent too. resp.ok and
//      data.error were never read, so every message the server writes was thrown away.
//   3. EMPHASIS MARKS THAT MATCH NOTHING LEFT THE SCRIPT WITH NO EMPHASIS AT ALL. tpEmphasise
//      branches on marks.length, not on whether anything matched, and returns above the fallback
//      heuristic. Emphasis is applied per rendered line, so a model phrase straddling a
//      tpSenseLines break exists in no single line and can never match — yet it still switches
//      the heuristic off. Measured over every contiguous phrase of three realistic sentences:
//      7% of 2-word marks, 14% of 3-word and 23% of 4-word rendered ZERO emphasis, against 2-3
//      emphasised words when the model sends none at all. Strictly worse than having no marks.
//
// HOW IT CHECKS
//   It RUNS the real functions, lifted from app.html by name, in a vm with a small DOM. Every
//   arm carries its opposite: a draft must restore AND a shipped brief must not resurrect; a
//   mark that DOES match must still win over the heuristic; the cap must stop a take and must
//   never discard one.
//
// RUN:    node scripts/verify/idea-mic-emphasis.mjs
// EXPECT: prints "PASS" and exits 0.
import fs from 'node:fs'; import vm from 'node:vm';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
setTimeout(() => { console.log('FAIL: wall clock (60s) exceeded'); process.exit(2); }, 60000).unref();
let fail = 0; const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fail++; } else console.log('ok:', m); };
const grab = n => {
  let i = html.indexOf('\nfunction ' + n + '('); if (i < 0) i = html.indexOf('\nasync function ' + n + '(');
  if (i < 0) throw new Error('no ' + n);
  const eol = html.indexOf('\n', i + 1), first = html.slice(i + 1, eol);
  let d = 0, seen = false; for (const ch of first) { if (ch === '{') { d++; seen = true; } else if (ch === '}') d--; }
  if (seen && d === 0) return first;
  return html.slice(i + 1, html.indexOf('\n}', i) + 2);
};

// ── 1. the Idea Catcher draft survives leaving and returning ─────────────────
{
  const store = new Map();
  const els = new Map();
  const mkEl = (id) => ({ id, value: '', style: {}, scrollHeight: 100, textContent: '', className: '',
                          innerHTML: '', addEventListener() {}, classList: { add() {}, remove() {} } });
  const c = {
    console, JSON, Date, setTimeout, clearTimeout, Math,
    currentBrand: { id: 'brand-1' },
    icRefImage: null,
    lsSet: (k, v) => store.set(k + '::brand-1', v),
    lsGet: (k) => (store.has(k + '::brand-1') ? store.get(k + '::brand-1') : null),
    lsDel: (k) => store.delete(k + '::brand-1'),
    document: { getElementById: (id) => els.get(id) || null },
  };
  vm.createContext(c);
  vm.runInContext([grab('icDraftSave'), grab('icDraftLoad'), grab('icDraftClear')].join('\n'), c);

  // the user types, and attaches a screenshot
  for (const id of ['icIdea', 'icUrl', 'icNotes']) els.set(id, mkEl(id));
  els.get('icIdea').value = 'Why nobody talks about the boring middle of building a business';
  els.get('icUrl').value = 'https://www.tiktok.com/@x/video/123';
  els.get('icNotes').value = 'use the clip at 0:14, deadpan';
  c.icRefImage = 'data:image/jpeg;base64,PRETEND';
  vm.runInContext('icDraftSave()', c);

  // they leave: renderIdeaCatcher discards every node and nulls the image
  els.clear(); c.icRefImage = null;
  const d = vm.runInContext('icDraftLoad()', c);
  ok(d && d.idea === 'Why nobody talks about the boring middle of building a business',
     'the typed idea survives leaving and returning to the tab (got ' + JSON.stringify(d && (d.idea || '').slice(0, 24)) + ')');
  ok(d && d.url && d.notes, 'so do the reference link and the notes');
  ok(d && d.img === 'data:image/jpeg;base64,PRETEND',
     'and the attached screenshot — restoring the text but silently not the image would be worse than restoring neither');

  // the opposite arm: a shipped brief must NOT come back as a stale draft
  vm.runInContext('icDraftClear()', c);
  ok(vm.runInContext('icDraftLoad()', c) === null, 'a developed brief clears its draft, so it cannot resurrect on the next visit');

  // an all-empty form must not leave a phantom draft behind either
  for (const id of ['icIdea', 'icUrl', 'icNotes']) els.set(id, mkEl(id));
  c.icRefImage = null;
  vm.runInContext('icDraftSave()', c);
  ok(vm.runInContext('icDraftLoad()', c) === null, 'an empty form stores nothing');

  // a corrupt blob must be dropped, not thrown
  store.set('ic_draft::brand-1', '{not json');
  let threw = false;
  try { ok(vm.runInContext('icDraftLoad()', c) === null, 'an unparseable stored draft is dropped'); }
  catch (e) { threw = true; }
  ok(!threw, 'and loading it never throws into the render path');
}

// ── 1b. the render path actually calls them ──────────────────────────────────
{
  const render = grab('renderIdeaCatcher');
  // NB: compare against the MAIN innerHTML assignment (v.innerHTML = `), not the first mention
  // of v.innerHTML in the file — the no-brand early return above it also writes innerHTML.
  ok(/const _draft = icDraftLoad\(\)/.test(render) && render.indexOf('icDraftLoad') < render.indexOf('v.innerHTML = `'),
     'renderIdeaCatcher reads the draft BEFORE the innerHTML that destroys the fields it came from');
  ok(render.indexOf('icDraftLoad') < render.indexOf('icRefImage = null'),
     'and before icRefImage = null, the line that threw the screenshot away separately');
  ok(/refShotSet\('ic', _draft\.img\)/.test(render), 'and puts the screenshot back through refShotSet, so its preview chip returns with it');
  const dev = grab('ideaDevelop');
  ok(/icDraftClear\(\)/.test(dev), 'ideaDevelop clears the draft once the brief is in state');
  // Assert on the LISTENER ITSELF, not on the file: icDraftQueue is named in three places, so
  // a file-wide test still passed with the call deleted from the one listener that fires while
  // the user types — which is the whole bug.
  const listener = (/document\.addEventListener\('input', function\(e\)\{[\s\S]*?\n\}\);/.exec(html) || [''])[0];
  ok(/icIdea/.test(listener) && /icDraftQueue\(\)/.test(listener),
     'the delegated input listener — the only thing that fires while the user types — queues a draft save');
  const urlWire = grab('renderIdeaCatcher');
  ok(/_u\.addEventListener\('input', icDraftQueue\)/.test(urlWire),
     "and #icUrl is wired directly, because it is an <input> and that listener filters on TEXTAREA");
  ok(/if \(kind === 'ic'\)[\s\S]{0,140}icDraftSave\(\)/.test(grab('refShotSet')),
     'attaching a screenshot saves the draft even with no keystroke after it');
}

// ── 2. the coach mic caps itself, and says what went wrong ───────────────────
{
  const src = grab('bvStartMic');
  ok(/_bvMaxMicT = setTimeout/.test(src) && /BV_MAX_MIC_MS/.test(src),
     'bvStartMic arms a hard stop — it was the one mic with no cap, and bvTabDown long-presses straight into it');
  ok(/bvStopMic\(\);/.test(src),
     'the cap calls the ORDINARY stop, so the clip still goes to transcription: the cap stops the take, it never discards it');
  ok(/_bvWarnMicT = setTimeout/.test(src), 'and warns before it fires, rather than cutting the user off mid-sentence');
  ok(/bvState\.recognition !== recorder/.test(src),
     'both timers carry the identity guard, so a stale timer from a finished recording cannot kill a later one');
  ok(/bvClearMicLimit\(\)/.test(grab('bvStopMic')), 'every stop clears the timers');
  const MAX = Number((/const BV_MAX_MIC_MS = (\d+)/.exec(html) || [])[1]);
  const WARN = Number((/const BV_WARN_MIC_MS = (\d+)/.exec(html) || [])[1]);
  ok(MAX > 0 && MAX <= 210000,
     'the cap (' + MAX / 1000 + 's) is inside the measured 3.8-minute worst case at 128kbps, past which the POST is refused and the recording is gone');
  ok(WARN > 0 && WARN < MAX, 'the warning fires before the stop (' + WARN / 1000 + 's < ' + MAX / 1000 + 's)');
  ok(/blob\.size > 3 \* 1024 \* 1024/.test(src), 'and an oversized blob is refused with a message rather than posted into a 413');

  // the failure path must not borrow the text-to-speech flag
  ok(!/bvVoiceUnavailable\(\)/.test(src),
     'a transcription failure no longer calls bvVoiceUnavailable — that flag is set once per page load and is SHARED with ' +
     'bvSpeak, so one earlier /api/speak failure made the FIRST mic failure silent too');
  ok(/bvTranscribeFailed\(/.test(src), 'it calls bvTranscribeFailed instead');
  ok(/resp\.ok && data\.text/.test(src), 'and it reads resp.ok, not just data.text');
  ok(/data\.error \|\|/.test(src), "and surfaces the server's own message — api/transcribe-voice.js writes real ones and they were all discarded");
  // proven by running it: it must speak EVERY time
  {
    const c = { console, toasts: [], String, window: {},
                showToast: (m) => c.toasts.push(m) };
    vm.createContext(c);
    vm.runInContext(grab('bvTranscribeFailed'), c);
    vm.runInContext("bvTranscribeFailed('first'); bvTranscribeFailed('second'); bvTranscribeFailed('third');", c);
    ok(c.toasts.length === 3, 'bvTranscribeFailed speaks on EVERY failure, not once per page (' + c.toasts.length + ' of 3)');
  }
  // the other uncapped mic
  ok(/if \(_nbRec === rec\)[\s\S]{0,60}\}, 60000\)/.test(html), 'nbToggleMic, the only other uncapped mic, now stops at 60s like its six siblings');
}

// ── 3. emphasis that matches nothing must fall back, not vanish ──────────────
{
  const c = { console, String, Array, Math, RegExp, JSON };
  vm.createContext(c);
  for (const n of ['tpEscape', 'tpOutsideTags', 'tpSenseLines', 'tpEmphasise', 'tpFormatScript'])
    vm.runInContext(grab(n), c);
  // tpStressRx is a one-liner; the two word lists are top-level consts. Lifted verbatim, and
  // re-declared with `var` so they land on the vm context rather than staying block-scoped.
  vm.runInContext(grab('tpStressRx'), c);
  for (const m of html.matchAll(/^const (TP_STRESS_[AB]) = .*$/gm)) vm.runInContext(m[0].replace(/^const /, 'var '), c);

  const SCRIPT = 'We never raised our prices for 40 months and the business almost died last winter.';
  const bolded = (emph) => {
    const out = vm.runInContext('tpFormatScript(' + JSON.stringify(SCRIPT) + ', ' + JSON.stringify(emph) + ')', c);
    return (String(out).match(/<b class="tp-em">([^<]*)<\/b>/g) || []).map(x => x.replace(/<[^>]*>/g, ''));
  };
  const none = bolded([]);
  ok(none.length > 0, 'with NO marks the fallback heuristic emphasises something (' + JSON.stringify(none) + ')');

  const straddle = bolded(['for 40 months and the business']);   // spans the sense-line break
  ok(straddle.length > 0,
     'a mark that straddles a line break must not leave the script with NOTHING emphasised — it renders ' +
     JSON.stringify(straddle) + '. Before the fix this was [] while no marks at all gave ' + JSON.stringify(none) +
     ', so supplying marks was strictly worse than supplying none.');

  const good = bolded(['almost died']);
  ok(good.includes('almost died'),
     'a mark that DOES match still wins over the heuristic (' + JSON.stringify(good) + ') — the fix must not turn emphasis off');
  ok(good.length <= 2, 'and the heuristic does not also fire alongside it, which would over-mark (' + JSON.stringify(good) + ')');

  const mixed = bolded(['for 40 months and the business', 'almost died']);
  ok(mixed.includes('almost died'), 'one straddling mark among good ones does not discard the good ones (' + JSON.stringify(mixed) + ')');
}

// ── v690: a full storage quota keeps the WORDS, not a stale older draft ──────
{
  const store = new Map();
  const els = new Map();
  const mkEl = (id) => ({ id, value: '' });
  const c = { console, JSON, Date, Math, String, icRefImage: null,
    // a storage that refuses anything over 5000 characters, the way a full quota refuses a big screenshot
    lsSet: (k, v) => { if (String(v).length > 5000) return false; store.set(k, v); return true; },
    lsGet: (k) => (store.has(k) ? store.get(k) : null),
    lsDel: (k) => store.delete(k),
    document: { getElementById: (id) => els.get(id) || null } };
  vm.createContext(c);
  vm.runInContext([grab('icDraftSave'), grab('icDraftLoad')].join('\n'), c);
  for (const id of ['icIdea', 'icUrl', 'icNotes']) els.set(id, mkEl(id));
  store.set('ic_draft', JSON.stringify({ idea: 'an OLD version of the idea', url: '', notes: '', img: '' }));
  els.get('icIdea').value = 'The newest wording of the idea, typed after attaching a big screenshot';
  c.icRefImage = 'data:image/jpeg;base64,' + 'A'.repeat(20000);
  vm.runInContext('icDraftSave()', c);
  const d = vm.runInContext('icDraftLoad()', c);
  ok(d && d.idea === 'The newest wording of the idea, typed after attaching a big screenshot',
     'with the screenshot too big for storage, the NEW words are kept (' + JSON.stringify(d && d.idea) + '). Text and image ' +
     'were one value, so the refusal took the words down too and left the older draft to be restored');
  ok(d && d.img === '' && d.imgDropped === true, 'and the draft says the picture was dropped, so the screen can ask for it again');
  const r = grab('renderIdeaCatcher');
  ok(/_draft\.imgDropped/.test(r) && /attach it again/.test(r), 'renderIdeaCatcher tells the person to attach the screenshot again');
  c.icRefImage = 'data:image/jpeg;base64,SMALL';
  vm.runInContext('icDraftSave()', c);
  const d2 = vm.runInContext('icDraftLoad()', c);
  ok(d2 && d2.img === 'data:image/jpeg;base64,SMALL' && !d2.imgDropped, 'the opposite arm: a screenshot that fits is kept with the words');
}
// ── v690: the notebook mic says when transcription failed ────────────────────
async function nbRun(answer) {
  const toasts = [];
  const input = { value: '', placeholder: '', focus() {} };
  const btn = { classList: { add() {}, remove() {} } };
  class FakeRec {
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
    static isTypeSupported() { return true; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; try { this.ondataavailable && this.ondataavailable({ data: new Blob(['x']) }); } catch (e) {} this.onstop && this.onstop(); }
  }
  class FakeReader { readAsDataURL() { this.result = 'data:audio/webm;base64,AAAA'; setTimeout(() => this.onloadend(), 0); } }
  const c = { console, JSON, Blob, Promise, String, Date, toasts, _nbRec: null, _micHold: null,
    setTimeout: (fn, ms) => (ms >= 1000 ? 0 : setTimeout(fn, ms)), clearTimeout: () => {},
    MediaRecorder: FakeRec, FileReader: FakeReader,
    brandGate: () => () => true, voiceLogAdd() {}, _micReleaseHandled() {}, _micRelease() {},
    getMicStream: async () => ({ getTracks: () => [{ stop() {} }] }),
    showToast: (m) => toasts.push(String(m)),
    fetch: async () => answer(),
    document: { getElementById: (id) => (id === 'nbInput' ? input : id === 'nbMic' ? btn : null) } };
  vm.createContext(c);
  vm.runInContext(grab('humanErr') + '\n' + grab('nbToggleMic'), c);
  await vm.runInContext('nbToggleMic()', c);   // start
  await vm.runInContext('nbToggleMic()', c);   // stop → transcribe
  await new Promise(r => setTimeout(r, 30));
  return { toasts, input };
}
{
  const failed = await nbRun(() => new Response(JSON.stringify({ error: 'Transcription is not configured on the server.' }), { status: 500 }));
  ok(failed.toasts.length === 1 && failed.toasts[0] === 'Transcription is not configured on the server.',
     'a failed notebook transcription says what the server said (' + JSON.stringify(failed.toasts) + '). It read neither resp.ok ' +
     'nor data.error, so the person talked for up to a minute and got an empty box and no word why');
  const html504 = await nbRun(() => new Response('<html>504</html>', { status: 504 }));
  ok(html504.toasts.length === 1 && /Couldn't turn that into words/.test(html504.toasts[0]),
     'an HTML error page (a platform 413/504) is reported too, not swallowed by resp.json() (' + JSON.stringify(html504.toasts) + ')');
  const good = await nbRun(() => new Response(JSON.stringify({ text: 'hello there' }), { status: 200 }));
  ok(good.toasts.length === 0 && good.input.value === 'hello there',
     'the opposite arm: a good transcription lands in the box with no toast (' + JSON.stringify(good.input.value) + ')');
}

// ── v690 r2: a refused save never leaves an OLDER draft to be restored ───────
{
  for (const [label, refuseAll] of [['storage refuses everything', true], ['storage accepts', false]]) {
    const store = new Map(); const els = new Map();
    const c = { console, JSON, Date, Math, String, icRefImage: null,
      lsSet: (k, v) => { if (refuseAll) return false; store.set(k, v); return true; },
      lsGet: (k) => (store.has(k) ? store.get(k) : null),
      lsDel: (k) => store.delete(k),
      document: { getElementById: (id) => els.get(id) || null } };
    vm.createContext(c);
    vm.runInContext([grab('icDraftSave'), grab('icDraftLoad')].join('\n'), c);
    for (const id of ['icIdea', 'icUrl', 'icNotes']) els.set(id, { id, value: '' });
    store.set('ic_draft', JSON.stringify({ idea: 'OLD words', url: '', notes: '', img: '' }));
    els.get('icIdea').value = 'NEW words typed today';   // no screenshot at all: storage is full of other data
    vm.runInContext('icDraftSave()', c);
    const d = vm.runInContext('icDraftLoad()', c);
    if (refuseAll) ok(d === null,
      label + ': the OLD draft is gone rather than restored in place of the new words (' + JSON.stringify(d && d.idea) + '). ' +
      'Coming back to "OLD words" after typing "NEW words" reads as the app silently undoing their work');
    else ok(d && d.idea === 'NEW words typed today', 'the opposite arm — ' + label + ': the new words replace the old draft');
  }
}
// ── v690 r2: an error response that happens to carry `text` is still an error ─
{
  const r = await nbRun(() => new Response(JSON.stringify({ text: 'partial garbage', error: 'Couldn\'t transcribe your voice — please try again.' }), { status: 502 }));
  ok(r.input.value === '' && r.toasts.length === 1,
     'a 502 whose body also carries `text` is not pasted into the note (' + JSON.stringify(r.input.value) + ') and the failure is said (' + JSON.stringify(r.toasts) + ')');
}

if (fail === 0) console.log('\nPASS — idea-mic-emphasis: the draft survives, the mic stops itself and says why, and marks that miss fall back.');
else { console.log('\n' + fail + ' failure(s)'); process.exitCode = 1; }
