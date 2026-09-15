#!/usr/bin/env node
// GATE: the "Start over (re-run onboarding)" button is rendered for the brand OWNER
//       and for nobody else.
//
// WHY THIS EXISTS
//   app.html obResetForTesting() loops over the seven content-library tables and
//   deletes on brand_id alone:
//       ideas, remixes, product_refs, competitors, prompt_history,
//       notebook_notes, edit_signals
//   Until sql/v658-member-delete.sql, every teammate held DELETE on all seven
//   (team-tables.sql:136-147 gave each a FOR ALL policy over user_brand_ids(),
//   which unions brands you OWN with brands you merely BELONG TO). The button sat
//   in the settings panel, visible to members, behind one confirm — so a member
//   pressing it out of curiosity destroyed the owner's entire library.
//
//   v658-member-delete.sql narrows DELETE to the owner, which turns that silent
//   destruction into an honest refusal. But an honest refusal is still a dead
//   button and a confusing dialog ("Some of this brand's data could not be
//   removed..."). This gate is the other half: a member never sees the button.
//
// HOW IT CHECKS — BEHAVIOURALLY, NOT BY GREP
//   A grep for the word "owner" near the button would pass on a comment. So this
//   gate lifts the actual `${ ... }` interpolation that wraps the button out of
//   app.html, compiles it with new Function, and RUNS it three times:
//       owner   -> markup MUST contain the button
//       member  -> markup MUST NOT contain the button
//       signed-out / no brand loaded -> MUST NOT contain the button
//   Deleting the condition, or inverting it, fails here.
//
// RUN:    node scripts/verify/start-over-owner-only.mjs
// EXPECT: prints "PASS" and exits 0.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../app.html');
const src = fs.readFileSync(APP, 'utf8');

const die = (msg) => { console.error('FAIL: ' + msg); process.exit(1); };

const NEEDLE = 'onclick="obResetForTesting()"';
const hits = src.split(NEEDLE).length - 1;
if (hits !== 1) die('expected exactly 1 "' + NEEDLE + '" in app.html, found ' + hits +
                    ' — this gate lifts the one interpolation around it and cannot ' +
                    'tell which copy is which.');
const at = src.indexOf(NEEDLE);

// Walk back to the nearest `${`, then forward to its matching `}`, tracking nesting
// so a `}` inside a nested template literal or an object literal does not end it early.
const open = src.lastIndexOf('${', at);
if (open < 0) die('the Start over button is not inside any ${...} interpolation — it is ' +
                  'rendered unconditionally, so every team member can see it.');

let depth = 0, i = open + 1, end = -1;
let tick = 0;            // nested template-literal depth
for (; i < src.length; i++) {
  const c = src[i];
  const prev = src[i - 1];
  if (prev === '\\') continue;
  if (c === '`') { tick = tick ? tick - 1 : 1; continue; }
  if (tick) continue;                                   // inside `...`: braces are text
  if (c === '{') depth++;
  else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
}
if (end < 0) die('could not find the end of the interpolation wrapping the Start over button.');
if (end < at) die('the Start over button is outside the interpolation that precedes it.');

const expr = src.slice(open + 2, end);

let render;
try {
  render = new Function('currentBrand', 'currentUser', 'return (' + expr + ');');
} catch (e) {
  die('the interpolation around the Start over button does not compile on its own: ' +
      e.message + '\n--- expression ---\n' + expr.slice(0, 400));
}

const run = (brand, user, label) => {
  let out;
  try { out = String(render(brand, user)); }
  catch (e) { die('rendering the Start over block as ' + label + ' threw: ' + e.message); }
  return out;
};

const OWNER  = run({ id: 'brand-1', user_id: 'user-1' }, { id: 'user-1' }, 'the owner');
const MEMBER = run({ id: 'brand-1', user_id: 'user-2' }, { id: 'user-1' }, 'a member');
const NOBODY = run(null, null, 'signed out');

if (!OWNER.includes('obResetForTesting'))
  die('the BRAND OWNER can no longer see "Start over" — this went one step too far. ' +
      'The owner is the one person who is meant to be able to re-run onboarding.');

if (MEMBER.includes('obResetForTesting'))
  die('a team MEMBER still sees the "Start over" button. Pressing it runs a delete over ' +
      "the owner's ideas, remixes, product_refs, competitors, prompt_history, " +
      'notebook_notes and edit_signals.');

if (NOBODY.includes('obResetForTesting'))
  die('the "Start over" button renders with no brand or no user loaded, so the ownership ' +
      'test is not actually gating it.');

// The member must still be told something, rather than being shown a blank gap where
// a button used to be.
if (!/only the brand owner/i.test(MEMBER))
  die('a member sees neither the button nor an explanation — the settings panel just ' +
      'has a hole in it. Say who can do this instead.');

console.log('PASS: "Start over" renders for the brand owner only (member and signed-out both refused).');
