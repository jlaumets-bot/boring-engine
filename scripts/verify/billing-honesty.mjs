#!/usr/bin/env node
// G35 — the money path cannot claim a success it did not achieve.
//
// Found 2026-08-27. `setPlan()` swallowed every failure (`catch(e){ return false }`, no log) and
// all three callers threw the boolean away. The result:
//   • checkout-confirm answered {ok:true, plan:'pro'} AFTER the plan write failed — the customer
//     was charged and told it worked, and nothing anywhere recorded it.
//   • stripe-webhook answered 200 on a failed write, which tells Stripe "delivered, do not
//     retry" — so a cancelled customer kept paid access forever, and a paying customer stayed
//     on free. The one mechanism that would have healed it (Stripe's retry) was switched off
//     by our own success response.
//
// This is the highest-stakes instance of the app's recurring defect: reporting success that did
// not happen. It is invisible by construction — no error, no log, no user-visible symptom until
// somebody complains about their bill. So it gets a gate.
//
// See the note above assertResultIsChecked for exactly what this can and cannot prove — it does
// NOT execute the handlers end-to-end, and it says so rather than implying more coverage than
// it has. Overstating a gate is how you end up trusting a check that cannot fail.
//
// Read-only. Run: node scripts/verify/billing-honesty.mjs

import path from 'node:path';
import { createRequire } from 'node:module';
import { stripCode, selfTest } from './_srcscan.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const require_ = createRequire(import.meta.url);
const fails = [];
const check = (label, ok, detail) => { if (!ok) fails.push(label + (detail ? ' — ' + detail : '')); };

// NOTE ON WHAT THIS GATE CAN AND CANNOT PROVE.
// Executing these two handlers end-to-end needs a live Stripe key and a live Supabase — without
// them checkout-confirm bails at 401 and stripe-webhook at "billing not configured", so both the
// success and failure runs come back identical and the test proves NOTHING while looking green.
// The first version of this file did exactly that and said so out loud rather than passing.
// So it asserts the next-best thing that cannot be satisfied by a name: that setPlan's return
// value is CAPTURED into a variable and that the SAME variable is then branched on, and that the
// failure branch does not answer with success. That is the precise thing that was broken —
// the result was computed and thrown away.
function assertResultIsChecked(file, src) {
  // find `<name> = await usage.setPlan(` / `await setPlan(` — the value must land somewhere
  const caps = [...src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+(?:usage\.)?setPlan\s*\(/g)]
    .map(m => m[1]);
  const callCount = (src.match(/await\s+(?:usage\.)?setPlan\s*\(/g) || []).length;
  check(`api/${file}: a setPlan call throws its result away (${callCount} call(s), ${caps.length} captured)`,
    callCount > 0 && caps.length === callCount);
  for (const v of caps) {
    // the captured variable must appear in a condition, not just exist
    const branched = new RegExp(`if\\s*\\(\\s*!?\\s*${v}\\b|${v}\\s*(?:===|!==|\\?)`).test(src);
    check(`api/${file}: captures setPlan's result as \`${v}\` but never branches on it`, branched);
  }
  // and the failure path must not be a 2xx that claims success
  check(`api/${file}: has no failure branch that stops short of reporting the problem`,
    /plan_write_failed|status\(5\d\d\)/.test(src));
}

// ── 1. setPlan itself must not fail silently ──
const usageSrc = require_('node:fs').readFileSync(path.join(root, 'api/_usage.js'), 'utf8');
const setPlanBody = (usageSrc.match(/async function setPlan[\s\S]{0,900}/) || [''])[0];
check(
  'setPlan swallows its failure with no log — a failed plan write leaves no trace anywhere',
  /console\.(error|warn|log)/.test(setPlanBody)
);
check('setPlan no longer returns a boolean its callers can check', /return\s+false/.test(setPlanBody));

// ── 2. the two callers must actually USE what setPlan returned ──
for (const f of ['checkout-confirm.js', 'stripe-webhook.js']) {
  assertResultIsChecked(f, require_('node:fs').readFileSync(path.join(root, 'api', f), 'utf8'));
}

// ── 3. every guard() caller must both enforce the limit and record the usage ──
// stock-photo called guard() and checked neither — the only handler in the app doing so. Each
// half hid the other: with no usage row, `used` stays 0 forever, so the gate could never fire.
//
// v656: this loop used to `continue` unless the file matched the literal `_g = await guard`.
// Exactly ONE endpoint (api/stock-photo.js) is written that way; the other 22 use
// `const _g = await require('./_usage').guard(req, 'action')`, and two more use their own
// variable names (_cbGuard, _eaGuard). So the gate reached one file out of twenty-three and
// silently skipped the rest — deleting both the `.over` block and the logUsage call from
// api/viral-twist.js passed green. Now: find the guard call in whatever shape it is written,
// bind the check to the variable the result was captured into, and print the reached count so
// a future regression in this scanner shows up as a number rather than as silence.
const fs = require_('node:fs');
selfTest();   // the comment/string stripper must be proven before its result is trusted

// Endpoints that legitimately need only one half. Both empty today — every guard() caller in
// api/ blocks AND records. An entry here must name the file and say why, or it is a hole.
const NEED_NOT_BLOCK = {};   // file -> reason (guard() used only to resolve the user, never to meter)
const NEED_NOT_LOG   = {};   // file -> reason (the action is recorded by a different endpoint)

const EXPECTED_MIN_REACHED = 20;   // 23 guard() callers when this was written

const reached = [];
for (const f of fs.readdirSync(path.join(root, 'api')).filter(f => f.endsWith('.js'))) {
  if (f === '_usage.js') continue;            // defines guard(); the signature is not a call site
  const src = stripCode(fs.readFileSync(path.join(root, 'api', f), 'utf8'));
  // Any shape of guard call: `guard(req…`, `usage.guard(req…`, `require('./_usage').guard(req…`
  if (!/\bguard\s*\(\s*req\b/.test(src)) continue;
  reached.push(f);

  // The result must be CAPTURED — an un-captured `await guard(req, …)` can never be acted on.
  const caps = [...src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+[^;\n]*?\bguard\s*\(\s*req\b/g)]
    .map(m => m[1]);
  const callCount = (src.match(/\bguard\s*\(\s*req\b/g) || []).length;
  check(`api/${f}: calls guard() ${callCount}x but captures its result ${caps.length}x — an uncaptured ` +
        `guard() result can never block anyone`, caps.length >= 1 && caps.length >= callCount);

  // BLOCK: the captured result's `.over` must be read, and read as a condition.
  if (NEED_NOT_BLOCK[f]) {
    console.log(`  allowlisted (no block): api/${f} — ${NEED_NOT_BLOCK[f]}`);
  } else {
    const blocks = caps.some(v => new RegExp(`(?:if\\s*\\(|&&|\\|\\||!|\\?)\\s*!?\\s*${v}\\s*\\.\\s*over\\b`).test(src));
    check(`api/${f} calls guard() but never blocks an over-limit user — no \`${caps[0] || '<var>'}.over\` ` +
          `is tested (guard() only CHECKS the allowance; something has to act on it)`, blocks);
  }

  // RECORD: without a usage row `used` stays 0 forever and the limit is unreachable.
  if (NEED_NOT_LOG[f]) {
    console.log(`  allowlisted (no logUsage): api/${f} — ${NEED_NOT_LOG[f]}`);
  } else {
    check(`api/${f} calls guard() but never records usage — its limit can never be reached`,
          /\blogUsage\s*\(/.test(src));
  }
}

// A scanner that reaches nothing passes vacuously. Make that impossible.
check(`the guard() scanner reached only ${reached.length} api file(s) — it is broken, not the code ` +
      `(${EXPECTED_MIN_REACHED}+ endpoints call guard()). Files reached: ${reached.join(', ') || '(none)'}`,
      reached.length >= EXPECTED_MIN_REACHED);

if (fails.length) {
  console.log(`REACHED ${reached.length} guard()-calling api file(s): ${reached.join(', ')}`);
  console.log('FAIL: billing-honesty');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log(`REACHED ${reached.length} guard()-calling api file(s): ${reached.join(', ')}`);
console.log('PASS: billing-honesty — a failed plan write is logged, never reported as success, and every metered endpoint both blocks and records');
