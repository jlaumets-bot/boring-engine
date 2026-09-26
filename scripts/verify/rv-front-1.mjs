#!/usr/bin/env node
// GATE (v690 review, front 1): the B-roll preview charges once, says why photos are missing, and
//       does not promise a video length it will not deliver.
//
// WHY THIS EXISTS
//   1. v688 added a cache check to the B-roll preview so looking twice would not pay twice. The
//      check asked for `.beats` on what beatsCacheGet returns — but beatsCacheGet returns the beats
//      ARRAY itself (the brand/script stamps live on the array). `.beats` was always undefined, so
//      every look still bought a fresh graphics track (1 credit) plus up to six stock photos.
//   2. The preview says "Finding the photos… free stock, recoloured to your brand" and, when the
//      shared Pexels quota was drained, showed plain text cards with no word why. The render's
//      result sheet learned to say it in v688; the preview — where people see it first — did not.
//   3. The preview's footer said "6 beats · 19.50s". The finished video is as long as the TAKE; the
//      beats are stretched across it. A 60-second take never comes out 19.5 seconds long.
//   4. A number beat's headline was drawn nowhere — preview or render (see beat-text-fits.mjs).
//   5. With the AI account paused, the failure line said "Tap B-roll again to retry", which cannot
//      help; the server's own message already says when to come back.
//
// HOW IT CHECKS
//   It RUNS the real openBrollIdea, with the real cache (beatsCacheGet/Set and their stamps), the
//   real renderBrollStage/brollBeatHtml and the real spPhotoMissMsg, against a fake network that
//   counts calls. Every arm has its opposite: a changed script must still refetch.
//
// RUN:    node scripts/verify/rv-front-1.mjs
// EXPECT: prints "PASS" and exits 0.
import fs from 'node:fs'; import vm from 'node:vm';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
setTimeout(() => { console.log('FAIL: wall clock (60s) exceeded'); process.exit(2); }, 60000).unref();
let fail = 0; const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fail++; } else console.log('ok:', m); };
const grab = n => {
  let i = html.indexOf('\nfunction ' + n + '('); if (i < 0) i = html.indexOf('\nasync function ' + n + '(');
  if (i < 0) throw new Error('no function ' + n + ' in app.html — re-anchor this gate');
  return html.slice(i + 1, html.indexOf('\n}', i) + 2);
};

const BEATS = () => [
  { kind: 'statement', headline: 'Only two matched', highlight: 'two', imageQuery: 'supplement tub' },
  { kind: 'number', value: '34g', headline: 'of protein', sub: 'per scoop' },
  { kind: 'statement', headline: 'Nothing else in it', imageQuery: 'empty scoop' },
];
function world({ answer, photos } = {}) {
  const body = { innerHTML: '' };
  const c = { console, Math, String, Number, Array, JSON, Object, Date, Promise,
    calls: 0, photoCalls: 0,
    currentBrand: { id: 'brand-1' },
    state: {},
    document: { querySelectorAll: () => [], createElement: () => ({ style: {} }),
                body: { appendChild() {} }, getElementById: (id) => (id === 'brollBody' ? body : null) },
    closeBroll() {}, getBrandContext: () => ({}), spBrollVars: () => '',
    URL: { createObjectURL: () => 'blob:x' },
  };
  c.window = c; c.window._beatsCache = {};
  c.leanBrandFetch = async () => { c.calls++; return answer ? answer() : new Response(JSON.stringify({ beats: BEATS(), secondsPerBeat: 3.25 }), { status: 200 }); };
  c.spFetchBeatPhotos = async (beats) => { c.photoCalls++; if (photos) photos(c, beats); };
  vm.createContext(c);
  for (const n of ['_beatsFp', '_beatsBrand', '_beatsIdeaFor', '_beatsFreeMedia', '_beatsStillCached', 'beatsCacheDrop',
                   'beatsCacheGet', 'beatsCacheSet', '_brollCachedData', 'brollEsc', 'brollHi', 'brollBeatHtml',
                   'renderBrollStage', 'humanErr', 'spPhotoMissMsg', 'openBrollIdea'])
    vm.runInContext(grab(n), c);
  return { c, body };
}
const idea = { script: 'We tested nine best sellers and only two matched', hook: 'h', title: 't', status: 'pending' };

// ── 1. looking twice costs once ──────────────────────────────────────────────
{
  const { c, body } = world();
  c.IDEA = idea;
  await vm.runInContext('openBrollIdea(IDEA, 4)', c);
  ok(c.calls === 1 && /br-sg/.test(body.innerHTML), 'the first look fetches the graphics track and shows it');
  await vm.runInContext('openBrollIdea(IDEA, 4)', c);
  await vm.runInContext('openBrollIdea(IDEA, 4)', c);
  ok(c.calls === 1,
     'looking again at the same card, same brand, same script does NOT pay again (' + c.calls + ' paid calls for 3 looks). The ' +
     'v688 check asked beatsCacheGet\'s ARRAY for `.beats`, which is always undefined, so every look was a fresh charge');
  ok(/br-sg/.test(body.innerHTML), 'and the cached look still renders the stage');
  // opposite arm: the script changed (a sharpen) — the cache must not be used
  c.IDEA = Object.assign({}, idea, { script: idea.script + ' — sharpened' });
  await vm.runInContext('openBrollIdea(IDEA, 4)', c);
  ok(c.calls === 2, 'the opposite arm: after the script changes, the next look DOES fetch fresh graphics (' + c.calls + ')');
  c.currentBrand = { id: 'brand-2' };
  await vm.runInContext('openBrollIdea(IDEA, 4)', c);
  ok(c.calls === 3, 'and after a brand switch too (' + c.calls + ')');
}
// ── 2. the preview says why the photos are missing ───────────────────────────
{
  const { c, body } = world({ photos: (c) => { c.window._spPhotoMisses = 2; c.window._spPhotoWhy = 'http_429'; } });
  c.IDEA = idea;
  await vm.runInContext('openBrollIdea(IDEA, 5)', c);
  ok(/rated out/.test(body.innerHTML),
     'when the shared photo quota is drained the preview says so (' + JSON.stringify((body.innerHTML.match(/No stock photos[^<]*/) || [''])[0]) + ') ' +
     'instead of promising "free stock, recoloured to your brand" and showing text cards');
  const w2 = world({ photos: (c) => { c.window._spPhotoMisses = 0; c.window._spPhotoWhy = ''; } });
  w2.c.IDEA = idea;
  await vm.runInContext('openBrollIdea(IDEA, 5)', w2.c);
  ok(!/rated out|came out as text/.test(w2.body.innerHTML), 'the opposite arm: when every photo arrived, no note is shown');
  const w3 = world({ photos: (c) => { c.window._spPhotoMisses = 6; c.window._spPhotoWhy = 'http_401'; } });
  w3.c.IDEA = idea;
  await vm.runInContext('openBrollIdea(IDEA, 5)', w3.c);
  ok(/not available right now/.test(w3.body.innerHTML) && !/no stock photo matched/.test(w3.body.innerHTML),
     'a rejected photo key is reported as the service being unavailable, not blamed on the script ("no stock photo matched")');
}
// ── 3. the footer does not promise a length the video will not have ─────────
{
  const { c, body } = world();
  c.IDEA = idea;
  await vm.runInContext('openBrollIdea(IDEA, 6)', c);
  const meta = (body.innerHTML.match(/<div class="br-meta">[^<]*<\/div>/) || [''])[0];
  ok(meta && !/\d+\.\d+s/.test(meta),
     'the preview footer no longer states a total length (' + JSON.stringify(meta) + '). "3 beats · 9.75s" described a video ' +
     'that is really as long as the take');
  ok(/3 beats/.test(meta) && /take/.test(meta), 'it still counts the beats and says they follow the take');
  // 4. the number beat's headline reaches the preview
  ok(/br-num">34g<\/div><div class="br-big"[^>]*>of protein</.test(body.innerHTML),
     'a number beat shows its headline under the figure in the preview, as the render now draws it');
}
// ── 5. AI paused: the failure line does not tell them to tap again ───────────
{
  const MSG = 'The AI writer is paused on our side right now. Please try again later.';
  const { c, body } = world({ answer: () => new Response(JSON.stringify({ error: MSG, code: 'AI_UNAVAILABLE' }), { status: 503 }) });
  c.IDEA = idea;
  await vm.runInContext('openBrollIdea(IDEA, 7)', c);
  ok(body.innerHTML.indexOf(MSG) !== -1 && !/Tap B-roll again/.test(body.innerHTML),
     'with the AI account paused the preview shows the server message and no "Tap B-roll again to retry" (' + JSON.stringify(body.innerHTML) + ')');
  const o = world({ answer: () => new Response(JSON.stringify({ error: 'no beats came back' }), { status: 500 }) });
  o.c.IDEA = idea;
  await vm.runInContext('openBrollIdea(IDEA, 7)', o.c);
  ok(/Tap B-roll again to retry/.test(o.body.innerHTML), 'the opposite arm: an ordinary failure still offers the retry');
}

if (fail === 0) console.log('\nPASS — rv-front-1: the B-roll preview charges once, names missing photos, and promises no length it cannot keep.');
else { console.log('\n' + fail + ' failure(s)'); process.exitCode = 1; }
