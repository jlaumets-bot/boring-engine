#!/usr/bin/env node
// GATE: xAI reasoning depth is set explicitly, and never left on the "high" default.
//
// WHY — production log, 2026-08-27:
//   xAI EMPTY 200 after 52771ms — completion_tokens: 0, reasoning_tokens: 2533
// The app never sent `reasoning_effort`, and xAI defaults it to "high" (docs.x.ai: "If not
// specified, reasoning_effort defaults to 'high'"). So every post ever written ran at the depth
// meant for maths proofs — 52s of reasoning producing zero words, then a retry. Writing in a
// brand voice is not a logic puzzle; the depth bought latency and empty responses, not quality.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = fs.readFileSync(path.join(root, 'api', '_llm.js'), 'utf8');
const fails = [];
const check = (n, c, d) => { if (!c) fails.push(n + (d ? ' — ' + d : '')); };

check('reasoning_effort is never sent — xAI silently defaults it to "high"',
  /reasoning_effort/.test(src),
  'that default is what produced 52s of reasoning and an empty response');
check('the effort level is hardcoded rather than env-overridable',
  /XAI_REASONING_EFFORT/.test(src),
  'the level must be raisable without a deploy if the writing degrades');

const m = src.match(/process\.env\.XAI_REASONING_EFFORT\s*\|\|\s*'([a-z]+)'/);
check('could not read the default effort level', !!m);
if (m) {
  check('default effort is still a slow level', ['low', 'medium'].includes(m[1]),
    'default is "' + m[1] + '" — the whole point is to stop paying maths-proof latency for a social post');
}

// Reasoning models REJECT these outright (docs.x.ai). Sending one would 400 every request.
// Strip comments first: the note explaining this rule mentions both names, and matching that
// made the check fail against correct code — a false positive is as useless as a missed one.
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
for (const bad of ['presence_penalty', 'frequency_penalty']) {
  check('sends ' + bad + ', which reasoning models reject', !new RegExp('\\b' + bad + '\\b').test(code));
}

// BEHAVIOURAL: the parameter must actually reach the request body.
const gi = src.indexOf('const payload = {');
const win = src.slice(gi, gi + 900);
check('reasoning_effort is not attached to the payload that gets sent',
  /payload\.reasoning_effort\s*=/.test(win),
  'declared but never added to the body would be a no-op that still reads as fixed');

if (fails.length) {
  console.error('FAIL: reasoning-effort —');
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('PASS: reasoning-effort — depth is set explicitly, defaults fast, and is env-overridable');
