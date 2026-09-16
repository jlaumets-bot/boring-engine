#!/usr/bin/env node
// GATE: the brand allowance the server enforces is the same one the price page sells.
//
// WHY THIS EXISTS
//   api/_brandlimit.js holds ONE table (BRAND_LIMITS) that decides how many brands a plan may
//   own, and index.html's pricing cards are what a customer actually reads before paying. Those
//   two live in different files, in different languages, edited by different people, and nothing
//   connected them. That is exactly how this repo has been burned before: a promise on the
//   landing page and a number in the code that quietly stopped matching it, with no error
//   anywhere — the customer is charged for what the page said and the server hands them less.
//
//   The specific thing that just happened: Pro was raised from one brand to two. If someone
//   raises it again, or lowers it, or drops the line from the Pro card in a copy edit, nothing
//   would notice. The trial has the same problem in miniature — it is sold as "Try Pro free for
//   7 days", so a trial that grants fewer brands than Pro is the product lying about itself.
//
// HOW IT CHECKS
//   Behaviourally where it can. It imports the REAL module and calls the REAL brandLimitFor(),
//   rather than grepping for a digit — a gate that greps passes on a table nobody reads.
//   Then it parses the Pro card out of index.html and requires the number the code enforces to
//   be stated on it. Trial is asserted EQUAL TO the pro value, never to a literal, so the two
//   cannot be edited apart.
//
// RUN:    node scripts/verify/brand-limit-wire.mjs
// EXPECT: prints "PASS" and exits 0. Any drift exits 1 naming what the customer would be sold
//         versus what the server would give them.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = path.join(ROOT, 'index.html');
const MODULE = path.join(ROOT, 'api/_brandlimit.js');

const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };
const die = (msg) => { console.error('FAIL: ' + msg); process.exit(1); };

// ── 1. the real module, not a grep ────────────────────────────────────────────
let mod;
try { mod = require(MODULE); }
catch (e) {
  die('api/_brandlimit.js would not load (' + ((e && e.message) || e) + ') — every brand limit in ' +
      'the product comes from this file, so nothing is enforcing anything right now');
}
const { BRAND_LIMITS, brandLimitFor } = mod;
if (typeof brandLimitFor !== 'function') {
  die('api/_brandlimit.js no longer exports brandLimitFor() — api/usage.js calls it through ' +
      'canCreateBrand(), so the brand allowance is not being decided by this table at all');
}
if (!BRAND_LIMITS || typeof BRAND_LIMITS !== 'object') {
  die('api/_brandlimit.js no longer exports BRAND_LIMITS — this gate cannot see the policy it is ' +
      'meant to hold the price page to, so it would pass while proving nothing');
}

const PRO = brandLimitFor('pro');

ok(PRO === 2,
   'Pro grants ' + PRO + ' brand(s), not 2 — the Pro card on the pricing page sells two, so every ' +
   'Pro customer who makes a second brand is either refused something they paid for or given ' +
   'something that was never priced');
ok(brandLimitFor('free') === 1,
   'Free grants ' + brandLimitFor('free') + ' brand(s), not 1 — index.html:702 sells Free as ' +
   '"40 posts a month, one brand"');
ok(brandLimitFor('agency') === Infinity,
   'Agency is capped at ' + brandLimitFor('agency') + ' — index.html:729 sells it as "Multiple ' +
   'brands & seats for your team", so a cap of any size is a refusal the customer was not sold');
ok(brandLimitFor('trial') === PRO,
   'the trial grants ' + brandLimitFor('trial') + ' brand(s) but Pro grants ' + PRO + ' — the trial ' +
   'is sold as "Try Pro free for 7 days" (index.html:695), so a trialist would hit a wall inside ' +
   'the very plan they are evaluating, on the one week that decides whether they pay');

// Unknown plan names must land on the free allowance, not on undefined/NaN — a stripe webhook
// writing a plan string nobody added to the table must not silently grant Infinity or block
// everyone. (This arm is only meaningful while free !== pro, which is true today.)
ok(brandLimitFor('some-plan-nobody-added-yet') === brandLimitFor('free'),
   'an unknown plan name returns ' + brandLimitFor('some-plan-nobody-added-yet') + ' instead of the ' +
   'free allowance (' + brandLimitFor('free') + ') — a plan key that reaches us from Stripe before ' +
   'it reaches this table would get an allowance nobody chose');
ok(brandLimitFor(undefined) === brandLimitFor('free') && brandLimitFor(null) === brandLimitFor('free'),
   'a missing plan does not fall back to the free allowance — canCreateBrand() passes plan=null ' +
   'whenever the plan read failed, and that path must not hand out an unowned allowance');

// ── 2. THE COHERENCE CHECK — code vs. the page the customer pays from ─────────
// This is the point of the gate. Everything above can be true while the pricing card says
// something else entirely, and the card is the thing the customer read.
if (!fs.existsSync(INDEX)) die('index.html not found at ' + INDEX + ' — the pricing promise cannot be checked');
const html = fs.readFileSync(INDEX, 'utf8');

const cardStart = html.indexOf('<div class="price pro');
if (cardStart < 0) {
  die('could not find the Pro pricing card in index.html (`<div class="price pro`) — the card was ' +
      'renamed or removed, so this gate is blind and the code/price-page link is unchecked');
}
const featsStart = html.indexOf('<ul class="price-feats">', cardStart);
const featsEnd = html.indexOf('</ul>', featsStart);
if (featsStart < 0 || featsEnd < 0) {
  die('the Pro card in index.html has no <ul class="price-feats"> list — the feature list this gate ' +
      'reads the brand promise from is gone');
}
const featsHtml = html.slice(featsStart, featsEnd);
const feats = [...featsHtml.matchAll(/<li class="price-feat">([\s\S]*?)<\/li>/g)]
  .map(m => m[1].replace(/<[^>]*>/g, '').replace(/&mdash;/g, '—').replace(/&amp;/g, '&').trim());

// A extractor that reaches nothing passes vacuously. Make that impossible.
if (feats.length < 3) {
  die('only ' + feats.length + ' feature line(s) parsed out of the Pro card — the extractor is ' +
      'broken, not the copy, and a broken extractor would wave any pricing change through');
}
// And prove we are on the Pro card, not a neighbour.
ok(!/Everything in Pro|Multiple brands/.test(featsHtml),
   'the "Pro card" this gate parsed is actually the Agency card — the coherence check is pointed ' +
   'at the wrong card and proves nothing about Pro');

// The enforced number must be STATED on the card, on a line that is about brands.
const numberOnCard = new RegExp('(?<![\\d.,])' + PRO + '(?![\\d.,])');
const brandLine = feats.find(f => /brands?\b/i.test(f) && numberOnCard.test(f));
ok(!!brandLine,
   'the Pro card in index.html never states the ' + PRO + '-brand allowance the server enforces. ' +
   'Lines on the card: ' + JSON.stringify(feats) + '. A customer reading this page cannot tell ' +
   'how many brands Pro buys them, and the next person to change BRAND_LIMITS.pro has nothing ' +
   'telling them the page has to change too');

// ── verdict ──────────────────────────────────────────────────────────────────
if (fails.length) {
  console.error('FAIL (' + fails.length + ') — what the server enforces and what the price page sells have drifted apart:');
  fails.forEach(f => console.error('  - ' + f));
  process.exit(1);
}
console.log('PASS — BRAND_LIMITS grants pro=' + PRO + ', trial=pro, free=1, agency=unlimited, unknown→free, ' +
            'and the Pro pricing card states it: "' + brandLine + '"');
process.exit(0);
