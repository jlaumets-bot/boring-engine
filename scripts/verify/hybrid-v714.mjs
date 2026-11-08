#!/usr/bin/env node
// GATE (v714, owner-approved mockup H-hybrid.png, 2026-11-07): the new "Make it yours" main screen (view 'create').
// Contract: .unlazy/hybrid/CONTRACT.md. EXECUTED — the real hybrid block (hy*) and the real helpers it reuses
// (remixPickLink, remixFetchWords, cf* feed, humanErr, escAttr, safeUrl, remixParts, tvOpenTeleprompter …) are lifted out
// of app.html and run in node:vm against a fake DOM, a stubbed fetch and a stubbed clipboard. No network, no AI.
//   1  H1 start renders exactly: the big "Paste TikTok link" button (v722 label + its one-time help line), "New from your creators" (Today / Yesterday, ≤4 rows,
//      "N× usual" chip, "Words ready" dot, "See all"), the bottom input "Paste a link or type an idea…" — no other text;
//      no bar, no hint, no new-chat button yet. Nobody followed → no list at all.
//   2  the paste button reads navigator.clipboard.readText(); a TikTok link runs the paste path (/api/transcribe-url with
//      the brand) and opens the thread: your link bubble → "Here’s what they said" → the words.
//   3  clipboard denied / empty / not a link → no call, the input gets focus and a short hint.
//   4  a feed row whose words are ready opens the thread with NO fetch; a row without words asks the feed once ('transcript').
//   5  a twist posts /api/remix (mode, words, link, creator) and renders "Your version" + the twist; a second twist ADDS a
//      block (both stay); one at a time — a pick while one runs makes no call.
//   6  "Ask for changes" posts /api/revise with the contract body {brandId, current (as /api/remix sent it), instruction,
//      source{transcript, creator, url}, twist}; renders the instruction bubble, "Your version · v2", the v1/v2 toggle and the
//      server's note; a send while one runs makes no call; an error is humanErr's words and the instruction comes back.
//   7  Film it opens the real teleprompter (tvOpenTeleprompter → tpOpenMode) with the SELECTED version; copy copies its script.
//   8  brand switch clears the thread and the feed (a stale feed of the old brand never draws); the thread is kept per brand
//      in localStorage and comes back after a reload; the new-chat icon starts fresh.
//   9  every server and user string (transcript, caption, instruction, note, version) is escaped.
//  10  wiring: the classic layout only in "Classic Make it yours" (menu + sidebar), switchView/switchBrand/composer/pencil
//      hooks, the dock outside .view with safe-area + keyboard (visualViewport) handling, 44px+ targets, Enter sends.
//  11  the v714 teleprompter fixes still hold (runs scripts/verify/tp-fixes-v714.mjs).
//  12  review fixes: (a) a creator row still being read never replaces a newer thread (a hand-off / new chat wins and its
//      running twist is kept); paste / send wait while a row is read. (b) "+ Add creator" on the start screen while fewer
//      than 5 TikTok creators are followed, through the existing add path (fpAdd, max 5); nobody followed → one line + that
//      button. (c) a thread saved mid-read comes back as "Words didn’t finish loading…" + a one-tap retry, never re-fetched
//      on its own. (d) plain text before any version → "Pick a twist first." (the thread is kept); links still start fresh.
// RUN: node scripts/verify/hybrid-v714.mjs        EXPECT: "HYBRID OK", exit 0.
import fs from 'node:fs'; import vm from 'node:vm'; import { spawnSync } from 'node:child_process';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'clean.css'), 'utf8');
setTimeout(() => { console.log('FAIL: wall clock (90s) exceeded'); process.exit(2); }, 90000).unref();
let finished = false; process.on('exit', (code) => { if (!finished && code === 0) { console.log('FAIL: the gate ended before all checks ran'); process.exitCode = 1; } });
let fail = 0; const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fail++; } else console.log('ok:', m); };
const grab = n => {
  let i = html.indexOf('\nfunction ' + n + '('); if (i < 0) i = html.indexOf('\nasync function ' + n + '(');
  if (i < 0) throw new Error('no ' + n + ' in app.html');
  const eol = html.indexOf('\n', i + 1), first = html.slice(i + 1, eol);
  let d = 0, seen = false; for (const ch of first) { if (ch === '{') { d++; seen = true; } else if (ch === '}') d--; }
  if (seen && d === 0) return first;
  return html.slice(i + 1, html.indexOf('\n}', i) + 2);
};
const between = (a, b) => { const i = html.indexOf(a); const j = html.indexOf(b, i); if (i < 0 || j < 0) throw new Error('marker missing: ' + a.slice(0, 40)); return html.slice(i, j); };
const line = re => { const m = re.exec(html); if (!m) throw new Error('missing ' + re); return m[0]; };
const tick = async (n = 14) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const deferred = () => { let res; const p = new Promise(r => { res = r; }); return { p, res }; };
const vis = h => String(h).replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, m => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[m] || ' ')).replace(/\s+/g, ' ').trim();

// ── fake DOM ──
const els = {}; const focuses = []; const listeners = {};
function mk(id) {
  const attrs = {}; const cls = new Set();
  const e = { id, value: '', textContent: '', hidden: false, style: { setProperty() {} }, scrollTop: 0,
    focus() { focuses.push(id); c.document.activeElement = e; }, scrollIntoView() {}, setSelectionRange() {},
    setAttribute(k, v) { attrs[k] = String(v); }, getAttribute(k) { return k in attrs ? attrs[k] : null },
    classList: { add: x => cls.add(x), remove: x => cls.delete(x), toggle: (x, on) => { if (on === undefined ? !cls.has(x) : on) cls.add(x); else cls.delete(x); }, contains: x => cls.has(x) } };
  return e;
}
function host(id) {
  const e = mk(id); els[id] = e; let h = ''; let kids = [];
  Object.defineProperty(e, 'innerHTML', { get: () => h, set: v => {
    h = String(v); for (const k of kids) delete els[k]; kids = [];
    for (const m of h.matchAll(/<(\w+)([^>]*?)\bid="([^"]+)"([^>]*)>/g)) { const k = mk(m[3]); kids.push(m[3]); els[m[3]] = k; }
  } });
  return e;
}
['hyApp', 'hyMain', 'hyBar', 'hyHint', 'hyInLbl', 'hySend', 'hyNewBtn', 'hyDock', 'tpTitle', 'tpBody', 'teleprompterOverlay'].forEach(host);
els.hyIn = mk('hyIn'); els.hyIn.setAttribute('placeholder', 'Paste a link or type an idea…');
const body = mk('body');
// ── stubs ──
let calls = [], route = null, clip = null, written = [], toasts = [], tpOpened = 0, saved = [];
const store = new Map();
const c = {
  console: { log() {}, warn() {}, error() {}, info() {} }, JSON, Promise, Date, Math, String, Number, Array, Object, Set, Map, RegExp, Error, TypeError, isFinite, encodeURIComponent, URL, setTimeout, clearTimeout,
  window: { scrollTo() {}, innerWidth: 390, innerHeight: 844, addEventListener() {}, requestAnimationFrame: f => f(), _remixDelivery: null },
  localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
  navigator: { clipboard: { readText: () => clip(), writeText: t => { written.push(t); return Promise.resolve(); } } },
  document: { getElementById: id => els[id] || null, querySelector: () => null, activeElement: null, body, documentElement: { scrollHeight: 2000, style: { setProperty() {} } },
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); }, createElement: () => mk('x') },
  fetch: async (url, opt) => { const b = opt && opt.body ? JSON.parse(opt.body) : null; calls.push({ url, body: b }); return route(url, b); },
  currentBrand: { id: 'b1' }, activeView: 'create', _switchSeq: 0, remixes: [],
  showToast: t => toasts.push(t), copyFallback: t => written.push('FB:' + t), saveRemixes() {}, renderRemixResults() {},
  saveRemixToIdeas: (i, b) => { saved.push(c.remixes[i]); return true; },
  getBrandContext: () => ({ brandName: 'Acme' }), deliveryReq: () => 'face', deliveryUi: () => 'face', DELIVERY_FORMATS: new Set(['video']),
  leanBrandFetch: (url, base, full) => { if (typeof full !== 'function') throw new Error('no full-brand fallback'); return c.fetch(url, { body: JSON.stringify(base) }); },
  // teleprompter (the real tvOpenTeleprompter runs; its formatting helpers are stand-ins that keep the text visible)
  tpFormatScript: (t) => '<p>' + c.escAttr(t) + '</p>', tpPrimer: () => '', tpSetSmartSpeed() {}, tpFontSize: 30, _tpIdeaId: 5, tpSyncDoneBtn() {},
  tpOpenMode: () => { tpOpened++; return 'film'; }, tpEnsureCamera() { throw new Error('camera without tpOpenMode'); }, tvActiveIdea: () => null, tvNoIdea() {},
  setRemixSource() {}, extractArticle: async () => {}, remixSetSource() {},
  // the creators you follow (Bookmarks): 3 TikTok creators; the real fpAdd / cfFollowedHandles run on them
  bookmarkCategories: [], _fpAdding: false, saveBookmarks() { bmSaves++; }, rerenderBookmarks() {}, renderFollowPanels() {}, cfRender() {}, listLoadFailed: () => false,
};
let bmSaves = 0;
const FOLLOW = (n) => [{ id: 'k1', name: 'Following', entries: ['morningcup', 'studioops', 'calmfounder', 'fourth', 'fifth'].slice(0, n).map((h, i) => ({ id: 'e' + i, name: h, links: { tt: 'https://www.tiktok.com/@' + h } })) }];
c.globalThis = c; vm.createContext(c);
const load = src => vm.runInContext(src, c);
const V = src => vm.runInContext(src, c);
for (const n of ['escAttr', 'escHtml', 'safeUrl', 'nl2br', 'humanErr', 'humanErrCode', 'csBrandRef', 'remixDetectKind', 'remixAbsUrl', 'remixPickLink', 'remixCreatorFromUrl',
  'remixFetchWords', 'remixParts', 'remixCopyText', 'remixHasContent', 'csComposerSource', 'brandGate', 'readJsonOrThrow', '_leanNetFail', '_leanErrMsg',
  'cfShortNum', 'cfAge', 'cfScoreLabel', 'cfHandle', 'cfReady', 'cfSorted', 'cfCall', 'cfApply', 'cfBrandNow', 'cfReset', 'fpHttps', 'tvOpenTeleprompter',
  'cfTtLink', 'cfCreatorTtLink', 'cfFollowedHandles', 'cfAllowLinks', 'cfLoad', 'cfRefresh', 'fpAdd', 'fpNormLink', 'fpPlatOf', 'fpNameFromLink', 'fpCleanNote', 'bmId']) load(grab(n));
for (const n of ['CF_MAX_CREATORS', 'CF_MAX_MSG', 'FP_NOTE_MAX']) load(line(new RegExp('\\nconst ' + n + ' = [^\\n]*')).replace('const ', 'var '));
load(line(/\nconst RX_LINK_MAX_WORDS = [^\n]*/).replace('const ', 'var '));
load(line(/\nconst RX_IG_MSG = [^\n]*/).replace('const ', 'var '));
load(line(/\nconst CF_PASTE_CODES = [^\n]*/).replace('const ', 'var '));
load(line(/\nlet _cf = [^\n]*/).replace('let ', 'var ')); load('var _cfRows = []; var _rxFetching = false;');
{ const m = /\nconst RX_MODES = \[[\s\S]*?\n\];/.exec(html); load(m[0].replace('const ', 'var ')); }
const HY = between('// ===== v714 HYBRID main screen', '// ===== end v714 hybrid =====');
load(HY.replace(/^(let|const) /gm, 'var '));

const now = Date.now();
const WORDS = 'Your first cup decides your whole morning. Most people drink coffee before water <img src=x onerror=alert(1)>.';
const VID = (o) => Object.assign({ likes: 1, comments: 1, shares: 1, durationSec: 30, cover: null, auto: false }, o);
const FEED = () => ({ ok: true, fetchedAt: new Date(now - 3600e3).toISOString(), nextRefreshAt: null, note: null,
  creators: [{ handle: 'morningcup', error: null }, { handle: 'studioops', error: null }, { handle: 'calmfounder', error: null }],
  videos: [
    VID({ videoId: 'v1', handle: 'morningcup', url: 'https://www.tiktok.com/@morningcup/video/7341', caption: 'Your first cup decides your whole morning', views: 184000, postedAt: new Date(now).toISOString(), score: 4.2, transcript: WORDS, transcriptStatus: 'ready' }),
    VID({ videoId: 'v2', handle: 'studioops', url: 'https://www.tiktok.com/@studioops/video/2', caption: 'Stop writing SOPs <b>nobody</b> reads', views: 96000, postedAt: new Date(now).toISOString(), score: 2.1, transcript: null, transcriptStatus: 'none' }),
    VID({ videoId: 'v3', handle: 'calmfounder', url: 'https://www.tiktok.com/@calmfounder/video/3', caption: 'I quit hustle culture for 90 days', views: 212000, postedAt: new Date(now - 86400e3).toISOString(), score: 3.0, transcript: 'I quit.', transcriptStatus: 'ready' }),
    VID({ videoId: 'v4', handle: 'morningcup', url: 'https://www.tiktok.com/@morningcup/video/4', caption: 'Coffee at noon, not at seven', views: 61000, postedAt: new Date(now - 86400e3).toISOString(), score: 1.8, transcript: 'Noon.', transcriptStatus: 'ready' }),
    VID({ videoId: 'v5', handle: 'studioops', url: 'https://www.tiktok.com/@studioops/video/5', caption: 'Fifth', views: 1000, postedAt: new Date(now - 5 * 86400e3).toISOString(), score: 1.0, transcript: 'Five.', transcriptStatus: 'ready' })
  ] });
const resp = (status, obj) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj), json: async () => obj });
const R1 = { remixTitle: 'Water first', remixHook: 'Hot take.', remixScript: "Hot take: it's not the coffee. V1 SCRIPT.", remixCaption: 'cap one', remixHashtags: '#water', remixFormat: 'video' };
const R2 = { remixTitle: 'Flip', remixHook: '', remixScript: 'FLIPPED SCRIPT <script>alert(2)</script>', remixCaption: '', remixHashtags: '', remixFormat: 'video' };
const R3 = { remixTitle: 'Flip v2', remixHook: '', remixScript: 'REVISED V2 SCRIPT', remixCaption: '', remixHashtags: '', remixFormat: 'video' };
const main = () => els.hyMain.innerHTML;
c.bookmarkCategories = FOLLOW(3);
const st = () => V('_hy');
function feedReady() { V('_cf.brandId = "b1"'); c.cfApply(FEED()); }

(async () => {
  // ═══ 1. H1 start ═══
  feedReady();
  c.hyOnView();
  {
    const h = main(), text = vis(h);
    const btns = (h.match(/<button\b/g) || []).length;
    ok(/<button type="button" class="hy-paste" id="hyPasteBig" onclick="hyPaste\(\)">[\s\S]*?<span>Paste TikTok link<\/span><\/button>/.test(h), '1 the big round "Paste TikTok link" button (v722 label)');
    ok(/<h2 class="hy-lt">New from your creators<\/h2>/.test(h) && />See all<\/button>/.test(h), '1 "New from your creators" + "See all"');
    const rows = (h.match(/class="hy-row"/g) || []).length;
    ok(rows === 4 && btns === 1 + 1 + 4 + 1 && /<button type="button" class="hy-add" onclick="hyAddOpen\(\)">\+ Add creator<\/button>/.test(h), '1 four rows (5 videos) + "+ Add creator" (3 of 5 followed): the only buttons (' + btns + ')');
    ok(h.indexOf('>Today<') > 0 && h.indexOf('>Yesterday<') > h.indexOf('>Today<') && !/>Earlier</.test(h), '1 grouped Today / Yesterday');
    ok(/4\.2× usual/.test(h) && /3\.0× usual/.test(h) && /1\.8× usual/.test(h) && (h.match(/class="hy-dot"/g) || []).length === 3, '1 "N× usual" chips and a "Words ready" dot on the 3 ready rows');
    const allowed = ['Paste TikTok link', 'In TikTok: Share → Copy link, then press here.', 'New from your creators', 'See all', 'Today', 'Yesterday', 'Your first cup decides your whole morning', 'Stop writing SOPs <b>nobody</b> reads',
      'I quit hustle culture for 90 days', 'Coffee at noon, not at seven', '@morningcup', '@studioops', '@calmfounder', '4.2× usual', '2.1× usual', '3.0× usual', '1.8× usual', 'Words ready', '+ Add creator'];
    let rest = text; for (const a of allowed.sort((x, y) => y.length - x.length)) rest = rest.split(a).join(' ');
    ok(rest.replace(/\s+/g, '') === '', '1 no other text on the start screen (left over: "' + rest.trim() + '")');
    ok(els.hyBar.hidden === true && els.hyHint.textContent === '' && els.hyNewBtn.hidden === true && els.hyIn.getAttribute('placeholder') === 'Paste a link or type an idea…',
      '1 no sticky bar, no hint, no new-chat button; the input says "Paste a link or type an idea…"');
    ok(/Stop writing SOPs &lt;b&gt;nobody&lt;\/b&gt; reads/.test(h), '9 a caption with markup is escaped');
  }
  // the static markup: the start screen's own words are only these
  {
    const app = between('<section class="hy-app" id="hyApp"', '</section>');
    const dock = between('<div class="hy-dock" id="hyDock">', '\n</div>\n');
    ok(vis(app.replace(/<label[\s\S]*?<\/label>/g, '')) === '' && vis(dock.replace(/<label[\s\S]*?<\/label>/g, '')) === '', '1 the static markup adds no visible words (labels are screen-reader only)');
    ok(/<input type="text" class="hy-in" id="hyIn" placeholder="Paste a link or type an idea…"[^>]*enterkeyhint="send"/.test(dock) && /<form class="hy-input" id="hyForm" onsubmit="event\.preventDefault\(\);window\.hySend\(\);">/.test(dock) && /<button type="submit" class="hy-send"/.test(dock),
      '10 Enter sends (a real form submit), the send button is a submit button');
  }
  c.bookmarkCategories = []; V('_cf.data = { creators: [], videos: [], fetchedAt: null }; _cf.status = "ready";'); c.hyRender();
  ok(vis(main()) === 'Paste TikTok link In TikTok: Share → Copy link, then press here. Follow up to 5 TikTok creators to see their new videos here + Add creator' && /onclick="hyAddOpen\(\)"/.test(main()),
    '12b nobody followed → just one line + "+ Add creator" (no list)');
  c.bookmarkCategories = FOLLOW(5); c.hyRender();
  ok(!/Add creator/.test(main()) && !/Follow up to 5/.test(main()), '12b five followed → no add row');
  c.bookmarkCategories = FOLLOW(3); feedReady(); c.hyRender();

  // ═══ 3. clipboard denied / empty / no link ═══
  calls = []; focuses.length = 0;
  clip = () => Promise.reject(new Error('NotAllowedError'));
  ok(await c.hyPaste() === false && calls.length === 0 && focuses.includes('hyIn') && /Paste the link here/.test(els.hyHint.textContent) && !st().t, '3 clipboard denied → no call, the input gets focus + "Paste the link here."');
  focuses.length = 0; clip = () => Promise.resolve('   ');
  ok(await c.hyPaste() === false && calls.length === 0 && focuses.includes('hyIn') && /clipboard is empty/.test(els.hyHint.textContent), '3 clipboard empty → focus + hint');
  focuses.length = 0; clip = () => Promise.resolve('just some words I copied');
  ok(await c.hyPaste() === false && calls.length === 0 && focuses.includes('hyIn') && /No link/.test(els.hyHint.textContent), '3 clipboard without a link → focus + hint');
  { const saveNav = c.navigator.clipboard; c.navigator.clipboard = undefined; focuses.length = 0;
    ok(await c.hyPaste() === false && focuses.includes('hyIn'), '3 no clipboard API at all → the same fallback'); c.navigator.clipboard = saveNav; }

  // ═══ 2. the paste button reads the clipboard and starts the flow ═══
  calls = []; let read = 0;
  clip = () => { read++; return Promise.resolve('https://www.tiktok.com/@morningcup/video/7341'); };
  route = (url) => url === '/api/transcribe-url' ? resp(200, { transcript: WORDS }) : resp(404, {});
  const pp = c.hyPaste(); await tick();
  ok(read === 1 && calls.length === 1 && calls[0].url === '/api/transcribe-url' && calls[0].body.url === 'https://www.tiktok.com/@morningcup/video/7341' && calls[0].body.brandId === 'b1',
    '2 the paste button read the clipboard once and asked /api/transcribe-url for that link (with the brand)');
  await pp; await tick();
  {
    const h = main();
    ok(/<div class="hy-me hy-me-link">tiktok\.com\/@morningcup\/video\/7341<\/div>/.test(h) && /Here’s what they said/.test(h) && /@morningcup/.test(h), '2 thread: your link bubble → "Here’s what they said" (+ the creator)');
    ok(h.includes('Most people drink coffee before water &lt;img src=x onerror=alert(1)&gt;.') && !/<img/.test(h), '9 the transcript is escaped (no live <img>)');
    ok(/class="hy-clamp"/.test(h) && />Show all/.test(h), '2 the words show 3 lines + "Show all"');
    ok((h.match(/class="hy-pill/g) || []).length === 6 && RX_LABELS().every(l => h.includes('>' + l + '</button>')), '2 "Make it yours" with the 6 twists as buttons');
    ok(els.hyNewBtn.hidden === false && els.hyBar.hidden === true, '2 no version yet → no sticky bar');
    c.hySrcToggle(); ok(/id="hySrcTa"/.test(main()) && els.hySrcTa && els.hySrcTa.value === WORDS, '2 "Show all" opens the words in an editable box (the exact words as its value)');
    c.hySrcEdit(WORDS + ' Edited.'); c.hySrcToggle();
    ok(st().t.src.text === WORDS + ' Edited.', '2 an edit is kept as the source');
  }

  // ═══ 12d. plain text before any version ═══
  ok(els.hyIn.getAttribute('placeholder') === 'Paste another link\u2026', '12d words on screen, no version yet: the input says "Paste another link…"');
  calls = []; els.hyIn.value = 'make it punchy';
  { const before = st().t;
    ok(c.hySend() === false && calls.length === 0 && st().t === before && /Pick a twist first/.test(els.hyHint.textContent) && els.hyIn.value === 'make it punchy',
      '12d plain text before a twist → "Pick a twist first." (thread and text kept, no call)'); }
  els.hyIn.value = ''; c.hyInput();

  // ═══ 5. twists ═══
  calls = [];
  let gate = deferred();
  route = async (url) => { if (url === '/api/remix') { await gate.p; return resp(200, { remix: Object.assign({}, calls.length === 1 ? R1 : R2) }); } return resp(404, {}); };
  const t1 = c.hyTwist('remix'); await tick();
  ok(calls.length === 1 && calls[0].url === '/api/remix' && calls[0].body.remixMode === 'remix' && calls[0].body.postDescription === WORDS + ' Edited.' && calls[0].body.postUrl === 'https://www.tiktok.com/@morningcup/video/7341' && calls[0].body.creatorName === 'morningcup',
    '5 My take posts /api/remix with the mode, the (edited) words, the link and the creator');
  ok(/hy-skel/.test(main()) && /disabled/.test(main().split('class="hy-grid"')[1] || ''), '5 while it writes: a placeholder card, the twists are disabled');
  ok(await c.hyTwist('flip') === false && calls.length === 1 && /One at a time/.test(els.hyHint.textContent), '5 a second pick while one runs makes no call');
  gate.res(); await t1; await tick();
  {
    const h = main();
    ok(/Your version <span class="hy-tag">My take<\/span>/.test(h) && h.includes('V1 SCRIPT') && /class="hy-hook">Hot take\.</.test(h) && /cap one/.test(h) && /#water/.test(h), '5 "Your version · My take" with the existing renderer fields (hook, script, caption, hashtags)');
    ok(/class="hy-pill on" data-twist="remix"/.test(h), '5 the picked twist is highlighted');
    ok(els.hyBar.hidden === false && /onclick="hyFilm\(\)"/.test(els.hyBar.innerHTML) && /onclick="hyCopy\(this\)"/.test(els.hyBar.innerHTML) && els.hyIn.getAttribute('placeholder') === 'Ask for changes…',
      '5 the sticky bar [Film it][copy] appears; the input now says "Ask for changes…"');
    ok(/onclick="hyMenu\(\)"/.test(h), '5 a "⋯" holds the secondary actions');
    c.hyMenu(); ok(/onclick="hySaveIdeas\(this\)">Save to Ideas</.test(main()), '5 "⋯" → Save to Ideas');
    c.hySaveIdeas(null); ok(saved.length === 1 && saved[0].remixScript === R1.remixScript, '5 Save to Ideas saves the selected version through the classic save');
  }
  gate = deferred(); gate.res();
  await c.hyTwist('flip'); await tick();
  {
    const h = main();
    ok((h.match(/>Your version <span class="hy-tag">/g) || []).length === 2 && h.includes('V1 SCRIPT') && h.includes('FLIPPED SCRIPT') && /Flip it<\/span>/.test(h), '5 a second twist ADDS a "Your version" block — the first one stays');
    ok(h.includes('FLIPPED SCRIPT &lt;script&gt;alert(2)&lt;/script&gt;') && !/<script>/.test(h), '9 a version is escaped');
    ok(c.remixes.length >= 2, '5 versions also land in the saved versions list (the classic list)');
  }

  // ═══ 6. Ask for changes → /api/revise ═══
  calls = [];
  gate = deferred();
  const NOTE = 'Kept it under 30 seconds <img src=y onerror=alert(3)>';
  route = async (url) => { if (url === '/api/revise') { await gate.p; return resp(200, { ok: true, result: Object.assign({}, R3), version: 2, note: NOTE }); } return resp(404, {}); };
  els.hyIn.value = 'shorter <b>and</b> more casual';
  const r1 = c.hySend(); await tick();
  {
    const b = calls[0] && calls[0].body;
    ok(calls.length === 1 && calls[0].url === '/api/revise', '6 the instruction posts to /api/revise');
    ok(b && b.brandId === 'b1' && JSON.stringify(b.current) === JSON.stringify(R2) && b.instruction === 'shorter <b>and</b> more casual' && b.twist === 'flip'
      && b.source && b.source.transcript === WORDS + ' Edited.' && b.source.creator === 'morningcup' && b.source.url === 'https://www.tiktok.com/@morningcup/video/7341'
      && Object.keys(b).sort().join() === 'brandId,current,instruction,source,twist', '6 the contract body: brandId, current (exactly as /api/remix sent it), instruction, source{transcript,creator,url}, twist');
    ok(els.hyIn.value === '' && /hy-skel/.test(main()) && main().includes('shorter &lt;b&gt;and&lt;/b&gt; more casual'), '6 busy: the bubble shows at once (escaped), a placeholder for v2');
    els.hyIn.value = 'again';
    ok(c.hySend() === false && calls.length === 1, '6 a send while one runs makes no call');
    ok(await c.hyTwist('series') === false && calls.length === 1, '6 …and neither does a twist');
    els.hyIn.value = '';
  }
  gate.res(); await r1; await tick();
  {
    const h = main();
    ok(/Your version · v2/.test(h) && h.includes('REVISED V2 SCRIPT'), '6 "Your version · v2" with the new version');
    ok(/<span class="hy-seg" role="group" aria-label="Versions"><button type="button" class="hy-segb" aria-pressed="false" onclick="hyPickVersion\(0\)">v1<\/button><button type="button" class="hy-segb on" aria-pressed="true" onclick="hyPickVersion\(1\)">v2<\/button><\/span>/.test(h),
      '6 a v1 / v2 toggle on the latest block, v2 selected');
    ok(h.includes('Kept it under 30 seconds &lt;img src=y onerror=alert(3)&gt;') && /class="hy-note"/.test(h) && !/<img/.test(h), '6 the server note shows as a muted line (escaped)');
    ok((h.match(/class="hy-segb/g) || []).length === 2 && h.indexOf('hy-seg') > h.lastIndexOf('FLIPPED') - 2000, '6 only the latest block carries the toggle');
  }

  // ═══ 7. Film it / copy use the selected version ═══
  tpOpened = 0;
  ok(c.hyFilm() && els.teleprompterOverlay.classList.contains('open') && els.tpBody.innerHTML.includes('REVISED V2 SCRIPT') && tpOpened === 1 && V('_tpIdeaId') === null,
    '7 Film it opens the real teleprompter (tvOpenTeleprompter → tpOpenMode) with v2, not as a saved post');
  els.teleprompterOverlay.classList.remove('open');
  c.hyPickVersion(0);
  ok(/Your version · v1/.test(main()) && /aria-pressed="true" onclick="hyPickVersion\(0\)"/.test(main()), '7 the toggle selects v1');
  c.hyFilm();
  ok(els.tpBody.innerHTML.includes('FLIPPED SCRIPT') && !els.tpBody.innerHTML.includes('REVISED V2'), '7 Film it now reads v1');
  written = []; c.hyCopy();
  ok(written[0] === R2.remixScript, '7 copy copies the selected version\'s script');
  c.hyPickVersion(1); written = []; c.hyCopy(); ok(written[0] === R3.remixScript, '7 …and v2 after switching back');

  // errors through humanErr; the instruction comes back
  route = async () => resp(402, { error: 'limit_reached', code: 'limit_reached' });
  els.hyIn.value = 'make it funnier';
  await c.hySend(); await tick();
  ok(/You've used up this month's posts/.test(vis(main())) && !/limit_reached/.test(main()) && els.hyIn.value === 'make it funnier' && st().busy === '', '6 an error is humanErr\'s words (never the code), the instruction is back in the box, not busy');
  route = async () => { throw new TypeError('Failed to fetch'); };
  await c.hySend(); await tick();
  ok(/connection dropped/.test(main()) && !/Failed to fetch/.test(main()), '6 a dropped connection says so in plain words');
  els.hyIn.value = 'x'.repeat(301); calls = [];
  ok(await c.hySend() === false && calls.length === 0 && /300/.test(els.hyHint.textContent), '6 over 300 characters → a hint, no call');
  els.hyIn.value = '';

  // ═══ 8. persistence, new chat, brand switch ═══
  {
    const saved1 = JSON.parse(store.get('cs_hy_thread::b1') || 'null');
    ok(saved1 && saved1.blocks.length === 2 && saved1.blocks[1].versions.length === 2, '8 the thread is kept in localStorage per brand');
    V('_hy.brandId = ""; _hy.t = null;'); c.hyRender();   // a reload
    ok(main().includes('REVISED V2 SCRIPT') && main().includes('V1 SCRIPT') && /Your version · v2/.test(main()), '8 …and comes back after a reload');
  }
  c.currentBrand = { id: 'b2' }; V('currentBrand = globalThis.currentBrand');
  // a stale feed answer of the OLD brand must never draw on the new one
  V('_cf.brandId = "b1"'); c.hyBrandReset(); V('_cf.brandId = "b1"; _cf.data = ' + JSON.stringify({ creators: FEED().creators, videos: FEED().videos }) + '; _cf.status = "ready";'); c.hyRender();
  ok(!st().t && /Paste TikTok link/.test(main()) && !/V1 SCRIPT/.test(main()) && !/hy-row/.test(main()) && els.hyBar.hidden === true, '8 brand switch clears the thread and the feed (an old-brand feed never draws)');
  ok(store.has('cs_hy_thread::b1'), '8 the other brand\'s thread stays saved for that brand');
  c.currentBrand = { id: 'b1' }; V('currentBrand = globalThis.currentBrand'); c.hyBrandReset();
  ok(/REVISED V2 SCRIPT/.test(main()), '8 back on brand 1 → its own thread');
  c.hyNew();
  ok(!st().t && !store.has('cs_hy_thread::b1') && /Paste TikTok link/.test(main()) && els.hyBar.hidden === true, '8 the new-chat icon starts fresh');

  // ═══ 12c. a thread saved mid-read ═══
  store.set('cs_hy_thread::b1', JSON.stringify({ at: now, open: false, blocks: [], src: { kind: 'tiktok', url: 'https://www.tiktok.com/@morningcup/video/7341', creator: 'morningcup', platform: 'tiktok', text: '', failed: false, empty: true, note: '', reading: true, views: null, score: null } }));
  V('_hy.brandId = ""; _hy.t = null;'); calls = []; c.hyRender();
  ok(vis(main()).includes('Words didn’t finish loading — paste the link again.') && /onclick="hyRetryRead\(\)">Try again</.test(main()) && !/No spoken words/.test(main()) && calls.length === 0 && st().busy === '',
    '12c restored mid-read → "Words didn’t finish loading…" + "Try again", and NO automatic fetch');
  route = (url) => url === '/api/transcribe-url' ? resp(200, { transcript: 'Back again.' }) : resp(404, {});
  await c.hyRetryRead(); await tick();
  ok(calls.length === 1 && calls[0].url === '/api/transcribe-url' && st().t.src.text === 'Back again.' && !st().t.src.interrupted, '12c one tap reads the link again');
  c.hyNew();

  // ═══ 12b. add a creator from the start screen ═══
  feedReady(); c.bookmarkCategories = FOLLOW(3); c.hyRender(); calls = []; bmSaves = 0;
  route = async () => resp(200, FEED());
  c.hyAddOpen();
  ok(/<form class="hy-addf"/.test(main()) && els.hyAddLink && /placeholder="tiktok\.com\/@name"/.test(main()), '12b "+ Add creator" opens a one-line form');
  els.hyAddLink.value = 'not a link';
  ok(c.hyAddCreator() === false && /Paste a TikTok/.test(els.hyAddErr.textContent) && bmSaves === 0, '12b a bad link is refused in words (the existing add path\'s message)');
  els.hyAddLink.value = 'tiktok.com/@newone';
  ok(c.hyAddCreator() === true && c.cfFollowedHandles(null).length === 4 && bmSaves === 1 && !/hy-addf/.test(main()), '12b a TikTok link is saved through the existing add path (fpAdd → saveBookmarks)');
  await tick();
  ok(calls.some(x => x.url === '/api/creator-feed' && x.body.action === 'refresh'), '12b …and the feed refreshes for them');
  c.hyAddOpen(); els.hyAddLink.value = 'https://www.tiktok.com/@fifthone'; c.hyAddCreator(); await tick();
  ok(c.cfFollowedHandles(null).length === 5 && !/Add creator/.test(main()), '12b at 5 the add row is gone (the 5 rule)');
  c.bookmarkCategories = FOLLOW(3);

  // ═══ 4. feed rows ═══
  feedReady(); c.hyRender(); calls = [];
  const iReady = st().rows.findIndex(v => v.videoId === 'v1'), iNone = st().rows.findIndex(v => v.videoId === 'v2');
  ok(await c.hyFeedPick(iReady) === true && calls.length === 0 && st().t && st().t.src.text === WORDS && /184K views/.test(main()) && /4\.2× their usual/.test(main()), '4 a row with words ready opens the thread with NO fetch (creator · views · N× their usual)');
  c.hyNew(); feedReady(); c.hyRender(); calls = [];
  const fg = deferred();
  route = async (url, b) => { if (url === '/api/creator-feed' && b.action === 'transcript') { await fg.p; const f = FEED(); f.videos[1].transcript = 'SOP words'; f.videos[1].transcriptStatus = 'ready'; return resp(200, f); } return resp(404, {}); };
  const iN = st().rows.findIndex(v => v.videoId === 'v2');
  const fp = c.hyFeedPick(iN); await tick(2);
  ok(/Getting the words/.test(main()) && await c.hyFeedPick(iN) === false, '4 the row says "Getting the words…"; a double tap does nothing');
  fg.res(); await fp; await tick();
  ok(calls.length === 1 && calls[0].body.action === 'transcript' && calls[0].body.videoId === 'v2' && st().t && st().t.src.text === 'SOP words', '4 a row without words asks the feed once, then opens the thread');
  // 12a. a row still being read must never replace a newer thread, nor drop the twist running in it
  c.hyNew(); feedReady(); c.hyRender(); calls = [];
  const fg2 = deferred();
  route = async (url, b) => {
    if (url === '/api/creator-feed') { await fg2.p; const f = FEED(); f.videos[1].transcript = 'LATE ROW WORDS'; f.videos[1].transcriptStatus = 'ready'; return resp(200, f); }
    if (url === '/api/remix') return resp(200, { remix: Object.assign({}, R1) });
    return resp(404, {});
  };
  const late = c.hyFeedPick(st().rows.findIndex(v => v.videoId === 'v2')); await tick(2);
  clip = () => Promise.resolve('https://www.tiktok.com/@other/video/9');
  ok(await c.hyPaste() === false && calls.length === 1 && /One at a time/.test(els.hyHint.textContent), '12a paste waits while a creator row is being read (one at a time)');
  els.hyIn.value = 'https://www.tiktok.com/@other/video/9';
  ok(c.hySend() === false && calls.length === 1, '12a …and so does a link sent from the input');
  els.hyIn.value = '';
  c.hyTakeOriginal({ kind: 'trend', url: '', text: 'NEWER THREAD WORDS' });
  await c.hyTwist('remix'); await tick();
  ok(/V1 SCRIPT/.test(main()), '12a a newer thread (a hand-off) gets its version meanwhile');
  fg2.res(); await late; await tick();
  ok(st().t.src.text === 'NEWER THREAD WORDS' && /V1 SCRIPT/.test(main()) && !/LATE ROW WORDS/.test(main()) && st().rowBusy === '', '12a the row\'s late words are dropped: the newer thread and its (charged) version stay');

  // ═══ text → your idea; Instagram; hand-offs ═══
  c.hyNew(); calls = [];
  els.hyIn.value = 'Why I stopped drinking coffee first thing <svg onload=x>';
  await c.hySend();
  ok(calls.length === 0 && st().t && st().t.src.kind === 'text' && !/Here’s what they said/.test(main()) && /class="hy-grid"/.test(main()) && main().includes('&lt;svg onload=x&gt;'), 'plain words → your idea goes straight to the twists (no read call, escaped)');
  route = async (url) => resp(200, { remix: Object.assign({}, R1) }); calls = [];
  await c.hyTwist('tip');   // v716: a typed idea shows the idea twists (Quick tip = mode 'simplify' + its angle line)
  ok(calls[0] && calls[0].body.postDescription.indexOf('MY IDEA: Why I stopped') === 0 && calls[0].body.postUrl === '' && calls[0].body.remixMode === 'simplify', '…and is sent the way the composer sends an idea ("MY IDEA: …")');
  c.hyNew(); els.hyIn.value = 'https://www.instagram.com/reel/abc'; calls = [];
  ok(await c.hySend() === false && calls.length === 0 && /Instagram/.test(els.hyHint.textContent), 'an Instagram link is refused in words, no call');
  ok(c.hyTakeOriginal({ kind: 'trend', url: '', text: 'trend words' }) === true && st().t.src.text === 'trend words', 'a hand-off (Trends → Make it yours) opens a fresh thread here');
  V('_hy.classic = true'); ok(c.hyTakeOriginal({ kind: 'text', text: 'x' }) === false, '…but not while the classic layout is up'); V('_hy.classic = false');

  // ═══ 10. wiring ═══
  ok(/body:not\(\.hy-classic\) #view-create > #createRemix \{ display: none !important; \}/.test(css) && /body\.hy-classic #hyApp \{ display: none !important; \}/.test(css), '10 the old layout shows only in classic mode, nothing removed');
  ok(/\{ act: 'hyClassic', icon: 'create', label: 'Classic Make it yours' \}/.test(html) && /data-act="hyClassic" onclick="hyClassic\(\)"/.test(html), '10 "Classic Make it yours" in the menu (drawer) and the desktop sidebar');
  ok(/try\{ hyOnView\(\); \}catch\(e\)\{\} \}/.test(html) && /if \(typeof hyBrandReset === 'function'\) hyBrandReset\(\);/.test(between('async function switchBrand(', '\nfunction ')), '10 switchView → hyOnView; switchBrand → hyBrandReset');
  ok(/if \(typeof hyActive === 'function' && hyActive\(\)\) \{ hyNew\(\); return; \}/.test(grab('csNewPost')) && /hyActive\(\)\) \{ if \(box\) box\.value = ''; return hyStart\(raw\); \}/.test(grab('csComposerSend')), '10 the header pencil = new chat here; the composer\'s links land in the thread');
  ok(/if \(typeof hyTakeOriginal === 'function' && hyTakeOriginal\(o\)\) return;/.test(grab('remixShowOriginal')) && /hyFeedSoon\(\)/.test(grab('cfRender')), '10 hand-offs and feed redraws reach the hybrid');
  { const vi = html.indexOf('<div class="view" id="view-create">'), ve = html.indexOf('<!-- /view-create -->'), di = html.indexOf('<div class="hy-dock" id="hyDock">');
    ok(di > ve && html.indexOf('<section class="hy-app" id="hyApp"') > vi && html.indexOf('<section class="hy-app" id="hyApp"') < html.indexOf('id="createRemix"'), '10 the hybrid comes first in the view; the fixed dock sits outside .view (its transform would pin it)'); }
  { const rule = sel => [...css.matchAll(new RegExp('(?:^|\\n)' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{([^}]*)\\}', 'g'))].map(m => m[1]).join(';');
    const px = (b, p) => { const m = new RegExp('(?:^|;|\\s)' + p + ':\\s*(\\d+)px').exec(b); return m ? +m[1] : 0; };
    const dock = rule('.hy-dock');
    ok(/bottom: var\(--hy-kb, 0px\)/.test(dock) && /env\(safe-area-inset-bottom\)/.test(dock), '10 the dock sits on the keyboard (--hy-kb) and above the home bar (safe area)');
    ok(/visualViewport/.test(grab('hyWire')) && /--hy-kb/.test(grab('hyWire')), '10 visualViewport feeds --hy-kb');
    const T = { '.hy-pill': 'min-height', '.hy-segb': 'height', '.hy-dots': 'height', '.hy-send': 'height', '.hy-pst': 'height', '.hy-copy': 'height', '.hy-film': 'height', '.hy-more': 'min-height', '.hy-row': 'min-height', '.hy-showall': 'min-height', '.hy-menu button': 'min-height' };
    const small = Object.entries(T).filter(([s, p]) => px(rule(s), p) < 44).map(([s, p]) => s + ' ' + p + ' ' + px(rule(s), p));
    ok(!small.length, '10 every hybrid tap target is ≥44 px (' + (small.join(', ') || 'all') + ')');
    ok(/max-width: 760px/.test(rule('.hy-app')) && /max-width: 760px/.test(rule('.hy-dock-in')) && /function hyAlignDock\(/.test(html), '10 desktop: a centred ~760 px column, the dock lined up under it'); }
  ok(!/\bhyE\(safeUrl/.test(HY) && /escAttr\(safeUrl\(s\.url\)\)/.test(HY), '9 the one link is scheme-checked (safeUrl) and escaped');

  // ═══ 11. teleprompter fixes still hold ═══
  { const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'verify', 'tp-fixes-v714.mjs')], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    ok(r.status === 0 && /TP FIXES OK/.test(r.stdout || ''), '11 tp-fixes-v714 still passes (timer clear of Mark done; voice matcher prefers the nearest match)'); }

  finished = true;
  if (fail) { console.log(fail + ' check(s) failed'); process.exit(1); }
  console.log('HYBRID OK');
})().catch(e => { console.log('FAIL: threw', e && e.stack || e); process.exit(1); });
function RX_LABELS() { return ['My take', 'Simplify', 'Flip it', 'Different format', 'Series', 'Roast &amp; respond']; }
