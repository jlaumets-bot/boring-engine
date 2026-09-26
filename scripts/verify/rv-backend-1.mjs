#!/usr/bin/env node
// GATE: the SSRF guard (api/_safeurl.js) refuses every private address, IPv6 included.
//
// WHY THIS EXISTS
//   v690 review, leaf-2 F1. WHATWG URL keeps the brackets on an IPv6 host
//   (new URL('http://[::1]/').hostname === '[::1]'), and net.isIP('[::1]') is 0, so the guard
//   never saw an IPv6 host as an IP: it ran dns.lookup('[::1]'), that failed, and the failure was
//   swallowed as a "DNS hiccup" — the URL was ALLOWED. Measured before the fix: http://[::1]/,
//   http://[::ffff:127.0.0.1]/, http://[fd00::1]/ (AWS IPv6 metadata lives in fd00:ec2::/32) and
//   http://[::]/ all passed. Every server-side fetcher (extract-article, crawl-brand,
//   transcribe-url, transcribe) trusts this one function.
//
// HOW IT CHECKS
//   It RUNS the real module with dns stubbed (no network): a table of hostile URLs must be
//   refused, a table of public ones must still pass (the opposite arm — an always-refuse guard
//   would break every crawl), a DNS name answering a private address must be refused, a lookup
//   that FAILS must be refused (fail closed), and the connect-time safeLookup must refuse a
//   private answer in both its callback shapes while passing a public one.
//
// RUN:    node scripts/verify/rv-backend-1.mjs
// EXPECT: prints "PASS" and exits 0.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const wall = setTimeout(() => { console.error('FAIL: wall clock — rv-backend-1 did not finish in 30s'); process.exit(1); }, 30000);
wall.unref();

let failed = 0;
const ok = (c, m) => { if (c) console.log('ok: ' + m); else { console.error('FAIL: ' + m); failed++; } };

// ── DNS, scripted: name -> addresses, 'fail' -> ENOTFOUND. Never touches the network. ──
const dnsMod = require_('node:dns');
const ZONE = {
  'public.example': [{ address: '93.184.216.34', family: 4 }],
  'public6.example': [{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }],
  'rebind.example': [{ address: '169.254.169.254', family: 4 }],
  'mixed.example': [{ address: '93.184.216.34', family: 4 }, { address: '::1', family: 6 }],
  'v6meta.example': [{ address: 'fd00:ec2::254', family: 6 }],
  'nat64.example': [{ address: '64:ff9b::a9fe:a9fe', family: 6 }],
  'empty.example': [],
};
const answer = (host) => {
  if (!(host in ZONE)) { const e = new Error('getaddrinfo ENOTFOUND ' + host); e.code = 'ENOTFOUND'; return e; }
  return ZONE[host];
};
dnsMod.promises.lookup = async (host) => { const a = answer(host); if (a instanceof Error) throw a; return a; };
dnsMod.lookup = (host, opts, cb) => { if (typeof opts === 'function') cb = opts; const a = answer(host); setImmediate(() => a instanceof Error ? cb(a) : cb(null, a)); };

const S = require_(path.join(ROOT, 'api', '_safeurl.js'));
const allowed = async (u) => { try { await S.assertPublicHttpUrl(u); return true; } catch (e) { return false; } };

// ── ARM 1: hostile URLs are refused (async AND sync check) ──
const HOSTILE = [
  'http://[::1]/', 'http://[::1]:8080/admin', 'http://[0:0:0:0:0:0:0:1]/', 'http://[::]/',
  'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[::ffff:169.254.169.254]/latest/meta-data/',
  'http://[::ffff:0:a9fe:a9fe]/', 'http://[::127.0.0.1]/',
  'http://[fc00::1]/', 'http://[fd00:ec2::254]/latest/meta-data/', 'http://[fdff:ffff::1]/',
  'http://[fe80::1]/', 'http://[fe90::1]/', 'http://[febf::1]/', 'http://[fec0::1]/',
  'http://[64:ff9b::a9fe:a9fe]/', 'http://[64:ff9b::7f00:1]/', 'http://[64:ff9b:1::1]/',
  'http://[2002:7f00:1::]/', 'http://[2002:a9fe:a9fe::1]/', 'http://[2001:0:4136:e378::1]/',
  'http://[ff02::1]/',
  'http://0.0.0.0/', 'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.1/', 'http://169.254.169.254/',
  'http://10.1.2.3/', 'http://192.168.1.1/', 'http://172.16.0.1/', 'http://100.64.0.1/', 'http://224.0.0.1/',
  // v690 round 2 — the EDGES of each range, so narrowing a range cannot pass: 240.0.0.0/4 reserved
  // and the broadcast address sit above multicast; 100.100.100.200 is Alibaba Cloud's metadata
  // service and 100.127.255.254 the top of CGNAT 100.64.0.0/10.
  'http://240.0.0.1/', 'http://255.255.255.255/', 'http://100.100.100.200/latest/meta-data/', 'http://100.127.255.254/',
  'http://239.255.255.250/', 'http://198.19.255.254/', 'http://192.0.0.192/',
  'http://localhost/', 'http://localhost./', 'http://api.localhost/', 'http://metadata.google.internal/',
  'file:///etc/passwd', 'gopher://public.example/',
];
for (const u of HOSTILE) {
  ok(!(await allowed(u)), 'assertPublicHttpUrl refuses ' + u);
}
// the sync check must refuse the literals specifically (the bracket bug lived in both)
for (const u of ['http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[fd00::1]/', 'http://[fe90::1]/', 'http://[64:ff9b::a9fe:a9fe]/', 'http://[::]/'])
  ok(S.isBlockedUrlSync(u) === true, 'isBlockedUrlSync refuses ' + u);

// ── ARM 2: DNS names answering a private address are refused; a failed lookup is refused ──
for (const h of ['rebind.example', 'mixed.example', 'v6meta.example', 'nat64.example'])
  ok(!(await allowed('https://' + h + '/x')), 'a name resolving to a private address is refused: ' + h + ' -> ' + JSON.stringify(ZONE[h]));
ok(!(await allowed('https://no-such-host.example/')), 'a lookup that FAILS is refused (fail closed), not waved through as a hiccup');
ok(!(await allowed('https://empty.example/')), 'a lookup with no addresses is refused');

// ── ARM 3 (the opposite): public addresses still pass ──
for (const u of ['https://public.example/page', 'http://public6.example/', 'http://93.184.216.34/', 'http://[2606:2800:220:1:248:1893:25c8:1946]/',
                 'http://[2a00:1450:4001:82a::200e]/', 'http://8.8.8.8/', 'http://[64:ff9b::808:808]/', 'http://[2002:808:808::1]/'])
  ok(await allowed(u), 'a public URL still passes: ' + u);
ok(S.isBlockedUrlSync('https://public.example/') === false && S.isBlockedUrlSync('http://[2606:4700::1111]/') === false,
   'isBlockedUrlSync lets public hosts through');

// ── ARM 4: isPrivateIp on the raw forms dns.lookup and callers hand it ──
for (const ip of ['::1', '0:0:0:0:0:0:0:1', '::ffff:10.0.0.1', '0:0:0:0:0:ffff:7f00:1', 'fe80::1%eth0', 'FD12::1', 'fe9a::'])
  ok(S.isPrivateIp(ip) === true, 'isPrivateIp(' + ip + ') is true');
// the opposite edges: the first public address past each blocked range must still pass
for (const ip of ['100.63.255.255', '100.128.0.1', '223.255.255.254', '198.20.0.1', '192.0.1.1', '172.32.0.1'])
  ok(S.isPrivateIp(ip) === false, 'isPrivateIp(' + ip + ') is false (just outside a blocked range)');
for (const ip of ['2606:4700::1111', '1.1.1.1', '::ffff:8.8.8.8'])
  ok(S.isPrivateIp(ip) === false, 'isPrivateIp(' + ip + ') is false');

// ── ARM 5: connect-time safeLookup (closes rebinding when a caller passes it as `lookup`) ──
const lk = (host, opts) => new Promise(res => S.safeLookup(host, opts, (err, a, f) => res({ err, a, f })));
{
  const r1 = await lk('rebind.example', {});
  ok(r1.err && /private/.test(r1.err.message), 'safeLookup refuses a private answer (single form)');
  const r2 = await lk('mixed.example', { all: true });
  ok(r2.err && /private/.test(r2.err.message), 'safeLookup refuses when ANY answer is private ({all:true} form)');
  const r3 = await lk('public.example', {});
  ok(!r3.err && r3.a === '93.184.216.34' && r3.f === 4, 'safeLookup passes a public answer through (single form): ' + JSON.stringify(r3.a));
  const r4 = await lk('public.example', { all: true });
  ok(!r4.err && Array.isArray(r4.a) && r4.a[0].address === '93.184.216.34', 'safeLookup passes a public answer through ({all:true} form)');
  const r5 = await lk('no-such-host.example', {});
  ok(r5.err && r5.err.code === 'ENOTFOUND', 'safeLookup passes a real lookup error through');
}

// ── ARM 6 (round 2): an unresolved host is refused WITH code UNRESOLVED, and only that maps to
// the "we couldn't find that website" sentence; a forbidden address keeps the caller's fallback.
{
  const errOf = async (u) => { try { await S.assertPublicHttpUrl(u); return null; } catch (e) { return e; } };
  const FALLBACK = 'That URL is not allowed.';
  const eNx = await errOf('https://no-such-host.example/');
  const eEmpty = await errOf('https://empty.example/');
  ok(eNx && eNx.code === 'UNRESOLVED', 'a failed lookup is refused with code UNRESOLVED (got ' + (eNx && eNx.code) + ')');
  ok(eEmpty && eEmpty.code === 'UNRESOLVED', 'a lookup with no addresses is refused with code UNRESOLVED (got ' + (eEmpty && eEmpty.code) + ')');
  ok(typeof S.URL_UNRESOLVED_MESSAGE === 'string' && S.URL_UNRESOLVED_MESSAGE.length > 10 &&
     S.urlRefusalMessage(eNx, FALLBACK) === S.URL_UNRESOLVED_MESSAGE,
     'urlRefusalMessage maps UNRESOLVED to the "could not find that website" sentence (got ' + JSON.stringify(S.urlRefusalMessage(eNx, FALLBACK)) + ')');
  const ePriv = await errOf('https://rebind.example/');
  const eLit = await errOf('http://[::1]/');
  ok(ePriv && ePriv.code !== 'UNRESOLVED' && S.urlRefusalMessage(ePriv, FALLBACK) === FALLBACK,
     'a name resolving to a private address is NOT reported as unresolved — it keeps the fallback (got ' + JSON.stringify(ePriv && S.urlRefusalMessage(ePriv, FALLBACK)) + ')');
  ok(eLit && S.urlRefusalMessage(eLit, FALLBACK) === FALLBACK, 'a private IP literal keeps the fallback message too');
  ok(S.urlRefusalMessage(null, FALLBACK) === FALLBACK, 'no error object -> the fallback');
}

clearTimeout(wall);
if (failed) { console.error('\n' + failed + ' failure(s)'); process.exit(1); }
console.log('\nPASS — rv-backend-1: the SSRF guard refuses private IPv4/IPv6 targets (literal, mapped, NAT64, by DNS, and at connect time) and still admits public ones.');
