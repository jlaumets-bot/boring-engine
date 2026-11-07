#!/usr/bin/env node
// GATE (v718 onboarding as a chat, owner-approved mockups design-options/desktop-onboarding/ O1–O5 + O2-desktop, 2026-11-07). EXECUTED in
// headless Chromium: the real app.html + clean.css as a brand-new user (no brand) against the in-memory fake Supabase; /api/crawl-brand,
// /api/transcribe-voice and the microphone are stubbed (a fake getUserMedia + MediaRecorder) — no AI, no network, no real database.
//   1  the chat replaces the old screens: "N of 5", a back arrow, "Hi! I'm Content Shrimp…", "What's your brand's website?", the
//      "No website? Set it up by talking" link (the existing obSkipCrawl path).
//   2  the website → the existing crawl (obCrawlWebsite, same request) → "Here's what I found": name, what you sell, who for, tone and
//      topic chips (× removes, "+ add" adds); typed fixes land in the old fields (obBrandName, obAudience …), unknown text asks which part.
//   3  the existing minimum (2 tones, 2 topics, name, who for, different) still blocks "Looks right", with a gentle line.
//   4  the voice talk: big mic → dictateInto (the same transcription) with the 60 s cap, a "0:00 / 1:00" timer, the words saved as the
//      voice sample; mic denied / no words → a friendly message with Try again + Type instead + Skip (never a dead end).
//   5  creators: @handles / links → chips, ≤5 (the shared creator rule), "Follow them" → obPendingCreators; Skip → none.
//   6  endings: creators added → obFinish saves the brand + bookmarks and lands on the main chat with the feed; skipped → the pre-v712
//      first-post ending (Quick Post); a link pasted on step 5 goes straight into the main chat thread.
//   7  crawl failure (out of credits) → a message with Try again and "Set it up by talking" (step 2 by hand); back arrow works.
//   8  desktop: one centred chat column, no sidebar; "a minute or two" is gone app-wide.
// RUN: node scripts/verify/onboarding-chat-v718.mjs        EXPECT: "ONBOARDING CHAT V718 OK", exit 0.
import fs from 'node:fs'; import path from 'node:path';
import { ROOT, ok, result, boot, closeAll, guard } from './_v718-harness.mjs';
const G = guard('onboarding-chat-v718', 115000);
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const CRAWL = { brandInfo: { brandName: 'Boring Electrolytes', tagline: 'Electrolyte powder with no sugar and no candy taste.', targetAudience: 'People who forget to drink water',
  usps: 'Tastes like water that works', tones: ['deadpan', 'casual', 'minimalist'], communities: ['Hydration', 'Morning routines', 'Sports drinks'] } };
const WORDS = 'Honestly it is supposed to taste like water that works and people think electrolytes are only for marathon runners but most of us just forget to drink anything before lunch so we made it boring on purpose with no sugar and no candy taste at all, one scoop and you are done';
const MIC = `(() => {
  window.__mic = 'ok';
  try { Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => {
    if (window.__mic === 'deny') { const e = new Error('Permission denied'); e.name = 'NotAllowedError'; throw e; }
    return { getTracks: () => [{ stop(){} }] }; } } }); } catch (e) {}
  class FakeRec { constructor(){ this.state = 'inactive'; } static isTypeSupported(t){ return /webm/.test(t); }
    start(){ this.state = 'recording'; } stop(){ this.state = 'inactive'; const b = new Blob([new Uint8Array(4000)], { type: 'audio/webm' });
      setTimeout(() => { this.ondataavailable && this.ondataavailable({ data: b }); this.onstop && this.onstop(); }, 20); } }
  window.MediaRecorder = FakeRec;
})();`;
const step = page => page.evaluate(() => _obc && _obc.step);
const txt = page => page.evaluate(() => document.getElementById('obcThread').innerText);
async function toStep2(page){ await page.fill('#obcIn', 'boringelectrolytes.com'); await page.press('#obcIn', 'Enter'); await page.waitForFunction(() => _obc && _obc.step === 2, null, { timeout: 15000 }); }
async function spyDict(page){ await page.evaluate(() => { const o = window.dictateInto; window.__dict = []; window.dictateInto = function () { window.__dict.push([...arguments]); return o.apply(this, arguments); }; }); }
try {
  // ---------------- A · the whole walk with creators (phone) ----------------
  {
    const api = { 'crawl-brand': CRAWL, 'transcribe-voice': { text: WORDS }, 'creator-feed': { ok: true, creators: [], videos: [] } };
    const { page, calls, errors, close } = await boot({ w: 390, h: 844, nobrand: true, api, init: MIC });
    const s1 = await page.evaluate(() => { const o = document.getElementById('onboardingOverlay'); return { on: !o.classList.contains('hidden') && o.classList.contains('obc-on'),
      old: getComputedStyle(o.querySelector('.onboarding-container')).display, chat: getComputedStyle(document.getElementById('obChat')).display,
      st: document.getElementById('obcStep').textContent, back: document.getElementById('obcBack').hidden, t: document.getElementById('obcThread').innerText, ph: document.getElementById('obcIn').placeholder }; });
    ok(s1.on && s1.old === 'none' && s1.chat === 'flex', '1: the chat shows and the old screens are hidden');
    ok(s1.st === '1 of 5' && s1.back, '1: "1 of 5", no back arrow on the first step');
    ok(/Hi! I.m Content Shrimp\. I write posts that sound like you\./.test(s1.t) && /What.s your brand.s website\?/.test(s1.t) && /No website\? Set it up by talking/.test(s1.t), '1: the greeting, the question and the no-website link');
    await toStep2(page);
    const cr = calls.find(c => c.name === 'crawl-brand');
    ok(cr && cr.body && cr.body.url === 'https://boringelectrolytes.com', '2: the website goes through the existing crawl request (obCrawlWebsite)');
    let t = await txt(page);
    ok(/Here.s what I found/.test(t) && /Boring Electrolytes/.test(t) && /no candy taste/.test(t) && /For people who forget to drink water/.test(t), '2: the card shows the name, what you sell and who for');
    const chips = await page.evaluate(() => [...document.querySelectorAll('.obc-found .obc-x')].map(e => e.textContent.trim()));
    ok(['Deadpan', 'Casual', 'Minimalist', 'Hydration', 'Morning routines', 'Sports drinks'].every(c => chips.includes(c)), '2: tone and topic chips from the crawl (' + chips.join(', ') + ')');
    ok(await page.evaluate(() => document.getElementById('obcStep').textContent === '2 of 5' && !document.getElementById('obcBack').hidden && document.getElementById('obcIn').placeholder === 'Or tell me what to fix…'), '2: "2 of 5", back arrow, "Or tell me what to fix…"');
    // min chips
    await page.evaluate(() => { obcTone('deadpan'); obcTone('casual'); });
    ok(await page.evaluate(() => obSelectedTones.length === 1 && !!document.querySelector('.obc-found .obc-min')), '3: below 2 tones the card says so gently');
    await page.evaluate(() => obcLooksRight());
    ok(await step(page) === 2 && /2 tones/.test(await page.evaluate(() => (document.querySelector('.obc-now > .obc-gentle') || {}).textContent || '')), '3: "Looks right" is refused with the existing minimum (2 tones)');
    await page.click('.obc-found .obc-add'); await page.click('.obc-found .obc-opts .obc-opt');
    ok(await page.evaluate(() => obSelectedTones.length === 2), '3: "+ add" adds a tone back');
    await page.evaluate(() => { obcTopicX(0); obcTopicX(0); });
    await page.evaluate(() => obcLooksRight());
    ok(await step(page) === 2 && /2 topics/.test(await page.evaluate(() => document.querySelector('.obc-now > .obc-gentle').textContent)), '3: …and 2 topics');
    await page.fill('#obcIn', 'add topic Sleep'); await page.press('#obcIn', 'Enter');
    ok(await page.evaluate(() => obCommunities.length === 2 && obCommunities.includes('Sleep')), '2: a typed "add topic …" adds it through obAddCommunity');
    await page.fill('#obcIn', 'name is Boring Co'); await page.press('#obcIn', 'Enter');
    ok(await page.evaluate(() => document.getElementById('obBrandName').value === 'Boring Co' && document.querySelector('.obc-found h3').textContent === 'Boring Co'), '2: a typed fix lands in the existing field (obBrandName)');
    await page.fill('#obcIn', 'busy parents who hate sugar'); await page.press('#obcIn', 'Enter');
    ok(/Which part is that\?/.test(await txt(page)), '2: text it cannot place asks which part');
    await page.evaluate(() => { const b = [...document.querySelectorAll('.obc-which .obc-opt')].find(x => /Who it/.test(x.textContent)); b.click(); });
    ok(await page.evaluate(() => document.getElementById('obAudience').value === 'busy parents who hate sugar'), '2: …and puts it in that field (obAudience)');
    await page.evaluate(() => obcLooksRight());
    ok(await step(page) === 3, '3: with the minimum met, "Looks right" moves on (obNext(2))');
    t = await txt(page);
    ok(/Talk to me for a minute about your brand/.test(t) && /0:00 \/ 1:00/.test(t) && /or type instead/.test(t) && /Skip for now/.test(t), '4: the talk step: big mic, "0:00 / 1:00", type instead, skip');
    await spyDict(page);
    await page.click('#obcMic'); await page.waitForFunction(() => /^0:0[1-9]/.test((document.getElementById('obcTimer') || {}).textContent || ''), null, { timeout: 6000 }).catch(() => {});
    const rec = await page.evaluate(() => ({ st: _obc.rec, pressed: document.getElementById('obcMic').getAttribute('aria-pressed'), tm: document.getElementById('obcTimer').textContent, args: window.__dict[0] }));
    ok(rec.st === 2 && rec.pressed === 'true' && /^0:0[1-9] \/ 1:00$/.test(rec.tm), '4: recording: the mic is on and the timer runs (' + rec.tm + ')');
    ok(rec.args && rec.args[0] === 'obVoiceSample' && rec.args[3] && rec.args[3].maxMs === 60000, '4: the existing dictateInto, into obVoiceSample, capped at 60 s');
    await page.click('#obcMic'); await page.waitForFunction(() => _obc.step === 4, null, { timeout: 8000 }).catch(() => {});
    ok(await step(page) === 4 && calls.some(c => c.name === 'transcribe-voice'), '4: stopping transcribes through /api/transcribe-voice and moves on');
    t = await txt(page);
    ok(/Voice · 0:0\d/.test(t) && /Got it\. That.s how you.ll sound\./.test(t) && /Who do you follow on TikTok\?/.test(t), '4: the voice bubble, "Got it…", "Who do you follow on TikTok?"');
    await page.click('#obcBack'); await page.waitForTimeout(100);
    ok(await step(page) === 3, '7: the back arrow goes back a step');
    await page.evaluate(() => obcVoiceDone()); await page.waitForTimeout(100);
    ok(await step(page) === 4, '4: the words kept → on again');
    await page.fill('#obcIn', '@morningcup tiktok.com/@studioops'); await page.press('#obcIn', 'Enter');
    ok(await page.evaluate(() => _obc.creators.length === 2 && [...document.querySelectorAll('.obc-now .obc-x')].map(e => e.textContent.trim()).join(',') === '@morningcup,@studioops'), '5: handles and links become chips');
    await page.fill('#obcIn', 'instagram.com/someone'); await page.press('#obcIn', 'Enter');
    ok(/isn.t a TikTok profile/.test(await txt(page)) && await page.evaluate(() => _obc.creators.length === 2), '5: a non-TikTok link is refused in plain words');
    await page.fill('#obcIn', '@a1 @a2 @a3 @a4'); await page.press('#obcIn', 'Enter');
    ok(await page.evaluate(() => _obc.creators.length === 5) && (await txt(page)).includes('You can follow up to 5 creators'), '5: at most 5 (the shared rule\'s words)');
    await page.evaluate(() => { obcCreatorX(4); obcCreatorX(3); obcCreatorX(2); });
    await page.fill('#obcIn', '');
    await page.evaluate(() => obcFollow()); await page.waitForTimeout(100);
    ok(await step(page) === 5 && await page.evaluate(() => obPendingCreators.length === 2), '5: "Follow them" → obNext(4) → obPendingCreators');
    t = await txt(page);
    ok(/Your brand brain is ready\./.test(t) && /Paste a TikTok to try it/.test(t) && !!(await page.$('#obcPaste')) && /Show their videos/.test(t), '6: step 5: the paste button and "Show their videos"');
    ok(await page.evaluate(() => [...document.querySelectorAll('.obc-now .obc-xs')].map(e => e.textContent).join(',') === '@morningcup,@studioops'), '6: step 5 shows the creators they just added as chips');
    await page.evaluate(() => { const b = [...document.querySelectorAll('.obc-now .obc-b')].find(x => /Show their videos/.test(x.textContent)); b.click(); });
    await page.waitForFunction(() => document.getElementById('onboardingOverlay').classList.contains('hidden') && activeView === 'create', null, { timeout: 15000 }).catch(() => {});
    const fin = await page.evaluate(() => { const DB = window.__FAKE_DB, bk = (DB.competitors || []).find(r => r.name === '__bookmarks__');
      return { hid: document.getElementById('onboardingOverlay').classList.contains('hidden'), view: activeView, brand: (DB.brands || []).map(b => b.brand_name), bk: bk ? bk.notes : '',
        voice: settings.voiceSample || '', aud: settings.targetAudience, handles: cfFollowedHandles(null) }; });
    ok(fin.hid && fin.view === 'create', '6: creators added → lands on the main chat (got ' + fin.view + ')');
    ok(fin.brand.includes('Boring Co') && /morningcup/.test(fin.bk) && /studioops/.test(fin.bk) && fin.handles.length === 2, '6: obFinish saved the brand row and the creators as bookmarks');
    ok(fin.voice.split(/\s+/).length >= 25 && fin.aud === 'busy parents who hate sugar', '6: the voice sample and the typed fix were saved');
    ok(calls.some(c => c.name === 'creator-feed'), '6: the main chat asked for their feed');
    ok(!errors.length, 'A: no page errors (' + errors.slice(0, 2).join(' | ') + ')');
    await close();
  }
  // ---------------- B · skip everything → the pre-v712 first-post ending ----------------
  {
    const { page, errors, close } = await boot({ w: 390, h: 844, nobrand: true, api: { 'crawl-brand': CRAWL }, init: MIC });
    await toStep2(page); await page.evaluate(() => obcLooksRight());
    await page.evaluate(() => { const b = [...document.querySelectorAll('.obc-link')].find(x => /Skip for now/.test(x.textContent)); b.click(); });
    ok(await step(page) === 4 && /No problem/.test(await txt(page)), 'B: skipping the talk moves on, no dead end');
    await page.evaluate(() => { const b = [...document.querySelectorAll('.obc-now .obc-b')].find(x => /Skip for now/.test(x.textContent)); b.click(); });
    ok(await step(page) === 5 && await page.evaluate(() => obPendingCreators.length === 0) && /Write my first post/.test(await txt(page)), 'B: skipping creators → step 5 offers the first post');
    await page.evaluate(() => { const b = [...document.querySelectorAll('.obc-now .obc-b')].find(x => /Write my first post/.test(x.textContent)); b.click(); });
    await page.waitForFunction(() => document.getElementById('onboardingOverlay').classList.contains('hidden'), null, { timeout: 15000 }).catch(() => {});
    ok(await page.evaluate(() => activeView === 'today' && !settings.voiceSample), 'B: skipped → the pre-v712 ending (Quick Post, first post), no voice sample saved');
    ok(!errors.length, 'B: no page errors (' + errors.slice(0, 2).join(' | ') + ')');
    await close();
  }
  // ---------------- C · a link pasted on step 5 goes straight into the main chat ----------------
  {
    const { page, calls, close } = await boot({ w: 390, h: 844, nobrand: true, api: { 'crawl-brand': CRAWL, 'transcribe-url': { text: 'Their words.' } }, init: MIC });
    await toStep2(page); await page.evaluate(() => { obcLooksRight(); obcVoiceSkip(); obcCreatorsSkip(); });
    await page.fill('#obcIn', 'https://www.tiktok.com/@studioops/video/7341'); await page.press('#obcIn', 'Enter');
    await page.waitForFunction(() => document.getElementById('onboardingOverlay').classList.contains('hidden') && activeView === 'create', null, { timeout: 15000 }).catch(() => {});
    const c = await page.evaluate(() => ({ view: activeView, url: _hy.t && _hy.t.src.url }));
    ok(c.view === 'create' && /7341/.test(c.url || ''), 'C: the pasted TikTok lands in the main chat thread (not the first-post ending)');
    ok(!calls.some(x => /^(write|angles|generate-ideas)$/.test(x.name)), 'C: no first post was generated on top');
    await close();
  }
  // ---------------- D · crawl failure (out of credits) + mic denied + no words ----------------
  {
    const api = { 'crawl-brand': { __status: 402, body: { error: 'limit_reached' } }, 'transcribe-voice': {} };
    const { page, errors, close } = await boot({ w: 390, h: 844, nobrand: true, api, init: MIC });
    await page.fill('#obcIn', 'boringelectrolytes.com'); await page.press('#obcIn', 'Enter');
    await page.waitForFunction(() => _obc && _obc.err, null, { timeout: 15000 }).catch(() => {});
    ok(await page.evaluate(() => !!document.getElementById('csUpgradeOverlay')), 'D: the 402 still opens the existing upgrade sheet (the global fetch wrapper)');
    await page.evaluate(() => { const u = document.getElementById('csUpgradeOverlay'); if (u) u.remove(); });   // the person closes it
    let t = await txt(page);
    ok(/out of credits/.test(t) && await page.evaluate(() => { const b = [...document.querySelectorAll('.obc-err .obc-b')].map(x => x.textContent); return b.includes('Try again') && b.includes('Set it up by talking'); }), 'D: a failed crawl says why, with Try again and "Set it up by talking"');
    ok(/No website\?/.test(t) && await page.evaluate(() => !document.getElementById('obcDock').hidden), 'D: the input and the no-website link stay (never a dead end)');
    await page.evaluate(() => { const b = [...document.querySelectorAll('.obc-err .obc-b')].find(x => /talking/.test(x.textContent)); b.click(); });
    ok(await step(page) === 2 && await page.evaluate(() => !!document.getElementById('obcF-obBrandName')) && /Tell me about your brand/.test(await txt(page)), 'D: the no-website way opens step 2 to fill in (obSkipCrawl)');
    await page.fill('#obcF-obBrandName', 'Hand Made Co');
    ok(await page.evaluate(() => document.getElementById('obBrandName').value === 'Hand Made Co'), 'D: the fill-in fields write the existing ones');
    await page.evaluate(() => { obcSet('obAudience', 'Runners'); obcSet('obUsps', 'No sugar'); obcTone('casual'); obcTone('witty'); obcTopicPush('Running'); obcTopicPush('Sleep'); obcLooksRight(); });
    ok(await step(page) === 3, 'D: filled by hand → the talk step');
    await page.evaluate(() => { window.__mic = 'deny'; }); await spyDict(page);
    await page.click('#obcMic'); await page.waitForFunction(() => !!_obc.voiceErr, null, { timeout: 8000 }).catch(() => {});
    t = await txt(page);
    ok(/can.t reach your microphone/.test(t) && /Try again/.test(t) && /Type instead/.test(t) && /Skip for now/.test(t), 'D: mic denied → a friendly message with Try again, Type instead and Skip');
    await page.evaluate(() => { window.__mic = 'ok'; }); await page.click('#obcMic'); await page.waitForTimeout(600); await page.click('#obcMic');
    await page.waitForFunction(() => _obc.rec === 0 && !!_obc.voiceErr, null, { timeout: 8000 }).catch(() => {});
    ok(/couldn.t make out any words/.test(await txt(page)), 'D: a take with no words → try again or type instead');
    await page.evaluate(() => obcTypeVoice()); await page.fill('#obcVoiceTa', 'too short');
    await page.evaluate(() => obcVoiceDone());
    ok(await step(page) === 3 && /A bit more/.test(await page.evaluate(() => document.querySelector('.obc-now > .obc-gentle').textContent)), 'D: typed but too short → a gentle line (the existing 25-word check)');
    await page.fill('#obcVoiceTa', WORDS); await page.evaluate(() => obcVoiceDone());
    ok(await step(page) === 4, 'D: typed enough → on to creators');
    ok(!errors.length, 'D: no page errors (' + errors.slice(0, 2).join(' | ') + ')');
    await close();
  }
  // ---------------- G · Back / Skip during a take: a late transcription never moves the chat ----------------
  {
    const api = { 'crawl-brand': CRAWL, 'transcribe-voice': { text: WORDS } };
    let { page, close } = await boot({ w: 390, h: 844, nobrand: true, api, init: MIC });
    await toStep2(page); await page.evaluate(() => obcLooksRight());
    await page.click('#obcMic'); await page.waitForFunction(() => _obc.rec === 2, null, { timeout: 6000 }).catch(() => {});
    await page.evaluate(() => obcBack());
    await page.evaluate(() => { obcTone('deadpan'); obcTone('casual'); });   // now below the 2-tone minimum
    await page.waitForTimeout(1500);
    ok(await page.evaluate(() => _obc.step === 2 && _obc.rec === 0 && obSelectedTones.length === 1), 'G: Back during a take → the late words never jump past step 2\'s minimum');
    // the second guard on its own: an end-of-take that still looks live (words in, a start time) arriving on step 2 changes nothing
    ok(await page.evaluate(() => { _obc.rec = 2; _obc.recStart = Date.now() - 2000; _obc.before = 0; obcMicEnd(); return _obc.step === 2 && _obc.rec === 0 && !_obc.voiceErr; }), 'G: obcMicEnd off step 3 never calls obNext(3)');
    await close();
    ({ page, close } = await boot({ w: 390, h: 844, nobrand: true, api, init: MIC }));
    await toStep2(page); await page.evaluate(() => obcLooksRight());
    await page.click('#obcMic'); await page.waitForFunction(() => _obc.rec === 2, null, { timeout: 6000 }).catch(() => {});
    await page.evaluate(() => obcVoiceSkip());
    await page.waitForTimeout(1500);
    ok(await page.evaluate(() => _obc.step === 4 && _obc.rec === 0 && _obc.voiceSkipped) && /No problem/.test(await txt(page)), 'G: Skip during a take → stays on creators, the late answer is ignored');
    await close();
  }
  // ---------------- E · desktop: one centred chat column, no sidebar ----------------
  {
    const { page, close } = await boot({ w: 1440, h: 900, nobrand: true, api: { 'crawl-brand': CRAWL }, init: MIC });
    await toStep2(page);
    const d = await page.evaluate(() => { const c = document.querySelector('#obcThread .obc-col').getBoundingClientRect(), hit = document.elementFromPoint(100, 300);
      return { w: Math.round(c.width), mid: Math.round(c.left + c.width / 2), side: !!(hit && hit.closest('#desktopSidebar')), inOv: !!(hit && hit.closest('#onboardingOverlay')), st: document.getElementById('obcStep').textContent, logo: getComputedStyle(document.querySelector('.obc-logo')).display }; });
    ok(d.w <= 640 && d.w >= 560 && Math.abs(d.mid - 720) <= 2 && !d.side && d.inOv, 'E: desktop = one centred column (' + d.w + 'px at ' + d.mid + '), the sidebar is covered');
    ok(d.st === '2 of 5' && d.logo === 'flex', 'E: the desktop top bar: Content Shrimp + "2 of 5"');
    await close();
  }
  // ---------------- F · copy + wiring (source) ----------------
  {
    const roots = fs.readdirSync(ROOT).filter(f => /\.(html|txt|md)$/.test(f) && !/^(CLAUDE|BUG-AUDIT|HANDOFF|MOBILE|GATES|QA|SIMPLIFY|DISTRIBUTION|ENV|STRIPE|PRICING|FULL|desktop-user|mobile|landing|linkedin)/i.test(f));
    const hits = roots.filter(f => /a minute or two/i.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    ok(!/a minute or two/i.test(html) && !hits.length, 'F: "a minute or two" is gone from the app (' + (hits.join(', ') || 'none in ' + roots.length + ' files') + ')');
    ok(/talk for a minute\. Rough is fine/.test(html) && /Talk to me for a minute about your brand/.test(html), 'F: the copy says "a minute"');
    ok(/const OBC_MIC_MAX = 60000;/.test(html) && /maxMs: OBC_MIC_MAX/.test(html), 'F: the 60 s cap stays');
    ok(/const _obLand = \(typeof obcTakeLanding === 'function'\) \? obcTakeLanding\(\) : '';/.test(html) && /\} else if \(_obFollowed > 0\) \{/.test(html), 'F: obFinish keeps both v712 endings after the step-5 paste branch');
  }
} catch (e) { ok(false, 'the gate crashed: ' + (e && e.stack || e)); }
await closeAll();
const { fail, n } = result();
G.done();
if (fail) { console.log('\n' + fail + ' of ' + n + ' checks FAILED'); process.exit(1); }
console.log('\nONBOARDING CHAT V718 OK (' + n + ' checks)');
