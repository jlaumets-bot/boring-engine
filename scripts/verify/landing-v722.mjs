#!/usr/bin/env node
// GATE (v722 Grok-style landing, owner-approved mockups design-options/landing/ A1–A4 + "Everything else inside", 2026-11-08).
// Contract: .unlazy/landing/CONTRACT.md (POST /api/try-transcript, hand-over 'cs-pending-link' + app.html?link=).
// STATIC (plain node):
//   S1  no "Jord" on any public page (index, faq, terms, privacy, refunds, llms.txt); each names JORG DIGITAL LTD.
//   S2  "Everything else inside" lists exactly the 11 approved features, and each label maps to a real function / view in app.html.
//   S3  "How it works" is headed exactly "Four steps." (no time claim) with the 4 steps; the v714 phone loop sits beside it.
//   S4  the paste script calls ONE endpoint (/api/try-transcript), stores 'cs-pending-link', opens /app.html?link=, and writes
//       server text only with textContent; no other /api/ path, no external URL beyond the v713 list, no src= / url( / @import.
//   S5  pricing = the real plans and prices (Free $0, Pro $24 with "2 brands" and "Coach", Agency $79), no "Assistant";
//       FAQ = the 9 existing questions as <details>; no gradient(, no emoji; reduced-motion CSS present.
// EXECUTED in headless Chromium (the real index.html; every other host blocked; /api/try-transcript stubbed):
//   B1  1440×900 first screen has exactly: logo "Content Shrimp", "Log in", "Start free"; the h1; the sub-line; the big input
//       "Paste a TikTok link…" with the clipboard button and the send arrow; the 4 tiny steps. Nothing below shows above the fold.
//   B2  paste → ONE POST /api/try-transcript {url} → "Here's what they said" + creator · length + the words; "Your version — one
//       step away" is blurred placeholder bars with NO text; the 6 twist pills are disabled; no other /api/ call (no AI).
//   B3  the clipboard button reads navigator.clipboard.readText and submits; without clipboard access a friendly line shows, no call.
//   B4  "Make it yours — free" stores {url, at} in localStorage 'cs-pending-link' and navigates to /app.html?link=<encoded>.
//   B5  every contract error code shows its own friendly line; limit_reached and busy offer "Sign up free to continue";
//       a non-TikTok/YouTube link never reaches the server; a network failure shows the "failed" line.
//   B6  XSS in transcript / creator is shown as text: no element is created, no script runs.
//   B7  390×844: no horizontal scroll (first screen, after paste, whole page); after paste the call to action is on screen.
//   B8  reduced motion: the phone loop shows frame 3 and does not advance.
// RUN: node scripts/verify/landing-v722.mjs     EXPECT: "LANDING V722 OK", exit 0. If Chromium cannot start the gate FAILS.
import fs from 'node:fs'; import path from 'node:path'; import vm from 'node:vm'; import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const html = read('index.html'), app = read('app.html');
const live = html.replace(/<!--[\s\S]*?-->/g, ' ');
let fail = 0, finished = false;
const ok = (c, m) => { if (!c) { fail++; console.log('FAIL:', m); } else console.log('ok:', m); return !!c; };
process.on('exit', (code) => { if (!finished && code === 0) { console.log('FAIL: the gate ended before all checks ran'); process.exitCode = 1; } });
setTimeout(() => { console.log('FAIL: wall clock (110s) exceeded'); process.exit(2); }, 110000).unref();
const text = s => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&mdash;/g, '—').replace(/&middot;/g, '·').replace(/\s+/g, ' ').trim();
function elementAt(src, i) {
  const tag = /^<([a-z][a-z0-9]*)/i.exec(src.slice(i)); if (!tag) return '';
  const re = new RegExp('<(/?)' + tag[1] + '\\b[^>]*>', 'gi'); re.lastIndex = i; let depth = 0, t;
  while ((t = re.exec(src))) { if (t[1]) { if (--depth === 0) return src.slice(i, re.lastIndex); } else if (!/\/>$/.test(t[0])) depth++; }
  return '';
}
const byId = id => { const i = live.search(new RegExp('<[a-z]+\\b[^>]*\\bid="' + id + '"')); return i < 0 ? '' : elementAt(live, i); };

/* ---------------- S1 company name ---------------- */
for (const f of ['index.html', 'faq.html', 'terms.html', 'privacy.html', 'refunds.html', 'llms.txt']) {
  const s = read(f);
  const m = s.match(/.{0,30}jord.{0,30}/i);
  ok(!m, 'S1 ' + f + ' has no "Jord"' + (m ? ' — ' + m[0] : ''));
  ok(/JORG DIGITAL LTD/.test(s), 'S1 ' + f + ' names JORG DIGITAL LTD');
}

/* ---------------- S2 Everything else inside ---------------- */
// label → the function or view in app.html that IS that feature (every one must be present)
const FEATURES = {
  daily: ['Daily ideas', [/async function csOpenPushIdeas\(/, /async function enableDailyPush\(/]],
  week: ['Plan my week', [/async function awPlanWeek\(/]],
  trends: ['Trends', [/_dsItem\('viral','Trends'\)/]],
  search: ['What people search', [/_dsItem\('questions','What people search'\)/, /function fetchPAAQuestions\(/]],
  coach: ['Coach', [/data-tab="coach" onclick="bvTabClick\(\)"/, /function openBrandVoice\(/]],
  creators: ['New from your creators', [/function hyFeedHtml\(/, /New from your creators/, /const CF_MAX_CREATORS = 5;/, /'× their usual'/]],
  notebook: ['Notebook', [/function renderNotebook\(/, /async function saveNotebookToDB\(|function saveNotebookToDB\(/]],
  pipeline: ['Pipeline', [/function renderPipeline\(/, /Ready → Film & Post → Done/]],
  split: ['Split-screen video', [/function renderSplitScreen\(/, /function openBroll\(/]],
  slides: ['Slides', [/function openCarouselMaker\(/]],
  changes: ['Ask for changes', [/aria-label="Ask for changes"/, /function hyRevise\(/]],
};
const inside = byId('inside');
ok(/<h2>Everything else inside<\/h2>/.test(inside), 'S2 the section is headed "Everything else inside"');
const feats = [...inside.matchAll(/<li class="lp-feat" data-feature="([a-z]+)">[\s\S]*?<h3>([^<]+)<\/h3><p>([^<]+)<\/p>/g)].map(m => ({ key: m[1], label: m[2], line: m[3] }));
ok((inside.match(/<li\b/g) || []).length === feats.length, 'S2 every item in the grid is a recognised feature row');
ok(feats.map(f => f.key).join(',') === Object.keys(FEATURES).join(','), 'S2 exactly the 11 approved features, in order (' + feats.map(f => f.key).join(',') + ')');
for (const f of feats) {
  const want = FEATURES[f.key];
  if (!ok(!!want, 'S2 "' + f.label + '" is a known feature')) continue;
  ok(f.label === want[0], 'S2 ' + f.key + ' is labelled "' + want[0] + '" (' + f.label + ')');
  const miss = want[1].filter(re => !re.test(app));
  ok(!miss.length, 'S2 "' + f.label + '" exists in app.html' + (miss.length ? ' — missing ' + miss.join(' ') : ''));
  ok(f.line.length > 10 && f.line.length <= 90, 'S2 "' + f.label + '" has one short line');
}
ok(/<svg\b/.test(inside) && !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text(inside)), 'S2 line icons, no emoji');

/* ---------------- S3 How it works ---------------- */
const how = byId('how');
ok(/<h2>Four steps\.<\/h2>/.test(how), 'S3 heading is exactly "Four steps."');
ok(!/minute|second|instant/i.test(text(how.replace(/<div class="hero-demo"[\s\S]*$/, ''))), 'S3 no time claim next to the steps');
const steps = [...how.matchAll(/<b class="t">([^<]+)<\/b>/g)].map(m => m[1]);
ok(steps.join('|') === 'Paste link|Exact words|Your version|Film it', 'S3 the 4 steps (' + steps.join('|') + ')');
ok(/id="heroDemo"/.test(how) && /data-site-mock aria-hidden="true"/.test(how) && (how.match(/class="hd-frame\b/g) || []).length === 5, 'S3 the v714 phone loop (5 frames) sits beside the steps');

/* ---------------- S4 the paste script ---------------- */
const scripts = [...live.matchAll(/<script(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const js = scripts.find(s => /getElementById\('tryForm'\)/.test(s)) || '';
let parses = false; try { new vm.Script(js); parses = !!js; } catch (e) {}
ok(parses, 'S4 the paste script exists and parses');
ok([...live.matchAll(/['"]\/api\/[a-z-]+/g)].map(m => m[0].slice(1)).join(',') === '/api/try-transcript', 'S4 the page names exactly one endpoint: /api/try-transcript');
ok(/KEY='cs-pending-link'/.test(js) && /localStorage\.setItem\(KEY,JSON\.stringify\(\{url:url,at:Date\.now\(\)\}\)\)/.test(js), "S4 hand-over stored as 'cs-pending-link' {url, at}");
ok(/APP\+'\?link='\+encodeURIComponent\(url\)/.test(js) && /APP='\/app\.html'/.test(js), 'S4 hand-over opens /app.html?link=<encoded> (the Start free target)');
ok((js.match(/innerHTML/g) || []).length === 1 && /b\.innerHTML='<i><\/i><i><\/i><i><\/i>'/.test(js), 'S4 innerHTML is used once, for the constant loading bars only');
const ALLOWED = new Set(['https://contentshrimp.com', 'https://contentshrimp.com/', 'https://contentshrimp.com/og-image.png',
  'https://fonts.googleapis.com', 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap', 'https://fonts.gstatic.com', 'https://schema.org']);
const extra = [...new Set([...html.matchAll(/(?:https?:)?\/\/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+[^"'\s)<>]*/g)].map(m => m[0]))].filter(u => !ALLOWED.has(u));
ok(!extra.length, 'S4 no external URL added' + (extra.length ? ' — ' + extra.join(', ') : ''));
ok(!/\bsrc\s*=/.test(live) && !/url\(/.test(live) && !/@import/.test(live), 'S4 no src=, url( or @import');

/* ---------------- S5 pricing, FAQ, look ---------------- */
const pricing = byId('pricing');
const amts = [...pricing.matchAll(/<div class="price-amt">([^<]+)<small>\/mo<\/small>/g)].map(m => m[1]);
ok(amts.join(',') === '$0,$24,$79', 'S5 three plans at $0 / $24 / $79 (' + amts.join(',') + ')');
const proAt = pricing.indexOf('<div class="price pro"'), pro = proAt >= 0 ? elementAt(pricing, proAt) : '';
ok(/2 brands on one account/.test(pro) && /Coach/.test(pro) && /7 days free/.test(pro), 'S5 Pro: 2 brands, Coach, 7 days free');
ok(!/Assistant/.test(pricing), 'S5 "Coach", not "Assistant"');
ok(/<h2>Try Pro free for 7 days\. No card\.<\/h2>/.test(pricing), 'S5 pricing heading from the mockup');
const faqs = [...byId('faq').matchAll(/<details class="fq"><summary>([\s\S]*?)<span/g)].map(m => m[1].trim());
ok(faqs.length === 9 && faqs.some(q => /sound like me/.test(q)) && faqs.some(q => /free trial/.test(q)), 'S5 the 9 existing FAQ questions as a <details> accordion (' + faqs.length + ')');
ok(!/gradient\s*\(/i.test(html), 'S5 no gradient(');
const vis = text(live.replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/g, ' '));
ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(vis), 'S5 no emoji in visible text');
ok(/@media\(prefers-reduced-motion:reduce\)\{[\s\S]*?\.hd-frame,\.hd-frame \*,\.hd-dot::before\{animation:none!important;transition:none!important\}/.test(live), 'S5 reduced-motion CSS stops the loop');

/* ---------------- browser ---------------- */
const LINK = 'https://www.tiktok.com/@calm.creator/video/7301';
const OKBODY = { ok: true, transcript: "Nobody tells you this about mornings. You don't need an hour.\nYou need one thing you never skip. Mine is ten minutes outside.", creator: 'calm.creator', durationSec: 24, videoId: '7301', cached: false };
const LINES = {
  bad_link: "That doesn't look like a TikTok or YouTube link. In TikTok, tap Share, then Copy link, and paste it here.",
  too_long: 'That video is longer than 3 minutes. Try a shorter one here.',
  limit_reached: "You've used today's free tries on this page. Sign up free to continue",
  busy: 'Lots of people are trying this right now, so the free tries are paused for today. Sign up free to continue',
  no_words: "We couldn't hear any words in that video. Try one where someone talks.",
  failed: 'Something went wrong reading that video. Try again in a moment.',
};
let browser;
try { browser = await chromium.launch({ headless: true }); } catch (e) { ok(false, 'Chromium starts (' + String(e.message).split('\n')[0] + ') — run `npx playwright install chromium`'); finished = true; process.exit(1); }
async function boot({ w = 1440, h = 900, api, reduced = false, init } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: 'dark', reducedMotion: reduced ? 'reduce' : 'no-preference', serviceWorkers: 'block' });
  if (init) await ctx.addInitScript(init);
  const calls = [];
  await ctx.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url());
    if (u.hostname !== 'site.test') return route.abort();
    if (u.pathname.startsWith('/api/')) {
      let body = null; try { body = JSON.parse(req.postData() || 'null'); } catch (e) {}
      calls.push({ path: u.pathname, method: req.method(), body });
      const r = typeof api === 'function' ? await api(u.pathname, body) : { status: 200, body: OKBODY };
      if (r === 'abort') return route.abort();
      return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body) });
    }
    if (u.pathname === '/app.html') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>app</title><p>app</p>' });
    const rel = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
    if (rel === 'index.html') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    return route.fulfill({ status: 404, body: '' });
  });
  const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(String(e.message || e)));
  await page.goto('https://site.test/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(150);
  return { ctx, page, calls, errors };
}
const submit = async (page, url) => { await page.fill('#tryUrl', url); await page.click('#trySend'); };
const hintOf = page => page.evaluate(() => document.getElementById('tryHint').textContent.trim());
try {
  /* B1 */
  {
    const { ctx, page, errors } = await boot();
    const f = await page.evaluate(() => {
      const inView = el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && s.visibility !== 'hidden' && s.display !== 'none'; };
      const nav = document.querySelector('.lp-nav');
      const ctrls = [...document.querySelectorAll('a,button,input')].filter(inView).map(e => (e.tagName + ':' + (e.getAttribute('aria-label') || e.placeholder || e.textContent).trim()));
      const texts = [...document.querySelectorAll('body *')].filter(e => [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && inView(e)).map(e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join(' ').trim());
      return { navLinks: [...nav.querySelectorAll('a')].map(a => a.textContent.trim() + '→' + a.getAttribute('href')), ctrls, texts,
        h1: document.querySelector('h1').textContent, sub: document.querySelector('.lp-sub').textContent,
        ph: document.getElementById('tryUrl').placeholder, steps: [...document.querySelectorAll('#trySteps li')].map(l => l.textContent.trim()),
        revHidden: document.getElementById('tryOut').hidden, howTop: document.getElementById('how').getBoundingClientRect().top };
    });
    ok(f.navLinks.join(' | ') === 'Content Shrimp→/ | Log in→/app.html | Start free→/app.html', 'B1 top bar = logo, Log in, Start free (' + f.navLinks.join(' | ') + ')');
    ok(f.h1 === 'Paste any TikTok. Make it yours.', 'B1 the h1');
    ok(f.sub === 'Get the exact words, your own version, and a teleprompter to film it.', 'B1 the sub-line');
    ok(f.ph === 'Paste a TikTok link…', 'B1 the big input "Paste a TikTok link…"');
    ok(f.steps.join(' · ') === 'Paste link · Exact words · Your version · Film it', 'B1 the 4 tiny steps');
    const want = ['A:Content Shrimp', 'A:Log in', 'A:Start free', 'BUTTON:Paste from clipboard', 'INPUT:Paste a TikTok link…', 'BUTTON:Get the words'];
    ok(f.ctrls.join('|') === want.join('|'), 'B1 the only controls on the first screen: ' + f.ctrls.join('|'));
    const wantTexts = ['Content Shrimp', 'Log in', 'Start free', 'Paste any TikTok.', 'Make it yours.', 'Get the exact words, your own version, and a teleprompter to film it.', 'TikTok link', 'Paste link', 'Exact words', 'Your version', 'Film it'];
    ok(f.texts.filter(t => !wantTexts.includes(t)).length === 0, 'B1 no other text on the first screen (' + f.texts.filter(t => !wantTexts.includes(t)).join(' | ') + ')');
    ok(f.revHidden && f.howTop >= 900, 'B1 the reveal is hidden and "How it works" starts below the fold');
    ok(!errors.length, 'B1 no page errors ' + errors.join(' | '));
    await ctx.close();
  }
  /* B2 + B4 */
  {
    const { ctx, page, calls, errors } = await boot();
    await submit(page, LINK);
    await page.waitForSelector('#tryOut[data-state="ready"]', { timeout: 5000 }).catch(() => {});
    const r = await page.evaluate(() => ({
      say: [...document.querySelectorAll('#tryOut .lp-say')].map(e => e.textContent.trim()), meta: document.getElementById('tryMeta').textContent,
      lines: [...document.querySelectorAll('#tryWords p')].map(p => p.textContent), skelText: document.querySelector('#tryOut .lp-skel').textContent.trim(),
      skelBars: document.querySelectorAll('#tryOut .lp-skel i').length, blur: getComputedStyle(document.querySelector('#tryOut .lp-skel')).filter,
      pills: [...document.querySelectorAll('#tryOut .lp-pills button')].map(b => b.textContent + (b.disabled ? ':off' : ':ON')),
      go: document.getElementById('tryGo').textContent.trim(), small: document.querySelector('#tryOut .lp-cta .m').textContent.trim(), open: !document.getElementById('tryOut').hidden }));
    const posts = calls.filter(c => c.path === '/api/try-transcript');
    ok(posts.length === 1 && posts[0].method === 'POST' && posts[0].body && posts[0].body.url === LINK && Object.keys(posts[0].body).join() === 'url', 'B2 one POST /api/try-transcript {url}');
    ok(calls.length === 1, 'B2 no other /api/ call — no AI before sign-up (' + calls.map(c => c.path).join(',') + ')');
    ok(r.open && r.say.join(' | ') === "Here's what they said | Your version — one step away", 'B2 "Here\'s what they said" then "Your version — one step away"');
    ok(r.meta === '@calm.creator · 0:24', 'B2 the transcript card shows creator and length (' + r.meta + ')');
    ok(r.lines.join(' ') === OKBODY.transcript.replace('\n', ' ') && r.lines.length === 4, 'B2 the exact words are shown, line by line');
    ok(r.skelText === '' && r.skelBars === 4 && /blur\(/.test(r.blur), 'B2 "Your version" is blurred placeholder bars with no text (' + r.blur + ')');
    ok(r.pills.join(',') === 'My take:off,Simplify:off,Flip it:off,Different format:off,Series:off,Roast & respond:off', 'B2 the twist pills are shown disabled');
    ok(r.go === 'Make it yours — free' && r.small === 'Email sign-in link, no password', 'B2 the primary button and the small line');
    await Promise.all([page.waitForURL(/\/app\.html/, { timeout: 5000 }).catch(() => {}), page.click('#tryGo')]);
    const u = new URL(page.url());
    const stored = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('cs-pending-link')); } catch (e) { return null; } });
    ok(u.pathname === '/app.html' && u.searchParams.get('link') === LINK && u.search === '?link=' + encodeURIComponent(LINK), 'B4 "Make it yours — free" opens /app.html?link=<encoded> (' + u.pathname + u.search + ')');
    ok(stored && stored.url === LINK && typeof stored.at === 'number' && Math.abs(Date.now() - stored.at) < 60000, "B4 'cs-pending-link' holds {url, at}");
    ok(!errors.length, 'B2 no page errors ' + errors.join(' | '));
    await ctx.close();
  }
  /* B3 clipboard */
  {
    const { ctx, page, calls } = await boot({ init: `Object.defineProperty(navigator,'clipboard',{configurable:true,value:{readText:()=>Promise.resolve('  ${LINK}  ')}});` });
    await page.click('#tryPaste'); await page.waitForTimeout(400);
    ok(calls.length === 1 && calls[0].body.url === LINK && await page.inputValue('#tryUrl') === LINK, 'B3 the clipboard button reads the clipboard, fills the box and submits');
    await ctx.close();
    const b = await boot({ init: `Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined});` });
    await b.page.click('#tryPaste'); await b.page.waitForTimeout(200);
    ok(b.calls.length === 0 && /didn't let us read the clipboard/.test(await hintOf(b.page)) && await b.page.evaluate(() => document.activeElement.id) === 'tryUrl', 'B3 fallback: no clipboard access → a friendly line, the box focused, no call');
    await b.ctx.close();
  }
  /* B5 errors */
  {
    let mode = 'ok';
    const STATUS = { bad_link: 400, too_long: 400, limit_reached: 429, busy: 503, no_words: 422, failed: 500 };
    const { ctx, page, calls } = await boot({ api: () => mode === 'net' ? 'abort' : mode === 'weird' ? { status: 500, body: { error: '<b>boom</b>', code: 'surprise' } } : { status: STATUS[mode], body: { error: 'server words <i>x</i>', code: mode } } });
    for (const code of Object.keys(LINES)) {
      mode = code; await submit(page, LINK + '?v=' + code); await page.waitForTimeout(250);
      const h = await hintOf(page), link = await page.evaluate(() => { const a = document.getElementById('trySignup'); return a ? a.textContent + '→' + a.getAttribute('href') : ''; });
      ok(h === LINES[code], 'B5 ' + code + ' shows its friendly line (' + h + ')');
      ok((code === 'limit_reached' || code === 'busy') === (link === 'Sign up free to continue→/app.html'), 'B5 ' + code + (code === 'limit_reached' || code === 'busy' ? ' offers' : ' does not offer') + ' "Sign up free to continue"');
      ok(await page.evaluate(() => document.getElementById('tryOut').hidden), 'B5 ' + code + ' leaves no half-open reveal');
    }
    mode = 'weird'; await submit(page, LINK + '?v=w'); await page.waitForTimeout(250);
    ok(await hintOf(page) === LINES.failed, 'B5 an unknown code shows the "failed" line, never the server text');
    mode = 'net'; await submit(page, LINK + '?v=n'); await page.waitForTimeout(250);
    ok(await hintOf(page) === LINES.failed, 'B5 a network failure shows the "failed" line');
    const before = calls.length;
    for (const bad of ['https://example.com/@x/video/1', 'javascript:alert(1)', 'tiktok', 'https://tiktok.com.evil.io/v/1']) { await submit(page, bad); await page.waitForTimeout(80); }
    ok(calls.length === before && await hintOf(page) === LINES.bad_link, 'B5 links that are not TikTok/YouTube never reach the server and show the bad_link line');
    mode = 'limit_reached'; await submit(page, LINK + '?v=s'); await page.waitForTimeout(250);
    await Promise.all([page.waitForURL(/\/app\.html/, { timeout: 5000 }).catch(() => {}), page.click('#trySignup')]);
    ok(new URL(page.url()).searchParams.get('link') === LINK + '?v=s', 'B5 "Sign up free to continue" carries the link to the app');
    await ctx.close();
  }
  /* B6 XSS */
  {
    const evil = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script> said it.';
    const { ctx, page } = await boot({ api: () => ({ status: 200, body: Object.assign({}, OKBODY, { transcript: evil, creator: '<b onmouseover="window.__xss=3">bad</b>' }) }) });
    await submit(page, LINK); await page.waitForSelector('#tryOut[data-state="ready"]', { timeout: 5000 }).catch(() => {}); await page.waitForTimeout(200);
    const x = await page.evaluate(() => ({ els: document.querySelectorAll('#tryOut img, #tryOut script, #tryOut b').length, flag: window.__xss, words: document.getElementById('tryWords').textContent, meta: document.getElementById('tryMeta').textContent }));
    ok(x.els === 0 && x.flag === undefined && x.words.includes('<img src=x') && x.meta.includes('<b onmouseover'), 'B6 server text is shown as text — no element, no script (' + JSON.stringify(x).slice(0, 160) + ')');
    await ctx.close();
  }
  /* B7 phone */
  {
    const { ctx, page } = await boot({ w: 390, h: 844 });
    const sw = () => page.evaluate(() => document.documentElement.scrollWidth);
    ok(await sw() <= 390, 'B7 390px first screen: no horizontal scroll');
    const g = await page.evaluate(() => { const r = document.querySelector('.lp-in').getBoundingClientRect(); return [Math.round(r.left), Math.round(innerWidth - r.right)]; });
    ok(g[0] >= 16 && g[1] >= 16, 'B7 the input keeps the 16px side gutters (' + g + ')');
    await submit(page, LINK); await page.waitForSelector('#tryOut[data-state="ready"]', { timeout: 5000 }).catch(() => {}); await page.waitForTimeout(200);
    ok(await sw() <= 390, 'B7 after paste: no horizontal scroll');
    const cta = await page.evaluate(() => { const r = document.getElementById('tryGo').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
    ok(cta, 'B7 after paste the "Make it yours — free" button is on screen');
    const wide = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1 && !e.closest('[data-site-mock]')).map(e => e.className || e.tagName).slice(0, 5));
    ok(!wide.length && await sw() <= 390, 'B7 nothing on the whole page sticks out past 390px (' + wide.join(',') + ')');
    await ctx.close();
  }
  /* B8 reduced motion */
  {
    const { ctx, page } = await boot({ reduced: true });
    const a = await page.evaluate(() => [...document.querySelectorAll('.hd-frame')].findIndex(f => f.classList.contains('on')));
    await page.waitForTimeout(3200);
    const b = await page.evaluate(() => [...document.querySelectorAll('.hd-frame')].findIndex(f => f.classList.contains('on')));
    ok(a === 2 && b === 2, 'B8 reduced motion: the phone loop rests on frame 3 (' + a + ',' + b + ')');
    await ctx.close();
  }
} catch (e) { ok(false, 'browser checks crashed: ' + (e && e.stack || e)); }
await browser.close().catch(() => {});
finished = true;
if (fail) { console.log('\nLANDING V722 FAILED (' + fail + ')'); process.exit(1); }
console.log('\nLANDING V722 OK');
