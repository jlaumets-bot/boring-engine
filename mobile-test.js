// mobile-test.js — WEEKLY MOBILE WALKTHROUGH + BUG-FINDER for Content Shrimp.
//
// Opens the app in a real iPhone-emulated browser (390px, touch, mobile UA), logs
// in ONCE (saved), then TAPS through every screen like a real user — bottom nav,
// the More sheet, Settings, the Brain, and (with --deep) the real Generate flows.
// It RECORDS everything so you can watch how the app behaves when clicked:
//
//   • mobile-test-video.webm     ← a video of the whole run (just play it)
//   • mobile-test-trace.zip      ← INTERACTIVE: open it and scrub through every
//                                    click, seeing the live DOM + network + console
//                                    at each step:   npx playwright show-trace mobile-test-trace.zip
//   • mobile-test-report.md      ← triaged bug list (JS errors, failed APIs,
//                                    broken layout, dead buttons)
//   • mobile-test-shots/*.png    ← one screenshot per screen (evidence)
//
// ── Run (on your Mac) ─────────────────────────────────────────────────────────
//   cd ~/boring-content-engine-deploy
//   node mobile-test.js            # taps through every screen, records, finds bugs (free)
//   node mobile-test.js --deep     # ALSO taps Generate on Quick Post / Ideas / Blog (costs money)
//   APP_URL=https://boring-engine.vercel.app/app.html node mobile-test.js   # other URL
//
// First run opens a phone window on the login screen — log in with your magic link
// once; the session is saved to ./mobile-test-shots/.auth.json and reused weekly.

const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');

const APP = process.env.APP_URL || 'https://contentshrimp.com/app.html';
const ORIGIN = (() => { try { return new URL(APP).origin; } catch (e) { return ''; } })();
const DEEP = process.argv.includes('--deep');
const OUT = path.join(__dirname, 'mobile-test-shots');
const AUTH = path.join(OUT, '.auth.json');
const REPORT = path.join(__dirname, 'mobile-test-report.md');
const TRACE = path.join(__dirname, 'mobile-test-trace.zip');
const VIDEO = path.join(__dirname, 'mobile-test-video.webm');
fs.mkdirSync(OUT, { recursive: true });

// Each screen: how to REACH it (a list of real on-screen buttons to tap, by their
// onclick), a JS fallback if a tap can't find the button, and its primary Generate
// handler (checked for existence = dead-button test; tapped in --deep).
const VIEWS = [
  { id: '01-quick-post',   taps: ["switchView('today')"],                    nav: "switchView('today')",    fn: 'generateTodayTabPost', deep: true  },
  { id: '02-ideas',        taps: ["switchView('ideas')"],                    nav: "switchView('ideas')",    fn: 'generateNewIdeas',     deep: true  },
  { id: '03-pipeline',     taps: ["switchView('pipeline')"],                 nav: "switchView('pipeline')", fn: null,                   deep: false },
  { id: '04-remix',        taps: ["toggleMoreSheet()", "moreGo('create')"],  nav: "moreGo('create')",       fn: 'remixContent',         deep: false },
  { id: '05-idea-catcher', taps: ["toggleMoreSheet()", "moreGo('idea')"],    nav: "moreGo('idea')",         fn: 'ideaDevelop',          deep: false },
  { id: '06-questions',    taps: ["toggleMoreSheet()", "moreGo('questions')"],nav: "moreGo('questions')",   fn: 'fetchPAAQuestions',    deep: false },
  { id: '07-notebook',     taps: ["toggleMoreSheet()", "moreGo('notebook')"],nav: "moreGo('notebook')",     fn: 'nbSaveNote',           deep: false },
  { id: '08-blog',         taps: ["toggleMoreSheet()", "moreGo('blog')"],    nav: "moreGo('blog')",         fn: 'generateBlogPosts',    deep: true  },
  { id: '09-viral-lab',    taps: ["toggleMoreSheet()", "moreGo('viral')"],   nav: "moreGo('viral')",        fn: 'analyzeViral',         deep: false },
  { id: '10-meme-image',   taps: ["toggleMoreSheet()", "moreGo('meme')"],    nav: "moreGo('meme')",         fn: 'memeGenerate',         deep: false },
  { id: '11-settings',     taps: ["toggleSettings()"],                       nav: "(typeof toggleSettings==='function'&&toggleSettings())", fn: null, deep: false },
  { id: '12-brain',        taps: ["openBrain()"],                            nav: "(typeof openBrain==='function'&&openBrain())",           fn: null, deep: false },
];

const MEASURE = `(function(){
  var vw=innerWidth, dW=document.documentElement.scrollWidth, off=[], tap=[];
  var nodes=document.querySelectorAll('body *');
  for(var i=0;i<nodes.length;i++){var e=nodes[i];var r;try{r=e.getBoundingClientRect();}catch(x){continue;}
    if(!r.width||!r.height)continue;var c;try{c=getComputedStyle(e);}catch(x){continue;}
    if(c.visibility=='hidden'||c.display=='none'||parseFloat(c.opacity||'1')===0)continue;
    if(r.right>vw+1 && r.width<=vw+120 && r.left>=-2) off.push((e.tagName+(e.id?'#'+e.id:'')).slice(0,28)+'→'+Math.round(r.right)+'px');
    var isTap=/^(A|BUTTON)$/.test(e.tagName)||(e.getAttribute&&e.getAttribute('role')=='button');
    var txt=(e.innerText||'').trim();
    if(isTap&&txt&&(r.width<40||r.height<32)&&r.top<3000) tap.push(txt.slice(0,18)+' '+Math.round(r.width)+'x'+Math.round(r.height));
  }
  var main=document.querySelector('.view.active, #view-today, main, #app')||document.body;
  return {vw:vw, hScroll:(dW>vw+1), overflow:off.slice(0,6), smallTaps:tap.slice(0,8), mainTextLen:(main.innerText||'').trim().length};
})()`;

const bugs = [];
const add = (screen, sev, kind, detail) => bugs.push({ screen, sev, kind, detail });

(async () => {
  const browser = await chromium.launch({ headless: false });
  const haveAuth = fs.existsSync(AUTH);
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    storageState: haveAuth ? AUTH : undefined,
    recordVideo: { dir: OUT, size: { width: 390, height: 844 } },   // ← records the whole run
  });

  await context.addInitScript(() => {
    try { localStorage.setItem('bc_tour_done', '1'); } catch (e) {}
    try { localStorage.setItem('cs_onb_hidden', '1'); } catch (e) {}
    try { window.__onbDismissed = true; } catch (e) {}
    var KILL = /finish these last fields|Welcome to Content Shrimp|Quick tour|WHAT EACH FIELD POWERS|Getting started\s*·|Almost there/i;
    var SEL = '.tour-overlay,#csOnbCard,.pwa-banner,#pwaGuideOverlay';
    function nuke() {
      try {
        document.querySelectorAll(SEL).forEach(function (e) { e.remove(); });
        document.querySelectorAll('div').forEach(function (e) {
          var t = e.textContent || '';
          if (t.length < 600 && KILL.test(t)) {
            var n = e;
            for (var i = 0; i < 6 && n && n.parentElement; i++) {
              var p = n.parentElement, pos = '';
              try { pos = getComputedStyle(p).position; } catch (x) {}
              if (pos === 'fixed' || (p.className || '').toString().match(/overlay|modal|backdrop|onb/i)) { p.remove(); return; }
              n = p;
            }
            e.remove();
          }
        });
      } catch (e) {}
    }
    var start = function () {
      nuke();
      try { new MutationObserver(nuke).observe(document.body, { childList: true, subtree: true }); } catch (e) {}
      setInterval(nuke, 800);
    };
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
  });

  // interactive trace — the scrub-through-every-click recording
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true }).catch(() => {});

  const page = await context.newPage();
  const video = page.video();

  let current = 'boot';
  const IGNORE = /favicon|\.woff|fonts\.g|google-analytics|googletagmanager|doubleclick|hotjar|sentry|posthog|stripe\.com\/v3/i;
  page.on('pageerror', e => add(current, '🔴', 'JS error', (e && e.message ? e.message : String(e)).slice(0, 180)));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = (m.text() || '').slice(0, 200);
    if (IGNORE.test(t)) return;
    if (/Failed to load resource/i.test(t) && ORIGIN && !t.includes(new URL(ORIGIN).host)) return;
    add(current, '🟠', 'console.error', t);
  });
  page.on('response', r => {
    try {
      const s = r.status(), u = r.url();
      if (s < 400 || IGNORE.test(u)) return;
      if (ORIGIN && !u.startsWith(ORIGIN)) return;
      add(current, s >= 500 ? '🔴' : '🟠', 'HTTP ' + s, u.replace(/\?.*/, '').replace(ORIGIN, ''));
    } catch (e) {}
  });
  page.on('requestfailed', r => {
    try {
      const u = r.url();
      if (IGNORE.test(u) || (ORIGIN && !u.startsWith(ORIGIN))) return;
      add(current, '🟠', 'req failed', ((r.failure() && r.failure().errorText) || 'failed') + ' ' + u.replace(/\?.*/, '').replace(ORIGIN, ''));
    } catch (e) {}
  });

  await page.goto(APP, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(2500);

  // Detect the login screen AFTER load — an expired saved session must force a
  // fresh login instead of silently running the whole walkthrough logged out.
  let loggedOut = await page.evaluate(() => /Send Magic Link|Enter your email to start/i.test(document.body.innerText)).catch(() => false);
  if (!haveAuth || loggedOut) {
    if (haveAuth && loggedOut) { try { fs.unlinkSync(AUTH); } catch (e) {} console.log('\n(Your saved login expired — logging in fresh this once.)'); }
    console.log('\n============================================================');
    console.log(' A phone-sized window opened on the LOGIN screen.');
    console.log('   1) Enter your email → tap "Send Magic Link".');
    console.log('   2) Open the email, COPY the magic link.');
    console.log('   3) PASTE it into THAT phone window\'s address bar + Enter.');
    console.log('   4) When you SEE the app (Quick Post / Ideas), come back here and press ENTER.');
    console.log('============================================================\n');
    await new Promise(r => process.stdin.once('data', r));
    // wait for the app shell to actually be authenticated before capturing
    try { await page.waitForFunction(() => !!document.querySelector('.nav-tab') && !/Send Magic Link/i.test(document.body.innerText), { timeout: 120000 }); } catch (e) {}
    await page.waitForTimeout(1500);
    try { await context.storageState({ path: AUTH }); console.log('(login saved — future runs skip this)\n'); } catch (e) {}
    loggedOut = await page.evaluate(() => /Send Magic Link|Enter your email to start/i.test(document.body.innerText)).catch(() => false);
  }

  if (loggedOut) add('boot', '🔴', 'auth', 'Still on the login screen after the login step — try again.');

  const clean = async () => {
    await page.evaluate(`
      try { if (typeof endTour==='function') endTour(); } catch(e){}
      try { localStorage.setItem('bc_tour_done','1'); localStorage.setItem('cs_onb_hidden','1'); } catch(e){}
      try { window.__onbDismissed = true; } catch(e){}
      try { document.querySelectorAll('.tour-overlay,#csOnbCard,.pwa-banner,#pwaGuideOverlay').forEach(x=>x.remove()); } catch(e){}
    `).catch(() => {});
  };

  // tap a REAL button by its onclick text; returns true if a real tap happened
  const tapOnclick = async (sub) => {
    const sel = `[onclick*=${JSON.stringify(sub)}]`;
    const el = await page.$(sel);
    if (!el) return false;
    try { await el.scrollIntoViewIfNeeded({ timeout: 1200 }); } catch (e) {}
    try { await el.click({ timeout: 2500 }); return true; } catch (e) { return false; }
  };

  // reveal the whole screen in the video (human-style scroll down then back up)
  const scrollTour = async () => {
    for (const dy of [700, 700, 700]) { await page.mouse.wheel(0, dy).catch(() => {}); await page.waitForTimeout(450); }
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' })).catch(() => {});
    await page.waitForTimeout(500);
  };

  for (const v of VIEWS) {
    current = v.id;
    const before = bugs.length;
    await clean();

    // TAP the real buttons to get there (falls back to JS only if a button is missing)
    let tappedAll = true;
    for (const sub of v.taps) {
      const ok = await tapOnclick(sub);
      if (!ok) tappedAll = false;
      await page.waitForTimeout(700);
    }
    if (!tappedAll) { try { await page.evaluate(v.nav); } catch (e) { add(v.id, '🔴', 'nav', 'could not reach screen: ' + e.message.slice(0, 100)); } }
    await page.waitForTimeout(900);
    await clean();

    if (v.fn) {
      const okFn = await page.evaluate(fn => typeof window[fn] === 'function', v.fn).catch(() => false);
      if (!okFn) add(v.id, '🔴', 'dead button', `primary handler ${v.fn}() is not defined`);
    }

    let m = null;
    try { m = await page.evaluate(MEASURE); } catch (e) {}
    if (m) {
      if (m.hScroll) add(v.id, '🟠', 'overflow', 'scrolls sideways at ' + m.vw + 'px' + (m.overflow.length ? ' — ' + m.overflow.join(', ') : ''));
      if (m.smallTaps.length) add(v.id, '🟡', 'tap target', m.smallTaps.join(' · '));
      if (m.mainTextLen < 15 && !/settings|brain|pipeline/.test(v.id)) add(v.id, '🔴', 'empty screen', 'rendered almost no content (len ' + m.mainTextLen + ')');
    } else add(v.id, '🟠', 'measure', 'could not measure this screen');

    await scrollTour();

    if (DEEP && v.fn && v.deep) {
      const t0 = Date.now();
      const realTap = await tapOnclick(v.fn + '(');
      if (!realTap) { try { await page.evaluate(fn => { if (typeof window[fn] === 'function') window[fn](); }, v.fn); } catch (e) {} }
      await page.waitForTimeout(30000);         // let generation finish
      await clean();
      const errToast = await page.evaluate(() =>
        [...document.querySelectorAll('body *')].some(e => {
          const c = getComputedStyle(e); if (c.display === 'none' || c.visibility === 'hidden') return false;
          const t = (e.innerText || '');
          return t.length < 140 && /something went wrong|couldn.?t|failed|error|try again|too many|limit reached/i.test(t) && /toast|alert|error|banner|notice/i.test((e.className || '') + ' ' + (e.id || ''));
        })).catch(() => false);
      const secs = Math.round((Date.now() - t0) / 1000);
      add(v.id, errToast ? '🔴' : 'ℹ️', 'flow', `${v.fn}() ${errToast ? 'surfaced an ERROR' : 'ran, no error'} (${secs}s)`);
      await scrollTour();
    }

    const found = bugs.slice(before).filter(b => b.sev !== 'ℹ️');
    try {
      // Grow the viewport to the view's FULL content height so the evidence shot
      // captures the whole screen (the app scrolls inside an inner container, so
      // plain fullPage would crop everything below the fold).
      const full = await page.evaluate(() => {
        const sels = ['.view.active', '.main-views', '#app', '.app', 'main'];
        let h = (document.body && document.body.scrollHeight) || 0;
        sels.forEach(s => { const el = document.querySelector(s); if (el) h = Math.max(h, el.scrollHeight); });
        document.querySelectorAll('*').forEach(el => { const cs = getComputedStyle(el); if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 4) h = Math.max(h, el.scrollHeight); });
        return Math.max(h, 900);
      }).catch(() => 900);
      await page.setViewportSize({ width: 390, height: Math.min(full + 160, 8000) });
      await page.waitForTimeout(350);
      await page.screenshot({ path: path.join(OUT, v.id + '.png'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
    } catch (e) {}
    const tag = found.some(b => b.sev === '🔴') ? '🔴 FAIL' : found.length ? '🟠 warn' : '✓ ok';
    console.log(`  ${tag}  ${v.id}${found.length ? '  — ' + found.map(b => b.kind).join(', ') : ''}`);
  }

  // report
  const sevRank = { '🔴': 0, '🟠': 1, '🟡': 2, 'ℹ️': 3 };
  const real = bugs.filter(b => b.sev !== 'ℹ️');
  const red = real.filter(b => b.sev === '🔴').length;
  const org = real.filter(b => b.sev === '🟠').length;
  const yel = real.filter(b => b.sev === '🟡').length;

  let md = `# Mobile walkthrough — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}\n\n`;
  md += `App: ${APP}  ·  iPhone 13 (390px)  ·  mode: ${DEEP ? 'deep (ran Generate flows)' : 'walkthrough (no paid flows)'}\n\n`;
  md += `**${red} 🔴 bugs · ${org} 🟠 warnings · ${yel} 🟡 nits**\n\n`;
  md += `Watch it:  \`mobile-test-video.webm\`  ·  Scrub every click:  \`npx playwright show-trace mobile-test-trace.zip\`\n\n`;
  if (!real.length) md += `No JS / API / layout / dead-button issues found on any screen. ✅\n\n`;
  const byScreen = {};
  for (const b of bugs) (byScreen[b.screen] = byScreen[b.screen] || []).push(b);
  for (const v of VIEWS.map(x => x.id).concat(['boot'])) {
    const list = byScreen[v]; if (!list) continue;
    const real2 = list.filter(b => b.sev !== 'ℹ️');
    const info = list.filter(b => b.sev === 'ℹ️');
    md += `## ${v}${real2.length ? '' : ' — clean'}\n`;
    for (const b of real2.sort((a, c) => sevRank[a.sev] - sevRank[c.sev])) md += `- ${b.sev} **${b.kind}** — ${b.detail}\n`;
    for (const b of info) md += `- ${b.sev} ${b.detail}\n`;
    md += `\n`;
  }
  fs.writeFileSync(REPORT, md);

  await context.tracing.stop({ path: TRACE }).catch(() => {});
  await context.close();                 // finalizes the video
  if (video) { try { await video.saveAs(VIDEO); } catch (e) {} try { await video.delete(); } catch (e) {} }
  await browser.close();

  console.log(`\n────────────────────────────────────────`);
  console.log(`  ${red} 🔴 bugs · ${org} 🟠 warnings · ${yel} 🟡 nits`);
  console.log(`  ▶ video   mobile-test-video.webm`);
  console.log(`  ⏱ trace   npx playwright show-trace mobile-test-trace.zip`);
  console.log(`  📄 report  mobile-test-report.md`);
  console.log(`────────────────────────────────────────\n`);
  process.exit(red > 0 ? 1 : 0);
})();
