#!/usr/bin/env node
// GATE: the brand brain never sends the model something it has quietly shortened, cut in half, or
//       mislabelled. Three shapes of the same lie: a rule list the model is told to "obey ALL" of
//       that is missing a quarter of its rules, a title cut mid-word, and a months-old competitor
//       digest rendered under the heading "what rivals JUST did".
//
// WHY THIS EXISTS
//   Two measured failures, both found by EXECUTING api/_brain.js rather than reading it:
//
//   1. VOICE MEMORY. `coachNotes` is one field holding many rules, one per line, appended over
//      time. It went through the same per-field cap as every other field — slice(0, 4000), keeping
//      the FRONT — while the app appends new rules to the END. At the app's own soft cap
//      (BRAIN_RULES_SOFT_CAP = 60 in app.html) and the length the distiller actually writes:
//          rules that reached the model INTACT: 36 of 60
//          the section ended mid-word: 'Rule 37: never say "leverage" or "unlock" when ta'
//      Meanwhile the app's toast said "Voice Memory is at 60 rules" and the prompt heading said
//      "obey ALL". 24 rules the user believed were in force were not in the prompt, and the 37th
//      was a fragment the model still had to obey.
//
//   2. THE TASTE SIGNAL. learnedSignalsFrom (api/_brandctx.js) and its client twin budget the
//      approved and dismissed halves against each other and drop WHOLE titles. _brain.js then
//      re-sliced their output at 500 — undoing exactly that. Measured at 8 approved + 6 dismissed
//      titles of this app's own generated length, the budgeter returned 502 chars and the slice
//      cut it to 500, ending '...listicle number 3 nobody asked f'.
//
//   The shared defect is a blind slice on a field whose items have meaning. The general rule this
//   gate enforces: cut on an ITEM boundary, and if anything was dropped, SAY SO in the prompt.
//
// HOW IT CHECKS
//   By running the real fullBrandBlock and the real learnedSignalsFrom and reading the output —
//   not by scanning for constants. A future rewrite that keeps the numbers but loses the
//   line-awareness still fails here.
//
// RUN:    node scripts/verify/brain-field-budgets.mjs
// EXPECT: prints "PASS" and exits 0.
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'x.js'));
const B = require(path.join(root, 'api/_brain.js'));
const { learnedSignalsFrom } = require(path.join(root, 'api/_brandctx.js'));

const fails = [];
const bad = m => fails.push(m);

// The cap the CLIENT enforces on the rule list. Read from app.html so the two can never drift:
// if someone raises the client cap, this gate starts testing the new number automatically.
import fs from 'fs';
const appSrc = fs.readFileSync(path.join(root, 'app.html'), 'utf8');
const capM = appSrc.match(/const\s+BRAIN_RULES_SOFT_CAP\s*=\s*(\d+)/);
if (!capM) bad('BRAIN_RULES_SOFT_CAP is gone from app.html, so this gate cannot know how many rules the app promises to keep.');
const SOFT_CAP = capM ? +capM[1] : 60;

// ── 1. every rule the app lets the user keep must reach the model, whole ────────────────────
// 110 chars is the measured length of a distilled rule; the point is a REALISTIC list, not a tiny one.
const rules = Array.from({ length: SOFT_CAP }, (_, i) =>
  `Rule ${i + 1}: never say "leverage" or "unlock" when talking about the morning routine product line, say it plainly`);
const block = B.fullBrandBlock({ brandName: 'Acme', coachNotes: rules.join('\n') }, {});
const missing = rules.filter(r => !block.includes(r));
if (missing.length) {
  bad(`Voice Memory drops rules the app promises to keep: only ${SOFT_CAP - missing.length} of ${SOFT_CAP} ` +
      `reached the model. The app tells the user all ${SOFT_CAP} are in force and tells the model to obey ALL of them.`);
}

// ── 2. a rule is either fully present or fully absent, in BOTH the fitting and overflow cases ──
const wholeRulesOnly = (text, known, label) => {
  const i = text.indexOf('Voice memory');
  if (i < 0) return bad(`the Voice memory section vanished entirely (${label}).`);
  const lines = text.slice(i).split('\n').slice(1);
  const body = [];
  for (const l of lines) { if (!l || /^[A-Z][^:]{2,}:/.test(l)) break; body.push(l); }
  const partial = body.filter(l => l && !known.includes(l));
  if (partial.length) {
    bad(`Voice Memory cut a rule in half (${label}): ${JSON.stringify(partial[0].slice(-60))}. ` +
        'A fragment is still an instruction the model has to obey.');
  }
  return body;
};
wholeRulesOnly(block, rules, 'at the soft cap');

// Far past any real list, to exercise the overflow branch.
const many = Array.from({ length: SOFT_CAP * 8 }, (_, i) => `Rule ${i + 1}: ` + 'x'.repeat(100));
const big = B.fullBrandBlock({ brandName: 'Acme', coachNotes: many.join('\n') }, {});
const keptLines = wholeRulesOnly(big, many, 'on overflow');
const kept = many.filter(r => big.includes(r));
if (!kept.length) bad('on overflow Voice Memory rendered nothing at all.');
// Newest wins: a later rule is the user's correction of an earlier one.
if (kept.length && kept[kept.length - 1] !== many[many.length - 1]) {
  bad('on overflow Voice Memory keeps the OLDEST rules and drops the newest. New rules are appended ' +
      'to the end, so the dropped ones are the corrections the user just made.');
}
// And the model must be told the list is partial rather than handed a short list labelled complete.
const head = big.split('\n').find(l => l.startsWith('Voice memory')) || '';
if (!/\bof\s+\d+\s+rules\b/.test(head)) {
  bad('on overflow the heading still claims to be the complete rule list. It says: ' + JSON.stringify(head.slice(0, 160)));
}
if (keptLines && keptLines.length && !head.includes(String(keptLines.length))) {
  bad(`the heading's count (${JSON.stringify(head.slice(0, 120))}) does not match the ${keptLines.length} rules actually rendered.`);
}

// ── 3. the taste signal budgeter's output must survive _brain.js untouched ──────────────────
const up = Array.from({ length: 8 }, (_, i) => `The quiet morning routine that actually sticks, part ${i + 1}`);
const down = Array.from({ length: 6 }, (_, i) => `Generic productivity hack listicle number ${i + 1} nobody asked for`);
const sig = learnedSignalsFrom(up, down);
if (!sig) bad('learnedSignalsFrom produced nothing for a realistic set of approvals and dismissals.');
const b2 = B.fullBrandBlock({ brandName: 'Acme', learnedSignals: sig }, {});
if (sig && !b2.includes(sig)) {
  const line = b2.split('\n').find(l => l.startsWith('Recent taste signal')) || '';
  bad(`_brain.js re-cuts the already-budgeted taste signal (${sig.length} chars in). It ends ` +
      JSON.stringify(line.slice(-50)) + ' — the budgeter drops whole titles precisely so this cannot happen.');
}

// ── 4. a crafted oversize signal is still capped, and still cuts on an item boundary ────────
const crafted = 'Recently APPROVED (favor topics/angles like these): ' +
  Array.from({ length: 200 }, (_, i) => 'Title number ' + (i + 1) + ' padded out').join(' · ');
const b3 = B.fullBrandBlock({ brandName: 'Acme', learnedSignals: crafted }, {});
const line3 = b3.split('\n').find(l => l.startsWith('Recent taste signal')) || '';
if (!line3) bad('a long taste signal made the section disappear instead of being capped.');
if (line3.length > 1200) bad(`an oversize taste signal is not capped: ${line3.length} chars reached the prompt.`);
if (line3 && !/padded out$/.test(line3)) {
  bad('an oversize taste signal is cut mid-title: ' + JSON.stringify(line3.slice(-40)) +
      '. It must lose whole items, not half of one.');
}

// ── 5. the trends gatherer's brain summary loses whole PARTS, cheapest first ────────────────
// Same defect, different file: api/_trends.js ended on `.join(' | ').slice(0, 1200)` over a string
// built in fixed order, so the LAST parts were always the ones lost — and the last two are the two
// that matter most to what this summary is for. It exists to SCOPE a web search and filter what
// comes back; losing "avoid / off-topic" loses the filter itself, which is what stops a
// peptide-research brand being handed celebrity headlines. Measured on a brand with every field
// filled at ordinary length, the old code dropped both and ended mid-word.
const { brainSummaryFrom } = require(path.join(root, 'api/_trends.js'));
const rep = (w, n) => Array.from({ length: n }, (_, i) => w + i).join(', ');
const FULL = {
  brandName: 'Peptide Labs', communities: rep('research peptide community ', 6),
  targetAudience: rep('longevity researcher ', 6), usps: rep('third-party tested batch ', 6),
  competitors: rep('RivalBrand ', 10), painPoints: rep('worries about purity ', 6),
  coachNotes: rep('never use the word unlock ', 9),
  learnedSignals: 'Recently APPROVED (favor topics/angles like these): ' + rep('Approved title ', 6) +
                  '  |  Recently DISMISSED (avoid these): ' + rep('Dismissed title ', 5),
  bannedTopics: 'celebrity gossip, crypto, weight-loss before-and-afters, MLM',
};
const summary = brainSummaryFrom(FULL);
if (!/RivalBrand|Pain points/.test(summary) === false && summary.length < 400) {
  bad('brainSummaryFrom produced almost nothing for a fully-filled brand — the fixture is not exercising it.');
}
if (!/Avoid \/ off-topic for it/.test(summary)) {
  bad('the trends brain summary drops "Avoid / off-topic for it" — the only part that says what to ' +
      'THROW AWAY. Without it the gatherer can scope a search but not filter the results, which is ' +
      'the exact complaint this summary was written to fix.');
}
if (!/Recent behavior/.test(summary)) {
  bad('the trends brain summary drops the approved/dismissed behaviour, so gathering stops improving with use.');
}
// Whole parts only: every rendered part must still end where its own per-part cap put it, never mid-word.
const lastPart = summary.split(' | ').pop() || '';
if (/[A-Za-z]$/.test(lastPart) && !FULL.bannedTopics.endsWith(lastPart.split(': ').pop() || '\u0000')) {
  // Only a real mid-word cut fails: the final part must match a complete source value.
  const vals = Object.values(FULL).map(v => String(v));
  const tailVal = lastPart.slice(lastPart.indexOf(': ') + 2);
  if (!vals.some(v => v.startsWith(tailVal))) {
    bad('the trends brain summary ends mid-value: ' + JSON.stringify(lastPart.slice(-60)));
  }
}
// It must still be capped — this string is sent on every trend pull, for every brand.
if (summary.length > 1700) bad('the trends brain summary is no longer capped: ' + summary.length + ' chars.');

// ── 6. "Recent competitor moves" must actually be recent ───────────────────────────────────
// The cron refreshes this weekly, but nothing ever EXPIRED it. If the refresh stops succeeding —
// the XAI key is rotated out, the competitors field is cleared, the pulse returns '' — the last
// digest is carried forward untouched and rendered under "Recent competitor moves (what rivals
// just did)" with "Differentiate from, counter, or ride the same wave better than them." Telling
// the model to counter a campaign that ended months ago is worse than saying nothing.
const { contextFromBrandRow } = require(path.join(root, 'api/_brandctx.js'));
const DAY = 86400000;
const moves = age => contextFromBrandRow({ brand_name: 'A', auto_trends: age === null
  ? { competitorMoves: 'Rival launched X' }
  : { competitorMoves: 'Rival launched X', compAt: Date.now() - age } }).competitorMoves;
if (!moves(3 * DAY)) {
  bad('a competitor digest three days old is discarded — the expiry is so tight the feature never works.');
}
if (moves(120 * DAY)) {
  bad('a competitor digest 120 days old still reaches the model under "what rivals JUST did", and the ' +
      'prompt tells the model to counter it. The cron refreshes weekly, so that digest means the ' +
      'refresh has been failing for months with nothing saying so.');
}
if (moves(null)) {
  bad('a competitor digest with no timestamp is treated as fresh. An unknown age is not evidence of freshness.');
}
// And it must still render when it IS fresh, or the check above is satisfied by deleting the feature.
if (!/Recent competitor moves/.test(B.fullBrandBlock({ brandName: 'A', competitorMoves: 'Rival launched X' }, {}))) {
  bad('fullBrandBlock no longer renders competitorMoves at all.');
}
// The client applies the SAME expiry (app.html getCompetitorMoves). If the two drift, the legacy
// full-context path uploads a digest the lean path would have dropped, and lean-payload.mjs's
// field-for-field comparison starts failing for a reason that looks like a payload bug.
const srvAge = (fs.readFileSync(path.join(root, 'api/_brandctx.js'), 'utf8')
  .match(/COMP_MAX_AGE_MS\s*=\s*([^;]+);/) || [])[1];
const cliAge = (appSrc.match(/CM_MAX_AGE_MS\s*=\s*([^;]+);/) || [])[1];
if (!cliAge) bad('app.html has no CM_MAX_AGE_MS, so the client no longer expires the competitor digest ' +
                 'and will upload one the server would have dropped.');
else if (!srvAge) bad('api/_brandctx.js has no COMP_MAX_AGE_MS.');
else if (eval(srvAge) !== eval(cliAge)) {
  bad(`the client and server competitor-digest expiries have drifted: client ${cliAge.trim()}, server ${srvAge.trim()}.`);
}

if (fails.length) {
  console.error('FAIL:');
  fails.forEach(f => console.error('  - ' + f));
  process.exit(1);
}
console.log(`brand-brain field budgets verified: all ${SOFT_CAP} Voice Memory rules reach the model whole, ` +
            'overflow drops whole rules newest-first and says so in the heading, and the taste signal ' +
            'budgeter\'s output is never re-sliced. The trends brain summary keeps its filter and its ' +
            'behaviour signal, dropping cheaper parts whole instead of blind-slicing the tail. A ' +
            'competitor digest older than the expiry is dropped rather than shown as "what rivals just did".');
console.log('PASS');
