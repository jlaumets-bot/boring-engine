#!/usr/bin/env node
// GATE (creator-panels, owner 2026-10-04): "Creators you follow" panels at the bottom of Remix. EXECUTED —
// the real functions lifted from app.html run in node:vm against a fake DOM and a fake save path.
//   1  the old "Borrow from" strip is gone (HTML, JS, CSS); the panels sit at the bottom of Remix and
//      re-render when Remix opens and whenever Bookmarks change.
//   2  one panel per saved creator: name, platform badge (TikTok preferred), opens in a new tab
//      (https only, rel=noopener); a creator with no usable link shows "Add link" instead.
//   3  names and notes are escaped everywhere (text and attributes).
//   4  the note: "Add why you follow them" when empty; edit saves it (≤140 chars) through the real save path.
//   5  edit link / note, + Add creator (TikTok / Instagram / YouTube link, into the first category or a new
//      "Following" one), remove with an on-panel "Remove? Remove · Keep" (no window.confirm/prompt/alert).
//   6  the note survives a save → load round trip through saveBookmarksToDB / loadBookmarksFromDB.
//   7  a failed bookmarks load is said plainly (no add form that could not save).
//   8  CSS: theme tokens with dark values only; the row scrolls sideways itself at 375 px, the page does not.
//   9  "Open" goes to the PROFILE: a saved video / post link becomes the account link
//      (tiktok.com/@user/video/123 → https://www.tiktok.com/@user); the note is clamped to 2 lines and
//      one tap on it opens the editor; an old entry with no note still renders.
//  10  the same note is shown and editable in Settings → Bookmarks and shown in the Bookmarks sheet (escaped).
// RUN: node scripts/verify/creator-panels-ui.mjs      EXPECT: prints "CREATOR PANELS OK", exit 0.
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
const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

// ── fake DOM: setting innerHTML "creates" the children whose ids it names ──
const els = {};
const mk = id => ({ id, value: '', textContent: '', style: {}, focus() {}, scrollIntoView() {} });
function host(id) {
  const e = mk(id); els[id] = e; let h = ''; let kids = [];
  Object.defineProperty(e, 'innerHTML', { get: () => h, set: v => {
    h = String(v); for (const k of kids) delete els[k]; kids = [];
    // like a browser: an <input value="…"> or <textarea>…</textarea> starts with that (decoded) value
    const dec = t => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    for (const m of h.matchAll(/<(\w+)([^>]*?)\bid="([^"]+)"([^>]*)>/g)) {
      const k = mk(m[3]); kids.push(m[3]); els[m[3]] = k;
      const attrs = m[2] + ' ' + m[4], v = /\bvalue="([^"]*)"/.exec(attrs);
      if (m[1] === 'input' && v) k.value = dec(v[1]);
      if (m[1] === 'textarea') k.value = dec(h.slice(m.index + m[0].length, h.indexOf('</textarea>', m.index)));
    }
  } });
  return e;
}
let saves = [], db = [], confirmAnswer = true, confirms = [], loadFailed = false;
const c = {
  console: { log() {}, warn() {}, error() {}, info() {} }, JSON, Promise, Date, Math, String, Number, Array, Object, Set, Map, RegExp, Error,
  window: {}, currentBrand: { id: 'brand-1' }, bookmarkCategories: [],
  document: { getElementById: id => els[id] || null },
  confirm: m => { confirms.push(m); return confirmAnswer; },
  _listLoaded: () => !loadFailed, listLoadFailed: k => k === 'bookmarks' && loadFailed, _warnListNotSaved() {}, _warnSaveFailed() {},
  _replaceBrandRows: async (table, brandId, rows, opts) => { saves.push({ table, brandId, rows: JSON.parse(J(rows)), opts }); return { ok: true }; },
  renderBookmarkBar() {}, renderBookmarksInner: () => '', toggleBookmarkBar() {}, _bmEditingEntry: null,
  prompt: m => { confirms.push('PROMPT ' + m); return null; }, alert: m => { confirms.push('ALERT ' + m); },
  sb: { from: (t) => { const q = { _t: t, _f: [], select() { return q; }, eq(k, v) { q._f.push([k, v]); return q; },
    then(res, rej) { return Promise.resolve({ data: db.filter(r => q._f.every(([k, v]) => r[k] === v)), error: null }).then(res, rej); } }; return q; } },
};
c.globalThis = c;
vm.createContext(c);
vm.runInContext(between('// ===== follow-panels:', '\nfunction saveBookmarks() {').replace(/^(let|const) /gm, 'var '), c);
for (const n of ['escapeHtml', 'escAttr', 'safeUrl', 'bmId', 'saveBookmarks', 'saveBookmarksToDB', 'loadBookmarksFromDB', 'rerenderBookmarks',
  'renderBookmarksInner', 'editBmLinks', 'saveBmLinks', 'openBookmarks']) vm.runInContext(grab(n), c);
{ const m = /\nconst BM_PLATFORMS = \[[\s\S]*?\n\];/.exec(html); if (!m) throw new Error('no BM_PLATFORMS'); vm.runInContext(m[0].replace('const ', 'var '), c); }

const P = () => els.followPanels.innerHTML;
const panels = () => P().split('<div class="fp-panel').slice(1).map(x => '<div class="fp-panel' + x);
const XSS_NAME = '<img src=x onerror=alert(1)>"Bob\'s';
const XSS_NOTE = '"><script>alert(2)</script> & more';
const seed = () => [
  { id: 'c1', name: 'Hooks', entries: [
    { id: 'e1', name: 'Ann', links: { yt: 'https://youtube.com/@ann', ig: 'https://instagram.com/ann', tt: 'https://www.tiktok.com/@ann' }, note: 'Best hooks in my niche' },
    { id: 'e2', name: 'Bee', links: { yt: 'https://youtube.com/@bee', ig: 'https://instagram.com/bee' } },
    { id: 'e3', name: 'Cee', links: {} } ] },
  { id: 'c2', name: 'Other', entries: [
    { id: 'e4', name: 'Dee', links: { tt: 'javascript:alert(1)', web: 'http://dee.example.com' } },
    { id: 'e5', name: XSS_NAME, links: { tt: 'https://www.tiktok.com/@x"onmouseover="alert(3)' }, note: XSS_NOTE } ] } ];
const reset = (cats) => {
  for (const k of Object.keys(els)) delete els[k];
  host('followPanels'); saves = []; confirms = []; confirmAnswer = true; loadFailed = false;
  c.bookmarkCategories = cats; vm.runInContext('_fpEdit = ""; _fpAdding = false; _fpConfirm = ""; _fpReplaceAsk = "";', c);
  c.renderFollowPanels();
};
const ent = id => c.bookmarkCategories.flatMap(k => k.entries).find(e => e.id === id);

(async () => {
  // ═══ 1. the old strip is gone; the panels are at the bottom of Remix ═══
  ok(!/remixBorrowStrip|renderRemixBorrowStrip|_borrowCreators|openBorrow|borrow-chip|borrow-row|borrow-empty|remix-borrow-strip/.test(html), '1 the old "Borrow from" strip is gone (HTML, JS and CSS)');
  { const v = html.indexOf('<div class="view" id="view-create">'), r = html.indexOf('<div id="remixResults"></div>', v), f = html.indexOf('<div id="followPanels" class="fp-wrap"></div>', v), end = html.indexOf('<!-- /view-create -->', v);
    ok(v > 0 && r > v && f > r && f < end && (html.match(/id="followPanels"/g) || []).length === 1, '1 the panels sit once, at the bottom of the Remix screen (after the results)'); }
  ok(/else if\(view==='create'\) \{[^\n]*renderFollowPanels\(\)/.test(html) && /renderFollowPanels\(\)/.test(grab('rerenderBookmarks')), '1 they render when Remix opens and whenever Bookmarks change');

  // ═══ 2. one panel per creator; TikTok first; https only; name-only → Add link ═══
  reset(seed());
  const ps = panels();
  ok(/Creators you follow/.test(P()) && ps.length === 6 && /\+ Add creator/.test(ps[5]), '2 five creator panels + the "+ Add creator" panel (' + ps.length + ')');
  ok(ps[0].includes('href="https://www.tiktok.com/@ann"') && /fp-b-tt">TikTok</.test(ps[0]) && ps[0].includes('target="_blank" rel="noopener noreferrer"') && />Ann</.test(ps[0]),
    '2 a creator with TikTok + Instagram + YouTube opens TikTok, badge "TikTok", new tab, noopener');
  ok(ps[1].includes('href="https://www.instagram.com/bee"') && />Instagram</.test(ps[1]), '2 without TikTok, the next link (Instagram) is used, as the profile');
  ok(!/href=/.test(ps[2]) && /onclick="fpEditOpen\(2\)">Add link</.test(ps[2]), '2 a creator saved by name only shows "Add link" instead of opening');
  ok(!/javascript:/i.test(ps[3]) && !/http:\/\/dee/.test(ps[3]) && ps[3].includes('href="https://dee.example.com"') && />Website</.test(ps[3]), '2 javascript: is never opened; a saved http:// link opens upgraded to https://');
  ok(/>Best hooks in my niche</.test(ps[0]) && /onclick="fpEditOpen\(1\)">Add why you follow them</.test(ps[1]), '2 the note shows; without one a faint "Add why you follow them" opens the editor');
  ok(ps.slice(0, 5).every((p, i) => p.includes('onclick="fpEditOpen(' + i + ')" aria-label="Edit') && p.includes('onclick="fpRemove(' + i + ')"')), '2 every panel has Edit and Remove');

  // ═══ 3. escaping ═══
  ok(!P().includes('<img') && !P().includes('<script') && ps[4].includes('&lt;img src=x onerror=alert(1)&gt;') && ps[4].includes('&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt; &amp; more'),
    '3 a name / note with HTML is shown as text');
  ok(!/aria-label="[^"]*"Bob/.test(P()) && /aria-label="Open &lt;img src=x onerror=alert\(1\)&gt;&quot;Bob&#39;s on TikTok"/.test(ps[4]) && !/href="[^"]*"onmouseover/.test(ps[4]) && ps[4].includes('href="https://www.tiktok.com/@x&quot;onmouseover=&quot;alert(3)"'),
    '3 quotes in names and links never break out of an attribute');
  c.fpEditOpen(4);
  ok(els.fpEditNote && P().includes('>&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt; &amp; more</textarea>') && !P().includes('<script'), '3 the note editor holds the note as text');
  c.fpCancel();

  // ═══ 4 + 5. edit note / link ═══
  c.fpEditOpen(2);
  ok(els.fpEditLink && els.fpEditNote && /fp-editing/.test(P()) && P().includes('maxlength="140"'), '5 Edit opens an inline editor (link + note, 140 max)');
  els.fpEditLink.value = 'tiktok.com/@cee'; els.fpEditNote.value = '  Great   storytelling,\n short  ';
  ok(c.fpSaveEdit() === true, '5 saving the edit succeeds'); await tick();
  ok(J(ent('e3').links) === J({ tt: 'https://tiktok.com/@cee' }) && ent('e3').note === 'Great storytelling, short', '4 the link (https added) and the tidied note are on the creator (' + J(ent('e3')) + ')');
  ok(saves.length === 1 && saves[0].table === 'competitors' && saves[0].rows[0].name === '__bookmarks__' && JSON.parse(saves[0].rows[0].notes)[0].entries[2].note === 'Great storytelling, short',
    '4 it is saved through the real bookmarks save (one JSON row in competitors.notes, note inside)');
  ok(panels()[2].includes('href="https://www.tiktok.com/@cee"') && />Great storytelling, short</.test(panels()[2]) && !/fp-editing/.test(P()), '4 the panel now opens the profile and shows the note');
  c.fpEditOpen(1); els.fpEditLink.value = 'javascript:alert(1)'; els.fpEditNote.value = 'x';
  ok(c.fpSaveEdit() === false && /doesn't look like a web link/.test(els.fpEditErr.textContent) && saves.length === 1 && !ent('e2').note, '5 a bad link is refused with a plain message and nothing is saved');
  els.fpEditLink.value = 'https://www.tiktok.com/@bee'; els.fpEditNote.value = 'n'.repeat(200);
  c.fpSaveEdit(); await tick();
  ok(J(ent('e2').links) === J({ yt: 'https://youtube.com/@bee', tt: 'https://www.tiktok.com/@bee' }) && ent('e2').note.length === 140 && saves.length === 2,
    '5 changing the link replaces the shown one (others kept); a long note is cut to 140 (' + J(ent('e2').links) + ')');
  c.fpEditOpen(0); els.fpEditNote.value = '   ';
  c.fpSaveEdit(); await tick();
  ok(!('note' in ent('e1')) && ent('e1').links.tt === 'https://www.tiktok.com/@ann' && /Add why you follow them/.test(panels()[0]), '5 clearing the note removes it; the link stays');

  // ═══ 5. + Add creator ═══
  c.fpAddOpen();
  ok(els.fpAddLink && els.fpAddNote && /Their profile link/.test(P()), '5 "+ Add creator" opens a link + note form');
  els.fpAddLink.value = 'https://example.com/me';
  ok(c.fpAdd() === false && /TikTok, Instagram or YouTube/.test(els.fpAddErr.textContent) && saves.length === 3, '5 a non-profile link is refused');
  els.fpAddLink.value = ' https://www.youtube.com/@newguy '; els.fpAddNote.value = 'Explains things simply';
  ok(c.fpAdd() === true, '5 a YouTube link is accepted'); await tick();
  { const n = c.bookmarkCategories[0].entries.slice(-1)[0];
    ok(n.name === 'newguy' && J(n.links) === J({ yt: 'https://www.youtube.com/@newguy' }) && n.note === 'Explains things simply' && /^bm_/.test(n.id) && saves.length === 4,
      '5 it is saved into the first category, named from the link, with the note (' + J(n) + ')'); }
  ok(panels().length === 7 && />newguy</.test(panels()[3]) && panels()[3].includes('href="https://www.youtube.com/@newguy"') && />YouTube</.test(panels()[3]) && /\+ Add creator/.test(panels()[6]), '5 the new panel appears; "+ Add creator" stays last');
  reset([]);
  ok(/Save the creators you learn from/.test(P()) && panels().length === 1, '5 with nobody saved yet: a one-line hint and the add panel');
  c.fpAddOpen(); els.fpAddLink.value = 'http://instagram.com/foo';
  c.fpAdd(); await tick();
  ok(c.bookmarkCategories.length === 1 && c.bookmarkCategories[0].name === 'Following' && J(c.bookmarkCategories[0].entries[0].links) === J({ ig: 'https://instagram.com/foo' }) && !('note' in c.bookmarkCategories[0].entries[0]),
    '5 with no category a "Following" one is made; http:// becomes https://; the note is optional');

  // ═══ 5. remove (asked on the panel itself — no window.confirm) ═══
  reset(seed());
  ok(c.fpRemove(1) === false && ent('e2') && saves.length === 0 && confirms.length === 0 && /Remove from this list\?/.test(panels()[1])
    && /onclick="fpRemove\(1\)" aria-label="Yes, remove Bee">Remove</.test(panels()[1]) && /onclick="fpCancel\(\)">Keep</.test(panels()[1]), '5 the first Remove asks on the panel (Remove · Keep), no browser pop-up');
  c.fpCancel();
  ok(ent('e2') && saves.length === 0 && !/Remove from this list/.test(P()), '5 "Keep" keeps them');
  c.fpRemove(1);
  ok(c.fpRemove(1) === true && !ent('e2') && saves.length === 1 && confirms.length === 0, '5 the second Remove removes them and saves'); await tick();
  ok(panels().length === 5 && !/>Bee</.test(P()), '5 the panel is gone');

  // ═══ 6. note round trip: save → load ═══
  reset(seed()); saves = [];
  c.saveBookmarks(); await tick();
  db = [{ brand_id: 'brand-1', created_at: new Date().toISOString(), name: saves[0].rows[0].name, notes: saves[0].rows[0].notes }];
  { const back = await c.loadBookmarksFromDB();
    const e1 = back[0].entries.find(e => e.id === 'e1'), e5 = back[1].entries.find(e => e.id === 'e5');
    ok(e1.note === 'Best hooks in my niche' && e5.note === XSS_NOTE && !('note' in back[0].entries.find(e => e.id === 'e2')), '6 the note comes back from the database unchanged (no new column needed)');
    reset(back);
    ok(/>Best hooks in my niche</.test(panels()[0]), '6 and shows on the panel after a reload'); }

  // ═══ 7. failed load ═══
  for (const k of Object.keys(els)) delete els[k]; host('followPanels'); loadFailed = true; c.bookmarkCategories = []; c.renderFollowPanels();
  ok(/Couldn't load the creators you follow/.test(P()) && !/Add creator/.test(P()), '7 a failed load says so (no add form that could not save)');

  // ═══ 8. CSS ═══
  { const css = [...html.matchAll(/^\s*(\.fp-[^{]*)\{([^}]*)\}/gm)].map(m => ({ sel: m[1].trim(), body: m[2] }));
    const dark = between('[data-theme="dark"] {', '}');
    const used = [...new Set(css.flatMap(r => [...r.body.matchAll(/var\((--[\w-]+)\)/g)].map(m => m[1])))];
    ok(css.length >= 20 && css.every(r => !/#[0-9a-f]{3,8}\b|rgba?\(/i.test(r.body)), '8 theme tokens only (' + css.length + ' rules)');
    ok(used.length && used.every(v => dark.includes(v + ':')), '8 every token has a dark-mode value (' + used.join(' ') + ')');
    const rule = s => (css.find(r => r.sel === s) || {}).body || '';
    const widths = css.flatMap(r => [...r.body.matchAll(/(?:^|;)\s*(?:min-|max-|flex-basis:|flex:0 0 )?width:\s*(\d+)px|flex:0 0 (\d+)px|flex-basis:(\d+)px/g)].map(m => Number(m[1] || m[2] || m[3])));
    ok(/overflow-x:auto/.test(rule('.fp-row')) && /display:flex/.test(rule('.fp-row')) && /max-width:100%/.test(rule('.fp-row')) && /max-width:100%/.test(rule('.fp-wrap')),
      '8 the row scrolls sideways inside itself; the wrapper never grows past the screen');
    ok(widths.length >= 2 && widths.every(w => w <= 343) && /max-width:80vw/.test(rule('.fp-panel')), '8 every panel fits a 375 px screen with 16 px gutters (' + widths.join(',') + ' px)');
    ok(/position:relative/.test(rule('.fp-panel')) && /inset:0/.test(rule('.fp-open::after')) && /z-index:1/.test(rule('.fp-tools')) && /z-index:1/.test(rule('.fp-ghost')),
      '8 the whole panel is the tap target; Edit / Remove / note sit above it'); }

  // ═══ 9. Open → the PROFILE; the note: 2 lines, one tap to edit ═══
  { const T = [
      ['https://www.tiktok.com/@user/video/123', 'https://www.tiktok.com/@user'],
      ['tiktok.com/@user/video/123', 'https://www.tiktok.com/@user'],
      ['https://m.tiktok.com/@some.one_9/video/7312?lang=en', 'https://www.tiktok.com/@some.one_9'],
      ['https://www.tiktok.com/@user?lang=en', 'https://www.tiktok.com/@user'],
      ['https://vm.tiktok.com/ZMabc123/', 'https://vm.tiktok.com/ZMabc123/'],
      ['https://www.youtube.com/@handle/shorts', 'https://www.youtube.com/@handle'],
      ['https://youtu.be/abc', 'https://youtu.be/abc'],
      ['https://www.instagram.com/ann.b/reel/C9x/', 'https://www.instagram.com/ann.b'],
      ['https://www.instagram.com/reel/C9x/', 'https://www.instagram.com/reel/C9x/'],
      ['https://twitter.com/jack/status/20', 'https://x.com/jack'],
      ['https://dee.example.com/about', 'https://dee.example.com/about'],
      ['javascript:alert(1)', ''], ['http://www.tiktok.com/@user/video/1', ''] ];
    const bad = T.filter(([i, o]) => c.fpProfileUrl(i.startsWith('tiktok.com') ? 'https://' + i : i) !== o);
    ok(!bad.length, '9 a saved video / post link becomes the profile link (' + (bad.length ? 'wrong: ' + bad.map(([i, o]) => i + ' → ' + c.fpProfileUrl(i) + ' (want ' + o + ')').join('; ') : T.length + ' cases') + ')'); }
  reset([{ id: 'c1', name: 'Hooks', entries: [
    { id: 'v1', name: 'Vid', links: { tt: 'https://www.tiktok.com/@vidguy/video/7312345678901234567' }, note: 'Long note '.repeat(13).trim() },
    { id: 'v2', name: 'Old', links: { yt: 'https://www.youtube.com/@old' } } ] }]);
  { const ps2 = panels();
    ok(ps2[0].includes('href="https://www.tiktok.com/@vidguy"') && !ps2[0].includes('/video/') && ps2[0].includes('target="_blank" rel="noopener noreferrer"') && /<span class="fp-go" aria-hidden="true">Open ↗<\/span>/.test(ps2[0]),
      '9 a TikTok VIDEO link opens the creator\'s profile in a new tab, with a visible "Open"');
    ok(/<button type="button" class="fp-notebtn" onclick="fpEditOpen\(0\)"[^>]*><span class="fp-note">Long note/.test(ps2[0]), '9 the note sits under the name and one tap on it opens the editor');
    ok(!('note' in ent('v2')) && /Add why you follow them/.test(ps2[1]) && ps2[1].includes('href="https://www.youtube.com/@old"'), '9 an old entry without a note still renders and opens');
    const note = (/^\s*\.fp-note\{([^}]*)\}/m.exec(html) || [])[1] || '';
    ok(/-webkit-line-clamp:2/.test(note) && /overflow:hidden/.test(note) && /display:-webkit-box/.test(note), '9 the note is clamped to 2 lines');
    c.fpEditOpen(0);
    ok(els.fpEditLink.value === 'https://www.tiktok.com/@vidguy/video/7312345678901234567', '9 editing keeps the saved link as it was (only Open is turned into the profile)'); c.fpCancel(); }
  { const blk = between('// ===== follow-panels:', '\nfunction saveBookmarks() {');
    ok(!/\b(?:window\.)?(?:confirm|prompt|alert)\s*\(/.test(blk) && confirms.length === 0, '5 the panels never use window.confirm / prompt / alert'); }

  // ═══ 11. review fixes ═══
  // links saved as typed (http://, no scheme) still open, upgraded to https
  reset([{ id: 'c1', name: 'H', entries: [
    { id: 'h1', name: 'Plain', links: { tt: 'tiktok.com/@plain/video/9' } },
    { id: 'h2', name: 'Http', links: { ig: 'http://instagram.com/httpguy' } },
    { id: 'h3', name: 'Bad', links: { tt: 'javascript:alert(1)', yt: 'not a link at all' } } ] }]);
  { const ps3 = panels();
    ok(ps3[0].includes('href="https://www.tiktok.com/@plain"') && ps3[1].includes('href="https://www.instagram.com/httpguy"') && !/href=/.test(ps3[2]) && /Add link/.test(ps3[2]),
      '11 a scheme-less or http:// saved link opens (as https, as the profile); junk still shows "Add link"'); }
  // the one link box never silently overwrites a different platform's saved link
  reset([{ id: 'c1', name: 'H', entries: [{ id: 'm1', name: 'Multi', links: { tt: 'https://www.tiktok.com/@a', ig: 'https://instagram.com/b' } }] }]);
  c.fpEditOpen(0); els.fpEditLink.value = 'https://instagram.com/c'; els.fpEditNote.value = '';
  ok(c.fpSaveEdit() === false && saves.length === 0 && J(ent('m1').links) === J({ tt: 'https://www.tiktok.com/@a', ig: 'https://instagram.com/b' })
    && /This replaces your saved Instagram link \(https:\/\/instagram\.com\/b\)\. Press Save again/.test(els.fpEditErr.textContent), '11 replacing TikTok with an Instagram link first says it replaces the saved Instagram one; nothing changes yet');
  ok(c.fpSaveEdit() === true, '11 a second Save confirms'); await tick();
  ok(J(ent('m1').links) === J({ ig: 'https://instagram.com/c' }) && saves.length === 1, '11 then the edited link replaces both, as told (' + J(ent('m1').links) + ')');
  reset([{ id: 'c1', name: 'H', entries: [{ id: 'm1', name: 'Multi', links: { tt: 'https://www.tiktok.com/@a', ig: 'https://instagram.com/b' } }] }]);
  c.fpEditOpen(0); els.fpEditLink.value = 'https://www.youtube.com/@yy'; els.fpEditNote.value = '';
  ok(c.fpSaveEdit() === true, '11 a link for a free platform saves at once'); await tick();
  ok(J(ent('m1').links) === J({ ig: 'https://instagram.com/b', yt: 'https://www.youtube.com/@yy' }), '11 only the edited (shown) link is replaced; the hidden Instagram one is kept');
  // edit / remove state follows the ENTRY, not its slot
  reset(seed());
  c.fpEditOpen(1);
  c.bookmarkCategories[0].entries.shift(); c.renderFollowPanels();
  ok(/fp-editing/.test(panels()[0]) && />Bee</.test(panels()[0]) && !/fp-editing/.test(panels()[1]), '11 after a reload moves the entries, the editor stays on the same creator');
  c.fpCancel(); c.fpRemove(0);   // arms Bee (slot 0 now)
  c.bookmarkCategories[0].entries.unshift({ id: 'z0', name: 'Zed', links: {} }); c.renderFollowPanels();
  ok(/Remove from this list\?/.test(panels()[1]) && />Bee</.test(panels()[1]) && !/Remove from this list/.test(panels()[0]), '11 the "Remove?" question moves with the creator');
  ok(c.fpRemove(0) === false && ent('z0') && ent('e2') && saves.length === 0,
    '11 a "Remove?" armed on one creator never removes whoever moves into that slot');
  c.bookmarkCategories = [{ id: 'k9', name: 'Other brand', entries: [{ id: 'q1', name: 'Q', links: {} }] }]; c.renderFollowPanels();
  ok(!/fp-editing|Remove from this list/.test(P()) && vm.runInContext('_fpEdit === "" && _fpConfirm === ""', c), '11 a brand switch / reload without that creator clears the state');

  // ═══ 10. the note in Bookmarks (Settings) and in the Bookmarks sheet ═══
  reset(seed()); host('bmContainer'); saves = [];
  c.rerenderBookmarks();
  { const B = () => els.bmContainer.innerHTML;
    ok(B().includes('<div class="bm-entry-note">Best hooks in my niche</div>') && B().includes('<div class="bm-entry-note">&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt; &amp; more</div>') && !B().includes('<script'),
      '10 Settings → Bookmarks shows each note under the name, escaped');
    ok((B().match(/bm-entry-note/g) || []).length === 2, '10 entries without a note show no note line');
    c.editBmLinks('c1', 'e2');
    ok(els.bmNote_e2 && B().includes('<textarea id="bmNote_e2" maxlength="140"') && /Why you follow them/.test(B()), '10 the ✎ editor has a "Why you follow them" box (140 max)');
    els.bmNote_e2.value = '  Short   videos,\n sharp hooks '; for (const k of ['ig', 'tt', 'yt', 'li', 'x', 'web']) if (els['bmLink_e2_' + k] === undefined) host('bmLink_e2_' + k);
    els.bmLink_e2_yt.value = 'https://youtube.com/@bee'; els.bmLink_e2_ig.value = 'https://instagram.com/bee';
    c.saveBmLinks('c1', 'e2'); await tick();
    ok(ent('e2').note === 'Short videos, sharp hooks' && saves.length === 1 && JSON.parse(saves[0].rows[0].notes)[0].entries[1].note === 'Short videos, sharp hooks', '10 saving there stores the tidied note on the entry, through the same save');
    ok(/>Short videos, sharp hooks</.test(panels()[1]), '10 and the Remix panel shows it at once');
    c.editBmLinks('c1', 'e2'); els.bmNote_e2.value = 'z'.repeat(300); c.saveBmLinks('c1', 'e2'); await tick();
    ok(ent('e2').note.length === 140, '10 a long note is cut to 140 there too');
    c.editBmLinks('c1', 'e2'); els.bmNote_e2.value = ''; c.saveBmLinks('c1', 'e2'); await tick();
    ok(!('note' in ent('e2')) && J(ent('e2').links) === J({ ig: 'https://instagram.com/bee', yt: 'https://youtube.com/@bee' }), '10 an empty box removes the note; links kept'); }
  { const body = { kids: [], appendChild(x) { this.kids.push(x); } };
    const w = mk('bmOverlay'); let wh = ''; Object.defineProperty(w, 'innerHTML', { get: () => wh, set: v => { wh = String(v); } });
    c.document = { getElementById: id => id === 'bmOverlay' ? (body.kids[0] || null) : (els[id] || null), createElement: () => w, body };
    c.openBookmarks();
    ok(wh.includes('<div class="bm-card-note">Best hooks in my niche</div>') && wh.includes('&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt; &amp; more') && !wh.includes('<script'), '10 the Bookmarks sheet shows the note too, escaped');
    c.document = { getElementById: id => els[id] || null }; }

  finished = true;
  if (fail) { console.log(fail + ' check(s) failed'); process.exit(1); }
  console.log('CREATOR PANELS OK');
})().catch(e => { console.log('FAIL: threw', e && e.stack || e); process.exit(1); });
