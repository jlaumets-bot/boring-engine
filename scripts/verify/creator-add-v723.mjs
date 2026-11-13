#!/usr/bin/env node
// GATE v723 — "i cant add creators" (owner 2026-11-13). Adding a creator on the phone start screen worked, but the screen
// looked exactly the same afterwards (nothing listed who you follow), so it read as broken. EXECUTED in headless Chromium
// on the real app.html + clean.css against the in-memory fake Supabase; every /api/* stubbed; no network, no AI.
//   1  the phone start screen lists the followed TikTok creators ("Your creators", "N of 5", one row per @handle)
//   2  "+ Add creator" → paste a profile link → Add: the new @handle appears in the list, the count goes up, a toast says "Added @handle"
//   3  the feed call sends tzOffsetMin (retry times in the user's own clock, not UTC)
//   4  at 5 creators the add button is gone but all 5 are still listed
// RUN: node scripts/verify/creator-add-v723.mjs     EXPECT: "CREATOR ADD V723 OK", exit 0.
import { ok, result, boot, closeAll, guard } from './_v718-harness.mjs';
const G = guard('creator-add-v723', 90000);
try {
  const { page, calls, errors, close } = await boot({ w: 390, h: 844,
    api: { 'creator-feed': { __status: 502, body: { error: 'The creator feed is offline on our side right now. Your creators are saved — paste a TikTok link for now.', code: 'apify_failed' } } } });
  await page.evaluate(() => { if (activeView !== 'create') switchView('create'); });
  await page.waitForTimeout(800);
  const s1 = await page.evaluate(() => ({ head: (document.querySelector('#hyFeed .hy-crh') || {}).textContent || '', rows: Array.from(document.querySelectorAll('#hyFeed .hy-cr .hy-ch')).map(e => e.textContent) }));
  ok(/Your creators/.test(s1.head) && /2 of 5/.test(s1.head) && s1.rows.join(',') === '@mondaydotcom,@studioops', '1 the start screen lists who you follow (got ' + JSON.stringify(s1) + ')');
  await page.evaluate(() => { document.querySelector('#hyFeed .hy-add').click(); });
  await page.waitForTimeout(200);
  await page.fill('#hyAddLink', 'https://www.tiktok.com/@garyvee');
  await page.evaluate(() => document.querySelector('.hy-addf').requestSubmit());
  await page.waitForTimeout(600);
  const s2 = await page.evaluate(() => ({ head: (document.querySelector('#hyFeed .hy-crh') || {}).textContent || '', rows: Array.from(document.querySelectorAll('#hyFeed .hy-cr .hy-ch')).map(e => e.textContent), toast: document.body.innerText }));
  ok(s2.rows.includes('@garyvee') && /3 of 5/.test(s2.head), '2a the added creator shows up in the list right away (got ' + JSON.stringify({ head: s2.head, rows: s2.rows }) + ')');
  ok(/Added @garyvee/.test(s2.toast), '2b a toast says "Added @garyvee"');
  const feedCalls = calls.filter(c => c.name === 'creator-feed');
  ok(feedCalls.length > 0 && feedCalls.every(c => c.body && Number.isFinite(c.body.tzOffsetMin)), '3 every feed call sends tzOffsetMin (' + feedCalls.length + ' calls)');
  for (const h of ['one', 'two']) {
    await page.evaluate(() => { document.querySelector('#hyFeed .hy-add').click(); });
    await page.waitForTimeout(150);
    await page.fill('#hyAddLink', 'https://www.tiktok.com/@' + h);
    await page.evaluate(() => document.querySelector('.hy-addf').requestSubmit());
    await page.waitForTimeout(400);
  }
  const s4 = await page.evaluate(() => ({ add: !!document.querySelector('#hyFeed .hy-add'), n: document.querySelectorAll('#hyFeed .hy-cr').length, head: (document.querySelector('#hyFeed .hy-crh') || {}).textContent || '' }));
  ok(!s4.add && s4.n === 5 && /5 of 5/.test(s4.head), '4 at 5 creators: no add button, all 5 listed (got ' + JSON.stringify(s4) + ')');
  if (process.env.V723_SHOTS) await page.screenshot({ path: process.env.V723_SHOTS + '/phone-creators.png' });
  ok(!errors.length, '5 no page errors (' + errors.slice(0, 2).join(' | ') + ')');
  await close();
} catch (e) { ok(false, 'the gate crashed: ' + (e && e.stack || e)); }
await closeAll();
const { fail, n } = result();
G.done();
if (fail) { console.log('\n' + fail + ' of ' + n + ' checks FAILED'); process.exit(1); }
console.log('\nCREATOR ADD V723 OK (' + n + ' checks)');
