#!/usr/bin/env node
// GATE fact-pack — v706 (.unlazy/quality/PLAN.md, Agent F). Proves, with the REAL api/fact-pack.js,
// api/_brandctx.js, api/_brain.js and app.html, and every edge stubbed (no web search, no page fetch,
// no DNS, no database, no model):
//   1. verification keeps true facts and drops: a number not on the page, an unreachable URL, http, a
//      private IP (literal, by DNS, and by redirect), a social URL, a shop/competitor page, a health claim
//      about the brand's product, a salesy fact; numbers normalize (1,000 = 1000, 50% = 50 percent);
//      terms + numbers must sit in one stretch of the page; reputable sources rank first; fetch limits;
//   2. storage replaces the pack only with >= 5 verified facts, ids F1..Fn;
//   3. the cron searches once per due brand, skips inactive / over-the-fuse / recently searched brands,
//      never twice in a week, refuses without CRON_SECRET, and survives the column being missing;
//   4. the manual refresh: owner only, once per 6 h per brand, one search under a concurrent double click;
//      remove keeps the other ids;
//   5. bc.facts: <= 12, <= 30 days, newest first, theme first, malformed dropped, column missing -> [];
//   6. the CHECKED FACTS block, the NO_INVENTION_RULE extension, factSources (dedupe, max 2, unknown ids);
//   7. the Settings UI escapes every value and links https sources only.
// RUN:    node scripts/verify/fact-pack.mjs
// EXPECT: prints "FACT PACK OK" and exits 0.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import vm from 'node:vm';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const Module = require_('module');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = path.join(ROOT, 'api');
const WALL = setTimeout(() => { console.log('FAIL: fact-pack wall clock (60s) — something hung'); process.exit(1); }, 60000);
let failed = 0, passed = 0;
const ok = (c, m) => { if (c) passed++; else { failed++; console.log('FAIL: ' + m); } };
const quiet = async (fn) => { const q = console.error, w = console.warn, l = console.log; console.error = console.warn = console.log = () => {}; try { return await fn(); } finally { console.error = q; console.warn = w; console.log = l; } };

process.env.CRON_SECRET = 'cron-test-secret';
process.env.SUPABASE_URL = 'https://stub.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
process.env.XAI_API_KEY = 'stub';

function stub(rel, exports) {
  const file = require_.resolve(path.join(API, rel));
  const m = new Module(file); m.filename = file; m.loaded = true; m.exports = exports; require_.cache[file] = m;
}

// ── the fake database ──
const DAY = 24 * 3600 * 1000;
const NOW = Date.now();
const db = { brands: [], ideas: {}, usage: {}, missingCol: false, heartbeats: [], patches: [] };
const qp = (p) => { const i = p.indexOf('?'); return i < 0 ? '' : p.slice(i + 1); };
const param = (p, k) => { for (const part of qp(p).split('&')) { const j = part.indexOf('='); if (decodeURIComponent(part.slice(0, j)) === k) return decodeURIComponent(part.slice(j + 1)); } return null; };
const clone = (x) => JSON.parse(JSON.stringify(x));
function rest(method, p, opts) {
  const o = opts || {};
  if (p.startsWith('/brands')) {
    const sel = param(p, 'select') || '';
    if (db.missingCol && (sel.indexOf('fact_pack') >= 0 || p.indexOf('fact_pack') >= 0)) {
      return Promise.resolve({ status: 400, data: { code: '42703', message: 'column brands.fact_pack does not exist' }, raw: '{"code":"42703","message":"column brands.fact_pack does not exist"}' });
    }
    const idEq = param(p, 'id');
    const rows = db.brands.filter(b => !idEq || idEq === 'eq.' + b.id);
    if (method === 'GET') return Promise.resolve({ status: 200, data: clone(rows) });
    if (method === 'PATCH') {
      db.patches.push({ path: p, body: clone(o.body) });
      const isNull = param(p, 'fact_pack') === 'is.null';
      const lsa = param(p, 'fact_pack->>lastSearchAt');
      const rv = param(p, 'fact_pack->>rev');
      if (db.beforePatch) { const f = db.beforePatch; db.beforePatch = null; f(); }
      const hit = rows.filter(b => {
        if (isNull && b.fact_pack != null) return false;
        if (lsa != null) {
          const cur = b.fact_pack && b.fact_pack.lastSearchAt;
          if (lsa === 'is.null') { if (cur != null) return false; }
          else if (String(cur) !== lsa.replace(/^eq\./, '')) return false;
        }
        if (rv != null) {
          const cur = b.fact_pack && b.fact_pack.rev;
          if (rv === 'is.null') { if (cur != null) return false; }
          else if (String(cur) !== rv.replace(/^eq\./, '')) return false;
        }
        return true;
      });
      for (const b of hit) Object.assign(b, clone(o.body));
      return Promise.resolve({ status: 200, data: hit.map(b => ({ id: b.id })) });
    }
  }
  if (p.startsWith('/ideas')) { const id = (param(p, 'brand_id') || '').replace(/^eq\./, ''); return Promise.resolve({ status: 200, data: clone(db.ideas[id] || []) }); }
  if (p.startsWith('/usage_events')) { const id = (param(p, 'brand_id') || '').replace(/^eq\./, ''); return Promise.resolve({ status: 200, data: clone(db.usage[id] || []) }); }
  return Promise.resolve({ status: 200, data: [] });   // edit_signals, brand_memory, ...
}
let accessMap = {};
stub('_publish/store.js', {
  rest, setRequestBudget() {},
  heartbeat: async (job, status, detail) => { db.heartbeats.push({ job, status, detail }); },
  userCanAccessBrand: async (u, b) => !!(accessMap[b] && accessMap[b].includes(u)),
});
let searches = [];
let searchAnswer = () => null;
stub('_llm.js', {
  callGrokSearch: async (prompt, opts) => { searches.push({ prompt, opts }); return searchAnswer(prompt); },
  callLLM: async () => { throw new Error('no model calls in this gate'); },
  aiUnavailable: () => ({}), claudeConfigured: () => false,
});
const plans = {};
stub('_usage.js', { COST_CAP_EUR: 25, getStatus: async (u) => plans[u] || { plan: 'pro', cost: 0 } });
let currentUser = null;
stub('_requireUser.js', async () => currentUser);

const FP = require_(path.join(API, 'fact-pack.js'));
const BC = require_(path.join(API, '_brandctx.js'));
const B = require_(path.join(API, '_brain.js'));

// ── the fake web ──
const PAGES = {}, DNS = {}, fetched = [];
let fetchOpts = [];
FP._deps.lookup = async (host) => [{ address: net.isIP(host) ? host : (DNS[host] || '93.184.216.34'), family: 4 }];
FP._deps.httpGet = async (url, o) => {
  fetched.push(url); fetchOpts.push(o);
  const p = PAGES[url];
  if (!p) throw new Error('ECONNREFUSED');
  return { status: p.status || 200, headers: Object.assign({ 'content-type': 'text/html; charset=utf-8' }, p.headers || {}), body: p.body || '' };
};
const html = (t) => '<html><head><style>p{}</style><script>var x = "3000 milligrams";</script></head><body><p>' + t + '</p></body></html>';

// ═════ 1. verification ═════
const BRAND = { id: 'b-verify', user_id: 'u-owner', brand_name: 'Acme Salts', website: 'https://acmesalts.com', competitors_text: 'SaltCo\nHydra Max',
  communities: ['endurance running', 'hydration'], target_audience: 'runners', voice_extra: {} };
PAGES['https://www.cdc.gov/heat/sweat.html'] = { body: html('During exercise in hot weather, adults can lose 1,000 milligrams of sodium per hour through sweat, the agency says.') };
PAGES['https://www.nih.gov/water'] = { body: html('About 60 percent of the adult human body is water, according to the institute.') };
PAGES['https://www.reuters.com/science/marathons'] = { body: html('More than 1.1 million runners finished a marathon worldwide in 2019, a study of race results found.') };
PAGES['https://www.cdc.gov/heat/far.html'] = { body: html('Sodium is a mineral. ' + 'Filler words about many unrelated things here. '.repeat(120) + 'Hot weather exercise sweat loss per hour for adults is discussed elsewhere.') };
PAGES['https://redirector.org/to-private'] = { status: 302, headers: { location: 'https://127.0.0.1/admin' } };
PAGES['https://redirector.org/to-http'] = { status: 301, headers: { location: 'http://www.cdc.gov/heat/sweat.html' } };
PAGES['https://redirector.org/to-good'] = { status: 302, headers: { location: 'https://www.nih.gov/water' } };
for (let i = 0; i < 5; i++) PAGES['https://loop.org/' + i] = { status: 302, headers: { location: 'https://loop.org/' + (i + 1) } };
PAGES['https://www.acme-blog.org/salts'] = { body: html('Acme Salts electrolyte sticks improve hydration during long runs, the makers say.') };
PAGES['https://www.cdc.gov/heat/sale.html'] = { body: html('Electrolyte mixes are 20% off this week, use code SALT10 at checkout.') };
PAGES['https://www.saltco.com/blog/sodium'] = { body: html('Adults can lose 1,000 milligrams of sodium per hour through sweat.') };
PAGES['https://www.cdc.gov/heat/pdf'] = { headers: { 'content-type': 'application/pdf' }, body: '%PDF' };
DNS['intranet.corp-facts.com'] = '10.0.0.5';
const C = (text, url, extra) => Object.assign({ text, url, title: 'T', topic: 'hydration' }, extra || {});
const TRUE1 = 'Adults can lose 1000 milligrams of sodium per hour through sweat during exercise in hot weather.';
const TRUE2 = 'About 60% of the adult human body is water.';
const TRUE3 = 'More than 1.1 million runners finished a marathon worldwide in 2019.';
const cands = [
  C(TRUE3, 'https://www.reuters.com/science/marathons'),
  C(TRUE1, 'https://www.cdc.gov/heat/sweat.html'),
  C(TRUE2, 'https://www.nih.gov/water'),
  C('About 60% of the adult human body is water, the institute notes.', 'https://redirector.org/to-good'),
  C('Adults can lose 3000 milligrams of sodium per hour through sweat during exercise in hot weather.', 'https://www.cdc.gov/heat/sweat.html'),   // number not on page
  C('Adults can lose sodium per hour through sweat during exercise in hot weather.', 'https://www.cdc.gov/heat/far.html'),                   // terms scattered
  C('Adults can lose 1000 milligrams of sodium per hour through sweat in hot weather.', 'https://dead-host-facts.org/x'),                   // unreachable
  C('Adults can lose 1000 milligrams of sodium per hour through sweat in the heat.', 'http://www.cdc.gov/heat/sweat.html'),                // http
  C('Adults can lose 1000 milligrams of sodium per hour through sweat in heat waves.', 'https://192.168.1.10/facts'),                     // private literal
  C('Adults can lose 1000 milligrams of sodium per hour through sweat in summer.', 'https://intranet.corp-facts.com/a'),                  // private by DNS
  C('Adults can lose 1000 milligrams of sodium hourly through sweat in hot weather.', 'https://redirector.org/to-private'),               // redirect to private
  C('Adults lose 1000 milligrams of sodium per hour through sweat in very hot weather.', 'https://redirector.org/to-http'),               // redirect to http
  C('Adults can lose 1000 milligrams of sodium per hour through sweat, says a loop.', 'https://loop.org/0'),                              // redirect loop
  C('Runners lose 1000 milligrams of sodium per hour through sweat in hot weather.', 'https://www.reddit.com/r/running/comments/1'),     // social
  C('Adults can lose 1000 milligrams of sodium per hour, per the shop page.', 'https://www.amazon.com/dp/B000'),                          // shop
  C('Adults can lose 1000 milligrams of sodium per hour through sweat on hot days.', 'https://www.saltco.com/blog/sodium'),              // competitor
  C('Acme Salts electrolyte sticks improve hydration during long runs.', 'https://www.acme-blog.org/salts'),                             // product health claim
  C('Electrolyte mixes are 20% off this week, use code SALT10 at checkout.', 'https://www.cdc.gov/heat/sale.html'),                       // salesy
  C('Adults can lose 1000 milligrams of sodium per hour through sweat at noon.', 'https://www.cdc.gov/heat/pdf'),                        // not a text page
];
const v = await quiet(() => FP.verifyCandidates(cands, BRAND, { deadlineAt: Date.now() + 20000 }));
const keptTexts = v.kept.map(k => k.text);
ok(keptTexts.includes(TRUE1), 'true fact kept with "1,000" on the page and "1000" in the fact (dropped: ' + JSON.stringify(v.dropped) + ')');
ok(keptTexts.includes(TRUE2), 'true fact kept with "60 percent" on the page and "60%" in the fact');
ok(keptTexts.includes(TRUE3), 'true fact kept from a reputable newsroom (1.1 million, 2019)');
ok(keptTexts.some(t => /the institute notes/.test(t)), 'a fact behind one safe redirect is kept');
ok(v.kept.length === 4, 'exactly the 4 true facts survive, got ' + v.kept.length + ': ' + JSON.stringify(keptTexts));
const d = v.dropped;
ok(d.number_not_on_page === 1, 'the fact whose number is not on the page is dropped (number_not_on_page)');
ok(d.terms_not_on_page === 1, 'terms scattered across the page (not in one stretch) are dropped');
ok(d.unreachable === 1, 'an unreachable URL is dropped');
ok(d.not_https === 2, 'an http URL and a redirect to http are dropped (not_https x2), got ' + d.not_https);
ok(d.private_ip === 3, 'private IPs are dropped: literal, by DNS and by redirect (private_ip x3), got ' + d.private_ip);
ok(d.too_many_redirects === 1, 'more than 3 redirects is dropped');
ok(d.social === 1 && d.shop === 1 && d.competitor === 1, 'social, shop and competitor sources are dropped');
ok(d.product_claim === 1, 'a health/benefit claim about the brand\'s own product is dropped');
ok(d.salesy === 1, 'a salesy fact is dropped');
ok(d.not_text === 1, 'a non-text page (PDF) is dropped');
ok(!fetched.some(u => /^http:|192\.168|127\.0\.0\.1|intranet\.corp-facts|reddit|amazon|saltco|acme-blog|sale\.html/.test(u)), 'nothing unsafe or pre-filtered was ever fetched: ' + fetched.filter(u => /^http:|192\.168|127\.0\.0|intranet|reddit|amazon|saltco|acme-blog|sale\.html/.test(u)).join(', '));
ok(fetched.filter(u => u === 'https://www.cdc.gov/heat/sweat.html').length === 1, 'one fetch per distinct URL (two facts on one page share it)');
ok(fetchOpts.every(o => o.timeoutMs <= 6000 && o.maxBytes === 1536 * 1024), 'every fetch carries a <= 6 s timeout and the 1.5 MB cap');
ok(FP.C.MAX_REDIRECTS === 3 && FP.C.FETCH_TIMEOUT_MS === 6000, 'limits: 3 redirects, 6 s');
const sc = v.kept.map(k => FP.sourceScore(new URL(k.url).hostname));
ok(sc.every((x, i) => i === 0 || sc[i - 1] >= x), 'reputable sources first (gov/edu before newsrooms): ' + sc.join());
ok(v.kept.some(k => k.url === 'https://www.nih.gov/water' && /the institute notes/.test(k.text)), 'a redirected fact is cited by the page it really came from');
ok(FP.sourceScore('www.cdc.gov') === 3 && FP.sourceScore('www.ox.ac.uk') === 3 && FP.sourceScore('www.reuters.com') === 2 && FP.sourceScore('someblog.net') === 1, 'source scores: gov/academic 3, journals/newsrooms 2, other 1');
ok(/cdc\.gov|nih\.gov/.test(v.kept[0].url) && /reuters/.test(v.kept[v.kept.length - 1].url), 'the newsroom fact ranks after the government ones even though it came first');
// units
ok(FP.canonNum('1,000') === '1000' && FP.canonNum('1.000.000') === '1000000' && FP.canonNum('2,5') === '2.5' && FP.canonNum('50%') === '50%' && FP.canonNum('07') === '7', 'number normalization');
ok(FP.normText('50 percent and 3 per cent') === '50% and 3%', '"percent" / "per cent" normalize to %');
ok(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1'].every(FP.ipIsPrivate), 'private / loopback / link-local / metadata addresses are private');
ok(!FP.ipIsPrivate('93.184.216.34') && !FP.ipIsPrivate('2606:4700::1'), 'public addresses are not private');
const V6_PRIVATE = ['0:0:0:0:0:ffff:7f00:1', '0:0:0:0:0:ffff:a00:1', '::ffff:7f00:1', '::ffff:10.0.0.1', '0:0:0:0:0:0:0:1', '::127.0.0.1',
  '2002:7f00:0001::1', '2002:c0a8:0101::1', '2002:0a00:0001:0:0:0:0:1', 'fec0::1', 'feff::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001::1',
  'fc00::1', 'fdff::1', 'febf::1', '64:ff9b::7f00:1', '2001:db8::1', 'ff02::1', '[::1]'];
ok(V6_PRIVATE.every(FP.ipIsPrivate), 'IPv6 judged after full normalization: uncompressed mapped, 6to4 with a private IPv4 inside, site-local, Teredo, ULA, NAT64 are refused: ' + V6_PRIVATE.filter(x => !FP.ipIsPrivate(x)).join(', '));
ok(!FP.ipIsPrivate('2002:0808:0808::1') && !FP.ipIsPrivate('::ffff:8.8.8.8') && !FP.ipIsPrivate('2a00:1450:4001:80b::200e'), '6to4 / mapped with a PUBLIC IPv4 inside, and ordinary global IPv6, pass');
ok(String(FP.ipv6Groups('0:0:0:0:0:ffff:7f00:1')) === String(FP.ipv6Groups('::ffff:127.0.0.1')), 'two spellings of one IPv6 address normalize to the same groups');
// v706 r2 — linear HTML stripping: hostile / broken pages cannot stall the cron.
// Each case runs in a child process with a hard 5 s kill, so a quadratic regression FAILS here instead of
// hanging the gate (a synchronous regex would block this process's own wall clock).
{
  const { spawnSync } = await import('node:child_process');
  const CASES = { 'script': "'<script '.repeat(196608)", 'comment': "'<!--'.repeat(393216)", 'lt': "'<'.repeat(1572864)",
    'style': "'<style '.repeat(224694)", 'entity': "('&' + 'a'.repeat(47)).repeat(32768)", 'stray-lt': "'a <b '.repeat(314572)" };
  for (const [label, expr] of Object.entries(CASES)) {
    const code = 'const F = require(' + JSON.stringify(path.join(API, 'fact-pack.js')) + '); const p = ' + expr +
      '; const t0 = process.hrtime.bigint(); F.htmlToText(p, "text/html"); console.log(Number((process.hrtime.bigint() - t0) / 1000000n));';
    const rr = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 5000 });
    const ms = Number(String(rr.stdout || '').trim());
    ok(rr.status === 0 && isFinite(ms) && ms < 300, '1.5 MB of unclosed "' + label + '" is stripped in under 300 ms (took ' + (rr.status === 0 ? ms + ' ms' : 'too long — killed after 5 s') + ')');
  }
}
ok(FP.htmlToText('<p>A <B>b</B><SCRIPT type="x">var n = 99;</SCRIPT> c <!-- 77 --> d<style>.x{}</style> e &amp; f 50 per cent</p>', 'text/html') === 'a b c d e & f 50%', 'stripping still drops scripts, styles and comments (any case) and keeps the text');
ok(FP.htmlToText('x'.repeat(3 * 1024 * 1024), 'text/plain').length <= 1536 * 1024, 'text is capped before processing');
ok(FP.checkUrl('https://localhost/x').reason === 'private_host' && FP.checkUrl('https://printer/x').reason === 'private_host' && FP.checkUrl('https://a.com:8443/x').reason === 'bad_port', 'localhost, single-label hosts and odd ports are refused');
ok(FP.aboutBrandReason('Our sticks boost energy for runners.', BRAND) === 'product_claim' && FP.aboutBrandReason('Acme Salts was founded in 2019 in Tallinn.', BRAND) === 'about_brand', '"our ..." health claims and facts about the brand are refused');
ok(FP.aboutBrandReason('Sodium is lost in sweat during exercise.', BRAND) === '', 'a general fact is not about the brand');

// ═════ 2. storage ═════
db.brands = [{ id: 'b-store', user_id: 'u1', fact_pack: { lastSearchAt: 111, updatedAt: 100, facts: [{ id: 'F1', text: 'Old fact that stays in place.', url: 'https://x.gov/a', title: 'X', fetchedAt: 100 }] } }];
const four = [1, 2, 3, 4].map(i => ({ text: 'Fact number ' + i + ' about water.', url: 'https://x.gov/' + i, title: 'X', topic: 't' }));
db.patches = [];
const s4 = await FP.savePack('b-store', four, 111, NOW);
ok(!s4.saved && db.patches.length === 0 && db.brands[0].fact_pack.facts.length === 1, 'storage: 4 verified facts never replace the old pack (no write at all)');
const five = four.concat([{ text: 'Fact number 5 about water.', url: 'https://x.gov/5', title: 'X', topic: 't' }]);
const s5 = await FP.savePack('b-store', five, 111, NOW);
const fp5 = db.brands[0].fact_pack;
ok(s5.saved && fp5.facts.length === 5 && fp5.facts.map(f => f.id).join() === 'F1,F2,F3,F4,F5' && fp5.updatedAt === NOW && fp5.lastSearchAt === 111 && fp5.facts.every(f => f.fetchedAt === NOW && f.url && f.title), 'storage: 5 verified facts replace the pack, ids F1..F5, stamped');
const sOld = await FP.savePack('b-store', five, 999, NOW + 1);
ok(!sOld.saved && sOld.reason === 'superseded', 'storage: a save for a search that is no longer the latest claim writes nothing');

// ═════ 3. the cron ═════
const recent = (days) => new Date(NOW - days * DAY).toISOString();
const candJson = (tag) => JSON.stringify([
  { text: TRUE1, url: 'https://www.cdc.gov/heat/sweat.html', title: 'CDC heat', topic: tag },
  { text: TRUE2, url: 'https://www.nih.gov/water', title: 'NIH water', topic: tag },
  { text: TRUE3, url: 'https://www.reuters.com/science/marathons', title: 'Reuters', topic: tag },
  { text: 'About 60% of the adult human body is water, the institute notes.', url: 'https://redirector.org/to-good', title: 'NIH', topic: tag },
  { text: 'Adults lose 1000 milligrams of sodium per hour through sweat in hot weather, the agency says.', url: 'https://www.cdc.gov/heat/sweat.html', title: 'CDC', topic: tag },
  { text: 'Adults can lose 3000 milligrams of sodium per hour through sweat during exercise in hot weather.', url: 'https://www.cdc.gov/heat/sweat.html', title: 'CDC', topic: tag },
]);
const mk = (id, extra) => Object.assign({ id, user_id: 'own-' + id, brand_name: 'Brand ' + id, website: '', competitors_text: '', communities: ['topic-' + id], target_audience: 'runners', voice_extra: {}, fact_pack: null }, extra || {});
function resetCron() {
  db.brands = [
    mk('c1'),                                                                         // active, never searched -> search
    mk('c2', { fact_pack: { lastSearchAt: NOW - 2 * DAY, updatedAt: NOW - 2 * DAY, facts: [] } }),   // searched 2 days ago -> not due
    mk('c3'),                                                                         // inactive 20 days -> skip
    mk('c4', { fact_pack: { lastSearchAt: NOW - 8 * DAY, updatedAt: NOW - 8 * DAY, facts: [] } }),   // 8 days -> search
    mk('c5'),                                                                         // only the daily cron's rows -> inactive
    mk('c6'),                                                                         // trial owner over the cost fuse -> skip
    mk('c7', { communities: [] , target_audience: '' }),                              // no topics -> skip
  ];
  db.ideas = { c1: [{ created_at: recent(1), status: 'filming' }], c2: [{ created_at: recent(1), status: 'done' }], c3: [{ created_at: recent(20), status: 'done' }],
    c4: [], c5: [{ created_at: recent(1), status: 'pending', gen_flow: 'daily' }, { created_at: recent(30), status: 'done' }], c6: [{ created_at: recent(2), status: 'done' }],
    c7: [{ created_at: recent(1), status: 'done' }] };
  db.usage = { c4: [{ created_at: recent(3), action: 'write' }], c5: [{ created_at: recent(1), action: 'ideas' }] };
  plans['own-c6'] = { plan: 'trial', cost: 24.99 };
  db.heartbeats = []; searches = [];
}
resetCron();
searchAnswer = (p) => { const m = p.match(/topic-(c\d)/); return m ? candJson(m[1]) : null; };
const fakeRes = () => ({ statusCode: 0, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } });
async function call(req) { const res = fakeRes(); await quiet(() => FP(Object.assign({ headers: {} }, req), res)); return res; }
const searchedFor = (id) => searches.filter(s => s.prompt.indexOf('topic-' + id) >= 0).length;

let r = await call({ method: 'GET', headers: {} });
ok(r.statusCode === 401 && searches.length === 0, 'cron without CRON_SECRET: 401 and no search');
r = await call({ method: 'GET', headers: { authorization: 'Bearer ' + process.env.CRON_SECRET } });
ok(r.statusCode === 200, 'cron answers 200, got ' + r.statusCode + ' ' + JSON.stringify(r.body));
ok(searchedFor('c1') === 1 && searchedFor('c4') === 1, 'cron: exactly one search for each due, active brand (c1, c4)');
ok(searches.length === 2, 'cron: no other search at all, got ' + searches.length);
ok(searchedFor('c3') === 0 && searchedFor('c5') === 0, 'cron: inactive brands (20 days; only the daily cron\'s own rows) are skipped');
ok(searchedFor('c2') === 0, 'cron: a brand searched 2 days ago is not due');
ok(searchedFor('c6') === 0, 'cron: a trial owner over the cost fuse is skipped');
ok(r.body && r.body.skipInactive === 2 && r.body.skipCostCap === 1 && r.body.skipNoTopics === 1 && r.body.updated === 2, 'cron counts: ' + JSON.stringify(r.body));
const c1 = db.brands.find(b => b.id === 'c1').fact_pack;
ok(c1 && c1.facts.length === 5 && c1.facts[0].id === 'F1' && c1.lastSearchAt > 0, 'cron stored the verified pack for c1 (5 facts)');
ok(db.heartbeats.some(h => h.job === 'fact-pack-cron' && h.status === 'ok'), 'cron writes its heartbeat');
r = await call({ method: 'GET', headers: { authorization: 'Bearer ' + process.env.CRON_SECRET } });
ok(searches.length === 2, 'cron run again the same day: no second search for anyone (at most one per brand per week)');
const sixDays = FP.C.WEEK_MS - FP.C.CRON_SLACK_MS;
ok(sixDays > 6.9 * DAY && sixDays <= 7 * DAY, 'a brand is due again only after ~7 days');
// a brand whose search keeps < 5 facts keeps its old pack, and is not searched again for a week
resetCron();
db.brands = [mk('c8', { fact_pack: { lastSearchAt: NOW - 9 * DAY, updatedAt: NOW - 9 * DAY, facts: [{ id: 'F1', text: 'Kept fact from before.', url: 'https://x.gov/k', title: 'X', fetchedAt: NOW - 9 * DAY }] } })];
db.ideas = { c8: [{ created_at: recent(1), status: 'done' }] };
searchAnswer = () => JSON.stringify([{ text: TRUE2, url: 'https://www.nih.gov/water', title: 'NIH', topic: 't' }]);
r = await call({ method: 'GET', headers: { authorization: 'Bearer ' + process.env.CRON_SECRET } });
const c8 = db.brands[0].fact_pack;
ok(searches.length === 1 && c8.facts.length === 1 && c8.facts[0].text === 'Kept fact from before.' && c8.lastSearchAt > NOW - DAY, 'cron: 1 verified fact keeps the old pack but records the search');
r = await call({ method: 'GET', headers: { authorization: 'Bearer ' + process.env.CRON_SECRET } });
ok(searches.length === 1, 'cron: that brand is not searched again the next run');
// column missing
resetCron(); db.missingCol = true;
r = await call({ method: 'GET', headers: { authorization: 'Bearer ' + process.env.CRON_SECRET } });
ok(r.statusCode === 200 && r.body && r.body.notSetUp === true && searches.length === 0, 'cron before sql/fact-pack.sql: no crash, no search, says not set up');
db.missingCol = false;

// ═════ 4. manual refresh + remove ═════
searchAnswer = () => candJson('m');
const mkM = (pack) => { db.brands = [mk('m1', { user_id: 'owner', fact_pack: pack })]; accessMap = { m1: ['owner', 'member'] }; searches = []; };
const post = (body) => call({ method: 'POST', headers: { authorization: 'Bearer t' }, body });
currentUser = null; mkM(null);
r = await post({ brandId: 'm1', action: 'refresh' });
ok(r.statusCode === 401 && searches.length === 0, 'refresh without a session: 401');
currentUser = { id: 'member' };
r = await post({ brandId: 'm1', action: 'refresh' });
ok(r.statusCode === 403 && r.body.code === 'owner_only' && searches.length === 0, 'refresh by a member (not the owner): 403 owner_only, no search');
currentUser = { id: 'stranger' };
r = await post({ brandId: 'm1', action: 'refresh' });
ok(r.statusCode === 403 && searches.length === 0, 'refresh by a stranger: 403');
currentUser = { id: 'owner' }; mkM({ lastSearchAt: NOW - 1 * 3600 * 1000, updatedAt: NOW - 3600 * 1000, facts: [] });
r = await post({ brandId: 'm1', action: 'refresh' });
ok(r.statusCode === 429 && r.body.code === 'rate_limited' && r.body.retryAfter > 4 * 3600 && /6 hours/.test(r.body.error) && searches.length === 0, 'refresh 1 h after the last one: 429 with the wait, no search');
mkM({ lastSearchAt: NOW - 7 * 3600 * 1000, updatedAt: NOW - 7 * DAY, facts: [] });
r = await post({ brandId: 'm1', action: 'refresh' });
ok(r.statusCode === 200 && r.body.updated === true && searches.length === 1 && r.body.factPack.facts.length === 5, 'refresh 7 h after the last one: one search, pack saved and returned');
r = await post({ brandId: 'm1', action: 'refresh' });
ok(r.statusCode === 429 && searches.length === 1, 'refresh again right away: 429, no second search');
mkM(null);
const [ra, rb] = await Promise.all([post({ brandId: 'm1', action: 'refresh' }), post({ brandId: 'm1', action: 'refresh' })]);
ok(searches.length === 1 && [ra.statusCode, rb.statusCode].sort().join() === '200,429', 'two clicks at once: one search, the other refused (' + ra.statusCode + ',' + rb.statusCode + ')');
mkM({ lastSearchAt: NOW - 7 * 3600 * 1000, facts: [] }); plans.owner = { plan: 'free', cost: 30 };
r = await post({ brandId: 'm1', action: 'refresh' });
ok(r.statusCode === 402 && r.body.code === 'cost_cap' && searches.length === 0, 'refresh for a free owner over the cost fuse: refused, no search');
delete plans.owner;
// remove
const packM = { lastSearchAt: NOW - DAY, updatedAt: NOW - DAY, facts: [1, 2, 3].map(i => ({ id: 'F' + i, text: 'Fact ' + i + ' about water here.', url: 'https://x.gov/' + i, title: 'X', fetchedAt: NOW - DAY })) };
mkM(clone(packM)); currentUser = { id: 'member' };
r = await post({ brandId: 'm1', action: 'remove', id: 'F2' });
ok(r.statusCode === 200 && db.brands[0].fact_pack.facts.map(f => f.id).join() === 'F1,F3' && r.body.factPack.facts.length === 2, 'remove F2 (a member may): saved, the other ids stay F1,F3');
// conditional remove (v706 r2): stale client version -> 409 + the latest pack; a refresh landing between
// the read and the write -> 409, nothing overwritten; the matching version -> removed.
mkM(Object.assign(clone(packM), { rev: 'r1' })); currentUser = { id: 'owner' };
r = await post({ brandId: 'm1', action: 'remove', id: 'F1', rev: 'r0' });
ok(r.statusCode === 409 && r.body.code === 'changed' && r.body.factPack && r.body.factPack.rev === 'r1' && db.brands[0].fact_pack.facts.length === 3, 'remove with a stale version: 409 with the current pack, nothing written');
const fresher = { rev: 'r9', lastSearchAt: NOW, updatedAt: NOW, facts: [1, 2, 3, 4, 5].map(i => ({ id: 'F' + i, text: 'New fact ' + i + ' from a refresh.', url: 'https://x.gov/n' + i, title: 'X', fetchedAt: NOW })) };
db.beforePatch = () => { db.brands[0].fact_pack = clone(fresher); };
r = await post({ brandId: 'm1', action: 'remove', id: 'F1', rev: 'r1' });
ok(r.statusCode === 409 && db.brands[0].fact_pack.rev === 'r9' && db.brands[0].fact_pack.facts.length === 5, 'a refresh saved between the read and the remove: 409, the new pack is NOT overwritten');
r = await post({ brandId: 'm1', action: 'remove', id: 'F2', rev: 'r9' });
ok(r.statusCode === 200 && db.brands[0].fact_pack.facts.map(f => f.id).join() === 'F1,F3,F4,F5' && db.brands[0].fact_pack.rev !== 'r9' && r.body.factPack.rev === db.brands[0].fact_pack.rev, 'remove with the current version: removed, and the version moves on');
currentUser = { id: 'stranger' }; mkM(clone(packM));
r = await post({ brandId: 'm1', action: 'remove', id: 'F1' });
ok(r.statusCode === 403 && db.brands[0].fact_pack.facts.length === 3, 'remove by a stranger: 403, nothing changed');
currentUser = { id: 'owner' }; db.missingCol = true;
r = await post({ brandId: 'm1', action: 'refresh' });
ok(r.statusCode === 503 && r.body.code === 'not_set_up' && searches.length === 0, 'refresh before sql/fact-pack.sql: 503 not_set_up, no crash');
db.missingCol = false;

// ═════ 5. bc.facts ═════
const fact = (i, ageDays, extra) => Object.assign({ id: 'F' + i, text: 'Checked fact number ' + i + ' about sodium.', url: 'https://x.gov/' + i, title: 'Src ' + i, topic: 'general', fetchedAt: NOW - ageDays * DAY }, extra || {});
const many = [];
for (let i = 1; i <= 16; i++) many.push(fact(i, i));          // F1 newest ... F16 16 days old
many.push(fact(17, 31)); many.push(fact(18, 45));              // too old
many.push({ id: 'F19', text: 'Bad url fact here ok.', url: 'javascript:alert(1)', fetchedAt: NOW });
many.push({ id: '<b>', text: 'Bad id fact here okay.', url: 'https://x.gov/b', fetchedAt: NOW });
db.brands = [{ id: 'bb', user_id: 'owner', brand_name: 'Acme', communities: [], fact_pack: { updatedAt: NOW, lastSearchAt: NOW, facts: many } }];
accessMap = { bb: ['owner'] };
const h = await quiet(() => BC.loadBrandContext('bb', { userId: 'owner' }, ''));
const f = h.ok ? h.bc.facts : null;
ok(Array.isArray(f) && f.length === 12, 'bc.facts holds at most 12, got ' + (f && f.length));
ok(f && f.every(x => Object.keys(x).sort().join() === 'id,text,title,url'), 'bc.facts entries are exactly {id,text,url,title}');
ok(f && f.map(x => x.id).join() === 'F1,F2,F3,F4,F5,F6,F7,F8,F9,F10,F11,F12', 'bc.facts is newest first and drops the > 30-day and malformed ones');
ok(h.ok && !Object.prototype.hasOwnProperty.call({}, 'x') && BC.populatedFieldCount({ facts: [1] }) === 0, 'facts never count as a brand field');
const small = BC.factsFromPack({ facts: [fact(1, 2), fact(2, 31), fact(3, 29)] }, NOW, '');
ok(small.map(x => x.id).join() === 'F1,F3', 'a fact fetched more than 30 days ago is left out even when there is room: ' + small.map(x => x.id).join());
const themed = BC.factsFromPack({ facts: [fact(1, 1), fact(2, 5, { text: 'Marathon runners sweat a lot in races.' })] }, NOW, 'marathon training');
ok(themed[0].id === 'F2', 'a fact sharing a word with today\'s theme ranks first');
db.missingCol = true;
const h2 = await quiet(() => BC.loadBrandContext('bb', { userId: 'owner' }, ''));
ok(h2.ok === true && Array.isArray(h2.bc.facts) && h2.bc.facts.length === 0, 'column missing: the brand context still loads, bc.facts = []');
db.missingCol = false;
ok(BC.factsFromPack(null, NOW).length === 0 && BC.factsFromPack('x', NOW).length === 0 && BC.factsFromPack({ facts: 'x' }, NOW).length === 0, 'no pack / junk pack -> []');

// ═════ 6. _brain ═════
const ORIG = 'NEVER INVENT FACTS: no made-up numbers, prices, names, customer cases, results or quotes. Use only facts the BRAND PROFILE or the material you were given actually contains. Where a line needs proof you do not have, write a slot exactly like [your story: <what to tell>] for the creator to fill in. Where there is no room for a slot (a one-line meme, a hook), cut the claim instead.';
ok(B.NO_INVENTION_RULE.startsWith(ORIG), 'NO_INVENTION_RULE keeps its existing text word for word');
ok(B.NO_INVENTION_RULE.endsWith(' The one exception: a CHECKED FACT from the list you were given (use it as written, no extra numbers).'), 'NO_INVENTION_RULE gains the CHECKED FACT clause');
const bcF = { facts: [
  { id: 'F1', text: 'Adults can lose 1000 mg of sodium per hour in sweat.', url: 'https://www.cdc.gov/a', title: 'CDC heat' },
  { id: 'F2', text: 'About 60% of the adult human body is water.', url: 'https://www.cdc.gov/a', title: 'CDC heat' },
  { id: 'F3', text: 'More than 1.1 million runners finished a marathon in 2019.', url: 'https://www.reuters.com/b', title: 'Reuters' },
  { id: 'F4', text: 'A fourth checked fact about water and salt.', url: 'https://www.nih.gov/c', title: 'NIH' },
] };
const blk = B.factsBlock(bcF);
ok(blk.split('\n')[0] === 'CHECKED FACTS (you may use these; cite by id)' && B.FACTS_HEADING === 'CHECKED FACTS (you may use these; cite by id)', 'the block opens with the CHECKED FACTS heading');
ok(blk.indexOf('[F1] Adults can lose 1000 mg of sodium per hour in sweat. (source: CDC heat)') >= 0 && blk.indexOf('[F4] ') >= 0, 'one line per fact: [id] text (source: title)');
ok(/use it as written \(no extra numbers/.test(blk) && /cite the id/.test(blk), 'the block repeats: as written, no extra numbers, cite the id');
ok(B.factsBlock({}) === '' && B.factsBlock({ facts: [] }) === '' && B.factsBlock({ facts: [{ id: 'F1', text: 'x', url: 'javascript:1' }] }) === '', 'no facts -> no block (no dangling heading)');
const fs1 = B.factSources(bcF, ['F1', 'F2', 'F3', 'F4']);
ok(fs1.length === 2 && fs1[0].url === 'https://www.cdc.gov/a' && fs1[1].url === 'https://www.reuters.com/b' && fs1[0].title === 'CDC heat', 'factSources: deduped by url, max 2, in cited order');
ok(B.factSources(bcF, ['F9', 'X1', null, 'F3']).map(s => s.url).join() === 'https://www.reuters.com/b', 'factSources: unknown ids are ignored');
ok(B.factSources(bcF, 'F1').length === 0 && B.factSources({}, ['F1']).length === 0, 'factSources: junk input -> []');

// ═════ 6b. the SQL: fact_pack is server-only ═════
const { stripSqlComments } = await import(path.join(ROOT, 'scripts', 'verify', '_sqlscan.mjs'));
const SQL = stripSqlComments(fs.readFileSync(path.join(ROOT, 'sql', 'fact-pack.sql'), 'utf8'));
const sqlN = SQL.replace(/\s+/g, ' ').toLowerCase();
ok(/alter table public\.brands add column if not exists fact_pack jsonb/.test(sqlN), 'SQL: the column is added idempotently');
ok(/create or replace function public\.brands_pin_fact_pack\(\) returns trigger/.test(sqlN), 'SQL: the pin function exists (create or replace)');
ok(/drop trigger if exists brands_pin_fact_pack_trg on public\.brands; create trigger brands_pin_fact_pack_trg before insert or update on public\.brands for each row execute function public\.brands_pin_fact_pack\(\)/.test(sqlN), 'SQL: BEFORE INSERT OR UPDATE trigger on brands, drop-then-create');
ok(/current_user in \('anon', 'authenticated'\)/.test(sqlN) && /request\.jwt\.claim/.test(sqlN), 'SQL: a client is recognised by its role (anon / authenticated)');
ok(/if not \(current_user in[^;]*\) then return new;/.test(sqlN), 'SQL: the service role / SQL editor are not pinned');
ok(/if tg_op = 'insert' then new\.fact_pack := null;/.test(sqlN), 'SQL: a client INSERT cannot seed a pack');
ok(/elsif new\.fact_pack is distinct from old\.fact_pack then new\.fact_pack := old\.fact_pack;/.test(sqlN), 'SQL: a client UPDATE keeps the old pack, silently (normal brand saves keep working)');
ok(!/raise exception/.test(sqlN), 'SQL: it never raises (a save that carries the row back must not fail)');
ok(/revoke all on function public\.brands_pin_fact_pack\(\) from public/.test(sqlN), 'SQL: the trigger function is off the PUBLIC execute grant');
const V658 = fs.readFileSync(path.join(ROOT, 'sql', 'v658-revoke-security-health.sql'), 'utf8');
ok((V658.match(/'brands_pin_fact_pack'/g) || []).length >= 3, 'SQL: v658 names brands_pin_fact_pack in its lockdown, verify and trigger lists');
const FPSRC = fs.readFileSync(path.join(API, 'fact-pack.js'), 'utf8');
ok(!/token\s*:/.test(FPSRC.replace(/\/\/.*$/gm, '')), 'every fact_pack write goes through store.rest with the service key (no user token is ever passed)');

// ═════ 7. the UI ═════
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
function grab(name) {
  let i = APP.indexOf('function ' + name + '(');
  if (i < 0) return '';
  if (APP.slice(i - 6, i) === 'async ') i -= 6;
  let j = APP.indexOf('{', i), depth = 0;
  for (let k = j; k < APP.length; k++) { const ch = APP[k]; if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) return APP.slice(i, k + 1); } }
  return '';
}
const names = ['escAttr', 'escapeHtml', 'safeUrl', 'factPackAgo', 'factPackOf', 'factPackHref', 'factPackRowHtml', 'factPackSectionHtml'];
const src = names.map(grab);
ok(src.every(Boolean), 'the fact-pack UI functions exist in app.html: ' + names.filter((n, i) => !src[i]).join(', '));
// A second `function x(` anywhere in app.html silently replaces the first (the old fpRemove did exactly that).
const uiNames = ['factPackAgo', 'factPackOf', 'factPackHref', 'factPackRowHtml', 'factPackSectionHtml', 'factPackCall', 'factPackApply', 'factPackRefresh', 'factPackRemove'];
ok(uiNames.every(n => (APP.match(new RegExp('function ' + n + '\\(', 'g')) || []).length === 1), 'each fact-pack UI function is declared exactly once in app.html (no name clash)');
ok((APP.match(/function fpRemove\(/g) || []).length === 1, 'the bookmarks panel\'s own fpRemove is still the only one');
const ctx = { settings: { openSections: { facts: true } }, URL, currentBrand: null };
vm.createContext(ctx);
vm.runInContext('var _factPackBusy = false, _factPackMsg = "";\n' + src.join('\n') + '\nthis.render = factPackSectionHtml; this.setBusy = function(b){ _factPackBusy = b; };', ctx);
ctx.currentBrand = { id: 'b', fact_pack: { updatedAt: NOW - 3 * 3600 * 1000, facts: [
  { id: 'F1', text: '<img src=x onerror=alert(1)> water fact', url: 'https://good.gov/a?x="><script>alert(1)</script>', title: '"><script>alert(2)</script>' },
  { id: '"><b>x', text: 'Plain fact two.', url: 'javascript:alert(3)', title: 'JS' },
  { id: 'F3', text: 'Plain fact three.', url: 'http://insecure.example.org/p', title: 'Insecure' },
  { id: 'F4', text: 'Plain fact four.', url: 'https://ok.gov/p', title: '' },
] } };
const out = ctx.render();
ok(!/<img|<script|<b>/i.test(out), 'fact text, title and id are escaped (no live <img>/<script>/<b>)');
ok(!/javascript:/i.test(out), 'a javascript: source never becomes a link');
ok(!/href="http:\/\//.test(out) && out.indexOf('Plain fact three.') >= 0, 'an http source is shown without a link (https only)');
const hrefs = out.match(/href="[^"]*"/g) || [];
ok(hrefs.length === 2 && hrefs.every(x => /^href="https:\/\//.test(x)), 'only the https sources are links: ' + hrefs.join(' '));
ok((out.match(/target="_blank" rel="noopener noreferrer"/g) || []).length === 2, 'source links open in a new tab with noopener');
ok(/ok\.gov<\/a>/.test(out), 'a source with no title is labelled by its host');
ok((out.match(/onclick="factPackRemove\(this\)"/g) || []).length === 4 && /aria-label="Remove this fact"/.test(out), 'every fact has a remove control');
ok(/Refresh facts/.test(out) && /Last updated 3 h ago/.test(out) && !/disabled/.test(out.match(/<button class="sp-fill-btn"[^>]*>/)[0]), 'the Refresh button shows the last-updated time and is enabled');
ctx.setBusy(true);
const busy = ctx.render();
ok(/<button class="sp-fill-btn" id="factPackRefreshBtn"[^>]*disabled/.test(busy) && /Checking sources/.test(busy), 'while running the button is disabled');
ctx.setBusy(false);
ctx.currentBrand = { id: 'b' };
ok(/No checked facts yet/.test(ctx.render()) && /Not refreshed yet/.test(ctx.render()), 'no pack (column missing): an empty section, no crash');
const fpSrc = names.slice(3).map(grab).join('\n') + grab('factPackRefresh') + grab('factPackRemove');
ok(!/\btap\b/i.test(fpSrc) && !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(fpSrc), 'no "tap", no emoji in the fact-pack UI');
ok(/rate_limited|r\.data\.error/.test(grab('factPackRefresh')) && /String\(r\.data\.error/.test(grab('factPackRefresh')), 'the refresh shows the server\'s message (incl. the rate-limit one)');
// the remove control sends the version it shows, and on 409 retries ONCE only if the same fact is still there
{
  const rctx = { URL, currentBrand: null, calls: [], plan: [], showToast() {}, renderSettingsPanel() {} };
  vm.createContext(rctx);
  vm.runInContext('var _factPackBusy = false, _factPackMsg = "";\n' + ['factPackOf', 'factPackApply', 'factPackRemove'].map(grab).join('\n') +
    '\nasync function factPackCall(b){ calls.push(b); return plan.shift(); }\nthis.remove = factPackRemove; this.msg = () => _factPackMsg;', rctx);
  const btn = { disabled: false, getAttribute: () => 'F2' };
  const pk = (rev, t2) => ({ rev, facts: [{ id: 'F1', text: 'One fact.' }, { id: 'F2', text: t2 }] });
  rctx.currentBrand = { id: 'b', fact_pack: pk('r1', 'Two fact.') };
  rctx.calls = []; rctx.plan = [{ ok: false, status: 409, data: { factPack: pk('r2', 'Two fact.') } }, { ok: true, status: 200, data: { factPack: { rev: 'r3', facts: [{ id: 'F1', text: 'One fact.' }] } } }];
  await rctx.remove(btn);
  ok(rctx.calls.length === 2 && rctx.calls[0].rev === 'r1' && rctx.calls[1].rev === 'r2' && rctx.currentBrand.fact_pack.rev === 'r3', 'UI remove: sends its version; on 409 with the same fact still there it retries once with the new version');
  rctx.currentBrand = { id: 'b', fact_pack: pk('r1', 'Two fact.') };
  rctx.calls = []; rctx.plan = [{ ok: false, status: 409, data: { factPack: pk('r2', 'A different fact now.') } }];
  await rctx.remove(btn);
  ok(rctx.calls.length === 1 && rctx.currentBrand.fact_pack.rev === 'r2' && /just changed/.test(rctx.msg()), 'UI remove: on 409 where F2 is now a different fact it shows the latest and does not retry');
}
const panel = grab('renderSettingsPanel');
const iVoice = panel.indexOf("display:${spActiveTab==='voice'?'block':'none'}"), iWs = panel.indexOf("display:${spActiveTab==='workspace'?'block':'none'}"), iFp = panel.indexOf('${factPackSectionHtml()}');
ok(iVoice > 0 && iFp > iVoice && iFp < iWs, 'the Fact pack section sits in Settings > Brand Voice (the Brand brain tab)');

clearTimeout(WALL);
if (failed) { console.log('fact-pack: ' + failed + ' failed, ' + passed + ' passed'); process.exit(1); }
console.log('FACT PACK OK (' + passed + ' checks)');
