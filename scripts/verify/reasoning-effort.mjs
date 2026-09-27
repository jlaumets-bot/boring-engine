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

/* ── v693 r3 — THE NEW RULE: depth above 'low' only WITH thinking headroom ─────────────────────
   The 2026-08-27 empty response was depth WITHOUT room: reasoning ate the whole max_tokens. The owner
   now wants deeper writing, so effort may rise — but only through api/_write.js writerCall(), which
   runs the call inside _llm.js withThinkingHeadroom() (low +2k, medium +6k, high +12k tokens on top
   of max_tokens). Checked three ways: no endpoint passes `effort` straight to callLLM; the real
   _llm.js request body carries effort AND headroom when a writer asks for depth (and the bare path
   visibly does not — that is the bug shape); the env knobs are validated. */
{
  const { createRequire } = await import('node:module');
  const { EventEmitter } = await import('node:events');
  const req = createRequire(import.meta.url);
  const fails2 = [];
  const ck = (n, c) => { if (!c) fails2.push(n); };
  // 1. static: effort never goes to callLLM directly
  for (const f of fs.readdirSync(path.join(root, 'api')).filter(f => f.endsWith('.js') && f !== '_llm.js' && f !== '_write.js')) {
    const s = fs.readFileSync(path.join(root, 'api', f), 'utf8');
    for (const m of s.matchAll(/\bcallLLM\(\{/g)) {
      const win = s.slice(m.index, m.index + 1500);
      const end = win.indexOf('})');
      ck(`api/${f}: a callLLM site passes "effort" without thinking headroom — use writerCall from api/_write.js`, !/\beffort\s*:/.test(end > 0 ? win.slice(0, end) : win));
    }
  }
  // 2. behavioural: the real request body
  process.env.XAI_API_KEY = 'test-only-not-a-real-key';
  const https = req('https');
  let sent = [];
  https.request = (opts, cb) => {
    const r = new EventEmitter(); let body = '';
    r.setTimeout = () => r; r.destroy = () => {}; r.write = (b) => { body += b; };
    r.end = () => {
      sent.push({ host: opts.hostname, body: JSON.parse(body || '{}') });
      setImmediate(() => { const resp = new EventEmitter(); resp.statusCode = 200; resp.headers = { 'content-type': 'application/json' }; cb(resp);
        const isClaude = opts.hostname === 'api.anthropic.com';
        resp.emit('data', JSON.stringify(isClaude ? { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } : { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} }));
        resp.emit('end'); });
    };
    return r;
  };
  const L = req(path.join(root, 'api', '_llm.js'));
  const W = req(path.join(root, 'api', '_write.js'));
  const msgs = [{ role: 'user', content: 'hi' }];
  for (const [effort, extra] of [['low', 2000], ['medium', 6000], ['high', 12000]]) {
    sent = []; await W.writerCall({ messages: msgs, max_tokens: 3000, effort, deadlineMs: 20000 });
    ck(`writerCall effort ${effort}: xAI body has reasoning_effort=${effort} and max_tokens 3000+${extra} (got ${JSON.stringify(sent[0] && { e: sent[0].body.reasoning_effort, m: sent[0].body.max_tokens })})`,
      sent.length === 1 && sent[0].body.reasoning_effort === effort && sent[0].body.max_tokens === 3000 + extra);
  }
  sent = []; await W.writerCall({ messages: msgs, max_tokens: 3000, deadlineMs: 20000 });
  ck('writerCall with no effort is the untouched default call (no headroom)', sent[0] && sent[0].body.max_tokens === 3000 && sent[0].body.reasoning_effort === (process.env.XAI_REASONING_EFFORT || 'low'));
  sent = []; await L.callLLM({ messages: msgs, max_tokens: 3000, effort: 'high', deadlineMs: 20000 });
  ck('opposite: a bare callLLM effort "high" gets NO headroom — the empty-response shape the static rule forbids', sent[0] && sent[0].body.max_tokens === 3000);
  const RM = req(path.join(root, 'api', 'remix.js'));
  sent = []; try { await RM._legacyRemix({ bc: {}, source: { text: 'x' }, effort: 'high', deadlineMs: 20000 }); } catch (e) {}
  ck('_legacyRemix with an effort goes through the headroom too', sent[0] && sent[0].body.max_tokens === 4000 + 12000);
  // 3. the env knobs
  const env = (k, v) => { if (v == null) delete process.env[k]; else process.env[k] = v; };
  ck('defaults: angles medium, draft medium, spoken medium, batch medium, edit medium, shape low',
    ['angles', 'draft', 'spoken', 'batch', 'edit', 'shape'].map(W.writerEffort).join() === 'medium,medium,medium,medium,medium,low');
  env('WRITER_EFFORT_DRAFT', 'high'); ck('WRITER_EFFORT_DRAFT moves the draft without a deploy', W.writerEffort('draft') === 'high');
  env('WRITER_EFFORT_DRAFT', 'extreme'); ck('an invalid WRITER_EFFORT_DRAFT falls back to the default', W.writerEffort('draft') === 'medium');
  env('WRITER_EFFORT_DRAFT', null);
  env('WRITER_EFFORT_BATCH', 'LOW'); ck('WRITER_EFFORT_BATCH is case-insensitive', W.writerEffort('batch') === 'low'); env('WRITER_EFFORT_BATCH', null);
  env('WRITER_PROVIDER', 'claude'); env('ANTHROPIC_API_KEY', null);
  ck('WRITER_PROVIDER=claude with no key falls back to grok (never fails a request)', W.writerProvider() === 'grok');
  env('ANTHROPIC_API_KEY', 'test-only-not-a-real-key');
  ck('WRITER_PROVIDER=claude with a key writes with Claude', W.writerProvider() === 'claude');
  sent = []; await W.writerCall({ messages: msgs, max_tokens: 3000, provider: W.writerProvider(), effort: 'medium', deadlineMs: 20000 });
  ck('...and the call really goes to Anthropic', sent[0] && sent[0].host === 'api.anthropic.com');
  env('WRITER_PROVIDER', 'gpt'); ck('an unknown WRITER_PROVIDER is Grok', W.writerProvider() === 'grok');
  env('WRITER_PROVIDER', null); env('ANTHROPIC_API_KEY', null);
  ck('unset WRITER_PROVIDER is Grok', W.writerProvider() === 'grok');
  if (fails2.length) { console.error('FAIL: reasoning-effort (v693 r3) —'); for (const f of fails2) console.error('  ✗ ' + f); process.exit(1); }
  console.log('PASS: reasoning-effort r3 — depth above low only travels with thinking headroom; WRITER_* knobs validated');
}
