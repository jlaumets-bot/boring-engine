// v718 shared harness for desktop-v718.mjs and onboarding-chat-v718.mjs (leading "_" = not a gate; run-suite skips it).
// Loads the REAL app.html + clean.css in headless Chromium as a signed-in user. Supabase is the in-memory fake in
// fixtures/v718-fake-supabase.js (window.__FAKE_DB); every /api/* answer is a stub the gate passes in; every other host is
// blocked, so nothing reaches the network, no AI is called and nothing is written to a real database.
// If Chromium cannot start, the gate FAILS (it never skips): run `npx playwright install chromium` once on that machine.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FAKE = fs.readFileSync(path.join(ROOT, 'scripts', 'verify', 'fixtures', 'v718-fake-supabase.js'), 'utf8');
const MIME = { html: 'text/html', css: 'text/css', js: 'application/javascript', png: 'image/png', json: 'application/json', svg: 'image/svg+xml', ico: 'image/x-icon' };
export const USAGE = { plan: 'pro', used: 42, limit: 750, brands: { used: 2, limit: 5 } };
let fail = 0, n = 0;
export const ok = (c, m) => { n++; if (!c) { fail++; console.log('FAIL:', m); } else console.log('ok:', m); return !!c; };
export const result = () => ({ fail, n });
let _browser = null;
export async function browser(){ if (!_browser) _browser = await chromium.launch({ headless: true, args: ['--ignore-certificate-errors', '--disable-gpu'] }); return _browser; }
export async function closeAll(){ try { if (_browser) await _browser.close(); } catch (e) {} _browser = null; }
// opts: w, h, nobrand, api: { name: json | (req, body) => ({status, body}) | json }, files: { 'app.html': string } (override), init: fn string run before the app
export async function boot(opts = {}){
  const b = await browser();
  const ctx = await b.newContext({ viewport: { width: opts.w || 1440, height: opts.h || 900 }, colorScheme: 'dark', serviceWorkers: 'block', ignoreHTTPSErrors: true });
  await ctx.addInitScript((o) => {
    try {
      localStorage.setItem('bc_tour_done', '1'); localStorage.setItem('cs_notif_asked', '1'); localStorage.setItem('cs-theme', 'dark');
      if (!o.nobrand) localStorage.setItem('cs_last_brand', 'b-acme');
    } catch (e) {}
    window.__AUDIT = true; if (o.nobrand) window.__AUDIT_NOBRAND = true;
    window.__calls = [];
  }, { nobrand: !!opts.nobrand });
  if (opts.init) await ctx.addInitScript(opts.init);
  const calls = [];
  await ctx.route('**/*', async (route) => {
    const req = route.request(), u = new URL(req.url());
    if (u.hostname !== 'app.test') return route.abort();
    if (u.pathname === '/supabase.min.js') return route.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE });
    if (u.pathname.startsWith('/api/')) {
      const name = u.pathname.slice(5); let body = null; try { body = JSON.parse(req.postData() || 'null'); } catch (e) {}
      calls.push({ name, body });
      let h = opts.api && Object.prototype.hasOwnProperty.call(opts.api, name) ? opts.api[name] : (name === 'usage' ? USAGE : null);
      if (typeof h === 'function') h = await h(req, body);
      if (h && h.__status) return route.fulfill({ status: h.__status, contentType: 'application/json', body: JSON.stringify(h.body || {}) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(h || {}) });
    }
    const p = u.pathname === '/' ? '/app.html' : u.pathname, rel = p.slice(1);
    if (opts.files && opts.files[rel] != null) return route.fulfill({ status: 200, contentType: MIME[rel.split('.').pop()] || 'text/plain', body: opts.files[rel] });
    const f = path.join(ROOT, rel);
    if (rel && !rel.includes('..') && fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ status: 200, contentType: MIME[p.split('.').pop()] || 'application/octet-stream', body: fs.readFileSync(f) });
    return route.fulfill({ status: 404, body: '' });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message || e)));
  await page.goto('https://app.test/app.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.switchView === 'function' && (document.querySelector('.view.active') || (document.getElementById('onboardingOverlay') && !document.getElementById('onboardingOverlay').classList.contains('hidden'))), null, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(opts.wait || 1800);
  return { ctx, page, calls, errors, close: () => ctx.close() };
}
export function guard(name, ms){
  let finished = false;
  setTimeout(() => { console.log('FAIL: wall clock (' + ms / 1000 + 's) exceeded'); process.exit(2); }, ms).unref();
  process.on('exit', (code) => { if (!finished && code === 0) { console.log('FAIL: the gate ended before all checks ran'); process.exitCode = 1; } });
  return { done(){ finished = true; } };
}
export const isoAgo = h => new Date(Date.now() - h * 3600e3).toISOString();
