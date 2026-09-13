#!/usr/bin/env node
// Gate: client-supplied brand context cannot become an unbounded LLM bill.
//
// getBrandContext() posts the ENTIRE brand snapshot from the browser, and fullBrandBlock()
// interpolates every field into the prompt. Grok's context window is ~500k tokens, so one field
// with a megabyte in it is a single request that costs more than a month of honest use.
//
// This is a BEHAVIOURAL check, not a grep: it calls the real function with an abusive payload
// and measures the output. A cap that is present in the source but bypassed on some path fails here.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const brain = require(path.join(root, 'api', '_brain.js'));

const fail = m => { console.error('FAIL: brand-context-cap — ' + m); process.exit(1); };

if (typeof brain.fullBrandBlock !== 'function') fail('_brain.js no longer exports fullBrandBlock');

const HUGE = 500000;
const big = 'x'.repeat(HUGE);

// 1. A single abusive field must be capped BY THE PER-FIELD CAP.
//    The threshold is deliberately well below the total cap: if it were merely "< HUGE", removing
//    the per-field cap would still pass here because the total cap would catch it, and this check
//    would be incapable of failing. Mutation-tested both ways.
const one = brain.fullBrandBlock({ brandName: 'Acme', painPoints: big });
const ONE_CEILING = 10000; // per-field cap is 4000; the total cap is 30000 and must NOT be what saves us
if (one.length > ONE_CEILING) {
  fail(`a single field of ${HUGE} chars produced a ${one.length}-char prompt (ceiling ${ONE_CEILING}) — the PER-FIELD cap is not applied`);
}

// 2. Many abusive fields must not stack past the total cap.
const FIELDS = ['usps', 'painPoints', 'coachNotes', 'exampleContent', 'productDetails',
  'categoryGripes', 'reviewInsights', 'webMentions', 'originStory', 'socialProof',
  'targetAudience', 'brandVocab', 'avoidWords', 'ctaStyle', 'tagline', 'bannedTopics',
  'competitors', 'channels', 'visualStyle', 'masterPromptContent'];
const bc = { brandName: 'Acme' };
for (const f of FIELDS) bc[f] = big;
const many = brain.fullBrandBlock(bc);
const CEILING = 60000; // generous: total cap + trends + the separately-capped master doc
if (many.length > CEILING) {
  fail(`${FIELDS.length} abusive fields produced a ${many.length}-char prompt (ceiling ${CEILING}) — the total cap is not applied`);
}

// 3. The cap must not damage a REAL brand. Nothing legitimate is near these limits, so a normal
//    payload must survive byte-for-byte — a cap that truncates honest content is its own bug.
const realistic = {
  brandName: 'Boring Electrolytes',
  targetAudience: 'Busy founders who train early and forget to hydrate.',
  painPoints: 'Sugary sports drinks. Vague dosing. Marketing that shouts.\n' + 'Real detail. '.repeat(120),
  usps: 'No sugar, no colour, no hype. Published dose per stick.',
  exampleContent: 'A post that worked. '.repeat(200)
};
const out = brain.fullBrandBlock(realistic);
for (const [k, v] of Object.entries(realistic)) {
  if (k === 'brandName') continue;
  if (!out.includes(String(v).trim())) {
    fail(`a realistic brand's "${k}" (${String(v).length} chars) was truncated — the cap is too tight for honest content`);
  }
}

console.log('PASS: brand-context-cap — per-field and total caps hold under abuse, realistic content untouched');
