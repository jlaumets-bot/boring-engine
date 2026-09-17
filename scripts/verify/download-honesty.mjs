#!/usr/bin/env node
// GATE: a download button never claims to have saved a file it did not save, and never dies
//       silently.
//
// WHY THIS EXISTS
//   `canvas.toBlob` hands back NULL when the browser cannot encode the canvas. On a phone that is
//   the ordinary low-memory case, not an exotic one. Three buttons — stmtDownload, staticDownload
//   and the carousel's Download All — each rolled their own save and each got the same three
//   things wrong:
//     1. No null check. `URL.createObjectURL(null)` THROWS, so the handler rejected before its
//        toast: no file, no message, nothing. The button just looked dead, which is the hardest
//        kind of failure for a person to report ("I pressed it and nothing happened").
//     2. The <a> was never added to the document. Firefox ignores a click on a detached anchor.
//     3. `URL.revokeObjectURL` ran on the very next line, which can cancel a download that has
//        not started.
//   memeDownload already had all three right. The fix is that code, shared.
//
//   NOTE ON WHAT THIS GATE DOES NOT PIN. Deleting the explicit `if (!blob)` check does NOT fail
//   here, and that is correct rather than an escape: `URL.createObjectURL(null)` throws, the inner
//   try/catch turns that into an honest message, and the button still behaves. The explicit check
//   only buys a more accurate sentence ("couldn't build the image file" vs "couldn't save it").
//   What IS pinned is the behaviour: never silent, never a false "Downloaded!", never a success
//   report without a blob.
//
// HOW IT CHECKS
//   The real canvasDownloadPng, stmtDownload and staticDownload are pulled out of app.html and RUN
//   against a fake canvas and DOM — once where toBlob succeeds, once where it returns null, and
//   once where it throws. A source scan would not have caught any of this.
//
// RUN:    node scripts/verify/download-honesty.mjs
// EXPECT: prints "PASS" and exits 0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const fails = [];
const bad = m => fails.push(m);
const fn = n => { const s = html.indexOf('function ' + n + '('); if (s < 0) throw new Error(n + ' missing from app.html');
  const from = html.slice(Math.max(0, s - 6), s) === 'async ' ? s - 6 : s;
  return html.slice(from, html.indexOf('\n}', s) + 2); };

// ── a fake browser just real enough for these three functions ──────────────────────────────
function world(blobMode) {
  const toasts = [];
  const clicked = [];
  const revoked = [];
  let attached = 0;
  const canvas = {
    toBlob(cb) {
      if (blobMode === 'throw') throw new Error('canvas is tainted');
      setTimeout(() => cb(blobMode === 'null' ? null : { size: 10, type: 'image/png' }), 0);
    },
  };
  const env = {
    document: {
      getElementById: () => canvas,
      createElement: () => ({
        set href(v) {}, set download(v) {},
        click() { clicked.push(this._n || 'file'); },
        remove() { attached--; },
      }),
      body: { appendChild() { attached++; } },
      querySelector: () => null,
    },
    URL: {
      createObjectURL: (b) => { if (!b) throw new TypeError('Failed to execute createObjectURL'); return 'blob:x'; },
      revokeObjectURL: (u) => revoked.push(u),
    },
    showToast: (m) => toasts.push(String(m)),
    setTimeout,
  };
  const keys = Object.keys(env);
  const api = new Function(...keys,
    fn('canvasDownloadPng') + '\n' + fn('stmtDownload') + '\n' + fn('staticDownload') +
    '\nreturn { canvasDownloadPng, stmtDownload, staticDownload };')(...keys.map(k => env[k]));
  return { api, toasts, clicked, revoked, attachedNow: () => attached };
}

const said = w => w.toasts.join(' | ');

// ── 1. the happy path still works, and says so ─────────────────────────────────────────────
for (const name of ['stmtDownload', 'staticDownload']) {
  const w = world('ok');
  await w.api[name](1);
  await new Promise(r => setTimeout(r, 5));
  if (!w.clicked.length) bad(`${name} no longer hands a file to the browser on the happy path.`);
  if (!/Downloaded/.test(said(w))) bad(`${name} saved a file but never confirmed it: ${JSON.stringify(said(w))}`);
}

// ── 2. toBlob returns null: no false claim, and the person is TOLD ─────────────────────────
for (const name of ['stmtDownload', 'staticDownload']) {
  for (const mode of ['null', 'throw']) {
    const w = world(mode);
    let threw = null;
    try { await w.api[name](1); await new Promise(r => setTimeout(r, 5)); } catch (e) { threw = e; }
    if (threw) bad(`${name} THROWS when the canvas cannot be encoded (${mode}): ${threw.message}. ` +
                   'The handler dies before its own toast, so the button looks dead.');
    if (w.clicked.length) bad(`${name} claims to have handed over a file when there was no blob (${mode}).`);
    if (/Downloaded/.test(said(w))) {
      bad(`${name} says "Downloaded!" when nothing was saved (${mode}): ${JSON.stringify(said(w))}`);
    }
    if (!said(w).trim()) {
      bad(`${name} fails in total silence when the canvas cannot be encoded (${mode}) — the person ` +
          'presses the button and nothing at all happens.');
    }
  }
}

// ── 3. the mechanics the three buttons each got wrong ──────────────────────────────────────
{
  const w = world('ok');
  const ok = await w.api.canvasDownloadPng({ toBlob: (cb) => setTimeout(() => cb({ size: 1 }), 0) }, 'x.png');
  await new Promise(r => setTimeout(r, 5));
  if (ok !== true) bad('canvasDownloadPng does not report success on a good blob.');
  if (w.attachedNow() !== 0) bad('canvasDownloadPng leaves its <a> attached to the document.');
  if (w.revoked.length) bad('canvasDownloadPng revokes the object URL immediately, which can cancel the download ' +
                            'before it starts. It must be deferred.');
  await new Promise(r => setTimeout(r, 2100));
  if (!w.revoked.length) bad('canvasDownloadPng never revokes the object URL, so the blob leaks for the tab\'s life.');
}
{
  const w = world('null');
  const ok = await w.api.canvasDownloadPng({ toBlob: (cb) => setTimeout(() => cb(null), 0) }, 'x.png');
  if (ok !== false) bad('canvasDownloadPng reports success when toBlob returned null.');
}
// It must append the anchor — Firefox ignores a click on a detached one.
if (!/document\.body\.appendChild\(a\)/.test(fn('canvasDownloadPng'))) {
  bad('canvasDownloadPng does not add its <a> to the document; Firefox ignores a click on a detached anchor.');
}

// ── 4. DERIVED: every canvas-to-file path must go through the shared helper ────────────────
// Scoped to `toBlob`, which is the defect itself — a canvas that cannot encode. An earlier
// version of this arm flagged every `URL.createObjectURL` near a `.download =`, which caught the
// helper's OWN body and `tpDownloadBlob` (a video-take path that is handed a blob and therefore
// has no toBlob to be null). Neither is the bug; both are legitimate. A new canvas download that
// calls toBlob by hand, on the other hand, has skipped the null check and fails here.
{
  const ALLOWED = ['canvasDownloadPng', 'memeDownload'];
  const owners = ALLOWED.map(n => {
    const st = html.indexOf('function ' + n + '(');
    return st < 0 ? null : [st, html.indexOf('\n}', st) + 2];
  }).filter(Boolean);
  const rogue = [];
  const rx = /\.toBlob\s*\(/g;
  let m;
  while ((m = rx.exec(html))) {
    if (owners.some(([a, b]) => m.index > a && m.index < b)) continue;
    rogue.push('app.html:' + html.slice(0, m.index).split('\n').length);
  }
  if (rogue.length) {
    bad('a canvas is encoded to a file outside the shared helper, so it has none of the ' +
        'null / attach / deferred-revoke handling: ' + rogue.join(', ') +
        '. Use canvasDownloadPng — that is why it exists.');
  }
  if (owners.length !== ALLOWED.length) {
    bad('canvasDownloadPng or memeDownload is gone, so this rule is no longer anchored to anything.');
  }
}

// ── 5. no control may fail in total silence ────────────────────────────────────────────────
// DERIVED, not a list: a handler that takes an idea id and gives up because it cannot find the
// idea must SAY so. `viralTwist`, `viralRewrite` and `applyViralRewrite` each had a bare
// `if(!i) return;` — the person taps the button and nothing happens at all: no message, no
// spinner, nothing to report or search for. sharpenIdea one screen over already said it.
{
  const bare = [];
  const rx = /\n\s*if\s*\(\s*!i\s*\)\s*return\s*;/g;
  let m;
  while ((m = rx.exec(html))) {
    bare.push('app.html:' + html.slice(0, m.index).split('\n').length);
  }
  if (bare.length) {
    bad('a control gives up without telling the person anything: ' + bare.join(', ') +
        '. "I pressed it and nothing happened" is the hardest failure to report and the hardest to find.');
  }
}

// ── 6. an empty model reply must not render a heading with nothing under it ────────────────
// `data.twist` only has to be TRUTHY to reach the renderer, so a reply of `{}` drew the panel
// heading "Viral angles" over an empty box — the same dangling-heading failure the prompt budgets
// were rewritten to make impossible, this time on screen.
{
  const vt = html.slice(html.indexOf('async function viralTwist('), html.indexOf('window._vtRewrite = window._vtRewrite'));
  if (!vt) bad('viralTwist is gone from app.html — re-point this gate.');
  else {
    // RUN the counting expression rather than checking that the variable is mentioned: a presence
    // check passed a mutation once already in this session (see brain-learning-loop.mjs).
    const expr = (vt.match(/const _vtCount = [^;]+;/) || [])[0];
    if (!expr) {
      bad('viralTwist renders its panel without first counting what survived, so an empty reply ' +
          'shows a heading with nothing underneath it.');
    } else {
      const count = new Function('t', expr + ' return _vtCount;');
      const cases = [
        ['an empty reply', {}, 0],
        ['angles present but all blank', { angles: [{}, { angle: '' }] }, 0],
        ['one real angle', { angles: [{ hook: 'A real hook' }] }, 1],
        ['spicy only', { spicy: { hook: 'Spicy one' } }, 1],
        ['two angles and a spicy', { angles: [{ hook: 'a' }, { angle: 'b' }], spicy: { hook: 'c' } }, 3],
        ['a tip but nothing else', { tip: 'try harder' }, 0],
      ];
      for (const [name, t, want] of cases) {
        let got;
        try { got = count(t); } catch (e) { bad(`viralTwist's survivor count throws on ${name}: ${e.message}`); continue; }
        if (got !== want) bad(`viralTwist counts ${got} usable angles for ${name}, expected ${want}` +
          (want === 0 ? ' — so it would render a heading over an empty box.' : '.'));
      }
    }
    // ...and that count must be what decides between the panel and the message.
    if (!/_vtCount\s*\?/.test(vt) || !/vt-error/.test(vt)) {
      bad('viralTwist counts the survivors but does not use the count to choose between the panel ' +
          'and an honest message.');
    }
  }
}

if (fails.length) {
  console.error('FAIL:');
  fails.forEach(f => console.error('  - ' + f));
  process.exit(1);
}
console.log('download honesty verified: a canvas that cannot be encoded produces an honest message ' +
            'rather than a dead button or a false "Downloaded!", the anchor is attached and the ' +
            'object URL deferred, and no download path rolls its own any more.');
console.log('PASS');
