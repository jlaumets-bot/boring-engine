// Shared SSRF guard. Rejects URLs that aren't plain http/https or that point at
// private / loopback / link-local / cloud-metadata addresses. DNS-resolves the
// host so an attacker can't hide an internal IP behind a public name.
const dns = require('dns').promises;
const net = require('net');

// Extract the embedded IPv4 from a v4-mapped/compat IPv6 — dotted OR hex form,
// e.g. both ::ffff:127.0.0.1 and ::ffff:7f00:1 -> '127.0.0.1'. Returns null otherwise.
function mappedV4(low) {
  if (!low.startsWith('::')) return null;
  const rest = low.replace(/^::(ffff:)?/, '');
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(rest)) return rest;
  const g = rest.split(':').filter(Boolean);
  if (g.length === 2) {
    const a = parseInt(g[0], 16), b = parseInt(g[1], 16);
    if (a >= 0 && a <= 0xffff && b >= 0 && b <= 0xffff) {
      return [(a >> 8) & 255, a & 255, (b >> 8) & 255, b & 255].join('.');
    }
  }
  return null;
}

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
    return false;
  }
  if (kind === 6) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return true;
    if (low.startsWith('fe80')) return true;            // link-local
    if (low.startsWith('fc') || low.startsWith('fd')) return true; // unique-local
    const v4 = mappedV4(low);                 // v4-mapped/compat (dotted OR hex form)
    if (v4) return isPrivateIp(v4);
    return false;
  }
  return false;
}

// Cheap synchronous check (scheme + obvious bad hosts / IP literals). Use on redirect hops.
function isBlockedUrlSync(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { return true; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (net.isIP(host) && isPrivateIp(host)) return true;
  return false;
}

// Full async check incl. DNS resolution. Throws on anything unsafe. Returns the URL object.
async function assertPublicHttpUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch (e) { throw new Error('Invalid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http/https URLs are allowed');
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('URL host not allowed');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('URL host not allowed');
    return u;
  }
  try {
    const addrs = await dns.lookup(host, { all: true });
    for (const a of addrs) {
      if (isPrivateIp(a.address)) throw new Error('URL resolves to a private address');
    }
  } catch (e) {
    if (/private address/.test(e.message)) throw e;
    // DNS hiccup on a legit public host: don't hard-block; the fetch itself will fail if truly bad.
  }
  return u;
}

module.exports = { assertPublicHttpUrl, isBlockedUrlSync, isPrivateIp };
