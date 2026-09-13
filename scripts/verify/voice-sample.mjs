#!/usr/bin/env node
// G41 — voice sample (v649): the founder's own speech is the brain's primary voice reference.
//
// Proves, by EXECUTING the real code wherever it can be lifted out of app.html / api:
//   A. the shared renderer puts the sample ABSOLUTELY LAST in the brand block, capped, labelled as
//      outranking, and renders nothing at all for a blank sample (no bare label);
//   B. the lean-path hydrator maps it (parity itself is proven by lean-payload.mjs);
//   C. bvAskField routes voiceSample to the Settings field and NEVER to the chat — with a negative
//      control proving a normal field still goes to the chat;
//   D. the onboarding step: word count + the soft floor behave, Skip bypasses it, obFinish saves it;
//   E. every plumbing touch point (defaults / settingsToBrand / brandToSettings / getBrandContext
//      ORDER / labels / BRAIN_Q / BRAIN_POWERS / Settings textarea with mic and WITHOUT the
//      "Make it better" polish button).
// Assertions are on behaviour and concepts, never exact copy (v619 lesson).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const req = createRequire(import.meta.url);
const app = fs.readFileSync(path.join(root, 'app.html'), 'utf8');
const brainSrc = fs.readFileSync(path.join(root, 'api/_brain.js'), 'utf8');
const ctxSrc = fs.readFileSync(path.join(root, 'api/_brandctx.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('  FAIL: ' + msg); } };
const between = (s, a, b) => { const i = s.indexOf(a); if (i < 0) return ''; const j = s.indexOf(b, i + a.length); return s.slice(i, j < 0 ? undefined : j); };
// Lift a function out of app.html by its declaration up to a known end marker (string-marker slicing
// is used deliberately — naive brace counting lies on this file, see v638).
const lift = (decl, endMark) => between(app, decl, endMark);

// ── A. renderer ──────────────────────────────────────────────────────────────────────────────
const { fullBrandBlock } = req(path.join(root, 'api/_brain.js'));
const SAMPLE = 'ZQVS so the thing is, right, most people think it is about the powder. It is not. ZQVS';
const bc = {
  brandName: 'ZQNAME', usps: 'ZQUSP', painPoints: 'ZQPAIN', coachNotes: 'ZQNOTES',
  approvedExamples: [{ text: 'ZQWINNER approved post body that is long enough to count as a winner', format: 'video', title: 'w' }],
  learnedSignals: 'ZQSIGNAL', recentTrends: ['ZQTREND'],
  voiceSample: SAMPLE,
};
const out = fullBrandBlock(bc);
const iVoice = out.indexOf('ZQVS'), iWin = out.indexOf('ZQWINNER'), iTrend = out.indexOf('ZQTREND'), iNotes = out.indexOf('ZQNOTES');
ok(iVoice > 0, 'A1 renderer carries the voice sample');
ok(iVoice > iWin && iVoice > iTrend && iVoice > iNotes, 'A2 voice sample is LAST — after winners, trends and coach notes');
ok(out.lastIndexOf('ZQVS') === out.length - out.split('').reverse().join('').indexOf('SVQZ') - 4 || out.slice(iVoice).indexOf('\n   ->') > 0, 'A3 sample is followed only by its own instruction line');
ok(/outranks/i.test(out.slice(iVoice)), 'A4 label says it outranks the descriptions and approved posts');
ok(/moves|rhythm/i.test(out.slice(iVoice)) && /do not copy|never copy/i.test(out.slice(iVoice)), 'A5 instruction is copy-how-it-MOVES, not copy-the-sentences');
const big = fullBrandBlock(Object.assign({}, bc, { voiceSample: 'w '.repeat(6000) }));
const bigSeg = big.slice(big.indexOf('HOW THIS PERSON'));
ok(bigSeg.length < 2200 + 900, 'A6 a 12k-char sample is capped in the prompt (rendered ' + bigSeg.length + ' chars)');
const blank = fullBrandBlock(Object.assign({}, bc, { voiceSample: '   \n ' }));
ok(!/HOW THIS PERSON/.test(blank), 'A7 a blank sample renders NO label at all');
// negative control: the oracle must be able to fail — a renderer that dropped the field would trip A1
ok(!/ZQVS/.test(fullBrandBlock(Object.assign({}, bc, { voiceSample: '' }))), 'A8 control: empty sample -> sentinel absent');

// ── B. lean hydrator ─────────────────────────────────────────────────────────────────────────
ok(/voiceSample:\s*v\.voiceSample\s*\|\|\s*''/.test(ctxSrc), 'B1 _brandctx hydrates voiceSample from voice_extra (parity proven by lean-payload.mjs)');

// ── C. bvAskField routing — executed ─────────────────────────────────────────────────────────
{
  const fn = lift('function bvAskField(key){', '\nfunction bvScanSite');
  ok(fn.length > 100, 'C0 bvAskField lifted');
  let calls = [];
  const env = {
    closeBrandVoice: () => calls.push('close'), openBrain: () => calls.push('openBrain'),
    spScrollToField: (k) => calls.push('scroll:' + k), bvSend: (m) => calls.push('send'),
    setTimeout: (f) => f(), BRAIN_FIELD_LABELS: { painPoints: 'Pain' }, BRAIN_Q: { painPoints: 'q?' },
  };
  const f = new Function(...Object.keys(env), fn + '\nreturn bvAskField;')(...Object.values(env));
  calls = []; f('voiceSample');
  ok(calls.includes('scroll:voiceSample') && !calls.includes('send'), 'C1 voiceSample -> Settings field with mic, NOT the chat (' + calls.join(',') + ')');
  calls = []; f('painPoints');
  ok(calls.includes('send') && !calls.some(c => c.startsWith('scroll')), 'C2 control: a normal field still goes to the chat (' + calls.join(',') + ')');
}

// ── D. onboarding step — executed ────────────────────────────────────────────────────────────
{
  const src = lift('function obNext(fromStep) {', '\nfunction obBack(');
  ok(src.includes('fromStep === 3') && src.includes('obVoiceWords'), 'D0 obNext has a step-3 branch using the word count');
  let box = { value: '' }, errs = [], gone = [];
  const env = {
    document: { getElementById: (id) => id === 'obVoiceSample' ? box : id === 'obVoiceCount' ? { textContent: '' } : { value: 'x', addEventListener() {} } },
    obClearErr: () => {}, obShowErr: (id, msg) => errs.push(msg), obGoToStep: (n) => gone.push(n),
    obSelectedTones: ['a', 'b'], obCommunities: ['a', 'b'],
  };
  const f = new Function(...Object.keys(env), src + '\nreturn { obNext, obVoiceWords, obVoiceCount };')(...Object.values(env));
  box.value = 'five words is not enough'; errs = []; gone = []; f.obNext(3);
  ok(errs.length === 1 && gone.length === 0, 'D1 5 words -> nudged, does not advance');
  box.value = ''; errs = []; gone = []; f.obNext(3);
  ok(errs.length === 1 && /mic/i.test(errs[0]) && gone.length === 0, 'D2 empty -> "tap the mic first", does not advance');
  box.value = 'word '.repeat(40); errs = []; gone = []; f.obNext(3);
  ok(errs.length === 0 && gone[0] === 4, 'D3 40 words -> advances to step 4');
  ok(f.obVoiceWords() === 40, 'D4 word count is a real count (' + f.obVoiceWords() + ')');
  const cnt = { textContent: '' };
  env.document.getElementById = (id) => id === 'obVoiceSample' ? box : id === 'obVoiceCount' ? cnt : { value: 'x' };
  const g = new Function(...Object.keys(env), src + '\nreturn { obVoiceCount };')(...Object.values(env));
  box.value = ''; g.obVoiceCount(); ok(cnt.textContent === '', 'D5 count line is blank at 0 words');
  box.value = 'w '.repeat(30); g.obVoiceCount(); ok(/keep going/i.test(cnt.textContent), 'D6 30 words -> "keep going"');
  box.value = 'w '.repeat(200); g.obVoiceCount(); ok(/plenty/i.test(cnt.textContent), 'D7 200 words -> "plenty"');
}
{
  const step3 = between(app, 'class="onboarding-step" data-step="3"', 'class="onboarding-step" data-step="4"');
  ok(step3.includes('id="obVoiceSample"') && step3.includes("dictateInto('obVoiceSample'"), 'D8 step 3 has the voice box and a mic wired to it');
  ok(/obGoToStep\(4\)/.test(step3) && /skip/i.test(step3), 'D9 step 3 has a Skip that bypasses the floor');
  ok(/OB_TOTAL_STEPS = 4/.test(app), 'D10 wizard is 4 steps');
  ok(/if\(step === 4\) obBuildSummary\(\)/.test(app), 'D11 the summary builds on the FINAL step (4), not the voice step');
  const finale = between(app, 'class="onboarding-step" data-step="4"', '<!-- ===== END ONBOARDING');
  ok(finale.includes('id="obFinishBtn"'), 'D12 the finish button lives on step 4');
  const fin = lift('async function obFinish() {', '\n}\n');
  ok(fin.includes('obVoiceSample') && fin.includes('settings.voiceSample'), 'D13 obFinish reads the box into settings.voiceSample');
}

// ── E. plumbing touch points ─────────────────────────────────────────────────────────────────
ok(/voiceSample:\s*""/.test(app), 'E1 defaultSettings has voiceSample');
ok(/voiceSample:\s*brand\.voice_extra\?\.voiceSample/.test(app), 'E2 brandToSettings reads it from voice_extra');
ok(/voiceSample:\s*settings\.voiceSample\s*\|\|\s*''/.test(between(app, 'function settingsToBrand', '\nfunction ')) || (between(app, 'voice_extra', 'reviewInsights: settings.reviewInsights').length < 4000 && /voiceSample: settings\.voiceSample/.test(app)), 'E3 settingsToBrand writes it to voice_extra');
{
  const gbc = lift('function getBrandContext(', '\n}');
  const iV = gbc.indexOf('voiceSample:'), iC = gbc.indexOf('ctaStyle:'), iR = gbc.indexOf('reviewInsights:');
  ok(iV > 0, 'E4 getBrandContext exposes voiceSample');
  ok(iV > 0 && iV < iC && iV < iR, 'E5 ...placed BEFORE the other deep fields so the shrimp asks for it first');
}
ok(/voiceSample:'How You Actually Talk'/.test(app), 'E6 SP_FIELD_LABELS label');
ok(/voiceSample:'How you actually talk'/.test(app), 'E7 BRAIN_FIELD_LABELS label');
ok(/const BRAIN_Q = \{\s*voiceSample:/.test(app), 'E8 BRAIN_Q has the mic question');
ok(/const BRAIN_POWERS = \{\s*voiceSample:/.test(app), 'E9 BRAIN_POWERS explains why');
{
  const field = between(app, 'data-sp-field="voiceSample"', 'Customer Pain Points');
  ok(field.length > 0 && field.includes("dictateInto('spVoiceSample'"), 'E10 Settings field has its own mic');
  ok(!field.includes("spRenderFieldActions('voiceSample')"), 'E11 Settings field has NO "Make it better" (it would polish the speech away)');
  ok(/'visualStyle','voiceSample'\]\)\}/.test(app), 'E12 the Deep Personalisation fill meter counts it');
}

// ── F. v650 the ongoing voice — executed ─────────────────────────────────────────────────────
{
  const a = app.indexOf('const VOICE_LOG_MAX'), b = app.indexOf('function brainFieldKeys(){');
  const src = app.slice(a, b);
  ok(src.length > 200, 'F0 voiceLogAdd lifted');
  let st = { voiceLog: [], voiceLearn: true }, saves = 0;
  const api = new Function('settings', 'saveSettings', 'renderSettingsPanel', src + '\nreturn {voiceLogAdd, voiceLogRemove};')(st, () => saves++, () => {});
  const long = 'w '.repeat(35).trim();
  ok(api.voiceLogAdd('make it shorter', 'coach', () => true) === false && st.voiceLog.length === 0, 'F1 under 30 words is ignored');
  ok(api.voiceLogAdd(long, 'notebook', () => true) === true && st.voiceLog.length === 1 && saves === 1, 'F2 a real note is kept and saved');
  ok(api.voiceLogAdd(long, 'coach', () => false) === false && st.voiceLog.length === 1, 'F3 brand switched since record-start -> refused (v643 race)');
  st.voiceLearn = false;
  ok(api.voiceLogAdd(long, 'coach', () => true) === false && st.voiceLog.length === 1, 'F4 toggle off -> nothing kept');
  st.voiceLearn = true;
  for (let i = 0; i < 12; i++) api.voiceLogAdd('ZQ' + i + ' ' + long, 'notebook', () => true);
  ok(st.voiceLog.length === 8 && st.voiceLog[7].text.startsWith('ZQ11'), 'F5 rolling cap of 8, newest kept');
  ok(api.voiceLogAdd('x'.repeat(2000) + ' ' + long, 'coach', () => true) && st.voiceLog[7].text.length === 600, 'F6 each note capped at 600 chars');
  // render: notes sit AFTER the sample, newest first, same block; without a sample they ARE the voice
  const notes = [{ ts: 1, src: 'notebook', text: 'ZQN1 ' + long }, { ts: 2, src: 'coach', text: 'ZQN2 ' + long }];
  let o = fullBrandBlock({ brandName: 'B', voiceSample: 'ZQVS the sample', voiceLog: notes, approvedExamples: bc.approvedExamples });
  ok(o.indexOf('ZQVS') < o.indexOf('ZQN2') && o.indexOf('ZQN2') < o.indexOf('ZQN1') && o.indexOf('ZQWINNER') < o.indexOf('ZQVS'), 'F7 notes render after the sample, newest first, both after winners');
  ok((o.match(/THIS IS THE VOICE/g) || []).length === 1, 'F8 the voice rule is stated once, not per block');
  o = fullBrandBlock({ brandName: 'B', voiceLog: notes });
  ok(/HOW THIS PERSON ACTUALLY TALKS — 2 recent/.test(o) && /THIS IS THE VOICE/.test(o), 'F9 with no sample the notes carry the heading and the rule');
  ok(/'voiceLog'/.test(between(app, 'const BRAIN_DERIVED_KEYS', ';')), 'F10 voiceLog is DERIVED — it does not count toward the completeness meters');
  ok(/voiceLog:\s*Array\.isArray\(v\.voiceLog\)/.test(ctxSrc), 'F11 _brandctx hydrates the log for lean callers');
  // every in-scope mic is hooked, gated on a record-start brandGate; the sample fields and meme/product are NOT
  for (const [fn, src] of [['function nbToggleMic() {', 'notebook'], ['function icMicToggle(){', 'catcher'], ['function sparkToggleMic() {', 'catcher'], ['function bvStartMic() {', 'coach'], ['function vlMicToggle(){', 'viral']]) {
    const body = between(app, fn, '\n}\n');
    ok(body.includes("voiceLogAdd(data.text, '" + src + "', _vg)") && body.includes('const _vg = (typeof brandGate'), 'F12 ' + src + ' mic feeds the log, brand-gated at record-start');
  }
  const di = between(app, 'function dictateInto(taId, btn, label){', '\n}\n');
  ok(di.includes("taId==='remixDescription'") && di.includes('voiceLogAdd'), 'F13 dictateInto feeds it ONLY for the Remix description (not the sample fields, not meme/product)');
  ok(!/teleprompter|tpVoice/.test(src) && !between(app, 'function startTpRecord', '\n}\n').includes('voiceLogAdd'), 'F14 the teleprompter never feeds it (that is them reading OUR script)');
  const ui = between(app, 'class="sp-voice-learn"', 'Customer Pain Points');
  ok(ui.includes("updateSetting('voiceLearn'") && ui.includes('voiceLogRemove(') && /Never the teleprompter/.test(ui), 'F15 Settings shows the toggle, the kept notes with a forget button, and says what is excluded');
}

console.log('voice-sample: ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
console.log('voice-sample verification passed');
