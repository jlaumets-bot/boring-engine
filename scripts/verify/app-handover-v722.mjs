#!/usr/bin/env node
// GATE (v722 app side of the landing, contract .unlazy/landing/CONTRACT.md "Hand-over to the app after sign-up"; mockups
// design-options/landing/B1 first-time, B2 returning). EXECUTED: part 1 runs the real hand-over block in node:vm; part 2 loads the
// real app.html + clean.css in headless Chromium against the in-memory fake Supabase (fixtures/v718-fake-supabase.js), every /api/*
// stubbed, every other host blocked — no network, no AI, no real database.
//   1  the big round button says exactly "Paste TikTok link"; first-time users see ONE muted line under it, "In TikTok: Share →
//      Copy link, then press here."; after the first link paste (button or input) the flag 'cs-paste-learned' is stored and the
//      line never shows again (also after a reload). Desktop (1440, D1) shows the same label and line.
//   2  app.html?link=<TikTok> (brand ready) → the main chat ('create') runs the link flow ONCE (/api/transcribe-url once), the
//      link leaves the address bar, cs-pending-link is cleared; a reload and a second tab with the same ?link= run nothing.
//      A fresh cs-pending-link (no ?link=) runs the same way.
//   3  a cs-pending-link older than 24 h is ignored (no call) and cleared.
//   4  a link that is not http(s) TikTok / YouTube (website, Instagram, javascript:, a look-alike host) is ignored.
//   5  a brand-new user: onboarding first (no call while it runs, the link survives a reload); after it finishes the link runs and
//      lands in the main chat thread — step 5 shows it running instead of "Paste a TikTok to try it", no first post on top.
// Screenshots (optional): V722_SHOTS=<dir> node scripts/verify/app-handover-v722.mjs
// RUN: node scripts/verify/app-handover-v722.mjs        EXPECT: "APP HANDOVER V722 OK", exit 0.
import fs from 'node:fs'; import path from 'node:path'; import vm from 'node:vm';
import { ROOT, ok, result, browser, closeAll, guard, USAGE } from './_v718-harness.mjs';
const G = guard('app-handover-v722', 115000);
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const FAKE = fs.readFileSync(path.join(ROOT, 'scripts', 'verify', 'fixtures', 'v718-fake-supabase.js'), 'utf8');
const SHOTS = process.env.V722_SHOTS || '';
const LABEL = 'Paste TikTok link', HELP = 'In TikTok: Share → Copy link, then press here.';
const TT = 'https://www.tiktok.com/@studioops/video/7341', TT2 = 'https://vm.tiktok.com/ZMabc123/';
const CRAWL = { brandInfo: { brandName: 'Boring Electrolytes', tagline: 'Electrolyte powder with no sugar.', targetAudience: 'People who forget to drink water',
  usps: 'Tastes like water that works', tones: ['deadpan', 'casual'], communities: ['Hydration', 'Morning routines'] } };
const API = { 'transcribe-url': { transcript: 'Their exact words.' }, 'creator-feed': { ok: true, creators: [], videos: [] }, 'crawl-brand': CRAWL };

// ---------------- part 1 · the hand-over block itself (node:vm) ----------------
{
  const between = (a, b) => { const i = html.indexOf(a), j = html.indexOf(b, i); if (i < 0 || j < 0) throw new Error('marker missing: ' + a); return html.slice(i, j); };
  const grab = n => { const i = html.indexOf('\nfunction ' + n + '('); if (i < 0) throw new Error('no ' + n); return html.slice(i + 1, html.indexOf('\n}', i) + 2); };
  const store = new Map(); let replaced = [];
  const c = { URL, URLSearchParams, JSON, Date, Number, String, Math, Promise, isFinite, console,
    localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    navigator: {}, window: { location: { search: '', href: 'https://app.test/app.html' }, history: { state: null, replaceState: (s, t, u) => replaced.push(u) } } };
  vm.createContext(c);
  vm.runInContext(grab('remixDetectKind'), c);
  vm.runInContext(between('// ===== v722 sign-up hand-over', '// ===== end v722 hand-over').replace(/^(let|const) /gm, 'var '), c);
  const V = s => vm.runInContext(s, c);
  const good = [TT, TT2, 'https://youtu.be/abc123', 'https://www.youtube.com/shorts/abc', 'http://m.tiktok.com/v/1.html'];
  const bad = ['https://example.com/video', 'https://www.instagram.com/reel/abc/', 'javascript:alert(1)//tiktok.com', 'https://tiktok.com.evil.io/x', 'https://eviltiktok.com/x',
    'tiktok.com/@a/video/1', 'ftp://www.tiktok.com/x', 'https://user:pw@www.tiktok.com/x', TT + ' extra', ''];
  ok(good.every(u => c.hoValid(u)) && bad.every(u => !c.hoValid(u)), '4 only http(s) TikTok / YouTube links pass (' + good.filter(u => !c.hoValid(u)).concat(bad.filter(u => c.hoValid(u))).join(' , ') + ')');
  // before login: ?link= is kept through the magic-link round trip, never over a link that already ran
  c.window.location.search = '?link=' + encodeURIComponent(TT);
  ok(c.hoStashEarly() === true && JSON.parse(store.get('cs-pending-link')).url === TT, '2 before login a valid ?link= is copied into cs-pending-link');
  store.clear(); store.set('cs-link-claimed', JSON.stringify({ url: TT, at: Date.now() - 1000 }));
  ok(c.hoStashEarly() === false && !store.has('cs-pending-link'), '2 …but not when that link already ran (claimed)');
  c.window.location.search = '?link=' + encodeURIComponent('https://example.com/x'); store.clear();
  ok(c.hoStashEarly() === false && !store.has('cs-pending-link'), '4 a non-TikTok ?link= is never stashed');
  // claims: same link run already → claimed; a NEWER landing paste of it (pending.at after the claim) is not
  const CAT = Date.now() - 10000; store.set('cs-link-claimed', JSON.stringify({ url: TT, at: CAT }));
  ok(c.hoClaimed(TT, 0) === true && c.hoClaimed(TT, CAT - 5000) === true && c.hoClaimed(TT, Date.now()) === false && c.hoClaimed(TT2, 0) === false, '2 the claim stops a re-run, a newer paste of the same link still runs');
  store.set('cs-link-claimed', JSON.stringify({ url: TT, at: Date.now() - 25 * 3600e3 }));
  ok(c.hoClaimed(TT, 0) === false, '2 a claim older than 24 h no longer blocks');
  // the pick: ?link= wins and leaves the address bar
  store.clear(); replaced = []; c.window.location.search = '?link=' + encodeURIComponent(TT) + '&x=1'; c.window.location.href = 'https://app.test/app.html?link=' + encodeURIComponent(TT) + '&x=1';
  const pk = c.hoPick();
  ok(pk && pk.url === TT && replaced.length === 1 && replaced[0] === '/app.html?x=1', '2 hoPick reads ?link= and removes only it from the address bar (' + replaced[0] + ')');
  c.window.location.search = ''; c.window.location.href = 'https://app.test/app.html';
  store.set('cs-pending-link', JSON.stringify({ url: TT, at: Date.now() - 25 * 3600e3 }));
  ok(c.hoPick() === null && !store.has('cs-pending-link'), '3 a pending link older than 24 h is ignored and cleared');
  store.set('cs-pending-link', JSON.stringify({ url: TT, at: new Date(Date.now() - 3600e3).toISOString() }));
  ok((c.hoPick() || {}).url === TT, '2 a pending link from an hour ago (ISO time) is picked');
}

// ---------------- part 2 · the real app in Chromium ----------------
async function context(opts = {}){
  const b = await browser();
  const ctx = await b.newContext({ viewport: { width: opts.w || 390, height: opts.h || 844 }, colorScheme: 'dark', serviceWorkers: 'block', ignoreHTTPSErrors: true });
  await ctx.addInitScript((o) => {
    try {
      if (!sessionStorage.getItem('__v722_init')) {
        sessionStorage.setItem('__v722_init', '1');
        localStorage.setItem('bc_tour_done', '1'); localStorage.setItem('cs_notif_asked', '1'); localStorage.setItem('cs-theme', 'dark');
        if (!o.nobrand) localStorage.setItem('cs_last_brand', 'b-acme');
        if (o.ls) for (const k of Object.keys(o.ls)) localStorage.setItem(k, typeof o.ls[k] === 'string' ? o.ls[k] : JSON.stringify(o.ls[k]));
      }
    } catch (e) {}
    window.__AUDIT = true; if (o.nobrand) window.__AUDIT_NOBRAND = true;
    if (o.clip) try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => o.clip, writeText: async () => {} } }); } catch (e) {}
  }, { nobrand: !!opts.nobrand, ls: opts.ls || null, clip: opts.clip || '' });
  if (opts.init) await ctx.addInitScript(opts.init);
  const calls = [];
  await ctx.route('**/*', async (route) => {
    const req = route.request(), u = new URL(req.url());
    if (u.hostname !== 'app.test') return route.abort();
    if (u.pathname === '/supabase.min.js') return route.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE });
    if (u.pathname.startsWith('/api/')) {
      const name = u.pathname.slice(5); let body = null; try { body = JSON.parse(req.postData() || 'null'); } catch (e) {}
      calls.push({ name, body });
      const h = Object.prototype.hasOwnProperty.call(API, name) ? API[name] : (name === 'usage' ? USAGE : null);
      if (h && h.__status) return route.fulfill({ status: h.__status, contentType: 'application/json', body: JSON.stringify(h.body || {}) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(h || {}) });
    }
    const rel = (u.pathname === '/' ? '/app.html' : u.pathname).slice(1), f = path.join(ROOT, rel);
    const MIME = { html: 'text/html', css: 'text/css', js: 'application/javascript', png: 'image/png', json: 'application/json', svg: 'image/svg+xml', ico: 'image/x-icon' };
    if (rel && !rel.includes('..') && fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ status: 200, contentType: MIME[rel.split('.').pop()] || 'application/octet-stream', body: fs.readFileSync(f) });
    return route.fulfill({ status: 404, body: '' });
  });
  return { ctx, calls, n: name => calls.filter(c => c.name === name).length };
}
async function open(ctx, q = ''){
  const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message || e)));
  await page.goto('https://app.test/app.html' + q, { waitUntil: 'domcontentloaded' });
  await ready(page);
  return { page, errors };
}
async function ready(page){
  await page.waitForFunction(() => typeof window.switchView === 'function' && window._csAppReady === true, null, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(1200);
}
const start = page => page.evaluate(() => { const b = document.querySelector('#hyPasteBig span'), h = document.getElementById('hyHelp'), r = document.querySelector('#hyMain .hy-ring');
  const hr = h && h.getBoundingClientRect(), rr = r && r.getBoundingClientRect();
  return { label: b ? b.textContent : null, help: h ? h.textContent : null, helpVis: !!(h && hr.width && getComputedStyle(h).display !== 'none'), under: !!(hr && rr && hr.top >= rr.bottom && Math.abs((hr.left + hr.width / 2) - (rr.left + rr.width / 2)) < 4),
    muted: h ? getComputedStyle(h).color !== getComputedStyle(b).color && parseFloat(getComputedStyle(h).fontSize) <= 15 : false, flag: localStorage.getItem('cs-paste-learned'), view: activeView, t: !!_hy.t }; });
const shot = async (page, name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name) }); };
try {
  // ---- 1 · label + one-time line (phone), first paste through the input, reload ----
  {
    const { ctx, n } = await context({ w: 390, h: 844 });
    const { page, errors } = await open(ctx);
    await page.evaluate(() => switchView('create')); await page.waitForTimeout(300);
    let s = await start(page);
    ok(s.label === LABEL, '1 the big button says exactly "' + LABEL + '" (got ' + JSON.stringify(s.label) + ')');
    ok(s.help === HELP && s.helpVis && s.under && s.muted, '1 first time: one small muted line under it, centred: "' + HELP + '" (got ' + JSON.stringify(s) + ')');
    await shot(page, 'phone-first-time.png');
    await page.fill('#hyIn', TT); await page.press('#hyIn', 'Enter');
    await page.waitForFunction(() => _hy.t && !_hy.busy, null, { timeout: 8000 }).catch(() => {});
    ok(n('transcribe-url') === 1 && await page.evaluate(() => localStorage.getItem('cs-paste-learned') === '1'), '1 the first link pasted in the input stores the flag');
    await page.evaluate(() => hyNew()); await page.waitForTimeout(100);
    s = await start(page);
    ok(s.label === LABEL && s.help === null, '1 after that first paste the line is gone (label stays)');
    await page.reload({ waitUntil: 'domcontentloaded' }); await ready(page);
    await page.evaluate(() => { switchView('create'); hyNew(); }); await page.waitForTimeout(200);
    s = await start(page);
    ok(s.label === LABEL && s.help === null && s.flag === '1', '1 the flag persists: after a reload the line never shows again');
    await shot(page, 'phone-returning.png');
    ok(!errors.length, '1 no page errors (' + errors.slice(0, 2).join(' | ') + ')');
    await ctx.close();
  }
  // ---- 1b · the big button itself (clipboard) also counts as the first paste ----
  {
    const { ctx, n } = await context({ w: 390, h: 844, clip: TT });
    const { page } = await open(ctx);
    await page.evaluate(() => switchView('create')); await page.waitForTimeout(200);
    await page.click('#hyPasteBig'); await page.waitForFunction(() => _hy.t && !_hy.busy, null, { timeout: 8000 }).catch(() => {});
    await page.evaluate(() => hyNew()); await page.waitForTimeout(100);
    const s = await start(page);
    ok(n('transcribe-url') === 1 && s.flag === '1' && s.help === null, '1 a paste from the big button stores the flag and hides the line');
    await ctx.close();
  }
  // ---- 1c · desktop D1: same label + line ----
  {
    const { ctx } = await context({ w: 1440, h: 900 });
    const { page, errors } = await open(ctx);
    await page.evaluate(() => switchView('create')); await page.waitForTimeout(500);
    const s = await start(page);
    ok(s.label === LABEL && s.help === HELP && s.helpVis && s.under, 'desktop: the same label and the same line under the button (got ' + JSON.stringify(s) + ')');
    await shot(page, 'desktop-first-time.png');
    ok(!errors.length, 'desktop: no page errors (' + errors.slice(0, 2).join(' | ') + ')');
    await ctx.close();
  }
  // ---- 2 · ?link= (brand ready): runs once, leaves the URL; reload + second tab run nothing ----
  {
    const { ctx, n } = await context({ w: 390, h: 844, ls: { 'cs-pending-link': { url: TT, at: Date.now() - 60000 } } });
    const { page, errors } = await open(ctx, '?link=' + encodeURIComponent(TT));
    await page.waitForFunction(() => _hy.t && _hy.t.src && /7341/.test(_hy.t.src.url) && !_hy.busy, null, { timeout: 10000 }).catch(() => {});
    const r = await page.evaluate(() => ({ view: activeView, url: _hy.t && _hy.t.src.url, text: _hy.t && _hy.t.src.text, search: location.search, pend: localStorage.getItem('cs-pending-link'),
      claim: localStorage.getItem('cs-link-claimed'), flag: localStorage.getItem('cs-paste-learned') }));
    ok(r.view === 'create' && /7341/.test(r.url || '') && r.text === 'Their exact words.' && n('transcribe-url') === 1, '2 ?link= opens the main chat and starts the link flow once (got ' + JSON.stringify({ view: r.view, url: r.url, calls: n('transcribe-url') }) + ')');
    ok(!/link=/.test(r.search) && r.pend === null && /7341/.test(r.claim || ''), '2 the link left the address bar, cs-pending-link is cleared, the run is claimed');
    ok(r.flag === '1', '1 a hand-over counts as the first paste (flag stored)');
    await page.reload({ waitUntil: 'domcontentloaded' }); await ready(page);
    ok(n('transcribe-url') === 1, '2 a reload does not run it again');
    const two = await open(ctx, '?link=' + encodeURIComponent(TT));
    ok(n('transcribe-url') === 1 && await two.page.evaluate(() => !/link=/.test(location.search)), '2 a second tab with the same ?link= runs nothing (and cleans its URL)');
    ok(!errors.length && !two.errors.length, '2 no page errors (' + errors.concat(two.errors).slice(0, 2).join(' | ') + ')');
    await ctx.close();
  }
  // ---- 2b · a fresh cs-pending-link alone (the magic link dropped ?link=) ----
  {
    const { ctx, n } = await context({ w: 390, h: 844, ls: { 'cs-pending-link': { url: TT2, at: Date.now() - 3600e3 } } });
    const { page } = await open(ctx);
    await page.waitForFunction(() => _hy.t && /ZMabc123/.test(_hy.t.src.url || ''), null, { timeout: 10000 }).catch(() => {});
    ok(n('transcribe-url') === 1 && await page.evaluate(() => activeView === 'create' && localStorage.getItem('cs-pending-link') === null), '2 a pending link from an hour ago runs once and is cleared');
    await ctx.close();
  }
  // ---- 3 + 4 · stale pending / not TikTok-YouTube ----
  {
    const { ctx, n } = await context({ w: 390, h: 844, ls: { 'cs-pending-link': { url: TT, at: Date.now() - 25 * 3600e3 } } });
    const { page } = await open(ctx);
    ok(n('transcribe-url') === 0 && await page.evaluate(() => !_hy.t && localStorage.getItem('cs-pending-link') === null), '3 a pending link older than 24 h is ignored (no call) and cleared');
    await ctx.close();
  }
  {
    const { ctx, n, calls } = await context({ w: 390, h: 844, ls: { 'cs-pending-link': { url: 'https://www.instagram.com/reel/abc/', at: Date.now() } } });
    const { page } = await open(ctx, '?link=' + encodeURIComponent('https://example.com/some-video'));
    const r = await page.evaluate(() => ({ t: !!_hy.t, search: location.search, pend: localStorage.getItem('cs-pending-link') }));
    ok(n('transcribe-url') === 0 && !calls.some(c => /^(transcribe|remix)$/.test(c.name)) && !r.t, '4 a website ?link= and an Instagram pending link are ignored (no thread, no call)');
    ok(!/link=/.test(r.search) && r.pend === null, '4 …and both are cleared');
    await ctx.close();
  }
  // ---- 5 · brand-new user: onboarding first, then the link runs and lands in the main chat ----
  {
    const { ctx, n, calls } = await context({ w: 390, h: 844, nobrand: true });
    let { page, errors } = await open(ctx, '?link=' + encodeURIComponent(TT));
    const onb = () => page.evaluate(() => { const o = document.getElementById('onboardingOverlay'); return !!o && !o.classList.contains('hidden'); });
    ok(await onb() && n('transcribe-url') === 0, '5 a new user gets onboarding first — the link does not run yet');
    ok(await page.evaluate(() => !/link=/.test(location.search) && JSON.parse(localStorage.getItem('cs-pending-link') || '{}').url) === TT, '5 the link is kept (cs-pending-link) and left the address bar');
    await page.reload({ waitUntil: 'domcontentloaded' }); await ready(page);
    ok(await onb() && n('transcribe-url') === 0 && await page.evaluate(() => hoHeld()), '5 a reload during onboarding keeps it waiting');
    await page.fill('#obcIn', 'boringelectrolytes.com'); await page.press('#obcIn', 'Enter');
    await page.waitForFunction(() => _obc && _obc.step === 2, null, { timeout: 15000 }).catch(() => {});
    await page.evaluate(() => { const o = window.obcFinish; window.obcFinish = function () { window.__s5 = document.getElementById('obcThread').innerText; return o.apply(this, arguments); }; });
    await page.evaluate(() => { obcLooksRight(); obcVoiceSkip(); obcCreatorsSkip(); });
    await page.waitForFunction(() => document.getElementById('onboardingOverlay').classList.contains('hidden') && activeView === 'create' && _hy.t && !_hy.busy, null, { timeout: 15000 }).catch(() => {});
    const r = await page.evaluate(() => ({ s5: window.__s5 || '', view: activeView, url: _hy.t && _hy.t.src.url, text: _hy.t && _hy.t.src.text, pend: localStorage.getItem('cs-pending-link'), brands: (window.__FAKE_DB.brands || []).length }));
    ok(/Making your version of the TikTok you pasted/.test(r.s5) && r.s5.includes(TT) && !/Paste a TikTok to try it/.test(r.s5), '5 step 5 shows the pasted link already running (not "Paste a TikTok to try it") (got ' + JSON.stringify(r.s5.slice(-160)) + ')');
    ok(r.view === 'create' && /7341/.test(r.url || '') && r.text === 'Their exact words.' && n('transcribe-url') === 1 && r.brands === 1, '5 after onboarding the link runs once and lands in the main chat (got ' + JSON.stringify({ view: r.view, url: r.url, calls: n('transcribe-url') }) + ')');
    ok(!calls.some(c => /^(write|angles|generate-ideas)$/.test(c.name)) && r.pend === null, '5 no first post generated on top; the pending link is cleared');
    ok(!errors.length, '5 no page errors (' + errors.slice(0, 2).join(' | ') + ')');
    await ctx.close();
  }
} catch (e) { ok(false, 'the gate crashed: ' + (e && e.stack || e)); }
await closeAll();
const { fail, n } = result();
G.done();
if (fail) { console.log('\n' + fail + ' of ' + n + ' checks FAILED'); process.exit(1); }
console.log('\nAPP HANDOVER V722 OK (' + n + ' checks)');
