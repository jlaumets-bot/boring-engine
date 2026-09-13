#!/usr/bin/env node
// GATE: no Quick Post action button can be a silent no-op.
//
// WHY — reported 2026-08-27: "after i pushed viral twist that didnt work". The server logs showed
// NO viral-twist request at all, while /api/connections and /api/speak succeeded seconds later —
// so the connection was fine and the request was never made. Cause: `_todayTabIdea` is nulled both
// on approve AND at the top of "Try Another", so a FAILED regeneration (the xAI empty-200: ~52s of
// reasoning, zero output) left the previous post on screen with the variable null. Four handlers
// then did `if (!i) return;` with no message: the button was simply dead.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const app = fs.readFileSync(path.join(root, 'app.html'), 'utf8');
const fails = [];
const check = (n, c, d) => { if (!c) fails.push(n + (d ? ' — ' + d : '')); };

// 1. No handler may bail on a missing idea without telling the user.
// A bare `if (!idea) return;` is the defect. tvApprove is ALLOWED to keep the strict guard (nulling
// the idea is what prevents a double-approve) but must still warn — so the rule is "never bail
// without telling the user", not "always use the fallback".
const silent = [...app.matchAll(/window\._todayTabIdea;\s*\n?\s*if\s*\(!\w+\)\s*(?:return;|\{\s*return;)/g)];
check('a Quick Post handler still bails silently on a missing post', silent.length === 0,
  silent.length + ' site(s) — the button does nothing at all: no spinner, no error, no message');

// 2. The resolver must exist and must be what the handlers use.
check('tvActiveIdea() resolver is missing', /function tvActiveIdea\s*\(/.test(app));
check('tvNoIdea() user-facing warning is missing', /function tvNoIdea\s*\(/.test(app));
for (const fn of ['tvPostIt', 'tvViralTwist', 'tvViralRewrite', 'tvApplyTwist']) {
  const i = app.indexOf('function ' + fn + '(');
  check(`${fn} not found — this gate is blind`, i >= 0);
  if (i < 0) continue;
  const head = app.slice(i, i + 400);
  check(`${fn} does not use tvActiveIdea()`, /tvActiveIdea\(\)/.test(head));
  check(`${fn} bails without warning the user`, /tvNoIdea\(/.test(head));
}

// 3. BEHAVIOURAL: the resolver must recover the on-screen post after a failed regeneration,
//    and must refuse when no card is rendered (never act on a post the user cannot see).
const gi = app.indexOf('function tvActiveIdea(');
let d = 0, j = app.indexOf('{', gi), end = 0;
for (let k = j; k < app.length; k++) { if (app[k] === '{') d++; else if (app[k] === '}') { d--; if (!d) { end = k + 1; break; } } }
const POST = { title: 'P' };
const run = (todayIdea, tvIdea, cardHtml) => {
  const win = { _todayTabIdea: todayIdea, _tvIdea: tvIdea };
  const doc = { getElementById: () => (cardHtml == null ? null : { innerHTML: cardHtml }) };
  return new Function('window', 'document', app.slice(gi, end) + '; return tvActiveIdea();')(win, doc);
};
check('normal generation does not resolve the post', run(POST, POST, '<div>c</div>') === POST);
check('after a FAILED regeneration the visible post is not recovered',
  run(null, POST, '<div>c</div>') === POST,
  'this is the exact reported bug — the button stays dead while the post is on screen');
check('acts on a post that is not rendered', run(null, POST, '   ') === null);
check('does not refuse when there is genuinely nothing', run(null, null, null) === null);

// 2. A button whose only output renders BELOW the action row must scroll to it.
// WHY — reported 2026-08-30: "microlecture and then viral twist, text seems the same", with two
// screenshots a minute apart showing an unchanged script. The twist had in fact worked: #viralTwist-tv
// and #tvRedoBox sit AFTER the whole .tp-actions-row in the markup, those buttons are usually the
// last thing on screen, so the panel AND its loading state rendered entirely below the fold with
// nothing scrolling to them. The button span its dots and, from the user's side, nothing happened.
// Confirmed by the user scrolling down and finding it. Same class as the Viral Lab results fix.
// Take each function body up to the next top-level function so a hit cannot leak in from a neighbour
// (deliberately NOT brace-counting — braces inside string literals make that lie).
function body(name) {
  const i = app.indexOf('function ' + name + '(');
  if (i < 0) return '';
  const rest = app.slice(i + 8);
  const j = rest.search(/\n(?:async )?function [A-Za-z_$]/);
  return j < 0 ? rest : rest.slice(0, j);
}
for (const fn of ['tvViralTwist', 'tvViralRewrite', 'tvRedoNotesOpen']) {
  const b = body(fn);
  check(`${fn} exists`, b.length > 0);
  check(`${fn} scrolls its output panel into view`, /_tvReveal\s*\(/.test(b),
    'its panel renders below the action buttons, so without this the user sees nothing happen');
}
check('_tvReveal is defined once', (app.match(/function _tvReveal\s*\(/g) || []).length === 1);
// The loading state must be revealed too, not just the finished result — otherwise a slow twist
// still looks like a dead button for the whole wait.
check('tvViralTwist reveals the panel while it is still loading',
  /vt-loading[^]{0,200}?_tvReveal/.test(body('tvViralTwist')),
  'revealing only the finished result leaves the button looking dead during the request');

// 3. Sharpen must state its outcome on the card, not only in a toast.
// WHY — reported 2026-08-30: "boring then video and then sharpen and original and sharpen stayd the
// same all". Two different correct behaviours both looked like a dead button: (a) Sharpen is a
// deliberately light-touch editor whose prompt caps the rewrite at the original length, so on a
// draft with no weak parts it returns {unchanged:true} — a REAL outcome that had only a 2.6s toast
// behind it; (b) when it DID rewrite, the fields it changed sit ABOVE the button that was tapped,
// so the change landed off-screen. Both now leave a visible note and scroll the user to the result.
const sq = body('sharpenQuickPost');
check('sharpenQuickPost exists', sq.length > 0);
check('sharpenQuickPost handles the "already sharp" outcome visibly', /onUnchanged/.test(sq),
  'unchanged is a real result, not a failure — it must say so somewhere that persists');
check('sharpenQuickPost scrolls to the rewritten fields', /_tvReveal\s*\(/.test(sq),
  'the fields it rewrites are above the button, so without this the change is invisible');
check('sharpenNow forwards the unchanged outcome to its caller', /o\.onUnchanged/.test(body('sharpenNow')));
check('the sharpen note element exists in the card', /id="tvSharpenNote"/.test(app));

if (fails.length) {
  console.error('FAIL: tv-dead-buttons —');
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('PASS: tv-dead-buttons — every Quick Post action resolves the on-screen post or says why it cannot');
