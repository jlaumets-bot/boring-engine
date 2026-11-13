#!/usr/bin/env node
// GATE v725 — the shrimp stops popping up by itself (owner 2026-11-13: "popping up right away and suggesting always the same
// something about reviews is super annoying"). EXECUTED in headless Chromium on the real app.html + clean.css (fake Supabase,
// every /api/* stubbed, no network, no AI), plus a source scan for the old self-started lines.
//   1  after launch the shrimp opens NO bubble by itself (waits past the old 6 s pop)
//   2  the old self-started lines are gone ("ideas waiting", "scripts ready", "review your new ideas", "-day streak", the launch pop)
//   3  a finished "Make it yours" version schedules the setup nudge (mascotSetupNudgeSoon)
//   4  the nudge says "Finish your setup for better results." with [Finish setup][Later]; "Finish setup" opens Brand Voice
//   5  after it showed once, it stays quiet for 3 days (per brand); after that it can show again
// RUN: node scripts/verify/mascot-quiet-v725.mjs     EXPECT: "MASCOT QUIET V725 OK", exit 0.
import fs from 'node:fs'; import path from 'node:path';
import { ROOT, ok, result, boot, closeAll, guard } from './_v718-harness.mjs';
const G = guard('mascot-quiet-v725', 100000);
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
ok(!/ideas waiting — review them in Ideas|scripts ready — open Pipeline|Scroll down to review your new ideas|-day streak — consistency|Press me \\u2014 I'll tell you what I'm doing back here/.test(html), '2 the old self-started shrimp lines are gone from app.html');
const REMIX = { remix: { remixTitle: 'T', remixHook: 'H', remixScript: 'Script words here.', remixCaption: 'c', remixHashtags: '#x', remixFormat: 'video' } };
try {
  const { page, errors, close } = await boot({ w: 390, h: 844, api: { remix: REMIX, 'creator-feed': { ok: true, creators: [], videos: [] } } });
  await page.waitForTimeout(8000);
  const s1 = await page.evaluate(() => ({ active: document.getElementById('mascotWrap').classList.contains('active'), q: typeof getBrainQuestion === 'function' }));
  ok(!s1.active, '1 no bubble opened by itself 8 s after launch');
  // 3: a finished version schedules the nudge
  const s3 = await page.evaluate(async () => {
    let n = 0; const orig = window.mascotSetupNudgeSoon; window.mascotSetupNudgeSoon = () => { n++; };
    if (activeView !== 'create') switchView('create');
    hyNewThread({ kind: 'tiktok', url: 'https://www.tiktok.com/@studioops/video/7341', creator: 'studioops', text: 'Plan your week on Friday.' });
    const r = await hyTwist('remix');
    window.mascotSetupNudgeSoon = orig;
    return { r, n };
  });
  ok(s3.r === true && s3.n === 1, '3 a finished version schedules the setup nudge once (got ' + JSON.stringify(s3) + ')');
  // 4 + 5
  const s4 = await page.evaluate(() => {
    try { localStorage.removeItem(bkey('setup_nudge_at')); } catch (e) {}
    let opened = 0; const ob = window.openBrandVoice; window.openBrandVoice = function(){ opened++; };
    const shown = window.mascotSetupNudge();
    const text = document.getElementById('mascotText').textContent;
    const btns = Array.from(document.querySelectorAll('#mascotActions button')).map(b => b.textContent);
    const again = (() => { mascotDismiss(); return window.mascotSetupNudge(); })();
    // 3 days later it may show again; then press "Finish setup"
    lsSet('setup_nudge_at', String(Date.now() - 3 * 24 * 3600 * 1000 - 1000));
    const later = window.mascotSetupNudge();
    const go = document.getElementById('snGo'); if (go) go.click();
    window.openBrandVoice = ob;
    return { shown, text, btns, again, later, opened, active: document.getElementById('mascotWrap').classList.contains('active') };
  });
  ok(s4.shown === true && /^Finish your setup for better results\./.test(s4.text) && s4.btns.join('|') === 'Finish setup|Later', '4 the nudge text and buttons (got ' + JSON.stringify({ shown: s4.shown, text: s4.text, btns: s4.btns }) + ')');
  ok(s4.opened === 1 && !s4.active, '4 "Finish setup" closes the bubble and opens Brand Voice');
  ok(s4.again === false && s4.later === true, '5 quiet for 3 days after it showed, then allowed again (got ' + JSON.stringify({ again: s4.again, later: s4.later }) + ')');
  ok(!errors.length, '6 no page errors (' + errors.slice(0, 2).join(' | ') + ')');
  await close();
} catch (e) { ok(false, 'the gate crashed: ' + (e && e.stack || e)); }
await closeAll();
const { fail, n } = result();
G.done();
if (fail) { console.log('\n' + fail + ' of ' + n + ' checks FAILED'); process.exit(1); }
console.log('\nMASCOT QUIET V725 OK (' + n + ' checks)');
