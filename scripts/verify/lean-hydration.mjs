#!/usr/bin/env node
// GATE: every endpoint that RECEIVES a lean request must HYDRATE the brand server-side.
//
// WHY — caught 2026-08-27, before it shipped. app.html was converted to send lean requests
// (brandId + only what the DB cannot know) to /api/viral-twist and /api/viral-rewrite, but neither
// handler implemented the brandId protocol. They received `brandContext: {recentTrends}`, so
// fullBrandBlock rendered a BRAND PROFILE containing nothing but a trends line — i.e. Viral Twist
// was generating with NO BRAND BRAIN AT ALL, silently, producing generic output that still looked
// fine. Strictly worse than before the change, and invisible without this check.
//
// This is a RATCHET: convert a call site to leanBrandFetch without hydrating its endpoint and this
// gate goes red naming the endpoint.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const app = fs.readFileSync(path.join(root, 'app.html'), 'utf8');
const fails = [];
const check = (n, c, d) => { if (!c) fails.push(n + (d ? ' — ' + d : '')); };

const lean = [...new Set([...app.matchAll(/leanBrandFetch\(\s*'\/api\/([a-z-]+)'/g)].map(m => m[1]))];
check('no lean call sites found — this gate is blind (was leanBrandFetch renamed?)', lean.length > 0);

for (const ep of lean) {
  const f = path.join(root, 'api', ep + '.js');
  if (!fs.existsSync(f)) { check(`/api/${ep} is called but has no handler file`, false); continue; }
  const src = fs.readFileSync(f, 'utf8');
  check(`/api/${ep} receives lean requests but never hydrates the brand`,
    /_brandctx/.test(src),
    'it gets brandContext:{recentTrends} only, so the model writes with no brand brain — silently');
  check(`/api/${ep} hydrates but cannot refuse a stale/missing brand row`,
    /brand_context_unavailable/.test(src),
    'without the 424 it would quietly write brand-less content instead of asking the client to re-send');
}

// BEHAVIOURAL: prove the difference is real, not cosmetic — an unhydrated context must render a
// materially emptier prompt than a hydrated one, so a regression here is measurable.
const { fullBrandBlock } = await import(path.join(root, 'api', '_brain.js'));
const bare = fullBrandBlock({ recentTrends: ['x'] });
const full = fullBrandBlock({ recentTrends: ['x'], brandName: 'Acme', usps: 'u', painPoints: 'p',
  targetAudience: 'a', tones: ['deadpan'], coachNotes: 'c' });
check('a hydrated context is no richer than an unhydrated one — the merge is not working',
  full.length > bare.length + 200 && full.includes('Acme'));

if (fails.length) {
  console.error('FAIL: lean-hydration —');
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('PASS: lean-hydration — all ' + lean.length + ' lean endpoints (' + lean.join(', ') + ') hydrate and can refuse');
