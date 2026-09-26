// Shared SSRF guard. Rejects URLs that aren't plain http/https or that point at
// private / loopback / link-local / cloud-metadata addresses. DNS-resolves the
// host so an attacker can't hide an internal IP behind a public name.
const dns = require('dns').promises;
const net = require('net');

/* v690 — EVERY IPv6 LITERAL WENT STRAIGHT THROUGH. WHATWG URL keeps the brackets on an IPv6
   hostname (new URL('http://[::1]/').hostname === '[::1]'), and net.isIP('[::1]') is 0, so an
   IPv6 host was never treated as an IP at all: it fell to dns.lookup('[::1]'), which fails, and
   that failure was swallowed as a "DNS hiccup" — so the URL was ALLOWED. Measured before this
   fix: http://[::1]/, http://[::ffff:127.0.0.1]/, http://[fd00::1]/ (fd00:ec2::254 is the AWS
   IPv6 metadata endpoint) and http://[::]/ all passed assertPublicHttpUrl. The brackets are now
   stripped before any check, and IPv6 is classified from its real 128 bits instead of by string
   prefix — the old prefix test only knew fe80, not the rest of fe80::/10 (fe90::, febf::), and
   missed NAT64 (64:ff9b::/96, which embeds an IPv4 address), 6to4, multicast and the full
   uncompressed spellings (0:0:0:0:0:0:0:1). */
// Parse a valid IPv6 string (brackets and zone already removed) into 8 16-bit words, or null.
function v6Words(ip) {
  let s = String(ip).toLowerCase();
  let tail = [];
  const m = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (m) {
    const p = [m[2], m[3], m[4], m[5]].map(Number);
    if (p.some(n => n > 255)) return null;
    tail = [(p[0] << 8) | p[1], (p[2] << 8) | p[3]];
    s = m[1].endsWith('::') ? m[1] : m[1].slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const grp = (x) => (x ? x.split(':') : []);
  const head = grp(halves[0]);
  const rest = halves.length === 2 ? grp(halves[1]) : null;
  const words = [];
  for (const g of head.concat(rest || [])) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    words.push(parseInt(g, 16));
  }
  const have = words.length + tail.length;
  if (rest === null) return have === 8 ? words.concat(tail) : null;
  if (have > 7) return null;
  const hl = head.length;
  return words.slice(0, hl).concat(new Array(8 - have).fill(0), words.slice(hl), tail);
}
const v4Of = (hi, lo) => [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join('.');

function isPrivateIp(ip) {
  if (!ip) return true;
  ip = String(ip).replace(/^\[|\]$/g, '').split('%')[0];
  const kind = net.isIP(ip);
  if (kind === 4) {
    const p = ip.split('.').map(Number);
    if (p[0] === 0) return true;            // 0.0.0.0/8
    if (p[0] === 10) return true;           // private
    if (p[0] === 127) return true;          // loopback
    if (p[0] === 169 && p[1] === 254) return true; // link-local + cloud metadata
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true; // private
    if (p[0] === 192 && p[1] === 168) return true; // private
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    // v690 — also special-purpose ranges no public page lives on.
    if (p[0] === 192 && p[1] === 0 && p[2] === 0) return true;  // 192.0.0.0/24 IETF protocol assignments
    if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return true; // 198.18.0.0/15 benchmarking
    if (p[0] >= 224) return true;           // multicast, reserved, broadcast
    return false;
  }
  if (kind === 6) {
    const w = v6Words(ip);
    if (!w) return true;                    // valid per net.isIP but unparsed here: fail closed
    const zero = (a, b) => w.slice(a, b).every(x => x === 0);
    if (zero(0, 8)) return true;                                   // ::
    if (zero(0, 7) && w[7] === 1) return true;                     // ::1 loopback
    if (zero(0, 5) && w[5] === 0xffff) return isPrivateIp(v4Of(w[6], w[7]));   // ::ffff:a.b.c.d mapped
    if (zero(0, 4) && w[4] === 0xffff && w[5] === 0) return isPrivateIp(v4Of(w[6], w[7])); // ::ffff:0:a.b.c.d
    if (zero(0, 6)) return isPrivateIp(v4Of(w[6], w[7]));         // ::a.b.c.d compat (deprecated)
    if (w[0] === 0x64 && w[1] === 0xff9b && zero(2, 6)) return isPrivateIp(v4Of(w[6], w[7])); // NAT64 64:ff9b::/96
    if (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 1) return true; // 64:ff9b:1::/48 local NAT64
    if (w[0] === 0x2002) return isPrivateIp(v4Of(w[1], w[2]));     // 6to4 embeds an IPv4
    if (w[0] === 0x2001 && w[1] === 0) return true;                // Teredo (obfuscated IPv4)
    if (w[0] === 0x2001 && w[1] === 0x0db8) return true;           // documentation
    if (w[0] === 0x0100 && zero(1, 4)) return true;                // 100::/64 discard
    if ((w[0] & 0xfe00) === 0xfc00) return true;                   // fc00::/7 unique-local (incl. fd00:ec2::254)
    if ((w[0] & 0xffc0) === 0xfe80) return true;                   // fe80::/10 link-local
    if ((w[0] & 0xffc0) === 0xfec0) return true;                   // fec0::/10 old site-local
    if ((w[0] & 0xff00) === 0xff00) return true;                   // ff00::/8 multicast
    return false;
  }
  return false;
}

// The hostname as the checks must see it: lower-case, IPv6 brackets off, trailing dots off
// ("localhost." is localhost).
function hostOf(u) {
  return u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
}
const namedInternal = (host) => host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal');

// Cheap synchronous check (scheme + obvious bad hosts / IP literals). Use on redirect hops.
function isBlockedUrlSync(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { return true; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
  const host = hostOf(u);
  if (namedInternal(host)) return true;
  if (net.isIP(host) && isPrivateIp(host)) return true;
  return false;
}

// Full async check incl. DNS resolution. Throws on anything unsafe. Returns the URL object.
async function assertPublicHttpUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch (e) { throw new Error('Invalid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http/https URLs are allowed');
  const host = hostOf(u);
  if (namedInternal(host)) throw new Error('URL host not allowed');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('URL host not allowed');
    return u;
  }
  /* v690 — A FAILED LOOKUP IS NOT A PASS. It used to be waved through as a "DNS hiccup" on the
     theory that the fetch would fail too. That is exactly how every bracketed IPv6 literal got
     in (above), and it is also a rebinding door: a hostile name server that fails the FIRST
     lookup and answers 169.254.169.254 to the fetch's own lookup was allowed. We cannot vouch
     for a host we could not resolve, so we refuse it. */
  let addrs;
  // v690 — code UNRESOLVED so callers can tell "no such website / DNS blip" (fix the link, retry)
  // from "that address is forbidden". Both still fail closed; only the message differs.
  const unresolved = () => { const e = new Error('Could not resolve the URL host'); e.code = 'UNRESOLVED'; return e; };
  try { addrs = await dns.lookup(host, { all: true }); }
  catch (e) { throw unresolved(); }
  if (!Array.isArray(addrs) || !addrs.length) throw unresolved();
  for (const a of addrs) {
    if (isPrivateIp(a && a.address)) throw new Error('URL resolves to a private address');
  }
  return u;
}

/* v690 — CONNECT-TIME CHECK, for closing DNS rebinding. assertPublicHttpUrl resolves the name,
   and then the caller's http/https request resolves it AGAIN — a name with a 0-second TTL can
   answer a public address to the first and 169.254.169.254 to the second. Passing this as the
   `lookup` option of http.get / https.request makes the address actually connected to pass the
   same test. Same signature as dns.lookup, including the {all:true} form Node uses when it
   races address families. IP-literal hosts never reach a lookup; assertPublicHttpUrl covers
   those. */
function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  const opts = typeof options === 'number' ? { family: options } : Object.assign({}, options || {});
  const wantAll = !!opts.all;
  require('dns').lookup(hostname, Object.assign({}, opts, { all: true }), (err, addrs) => {
    if (err) return callback(err);
    if (!Array.isArray(addrs) || !addrs.length) {
      const e = new Error('URL host did not resolve'); e.code = 'ENOTFOUND'; return callback(e);
    }
    for (const a of addrs) {
      if (isPrivateIp(a && a.address)) {
        const e = new Error('URL resolves to a private address'); e.code = 'EPRIVATEADDR'; return callback(e);
      }
    }
    if (wantAll) return callback(null, addrs);
    return callback(null, addrs[0].address, addrs[0].family);
  });
}

/* v690 — the user-facing sentence for a refused URL. Every entry point said "That URL is not
   allowed." for everything, so a typo or a DNS blip read as a policy block and nobody retried. */
const URL_UNRESOLVED_MESSAGE = "We couldn't find that website. Check the link and try again.";
function urlRefusalMessage(err, fallback) {
  return (err && err.code === 'UNRESOLVED') ? URL_UNRESOLVED_MESSAGE : fallback;
}

module.exports = { assertPublicHttpUrl, isBlockedUrlSync, isPrivateIp, safeLookup, urlRefusalMessage, URL_UNRESOLVED_MESSAGE };
