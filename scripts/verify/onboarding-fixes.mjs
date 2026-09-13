// Oracle for the ONBOARDING fixes in app.html (wizard/unlock agreement, dead
// finish button, silently-blocked buttons, duplicate listeners, tag escaping).
// Usage: node scripts/verify/onboarding-fixes.mjs [path-to-app.html]
// Exits 0 and prints PASS only when every fix is structurally present.
import fs from 'fs';
import path from 'path';

const file = process.argv[2] || path.join(process.cwd(), 'app.html');
const src = fs.readFileSync(file, 'utf8');
const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };

const DECL = /\n(?:async )?function ([A-Za-z_$][\w$]*)\s*\(/g;
function body(name) {
  DECL.lastIndex = 0;
  let start = -1, end = src.length, m;
  while ((m = DECL.exec(src))) {
    if (start !== -1) { end = m.index; break; }
    if (m[1] === name) start = m.index;
  }
  return start === -1 ? null : src.slice(start, end);
}

/* ── FIX 3: the wizard must collect everything the app then demands ─────────── */
// isBrandMinimumMet() gates the Shazam circle + Pipeline/Remix/Blog tabs; the
// "brand brain is still empty" modal additionally needs getBrainStats().filled > 2.
const min = body('isBrandMinimumMet');
ok(min, 'FIX3: isBrandMinimumMet() not found');
if (min) {
  ok(/settings\.brandName/.test(min) && /settings\.tones/.test(min) &&
     /settings\.communities/.test(min) && /settings\.targetAudience/.test(min),
     'FIX3: isBrandMinimumMet was weakened — the generate guard exists for a reason; fix the wizard, not the gate');
  ok(/tones\.length\s*>=\s*2/.test(min) && /communities\.length\s*>=\s*2/.test(min),
     'FIX3: isBrandMinimumMet no longer requires 2 tones + 2 communities');
}

const next = body('obNext');
ok(next, 'FIX3: obNext() not found');
if (next) {
  const step2 = next.slice(next.indexOf('fromStep === 2'));
  const need = [
    ['obBrandName',              'the brand name'],
    ['obSelectedTones.length < 2', '2+ tones'],
    ['obAudience',               'the target audience'],
    ['obUsps',                   'the USPs (needed so getBrainStats().filled > 2, else the "brain is still empty" modal fires)'],
    ['obCommunities.length < 2', '2+ topics'],
  ];
  for (const [needle, label] of need) {
    ok(step2.indexOf(needle) !== -1,
       'FIX3: obNext(2) does not require ' + label + ' — the wizard would promise "your brand brain is ready" and then hand the user a locked app');
  }
  // Every check must actually block the step, not just warn.
  const returns = (step2.match(/return\s*;/g) || []).length;
  ok(returns >= 5, `FIX3: obNext(2) has ${returns} blocking returns, expected one per required field (5)`);
}

/* ── FIX 5: no silently-blocked buttons ────────────────────────────────────── */
ok(body('obShowErr'), 'FIX5: obShowErr() helper not defined');
ok(/id="obStep1Err"/.test(src), 'FIX5: #obStep1Err message element missing from the wizard markup');
ok(/id="obStep2Err"/.test(src), 'FIX5: #obStep2Err message element missing from the wizard markup');
const crawl = body('obCrawlWebsite');
ok(crawl, 'FIX5: obCrawlWebsite() not found');
if (crawl) {
  const empty = crawl.slice(0, crawl.indexOf('startsWith'));
  ok(/obShowErr\(\s*'obStep1Err'/.test(empty),
     'FIX5: obCrawlWebsite still focus()es and returns in silence on an empty URL');
  ok(!/if\s*\(\s*!url\s*\)\s*\{\s*document\.getElementById\('obWebsiteUrl'\)\.focus\(\)\s*;\s*return\s*;\s*\}/.test(crawl),
     'FIX5: the silent empty-URL return is still present');
}
if (next) ok(/obShowErr\(\s*'obStep2Err'/.test(next),
   'FIX5: obNext(2) rejects without telling the user why');

/* ── FIX 4: the finish button is restored on every exit path ────────────────── */
const reset = body('obResetFinishBtn');
ok(reset, 'FIX4: obResetFinishBtn() not defined');
if (reset) {
  ok(/disabled\s*=\s*false/.test(reset), 'FIX4: obResetFinishBtn does not re-enable the button');
  ok(/Write my first post/.test(reset), 'FIX4: obResetFinishBtn restores the wrong label');
}
const showWiz = body('obShowWizard');
ok(showWiz, 'FIX4: obShowWizard() not found');
if (showWiz) ok(/obResetFinishBtn\(\)/.test(showWiz),
  'FIX4: obShowWizard does not restore the finish button — the obFinish failure path returns normally, so the wiring .catch never runs and the user finds a dead "Generating..." button');
const finish = body('obFinish');
ok(finish, 'FIX4: obFinish() not found');
if (finish) {
  const cat = finish.slice(finish.indexOf('brand save FAILED'));
  ok(/obResetFinishBtn\(\)/.test(cat), 'FIX4: obFinish\'s save-failure path does not restore the finish button');
}
ok(!/Generate my first ideas/.test(src),
   'FIX4: the stale "Generate my first ideas →" label is still used to restore the finish button');

/* ── FIX 6: keydown listeners must be wired exactly once ───────────────────── */
if (showWiz) {
  ok(/_obKeysWired/.test(showWiz),
     'FIX6: obShowWizard re-adds its keydown listeners on every call — a second call stacks duplicates and Enter fires obCrawlWebsite() twice');
  const iGuard = showWiz.indexOf('_obKeysWired');
  const iFirst = showWiz.indexOf("addEventListener('keydown'");
  ok(iGuard !== -1 && iFirst !== -1 && iGuard < iFirst,
     'FIX6: the _obKeysWired guard must come BEFORE the addEventListener calls');
}

/* ── FIX 7: crawl-supplied topics must be escaped into the tag markup ──────── */
const tags = body('obRenderCommunityTags');
ok(tags, 'FIX7: obRenderCommunityTags() not found');
if (tags) {
  ok(!/obRemoveCommunity\('\$\{c\}'\)/.test(tags),
     "FIX7: obRemoveCommunity('${c}') is still interpolated raw — an apostrophe in an LLM-supplied topic breaks the × handler");
  ok(/JSON\.stringify/.test(tags) && /vlEscAttr/.test(tags),
     'FIX7: the × handler argument is not encoded with JSON.stringify + vlEscAttr');
  ok(/escHtml\(c\)/.test(tags), 'FIX7: the visible tag label is not escaped with escHtml');
}

/* Behavioural check: the escaping actually round-trips a hostile topic. */
{
  const escHtml = s => !s ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const vlEscAttr = s => String(s==null?'':s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const c = `What's trending & "hot" <b>`;
  const attr = vlEscAttr(JSON.stringify(String(c)));
  ok(attr.indexOf('"') === -1, 'FIX7: encoded handler arg still contains a raw double quote (would break the attribute)');
  ok(attr.indexOf('<') === -1, 'FIX7: encoded handler arg still contains a raw <');
  // Decode the attribute the way a browser would, then confirm it is valid JS
  // that yields the ORIGINAL topic string — i.e. the × really would remove it.
  const decoded = attr.replace(/&quot;/g,'"').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
  let round = null;
  try { round = JSON.parse(decoded); } catch (e) { /* leave null */ }
  ok(round === c, 'FIX7: the encoded topic does not decode back to the original string');
  ok(escHtml(c).indexOf('<b>') === -1, 'FIX7: escHtml did not neutralise markup in the label');
}

if (fails.length) {
  console.error('ONBOARDING FIXES FAILED:');
  fails.forEach(f => console.error('  - ' + f));
  process.exit(1);
}
console.log('onboarding fixes verified: wizard/unlock agreement, finish-button restore, spoken refusals, single keydown wiring, escaped topic tags');
console.log('PASS');
