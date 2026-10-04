#!/usr/bin/env node
// GATE (remix-tt, leaf U): Remix one-box shows the ORIGINAL first, then "Make it yours". EXECUTED —
// the real functions lifted from app.html run in node:vm against a fake DOM and a fake fetch.
//   1  TikTok link variants (tiktok.com, www/m, vm., vt., /t/, no scheme, inside share text) and YouTube
//      are detected; "tiktok.com" in another site's query string is not.
//   2  TikTok → /api/transcribe-url; while it runs a progress line says so; the card shows creator, a link
//      back and the transcript BYTE-IDENTICAL in an editable box, with a word count and Copy. Nothing is
//      written until a Step 2 button is pressed. YouTube → /api/transcribe mode youtube. Plain text → same card.
//   3  a refusal shows the server's own sentence, keeps the link in the box (manual form stays shut) and
//      opens the card EMPTY with "or paste the words yourself"; typed words then run like any other.
//   4  an empty transcript says so plainly and asks for a description; Step 2 waits for words.
//   5  Step 2: My take → rv2Start with the EDITED words; Simplify / Flip it / Different format / Series /
//      Roast & respond → /api/remix with that mode and the EDITED words (+ Face-on/Faceless); a second
//      press while one runs is blocked; the mode in the manual form is left as it was.
//   6  every run REPLACES the hidden source (never appends) — Step 2 runs and the article lane.
//   7  classic results: Save to Ideas INSTEAD of Send to Pipeline (pending, postType tip, waits for the DB,
//      undone on failure, once);
//      a Series copies / sends / saves its parts, never empty fields.
//   8  the card's CSS wraps at 375 px and uses theme tokens only; Face-on/Faceless + the optional screenshot
//      sit in a small "Options" fold that stays open across re-renders.
//   9  Trends "Make it mine →" (remixTopPost) puts the post into the Step 1 card, scrolls to it, fetches
//      nothing, leaves the hidden boxes alone until a button is pressed; My take then runs it as a TREND.
//  10  Instagram links: no network call, a plain "not supported yet — paste the spoken words" line,
//      the link kept; the manual article reader refuses them too.
// RUN: node scripts/verify/remix-transcript-ui.mjs      EXPECT: prints "REMIX TRANSCRIPT OK", exit 0.
import fs from 'node:fs'; import vm from 'node:vm';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
setTimeout(() => { console.log('FAIL: wall clock (60s) exceeded'); process.exit(2); }, 60000).unref();
let finished = false; process.on('exit', (code) => { if (!finished && code === 0) { console.log('FAIL: the gate ended before all checks ran'); process.exitCode = 1; } });
let fail = 0; const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fail++; } else console.log('ok:', m); };
const J = v => JSON.stringify(v);
const grab = n => {
  let i = html.indexOf('\nfunction ' + n + '('); if (i < 0) i = html.indexOf('\nasync function ' + n + '(');
  if (i < 0) throw new Error('no ' + n + ' in app.html');
  const eol = html.indexOf('\n', i + 1), first = html.slice(i + 1, eol);
  let d = 0, seen = false; for (const ch of first) { if (ch === '{') { d++; seen = true; } else if (ch === '}') d--; }
  if (seen && d === 0) return first;
  return html.slice(i + 1, html.indexOf('\n}', i) + 2);
};
const between = (a, b) => { const i = html.indexOf(a); const j = html.indexOf(b, i); if (i < 0 || j < 0) throw new Error('marker missing: ' + a.slice(0, 40)); return html.slice(i, j); };
const tick = async (n = 14) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const deferred = () => { let res; const p = new Promise(r => { res = r; }); return { p, res }; };

// ── fake DOM: an element whose innerHTML is set "creates" the children whose ids it names ──
const els = {};
function mk(id, extra) {
  return Object.assign({ id, value: '', innerHTML: '', textContent: '', disabled: false, attrs: {}, style: {},
    classList: { _s: new Set(), add(k) { this._s.add(k); }, remove(k) { this._s.delete(k); }, toggle(k) { this._s.has(k) ? this._s.delete(k) : this._s.add(k); }, contains(k) { return this._s.has(k); } },
    getAttribute(k) { return this.attrs[k]; }, setAttribute(k, v) { this.attrs[k] = String(v); }, scrollIntoView() {}, focus() {}, click() {} }, extra || {});
}
const put = (id, extra) => (els[id] = mk(id, extra));
function host(id) {
  const e = put(id); let h = ''; let kids = [];
  Object.defineProperty(e, 'innerHTML', { get: () => h, set: v => {
    h = String(v); for (const k of kids) delete els[k]; kids = [];
    for (const m of h.matchAll(/\bid="([^"]+)"/g)) { kids.push(m[1]); put(m[1]); }
  } });
  return e;
}
// ── fake fetch ──
const calls = []; let route = () => ({ status: 404, body: { error: 'no route' } });
async function fakeFetch(url, init) {
  const body = init && init.body ? JSON.parse(init.body) : null;
  calls.push({ url, body });
  const r = await route(url, body);
  const txt = typeof r.body === 'string' ? r.body : JSON.stringify(r.body == null ? {} : r.body);
  return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => txt, json: async () => JSON.parse(txt) };
}
const callsTo = u => calls.filter(x => x.url === u);

const toasts = [], copied = [], rv2Calls = [], remixReqs = [];
let saveResult = { ok: true }, saveGate = null, remixGate = null, remixReply = null;
const c = {
  console: { log() {}, warn() {}, error() {}, info() {} }, JSON, Promise, Date, Math, String, Number, Array, Object, Set, Map, WeakSet, RegExp, Error, TypeError, URL,
  window: {}, state: [], IDEAS: [], currentBrand: { id: 'brand-1' }, _switchSeq: 0, currentRemixMode: 'remix', remixes: [], remixRefImage: null,
  document: { getElementById: id => els[id] || null, createElement: () => mk(''), querySelector: () => mk(''), querySelectorAll: () => [] },
  navigator: { clipboard: { writeText: async t => { copied.push(t); } } },
  fetch: fakeFetch, setTimeout: () => 0, clearTimeout() {}, alert: m => toasts.push('ALERT ' + m),
  showToast: m => toasts.push(String(m)), copyFallback: t => copied.push('FALLBACK ' + t), btnWork: () => () => {},
  deliverySegHtml: (cur, fn) => '<span class="DELIV" data-fn="' + fn + '">' + cur + '</span>',
  DELIVERY_FORMATS: new Set(['video', 'micro', 'qna', 'statement']), refShotClear() {}, saveRemixes() { c.__remixSaves = (c.__remixSaves || 0) + 1; },
  getBrandContext: () => ({}), saveState() {}, renderNav() {}, switchView() {}, remixCheckStage2() {},
  saveGeneratedIdeas() { c.__saves = (c.__saves || 0) + 1; return (saveGate ? saveGate.p : Promise.resolve()).then(() => saveResult); },
  leanBrandFetch: async (u, payload) => { remixReqs.push(payload); if (remixGate) await remixGate.p;
    const rep = remixReply || { status: 200, body: { remix: { remixTitle: 'T ' + payload.remixMode, remixHook: 'H', remixScript: 'S', remixFormat: 'video' } } };
    return { ok: rep.status < 300, status: rep.status, json: async () => rep.body }; },
  rv2Start: async (btn) => { rv2Calls.push({ src: c.rv2Source(), mode: c.currentRemixMode }); },
};
c.globalThis = c;
vm.createContext(c);
vm.runInContext(between('// remix-tt — ONE-BOX, ORIGINAL FIRST', '\nfunction remixCheckStage2() {').replace(/^(let|const) /gm, 'var '), c);
for (const n of ['remixTopPost', 'escapeHtml', 'escAttr', 'safeUrl', 'brandGate', 'remixContent', 'rv2Source', 'extractArticle', 'setRemixSource', 'remixToggleManual',
  'renderRemixDelivery', 'remixHasContent', 'renderRemixResults', 'remixParts', 'remixCopyText', 'remixToIdeas', 'copyRemix', 'sendRemixToPipeline', 'saveRemixToIdeas'])
  vm.runInContext(grab(n), c);
{ const m = html.match(/^const _rxSaving = .*$/m); if (!m) throw new Error('no _rxSaving'); vm.runInContext(m[0].replace(/^const /, 'var '), c); }

const TT = 'https://www.tiktok.com/@deskguy.92/video/7312345678901234567';
const TRANSCRIPT = '  So here\'s the thing — 3 desks, <b>one</b> rule & "no" excuses.\n\nPart two:\tstop buying organisers.  ';
const EDITED = 'Edited: one desk, one rule. My words now.';
const card = () => els.remixOrigCard.innerHTML;
const reset = () => {
  calls.length = 0; toasts.length = 0; copied.length = 0; rv2Calls.length = 0; remixReqs.length = 0;
  for (const k of Object.keys(els)) delete els[k];
  host('remixOrigCard'); host('remixResults'); put('remixQuickIn'); put('remixQuickStatus'); put('remixQuickBtn');
  for (const id of ['remixDescription', 'remixPostUrl', 'youtubeUrl', 'articleUrl', 'pasteSourceText', 'remixCreatorName', 'articleStatus', 'sourcePanel-article', 'remixBtn', 'remixDeliverySlot']) put(id);
  put('remixPlatform', { value: 'tiktok' });
  const mp = put('remixManualPanel'); mp.classList.add('remix-manual-hidden');
  saveResult = { ok: true }; saveGate = null; remixGate = null; remixReply = null; c.__saves = 0;
  vm.runInContext('_rxOrig = null; _rxBusy = ""; _rxFetching = false; currentRemixMode = "remix"; state = []; IDEAS = []; remixes = []; window = {};', c);
};
const TTOK = (words) => (u, b) => u === '/api/transcribe-url' ? { status: 200, body: { transcript: words } } : { status: 404, body: { error: 'no route ' + u } };

(async () => {
  // ═══ 1. detection ═══
  {
    const tt = ['https://www.tiktok.com/@a/video/1', 'tiktok.com/@a/video/1', 'https://vm.tiktok.com/ZMabc123/', 'vm.tiktok.com/ZMabc123/', 'https://vt.tiktok.com/ZSabc/',
      'https://www.tiktok.com/t/ZT8abc/', 'tiktok.com/t/ZT8abc/', 'https://m.tiktok.com/v/7312.html', 'HTTPS://VM.TIKTOK.COM/ZMX/'];
    const bad = tt.filter(u => c.remixDetectKind(u) !== 'tiktok' || c.remixPickLink(u).kind !== 'tiktok');
    ok(!bad.length, '1 every TikTok link form is detected (' + (bad.length ? 'missed: ' + bad.join(' ') : tt.length + ' forms') + ')');
    ok(c.remixPickLink('vm.tiktok.com/ZMabc123/').url === 'https://vm.tiktok.com/ZMabc123/', '1 a link pasted without https:// is sent with it');
    const share = c.remixPickLink('Look at this! https://vm.tiktok.com/ZMabc123/ #desk #fyp');
    ok(share.kind === 'tiktok' && share.url === 'https://vm.tiktok.com/ZMabc123/', '1 a TikTok link inside share-sheet text is found (' + J(share) + ')');
    ok(['https://youtu.be/abc', 'https://www.youtube.com/shorts/abc', 'youtube.com/watch?v=abc', 'https://m.youtube.com/watch?v=x'].every(u => c.remixPickLink(u).kind === 'youtube'), '1 YouTube links are detected');
    ok(c.remixDetectKind('https://example.com/post?ref=tiktok.com') === 'article' && c.remixPickLink('https://example.com/a').kind === 'article', '1 another site (even with "tiktok.com" in its query) stays an article link');
    ok(c.remixPickLink('Everyone says post daily. I disagree.').kind === 'text', '1 plain text is text');
  }

  // ═══ 2. TikTok → the exact transcript, first ═══
  reset();
  { const g = deferred(); route = async (u, b) => { await g.p; return TTOK(TRANSCRIPT)(u, b); };
    els.remixQuickIn.value = '  ' + TT + '  ';
    const run = c.remixQuickGo(els.remixQuickBtn); await tick();
    ok(/Getting the words from the TikTok/.test(els.remixQuickStatus.textContent) && /up to a minute/.test(els.remixQuickStatus.textContent), '2 while fetching, a clear progress line (' + J(els.remixQuickStatus.textContent) + ')');
    c.remixQuickGo(els.remixQuickBtn); await tick();
    ok(callsTo('/api/transcribe-url').length === 1, '2 a second tap while it reads does not start a second read');
    g.res(); await run; await tick(); }
  { const tr = callsTo('/api/transcribe-url');
    ok(tr.length === 1 && tr[0].body.url === TT, '2 TikTok words come from /api/transcribe-url with the link');
    const ta = els.rxOrigText;
    ok(ta && ta.value === TRANSCRIPT, '2 the transcript box holds the EXACT words, byte for byte (' + J(ta && ta.value) + ')');
    ok(/Step 1 · The original/.test(card()) && card().includes('@deskguy.92') && card().includes('href="' + TT + '"') && card().includes('target="_blank" rel="noopener"'), '2 the card names the creator and links back to the video');
    ok(!card().includes('<b>one</b>') , '2 the words never go in as HTML');
    const n = TRANSCRIPT.split(/\s+/).filter(Boolean).length;
    ok(card().includes('<span id="rxOrigWords">' + n + ' words</span>'), '2 a word count is shown (' + n + ')');
    ok(/onclick="remixOrigCopy\(\)">Copy</.test(card()), '2 there is a Copy button');
    ok(calls.length === 1 && rv2Calls.length === 0 && remixReqs.length === 0, '2 nothing is written until a Step 2 button is pressed');
    ok(els.remixQuickStatus.textContent === '', '2 the progress line clears');
    const labels = [...card().matchAll(/data-rxmode="([^"]+)"[^>]*>([^<]+)</g)].map(m => m[1] + '=' + m[2]);
    ok(J(labels) === J(['remix=My take', 'simplify=Simplify', 'flip=Flip it', 'format-swap=Different format', 'series=Series', 'roast=Roast &amp; respond']), '2 Step 2 is one row of six choices (' + labels.join(', ') + ')');
    ok(/Step 2 · Make it yours/.test(card()) && els.rxOrigDelivery && /DELIV/.test(els.rxOrigDelivery.innerHTML), '2 the Face-on / Faceless chooser is in the card');
    c.remixOrigCopy(); await tick();
    ok(copied[0] === TRANSCRIPT, '2 Copy copies the exact words');
    els.rxOrigText.value = EDITED; c.remixOrigEdit(EDITED);
    ok(els.rxOrigWords.textContent === '8 words', '2 editing updates the word count (' + els.rxOrigWords.textContent + ')');
    c.remixOrigCopy(); await tick();
    ok(copied[1] === EDITED, '2 Copy copies the edited words'); }
  // YouTube + plain text
  reset(); route = (u, b) => (u === '/api/transcribe' && b.mode === 'youtube') ? { status: 200, body: { text: 'YT words here' } } : { status: 404, body: {} };
  els.remixQuickIn.value = 'https://youtu.be/abc123'; await c.remixQuickGo(els.remixQuickBtn); await tick();
  ok(callsTo('/api/transcribe').length === 1 && callsTo('/api/transcribe')[0].body.url === 'https://youtu.be/abc123' && els.rxOrigText && els.rxOrigText.value === 'YT words here' && /Watch on YouTube/.test(card()),
    '2 YouTube words come from /api/transcribe (mode youtube) into the same card');
  reset(); const PASTED = 'Everyone says post daily.\nI think that is wrong.';
  els.remixQuickIn.value = PASTED; await c.remixQuickGo(els.remixQuickBtn); await tick();
  ok(calls.length === 0 && els.rxOrigText && els.rxOrigText.value === PASTED && !/rx-orig-meta/.test(card()), '2 pasted text goes straight to the card as the original');

  // ═══ 3. errors: the server's words, the link kept ═══
  reset(); const SAID = "Couldn't get the audio from that TikTok (it may be private or region-locked). Paste the spoken words or a short description instead.";
  route = () => ({ status: 500, body: { error: SAID } });
  els.remixQuickIn.value = TT; await c.remixQuickGo(els.remixQuickBtn); await tick();
  ok(els.remixQuickStatus.textContent === SAID, '3 a refusal shows the server\'s own sentence (' + J(els.remixQuickStatus.textContent) + ')');
  ok(els.remixQuickIn.value === TT, '3 the link stays in the box');
  ok(els.remixManualPanel.classList.contains('remix-manual-hidden'), '3 the manual form is not needed (it stays shut)');
  ok(els.rxOrigText && els.rxOrigText.value === '' && els.rxOrigEmpty && /Or paste the words yourself/.test(card()) && /Paste or type what they say/.test(card()) && card().includes('href="' + TT + '"'),
    '3 the card opens EMPTY for typing, says "or paste the words yourself", still links the video');
  ok(callsTo('/api/transcribe-url').length === 1 && rv2Calls.length === 0 && remixReqs.length === 0, '3 nothing else is called (no remix, no charge for a twist)');
  { const r0 = await c.remixRunMode('simplify'); await tick();
    ok(r0 === false && remixReqs.length === 0 && /paste or type the words first/.test(card()), '3 Step 2 waits until words are typed');
    els.rxOrigText.value = 'The words I typed myself.'; await c.remixRunMode('simplify'); await tick();
    ok(remixReqs.length === 1 && remixReqs[0].postDescription === 'The words I typed myself.' && remixReqs[0].remixMode === 'simplify' && remixReqs[0].postUrl === TT, '3 the typed words run like any transcript (link kept as the source) ' + J([remixReqs.length, remixReqs[0] && remixReqs[0].postDescription, remixReqs[0] && remixReqs[0].remixMode, remixReqs[0] && remixReqs[0].postUrl])); }
  reset(); els.remixQuickIn.value = TT;
  route = () => ({ status: 504, body: '<html>An error occurred with your deployment FUNCTION_INVOCATION_TIMEOUT</html>' });
  await c.remixQuickGo(els.remixQuickBtn); await tick();
  ok(/try again in a minute/.test(els.remixQuickStatus.textContent) && !/html|FUNCTION_INVOCATION/i.test(els.remixQuickStatus.textContent) && els.remixQuickIn.value === TT && els.rxOrigText && els.rxOrigText.value === '' && /Or paste the words yourself/.test(card()),
    '3 a non-JSON timeout page becomes a plain sentence, link kept, empty card open');

  // ═══ 4. empty transcript ═══
  reset(); route = TTOK('   ');
  els.remixQuickIn.value = TT; await c.remixQuickGo(els.remixQuickBtn); await tick();
  ok(els.rxOrigEmpty && /no spoken words/.test(card()) && /photo slideshow/.test(card()) && /Type a short description/.test(card()), '4 an empty transcript is said plainly, with a description asked for');
  { const r = await c.remixRunMode('remix'); await tick();
    ok(r === false && rv2Calls.length === 0 && remixReqs.length === 0 && /Type a short description of what it shows first/.test(card()), '4 Step 2 waits for words');
    els.rxOrigText.value = 'Five photos of a messy desk turning tidy.'; await c.remixRunMode('remix'); await tick();
    ok(rv2Calls.length === 1 && rv2Calls[0].src.text === 'Five photos of a messy desk turning tidy.', '4 the typed description is used as the source'); }

  // ═══ 5. Step 2 — each button, the EDITED words ═══
  reset(); route = TTOK(TRANSCRIPT);
  els.remixQuickIn.value = TT; await c.remixQuickGo(els.remixQuickBtn); await tick();
  els.rxOrigText.value = EDITED;           // the person edited the transcript
  await c.remixRunMode('remix', els.remixQuickBtn); await tick();
  ok(rv2Calls.length === 1 && rv2Calls[0].mode === 'remix' && rv2Calls[0].src.text === EDITED && rv2Calls[0].src.url === TT && rv2Calls[0].src.creator === 'deskguy.92' && rv2Calls[0].src.platform === 'tiktok',
    '5 My take → rv2Start with the EDITED words, the link and the creator (' + J(rv2Calls[0] && rv2Calls[0].src).slice(0, 120) + ')');
  ok(remixReqs.length === 0, '5 My take never calls the classic writer');
  c.window._remixDelivery = 'faceless';
  for (const mode of ['simplify', 'flip', 'format-swap', 'series', 'roast']) {
    els.rxOrigText.value = EDITED + ' ' + mode;
    await c.remixRunMode(mode); await tick();
    const p = remixReqs[remixReqs.length - 1];
    ok(p && p.remixMode === mode && p.postDescription === EDITED + ' ' + mode && p.postUrl === TT && p.creatorName === 'deskguy.92' && p.delivery === 'faceless',
      '5 ' + mode + ' → /api/remix in that mode with the EDITED words and Face-on/Faceless (' + J(p && { m: p.remixMode, d: p.postDescription, del: p.delivery }) + ')');
  }
  ok(rv2Calls.length === 1 && remixReqs.length === 5 && c.currentRemixMode === 'remix', '5 one call per press; the manual form\'s mode is left as it was');
  ok(c.remixes.length === 5 && c.remixes[0].remixMode === 'roast', '5 classic results land in the results list');
  // double press
  remixGate = deferred(); els.rxOrigText.value = EDITED;
  const first = c.remixRunMode('simplify'); await tick();
  ok((card().match(/data-rxmode="[^"]+" disabled/g) || []).length === 6 && /Working…/.test(card()), '5 while one runs, all six buttons are disabled and the pressed one says Working…');
  const second = await c.remixRunMode('flip'); const third = await c.remixRunMode('remix');
  ok(second === false && third === false && remixReqs.length === 6 && rv2Calls.length === 1 && toasts.some(t => /One at a time/.test(t)), '5 a second press while one runs is blocked (and says so)');
  remixGate.res(); await first; await tick();
  ok(!/disabled/.test(card()) && els.rxOrigText.value === EDITED, '5 the buttons come back afterwards, the edited words kept');

  // ═══ 6. the source is REPLACED, never appended ═══
  reset(); route = TTOK('FIRST video words');
  els.remixDescription.value = 'STALE text from an earlier, unsaved remix';
  els.remixQuickIn.value = TT; await c.remixQuickGo(els.remixQuickBtn); await tick();
  await c.remixRunMode('remix'); await tick();
  ok(rv2Calls[0].src.text === 'FIRST video words', '6 a stale hidden description never mixes into the first run (' + J(rv2Calls[0].src.text) + ')');
  route = TTOK('SECOND video words');
  els.remixQuickIn.value = 'https://vm.tiktok.com/ZMsecond/'; await c.remixQuickGo(els.remixQuickBtn); await tick();
  await c.remixRunMode('remix'); await tick();
  ok(rv2Calls[1].src.text === 'SECOND video words' && rv2Calls[1].src.url === 'https://vm.tiktok.com/ZMsecond/' && !rv2Calls[1].src.creator, '6 the second run carries ONLY the second source (' + J(rv2Calls[1].src) + ')');
  remixReply = { status: 500, body: { error: 'boom' } };      // a failed classic run leaves its source behind…
  await c.remixRunMode('flip'); await tick();
  remixReply = null; els.rxOrigText.value = 'THIRD words';   // …the next run still replaces it
  await c.remixRunMode('series'); await tick();
  ok(remixReqs[1].postDescription === 'THIRD words', '6 after a failed run the next one still replaces the source (' + J(remixReqs[1].postDescription) + ')');
  // the article lane keeps working, and clears first
  reset(); route = (u) => u === '/api/extract-article' ? { status: 200, body: { text: 'ARTICLE BODY' } } : { status: 404, body: {} };
  els.remixDescription.value = 'STALE';
  els.remixQuickIn.value = 'https://example.com/blog/post'; await c.remixQuickGo(els.remixQuickBtn); await tick();
  ok(callsTo('/api/extract-article').length === 1 && rv2Calls.length === 1 && rv2Calls[0].src.text === '--- ARTICLE TEXT ---\nARTICLE BODY', '6 an article link keeps today\'s path, with the stale source cleared first (' + J(rv2Calls[0] && rv2Calls[0].src.text) + ')');

  // ═══ 7. classic results: Save to Ideas + Series parts ═══
  reset();
  const ONE = { remixTitle: 'Desk rule', remixHook: 'One rule.', remixScript: 'Keep one thing on the desk.', remixCaption: 'cap', remixHashtags: '#desk', remixFormat: 'video', remixMode: 'simplify', creatorName: 'deskguy.92', platform: 'tiktok', postUrl: TT };
  c.remixes = [Object.assign({}, ONE)]; c.renderRemixResults();
  ok(/<button class="primary" onclick="saveRemixToIdeas\(0, this\)">Save to Ideas</.test(els.remixResults.innerHTML) && !/sendRemixToPipeline|Send to Pipeline/.test(els.remixResults.innerHTML),
    '7 each classic result has Save to Ideas (the main button) INSTEAD of Send to Pipeline — one destination');
  saveGate = deferred();
  const sv = c.saveRemixToIdeas(0, mk('b')); const sv2 = c.saveRemixToIdeas(0, mk('b'));
  ok(c.state.length === 1, '7 a double tap on Save to Ideas saves once');
  saveGate.res(); const saved = await sv; await sv2; await tick();
  const id0 = c.state[0];
  ok(id0 && id0.status === 'pending' && id0.postType === 'tip' && id0.title === 'Desk rule' && id0.script === 'Keep one thing on the desk.' && id0.hook === 'One rule.' && id0.isRemix === true && id0.originalCreator === 'deskguy.92' && id0.tags === '#desk',
    '7 Save to Ideas creates a PENDING idea (postType tip) with the remix\'s words (' + J(id0).slice(0, 160) + ')');
  ok(c.__saves === 1 && c.remixes.length === 0 && toasts.some(t => /Saved to Ideas/.test(t)), '7 it goes through saveGeneratedIdeas, leaves the list, and says Saved only after');
  reset(); c.remixes = [Object.assign({}, ONE)]; saveResult = { ok: false };
  const bad = await c.saveRemixToIdeas(0, mk('b')); await tick();
  ok(bad === false && c.state.length === 0 && c.remixes.length === 1 && toasts.some(t => /Couldn't save/.test(t)) && !toasts.some(t => /Saved to Ideas/.test(t)), '7 a failed save takes the idea back out and keeps the remix');
  // series
  const SERIES = { remixMode: 'series', remixTitle: 'Desk week', remixCaption: 'series caption', remixHashtags: '#desk #week', creatorName: 'unknown', platform: 'tiktok',
    seriesParts: [{ partNumber: 1, remixTitle: 'Clear it', remixHook: 'Hook one', remixScript: 'Script one', remixFormat: 'video', suggestedDay: 'Monday' },
      { partNumber: 2, remixTitle: 'Keep it', remixHook: 'Hook two', remixScript: 'Script two', remixFormat: 'carousel', suggestedDay: 'Wednesday' },
      { partNumber: 3, remixTitle: '', remixHook: 'Hook three', remixScript: 'Script three', remixFormat: 'micro', suggestedDay: 'Day 5' }] };
  reset(); c.remixes = [JSON.parse(J(SERIES))];
  c.copyRemix(0); await tick();
  ok(copied.length === 1 && ['Script one', 'Script two', 'Script three', 'Hook one', 'Hook two', 'Hook three', 'Clear it', 'Keep it', 'series caption', '#desk #week'].every(x => copied[0].includes(x)) && !/TITLE: \n/.test(copied[0]),
    '7 Copy Script on a Series copies every part (' + J(copied[0]).slice(0, 120) + '…)');
  c.sendRemixToPipeline(0); await tick();
  ok(c.state.length === 3 && c.state.every(i => i.status === 'filming' && i.approvedAt) && J(c.state.map(i => i.script)) === J(['Script one', 'Script two', 'Script three'])
    && J(c.state.map(i => i.day)) !== J([]) && c.state[0].day === 'Monday' && c.state[1].format === 'carousel' && c.state[2].title === 'Desk week (part 3 of 3)' && c.state.every(i => i.caption === 'series caption'),
    '7 Send to Pipeline on a Series sends each part (' + J(c.state.map(i => i.title)) + ')');
  ok(c.state.every(i => i.originalCreator === ''), '7 an unknown creator is not credited as "unknown"');
  reset(); c.remixes = [JSON.parse(J(SERIES))];
  await c.saveRemixToIdeas(0, mk('b')); await tick();
  ok(c.state.length === 3 && c.state.every(i => i.status === 'pending' && i.postType === 'tip') && J(c.state.map(i => i.hook)) === J(['Hook one', 'Hook two', 'Hook three']) && toasts.some(t => /3 parts saved to Ideas/.test(t)),
    '7 Save to Ideas on a Series saves each part as a pending idea');
  reset(); c.state = [{ title: 'Desk rule', status: 'pending' }]; c.remixes = [Object.assign({}, ONE)];
  await c.saveRemixToIdeas(0, mk('b')); await tick();
  ok(c.state.length === 2 && c.state[1].title === 'Desk rule (2)', '7 a saved remix never takes over an idea with the same title');

  // ═══ 8. layout: wraps at 375 px, theme tokens only ═══
  { const css = [...html.matchAll(/^\s*(\.rx-[^{]*)\{([^}]*)\}/gm)].map(m => ({ sel: m[1].trim(), body: m[2] }));
    const dark = between('[data-theme="dark"] {', '}');
    const used = [...new Set(css.flatMap(r => [...r.body.matchAll(/var\((--[\w-]+)\)/g)].map(m => m[1])))];
    ok(css.length >= 10 && css.every(r => !/#[0-9a-f]{3,8}\b|rgba?\(/i.test(r.body)), '8 the card\'s CSS uses theme tokens only (' + css.length + ' rules)');
    ok(used.length && used.every(v => dark.includes(v + ':')), '8 every token it uses has a dark-mode value (' + used.join(' ') + ')');
    ok(css.some(r => r.sel === '.rx-modes' && /flex-wrap:wrap/.test(r.body)) && css.some(r => r.sel === '.rx-orig' && /max-width:100%/.test(r.body) && /box-sizing:border-box/.test(r.body))
      && css.some(r => r.sel === '.rx-orig .gen-textarea' && /max-width:100%/.test(r.body)) && !css.some(r => /(?:^|;)\s*(?:min-)?width:\s*(\d{3,})px/.test(r.body)), '8 the buttons wrap and nothing is wider than a 375 px screen');
    // the options fold: Face-on / Faceless + the optional screenshot, kept open across re-renders
    reset(); c.remixShowOriginal({ kind: 'text', url: '', creator: '', text: 'abc' });
    ok(/<details class="rx-opts" id="rxOrigOpts" ontoggle="remixOptsToggle\(this\)"><summary>Options · Face-on \/ Faceless, screenshot<\/summary>/.test(card()) && /DELIV/.test(els.rxOrigDelivery.innerHTML) && /onclick="remixOrigShot\(\)">Add a screenshot/.test(card()),
      '8 Face-on / Faceless and the screenshot sit in a small closed "Options" fold');
    { let clicked = 0; put('remixShotInput', { click() { clicked++; } }); c.remixOrigShot(); ok(clicked === 1, '8 "Add a screenshot" opens the existing screenshot picker'); }
    c.remixOptsToggle({ open: true }); c.remixRefImage = 'data:image/png;base64,AAAA'; c.remixOrigRender();
    ok(/<details class="rx-opts" id="rxOrigOpts" open /.test(card()) && /Change the screenshot/.test(card()) && /Screenshot attached/.test(card()) && els.rxOrigText.value === 'abc', '8 the fold stays open on a re-render and says a screenshot is attached');
    c.remixRefImage = null; c.remixOptsToggle({ open: false });
    const qi = html.indexOf('id="remixQuick"'), oc = html.indexOf('<div id="remixOrigCard"></div>'), mp = html.indexOf('id="remixManualPanel"');
    ok(qi > 0 && oc > qi && oc < mp, '8 the card sits right under the one-box, above the manual form'); }

  // ═══ 9. Trends "Make it mine →" lands in the Step 1 card ═══
  reset(); route = (u) => ({ status: 500, body: { error: 'no network expected: ' + u } });
  { const POST = 'Nobody tells you this: <i>tidy</i> desks are a trap & "minimal" setups slow you down. Here is why.';
    const LINK = 'https://www.reddit.com/r/desks/comments/abc/';
    const views = []; let scrolled = 0;
    c.switchView = v => views.push(v);
    c.getTopPosts = () => [{ text: POST, link: LINK }, { text: 'x'.repeat(40), link: 'javascript:alert(1)' }];
    els.remixOrigCard.scrollIntoView = () => { scrolled++; };
    els.remixDescription.value = 'STALE hidden words'; els.pasteSourceText.value = '';
    c.remixTopPost(0); await tick();
    ok(views[0] === 'create' && els.rxOrigText && els.rxOrigText.value === POST, '9 Make it mine opens Remix with the post text in the Step 1 box, exactly (' + J(els.rxOrigText && els.rxOrigText.value).slice(0, 60) + ')');
    ok(scrolled >= 1, '9 the page scrolls to the card');
    ok(/Step 1 · The original/.test(card()) && /From Trends/.test(card()) && card().includes('href="' + LINK + '"') && /See the post/.test(card()) && !card().includes('<i>tidy</i>'), '9 the card says where it came from, links to the post, never renders the words as HTML');
    ok(calls.length === 0 && rv2Calls.length === 0 && remixReqs.length === 0 && els.pasteSourceText.value === '' && els.remixDescription.value === 'STALE hidden words', '9 nothing is fetched, written or filled into hidden boxes before a button is pressed');
    ok(!/Paste a link first/.test(els.remixQuickStatus.textContent), '9 Remix never asks for a link');
    await c.remixRunMode('remix'); await tick();
    ok(rv2Calls.length === 1 && rv2Calls[0].src.kind === 'trend' && rv2Calls[0].src.text === POST && rv2Calls[0].src.url === LINK && !rv2Calls[0].src.creator, '9 My take runs on the post as a TREND, the stale words replaced (' + J(rv2Calls[0] && rv2Calls[0].src).slice(0, 120) + ')');
    els.rxOrigText.value = 'My edit of it'; await c.remixRunMode('flip'); await tick();
    ok(remixReqs.length === 1 && remixReqs[0].postDescription === 'My edit of it' && remixReqs[0].remixMode === 'flip', '9 the other five use the edited words');
    c.remixTopPost(1); await tick();
    ok(els.rxOrigText.value === 'x'.repeat(40) && !/href=/.test(card()), '9 an unsafe post link is dropped, the words still land');
    c.remixShowOriginal({ kind: 'trend', url: 'javascript:alert(1)', creator: '', text: 'words' });
    ok(!/href=|javascript:/i.test(card()) && els.rxOrigText.value === 'words', '9 the card itself never links a javascript: URL');
    c.getTopPosts = () => []; toasts.length = 0; c.remixTopPost(3);
    ok(toasts.some(t => /Could not find that post/.test(t)), '9 a missing post says so'); }

  // ═══ 11. review fixes: a link inside pasted text never takes over; no new paste during a twist ═══
  { const SCRIPT = 'Everyone tells you to post every day. ' + 'Here is why I stopped and what happened to my reach after. '.repeat(15) + 'follow me at instagram.com/mybrand';
    const NOTES = 'Notes for Friday: the hook idea from tiktok.com/@bob was great, open with the messy desk, then the one rule.';
    reset(); route = () => ({ status: 200, body: { transcript: 'SHOULD NOT', text: 'SHOULD NOT' } });
    els.remixQuickIn.value = SCRIPT; await c.remixQuickGo(els.remixQuickBtn); await tick();
    ok(calls.length === 0 && els.remixQuickStatus.textContent !== "Instagram links aren't supported yet — paste the spoken words instead" && els.rxOrigText && els.rxOrigText.value === SCRIPT.trim(),
      '11 a long script that ends with an Instagram link is pasted text, not refused');
    reset(); route = () => ({ status: 200, body: { transcript: 'SHOULD NOT', text: 'SHOULD NOT' } });
    els.remixQuickIn.value = NOTES; await c.remixQuickGo(els.remixQuickBtn); await tick();
    ok(calls.length === 0 && els.rxOrigText && els.rxOrigText.value === NOTES, '11 notes that mention a TikTok link stay the words (no transcript fetch)');
    ok(c.remixPickLink('check this https://vm.tiktok.com/ZMx/').kind === 'tiktok' && c.remixPickLink('Look at this video, so good https://youtu.be/a #fyp #desk #wow').kind === 'youtube'
      && c.remixPickLink('one two three four five six seven eight nine https://vm.tiktok.com/ZMx/').kind === 'text' && c.remixPickLink('https://example.com/a and a few words').kind === 'article',
      '11 a link with a few words (or #tags) is still a link; nine plain words or more is text'); }
  reset(); c.remixShowOriginal({ kind: 'text', url: '', creator: '', text: 'my words' });
  { remixGate = deferred(); const run = c.remixRunMode('series'); await tick();
    els.remixQuickIn.value = 'https://example.com/article'; route = () => ({ status: 200, body: { text: 'ARTICLE' } });
    await c.remixQuickGo(els.remixQuickBtn); await tick();
    ok(calls.length === 0 && toasts.some(t => /Wait for this one to finish first/.test(t)) && els.remixQuickIn.value === 'https://example.com/article', '11 a new paste while a twist runs is held back with a short note (no mixed mode)');
    remixGate.res(); await run; await tick();
    ok(remixReqs.length === 1 && remixReqs[0].remixMode === 'series' && c.currentRemixMode === 'remix', '11 the running twist finishes with its own mode; the shared mode is put back'); }

  // ═══ 10. Instagram: not supported yet, no network call ═══
  { const MSG = "Instagram links aren't supported yet — paste the spoken words instead";
    for (const ig of ['https://www.instagram.com/reel/C9abc/', 'instagram.com/p/xyz/', 'Look https://instagr.am/p/Zq1/ wow', 'HTTPS://M.INSTAGRAM.COM/reel/A/']) {
      reset(); route = (u) => ({ status: 200, body: { text: 'SHOULD NOT BE CALLED', transcript: 'SHOULD NOT' } });
      els.remixQuickIn.value = ig; await c.remixQuickGo(els.remixQuickBtn); await tick();
      ok(calls.length === 0 && els.remixQuickStatus.textContent === MSG && els.remixQuickIn.value === ig && card() === '' && rv2Calls.length === 0 && remixReqs.length === 0,
        '10 ' + J(ig) + ' → no network call, the plain message, link kept (' + J(els.remixQuickStatus.textContent) + ')');
    }
    ok(c.remixDetectKind('https://example.com/a?src=instagram.com') === 'article', '10 "instagram.com" in another site\'s query string is not Instagram');
    ok(c.remixPickLink('https://www.instagram.com/reel/x/ and https://vm.tiktok.com/ZMx/').kind === 'tiktok', '10 a TikTok link next to an Instagram one still wins');
    reset(); route = () => ({ status: 200, body: { text: 'ARTICLE' } });
    els.articleUrl.value = 'https://www.instagram.com/p/abc/'; await c.extractArticle({ target: mk('b') }); await tick();
    ok(calls.length === 0 && els.articleStatus.textContent === MSG && els.remixDescription.value === '', '10 the manual article reader never sends an Instagram link either'); }

  finished = true;
  if (fail) { console.log(fail + ' check(s) failed'); process.exit(1); }
  console.log('REMIX TRANSCRIPT OK');
})().catch(e => { console.log('FAIL: threw', e && e.stack || e); process.exit(1); });
