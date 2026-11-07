#!/usr/bin/env node
// GATE (v718 desktop layout, owner-approved mockups design-options/desktop-onboarding/ D1–D3, 2026-11-07). EXECUTED in headless Chromium:
// the real app.html + clean.css, signed in against the in-memory fake Supabase (scripts/verify/_v718-harness.mjs), every /api/* stubbed.
//   1  D1 at 1440: three columns — sidebar | the chat column (~720) | the right rail (320) with "New from your creators" (the same _cf feed,
//      the same rows hyFeedPick reads) and "Your creators" (≤5, "N new"); the start screen's in-thread list is hidden; a rail row starts
//      the thread with no extra call when its words are ready; the toolbar has "New chat".
//   2  D2 Ideas: the calm list left, the SAME idea page (#awDetail) right, first idea auto-selected and marked; a row click and ↓ move it;
//      the toolbar's "Plan my week" is awPlanWeek; the detail bar has Film it / Ask for changes / copy / ⋯. Pipeline: the same.
//   3  Ask for changes posts kind:'idea' to /api/revise (brandId, idea fields, instruction) — never without text; the answer shows as v2 with
//      a v1/v2 toggle + the server note; Keep goes through the existing save path (_saveThenDropRenamedRow → saveIdeasToDB) and the idea
//      changes; a 402 / failed answer shows the plain reason and adds no version; on a phone the idea page's ⋯ has "Ask for changes".
//   4  D3 Settings: the rows left, the picked section's existing panel right; another row → that section.
//   5  Notebook: the note list left, the note's page right; ⌘K still opens the palette and Esc closes it.
//   6  390px (phones) unchanged: the key element positions of 7 screens are identical with and without everything v718 added
//      (the v718 CSS section removed + the v718 script stopped) — and 1000px (900–1099) gets no v718 layout.
// RUN: node scripts/verify/desktop-v718.mjs        EXPECT: "DESKTOP V718 OK", exit 0.
import fs from 'node:fs'; import path from 'node:path';
import { ROOT, ok, result, boot, closeAll, guard, isoAgo } from './_v718-harness.mjs';
const G = guard('desktop-v718', 110000);
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8'), css = fs.readFileSync(path.join(ROOT, 'clean.css'), 'utf8');
const FEED = { ok: true, fetchedAt: isoAgo(1), creators: [{ handle: 'mondaydotcom' }, { handle: 'studioops' }], videos: [
  { videoId: '7341', handle: 'studioops', caption: 'Your first cup decides your whole morning', views: 184000, score: 4.2, postedAt: isoAgo(2), transcript: 'Your first cup decides your whole morning.', transcriptStatus: 'ready', url: 'https://www.tiktok.com/@studioops/video/7341' },
  { videoId: '7342', handle: 'mondaydotcom', caption: 'Stop writing SOPs nobody reads', views: 52000, score: 2.1, postedAt: isoAgo(5), transcript: 'Stop writing SOPs.', transcriptStatus: 'ready', url: 'https://www.tiktok.com/@mondaydotcom/video/7342' },
  { videoId: '7343', handle: 'studioops', caption: 'Old one', views: 9000, score: 1, postedAt: isoAgo(24 * 5), url: 'https://www.tiktok.com/@studioops/video/7343' } ] };
const rect = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(), st = getComputedStyle(e);
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), vis: st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0 }; }, sel);
try {
  // ---------------- 1 · D1 main chat at 1440 ----------------
  {
    const { page, calls, errors, close } = await boot({ w: 1440, h: 900, api: { 'creator-feed': FEED } });
    await page.evaluate(() => switchView('create')); await page.waitForTimeout(900);
    const side = await rect(page, '#desktopSidebar'), app = await rect(page, '#hyApp'), rail = await rect(page, '#v18Rail');
    ok(side && app && rail && side.vis && app.vis && rail.vis, 'D1: sidebar, chat column and rail are all on screen');
    ok(rail && rail.w === 320 && rail.x + rail.w === 1440 && rail.y === 56, 'D1: the rail is 320 wide on the right, under the 56px toolbar (got ' + JSON.stringify(rail) + ')');
    ok(app && app.w >= 680 && app.w <= 720 && side.x + side.w <= app.x && app.x + app.w <= rail.x, 'D1: three columns, the chat column ~720 between sidebar and rail (got ' + JSON.stringify(app) + ')');
    const r = await page.evaluate(() => ({ t: (document.getElementById('v18Rail').innerText || ''), rows: document.querySelectorAll('#v18Rail .hy-row').length,
      crs: [...document.querySelectorAll('#v18Rail .v18-cr')].map(b => b.innerText.replace(/\s+/g, ' ').trim()), inFeed: getComputedStyle(document.querySelector('#hyMain .hy-feed') || document.body).display,
      paste: !!document.querySelector('#hyMain .hy-paste'), nb: [...document.querySelectorAll('#view-create .csx-toolbar button')].map(b => b.textContent.trim()) }));
    ok(/New from your creators/.test(r.t) && r.rows === 3, 'D1: the rail shows "New from your creators" with the feed rows (got ' + r.rows + ')');
    ok(/Your creators/.test(r.t) && r.crs.length === 2 && r.crs.some(x => /@studioops .*1 new/.test(x)) && r.crs.some(x => /@mondaydotcom .*1 new/.test(x)), 'D1: "Your creators" lists the followed creators with "N new" (got ' + JSON.stringify(r.crs) + ')');
    ok(r.inFeed === 'none' && r.paste, 'D1: the start screen keeps the big paste button and hides its own creators list (the rail replaces it)');
    ok(r.nb.includes('New chat'), 'D1: the toolbar has "New chat"');
    const before = calls.filter(c => c.name === 'creator-feed' && c.body && c.body.action === 'transcript').length;
    await page.click('#v18Rail .hy-row'); await page.waitForTimeout(500);
    const th = await page.evaluate(() => ({ url: _hy.t && _hy.t.src.url, text: _hy.t && _hy.t.src.text, rail: getComputedStyle(document.getElementById('v18Rail')).display }));
    ok(/7341/.test(th.url || '') && /first cup/.test(th.text || '') && calls.filter(c => c.name === 'creator-feed' && c.body && c.body.action === 'transcript').length === before,
      'D1: a rail row opens the thread with its ready words (no transcript call, nothing charged)');
    ok(th.rail === 'block', 'D1: the rail stays beside the thread');
    // brand switch: the rail belongs to one brand
    await page.evaluate(() => { cfReset('b-other'); v18RailRender(); }); await page.waitForTimeout(100);
    ok(await page.evaluate(() => document.querySelectorAll('#v18Rail .hy-row').length === 0), 'D1: another brand\'s feed state never draws the old brand\'s rows');
    ok(!errors.length, 'D1: no page errors (' + errors.slice(0, 2).join(' | ') + ')');
    await close();
  }
  // ---------------- 2 + 3 · D2 Ideas / Pipeline + Ask for changes ----------------
  {
    let reviseMode = 'ok';
    const api = { 'creator-feed': FEED, revise: (req, body) => reviseMode === 'ok'
      ? { ok: true, idea: { title: 'Shorter title', hook: 'New hook', script: 'New script line.', boldText: '', shots: 'Close-up\nWide', screen: '', caption: 'New caption', tags: '#calm #studio', emphasis: ['New script'], postType: body && body.idea && body.idea.postType, format: body && body.idea && body.idea.format }, note: 'Kept your facts.' }
      : { __status: 402, body: { error: 'limit_reached', code: 'limit_reached', message: "You've used up this month's posts — upgrade to keep going." } } };
    const { page, calls, errors, close } = await boot({ w: 1440, h: 900, api });
    await page.evaluate(() => switchView('ideas')); await page.waitForTimeout(700);
    const d = await page.evaluate(() => { const det = document.getElementById('awDetail'), sel = document.querySelector('#awIdeas .aw-row.v18-sel'), first = document.querySelector('#awIdeas .aw-irow');
      const id = awDetailId(); return { open: !det.hidden && getComputedStyle(det).display !== 'none', x: Math.round(det.getBoundingClientRect().left), list: getComputedStyle(document.getElementById('view-ideas')).display,
        selIsFirst: !!sel && sel === first, title: (det.querySelector('.aw-h1') || {}).textContent, stateTitle: id != null ? state[id].title : null,
        bar: [...document.querySelectorAll('#awDock .aw-bar button')].map(b => (b.getAttribute('aria-label') || b.textContent).trim()), tb: !!document.querySelector('#awIdeas .aw-head .v18-tbbtn') }; });
    ok(d.open && d.x === 680 && d.list === 'block', 'D2: the list stays on the left and the idea page opens on the right at x=680 (got ' + d.x + ', list ' + d.list + ')');
    ok(d.selIsFirst && d.title === d.stateTitle, 'D2: the first idea is selected, marked in the list and shown in the detail');
    ok(d.bar.some(x => /Film it/.test(x)) && d.bar.includes('Ask for changes') && d.bar.some(x => /Copy/.test(x)) && d.bar.includes('More'), 'D2: sticky bar = Film it · Ask for changes · copy · ⋯ (got ' + JSON.stringify(d.bar) + ')');
    ok(d.tb, 'D2: the toolbar has "Plan my week"');
    ok(await page.evaluate(() => { let hit = 0; const o = window.awPlanWeek; window.awPlanWeek = () => { hit++; return true; }; document.querySelector('#awIdeas .v18-tbbtn').click(); window.awPlanWeek = o; return hit === 1; }), 'D2: the toolbar button runs awPlanWeek (the phone pill\'s function)');
    await page.click('#awIdeas .aw-irow:nth-of-type(2) .aw-rb'); await page.waitForTimeout(250);
    const d2 = await page.evaluate(() => ({ t: document.querySelector('#awDetail .aw-h1').textContent, s: state[awDetailId()].title, sel: document.querySelector('#awIdeas .aw-row.v18-sel .aw-rt').textContent }));
    ok(d2.t === d2.s && d2.sel === d2.s, 'D2: a row click shows that idea on the right and moves the mark');
    await page.evaluate(() => document.activeElement && document.activeElement.blur()); await page.keyboard.press('ArrowDown'); await page.waitForTimeout(250);
    const d3 = await page.evaluate(() => ({ t: document.querySelector('#awDetail .aw-h1').textContent, rows: [...document.querySelectorAll('#awIdeas .aw-irow .aw-rt')].map(e => e.textContent) }));
    ok(d3.t === d3.rows[2], 'D2: ↓ moves the selection to the next idea (got ' + d3.t + ')');
    await page.keyboard.press('ArrowUp'); await page.waitForTimeout(200);
    ok(await page.evaluate(() => document.querySelector('#awDetail .aw-h1').textContent === [...document.querySelectorAll('#awIdeas .aw-irow .aw-rt')][1].textContent), 'D2: ↑ moves it back');
    // Ask for changes
    const base = await page.evaluate(() => { const i = state[awDetailId()]; return { title: i.title, hook: i.hook, format: i.format }; });
    await page.click('#awDock .v18-askb'); await page.waitForTimeout(200);
    ok(await page.evaluate(() => !!document.getElementById('v18AskIn') && document.getElementById('awDetail').contains(document.getElementById('v18AskIn'))), 'Ask: the bar button opens a small input under the idea');
    await page.press('#v18AskIn', 'Enter'); await page.waitForTimeout(150);
    ok(!calls.some(c => c.name === 'revise'), 'Ask: an empty ask sends nothing');
    await page.fill('#v18AskIn', 'shorter and more casual'); await page.press('#v18AskIn', 'Enter'); await page.waitForTimeout(500);
    const rv = calls.filter(c => c.name === 'revise').pop();
    ok(rv && rv.body.kind === 'idea' && rv.body.brandId === 'b-acme' && rv.body.instruction === 'shorter and more casual' && rv.body.idea && rv.body.idea.title === base.title && rv.body.idea.format === base.format && typeof rv.body.idea.postType === 'string' && rv.body.idea.hook === base.hook && !('status' in rv.body.idea) && !('id' in rv.body.idea),
      'Ask: posts kind:\'idea\' to /api/revise with brandId, the idea in the app\'s own names (title, hook, format, postType…, no status/id) and the instruction');
    const v = await page.evaluate(() => ({ seg: [...document.querySelectorAll('#v18Ask .hy-segb')].map(b => b.textContent + (b.classList.contains('on') ? '*' : '')), card: (document.querySelector('#v18Ask .v18-vc') || {}).innerText || '', note: (document.querySelector('#v18Ask .hy-note') || {}).textContent || '' }));
    ok(v.seg.join(',') === 'v1,v2*' && /Shorter title/.test(v.card) && /New hook/.test(v.card) && /Kept your facts/.test(v.note), 'Ask: the revised idea shows as v2 with a v1/v2 toggle and the server note');
    await page.click('#v18Ask .hy-segb:first-child'); await page.waitForTimeout(150);
    ok(await page.evaluate(t => (document.querySelector('#v18Ask .v18-vc').innerText || '').includes(t) && document.querySelector('#v18Ask .v18-keepb').disabled, base.title), 'Ask: v1 shows the saved idea (nothing to keep)');
    await page.click('#v18Ask .hy-segb:last-child'); await page.waitForTimeout(100);
    const kept = await page.evaluate(() => { const seen = []; const o = window._saveThenDropRenamedRow; window._saveThenDropRenamedRow = function (a, b) { seen.push([a, b]); return o.apply(this, arguments); };
      const so = window.saveIdeasToDB; let saves = 0; window.saveIdeasToDB = function () { saves++; return so.apply(this, arguments); };
      const id = awDetailId(); state[id].boldText = 'Edited meanwhile'; document.querySelector('#v18Ask .v18-keepb').click(); window._saveThenDropRenamedRow = o; window.saveIdeasToDB = so;
      const i = state[id]; return { seen, saves, title: i.title, hook: i.hook, tags: i.tags, shots: i.shots, emph: i.emphasis, bold: i.boldText, open: !!document.getElementById('v18Ask') }; });
    ok(kept.seen.length === 1 && kept.seen[0][0] === base.title && kept.seen[0][1] === 'Shorter title' && kept.saves >= 1, 'Ask: Keep saves through the existing path (_saveThenDropRenamedRow → saveIdeasToDB) (got ' + JSON.stringify(kept.seen) + ')');
    ok(kept.title === 'Shorter title' && kept.hook === 'New hook' && /#calm/.test(kept.tags || '') && kept.shots === 'Close-up\nWide' && JSON.stringify(kept.emph) === '["New script"]' && !kept.open, 'Ask: the idea now holds v2 (title, hook, shots, tags, emphasis) and the box closes');
    ok(kept.bold === 'Edited meanwhile', 'Ask: Keep merges only what the revision changed onto the current idea (an edit made meanwhile survives)');
    reviseMode = 'deny';
    await page.click('#awDock .v18-askb'); await page.fill('#v18AskIn', 'add a discount code'); await page.press('#v18AskIn', 'Enter'); await page.waitForTimeout(500);
    const den = await page.evaluate(() => ({ err: (document.querySelector('#v18Ask .hy-err') || {}).textContent || '', segs: document.querySelectorAll('#v18Ask .hy-segb').length }));
    ok(/used up this month/.test(den.err) && den.segs === 0, 'Ask: a 402 shows the plain reason and adds no version (got ' + den.err + ')');
    await page.evaluate(() => v18AskClose());
    // Pipeline: the same master-detail
    await page.evaluate(() => switchView('pipeline')); await page.waitForTimeout(500);
    const p = await page.evaluate(() => ({ open: !document.getElementById('awDetail').hidden, x: Math.round(document.getElementById('awDetail').getBoundingClientRect().left), v: getComputedStyle(document.getElementById('view-pipeline')).display,
      sel: !!document.querySelector('#awPipe .aw-row.v18-sel'), from: _aw.from, fn: !!document.querySelector('#awPipe .aw-head .v18-tbbtn') }));
    ok(p.open && p.x === 680 && p.v === 'block' && p.sel && p.from === 'pipeline' && p.fn, 'D2: Pipeline uses the same list + detail (and "Film next" in the toolbar)');
    ok(!errors.length, 'D2: no page errors (' + errors.slice(0, 2).join(' | ') + ')');
    await close();
  }
  // ---------------- 3b · phone: Ask for changes behind the idea page's ⋯ ----------------
  {
    const { page, calls, close } = await boot({ w: 390, h: 844, api: { revise: { ok: true, idea: { title: 'Phone v2', hook: 'h', script: 's', caption: 'c', tags: '#x', format: 'video', postType: 'tip' } } } });
    await page.evaluate(() => { switchView('ideas'); awOpen(state.find(i => i.status === 'pending').id, 'ideas'); }); await page.waitForTimeout(400);
    await page.click('#awDots'); await page.waitForTimeout(150);
    const items = await page.evaluate(() => [...document.querySelectorAll('#awDetail .aw-menu button')].map(b => b.textContent));
    ok(items.includes('Ask for changes'), 'Phone: the idea page\'s ⋯ has "Ask for changes"');
    await page.evaluate(() => { const b = [...document.querySelectorAll('#awDetail .aw-menu button')].find(x => x.textContent === 'Ask for changes'); b.click(); }); await page.waitForTimeout(200);
    await page.fill('#v18AskIn', 'shorter'); await page.press('#v18AskIn', 'Enter'); await page.waitForTimeout(400);
    ok(calls.some(c => c.name === 'revise' && c.body.kind === 'idea') && await page.evaluate(() => /Phone v2/.test(document.querySelector('#v18Ask .v18-vc').innerText)), 'Phone: the same box posts kind:\'idea\' and shows v2');
    await close();
  }
  // ---------------- 4 + 5 · D3 Settings, Notebook, ⌘K ----------------
  {
    const { page, errors, close } = await boot({ w: 1440, h: 900 });
    await page.evaluate(() => openSettings()); await page.waitForTimeout(600);
    const s = await page.evaluate(() => { const ov = document.getElementById('settingsOverlay'), rows = ov.querySelector('.v18-sprows'), body = ov.querySelector('.sp-body');
      const rr = rows && rows.getBoundingClientRect(), br = body && body.getBoundingClientRect();
      return { md: ov.classList.contains('v18-spmd'), rows: !!rows && rr.width > 300, body: !!body && br.left >= rr.right - 1, on: (ov.querySelector('.v18-sprows .aw2-srow.v18-on .aw2-lb') || {}).textContent, brain: !!body && /brand brain/i.test(body.innerText) }; });
    ok(s.md && s.rows && s.body && s.on === 'Brand brain' && s.brain, 'D3: Settings = the rows left, the Brand brain panel right (got ' + JSON.stringify(s) + ')');
    await page.evaluate(() => { const b = [...document.querySelectorAll('#settingsOverlay .v18-sprows .aw2-srow')].find(x => /Team/.test(x.textContent)); b.click(); }); await page.waitForTimeout(400);
    const t = await page.evaluate(() => { const ov = document.getElementById('settingsOverlay'); const vis = [...ov.querySelectorAll('.sp-body .sp-section')].filter(x => x.getClientRects().length > 0);
      return { on: (ov.querySelector('.v18-sprows .aw2-srow.v18-on .aw2-lb') || {}).textContent, n: vis.length, team: vis.some(x => /toggleSection\('team'\)/.test(x.innerHTML)), rows: !!ov.querySelector('.v18-sprows') }; });
    ok(t.on === 'Team' && t.rows && t.team && t.n === 1, 'D3: another row → its section on the right, the rows stay (got ' + JSON.stringify(t) + ')');
    await page.evaluate(() => toggleSettings()); await page.waitForTimeout(300);
    await page.evaluate(() => switchView('notebook')); await page.waitForTimeout(500);
    const nb = await page.evaluate(() => ({ pane: (document.getElementById('v18NotePane') || {}).innerText || '', vis: getComputedStyle(document.getElementById('v18NotePane')).display, rows: document.querySelectorAll('#awNotesBody .aw2-nrow').length,
      first: (document.querySelector('#awNotesBody .aw2-nrow .aw-rt') || {}).textContent || '' }));
    ok(nb.vis === 'block' && nb.rows >= 2 && nb.pane.includes(nb.first.slice(0, 30)), 'Notebook: the list stays left and the first note\'s page is on the right');
    await page.evaluate(() => document.querySelectorAll('#awNotesBody .aw2-nrow')[1].click()); await page.waitForTimeout(250);
    ok(await page.evaluate(() => document.getElementById('v18NotePane').innerText.includes(document.querySelectorAll('#awNotesBody .aw2-nrow .aw-rt')[1].textContent.slice(0, 30))), 'Notebook: another row → its page on the right');
    await page.keyboard.press('Meta+k'); await page.waitForTimeout(200);
    const pal = await page.evaluate(() => !!document.getElementById('csxPalette'));
    if (!pal) { await page.keyboard.press('Control+k'); await page.waitForTimeout(200); }
    ok(await page.evaluate(() => !!document.getElementById('csxPalette')), '⌘K / Ctrl K still opens the command palette');
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    ok(await page.evaluate(() => !document.getElementById('csxPalette') && !!aw2NoteObj()), 'Esc closes the palette first (the note pane stays)');
    ok(!errors.length, 'D3: no page errors (' + errors.slice(0, 2).join(' | ') + ')');
    await close();
  }
  // ---------------- 6 · phones unchanged (390) + 900–1099 untouched ----------------
  {
    const start = html.indexOf('/* ===== v718 DESKTOP LAYOUT'), end = html.indexOf('/* ===== end v718 ===== */');
    const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b); return (i > 0 && j > i) ? src.slice(0, i) + src.slice(j + b.length) : null; };
    const css1 = cut(css, '/* ============ v718 \u2014 onboarding as a chat', '/* ============ end v718 (every width) ============ */');
    const baseCss = css1 && cut(css1, '/* ============ v718 desktop \u2014', '/* ============ end v718 desktop ============ */');
    ok(start > 0 && end > start && !!baseCss && baseCss.length < css.length - 8000, '390: found the v718 script block and both v718 CSS sections');
    const SEL = ['#hyApp', '.hy-hero', '.hy-paste', '#hyFeed', '#hyDock', '#hyForm', '#hyIn', '#awIdeas', '#awIdeas .aw-head', '#awIdeas .aw-irow', '#awPipe', '#awPipe .aw-prow', '#awDetail', '#awDetail .aw-h1', '#awDock',
      '#awDock .aw-film', '#awNotes', '#awNotes .aw2-nrow', '#awTrends', '#settingsOverlay', '#settingsOverlay .aw2-srow', '.header', '#navTabs'];
    const SCREENS = [['create', 'switchView("create")'], ['ideas', 'switchView("ideas")'], ['detail', 'switchView("ideas");awOpen(state.find(i=>i.status==="pending").id,"ideas")'],
      ['pipeline', 'switchView("pipeline")'], ['notebook', 'switchView("notebook")'], ['trends', 'switchView("viral")'], ['settings', 'switchView("ideas");openSettings()']];
    async function measure(files, init){
      const { page, close } = await boot({ w: 390, h: 844, files, init, api: { 'creator-feed': FEED } });
      const outp = {};
      for (const [name, js] of SCREENS) {
        await page.evaluate(src => { try { if (document.getElementById('settingsOverlay').classList.contains('open')) toggleSettings(); } catch (e) {} (0, eval)(src); window.scrollTo(0, 0); }, js);
        await page.waitForTimeout(450);
        outp[name] = await page.evaluate(sels => { const o = {}; sels.forEach(s => { const e = document.querySelector(s); if (!e) { o[s] = null; return; } const r = e.getBoundingClientRect(), st = getComputedStyle(e);
          o[s] = st.display === 'none' || !r.width ? 'hidden' : [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(','); }); o.scrollH = document.documentElement.scrollHeight; return o; }, SEL);
      }
      await close(); return outp;
    }
    const now = await measure(null, null);
    const off = await measure({ 'clean.css': baseCss }, 'window.__v18Init = true;');
    let diffs = [];
    for (const k of Object.keys(now)) for (const s of Object.keys(now[k])) if (String(now[k][s]) !== String(off[k][s])) diffs.push(k + ' ' + s + ': ' + now[k][s] + ' vs ' + off[k][s]);
    const filled = Object.values(now).reduce((a, o) => a + Object.values(o).filter(v => v && v !== 'hidden').length, 0);
    ok(filled >= 25, '390: the snapshot measured real elements (' + filled + ' visible positions)');
    ok(!diffs.length, '390: every key element sits exactly where it does without v718 (' + (diffs.slice(0, 4).join(' | ') || 'no differences') + ')');
    const { page, close } = await boot({ w: 1000, h: 800, api: { 'creator-feed': FEED } });
    await page.evaluate(() => switchView('ideas')); await page.waitForTimeout(400);
    const m = await page.evaluate(() => ({ wide: document.body.classList.contains('v18-wide'), det: awDetailId(), rail: getComputedStyle(document.getElementById('v18Rail') || document.body).display }));
    await page.evaluate(() => switchView('create')); await page.waitForTimeout(400);
    const rail2 = await page.evaluate(() => getComputedStyle(document.getElementById('v18Rail')).display);
    ok(!m.wide && m.det == null && rail2 === 'none', '1000px (900–1099): no v718 layout — no auto-opened detail, no rail');
    await close();
  }
} catch (e) { ok(false, 'the gate crashed: ' + (e && e.stack || e)); }
await closeAll();
const { fail, n } = result();
G.done();
if (fail) { console.log('\n' + fail + ' of ' + n + ' checks FAILED'); process.exit(1); }
console.log('\nDESKTOP V718 OK (' + n + ' checks)');
