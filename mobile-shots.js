// mobile-shots.js — capture true phone-view screenshots of every app screen.
// Opens a real iPhone-emulated browser (390px, touch, mobile UA) so the app's
// mobile layout actually renders. You log in ONCE (saved for next time); it then
// dismisses the tour/onboarding overlays and screenshots every view into
// ./mobile-shots/ . Claude reads those PNGs and audits the mobile UI.
//
// Run:
//   cd ~/boring-content-engine-deploy
//   npm i playwright && npx playwright install chromium   # first time only
//   node mobile-shots.js
//
// (Optional) different URL:  APP_URL=https://boring-engine.vercel.app/app.html node mobile-shots.js

const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');

const APP = process.env.APP_URL || 'https://contentshrimp.com/app.html';
const OUT = path.join(__dirname, 'mobile-shots');
const AUTH = path.join(OUT, '.auth.json');   // saved login (your machine only; Claude never reads it)
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: false });
  const haveAuth = fs.existsSync(AUTH);
  const context = await browser.newContext({ ...devices['iPhone 13'], storageState: haveAuth ? AUTH : undefined });

  // Kill onboarding/tour/completeness popups BEFORE app JS runs, and keep killing
  // them (they re-render) via a MutationObserver. Runs on every page in this context.
  await context.addInitScript(() => {
    try { localStorage.setItem('bc_tour_done', '1'); } catch (e) {}
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
              var p = n.parentElement;
              var pos = '';
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
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start);
  });

  const page = await context.newPage();
  await page.goto(APP, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(2500);

  // Detect an expired/invalid saved session: if the app is STILL on the login
  // screen after loading, the saved .auth.json is stale — force a fresh login
  // instead of silently screenshotting the login page for every screen.
  const onLoginScreen = await page.evaluate(() => {
    try {
      if (document.querySelector('.nav-tab')) return false;
      const t = (document.body && document.body.innerText) || '';
      return /Send Magic Link|email to start/i.test(t);
    } catch (e) { return false; }
  });
  if (haveAuth && onLoginScreen) {
    try { fs.unlinkSync(AUTH); } catch (e) {}
    console.log('\n(Your saved login has expired — logging in fresh this once.)');
  }

  if (!haveAuth || onLoginScreen) {
    console.log('\n============================================================');
    console.log(' A phone-sized window just opened on the login screen.');
    console.log('   1) Enter your email, tap "Send Magic Link".');
    console.log('   2) Open the email, COPY the magic link.');
    console.log('   3) PASTE it into THAT phone window\'s address bar + Enter.');
    console.log('   4) When you SEE the app (Quick Post / Ideas), switch back');
    console.log('      here and press ENTER to start capturing.');
    console.log('============================================================\n');
    await new Promise(r => process.stdin.once('data', r));
    try { await context.storageState({ path: AUTH }); console.log('(login saved — future runs skip this step)\n'); } catch (e) {}
  } else {
    console.log('\nUsing saved login. Capturing…\n');
  }

  // Kill every onboarding/tour/overlay that would cover the real screens.
  const clean = async () => {
    try { await page.keyboard.press('Escape'); } catch (e) {}
    await page.evaluate(`
      try { if (typeof endTour === 'function') endTour(); } catch(e){}
      try { if (typeof closeMoreSheet === 'function') closeMoreSheet(); } catch(e){}
      try { localStorage.setItem('bc_tour_done','1'); } catch(e){}
      try { window.__onbDismissed = true; } catch(e){}
      try {
        document.querySelectorAll('.tour-overlay, #csOnbCard, .pwa-banner, #pwaGuideOverlay').forEach(x=>x.remove());
        // remove any leftover modal wrappers (welcome tour / "finish these last fields" completeness)
        document.querySelectorAll('div').forEach(function(e){
          var t = e.textContent || '';
          if (t.length < 500 && /finish these last fields|Welcome to Content Shrimp|Quick tour, 30 seconds/i.test(t)) {
            var n = e;
            for (var i=0;i<5 && n && n.parentElement;i++){
              if ((n.className||'').toString().match(/overlay|modal|backdrop|onb/i)) { n.remove(); return; }
              n = n.parentElement;
            }
            e.remove();
          }
        });
      } catch(e){}
    `).catch(() => {});
  };

  const shot = async (name, js) => {
    await clean();
    if (js) { try { await page.evaluate(js); } catch (e) { console.log('   (nav note ' + name + ': ' + e.message + ')'); } }
    await page.waitForTimeout(900);
    await clean();                 // clean again after navigating (some overlays re-open)
    await page.waitForTimeout(700);
    try {
      // The app scrolls inside an inner container (fixed header + bottom nav), so
      // plain fullPage only grabs one screen. Grow the viewport to the view's FULL
      // content height so the whole screen is captured top-to-bottom, then reset.
      const full = await page.evaluate(() => {
        const sels = ['.view.active', '.main-views', '#app', '.app', 'main'];
        let h = (document.body && document.body.scrollHeight) || 0;
        sels.forEach(s => { const el = document.querySelector(s); if (el) h = Math.max(h, el.scrollHeight); });
        // also expand any inner scroller so nothing is clipped
        document.querySelectorAll('*').forEach(el => {
          const cs = getComputedStyle(el);
          if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 4) {
            h = Math.max(h, el.scrollHeight);
          }
        });
        return Math.max(h, 900);
      });
      await page.setViewportSize({ width: 390, height: Math.min(full + 160, 8000) });
      await page.waitForTimeout(450);
      await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });   // reset for next view's mobile layout
      console.log('   ✓ ' + name);
    }
    catch (e) { console.log('   ✗ ' + name + ' — ' + e.message); }
  };

  await shot('01-quick-post',         "switchView('today')");
  await shot('02-ideas',              "switchView('ideas')");
  await shot('03-pipeline',           "switchView('pipeline')");
  await shot('04-more-sheet',         "toggleMoreSheet()");
  await shot('05-remix',              "moreGo('create')");
  await shot('06-idea-catcher',       "moreGo('idea')");
  await shot('07-what-people-search', "moreGo('questions')");
  await shot('08-notebook',           "moreGo('notebook')");
  await shot('09-blog',               "moreGo('blog')");
  await shot('10-viral-lab',          "moreGo('viral')");
  await shot('11-meme-image',         "moreGo('meme')");
  await shot('12-done-for-you',       "moreGo('dfy')");
  await shot('13-assistant',          "switchView('today'); (typeof bvTabClick==='function' && bvTabClick())");
  await shot('14-settings',           "(typeof toggleSettings==='function' && toggleSettings())");
  await shot('15-brand-dropdown',     "switchView('today'); (typeof toggleBrandSwitcher==='function' && toggleBrandSwitcher())");

  console.log('\nDone. Screenshots saved in: ' + OUT);
  console.log('Tell Claude "screenshots are ready".\n');
  await browser.close();
  process.exit(0);
})();
