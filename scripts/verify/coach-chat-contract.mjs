#!/usr/bin/env node
// GATE: the brand coach never shows the person its own machine blocks, and one bad suggestion can
//       never kill the chat window.
//
// WHY THIS EXISTS
//   The coach appends up to three machine-readable blocks (<brand_update>, <assistant_action>,
//   <coach_memory>) that the server is supposed to parse out before the person sees the reply.
//   Two failures, both measured by running the real code:
//
//   1. A BLOCK WITH NO CLOSING TAG. Both the extractor and the stripper required a closing tag, and
//      `max_tokens` is 800 with prose plus three blocks to fit — so being cut off mid-block is
//      ordinary. When it happened the stripper matched nothing and the chat bubble showed:
//          "Here is why.\n<brand_update>\n{"field":"tagline","value":"Boring works"...
//      and the suggestion was lost even when only the closing TAG was missing and its JSON was
//      complete.
//
//   2. A SUGGESTION WITH NO USABLE FIELD. Whatever shape the model produced was sent as a
//      suggestion card. bvRenderMessages builds the label with `s.field.replace(...)`, so a missing,
//      numeric or object field threw inside the messages `.map()`, `container.innerHTML` was never
//      assigned, and the whole coach window stopped rendering. Messages are persisted, so it stayed
//      dead through reloads. Measured: 3 of 5 shapes killed it.
//
// HOW IT CHECKS
//   Both halves are EXECUTED — the server's real block parser and validator, and the real
//   bvRenderMessages out of app.html. Both are needed: the server fix stops new bad replies, the
//   client fix repairs conversations already saved.
//
// RUN:    node scripts/verify/coach-chat-contract.mjs
// EXPECT: prints "PASS" and exits 0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(ROOT, 'x.js'));
const { extractJson } = require(path.join(ROOT, 'api/_brain.js'));
const fails = [];
const bad = m => fails.push(m);

// ── the server half: parse + strip, executed ──────────────────────────────────────────────
const srv = fs.readFileSync(path.join(ROOT, 'api/brand-voice-chat.js'), 'utf8');
const body = srv.slice(srv.indexOf('const takeBlocks ='), srv.indexOf('cleanContent = cleanContent.trim();') + 36);
if (!body || body.length < 200) {
  bad('api/brand-voice-chat.js: the block parser this gate executes is gone — re-point the gate at what replaced it.');
} else {
  const run = new Function('content', 'extractJson',
    body + '\nreturn { suggestion, action, memory, cleanContent };');
  const leaks = r => /<brand_update>|<assistant_action>|<coach_memory>|"field"\s*:|"type"\s*:|"note"\s*:/.test(r.cleanContent);

  // A complete reply: everything parsed, nothing leaked.
  let r = run('Here is why.\n<brand_update>\n{"field":"tagline","value":"Boring works","action":"set"}\n</brand_update>', extractJson);
  if (!r.suggestion || r.suggestion.field !== 'tagline') bad('a well-formed suggestion is no longer parsed: ' + JSON.stringify(r.suggestion));
  if (leaks(r)) bad('a well-formed block leaks into the visible reply: ' + JSON.stringify(r.cleanContent));
  if (r.cleanContent !== 'Here is why.') bad('the visible reply is not what the coach actually wrote: ' + JSON.stringify(r.cleanContent));

  // Cut off before the closing tag — the ordinary max_tokens case.
  r = run('Here is why.\n<brand_update>\n{"field":"tagline","value":"Boring works","action":"set"}', extractJson);
  if (leaks(r)) {
    bad('a block cut off before its closing tag is shown to the person as raw JSON: ' +
        JSON.stringify(r.cleanContent.slice(0, 120)) + '. max_tokens is 800 with three blocks to fit, ' +
        'so this is the ordinary truncation case, not an exotic one.');
  }
  if (!r.suggestion) {
    bad('a suggestion whose JSON arrived complete is thrown away just because the closing tag did not.');
  }
  // Cut off mid-JSON: nothing parses, but nothing may leak either.
  r = run('Here is why.\n<brand_update>\n{"field":"tag', extractJson);
  if (leaks(r)) bad('a block cut off mid-JSON still leaks: ' + JSON.stringify(r.cleanContent.slice(0, 120)));
  // The other two tags get the same treatment.
  r = run('Sure.\n<assistant_action>\n{"type":"write_post","label":"Draft it"}', extractJson);
  if (leaks(r)) bad('an unclosed <assistant_action> leaks into the reply: ' + JSON.stringify(r.cleanContent.slice(0, 100)));
  if (!r.action || r.action.type !== 'write_post') bad('an unclosed <assistant_action> is not parsed.');
  r = run('Sure.\n<coach_memory>\n{"note":"sharpened the audience"}', extractJson);
  if (leaks(r)) bad('an unclosed <coach_memory> leaks into the reply: ' + JSON.stringify(r.cleanContent.slice(0, 100)));
  if (r.memory !== 'sharpened the audience') bad('an unclosed <coach_memory> is not parsed.');

  // The validator: a suggestion the client cannot render must never be sent.
  const vm = srv.match(/const validSuggestion = \(j\) => \{[\s\S]*?\n    \};/);
  if (!vm) bad('api/brand-voice-chat.js no longer validates the suggestion shape before sending it.');
  else {
    const valid = new Function(vm[0] + '\nreturn validSuggestion;')();
    for (const j of [null, {}, { value: 'x' }, { field: 123, value: 'x' }, { field: {}, value: 'x' },
                     { field: 'tagline' }, { field: 'tagline', value: {} }, { field: '', value: 'x' },
                     ['tagline', 'x']]) {
      if (valid(j)) bad('validSuggestion accepts a shape the client cannot render: ' + JSON.stringify(j));
    }
    const ok = valid({ field: 'tagline', value: 'Boring works', action: 'set' });
    if (!ok || ok.field !== 'tagline' || ok.value !== 'Boring works') bad('validSuggestion rejects a good suggestion.');
    const arr = valid({ field: 'tones', value: ['deadpan', 'dry'] });
    if (!arr || arr.value !== 'deadpan, dry') {
      bad('validSuggestion throws away a list-shaped value instead of joining it: ' + JSON.stringify(arr));
    }
    if (valid({ field: 'tagline', value: 'x', action: 'drop table' }).action !== undefined) {
      bad('validSuggestion passes an unknown action through to the client.');
    }
  }
}

// ── the client half: one bad message must not kill the chat ───────────────────────────────
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const start = html.indexOf('function bvRenderMessages(');
if (start < 0) bad('bvRenderMessages is gone from app.html.');
else {
  const fnSrc = html.slice(start, html.indexOf('\n}', start) + 2);
  const el = { innerHTML: '<<UNTOUCHED>>' };
  const build = msgs => new Function('document', 'bvState', 'escHtml', 'bvBrainEmpty', 'ICO', 'safeUrl',
    fnSrc + '\nreturn bvRenderMessages;')(
    { getElementById: () => el },
    { messages: msgs, onboardingMode: false },
    s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    () => [], {}, () => '');
  const SHAPES = {
    'a suggestion with no field': { value: 'x' },
    'a suggestion whose field is a number': { field: 123, value: 'x' },
    'a suggestion whose field is an object': { field: { a: 1 }, value: 'x' },
    'a suggestion whose value is an object': { field: 'tagline', value: { a: 1 } },
  };
  for (const [name, sug] of Object.entries(SHAPES)) {
    el.innerHTML = '<<UNTOUCHED>>';
    try {
      build([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'hi', suggestion: sug, suggestionPending: true }])();
      if (el.innerHTML === '<<UNTOUCHED>>') bad(name + ' renders nothing at all — the chat is left blank.');
    } catch (e) {
      bad(name + ' kills the whole chat render: ' + e.message.slice(0, 70) +
          '. The messages are persisted, so the coach window stays dead through reloads.');
    }
  }
  // Control: a good suggestion must still produce a card, or the checks above prove nothing.
  el.innerHTML = '<<UNTOUCHED>>';
  try {
    build([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'hi', suggestion: { field: 'tagline', value: 'Boring works' }, suggestionPending: true }])();
    if (!/bv-suggestion/.test(String(el.innerHTML))) bad('a well-formed suggestion no longer renders its card.');
  } catch (e) { bad('a well-formed suggestion throws: ' + e.message); }
}

if (fails.length) {
  console.error('FAIL:');
  fails.forEach(f => console.error('  - ' + f));
  process.exit(1);
}
console.log('coach chat contract verified: a block cut off before its closing tag is still parsed and ' +
            'still hidden, only a suggestion the client can render is sent, and no shape of suggestion ' +
            'can stop the chat rendering.');
console.log('PASS');
