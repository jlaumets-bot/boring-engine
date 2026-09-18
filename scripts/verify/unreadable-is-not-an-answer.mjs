#!/usr/bin/env node
// GATE: a read we could not make is not an answer, and a write we did not check is not a save.
//
// WHY THIS EXISTS
//   store.rest RESOLVES on every HTTP status — it rejects only on a socket error — so a
//   PostgREST error is a plain object sitting where the data should be. Four shipped defects,
//   each measured against the real code:
//
//   1. THE NIGHTLY CRON WIPED THE POST STRIP. pull-trends-cron.js rebuilt brands.auto_trends
//      from scratch and assigned topPosts UNCONDITIONALLY. _trends.js:502 makes topPosts []
//      whenever the X/Apify lane comes back empty — no APIFY_API_TOKEN, a stalled actor, the
//      bound() race expiring, nothing clearing the engagement filter. The Grok and News lanes
//      still return trends, so the "nothing at all" skip does not fire and the brand is
//      "updated": every post the user was going to repurpose is erased, for every brand, every
//      such night, with nowhere to recover it. The manual button has guarded this since v644b
//      (pull-trends.js:111) and its comment says exactly why. Rebuilding the object also
//      dropped any auto_trends key not re-added by hand.
//   2. A PAYING CUSTOMER COULD NOT CANCEL. _usage.stripeCustomerId collapsed a failed read into
//      null, the same value it returns for "no Stripe customer", with no log line. Its caller
//      turns null into 400 no_subscription — so on any Supabase hiccup the one self-serve route
//      to cancel or fix a failing card answered "you have no subscription". The sibling on the
//      same table states the rule it broke: "callers must treat null as don't know".
//   3. "ADD YOUR GEMINI API KEY FIRST" TO USERS WHOSE KEY WAS STORED. All three key lookups in
//      meme.js read ((r.data || [])[0] || {}).gemini_key_enc, so a PostgREST 5xx asserted "no
//      key": has-key answered 200 {hasKey:false} and the UI re-opened the key form, inviting
//      the user to re-paste a Google API key over a problem that was never theirs.
//   4. A COMPETITOR PULSE REPORTED AS SAVED. pull-trends.js discarded its PATCH result and set
//      competitorMoves on the next line regardless. With Prefer: return=minimal the status is
//      the only evidence a write happened.
//
// HOW IT CHECKS
//   It RUNS the real handlers with node:https stubbed to answer like a broken PostgREST, and
//   reads the real responses. The cron arm executes the real payload-building block lifted from
//   the source by line range, so it cannot drift from a copy. Every arm carries its opposite:
//   a working read must still produce the working answer, or an always-fail fix would pass.
//
// RUN:    node scripts/verify/unreadable-is-not-an-answer.mjs
// EXPECT: prints "PASS" and exits 0.
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

process.env.SUPABASE_URL = 'https://read-gate.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only-not-a-real-key';
process.env.STRIPE_SECRET_KEY = 'test-only-not-a-real-key';

let failed = 0;
const ok = (cond, m) => { if (cond) console.log('ok: ' + m); else { console.error('FAIL: ' + m); failed++; } };

const https = require_('node:https');
const realRequest = https.request;

// Drive the real handlers against a scripted Supabase. answer(path, method) -> {status, body}.
function withSupabase(answer, fn) {
  https.request = (opts, cb) => {
    const req = new EventEmitter();
    req.write = () => {}; req.setTimeout = () => {};
    req.destroy = (e) => req.emit('error', e || new Error('destroyed'));
    req.end = () => setTimeout(() => {
      const a = answer(opts.path, opts.method) || { status: 200, body: '[]' };
      const resp = new EventEmitter();
      resp.statusCode = a.status;
      cb(resp);
      resp.emit('data', a.body == null ? '' : a.body);
      resp.emit('end');
    }, 0);
    return req;
  };
  return Promise.resolve().then(fn).finally(() => { https.request = realRequest; });
}
const mkRes = () => ({
  _code: 200, _body: null,
  setHeader() {}, status(c) { this._code = c; return this; },
  json(b) { this._body = b; return this; }, end() { return this; },
});
const fresh = (rel) => { const p = require_.resolve(path.join(ROOT, rel)); delete require_.cache[p]; return require_(p); };
const PGERR = (status, msg) => ({ status, body: JSON.stringify({ code: '57014', details: null, hint: null, message: msg }) });

// ── 1. the nightly cron must not wipe the post strip ─────────────────────────
// The payload block is LIFTED FROM THE SOURCE by line range and executed, so it is the shipped
// code, not a copy of it.
{
  const src = fs.readFileSync(path.join(ROOT, 'api/pull-trends-cron.js'), 'utf8').split('\n');
  const from = src.findIndex(l => l.includes('const _prevAuto = ') && l.includes('b.auto_trends'));
  // Anchor the END on the close of the _tp map, then take ONE more line — whatever it is.
  // Anchoring on the guard itself would make deleting the guard look like a stale gate rather
  // than the reintroduced wipe it is, and the behaviour arm below would never get to run.
  const tpAt = src.findIndex((l, i) => i > from && l.includes('const _tp = ') && l.includes('items.topPosts'));
  const to   = tpAt > 0 ? src.findIndex((l, i) => i > tpAt && l.trim() === '}));') + 1 : -1;
  ok(from > 0 && to > from,
     'the cron still builds its auto_trends payload in one identifiable block ' +
     '(found ' + from + '..' + to + ') — if this fails the gate is stale, re-anchor it');
  if (from > 0 && to > from) {
    const block = src.slice(from, to + 1).join('\n');
    const run = new Function('b', 'items', 'scored', 'now', block + '\nreturn payload;');
    const prevStrip = [{ text: 'a post worth repurposing', handle: 'someone', link: 'https://x.com/1', likes: 900, reposts: 40, ts: 1 }];
    const brand = { id: 'b1', auto_trends: { at: 1, items: [{ text: 'old' }], topPosts: prevStrip, competitorMoves: 'Rival cut price 15%', compAt: 5, somethingNewer: 'keep me' } };
    const scored = [{ text: 'a trend from the news lane', source: 'news', link: 'https://n/1', ts: 2, hot: true }];

    // the failure that shipped: Grok/News produced trends, the X lane produced no posts
    const quietX = run(brand, Object.assign([1, 2], { topPosts: [], lanes: { grok: 0, news: 2, x: 0 } }), scored, 9);
    ok(Array.isArray(quietX.topPosts) && quietX.topPosts.length === 1,
       'an empty X lane must NOT wipe the "Worth making yours" strip — it kept ' +
       ((quietX.topPosts || []).length) + ' of 1 post. Every brand loses the strip overnight otherwise, ' +
       'with nowhere to recover it from.');
    ok(quietX.somethingNewer === 'keep me',
       'an auto_trends key this cron does not know about survives the write (got ' + JSON.stringify(quietX.somethingNewer) + ')');
    ok(quietX.items.length === 1 && quietX.at === 9, 'the trends it DID pull are still written');

    // the opposite arm: a lane that really did return posts must replace the old ones
    const liveX = run(brand, Object.assign([1], { topPosts: [{ text: 'brand new post', handle: 'h', link: 'https://x.com/2', likes: 1, reposts: 0, ts: 3 }], lanes: { grok: 0, news: 1, x: 1 } }), scored, 9);
    ok(liveX.topPosts.length === 1 && liveX.topPosts[0].text === 'brand new post',
       'a pull that DID find posts still replaces the strip — the guard must not freeze it forever');
  }
}

// ── 2. "we could not read it" is not "you have no subscription" ──────────────
{
  const dead = () => PGERR(503, 'no Route matched with those values');
  await withSupabase(dead, async () => {
    const usage = fresh('api/_usage.js');
    const r = await usage.stripeCustomerId('user-who-pays');
    ok(r && r.unknown === true, 'stripeCustomerId answers {unknown:true} on an unreadable read, not null (got ' + JSON.stringify(r) + ')');
  });
  await withSupabase(() => ({ status: 200, body: '[]' }), async () => {
    const usage = fresh('api/_usage.js');
    const r = await usage.stripeCustomerId('user-with-no-stripe');
    ok(r === null, 'a clean read with no row still answers null — the honest "no customer" (got ' + JSON.stringify(r) + ')');
  });
  await withSupabase(() => ({ status: 200, body: JSON.stringify([{ stripe_customer_id: 'cus_123' }]) }), async () => {
    const usage = fresh('api/_usage.js');
    const r = await usage.stripeCustomerId('user-who-pays');
    ok(r === 'cus_123', 'a real customer id still comes back as a string (got ' + JSON.stringify(r) + ')');
  });
  // and the caller must not turn it into no_subscription
  const portalSrc = fs.readFileSync(path.join(ROOT, 'api/create-portal-session.js'), 'utf8');
  ok(/customerId\s*&&\s*customerId\.unknown/.test(portalSrc) && /503/.test(portalSrc),
     'create-portal-session answers 503 "try again", not 400 no_subscription, when the lookup could not be made — ' +
     'otherwise a customer trying to cancel is told there is nothing to cancel, and keeps being charged');
}

// ── 3. meme.js must not blame the user for a database error ──────────────────
{
  const brandOk = (p) => {
    if (p.includes('/brand_members')) return { status: 200, body: JSON.stringify([{ brand_id: 'b1' }]) };
    if (p.includes('/auth/v1/user')) return { status: 200, body: JSON.stringify({ id: 'u1' }) };
    if (p.includes('/brands') && p.includes('gemini_key_enc')) return PGERR(503, 'canceling statement due to statement timeout');
    if (p.includes('/brands')) return { status: 200, body: JSON.stringify([{ id: 'b1', user_id: 'u1' }]) };
    return { status: 200, body: '[]' };
  };
  await withSupabase(brandOk, async () => {
    const handler = fresh('api/meme.js');
    const res = mkRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer t', origin: 'https://contentshrimp.com' },
                    body: { brandId: 'b1', action: 'has-key' } }, res);
    ok(res._code !== 200 || !res._body || res._body.hasKey !== false,
       "has-key must not answer 200 {hasKey:false} when the row could not be read — the UI's own else-branch " +
       '("Couldn\'t check your key just now — retry") exists for this and never fired. Got ' +
       res._code + ' ' + JSON.stringify(res._body));
  });
  await withSupabase((p) => p.includes('gemini_key_enc')
      ? { status: 200, body: JSON.stringify([{ gemini_key_enc: 'sealed' }]) } : brandOk(p), async () => {
    const handler = fresh('api/meme.js');
    const res = mkRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer t', origin: 'https://contentshrimp.com' },
                    body: { brandId: 'b1', action: 'has-key' } }, res);
    ok(res._code === 200 && res._body && res._body.hasKey === true,
       'a readable row with a stored key still answers {hasKey:true} (got ' + res._code + ' ' + JSON.stringify(res._body) + ')');
  });
  // the generate paths must answer 5xx, so attachHoldRelease gives the reserved credit back
  // Strip comments first: the fix's own comment QUOTES the old pattern, and a name in a
  // comment is not a call site. Whole-line // only, plus /* */ (this is plain JS, not app.html).
  const memeSrc = fs.readFileSync(path.join(ROOT, 'api/meme.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, '');
  const reads = (memeSrc.match(/gemini_key_enc/g) || []).length;
  ok(!/\(\(r\.data \|\| \[\]\)\[0\] \|\| \{\}\)\.gemini_key_enc/.test(memeSrc),
     'no key lookup reads r.data without checking the status (' + reads + ' mentions of the column remain)');
  ok((memeSrc.match(/_k\.unknown\) return res\.status\(503\)/g) || []).length >= 2,
     'both generate paths answer 503 on an unreadable read, so the credit they just reserved is refunded');
}

// ── 4. an unchecked PATCH is not a save ──────────────────────────────────────
{
  const src = fs.readFileSync(path.join(ROOT, 'api/pull-trends.js'), 'utf8');
  const patches = src.match(/await store\.rest\('PATCH'[\s\S]{0,260}/g) || [];
  ok(patches.length >= 2, 'pull-trends.js still has its two auto_trends writes (found ' + patches.length + ')');
  for (const p of patches) {
    const head = p.split('\n').slice(0, 8).join(' ');
    ok(/\.status\s*(<|>=|!==|===)/.test(head),
       'every auto_trends PATCH in pull-trends.js keeps its result and checks the status before ' +
       'anything is reported as saved — with Prefer: return=minimal the status is the only evidence there is. ' +
       'Unchecked: ' + head.slice(0, 120));
  }
  ok(/competitorMoves = digest; compAt = merged\.compAt;\s*\n\s*\} else \{/.test(src) ||
     /if \(_cup && _cup\.status >= 200 && _cup\.status < 300\) \{/.test(src),
     'the competitor pulse is only shown as fresh when its write actually landed');
}

if (failed === 0) console.log('\nPASS — unreadable-is-not-an-answer: a failed read cannot pose as data, and a failed write cannot pose as a save.');
else { console.error('\n' + failed + ' failure(s)'); process.exitCode = 1; }
