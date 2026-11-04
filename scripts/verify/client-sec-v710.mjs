#!/usr/bin/env node
// GATE (v710, client security + error words). EXECUTED: the real code is lifted from app.html /
// api/crawl-brand.js and run in node:vm on a small fake DOM. No network, no AI calls.
//   1  Settings → Team: the panel's real template is rendered with a hostile member email, invite email,
//      invite code and ids. No tag or event attribute may break out of the text, and every onclick, once
//      entity-decoded the way a browser does, must call ONLY its own function with the exact hostile
//      string as the argument (alert never runs). Owner and member views both.
//   2  ?invite= no longer joins on load: initApp's invite block shows an in-app dialog (no window.confirm)
//      and does NOT call handleInviteCode until Join is pressed. Cancel calls nothing and removes only
//      `invite` from the URL. The brand name in the dialog is escaped; with no name it says
//      "a brand you were invited to" (lookup error / timeout only). Esc/X (inviteJoinCancel, CSX_DIALOGS) = Cancel.
//      A lookup that ANSWERS with no row (expired/used/wrong code): no dialog, nothing redeemed, invite=
//      stripped, a toast says the link expired or was used, startup continues.
//   3  onboarding summary (obBuildSummary) and obBuildDayGrid escape crawl-derived text.
//   4  humanErr('limit_reached') / ('rate_limited') are mapped plain words; humanErrFrame keeps a
//      sentence reason, swaps a known code for words and never shows an unknown code; the listed
//      screens route API errors through them.
//   5  api/crawl-brand.js's last catch logs the internal error and returns a plain sentence + code.
// RUN: node scripts/verify/client-sec-v710.mjs      EXPECT: prints "CLIENT SEC V710 OK", exit 0.
import fs from 'node:fs'; import vm from 'node:vm';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const crawlSrc = fs.readFileSync(path.join(ROOT, 'api', 'crawl-brand.js'), 'utf8');
setTimeout(() => { console.log('FAIL: wall clock (60s) exceeded'); process.exit(2); }, 60000).unref();
let finished = false; process.on('exit', (code) => { if (!finished && code === 0) { console.log('FAIL: the gate ended before all checks ran'); process.exitCode = 1; } });
let fail = 0; const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fail++; } else console.log('ok:', m); };
const grab = n => {
  let i = html.indexOf('\nfunction ' + n + '('); if (i < 0) i = html.indexOf('\nasync function ' + n + '(');
  if (i < 0) throw new Error('no ' + n + ' in app.html');
  const eol = html.indexOf('\n', i + 1), first = html.slice(i + 1, eol);
  let d = 0, seen = false; for (const ch of first) { if (ch === '{') { d++; seen = true; } else if (ch === '}') d--; }
  if (seen && d === 0) return first;
  return html.slice(i + 1, html.indexOf('\n}', i) + 2);
};
const tick = () => new Promise(r => setImmediate(r));
const uSetTimeout = (f, ms) => { const t = setTimeout(f, ms); if (t && t.unref) t.unref(); return t; };

// ── a tiny tag tokenizer: what a browser would treat as TAGS and ATTRIBUTES (text is skipped) ──
function tags(s) {
  const out = []; let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i); if (lt < 0) break;
    if (s.startsWith('<!--', lt)) { const e = s.indexOf('-->', lt); i = e < 0 ? s.length : e + 3; continue; }
    const m = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(s.slice(lt)); if (!m) { i = lt + 1; continue; }
    let j = lt + m[0].length; const attrs = [];
    while (j < s.length) {
      while (j < s.length && /[\s/]/.test(s[j])) j++;
      if (s[j] === '>') { j++; break; }
      const an = /^[^\s"'>/=]+/.exec(s.slice(j)); if (!an) { j++; continue; }
      j += an[0].length; let val = '';
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === '=') {
        j++; while (j < s.length && /\s/.test(s[j])) j++;
        const q = s[j];
        if (q === '"' || q === "'") { const e = s.indexOf(q, j + 1); val = s.slice(j + 1, e < 0 ? s.length : e); j = e < 0 ? s.length : e + 1; }
        else { const v = /^[^\s>]*/.exec(s.slice(j))[0]; val = v; j += v.length; }
      }
      attrs.push([an[0].toLowerCase(), val]);
    }
    out.push({ name: m[1].toLowerCase(), close: m[0][1] === '/', attrs }); i = j;
  }
  return out;
}
const decode = v => v.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/gi, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const helpers = ['escHtml', 'escJs', 'escAttr'].map(grab).join('\n');

// ═════════ 1. Team panel ═════════
{
  const a = html.indexOf(`<div class="sp-section-header" onclick="toggleSection('team')">`);
  const b = html.indexOf("${(function(){\n        if (window.matchMedia('(display-mode: standalone)')", a);
  ok(a > 0 && b > a, 'team panel template located in renderSettingsPanel');
  const tpl = html.slice(a, b);
  const EMAIL = `"><img src=x onerror=alert(1)>`;
  const CODE = `');alert(1);('`;
  const CODE2 = `x" onmouseover="alert(2)" y="</script><script>alert(3)</script>`;
  const ID = `1');alert(4);//`;
  const renderWith = (owner, harmless) => {
    const H = v => harmless ? String(v).replace(/[^A-Za-z0-9]/g, 'z') : v;
    const ctx = {
      sec: { team: true },
      currentUser: { id: 'me', email: H('me' + EMAIL) },
      currentBrand: { user_id: owner ? 'me' : 'boss' },
      teamMembers: [{ id: H(ID), user_id: 'u2', user_email: H(EMAIL), joined_at: '2026-01-02' }, { id: H('x' + CODE), user_id: 'u3', user_email: H('<svg/onload=alert(5)>') }],
      teamInvites: [{ id: H(ID), email: H(EMAIL), invite_code: H(CODE) }, { id: H(CODE2), email: null, invite_code: H(CODE2) }]
    };
    vm.createContext(ctx);
    vm.runInContext(helpers, ctx);
    return vm.runInContext('`' + tpl + '`', ctx);
  };
  const render = owner => renderWith(owner, false);
  for (const owner of [true, false]) {
    const who = owner ? 'owner view' : 'member view';
    let out = '';
    try { out = render(owner); } catch (e) { ok(false, who + ': template renders (' + e.message + ')'); continue; }
    const t = tags(out);
    // the same tags, in the same order, as a render with harmless data: nothing was added by the data
    const shape = x => x.map(y => (y.close ? '/' : '') + y.name).join(' ');
    const base = tags(renderWith(owner, true));
    ok(shape(t) === shape(base), who + ': the hostile data adds no tag (same tag sequence as a harmless render)');
    const bad = t.filter(x => ['img', 'script', 'iframe'].includes(x.name) || (x.name === 'svg' && x.attrs.some(([k]) => /^on/.test(k))));
    ok(bad.length === 0, who + ': no injected <img>/<svg onload>/<script> tag (' + bad.map(x => x.name).join(',') + ')');
    const handlers = []; t.forEach(x => x.attrs.forEach(([k, v]) => { if (/^on/.test(k)) handlers.push([k, v]); }));
    const strange = handlers.filter(([k]) => k !== 'onclick' && k !== 'onkeydown');
    ok(strange.length === 0, who + ': no event attribute other than the panel\'s own onclick/onkeydown (' + strange.map(h => h[0]).join(',') + ')');
    ok(out.includes('&lt;img src=x onerror=alert(1)&gt;'), who + ': the hostile email is shown as text');
    ok(out.includes('&lt;svg/onload=alert(5)&gt;'), who + ': the hostile member email is shown as text');
    const calls = []; let alerts = 0;
    const sandbox = {
      copyInviteLink: (...a) => calls.push(['copyInviteLink', ...a]), revokeInvite: (...a) => calls.push(['revokeInvite', ...a]),
      removeMember: (...a) => calls.push(['removeMember', ...a]), alert: () => { alerts++; },
      event: { key: 'x', preventDefault() {} }, inviteByEmail() {}, generateInviteLink() {}, toggleSection() {}
    };
    vm.createContext(sandbox);
    let syntaxBad = 0;
    for (const [k, v] of handlers) {
      if (k !== 'onclick') continue;
      try { vm.runInContext(decode(v), sandbox); } catch (e) { syntaxBad++; }
    }
    ok(syntaxBad === 0, who + ': every onclick is valid JavaScript after entity decoding (' + syntaxBad + ' broken)');
    ok(alerts === 0, who + ': no injected code ran from any onclick (alert ran ' + alerts + 'x)');
    const copies = calls.filter(c => c[0] === 'copyInviteLink').map(c => c[1]);
    ok(copies.length === 2 && copies[0] === CODE && copies[1] === CODE2, who + ': Copy passes the exact invite codes (' + JSON.stringify(copies) + ')');
    if (owner) {
      const rev = calls.filter(c => c[0] === 'revokeInvite').map(c => c[1]);
      ok(rev.length === 2 && rev[0] === ID && rev[1] === CODE2, 'owner view: revoke passes the exact invite ids');
      const rm = calls.filter(c => c[0] === 'removeMember').map(c => c[1]);
      ok(rm.length === 2 && rm[0] === ID && rm[1] === 'x' + CODE, 'owner view: remove passes the exact member ids');
    } else {
      ok(!calls.some(c => c[0] !== 'copyInviteLink'), 'member view: no revoke/remove buttons');
    }
  }
  const cil = grab('copyInviteLink');
  ok(/encodeURIComponent\(/.test(cil), 'copyInviteLink URL-encodes the code it puts in the link');
}

// ═════════ 2. Invite link asks before joining ═════════
{
  const ia = grab('inviteJoinAsk'), ic = grab('inviteJoinCancel');
  ok(!/\bconfirm\s*\(/.test(ia) && !/\balert\s*\(/.test(ia), 'inviteJoinAsk uses no browser dialog');
  const i0 = html.indexOf('\nasync function initApp(');
  const a = html.indexOf('const urlParams = new URLSearchParams(window.location.search);', i0);
  const b = html.indexOf('// Load brand', a);
  ok(i0 > 0 && a > i0 && b > a && b - a < 4000, 'initApp invite block located');
  const block = html.slice(a, b);
  const makeDoc = () => {
    const body = { kids: [], appendChild(el) { this.kids.push(el); } };
    return { body, createElement(tag) { const el = { tag, id: '', className: '', innerHTML: '', listeners: {}, addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }, remove() { const i = body.kids.indexOf(this); if (i >= 0) body.kids.splice(i, 1); this.removed = true; } }; return el; },
      getElementById(id) { return body.kids.find(k => k.id === id) || null; } };
  };
  async function scenario({ search, rpc, answer }) {
    const redeemed = [], replaced = [], toasts = [];
    const ctx = {
      URL, URLSearchParams, setTimeout: uSetTimeout, console,
      location: { search, href: 'https://contentshrimp.com/app.html' + search, pathname: '/app.html', hash: '' },
      history: { state: null, replaceState: (s, t, u) => replaced.push(u) },
      document: makeDoc(), sb: { rpc }, dismissCsSplash() {}, debugLog() {}, showToast: (m) => toasts.push(m),
      handleInviteCode: async (c) => { redeemed.push(c); return { ok: true, message: 'joined' }; }
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(helpers + '\n' + ia + '\n' + ic, ctx);
    let settled = false;
    const p = vm.runInContext('(async () => {\n' + block + '\n})()', ctx).then(() => { settled = true; });
    for (let k = 0; k < 6; k++) await tick();
    const dlg = ctx.document.getElementById('invJoinBackdrop');
    const before = { redeemed: redeemed.length, settled, dlg: !!dlg, inner: dlg ? dlg.innerHTML : '' };
    if (answer === 'esc') vm.runInContext('inviteJoinCancel()', ctx);
    else if (dlg && answer) {
      const btn = tags(dlg.innerHTML).find(x => x.attrs.some(([k, v]) => k === 'data-inv-answer' && v === answer));
      const f = (dlg.listeners.click || [])[0];
      if (btn && f) f({ target: { closest: () => ({ getAttribute: () => answer }) } });
    }
    await Promise.race([p, new Promise(r => setTimeout(r, 2000))]);
    await new Promise(r => setTimeout(r, 1700));   // the deferred toasts fire at 1.5 s
    return { before, redeemed, replaced, toasts, settled, dlgAfter: ctx.document.getElementById('invJoinBackdrop') };
  }
  const NAME = '<svg/onload=alert(1)>Acme';
  const okRpc = async () => ({ data: [{ brand_name: NAME }] });
  const j = await scenario({ search: '?invite=abc123&open=ideas', rpc: okRpc, answer: 'join' });
  ok(j.before.dlg, 'invite link: a join dialog is shown');
  ok(j.before.redeemed === 0 && !j.before.settled, 'invite link: nothing is redeemed before the user answers');
  ok(tags(j.before.inner).every(x => x.name !== 'svg'), 'join dialog: the brand name cannot inject a tag');
  ok(j.before.inner.includes('Join &lt;svg/onload=alert(1)&gt;Acme as a team member?'), 'join dialog: names the brand, escaped');
  ok(j.before.inner.includes('The owner will see your email.'), 'join dialog: says the owner will see the email');
  ok(j.redeemed.length === 1 && j.redeemed[0] === 'abc123', 'Join: runs the existing redeem path once with the code');
  ok(j.settled && !j.dlgAfter, 'Join: the dialog closes and init continues');
  const c = await scenario({ search: '?invite=abc123&open=ideas', rpc: okRpc, answer: 'cancel' });
  ok(c.redeemed.length === 0, 'Cancel: nothing is redeemed');
  ok(c.replaced.length === 1 && c.replaced[0] === '/app.html?open=ideas', 'Cancel: only invite= leaves the URL (' + JSON.stringify(c.replaced) + ')');
  ok(c.settled && !c.dlgAfter, 'Cancel: the dialog closes and init continues');
  const e = await scenario({ search: '?invite=abc123', rpc: okRpc, answer: 'esc' });
  ok(e.redeemed.length === 0 && e.settled, 'Esc / X (inviteJoinCancel): same as Cancel');
  const f = await scenario({ search: '?invite=abc123', rpc: async () => { throw new Error('offline'); }, answer: null });
  ok(f.before.dlg && f.before.inner.includes('Join a brand you were invited to as a team member?'), 'no brand name available: "a brand you were invited to"');
  ok(f.before.redeemed === 0, 'no brand name available: still not redeemed without an answer');
  const DEAD = 'This invite link has expired or was already used. Ask the brand owner for a new one.';
  for (const [label, rpc] of [['empty list', async () => ({ data: [], error: null })], ['null', async () => ({ data: null, error: null })]]) {
    const d = await scenario({ search: '?invite=dead1&open=ideas', rpc, answer: null });
    ok(!d.before.dlg, 'dead invite (' + label + '): no join dialog');
    ok(d.redeemed.length === 0, 'dead invite (' + label + '): nothing redeemed');
    ok(d.replaced.length === 1 && d.replaced[0] === '/app.html?open=ideas', 'dead invite (' + label + '): invite= stripped from the URL');
    ok(d.toasts.includes(DEAD), 'dead invite (' + label + '): says the link expired or was used');
    ok(d.settled, 'dead invite (' + label + '): startup continues');
  }
  const er = await scenario({ search: '?invite=abc123', rpc: async () => ({ data: null, error: { message: 'boom' } }), answer: null });
  ok(er.before.dlg && er.before.inner.includes('Join a brand you were invited to as a team member?') && !er.toasts.includes(DEAD), 'lookup ERROR (not an empty answer): still asks, with the fallback wording');
  ok(!j.toasts.includes(DEAD) && !c.toasts.includes(DEAD), 'a live invite never shows the expired message');
  const n = await scenario({ search: '', rpc: okRpc, answer: null });
  ok(!n.before.dlg && n.redeemed.length === 0 && n.settled, 'no invite in the URL: no dialog, nothing redeemed');
  ok(/\{ k: 'invite-join', root: '#invJoinBackdrop',[^\n]*close: 'inviteJoinCancel' \}/.test(html), 'desktop dialog table adopts the join dialog; its close = Cancel');
}

// ═════════ 3. Onboarding summary escapes crawl text ═════════
{
  const fns = grab('obBuildSummary') + '\n' + grab('obBuildDayGrid');
  const els = {
    obBrandName: { value: '<svg/onload=alert(1)>' }, obAudience: { value: '<img src=x onerror=alert(2)>' + 'a'.repeat(10) },
    obSummary: { innerHTML: '' }, obDayGrid: { innerHTML: '' }
  };
  const ctx = { document: { getElementById: id => els[id] || null }, obSelectedTones: ['<b onclick=alert(3)>Bold</b>'], obCommunities: ['"><img src=x onerror=alert(4)>', 'Plain'] };
  vm.createContext(ctx); vm.runInContext(helpers + '\n' + fns, ctx);
  vm.runInContext('obBuildSummary(); obBuildDayGrid();', ctx);
  const s = els.obSummary.innerHTML, st = tags(s);
  ok(!st.some(x => ['svg', 'img', 'b'].includes(x.name)) && !st.some(x => x.attrs.some(([k]) => /^on/.test(k))), 'obBuildSummary: no tag or handler from the brand name / audience / tones');
  ok(s.includes('&lt;svg/onload=alert(1)&gt;') && s.includes('&lt;img src=x onerror=alert(2)&gt;'), 'obBuildSummary: the crawl text is shown as text');
  const g = tags(els.obDayGrid.innerHTML);
  ok(!g.some(x => x.name === 'img') && !g.some(x => x.attrs.some(([k]) => /^on/.test(k))), 'obBuildDayGrid: topics cannot inject a tag');
}

// ═════════ 4. humanErr ═════════
{
  const ctx = {}; vm.createContext(ctx); vm.runInContext(grab('humanErr') + '\n' + grab('humanErrFrame'), ctx);
  const he = (...a) => ctx.humanErr(...a), hf = (...a) => ctx.humanErrFrame(...a);
  const lr = he('limit_reached'), unk = he('some_unknown_code');
  ok(/\s/.test(lr) && !/_/.test(lr) && lr !== unk, "humanErr('limit_reached') is its own plain words: " + lr);
  ok(he(new Error('limit_reached')) === lr, 'humanErr reads an Error too');
  const rl = he('rate_limited'); ok(/\s/.test(rl) && !/_/.test(rl) && rl !== unk, "humanErr('rate_limited') is plain words");
  ok(he('The site took too long.') === 'The site took too long.', 'humanErr keeps a sentence');
  ok(hf('limit_reached', "Couldn't rewrite") === lr, 'humanErrFrame: a known code becomes its words');
  ok(hf(new Error('Server is busy'), "Couldn't rewrite") === "Couldn't rewrite (Server is busy). Try again.", 'humanErrFrame: a sentence keeps the old frame');
  const u = hf('weird_code', "Couldn't rewrite"); ok(!/weird_code/.test(u) && /Couldn't rewrite/.test(u), 'humanErrFrame: an unknown code never shows');
  // the sinks H-client listed + siblings: raw err text must go through humanErr / humanErrFrame
  const tv = grab('generateTodayTabPost');
  ok(/humanErr\(err && err\.message, 'Couldn\\u2019t write the post'\)/.test(tv) && !/: \(err\.message \|\| 'Couldn/.test(tv), 'Quick Post failure line goes through humanErr (was "limit_reached" raw)');
  ok(!/Couldn't rewrite \(" \+ e\.message|Couldn't generate a twist \(" \+ e\.message|Couldn't rewrite \(\$\{escHtml\(e\.message\)\}\)|Couldn't generate a twist \(\$\{escHtml\(e\.message\)\}\)/.test(html), 'viral twist / rewrite errors no longer print e.message raw');
  ok((html.match(/humanErrFrame\(e, "Couldn't (rewrite|generate a twist)"\)/g) || []).length === 4, 'all four twist/rewrite error lines use humanErrFrame');
  ok(/showToast\(humanErr\(data && data\.error, "Couldn't sharpen/.test(html) && /showToast\(humanErr\(d && d\.error, 'Could not open checkout/.test(html) && /showToast\(humanErr\(r\.data\.error, 'Could not remove that fact\.'\)\)/.test(html), 'sharpen / checkout / fact-remove toasts go through humanErr');
}

// ═════════ 5. crawl-brand: no raw internal error to the client ═════════
{
  const end = crawlSrc.indexOf('\n};\n');
  const i = crawlSrc.lastIndexOf('} catch (err) {', end);
  const close = crawlSrc.lastIndexOf('}', end);
  ok(end > 0 && i > 0 && close > i, 'crawl-brand handler catch located');
  const body = crawlSrc.slice(i + '} catch (err) {'.length, close);
  const logged = []; let sent = null, code = 0;
  const res = { status(c) { code = c; return this; }, json(o) { sent = o; return this; } };
  const fakeConsole = { error: (...a) => logged.push(a.map(x => (x && x.stack) || String(x)).join(' ')), log() {}, warn() {} };
  const secret = 'Supabase timeout: GET /rest/v1/brands?id=eq.1234 (store.js:76)';
  try { new Function('err', 'res', 'aiUnavailable', 'console', body)(new Error(secret), res, () => null, fakeConsole); } catch (e) { ok(false, 'catch block runs: ' + e.message); }
  ok(code === 500 && sent && typeof sent.error === 'string', 'crawl-brand catch answers 500 with an error sentence');
  ok(sent && !sent.error.includes('rest/v1') && !sent.error.includes(secret) && /\s/.test(sent.error), 'crawl-brand: the internal message is not sent to the client');
  ok(sent && sent.code === 'crawl_failed', 'crawl-brand: a stable code is sent');
  ok(logged.some(l => l.includes(secret)), 'crawl-brand: the internal message is logged server-side');
  ok(!/json\(\{[^}]*error:\s*(err|e)\.message/.test(crawlSrc), 'crawl-brand: no res.json({ error: err.message }) anywhere');
}

finished = true;
if (fail) { console.log(`\nCLIENT SEC V710 FAILED (${fail})`); process.exit(1); }
console.log('\nCLIENT SEC V710 OK');
