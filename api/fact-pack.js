// v706 — THE FACT PACK (.unlazy/quality/PLAN.md, Agent F).
//
// WHY: NO_INVENTION_RULE (api/_brain.js) lets a writer state only what the brand profile contains, so a
// teaching post had nothing outside the brand to stand on and came out thin. This file gives each brand a
// small pack of CHECKED outside facts ("how the world works" in its field) that writers may cite by id.
//
// HOW (one Grok web search per brand per week, then a server-side check of every fact):
//   1. SEARCH  — callGrokSearch on the brand's topics returns 10–20 candidates {text, url, title, topic}.
//   2. FILTER  — https only; no social media, forums or shops; not the brand's own site or a competitor's;
//                no fact about the brand itself, no health/benefit claim about it, nothing salesy (hasSales).
//   3. VERIFY  — fetch every source page (no private IPs or localhost — checked on every DNS answer and
//                pinned for the connection, 6 s timeout, 1.5 MB cap, at most 3 redirects, each re-checked)
//                and keep a fact only when one stretch of the page carries its key terms AND every number
//                in it (normalized: 1,000 = 1000; 50% = 50 percent). Reputable sources rank first.
//   4. STORE   — brands.fact_pack (sql/fact-pack.sql) = {updatedAt, lastSearchAt, facts:[{id:'F1', text,
//                url, title, topic, fetchedAt}]}. The old pack is replaced ONLY when >= KEEP_MIN facts passed.
//
// ENTRY POINTS (one function file):
//   GET  + Bearer CRON_SECRET  — the daily cron (vercel.json). A brand is due once WEEK_MS has passed since
//        its last search, so each brand is searched at most once a week on its own day (staggered by when
//        it was first searched). Skips brands inactive > 14 days and non-paying owners over the cost fuse.
//   POST {brandId, action:'refresh'} — "Refresh facts" (brand OWNER only, once per 6 h per brand).
//   POST {brandId, action:'remove', id:'F3'} — remove one fact (owner or member, like any brand field).
// Cost: platform cost (no user credits), bounded by the weekly cadence, the 6 h manual gap and the fuse.
// Until sql/fact-pack.sql runs, every path answers "not set up" and nothing crashes.
'use strict';
const https = require('https');
const dns = require('dns');
const net = require('net');
const zlib = require('zlib');
const { StringDecoder } = require('string_decoder');
const store = require('./_publish/store');

const C = {
  CANDIDATES_MAX: 20,
  KEEP_MIN: 5,
  PACK_MAX: 20,
  FETCH_TIMEOUT_MS: 6000,
  FETCH_MAX_BYTES: 1536 * 1024,
  TEXT_MAX_CHARS: 1536 * 1024,      // no text step ever sees more than this
  MAX_REDIRECTS: 3,
  FETCH_CONC: 5,
  DNS_TIMEOUT_MS: 3000,
  WEEK_MS: 7 * 24 * 3600 * 1000,
  CRON_SLACK_MS: 30 * 60 * 1000,      // the cron fires at the same minute daily; a search stamped 2 min into
                                      // last week's run must be due again at this week's run
  MANUAL_GAP_MS: 6 * 3600 * 1000,
  INACTIVE_MS: 14 * 24 * 3600 * 1000,
  CRON_CAP: 12,                       // brands searched per run at most
  CRON_CONC: 3,
  BUDGET_MS: 270000,                  // maxDuration 300 (vercel.json)
  WORST_BATCH_MS: 95000,              // search <= 60 s + verification <= 25 s + the write
  MANUAL_BUDGET_MS: 110000,
  SEARCH_COST_EUR: 0.05,              // one Grok web search — the price _usage.js puts on pulltrends
  WINDOW_WORDS: 400,                  // terms + numbers must sit inside one stretch of this many words
};

// Swappable edges — the gate replaces these; nothing else in this file touches the network.
const deps = {
  search: (prompt, opts) => require('./_llm').callGrokSearch(prompt, opts),
  lookup: (host) => dns.promises.lookup(host, { all: true, verbatim: true }),
  httpGet: realHttpGet,
  now: () => Date.now(),
};

// ─────────────────────────────── URL safety ───────────────────────────────
function ipIsPrivate(ip) {
  const s = String(ip || '').toLowerCase();
  if (net.isIPv4(s)) {
    const p = s.split('.').map(Number);
    const a = p[0], b = p[1];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && p[2] === 0) ||
      (a === 192 && b === 0 && p[2] === 2) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && p[2] === 100) ||
      (a === 203 && b === 0 && p[2] === 113) || a >= 224;
  }
  if (net.isIPv6(s)) {
    // v706 r2 — judge the 8 NORMALIZED groups, never the spelling: '0:0:0:0:0:ffff:7f00:1' is 127.0.0.1.
    const g = ipv6Groups(s);
    if (!g) return true;
    const v4 = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
    const zero = (n) => g.slice(0, n).every(x => x === 0);
    if (zero(8) || (zero(7) && g[7] === 1)) return true;                          // :: and ::1
    if (zero(5) && g[5] === 0xffff) return ipIsPrivate(v4(g[6], g[7]));           // ::ffff:a.b.c.d (mapped)
    if (zero(6)) return true;                                                     // ::a.b.c.d (deprecated compat)
    if (zero(4) && g[4] === 0xffff && g[5] === 0) return true;                    // ::ffff:0:a.b.c.d (SIIT)
    if (g[0] === 0x2002) return ipIsPrivate(v4(g[1], g[2]));                      // 6to4: the embedded IPv4 decides
    if (g[0] === 0x2001 && g[1] === 0) return true;                               // Teredo 2001::/32
    if (g[0] === 0x2001 && g[1] === 0xdb8) return true;                           // documentation
    if (g[0] === 0x64 && g[1] === 0xff9b) return true;                            // NAT64 64:ff9b::/96 (+ local-use /48)
    if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true;  // discard-only 100::/64
    if ((g[0] & 0xfe00) === 0xfc00) return true;                                  // unique local fc00::/7
    if ((g[0] & 0xffc0) === 0xfe80) return true;                                  // link-local fe80::/10
    if ((g[0] & 0xffc0) === 0xfec0) return true;                                  // site-local fec0::/10
    if ((g[0] & 0xff00) === 0xff00) return true;                                  // multicast
    return false;
  }
  return true;                                                          // not an IP at all: refuse
}

// '::ffff:127.0.0.1' / '0:0::1' / '[fe80::1%eth0]' -> 8 numbers, or null when it is not an IPv6 address.
function ipv6Groups(ip) {
  let s = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!net.isIPv6(s)) return null;
  const m = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) {
    const p = m[2].split('.').map(Number);
    s = m[1] + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const all = head.concat(new Array(fill).fill('0'), tail);
  if (all.length !== 8) return null;
  const out = all.map(h => parseInt(h, 16));
  return out.every(n => n >= 0 && n <= 0xffff) ? out : null;
}

function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw == null ? '' : raw).trim()); } catch (e) { return { ok: false, reason: 'bad_url' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'not_https' };
  if (u.username || u.password) return { ok: false, reason: 'bad_url' };
  if (u.port && u.port !== '443') return { ok: false, reason: 'bad_port' };
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!host) return { ok: false, reason: 'bad_url' };
  if (net.isIP(host)) return { ok: false, reason: ipIsPrivate(host) ? 'private_ip' : 'ip_literal' };
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home|arpa|test|invalid|example)$/.test(host) || host.indexOf('.') < 0) {
    return { ok: false, reason: 'private_host' };
  }
  if (String(u.href).length > 500) return { ok: false, reason: 'bad_url' };
  return { ok: true, url: u, host };
}

const hostIs = (host, d) => host === d || host.endsWith('.' + d);
const SOCIAL = ['facebook.com', 'fb.com', 'fb.watch', 'instagram.com', 'tiktok.com', 'twitter.com', 'x.com', 't.co',
  'threads.net', 'reddit.com', 'redd.it', 'quora.com', 'pinterest.com', 'linkedin.com', 'lnkd.in', 'youtube.com',
  'youtu.be', 'tumblr.com', 'snapchat.com', 'discord.com', 'discord.gg', 't.me', 'telegram.org', 'vk.com', 'weibo.com',
  'medium.com', 'substack.com', 'bsky.app', 'mastodon.social', 'twitch.tv', 'stackexchange.com', 'stackoverflow.com',
  'answers.com', 'wikihow.com', 'tripadvisor.com', 'trustpilot.com', 'yelp.com'];
const SHOPS = ['ebay.com', 'etsy.com', 'aliexpress.com', 'alibaba.com', 'walmart.com', 'temu.com', 'iherb.com',
  'myshopify.com', 'shopify.com', 'bol.com', 'zalando.com', 'wish.com', 'shein.com', 'target.com', 'bestbuy.com'];
// Why a source is not allowed, or '' when it is. `brand` adds the brand's own site and its competitors.
function sourceBlockReason(host, pathname, brand) {
  const h = String(host || '').toLowerCase();
  const p = String(pathname || '').toLowerCase();
  if (SOCIAL.some(d => hostIs(h, d))) return 'social';
  if (/^(forum|forums|boards|community|communities|discuss|discussions)\./.test(h) || /\/(forum|forums|community|threads?|discussion|discussions|questions)\//.test(p + '/')) return 'forum';
  if (/(^|\.)amazon\.[a-z.]+$/.test(h) || /(^|\.)ebay\.[a-z.]+$/.test(h) || SHOPS.some(d => hostIs(h, d))) return 'shop';
  if (/\/(products?|shop|store|cart|checkout|collections|buy)(\/|$)/.test(p)) return 'shop';
  if (brand) {
    const own = siteHost(brand.website);
    if (own && (hostIs(h, own) || hostIs(own, h))) return 'own_site';
    const compact = h.replace(/[^a-z0-9]/g, '');
    if (competitorNames(brand).some(n => n.compact.length >= 4 && compact.indexOf(n.compact) >= 0)) return 'competitor';
  }
  return '';
}
function siteHost(w) {
  const s = String(w || '').trim();
  if (!s) return '';
  try { return new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { return ''; }
}
function competitorNames(brand) {
  const raw = String((brand && (brand.competitors_text || (brand.voice_extra && brand.voice_extra.competitors))) || '');
  return raw.split(/[\n,;|]+/).map(x => x.replace(/https?:\/\//i, '').replace(/\(.*?\)/g, '').trim()).filter(Boolean).slice(0, 20)
    .map(x => ({ phrase: normText(x), compact: x.toLowerCase().replace(/^www\./, '').replace(/\.[a-z]{2,}(\/.*)?$/, '').replace(/[^a-z0-9]/g, '') }));
}

// Reputable first: 3 = government / academic / intergovernmental, 2 = journals, major orgs and newsrooms, 1 = other.
const REPUTABLE_2 = ['nature.com', 'science.org', 'thelancet.com', 'bmj.com', 'nejm.org', 'jamanetwork.com', 'sciencedirect.com',
  'springer.com', 'wiley.com', 'cochranelibrary.com', 'plos.org', 'frontiersin.org', 'cell.com', 'oup.com', 'tandfonline.com',
  'oecd.org', 'worldbank.org', 'imf.org', 'un.org', 'fao.org', 'reuters.com', 'apnews.com', 'bbc.co.uk', 'bbc.com', 'nytimes.com',
  'theguardian.com', 'ft.com', 'economist.com', 'statista.com', 'britannica.com', 'mayoclinic.org', 'clevelandclinic.org',
  'hopkinsmedicine.org', 'nhs.uk', 'pewresearch.org', 'ourworldindata.org', 'eurostat.ec.europa.eu', 'wikipedia.org'];
function sourceScore(host) {
  const h = String(host || '').toLowerCase();
  if (/(^|\.)(gov|mil|edu|int)(\.[a-z]{2})?$/.test(h) || /(^|\.)ac\.[a-z]{2}$/.test(h) || /(^|\.)gc\.ca$/.test(h) ||
      hostIs(h, 'europa.eu') || hostIs(h, 'who.int') || /(^|\.)(gouv\.fr|bund\.de|gov\.uk|riigiteataja\.ee|stat\.ee)$/.test(h)) return 3;
  if (REPUTABLE_2.some(d => hostIs(h, d))) return 2;
  return 1;
}

// ─────────────────────────────── text checks ───────────────────────────────
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', minus: '-', rsquo: "'",
  lsquo: "'", ldquo: '"', rdquo: '"', hellip: '...', thinsp: ' ', ensp: ' ', emsp: ' ', percnt: '%', comma: ',', period: '.' };
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{1,10});/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' '; } catch (_) { return ' '; }
    }
    const v = ENT[e.toLowerCase()];
    return v == null ? m : v;
  });
}
// Whitespace is collapsed FIRST, so no later pattern can walk a long run of spaces from every digit.
function normText(s) {
  return String(s == null ? '' : s).slice(0, C.TEXT_MAX_CHARS).toLowerCase()
    .replace(/\s{2,}|[^\S ]/g, ' ')                  // runs, tabs, newlines, nbsp/thin spaces -> one space (lone spaces untouched: fast)
    .replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/(\d) ?(?:per ?cent|percent|pct)\b/g, '$1%')
    .replace(/(\d) %/g, '$1%')
    .trim();
}
// v706 r2 — A LINEAR SCAN, NOT LAZY REGEXES. `<script[\s\S]*?<\/script>` restarts at every "<script" and
// runs to the end of the page when the close tag is missing: quadratic, synchronous, and a hostile or
// broken 1.5 MB page took minutes and blew the cron's budget. Every indexOf below starts where the
// last one ended, and an unclosed block / comment / tag ends the scan, so the work is one pass.
const SKIP_BLOCKS = ['script', 'style', 'noscript', 'template', 'svg'];
function stripTags(s) {
  const low = s.replace(/[A-Z]/g, (c) => c.toLowerCase());     // same length as s (ASCII only)
  const n = s.length, out = [];
  let i = 0;
  scan: while (i < n) {
    const lt = low.indexOf('<', i);
    if (lt < 0) { out.push(s.slice(i)); break; }
    out.push(s.slice(i, lt), ' ');
    if (low.startsWith('<!--', lt)) {
      const e = low.indexOf('-->', lt + 4);
      if (e < 0) break;
      i = e + 3; continue;
    }
    for (const tag of SKIP_BLOCKS) {
      if (low.startsWith('<' + tag, lt) && !/[a-z0-9-]/.test(low[lt + 1 + tag.length] || '')) {
        const e = low.indexOf('</' + tag, lt + 1 + tag.length);
        if (e < 0) break scan;
        const gt = low.indexOf('>', e);
        if (gt < 0) break scan;
        i = gt + 1; continue scan;
      }
    }
    const gt = low.indexOf('>', lt + 1);
    if (gt < 0) { out.push(s.slice(lt + 1)); break; }            // a stray "<" in text: keep the rest as text
    i = gt + 1;
  }
  return out.join('');
}
function htmlToText(body, contentType) {
  let s = String(body || '').slice(0, C.TEXT_MAX_CHARS);
  if (/html|xml/i.test(String(contentType || '')) || /<(html|body|p|div)[\s>]/i.test(s.slice(0, 5000))) s = stripTags(s);
  return normText(decodeEntities(s));
}
// One number token -> its canonical form. 1,000 / 1.000 (European grouping) -> 1000; 2,5 -> 2.5; 07 -> 7.
function canonNum(tok) {
  let t = String(tok);
  const pct = /%$/.test(t);
  t = t.replace(/%$/, '');
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');
  else if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^\d+,\d+$/.test(t)) t = t.replace(',', '.');
  else if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  if (!isFinite(n)) return null;
  return String(n) + (pct ? '%' : '');
}
const NUM_RE = /\d+(?:[.,]\d+)*%?/g;
function numbersIn(norm) { return (String(norm).match(NUM_RE) || []).map(canonNum).filter(Boolean); }
const STOP = new Set(('a an the and or but nor for with without from into onto than then that this these those there their they them ' +
  'what when where which while who whom whose why how have has had having been being were will would could should shall ' +
  'about above after again against among around because before below between both during each even every from further ' +
  'here into just more most much many must only other over same some such very also your yours ours ourselves itself ' +
  'study studies research researchers report reports reported according percent people found finds show shows shown').split(/\s+/));
const stemOf = (w) => w.slice(0, Math.max(4, Math.min(w.length - 1, 6)));
function keyTerms(norm) {
  const out = [], seen = new Set();
  for (const w of (String(norm).match(/[a-z\u00c0-\u024f]{4,}/g) || [])) {
    if (STOP.has(w)) continue;
    const s = stemOf(w);
    if (seen.has(s)) continue;
    seen.add(s); out.push(s);
  }
  return out;
}
// Does ONE stretch of the page (WINDOW_WORDS tokens) carry enough of the fact's key terms and EVERY number?
function pageSupports(factText, pageNorm) {
  const fn = normText(factText);
  const terms = keyTerms(fn);
  const nums = Array.from(new Set(numbersIn(fn)));
  if (terms.length < 2) return { ok: false, reason: 'too_vague' };
  const needTerms = terms.length <= 3 ? terms.length : Math.ceil(terms.length * 0.7);
  const want = new Set(terms.map(t => 't:' + t).concat(nums.map(n => 'n:' + n)));
  const events = [];
  const re = /\d+(?:[.,]\d+)*%?|[a-z\u00c0-\u024f]+/g;
  let m, pos = 0;
  while ((m = re.exec(pageNorm))) {
    const tok = m[0];
    if (/^\d/.test(tok)) {
      const c = canonNum(tok);
      if (c) {
        if (want.has('n:' + c)) events.push([pos, 'n:' + c]);
        if (/%$/.test(c) && want.has('n:' + c.slice(0, -1))) events.push([pos, 'n:' + c.slice(0, -1)]);
      }
    } else if (tok.length >= 4) {
      for (let L = 4; L <= Math.min(6, tok.length); L++) { const k = 't:' + tok.slice(0, L); if (want.has(k)) events.push([pos, k]); }
    }
    pos++;
  }
  // Two pointers over the hits: is there a window holding needTerms distinct terms and all numbers?
  const cnt = new Map();
  let haveT = 0, haveN = 0, lo = 0;
  for (let hi = 0; hi < events.length; hi++) {
    const k = events[hi][1];
    cnt.set(k, (cnt.get(k) || 0) + 1);
    if (cnt.get(k) === 1) { if (k[0] === 't') haveT++; else haveN++; }
    while (events[hi][0] - events[lo][0] > C.WINDOW_WORDS) {
      const k2 = events[lo][1];
      cnt.set(k2, cnt.get(k2) - 1);
      if (cnt.get(k2) === 0) { if (k2[0] === 't') haveT--; else haveN--; }
      lo++;
    }
    if (haveT >= needTerms && haveN >= nums.length) return { ok: true };
  }
  // Name the reason precisely: a number missing anywhere on the page is the most telling one.
  const allHits = new Set(events.map(e => e[1]));
  if (nums.some(n => !allHits.has('n:' + n))) return { ok: false, reason: 'number_not_on_page' };
  return { ok: false, reason: 'terms_not_on_page' };
}

const HEALTH_RE = /\b(cure[sd]?|curing|treat(s|ed|ing|ment)?|prevent(s|ed|ing|ion)?|heal(s|ed|ing)?|boost(s|ed|ing)?|improv(e|es|ed|ing)|reduc(e|es|ed|ing)|relie(f|ve|ves|ved)|detox\w*|immun\w*|clinically|proven|benefit(s|ed)?|helps?|lower(s|ed|ing)?|burn(s)? fat|weight loss|anti-?aging|anti-?inflammatory|recover\w*|energ\w*|perform\w*|hydrat\w*|healthier|wellness)\b/i;
let _hasSales = null;
function salesy(text) {
  if (!_hasSales) {
    try { const W = require('./_write'); if (typeof W.hasSales === 'function') _hasSales = W.hasSales; } catch (e) { /* fall back below */ }
    if (!_hasSales) _hasSales = (t) => /\b(link in bio|shop now|buy now|order now|use code|discount code|promo code|% off|limited[- ]time|while stocks last|add to cart|free shipping|sign up today)\b/i.test(String(t || ''));
  }
  try { return !!_hasSales(text); } catch (e) { return false; }
}
// Facts must be about the world, not the brand: naming the brand (or "we/our") is out, and a health or
// benefit claim about it is the case this rule exists for.
function aboutBrandReason(text, brand) {
  const n = ' ' + normText(text).replace(/[^a-z0-9\u00c0-\u024f%]+/g, ' ') + ' ';
  const name = normText((brand && brand.brand_name) || '').replace(/[^a-z0-9\u00c0-\u024f]+/g, ' ').trim();
  const self = (name.length >= 3 && n.indexOf(' ' + name + ' ') >= 0) || /\s(we|our|ours|us)\s/.test(n);
  if (self) return HEALTH_RE.test(n) ? 'product_claim' : 'about_brand';
  if (competitorNames(brand).some(c => c.phrase.length >= 4 && n.indexOf(' ' + c.phrase.replace(/[^a-z0-9\u00c0-\u024f]+/g, ' ').trim() + ' ') >= 0)) return 'about_competitor';
  return '';
}

// ─────────────────────────────── candidates ───────────────────────────────
function normCandidates(parsed) {
  const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.facts) ? parsed.facts : []);
  const out = [], seen = new Set();
  for (const x of arr) {
    if (!x || typeof x !== 'object') continue;
    const text = String(x.text == null ? '' : x.text).replace(/\s+/g, ' ').trim();
    const url = String(x.url == null ? '' : x.url).trim();
    if (text.length < 20 || text.length > 300 || !url) continue;
    const k = text.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ text, url, title: String(x.title == null ? '' : x.title).replace(/\s+/g, ' ').trim().slice(0, 140),
      topic: String(x.topic == null ? '' : x.topic).replace(/\s+/g, ' ').trim().slice(0, 60) });
    if (out.length >= C.CANDIDATES_MAX) break;
  }
  return out;
}
function topicsFor(b) {
  const list = [];
  const comm = b && b.communities;
  if (Array.isArray(comm)) list.push(...comm.map(String));
  else if (typeof comm === 'string') list.push(...comm.split(/[,\n]/));
  const ve = (b && b.voice_extra && typeof b.voice_extra === 'object') ? b.voice_extra : {};
  if (ve.painPoints) list.push(String(ve.painPoints).split(/[.\n;]/)[0]);
  const seen = new Set(), out = [];
  for (let t of list) {
    t = String(t || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (t.length < 3 || /^(general|all)$/i.test(t) || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase()); out.push(t);
    if (out.length >= 5) break;
  }
  return out;
}
function searchPrompt(b) {
  const topics = topicsFor(b);
  if (!topics.length) return '';
  const audience = String((b && b.target_audience) || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const avoid = [String((b && b.brand_name) || '').trim()].concat(competitorNames(b).map(c => c.phrase)).filter(Boolean).join(', ').slice(0, 300);
  return [
    'Search the web for 10 to 20 short, checkable FACTS about these topics: ' + topics.join('; ') + '.',
    audience ? 'They will be used in short educational posts for this audience: ' + audience + '.' : '',
    'Rules:',
    '- Each fact is ONE plain sentence that states something true about how the world works in this field: a research finding, an official statistic, a definition, a piece of history or a rule. Not an opinion, not a tip, not advice.',
    '- Copy the wording of any number exactly as the source page writes it. Never round, convert or combine numbers.',
    '- The fact must be stated on the exact page you cite (a deep link to that page, not a home page).',
    '- Sources: prefer government agencies, universities, peer-reviewed journals, major international organisations and major news outlets. Never social media, forums, Q&A sites, blogs, or online shops and product pages.',
    avoid ? '- Never a fact about a specific brand, company or product, and never about: ' + avoid + '.' : '- Never a fact about a specific brand, company or product.',
    '- No health or benefit claims about any product, and nothing promotional.',
    'Return ONLY a JSON array, no prose: [{"text":"the fact","url":"https://...","title":"the page title","topic":"which topic it belongs to"}]',
  ].filter(Boolean).join('\n');
}

// ─────────────────────────────── fetching ───────────────────────────────
function realHttpGet(url, o) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    let done = false, timer = null;
    const finish = (err, val) => { if (done) return; done = true; try { clearTimeout(timer); } catch (_) {} err ? reject(err) : resolve(val); };
    const req = https.request({
      host: u.hostname, servername: u.hostname, port: 443, path: u.pathname + u.search, method: 'GET',
      // The address was vetted by the caller; pin it so a second DNS answer cannot point the socket elsewhere.
      lookup: (h, opts, cb) => (opts && opts.all) ? cb(null, [{ address: o.address, family: o.family }]) : cb(null, o.address, o.family),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ContentShrimpFactCheck/1.0; +https://contentshrimp.com)',
        'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1', 'Accept-Encoding': 'gzip, deflate, br', 'Accept-Language': 'en' },
    }, (resp) => {
      const status = resp.statusCode || 0;
      if (status >= 300 && status < 400) { resp.resume(); return finish(null, { status, headers: resp.headers, body: '' }); }
      const enc = String(resp.headers['content-encoding'] || '').toLowerCase();
      let stream = resp;
      try {
        if (enc === 'gzip' || enc === 'x-gzip') stream = resp.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = resp.pipe(zlib.createInflate());
        else if (enc === 'br') stream = resp.pipe(zlib.createBrotliDecompress());
      } catch (e) { return finish(e); }
      const dec = new StringDecoder('utf8');
      let body = '', bytes = 0;
      stream.on('data', (c) => {
        if (done) return;
        bytes += c.length;
        if (bytes > o.maxBytes) {                                 // cap: verify on what fits, stop reading
          body += dec.write(c.slice(0, Math.max(0, c.length - (bytes - o.maxBytes))));
          try { req.destroy(); } catch (_) {}
          return finish(null, { status, headers: resp.headers, body, truncated: true });
        }
        body += dec.write(c);
      });
      stream.on('end', () => finish(null, { status, headers: resp.headers, body: body + dec.end() }));
      stream.on('error', (e) => finish(e));
    });
    req.on('error', (e) => finish(e));
    req.setTimeout(o.timeoutMs, () => { try { req.destroy(new Error('timeout')); } catch (_) {} });
    timer = setTimeout(() => { try { req.destroy(new Error('timeout')); } catch (_) {} finish(new Error('timeout')); }, o.timeoutMs);
    req.end();
  });
}
function withTimeout(p, ms) {
  let t;
  return Promise.race([Promise.resolve(p), new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); })])
    .finally(() => clearTimeout(t));
}
// Fetch one page safely. Every hop (the first URL and each redirect) passes the same checks.
async function fetchPage(raw, deadlineAt) {
  let cur = raw;
  for (let hop = 0; hop <= C.MAX_REDIRECTS; hop++) {
    const c = checkUrl(cur);
    if (!c.ok) return { ok: false, reason: c.reason };
    const blocked = sourceBlockReason(c.host, c.url.pathname, null);
    if (blocked) return { ok: false, reason: blocked };
    let addrs;
    try { addrs = await withTimeout(deps.lookup(c.host), C.DNS_TIMEOUT_MS); } catch (e) { return { ok: false, reason: 'unreachable' }; }
    addrs = (Array.isArray(addrs) ? addrs : [addrs]).filter(a => a && a.address);
    if (!addrs.length) return { ok: false, reason: 'unreachable' };
    if (addrs.some(a => ipIsPrivate(a.address))) return { ok: false, reason: 'private_ip' };
    const left = Math.min(C.FETCH_TIMEOUT_MS, (deadlineAt || Infinity) - deps.now());
    if (!(left >= 1000)) return { ok: false, reason: 'timeout' };
    let r;
    try {
      r = await deps.httpGet(c.url.href, { address: addrs[0].address, family: addrs[0].family || (net.isIPv6(addrs[0].address) ? 6 : 4), timeoutMs: left, maxBytes: C.FETCH_MAX_BYTES });
    } catch (e) { return { ok: false, reason: 'unreachable' }; }
    const status = (r && r.status) || 0;
    if (status >= 300 && status < 400) {
      const loc = r.headers && (r.headers.location || r.headers.Location);
      if (!loc) return { ok: false, reason: 'unreachable' };
      try { cur = new URL(String(loc), c.url).href; } catch (e) { return { ok: false, reason: 'bad_url' }; }
      continue;
    }
    if (status < 200 || status >= 300) return { ok: false, reason: 'unreachable' };
    const ct = String((r.headers && (r.headers['content-type'] || r.headers['Content-Type'])) || '').toLowerCase();
    if (ct && !/text\/html|application\/xhtml|text\/plain|xml/.test(ct)) return { ok: false, reason: 'not_text' };
    return { ok: true, text: htmlToText(String(r.body || '').slice(0, C.FETCH_MAX_BYTES), ct), finalHost: c.host, finalUrl: c.url.href };
  }
  return { ok: false, reason: 'too_many_redirects' };
}

// The whole check for a list of candidates. Returns { kept:[...], dropped:{reason:n} }. `kept` are sorted
// reputable-first (stable), at most PACK_MAX, WITHOUT ids — packFrom() assigns them.
async function verifyCandidates(cands, brand, opts) {
  const o = opts || {};
  const deadlineAt = o.deadlineAt || (deps.now() + 25000);
  const dropped = {};
  const drop = (r) => { dropped[r] = (dropped[r] || 0) + 1; };
  const pending = [];
  for (const f of (Array.isArray(cands) ? cands : [])) {
    const c = checkUrl(f.url);
    if (!c.ok) { drop(c.reason); continue; }
    const why = sourceBlockReason(c.host, c.url.pathname, brand);
    if (why) { drop(why); continue; }
    if (salesy(f.text)) { drop('salesy'); continue; }
    const ab = aboutBrandReason(f.text, brand);
    if (ab) { drop(ab); continue; }
    pending.push(Object.assign({}, f, { url: c.url.href, _host: c.host }));
  }
  // One fetch per distinct URL, FETCH_CONC at a time.
  const urls = Array.from(new Set(pending.map(f => f.url)));
  const pages = new Map();
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const u = urls[next++];
      let r;
      try { r = await fetchPage(u, deadlineAt); } catch (e) { r = { ok: false, reason: 'unreachable' }; }
      pages.set(u, r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(C.FETCH_CONC, urls.length) }, worker));
  const kept = [];
  pending.forEach((f, i) => {
    const pg = pages.get(f.url);
    if (!pg || !pg.ok) { drop((pg && pg.reason) || 'unreachable'); return; }
    if (pg.finalHost && sourceBlockReason(pg.finalHost, '', brand)) { drop(sourceBlockReason(pg.finalHost, '', brand)); return; }
    const v = pageSupports(f.text, pg.text);
    if (!v.ok) { drop(v.reason); return; }
    // Rank and cite by where the page really lives (after any redirect), not by the link the search gave.
    kept.push({ f: Object.assign({}, f, { url: pg.finalUrl || f.url, _host: pg.finalHost || f._host }), score: sourceScore(pg.finalHost || f._host), i });
  });
  kept.sort((a, b) => (b.score - a.score) || (a.i - b.i));
  return { kept: kept.slice(0, C.PACK_MAX).map(k => ({ text: k.f.text, url: k.f.url, title: k.f.title || k.f._host, topic: k.f.topic })), dropped };
}
// rev changes on EVERY server write, so a writer that read the pack can make its write conditional on it.
const newRev = () => deps.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
const revFilter = (p) => (p && p.rev != null) ? '&fact_pack->>rev=eq.' + encodeURIComponent(String(p.rev)) : '&fact_pack->>rev=is.null';
function packFrom(kept, now, lastSearchAt) {
  return { rev: newRev(), updatedAt: now, lastSearchAt: lastSearchAt || now,
    facts: kept.slice(0, C.PACK_MAX).map((f, i) => ({ id: 'F' + (i + 1), text: f.text, url: f.url, title: f.title, topic: f.topic || '', fetchedAt: now })) };
}
// Search + verify for one brand. Never throws. { kept, dropped, candidates, reason? }
async function buildFacts(brand, opts) {
  const o = opts || {};
  const prompt = searchPrompt(brand);
  if (!prompt) return { kept: [], dropped: {}, candidates: 0, reason: 'no_topics', searched: false };
  let text = null;
  try { text = await deps.search(prompt, { maxTokens: 3000, timeoutMs: o.searchMs || 60000 }); } catch (e) { text = null; }
  if (!text) return { kept: [], dropped: {}, candidates: 0, reason: 'search_empty', searched: true };
  let parsed = null;
  try { parsed = require('./_brain').extractJson(text); } catch (e) { parsed = null; }
  const cands = normCandidates(parsed);
  if (!cands.length) return { kept: [], dropped: {}, candidates: 0, reason: 'search_unparseable', searched: true };
  const v = await verifyCandidates(cands, brand, { deadlineAt: deps.now() + (o.verifyMs || 25000) });
  return { kept: v.kept, dropped: v.dropped, candidates: cands.length, searched: true };
}

// ─────────────────────────────── storage ───────────────────────────────
const BRAND_COLS = 'id,user_id,brand_name,website,communities,target_audience,voice_extra,competitors_text,fact_pack';
const okStatus = (r) => !!r && r.status >= 200 && r.status < 300;
// PostgREST answers 400 "column brands.fact_pack does not exist" (42703) until sql/fact-pack.sql runs.
const columnMissing = (r) => !!r && r.status >= 400 && r.status < 500 && /fact_pack/i.test(String(r.raw || '') + JSON.stringify(r.data || ''));
const packOf = (b) => (b && b.fact_pack && typeof b.fact_pack === 'object' && !Array.isArray(b.fact_pack)) ? b.fact_pack : null;
// Claim the search slot with an optimistic lock on lastSearchAt, so two clicks (or the cron and a click)
// can never both pay for a search. true = this caller owns the slot.
async function claimSearch(brandId, prev, now) {
  const enc = encodeURIComponent(brandId);
  const prevAt = prev && prev.lastSearchAt;
  const filter = !prev ? '&fact_pack=is.null'
    : (prevAt != null ? '&fact_pack->>lastSearchAt=eq.' + encodeURIComponent(String(prevAt)) : '&fact_pack->>lastSearchAt=is.null');
  const body = { fact_pack: Object.assign({ facts: [] }, prev || {}, { lastSearchAt: now, rev: newRev() }) };
  const r = await store.rest('PATCH', '/brands?id=eq.' + enc + filter + '&select=id', { body, headers: { Prefer: 'return=representation' } });
  return okStatus(r) && Array.isArray(r.data) && r.data.length === 1;
}
// Replace the pack — only when it holds KEEP_MIN facts, and only if nobody claimed a newer search since.
async function savePack(brandId, kept, claimedAt, now) {
  if (!Array.isArray(kept) || kept.length < C.KEEP_MIN) return { saved: false, reason: 'too_few' };
  const pack = packFrom(kept, now, claimedAt);
  const r = await store.rest('PATCH', '/brands?id=eq.' + encodeURIComponent(brandId) + '&fact_pack->>lastSearchAt=eq.' +
    encodeURIComponent(String(claimedAt)) + '&select=id', { body: { fact_pack: pack }, headers: { Prefer: 'return=representation' } });
  if (!okStatus(r)) throw new Error('fact_pack PATCH ' + ((r && r.status) || 'no response') + ' ' + String((r && r.raw) || '').slice(0, 160));
  if (!Array.isArray(r.data) || r.data.length !== 1) return { saved: false, reason: 'superseded' };
  return { saved: true, pack };
}

// ─────────────────────────────── activity + cost ───────────────────────────────
// Last thing a PERSON did on the brand: their newest idea (the daily cron's untouched 'daily' rows do not
// count — the send-daily rule) or their newest usage row (except 'ideas', which the daily batch also writes).
async function lastActivityAt(brand) {
  const enc = encodeURIComponent(brand.id);
  let at = 0, anyRead = false;
  try {
    let r = await store.rest('GET', '/ideas?brand_id=eq.' + enc + '&select=created_at,status,gen_flow&order=created_at.desc&limit=50');
    if (!okStatus(r) && /gen_flow/i.test(String((r && r.raw) || ''))) r = await store.rest('GET', '/ideas?brand_id=eq.' + enc + '&select=created_at,status&order=created_at.desc&limit=50');
    if (okStatus(r) && Array.isArray(r.data)) {
      anyRead = true;
      const own = r.data.find(x => x && !(x.gen_flow === 'daily' && (!x.status || x.status === 'pending')));
      if (own) at = Math.max(at, Date.parse(own.created_at) || 0);
    }
  } catch (e) { /* counted as unread */ }
  try {
    const u = await store.rest('GET', '/usage_events?brand_id=eq.' + enc + '&select=created_at,action&order=created_at.desc&limit=20');
    if (okStatus(u) && Array.isArray(u.data)) {
      anyRead = true;
      const own = u.data.find(x => x && x.action && !/^(hold:)?ideas(:|$)/.test(String(x.action)));
      if (own) at = Math.max(at, Date.parse(own.created_at) || 0);
    }
  } catch (e) { /* counted as unread */ }
  return anyRead ? at : null;      // null = could not tell
}
// The cost fuse, same rule as _usage.checkLimit: armed when COST_CAP_EUR > 0, applies to trial/free owners.
async function overCostCap(userId) {
  let U;
  try { U = require('./_usage'); } catch (e) { return false; }
  const cap = Number(U.COST_CAP_EUR) || 0;
  if (cap <= 0 || !userId) return false;
  try {
    const s = await U.getStatus(userId);
    if (!s || s.unknown || (s.plan !== 'trial' && s.plan !== 'free')) return false;
    return (Number(s.cost) || 0) + C.SEARCH_COST_EUR > cap;
  } catch (e) { return false; }
}

// ─────────────────────────────── the cron ───────────────────────────────
async function runCron(req, res) {
  try { store.setRequestBudget(20000); } catch (_) {}
  const t0 = deps.now();
  const left = () => C.BUDGET_MS - (deps.now() - t0);
  const r = await store.rest('GET', '/brands?select=' + BRAND_COLS);
  if (columnMissing(r)) {
    console.error('fact-pack-cron: brands.fact_pack does not exist yet — run sql/fact-pack.sql. Nothing searched.');
    await store.heartbeat('fact-pack-cron', 'error', { notSetUp: true });
    return res.status(200).json({ ok: false, notSetUp: true });
  }
  if (!okStatus(r)) {
    console.error('fact-pack-cron: brands read FAILED (' + ((r && r.status) || 'no response') + ') — 0 brands processed');
    return res.status(500).json({ error: 'brands read failed' });
  }
  const now = deps.now();
  const brands = Array.isArray(r.data) ? r.data : [];
  const lastOf = (b) => Number((packOf(b) || {}).lastSearchAt) || 0;
  const due = brands.filter(b => b && b.id && (now - lastOf(b)) >= C.WEEK_MS - C.CRON_SLACK_MS).sort((a, b) => lastOf(a) - lastOf(b));
  const n = { considered: due.length, searched: 0, updated: 0, tooFew: 0, searchEmpty: 0, skipInactive: 0, skipActivityUnknown: 0,
    skipCostCap: 0, skipNoTopics: 0, skipClaimed: 0, failed: 0, untried: 0, ranOut: false };
  // Cheap eligibility first (no money spent), then the paid searches in small parallel batches.
  const ready = [];
  for (let i = 0; i < due.length && ready.length < C.CRON_CAP; i++) {
    const b = due[i];
    if (left() < C.WORST_BATCH_MS) { n.untried += due.length - i; n.ranOut = true; break; }
    if (!searchPrompt(b)) { n.skipNoTopics++; continue; }
    const act = await lastActivityAt(b);
    if (act == null) { n.skipActivityUnknown++; continue; }
    if (now - act > C.INACTIVE_MS) { n.skipInactive++; continue; }
    if (await overCostCap(b.user_id)) { n.skipCostCap++; continue; }
    ready.push(b);
  }
  for (let i = 0; i < ready.length; i += C.CRON_CONC) {
    if (left() < C.WORST_BATCH_MS) { n.untried += ready.length - i; n.ranOut = true; break; }
    const batch = ready.slice(i, i + C.CRON_CONC);
    await Promise.all(batch.map(async (b) => {
      try {
        const claimedAt = deps.now();
        if (!(await claimSearch(b.id, packOf(b), claimedAt))) { n.skipClaimed++; return; }
        n.searched++;
        const out = await buildFacts(b, { searchMs: Math.max(10000, Math.min(60000, left() - 35000)), verifyMs: 25000 });
        if (out.reason === 'search_empty' || out.reason === 'search_unparseable') n.searchEmpty++;
        const s = await savePack(b.id, out.kept, claimedAt, deps.now());
        if (s.saved) n.updated++;
        else {
          n.tooFew++;
          console.log('fact-pack-cron: brand ' + b.id + ' kept its pack — ' + out.kept.length + ' of ' + out.candidates +
            ' candidates passed (' + (out.reason || s.reason) + '; dropped ' + JSON.stringify(out.dropped) + ')');
        }
      } catch (e) {
        n.failed++;
        console.error('fact-pack-cron: brand ' + b.id + ' (' + (b.brand_name || 'unnamed') + ') failed — ' + ((e && e.message) || e));
      }
    }));
  }
  console.log('fact-pack-cron: considered=' + n.considered + ' searched=' + n.searched + ' updated=' + n.updated + ' tooFew=' + n.tooFew +
    ' searchEmpty=' + n.searchEmpty + ' skipped(inactive=' + n.skipInactive + ', activityUnknown=' + n.skipActivityUnknown +
    ', costCap=' + n.skipCostCap + ', noTopics=' + n.skipNoTopics + ', claimed=' + n.skipClaimed + ') failed=' + n.failed +
    (n.ranOut ? ' ranOut untried=' + n.untried : ''));
  const allSilent = n.searched > 0 && n.searchEmpty === n.searched;
  if (allSilent) console.error('fact-pack-cron: EVERY search came back empty (' + n.searched + ') — the search lane is down, not a quiet week.');
  await store.heartbeat('fact-pack-cron', ((n.failed && !n.updated) || allSilent) ? 'error' : 'ok', n);
  return res.status(200).json(Object.assign({ ok: !allSilent }, n));
}

// ─────────────────────────────── the button ───────────────────────────────
function publicPack(p) {
  const pk = p || {};
  return { rev: pk.rev == null ? null : pk.rev, updatedAt: pk.updatedAt || null, lastSearchAt: pk.lastSearchAt || null, facts: Array.isArray(pk.facts) ? pk.facts : [] };
}
async function runUser(req, res) {
  const user = await require('./_requireUser')(req);
  if (!user) return res.status(401).json({ error: 'Please sign in again.' });
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const brandId = String(body.brandId || '').trim();
  const action = String(body.action || 'refresh');
  if (!/^[A-Za-z0-9-]{1,64}$/.test(brandId)) return res.status(400).json({ error: 'Pick a brand first.' });
  if (action !== 'refresh' && action !== 'remove') return res.status(400).json({ error: 'Unknown action.' });
  const r = await store.rest('GET', '/brands?id=eq.' + encodeURIComponent(brandId) + '&select=' + BRAND_COLS);
  if (columnMissing(r)) return res.status(503).json({ code: 'not_set_up', error: 'The fact pack is not set up yet.' });
  if (!okStatus(r)) return res.status(502).json({ error: 'Could not load the brand just now. Try again.' });
  const b = Array.isArray(r.data) ? r.data[0] : null;
  if (!b) return res.status(404).json({ error: 'Brand not found.' });
  const prev = packOf(b);

  if (action === 'remove') {
    let allowed = false;
    try { allowed = await store.userCanAccessBrand(user.id, brandId); } catch (e) { return res.status(503).json({ error: 'Could not check access just now. Try again.' }); }
    if (!allowed) return res.status(403).json({ error: 'This brand is not yours.' });
    const id = String(body.id || '').trim();
    if (!/^F\d{1,2}$/.test(id)) return res.status(400).json({ error: 'Unknown fact.' });
    const facts = (prev && Array.isArray(prev.facts) ? prev.facts : []);
    // v706 r2 — CONDITIONAL on the version the client saw AND the version read here, so a removal can
    // never overwrite a pack a refresh saved a moment ago. A mismatch is 409 with the current pack; the
    // app shows it and retries once if the same fact is still there.
    const conflict = () => res.status(409).json({ code: 'changed', error: 'The facts just changed. Showing the latest.', factPack: publicPack(prev) });
    if (!prev) return conflict();
    if (body.rev !== undefined && String(body.rev == null ? '' : body.rev) !== String(prev.rev == null ? '' : prev.rev)) return conflict();
    if (!facts.some(f => f && f.id === id)) return conflict();
    const next = Object.assign({}, prev, { rev: newRev(), facts: facts.filter(f => f && f.id !== id) });   // ids of the rest stay as they are
    const up = await store.rest('PATCH', '/brands?id=eq.' + encodeURIComponent(brandId) + revFilter(prev) + '&select=id',
      { body: { fact_pack: next }, headers: { Prefer: 'return=representation' } });
    if (!okStatus(up)) return res.status(502).json({ error: 'Could not save that just now. Try again.' });
    if (!Array.isArray(up.data) || up.data.length !== 1) return conflict();
    return res.status(200).json({ ok: true, factPack: publicPack(next) });
  }

  // refresh — the brand OWNER only (a member cannot spend the owner's search budget).
  if (!b.user_id || b.user_id !== user.id) return res.status(403).json({ code: 'owner_only', error: 'Only the brand owner can refresh facts.' });
  const now = deps.now();
  const last = Number(prev && prev.lastSearchAt) || 0;
  if (last && now - last < C.MANUAL_GAP_MS) {
    const retryAfter = Math.ceil((C.MANUAL_GAP_MS - (now - last)) / 1000);
    const h = Math.max(1, Math.round(retryAfter / 3600));
    return res.status(429).json({ code: 'rate_limited', retryAfter, error: 'Facts were refreshed less than 6 hours ago. Try again in about ' + h + (h === 1 ? ' hour.' : ' hours.') });
  }
  if (!searchPrompt(b)) return res.status(400).json({ code: 'no_topics', error: 'Add a few content themes in Brand Basics first.' });
  if (await overCostCap(user.id)) return res.status(402).json({ code: 'cost_cap', error: 'Fact refresh is paused on this plan for now.' });
  if (!(await claimSearch(brandId, prev, now))) return res.status(429).json({ code: 'rate_limited', retryAfter: Math.ceil(C.MANUAL_GAP_MS / 1000), error: 'A refresh is already running for this brand.' });
  const out = await buildFacts(b, { searchMs: 60000, verifyMs: 25000 });
  let s;
  try { s = await savePack(brandId, out.kept, now, deps.now()); }
  catch (e) { console.error('fact-pack: save failed for brand ' + brandId + ' — ' + e.message); return res.status(502).json({ error: 'Could not save the new facts. Try again later.' }); }
  console.log('fact-pack: manual refresh brand ' + brandId + ' — ' + out.kept.length + ' of ' + out.candidates + ' passed, saved=' + !!s.saved +
    ' dropped ' + JSON.stringify(out.dropped));
  if (s.saved) return res.status(200).json({ ok: true, updated: true, kept: out.kept.length, factPack: publicPack(s.pack) });
  const keptPack = Object.assign({}, prev || { facts: [] }, { lastSearchAt: now });
  return res.status(200).json({ ok: true, updated: false, kept: out.kept.length, factPack: publicPack(keptPack),
    message: out.reason === 'search_empty' ? 'The web search did not answer. Your current facts are kept.'
      : 'Only ' + out.kept.length + ' new fact' + (out.kept.length === 1 ? '' : 's') + ' passed the source check (5 needed). Your current facts are kept.' });
}

async function handler(req, res) {
  const allowed = ['https://contentshrimp.com', 'https://bettercontent.app', 'https://boring-engine.vercel.app'];
  const origin = (req.headers && req.headers.origin) || '';
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    if (req.method === 'GET') {
      const cronSecret = process.env.CRON_SECRET;
      if (!cronSecret || ((req.headers && req.headers.authorization) || '') !== 'Bearer ' + cronSecret) return res.status(401).json({ error: 'Unauthorized' });
      return await runCron(req, res);
    }
    if (req.method === 'POST') return await runUser(req, res);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('fact-pack error:', e);
    return res.status(500).json({ error: 'Could not refresh facts just now. Try again later.' });
  }
}

module.exports = handler;
Object.assign(module.exports, {
  _deps: deps, C, ipIsPrivate, checkUrl, sourceBlockReason, sourceScore, canonNum, numbersIn, normText, htmlToText,
  keyTerms, pageSupports, stripTags, ipv6Groups, aboutBrandReason, salesy, normCandidates, topicsFor, searchPrompt, fetchPage, verifyCandidates,
  packFrom, buildFacts, claimSearch, savePack, lastActivityAt, overCostCap, columnMissing,
});
