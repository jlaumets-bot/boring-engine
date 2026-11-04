#!/usr/bin/env node
// GATE (creator-feed v711, owner 2026-11-04: "start with Remix more… creators I follow… remix content more easily").
// "New from your creators" — the FIRST thing on Remix. EXECUTED: the real functions lifted from app.html run in
// node:vm against a fake DOM and a fetch stub that answers with the .unlazy/creator-feed/CONTRACT.md payload.
//   1  the list sits first in Remix (above the banner and Step 1); 'list' fires ONCE per open — re-renders,
//      Bookmarks changes and switchView('create') while already on Remix never refire it; leaving and coming back does.
//   2  rows are sorted (score desc, then newest), top 8 + "Show all N"; each row: @handle, 1-line caption,
//      views short (12.3K / 1.2M), age ("3 d ago"), "N× their usual" only when score ≥ 2, "Transcript ready",
//      "Open on TikTok" (new tab, rel=noopener, https only). Rows are <button>s (keyboard) with 44px+ targets.
//   3  every server string (handle, caption, note, creator error, error message) is escaped, text and attributes.
//   4  tapping a row WITH a transcript fills the Step 1 card (text, creator, link) through remixShowOriginal with NO fetch.
//   5  tapping a row WITHOUT one calls 'transcript' once (a double tap is ignored, the row is busy), then fills
//      the card the same way and the row says "Transcript ready".
//   6  the empty state (no TikTok creators followed, or code no_creators): one line + the existing add path.
//   7  the 6th TikTok creator is refused client-side on every add path (+ Add creator panel, panel edit,
//      Settings → Bookmarks add and link editor); the 5th, a non-TikTok link and re-saving your own link pass.
//   8  Refresh calls 'refresh' and shows the server's note; errors are plain words (humanErr), never codes.
//   9  the feed belongs to ONE brand: a switch (even mid-request) clears the old rows, loads the new brand, drops late answers.
//  10  transcriptStatus 'working' (another tab is transcribing): "Transcribing…", and a tap makes no call.
//  7a  the 5-creator count is the SERVER's rule: api/creator-feed.js followedCreators runs on the same fixtures.
// RUN: node scripts/verify/creator-feed-ui-v711.mjs      EXPECT: prints "CREATOR FEED UI OK", exit 0.
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
const tick = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const deferred = () => { let res; const p = new Promise(r => { res = r; }); return { p, res }; };

// ── fake DOM: setting innerHTML "creates" the children whose ids it names ──
const els = {};
const scrolls = [], focuses = [];
const mk = id => ({ id, value: '', textContent: '', style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, focus() { focuses.push(id); }, scrollIntoView() { scrolls.push(id); } });
function host(id) {
  const e = mk(id); els[id] = e; let h = ''; let kids = [];
  Object.defineProperty(e, 'innerHTML', { get: () => h, set: v => {
    h = String(v); for (const k of kids) delete els[k]; kids = [];
    for (const m of h.matchAll(/<(\w+)([^>]*?)\bid="([^"]+)"([^>]*)>/g)) { const k = mk(m[3]); kids.push(m[3]); els[m[3]] = k; }
  } });
  return e;
}
['creatorFeed', 'remixOrigCard', 'followPanels', 'view-create', 'view-ideas', 'view-today'].forEach(host);
const toasts = [], fpAddOpens = [];
let calls = [], route = null;
const c = {
  console: { log() {}, warn() {}, error() {}, info() {} }, JSON, Promise, Date, Math, String, Number, Array, Object, Set, Map, RegExp, Error, TypeError, isFinite, encodeURIComponent, URL,
  window: {}, currentBrand: { id: 'brand-1' }, bookmarkCategories: [],
  document: {
    getElementById: id => els[id] || null,
    querySelectorAll: () => [],
    querySelector: sel => {
      const card = els.remixOrigCard.innerHTML;
      if (/rx-step-2/.test(sel) && /rx-step-2/.test(card)) return { scrollIntoView() { scrolls.push('step2'); } };
      if (/rx-mode-main/.test(sel) && /rx-mode-main/.test(card)) return { focus(o) { focuses.push('mode-main' + (o && o.preventScroll ? ':noscroll' : '')); } };
      return null;
    },
  },
  showToast: m => toasts.push(m), copyFallback() {}, renderRemixDelivery() {},
  fpAddOpen: () => fpAddOpens.push(1),
  fetch: async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null; calls.push({ url, body });
    const r = await route(url, body);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => (typeof r.body === 'string' ? r.body : J(r.body)) };
  },
  // switchView's neighbours (the real switchView runs)
  VIEW_ORDER: ['today', 'ideas', 'pipeline', 'create', 'notebook'], openDismissPopup: null, openApprovePopup: null,
  renderNav() {}, renderTodayView() {}, renderFilmingQueue() {}, restoreProToolsState() {}, renderStats() {}, renderIdeaFilters() {}, renderIdeas() {},
  renderRemixResults() {}, renderRefGrid() {}, renderFollowPanels() {}, renderFnFaq() {},
  // bookmarks save path is not under test here
  saveBookmarks() { c.__saves = (c.__saves || 0) + 1; }, rerenderBookmarks() {}, renderBookmarkBar() {}, _bmEditingEntry: null,
};
c.globalThis = c;
vm.createContext(c);
vm.runInContext('var activeView = "today"; var _rxOrig = null; var _rxBusy = ""; var _rxFetching = false; var _rxOptsOpen = false; var remixRefImage = null;', c);
vm.runInContext(between('// ===== creator-feed (v711)', '// ===== follow-panels:').replace(/^(let|const) /gm, 'var '), c);
vm.runInContext(between('// ===== follow-panels:', '\nfunction saveBookmarks() {').replace(/^(let|const) /gm, 'var '), c);
{ const m = /\nconst RX_MODES = \[[\s\S]*?\n\];/.exec(html); if (!m) throw new Error('no RX_MODES'); vm.runInContext(m[0].replace('const ', 'var '), c); }
for (const n of ['escHtml', 'escAttr', 'escapeHtml', 'safeUrl', 'humanErr', 'bmId', 'remixShowOriginal', 'remixOrigRender', 'remixCreatorFromUrl',
  'rxWordCount', 'rxWordsLabel', 'switchView', 'renderCreate', 'addBmEntry', 'saveBmLinks']) vm.runInContext(grab(n), c);

// ── the contract payload ──
const NOW = Date.now(), H = 3600e3, D = 24 * H;
const iso = ms => new Date(ms).toISOString();
const XSS_CAP = '<img src=x onerror=alert(1)> best "desk" tip';
const XSS_HANDLE = 'evil"><script>alert(2)</script>';
const vid = (id, handle, score, ageMs, views, extra) => Object.assign({ videoId: id, handle, url: 'https://www.tiktok.com/@' + handle.replace(/[^\w.]/g, '') + '/video/' + id,
  caption: 'Caption for ' + id, views, likes: 10, comments: 2, shares: 1, postedAt: iso(NOW - ageMs), durationSec: 30, cover: null, score,
  transcript: null, transcriptStatus: 'none', auto: false }, extra || {});
const VIDEOS = () => [
  vid('v1', 'ann', 1.2, 2 * D, 999),
  vid('v2', 'bob', 3.46, 3 * D + H, 12345, { transcript: 'Bob said these exact words.', transcriptStatus: 'ready', auto: true }),
  vid('v3', 'cat', 2, 1 * D, 1234567),
  vid('v4', 'dan', 0.8, 5 * D, 400),
  vid('v5', XSS_HANDLE, 1.9, 6 * D, 5000, { caption: XSS_CAP, url: 'javascript:alert(3)' }),
  vid('v6', 'eve', 2, 4 * H, 88000),
  vid('v7', 'ann', 0.5, 9 * D, 120),
  vid('v8', 'bob', 1, 7 * D, 3000),
  vid('v9', 'cat', 1, 8 * D, 2500),
  vid('v10', 'dan', 0.9, 10 * D, 700, { transcript: 'Dan words', transcriptStatus: 'ready' }),
  vid('v11', 'eve', 0.3, 11 * D, 90),
  vid('v12', 'ann', 1.5, 12 * D, 15000),
];
const EXPECT_ORDER = ['v2', 'v6', 'v3', 'v5', 'v12', 'v1', 'v8', 'v9', 'v10', 'v4', 'v7', 'v11'];
const CREATORS = ['ann', 'bob', 'cat', 'dan', 'eve'].map(h => ({ handle: h, profileUrl: 'https://www.tiktok.com/@' + h, note: null, error: null }));
const payload = (over) => Object.assign({ ok: true, fetchedAt: iso(NOW - 3 * H), nextRefreshAt: iso(NOW + 3 * H), creators: CREATORS, videos: VIDEOS(), note: 'Updated 3 hours ago' }, over || {});
const FEED = (over) => async () => ({ status: 200, body: payload(over) });
const feedCalls = a => calls.filter(x => x.url === '/api/creator-feed' && (!a || (x.body && x.body.action === a)));
const F = () => els.creatorFeed.innerHTML;
const rows = () => F().split(/(?=<div class="cf-row[ "])/).slice(1);
const order = () => [...F().matchAll(/data-cf-vid="([^"]+)"/g)].map(m => m[1]);
const rowOf = id => rows().find(r => r.includes('data-cf-vid="' + id + '"')) || '';
const idxOf = id => order().indexOf(id);
const resetFeed = () => vm.runInContext('currentBrand = { id: "brand-1" }; _cf = { brandId: "", status: "idle", data: null, err: "", note: "", noteBad: false, showAll: false, inflight: false, refreshing: false, busy: "", rowErr: {}, seq: 0 }; _cfRows = []; _rxOrig = null; _rxBusy = ""; _rxFetching = false; activeView = "today";', c);
const tt = (i) => ({ id: 'e' + i, name: 'C' + i, links: { tt: 'https://www.tiktok.com/@c' + i } });

(async () => {
  // ═══ 1. first on Remix; 'list' once per open ═══
  { const v = html.indexOf('<div class="create-section active" id="createRemix">'), f = html.indexOf('<div id="creatorFeed" class="cf-wrap"></div>', v),
      b = html.indexOf('<div class="al-banner">', v), q = html.indexOf('<div id="remixQuick"', v), o = html.indexOf('<div id="remixOrigCard"></div>', v);
    ok(v > 0 && f > v && f < b && f < q && f < o && html.slice(v, f).replace(/<div class="create-section active" id="createRemix">/, '').trim() === '' && (html.match(/id="creatorFeed"/g) || []).length === 1,
      '1 the list is the very first thing in Remix, above the banner, the paste box and the Step 1 card'); }
  resetFeed(); calls = []; route = FEED();
  c.switchView('create'); await tick();
  ok(feedCalls().length === 1 && feedCalls('list').length === 1 && J(feedCalls()[0].body) === J({ brandId: 'brand-1', action: 'list' }), '1 opening Remix sends ONE {brandId, action:"list"} (' + J(calls.map(x => x.body)) + ')');
  c.renderCreate(); c.renderCreate(); vm.runInContext('cfRender(); cfRender();', c); c.switchView('create'); await tick();
  ok(feedCalls().length === 1, '1 re-renders and switchView("create") while already on Remix do not refire (' + feedCalls().length + ')');
  c.switchView('ideas'); await tick(); ok(feedCalls().length === 1, '1 leaving Remix sends nothing');
  c.switchView('create'); await tick(); ok(feedCalls('list').length === 2, '1 opening Remix again loads again (' + feedCalls('list').length + ')');
  { // while the list is still on its way, another open never stacks a second request
    resetFeed(); calls = []; const g = deferred(); route = async () => { await g.p; return { status: 200, body: payload() }; };
    c.switchView('create'); await tick();
    ok(/cf-skel/.test(F()) && /Loading their new posts/.test(F()), '1 a loading skeleton while the list is on its way');
    c.switchView('ideas'); c.switchView('create'); await tick();
    ok(feedCalls().length === 1, '1 one feed request at a time'); g.res(); await tick(); }

  // ═══ 2. rows: sorted, chips, top 8 + Show all ═══
  resetFeed(); calls = []; route = FEED(); c.switchView('create'); await tick();
  ok(J(order()) === J(EXPECT_ORDER.slice(0, 8)), '2 top 8 rows, sorted by score then newest (' + order().join(',') + ')');
  ok(/>Show all 12</.test(F()) && /aria-expanded="false"/.test(F()), '2 "Show all 12" for the rest');
  vm.runInContext('cfToggleAll()', c);
  ok(J(order()) === J(EXPECT_ORDER) && />Show fewer</.test(F()), '2 Show all lists every row, in order (' + order().length + ')');
  vm.runInContext('cfToggleAll()', c);
  { const r2 = rowOf('v2'), r3 = rowOf('v3'), r1 = rowOf('v1'), r5 = rowOf('v5'), r6 = rowOf('v6');
    ok(/>@bob</.test(r2) && /class="cf-cap">Caption for v2</.test(r2) && />12\.3K views</.test(r2) && />3 d ago</.test(r2), '2 a row shows @handle, caption, 12.3K views, "3 d ago" (' + r2.slice(0, 400) + ')');
    ok(/>3\.5× their usual</.test(r2) && />2× their usual</.test(r3) && !/their usual/.test(r1) && !/their usual/.test(r5), '2 "N× their usual" only when score ≥ 2 (3.46 → 3.5×, 2 → 2×, 1.9 / 1.2 → none)');
    ok(/>1\.2M views</.test(r3) && />999 views</.test(r1) && />88K views</.test(r6) && />4 h ago</.test(r6), '2 views short form (1.2M, 999, 88K); hours for a fresh post');
    ok(/>Transcript ready</.test(r2) && !/Transcript ready/.test(r1), '2 "Transcript ready" only when the transcript is there');
    ok(/<a class="cf-open" href="https:\/\/www\.tiktok\.com\/@bob\/video\/v2" target="_blank" rel="noopener" aria-label="Open @bob&#39;s video on TikTok"><span>Open<span class="cf-open-long"> on TikTok<\/span> ↗<\/span><\/a>/.test(r2), '2 "Open on TikTok" opens the video in a new tab, rel=noopener; the label is ONE inline box (an inline-flex link would eat the spaces: "Openon TikTok↗")');
    ok(!/<a /.test(r5), '2 a non-https video link gets no link at all');
    ok(rows().every(r => /<button type="button" class="cf-main" onclick="cfPick\(\d+\)"/.test(r)), '2 every row is a real <button> (keyboard: Tab + Enter)');
    ok(/>Updated 3 hours ago</.test(F()) && />Refresh</.test(F()), '2 the server note and a Refresh button'); }
  { const css = [...html.matchAll(/^\s*(\.cf-[^{]*)\{([^}]*)\}/gm)].map(m => ({ sel: m[1].trim(), body: m[2] }));
    const rule = s => (css.find(r => r.sel === s) || {}).body || '';
    ok(css.length >= 20 && css.every(r => !/#[0-9a-f]{3,8}\b|rgba?\(/i.test(r.body)), '2 CSS: theme tokens only, no hard-coded colours (' + css.length + ' rules)');
    ok(/min-height:5\dpx/.test(rule('.cf-main')) && /min-height:44px/.test(rule('.cf-open')) && /min-height:44px/.test(rule('.cf-refresh')) && /min-height:44px/.test(rule('.cf-more')) && /min-height:44px/.test(rule('.cf-add')), '2 tap targets ≥ 44px (row, Open, Refresh, Show all, Add)');
    ok(/white-space:nowrap/.test(rule('.cf-cap')) && /text-overflow:ellipsis/.test(rule('.cf-cap')) && /min-width:0/.test(rule('.cf-main')), '2 the caption is one line with an ellipsis and can shrink'); }

  // ═══ 3. escaping ═══
  vm.runInContext('cfToggleAll()', c);
  { const r5 = rowOf('v5');
    ok(!/<img src=x/.test(F()) && r5.includes('&lt;img src=x onerror=alert(1)&gt; best &quot;desk&quot; tip'), '3 a caption with HTML is shown as text');
    ok(!/<script>alert\(2\)/.test(F()) && r5.includes('@evil&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;'), '3 a handle with HTML is shown as text'); }
  vm.runInContext('cfToggleAll()', c);
  resetFeed(); calls = []; route = FEED({ note: '<b onmouseover=x>hi</b>', creators: CREATORS.concat([{ handle: 'zed"<i>', profileUrl: '', note: null, error: '<svg onload=alert(4)>' }]),
    videos: [vid('x1', 'o\'neil', 2.2, 2 * D, 10)] });
  c.switchView('create'); await tick();
  ok(!/<b onmouseover|<svg onload|<i>/.test(F()) && F().includes('&lt;b onmouseover=x&gt;hi&lt;/b&gt;') && F().includes('&lt;svg onload=alert(4)&gt;'), '3 the note and a creator error are escaped');
  ok(/aria-label="Open @o&#39;neil&#39;s video on TikTok"/.test(F()), '3 attributes use escAttr (quotes escaped)');

  // ═══ 4. a ready row fills the card with no fetch ═══
  resetFeed(); calls = []; route = FEED(); c.switchView('create'); await tick();
  { const n0 = calls.length; scrolls.length = 0; focuses.length = 0;
    const r = await c.cfPick(idxOf('v2'));
    const o = vm.runInContext('_rxOrig', c);
    ok(r === true && calls.length === n0, '4 tapping a row with a transcript makes NO network call');
    ok(o && o.kind === 'tiktok' && o.text === 'Bob said these exact words.' && o.creator === 'bob' && o.url === 'https://www.tiktok.com/@bob/video/v2' && o.platform === 'tiktok', '4 the Step 1 card holds the text, creator and link (' + J(o) + ')');
    ok(/Step 1 · The original/.test(els.remixOrigCard.innerHTML) && els.rxOrigText && els.rxOrigText.value === 'Bob said these exact words.' && /@bob/.test(els.remixOrigCard.innerHTML) && /Watch on TikTok/.test(els.remixOrigCard.innerHTML), '4 the card is the real Step 1 card (remixShowOriginal), words in the box');
    ok(scrolls.includes('step2') && focuses.includes('mode-main:noscroll'), '4 then it goes to Step 2 (scroll + focus on "My take")'); }
  { vm.runInContext('_rxBusy = "simplify"', c); const n0 = calls.length; vm.runInContext('_rxOrig = null', c);
    const r = await c.cfPick(idxOf('v2'));
    ok(r === false && vm.runInContext('_rxOrig', c) === null && calls.length === n0 && /Wait for this one/.test(toasts[toasts.length - 1] || ''), '4 while a Step 2 run is working, a tap waits (like the paste box)');
    vm.runInContext('_rxBusy = ""', c); }

  // ═══ 5. a row without a transcript: 'transcript' once, busy, then fill ═══
  { calls = []; const g = deferred();
    route = async (u, b) => { await g.p; const vs = VIDEOS().map(v => v.videoId === 'v3' ? Object.assign(v, { transcript: 'Cat words, exactly.', transcriptStatus: 'ready' }) : v); return { status: 200, body: payload({ videos: vs }) }; };
    const p1 = c.cfPick(idxOf('v3')); await tick();
    const t0 = toasts.length;
    const p2 = c.cfPick(idxOf('v3')); await tick();
    ok(toasts.length === t0, '5 a double tap on the busy row is silent (no "wait" toast) — the row itself is the busy guard');
    ok(feedCalls('transcript').length === 1 && J(feedCalls('transcript')[0].body) === J({ brandId: 'brand-1', action: 'transcript', videoId: 'v3' }), '5 one {action:"transcript", videoId} call (' + J(calls.map(x => x.body)) + ')');
    ok(await p2 === false, '5 a double tap is ignored');
    ok(/Getting the words…/.test(rowOf('v3')) && /class="cf-main"[^>]*disabled aria-busy="true"/.test(rowOf('v3')) && /cf-busy/.test(rowOf('v3')), '5 the row shows a busy state and is disabled');
    ok(vm.runInContext('_rxFetching', c) === true, '5 the paste box knows a read is running (one at a time)');
    g.res(); const r1 = await p1; await tick();
    const o = vm.runInContext('_rxOrig', c);
    ok(r1 === true && o && o.text === 'Cat words, exactly.' && o.creator === 'cat' && o.url === 'https://www.tiktok.com/@cat/video/v3', '5 then the card is filled the same way (' + J(o && o.text) + ')');
    ok(/Transcript ready/.test(rowOf('v3')) && !/Getting the words/.test(rowOf('v3')) && vm.runInContext('_rxFetching', c) === false, '5 the row now says "Transcript ready"');
    const n0 = calls.length; await c.cfPick(idxOf('v3'));
    ok(calls.length === n0, '5 tapping it again is free (no call)'); }
  { calls = []; route = async () => ({ status: 502, body: { error: 'transcribe_failed', code: 'transcribe_failed' } });
    vm.runInContext('_rxOrig = null', c);
    const r = await c.cfPick(idxOf('v1'));
    ok(r === false && vm.runInContext('_rxOrig', c) === null && /Couldn&#39;t get the words from that TikTok|Couldn't get the words from that TikTok/.test(rowOf('v1')) && !/transcribe_failed/.test(F()), '5 a failed transcript says so in plain words on the row, never the code');
    ok(!/Getting the words/.test(rowOf('v1')) && vm.runInContext('_cf.busy', c) === '', '5 and the row is usable again'); }

  // ═══ 6. empty state ═══
  for (const [label, rt] of [['creators: []', FEED({ creators: [], videos: [], note: null })], ['code no_creators', async () => ({ status: 400, body: { error: 'Follow a TikTok creator first.', code: 'no_creators' } })]]) {
    resetFeed(); calls = []; c.bookmarkCategories = []; route = rt; fpAddOpens.length = 0;
    c.switchView('create'); await tick();
    ok(/Follow up to 5 TikTok creators to see their new posts here/.test(F()) && /onclick="cfAddCreator\(\)"/.test(F()) && !/cf-row/.test(F()) && !/>Refresh</.test(F()), '6 empty state (' + label + '): one line + "Add a creator", no rows');
    vm.runInContext('_fpAdding = false; cfAddCreator()', c);
    ok(vm.runInContext('_fpAdding', c) === true && scrolls.includes('followPanels'), '6 "Add a creator" opens the existing + Add creator panel (' + label + ')');
  }

  // ═══ 7. max 5 TikTok creators — the server's ONE creator rule, mirrored ═══
  { // 7a the client's count IS the server's: api/creator-feed.js followedCreators runs on the same fixtures
    const api = fs.readFileSync(path.join(ROOT, 'api', 'creator-feed.js'), 'utf8');
    const fnSrc = n => { const i = api.indexOf('\nfunction ' + n + '('); if (i < 0) throw new Error('no ' + n + ' in api/creator-feed.js'); return api.slice(i + 1, api.indexOf('\n}', i) + 2); };
    const sv = vm.createContext({ URL, Set, Array, Object, String, Math, JSON, C: { MAX_CREATORS: 5 }, MSG: { notTiktokHandle: 'x' } });
    vm.runInContext("const clean = (v, max) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim().slice(0, max);\n" + ['tiktokLink', 'creatorTiktokLink', 'followedCreators'].map(fnSrc).join('\n'), sv);
    const FIX = [
      [{ id: 'k', name: 'A', entries: [1, 2, 3, 4, 5, 6, 7].map(tt) }],
      [{ id: 'k', name: 'A', entries: [
        { id: 'a', name: 'a', links: { ig: 'https://www.instagram.com/x', web: 'tiktok.com/@WebOnly/video/1' } },
        { id: 'b', name: 'b', links: { tt: 'https://vm.tiktok.com/ZMabc/', web: 'https://www.tiktok.com/@notused' } },
        { id: 'c', name: 'c', links: { tt: '@bare', yt: 'https://youtube.com/@x' } },
        { id: 'd', name: 'd', links: { tt: 'http://m.tiktok.com/@Dupe' } }, { id: 'e', name: 'e', links: { tt: 'https://www.tiktok.com/@dupe/video/9' } },
        { id: 'f', name: 'f', links: { tt: 'https://evil.com/tiktok.com/@no' } }, { id: 'g', name: 'g', links: { tt: 'https://www.tiktok.com:8443/@port' } },
        { id: 'h', name: 'h', links: { li: 'https://www.tiktok.com/@li.first', tt: 'nonsense' } }, null, { id: 'i', name: 'i' } ] },
       { id: 'k2', name: 'B', entries: [tt(8), tt(9), tt(10), tt(11)] }],
      [],
    ];
    const bad = FIX.filter(cats => { c.bookmarkCategories = JSON.parse(J(cats)); const mine = c.cfFollowedHandles(null).slice(0, 5); const theirs = sv.followedCreators(JSON.parse(J(cats))).handles; return J(mine) !== J(theirs); });
    c.bookmarkCategories = JSON.parse(J(FIX[1]));
    ok(!bad.length && J(c.cfFollowedHandles(null)) === J(['webonly', 'dupe', 'li.first', 'c8', 'c9', 'c10', 'c11']),
      '7 the client counts creators exactly like the server (other fields, nameless share links, dedupe, bookmark order): ' + J(c.cfFollowedHandles(null))); }
  { const five = () => [{ id: 'k1', name: 'Following', entries: [1, 2, 3, 4, 5].map(tt).concat([{ id: 'ig1', name: 'Insta', links: { ig: 'https://www.instagram.com/x' } }]) }];
    const MSG = 'You can follow up to 5 creators. Remove one first.';
    const count = () => c.bookmarkCategories[0].entries.length;
    // + Add creator panel
    c.bookmarkCategories = five(); c.__saves = 0;
    els.fpAddLink = mk('fpAddLink'); els.fpAddNote = mk('fpAddNote'); els.fpAddErr = mk('fpAddErr');
    els.fpAddLink.value = 'https://www.tiktok.com/@sixth';
    ok(c.fpAdd() === false && count() === 6 && els.fpAddErr.textContent === MSG && !c.__saves, '7 + Add creator: a 6th TikTok creator is refused with the plain sentence');
    els.fpAddLink.value = 'tiktok.com/@C3/video/1'; els.fpAddErr.textContent = '';
    ok(c.fpAdd() === true, '7 a creator you already follow is not a 6th (handles compare lowercase)');
    c.bookmarkCategories = five(); els.fpAddLink.value = 'https://vm.tiktok.com/ZMshare/';
    ok(c.fpAdd() === true, '7 a share link with no @name does not count (the server lists it apart)');
    c.bookmarkCategories = five(); els.fpAddLink.value = 'https://www.instagram.com/someone';
    ok(c.fpAdd() === true, '7 an Instagram link is never counted');
    c.bookmarkCategories = five(); c.bookmarkCategories[0].entries.splice(4, 1); els.fpAddLink.value = 'https://www.tiktok.com/@fifth';
    ok(c.fpAdd() === true && c.cfFollowedHandles(null).length === 5, '7 the 5th TikTok creator is allowed');
    // Settings → Bookmarks: add row
    c.bookmarkCategories = five(); toasts.length = 0; els.bmNewEntry_k1 = mk('bmNewEntry_k1'); els.bmNewEntry_k1.value = 'https://www.tiktok.com/@sixth';
    c.addBmEntry('k1');
    ok(count() === 6 && toasts.includes(MSG), '7 Settings → Bookmarks "+ Add" with a 6th TikTok link is refused');
    // Settings → Bookmarks: link editor — a TikTok profile link in ANY field counts (server rule)
    c.bookmarkCategories = five(); toasts.length = 0;
    for (const k of ['ig', 'tt', 'yt', 'li', 'x', 'web']) { els['bmLink_ig1_' + k] = mk('bmLink_ig1_' + k); }
    els['bmLink_ig1_ig'].value = 'https://www.instagram.com/x'; els['bmLink_ig1_web'].value = 'https://www.tiktok.com/@sixth';
    c.saveBmLinks('k1', 'ig1');
    ok(!c.bookmarkCategories[0].entries[5].links.web && toasts.includes(MSG), '7 the link editor refuses a 6th creator even in the Website field');
    els['bmLink_ig1_web'].value = ''; els['bmLink_ig1_tt'].value = '@sixth'; toasts.length = 0;
    c.saveBmLinks('k1', 'ig1');
    ok(!toasts.length && c.bookmarkCategories[0].entries[5].links.tt === '@sixth', '7 a bare "@name" is not a TikTok link to the server, so it is not blocked either');
    // re-saving your own TikTok link (only the note changed) always passes
    c.bookmarkCategories = five(); toasts.length = 0;
    els['bmLink_e2_tt'] = mk('bmLink_e2_tt'); els['bmLink_e2_tt'].value = 'https://www.tiktok.com/@c2'; els['bmNote_e2'] = mk('bmNote_e2'); els['bmNote_e2'].value = 'great hooks';
    c.saveBmLinks('k1', 'e2');
    ok(!toasts.length && c.bookmarkCategories[0].entries[1].note === 'great hooks', '7 re-saving a followed creator (note only) is never blocked');
    // the panel's own editor: giving a non-TikTok entry a 6th TikTok link
    c.bookmarkCategories = five(); c.renderFollowPanels = () => {};
    vm.runInContext('_fpItems = []; bookmarkCategories.forEach(cat => cat.entries.forEach(e => _fpItems.push({ catId: cat.id, entId: e.id, name: e.name, note: "", best: fpBest(e.links) })));', c);
    vm.runInContext('_fpEdit = fpKeyAt(5)', c);
    els.fpEditLink = mk('fpEditLink'); els.fpEditNote = mk('fpEditNote'); els.fpEditErr = mk('fpEditErr'); els.fpEditLink.value = 'https://www.tiktok.com/@sixth';
    ok(c.fpSaveEdit() === false && els.fpEditErr.textContent === MSG && !c.bookmarkCategories[0].entries[5].links.tt, '7 the panel editor refuses a 6th TikTok link');
    vm.runInContext('_fpEdit = fpKeyAt(0)', c); els.fpEditLink.value = 'https://www.tiktok.com/@c1-new'; els.fpEditErr.textContent = '';
    ok(c.fpSaveEdit() === true && c.bookmarkCategories[0].entries[0].links.tt === 'https://www.tiktok.com/@c1-new', '7 replacing a followed creator\'s own TikTok link passes'); }

  // ═══ 9. the feed belongs to one brand ═══
  c.bookmarkCategories = [];
  { resetFeed(); calls = []; c.currentBrand = { id: 'brand-A' };
    const gA = deferred(), gB = deferred();
    route = async (u, b) => { if (b.brandId === 'brand-A') { await gA.p; return { status: 200, body: payload({ videos: [vid('A1', 'annA', 3, D, 10)] }) }; } await gB.p; return { status: 200, body: payload({ videos: [vid('B1', 'bobB', 3, D, 10)] }) }; };
    c.switchView('create'); await tick();
    c.currentBrand = { id: 'brand-B' }; c.renderCreate(); await tick();
    ok(feedCalls('list').length === 2 && feedCalls('list')[1].body.brandId === 'brand-B', '9 a brand switch on Remix starts a fresh list for the new brand at once, even while the old one is on its way (' + J(feedCalls().map(x => x.body.brandId)) + ')');
    ok(/cf-skel/.test(F()) && !/annA/.test(F()), '9 and shows the loading skeleton, not the old brand');
    gA.res(); await tick();
    ok(!/annA|A1/.test(F()) && /cf-skel/.test(F()), '9 the old brand\'s late answer is dropped');
    gB.res(); await tick();
    ok(J(order()) === J(['B1']) && /@bobb/i.test(F()), '9 then the new brand\'s rows show (' + order().join(',') + ')'); }
  { resetFeed(); calls = []; c.currentBrand = { id: 'brand-A' }; route = FEED({ videos: [vid('A1', 'annA', 3, D, 10)] });
    c.switchView('create'); await tick(); c.switchView('ideas');
    c.currentBrand = { id: 'brand-B' }; c.renderCreate(); await tick();
    ok(F() === '' && feedCalls('list').length === 1, '9 off Remix, a brand switch just clears the old rows (no request)');
    route = FEED({ videos: [vid('B1', 'bobB', 3, D, 10)] }); c.switchView('create'); await tick();
    ok(feedCalls('list').length === 2 && feedCalls('list')[1].body.brandId === 'brand-B' && J(order()) === J(['B1']), '9 opening Remix loads the new brand');
    c.currentBrand = { id: 'brand-1' }; }

  // ═══ 10. 'working': another tab is transcribing ═══
  { resetFeed(); calls = []; toasts.length = 0; route = FEED({ videos: [vid('w1', 'wendy', 3, D, 10, { transcriptStatus: 'working' })] });
    c.switchView('create'); await tick();
    ok(/>Transcribing…</.test(rowOf('w1')) && !/Transcript ready/.test(rowOf('w1')), '10 a "working" row says "Transcribing…"');
    const n0 = calls.length; vm.runInContext('_rxOrig = null', c);
    const r = await c.cfPick(idxOf('w1'));
    ok(r === false && calls.length === n0 && toasts.includes('Already transcribing — try again in a minute') && vm.runInContext('_rxOrig', c) === null, '10 tapping it says "Already transcribing — try again in a minute" without calling the server');
    resetFeed(); calls = []; toasts.length = 0; route = FEED({ videos: [vid('w2', 'wendy', 3, D, 10)] }); c.switchView('create'); await tick();
    route = FEED({ videos: [vid('w2', 'wendy', 3, D, 10, { transcriptStatus: 'working' })], note: 'This video is being transcribed — check back in a minute.' });
    const r2 = await c.cfPick(idxOf('w2')); await tick();
    ok(r2 === false && toasts.includes('Already transcribing — try again in a minute') && /Transcribing…/.test(rowOf('w2')) && !/cf-row-err/.test(rowOf('w2')), '10 a transcript call that finds it in progress elsewhere shows "Transcribing…", not an error'); }

  // ═══ 8. refresh + plain-words errors ═══
  c.bookmarkCategories = [];
  resetFeed(); calls = []; route = FEED(); c.switchView('create'); await tick();
  { route = FEED({ note: 'Fresh already — next refresh after 14:05' });
    await c.cfRefresh(); await tick();
    ok(feedCalls('refresh').length === 1 && J(feedCalls('refresh')[0].body) === J({ brandId: 'brand-1', action: 'refresh' }), '8 Refresh sends {action:"refresh"}');
    ok(/>Fresh already — next refresh after 14:05</.test(F()) && order().length === 8, '8 and shows the server\'s note');
    route = async () => ({ status: 429, body: { error: 'rate_limited', code: 'rate_limited' } });
    await c.cfRefresh(); await tick();
    ok(/Too many requests just now/.test(F()) && order().length === 8 && !/>rate_limited</.test(F()), '8 a failed refresh keeps the rows and says why in plain words'); }
  for (const [label, rt, want] of [
    ['apify_failed code only', async () => ({ status: 502, body: { code: 'apify_failed' } }), /Couldn(&#39;|')t load your creators(&#39;|')? new posts/],
    ['a server sentence', async () => ({ status: 502, body: { error: 'TikTok did not answer — try again in a minute.', code: 'apify_failed' } }), /TikTok did not answer — try again in a minute\./],
    ['HTML instead of JSON', async () => ({ status: 504, body: '<html>Gateway</html>' }), /Couldn(&#39;|')t load your creators/],
    ['network down', async () => { throw new TypeError('Failed to fetch'); }, /Your connection dropped/],
  ]) {
    resetFeed(); calls = []; route = rt; c.switchView('create'); await tick();
    ok(want.test(F()) && /class="cf-err"/.test(F()) && !/apify_failed|Gateway|Failed to fetch/.test(F()), '8 error, ' + label + ': plain words (' + (F().match(/cf-err"[^>]*>([^<]*)/) || [])[1] + ')');
  }

  finished = true;
  if (fail) { console.log('CREATOR FEED UI FAILED (' + fail + ')'); process.exit(1); }
  console.log('CREATOR FEED UI OK');
})().catch(e => { console.log('FAIL: crashed', e && e.stack || e); process.exit(1); });
