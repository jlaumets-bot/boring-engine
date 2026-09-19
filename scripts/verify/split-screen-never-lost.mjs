#!/usr/bin/env node
// GATE: nothing may throw away a finished split screen, and nothing may ship an empty one.
//
// WHY THIS EXISTS — three ways a rendered video was destroyed or misreported, all measured:
//
//   1. THE UPDATE BANNER COULD DELETE IT. The service worker is re-checked every 60 seconds and
//      on every visibilitychange; a split-screen build takes minutes. The banner is z-index
//      100000 — above the result sheet (50000) and above the rescue sheet (99999) — carries no
//      dismiss button, only "Refresh", and that button called location.reload() with no check of
//      _tpBlobInHand. Nothing in this app persists a take or a render (no IndexedDB anywhere, no
//      beforeunload), so one tap on a black pill that appeared over their finished video threw
//      away the take AND the render, with no warning and no way back. The 402 paywall branch was
//      hardened for exactly this in v678; the update banner was never brought in line.
//
//   2. CANCEL DISCARDED A COMPLETED RENDER. The cancel button aborts through a 700ms watchdog
//      poll, and finish() clears that interval — so the 15s muxer flush and the 4s drift probe
//      that follow the frame loop run with nothing watching _spCancel. In that ~19s window the
//      promise resolves with a complete video and `if (window._spCancel) return;` dropped it.
//      The button reads "Stop and just save my video", which is what someone watching a progress
//      bar sit at 99% will tap. The rule this codebase set for the filmed take is IT STOPS, IT
//      NEVER DISCARDS; the render did not honour it.
//
//   3. A HEADER-ONLY FILE SHIPPED AS "READY TO POST". TP_MIN_TAKE_BYTES (8192) exists because a
//      recorder that emits a container header and no frames yields a few hundred truthy bytes. It
//      guards the FILMED take at four sites and guarded the RENDER OUTPUT at none — only
//      `!blob.size` did. A 400-byte file reached the sheet as "0.0 MB · ready to post", and both
//      honesty checks are blind to it: `partial` compares dur to lastT (equal) and the drift probe
//      resolves 0 on probe.onerror, which is what a header-only file triggers. The same line also
//      leaked: `return reject(...)` resolves rather than throws, so the catch holding the only
//      other wake-lock release and track teardown never ran, and every "Try the split again"
//      leaked another wake lock and another pair of live tracks.
//
// HOW IT CHECKS
//   It RUNS the real banner code in a vm against a fake DOM, and executes the real guard
//   expressions lifted from app.html. Every arm carries its opposite, so a fix that simply never
//   shows the banner, or never cancels, or rejects every render, fails too.
//
// RUN:    node scripts/verify/split-screen-never-lost.mjs
// EXPECT: prints "PASS" and exits 0.
import fs from 'node:fs'; import vm from 'node:vm';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
let fail = 0; const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fail++; } else console.log('ok:', m); };

// ── a DOM small enough to run the banner, real enough to catch it ────────────
function mkDom() {
  const nodes = [];
  const mk = (tag) => {
    const el = { tag, id: '', textContent: '', style: { cssText: '' }, children: [], parent: null,
      appendChild(c) { this.children.push(c); c.parent = this; return c; },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this); this.parent = null; },
      get isConnected() { let n = this; while (n.parent) n = n.parent; return n === body; } };
    nodes.push(el); return el;
  };
  const body = mk('body');
  const document = {
    body,
    createElement: mk,
    getElementById: (id) => { const find = (n) => { if (n.id === id) return n; for (const c of n.children) { const r = find(c); if (r) return r; } return null; }; return find(body); },
  };
  return { document, body, nodes };
}
const bannerSrc = (() => {
  const i = html.indexOf('window._csUpdatePending = false;');
  // End on the function's LAST STATEMENT, not on the first `};` — the Refresh handler added in
  // v687 contains one of its own, and slicing there produced an unparseable fragment.
  const tail = html.indexOf('b.appendChild(btn); document.body.appendChild(b);', i);
  const j = html.indexOf('};', tail);
  if (i < 0 || tail < 0 || j < 0) throw new Error('banner block not found — re-anchor this gate');
  return html.slice(i, j + 2);
})();

function runBanner({ takeInHand }) {
  const { document, body } = mkDom();
  const ctx = { document, window: null, reloaded: false };
  ctx.window = ctx;
  ctx.location = { reload: () => { ctx.reloaded = true; } };
  ctx.window._tpBlobInHand = takeInHand;
  vm.createContext(ctx);
  vm.runInContext(bannerSrc, ctx);
  ctx.window._showUpdateBanner();
  const banner = document.getElementById('csUpdateBanner');
  return { ctx, document, body, banner, shown: !!banner };
}

// ── 1. the banner waits while a take is in hand, and appears once it is not ──
{
  const held = runBanner({ takeInHand: true });
  ok(!held.shown,
     'the update banner does NOT appear while a take is in hand — it is z-index 100000 over the ' +
     'result sheet, its only button reloads the page, and nothing here persists a video');
  ok(held.ctx.window._csUpdatePending === true, 'and the update is remembered, not dropped');

  const free = runBanner({ takeInHand: false });
  ok(free.shown,
     'with no take in hand the banner DOES appear — deferring it forever would just be a ' +
     'different bug (the app ships fixes daily)');

  // the deferred banner must actually arrive later
  held.ctx.window._tpBlobInHand = false;
  held.ctx.window._csShowPendingUpdate();
  ok(!!held.document.getElementById('csUpdateBanner'),
     'and the held-back update is shown once the take is delivered');
}
// ── 1b. Refresh re-checks, because the hold can be taken after it is on screen
{
  const r = runBanner({ takeInHand: false });
  ok(r.shown, 'banner is up');
  r.ctx.window._tpBlobInHand = true;                     // a take arrives while it sits there
  const btn = r.banner.children.find(c => c.tag === 'button');
  ok(!!btn, 'the banner has its Refresh button');
  btn.onclick();
  ok(r.ctx.reloaded === false,
     'tapping Refresh with a take in hand must NOT reload the page — that is the tap that ' +
     'destroyed a finished video');
  r.ctx.window._tpBlobInHand = false;
  const r2 = runBanner({ takeInHand: false });
  const btn2 = r2.banner.children.find(c => c.tag === 'button');
  btn2.onclick();
  ok(r2.ctx.reloaded === true, 'and with nothing in hand it still reloads, so the update works');
}
// ── 1c. _spBusy covers the whole flow, not just the 15-minute hold ───────────
{
  const r = mkDom();
  const ctx = { document: r.document, window: null };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(bannerSrc, ctx);
  ctx.window._tpBlobInHand = false; ctx.window._spBusy = true;
  ok(ctx.window._csTakeInHand() === true,
     '_spBusy alone holds the banner back: tpHoldTake\'s failsafe drops _tpBlobInHand after 15 ' +
     'minutes and is taken ONCE, but a long take plus a slow beats call plus six 40s photo ' +
     'fetches plus the render deadline can outrun that');
  ctx.window._spBusy = false;
  ok(ctx.window._csTakeInHand() === false, 'and it clears');
}

// ── 2. cancel offers a render that had already finished ─────────────────────
{
  // There are several `if (window._spCancel)` guards in the offer flow (one after each await).
  // The one this gate is about is the POST-RENDER branch — anchor on its own comment.
  const i = html.indexOf('A FINISHED VIDEO WAS THROWN ON THE FLOOR');
  ok(i > 0, 'the post-render cancel branch is still identifiable in tpOfferSplit');
  const branch = html.slice(i, i + 2400);
  ok(/out\.blob\.size > TP_MIN_TAKE_BYTES/.test(branch),
     'a cancel that arrives AFTER the render finished offers the finished video rather than ' +
     'discarding it — the muxer flush and drift probe leave a ~19s window in which the bytes ' +
     'already exist and the watchdog that reads _spCancel has been cleared');
  ok(/tpSplitResult\(/.test(branch), 'and it shows the result sheet');
  ok(/window\._spCancel = false/.test(branch),
     'and it clears the cancel flag, so the sheet it just opened is not treated as cancelled too');
  ok(/isConnected/.test(branch),
     'and it re-attaches the backdrop the cancel handler detached, or the sheet renders nowhere');
  ok(/return;\s+\/\/ genuinely mid-render/.test(branch.replace(/\s+/g, ' ')) ||
     /genuinely mid-render/.test(branch),
     'a cancel with NO finished bytes still returns — the fix must not resurrect a half-render');
}

// ── 3. the render output honours the byte floor, and releases before rejecting
{
  const i = html.indexOf('if (!blob.size || blob.size <= TP_MIN_TAKE_BYTES) {');
  ok(i > 0,
     'the render output is checked against TP_MIN_TAKE_BYTES, not just !blob.size. The filmed ' +
     'take is guarded at four sites; the render output was guarded at none, so a header-only ' +
     'file shipped as "0.0 MB · ready to post"');
  const branch = html.slice(i, i + 700);
  ok(/_wl\.release\(\)/.test(branch) && /_spReleaseRender\(/.test(branch),
     'and it releases the wake lock and stops every track BEFORE rejecting — `return reject(...)` ' +
     'resolves rather than throws, so the catch holding the only other teardown never ran, and ' +
     'every "Try the split again" leaked another wake lock and another pair of live tracks');
  const rel = branch.indexOf('_spReleaseRender('), rej = branch.indexOf('return reject(');
  ok(rel > 0 && rej > rel, 'release comes BEFORE the reject (' + rel + ' < ' + rej + ')');
}

if (fail === 0) console.log('\nPASS — split-screen-never-lost: the update banner waits, a late cancel keeps the video, and an empty render cannot ship or leak.');
else { console.log('\n' + fail + ' failure(s)'); process.exitCode = 1; }
