// qa.js — AI QA ENGINEER for ANY web app. Point it at a URL and it tests the app
// on a real iPhone-emulated browser: it DISCOVERS the app's features itself (no
// per-app editing), acts like a real user, judges output quality + design/UX, and
// writes a report + a video + an interactive trace.
//
// ── Use on ANY app ────────────────────────────────────────────────────────────
//   cd ~/boring-content-engine-deploy
//   node qa.js https://your-app.com
//   APP_URL=https://your-app.com GOAL="sign up and create a project" node qa.js
//
// First run for a site: a phone window opens — if it needs login, log in in that
// window, then come back and press ENTER. The session is saved PER SITE and reused.
//
// Outputs (named per site, so multiple apps don't clash), in ./qa-runs/ :
//   qa-<site>-video.webm   ← watch it use the app
//   qa-<site>-trace.zip    ← scrub every step:  npx playwright show-trace qa-runs/qa-<site>-trace.zip
//   qa-<site>-report.md    ← per-feature PASS/FAIL, output quality, design/UX, bugs
//
// Needs ONE LLM key in env or ./.env : ANTHROPIC_API_KEY / GROQ_API_KEY / OPENAI_API_KEY / XAI_API_KEY.
// It WILL use the app (fill forms, click Generate, etc.) but NEVER Publish, Buy,
// Checkout, Upgrade, Delete, or Log out.

const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');

const APP = process.argv[2] || process.env.APP_URL;
if (!APP || !/^https?:\/\//.test(APP)) {
  console.log('\nUsage: node qa.js https://your-app.com   (or set APP_URL=...)\n');
  process.exit(2);
}
const ORIGIN = (() => { try { return new URL(APP).origin; } catch (e) { return ''; } })();
const HOST = (() => { try { return new URL(APP).hostname.replace(/[^a-z0-9.]/gi, '_'); } catch (e) { return 'app'; } })();
const OUT = path.join(__dirname, 'qa-runs');
fs.mkdirSync(OUT, { recursive: true });
const AUTH = path.join(OUT, 'auth-' + HOST + '.json');
const REPORT = path.join(OUT, 'qa-' + HOST + '-report.md');
const TRACE = path.join(OUT, 'qa-' + HOST + '-trace.zip');
const VIDEO = path.join(OUT, 'qa-' + HOST + '-video.webm');

const MAX_FEATURES = parseInt(process.env.MAX_FEATURES || '8', 10);
const PER_FEATURE = parseInt(process.env.PER_FEATURE || '6', 10);
const PERSONA = process.env.PERSONA || 'a real first-time user on their phone, curious but not very technical';
const GOAL = process.env.GOAL || 'explore the app and actually use its main features the way a real user would';
const SAMPLE = process.env.SAMPLE || 'This is a small business that helps busy people save time. We keep things simple, honest, and useful — no fluff.';

// ── LLM (auto-detect key; Anthropic gets vision so it can see the screen) ──
function loadEnv() {
  for (const f of ['.env', '.env.local']) {
    const p = path.join(__dirname, f); if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '').split(/\s+/)[0];
    }
  }
}
loadEnv();
function pickLLM() {
  const M = process.env.MODEL;
  if (process.env.ANTHROPIC_API_KEY) return { name: 'Anthropic', kind: 'anthropic', url: 'https://api.anthropic.com/v1/messages',           key: process.env.ANTHROPIC_API_KEY, model: M || 'claude-sonnet-4-6' };
  if (process.env.GROQ_API_KEY)      return { name: 'Groq',      kind: 'openai',    url: 'https://api.groq.com/openai/v1/chat/completions', key: process.env.GROQ_API_KEY,      model: M || 'llama-3.3-70b-versatile' };
  if (process.env.OPENAI_API_KEY)    return { name: 'OpenAI',    kind: 'openai',    url: 'https://api.openai.com/v1/chat/completions',      key: process.env.OPENAI_API_KEY,    model: M || 'gpt-4o-mini' };
  if (process.env.XAI_API_KEY)       return { name: 'xAI',       kind: 'openai',    url: 'https://api.x.ai/v1/chat/completions',            key: process.env.XAI_API_KEY,       model: M || 'grok-2-latest' };
  return null;
}
async function askLLM(llm, system, user, imgB64) {
  const headers = { 'content-type': 'application/json' };
  let body;
  if (llm.kind === 'anthropic') {
    headers['x-api-key'] = llm.key; headers['anthropic-version'] = '2023-06-01';
    const content = imgB64 ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: imgB64 } }, { type: 'text', text: user }] : user;
    body = { model: llm.model, max_tokens: 900, system, messages: [{ role: 'user', content }] };
  } else {
    headers['authorization'] = 'Bearer ' + llm.key;
    const content = imgB64 ? [{ type: 'text', text: user }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + imgB64 } }] : user;
    body = { model: llm.model, temperature: 0.4, messages: [{ role: 'system', content: system }, { role: 'user', content }], response_format: { type: 'json_object' } };
  }
  let r = await fetch(llm.url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok && llm.kind === 'openai') { delete body.response_format; r = await fetch(llm.url, { method: 'POST', headers, body: JSON.stringify(body) }); }
  if (!r.ok) throw new Error('LLM ' + r.status + ' ' + (await r.text()).slice(0, 160));
  const j = await r.json();
  return llm.kind === 'anthropic' ? (j.content && j.content[0] && j.content[0].text) : (j.choices && j.choices[0] && j.choices[0].message.content);
}
function extractJSON(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/```json/gi, '```').replace(/```/g, '');
  const i = s.indexOf('{'); if (i < 0) return null;
  let d = 0, inStr = false, esc = false;
  for (let j = i; j < s.length; j++) { const c = s[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true; else if (c === '{') d++; else if (c === '}') { d--; if (d === 0) return s.slice(i, j + 1); } }
  return null;
}

const SNAPSHOT = `(() => {
  function vis(el){var r=el.getBoundingClientRect();var c=getComputedStyle(el);return r.width>2&&r.height>2&&c.visibility!=='hidden'&&c.display!=='none'&&parseFloat(c.opacity||'1')>0.05;}
  document.querySelectorAll('[data-ai]').forEach(e=>e.removeAttribute('data-ai'));
  var els=[].slice.call(document.querySelectorAll('button,a,input,textarea,select,[role=button],[onclick],[role=tab],[role=menuitem]')).filter(vis).slice(0,60);
  var out=[]; els.forEach(function(el,i){ el.setAttribute('data-ai',i);
    var t=(el.innerText||el.value||el.placeholder||el.getAttribute('aria-label')||el.title||'').replace(/\\s+/g,' ').trim().slice(0,48);
    out.push({i:i, tag:el.tagName.toLowerCase(), type:el.type||'', label:t, disabled:!!el.disabled}); });
  var head=''; var h=document.querySelector('h1,h2'); if(h)head=(h.innerText||'').trim().slice(0,80);
  var main=document.querySelector('main,#app,.app,.view.active,body'); var mainText=(main.innerText||'').replace(/\\s+/g,' ').trim().slice(0,700);
  var busy=/generating|thinking|working|loading|writing|saving|please wait|analyz/i.test(mainText);
  var toasts=[].slice.call(document.querySelectorAll('body *')).filter(function(e){try{var c=getComputedStyle(e);if(c.display==='none'||c.visibility==='hidden')return false;return /toast|error|alert|notice|banner/i.test((e.className||'')+' '+(e.id||''));}catch(x){return false;}}).map(function(e){return (e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,110);}).filter(Boolean).slice(0,3);
  var modal=''; try{ var ms=[].slice.call(document.querySelectorAll('body *')).filter(function(e){try{var c=getComputedStyle(e);if(c.position!=='fixed'&&c.position!=='absolute')return false;if(c.display==='none'||c.visibility==='hidden'||parseFloat(c.opacity||'1')<0.6)return false;var r=e.getBoundingClientRect();return r.width>innerWidth*0.6&&r.height>innerHeight*0.35&&(parseInt(c.zIndex)||0)>=10;}catch(x){return false;}}); if(ms.length)modal=(ms[ms.length-1].innerText||'').replace(/\\s+/g,' ').trim().slice(0,80);}catch(x){}
  return {heading:head, busy:busy, modalOpen:!!modal, modalText:modal, resultText:mainText, toasts:toasts, elements:out};
})()`;

const BLOCK = /publish|post now|check\s?out|buy|order|upgrade|subscribe|pay\b|delete|remove account|cancel plan|log ?out|sign ?out|confirm payment/i;
const results = [], allErrors = [];

(async () => {
  const llm = pickLLM();
  if (!llm) { console.log('\n✗ No LLM key found (ANTHROPIC_API_KEY / GROQ_API_KEY / OPENAI_API_KEY / XAI_API_KEY) in env or ./.env\n'); process.exit(2); }
  console.log(`\nQA target: ${APP}\nDriver: ${llm.name} (${llm.model})  ·  discovering up to ${MAX_FEATURES} features\n`);
  try { const ping = await askLLM(llm, 'Reply JSON only.', 'Reply exactly {"ok":true}'); if (!ping) throw new Error('empty'); }
  catch (e) { console.log(`✗ LLM check failed: ${e.message}\n  → check the key, or MODEL=claude-haiku-4-5-20251001 node qa.js\n`); process.exit(2); }

  const browser = await chromium.launch({ headless: false });
  const haveAuth = fs.existsSync(AUTH);
  const context = await browser.newContext({ ...devices['iPhone 13'], storageState: haveAuth ? AUTH : undefined, recordVideo: { dir: OUT, size: { width: 390, height: 844 } } });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true }).catch(() => {});
  const page = await context.newPage();
  const video = page.video();
  const visionOK = llm.kind === 'anthropic' || /gpt-4o|grok|vision/i.test(llm.model);

  let inflight = 0;
  const IGNORE = /favicon|\.woff|fonts\.g|google-analytics|googletagmanager|doubleclick|hotjar|sentry|posthog|stripe\.com\/v3/i;
  page.on('request', r => { try { if (r.url().includes('/api/')) inflight++; } catch (e) {} });
  const dec = r => { try { if (r.url().includes('/api/')) inflight = Math.max(0, inflight - 1); } catch (e) {} };
  page.on('requestfinished', dec); page.on('requestfailed', dec);
  const waitIdle = async (max = 75000) => { const t0 = Date.now(); let q = Date.now(); while (Date.now() - t0 < max) { if (inflight > 0) q = Date.now(); else if (Date.now() - q > 1400) return; await page.waitForTimeout(200); } };
  let current = 'boot';
  page.on('pageerror', e => allErrors.push({ feature: current, kind: 'JS error', detail: (e && e.message || String(e)).slice(0, 160) }));
  page.on('response', r => { try { const s = r.status(), u = r.url(); if (s < 500 || IGNORE.test(u) || (ORIGIN && !u.startsWith(ORIGIN))) return; allErrors.push({ feature: current, kind: 'HTTP ' + s, detail: u.replace(/\?.*/, '').replace(ORIGIN, '') }); } catch (e) {} });

  const shot = async () => { if (!visionOK) return null; try { return (await page.screenshot({ type: 'png' })).toString('base64'); } catch (e) { return null; } };
  const snap = async () => { try { return await page.evaluate(SNAPSHOT); } catch (e) { return { heading: '', busy: false, modalOpen: false, resultText: '', toasts: [], elements: [] }; } };
  const gotoHome = async () => { await page.goto(APP, { waitUntil: 'domcontentloaded' }).catch(() => {}); await waitIdle(); await page.waitForTimeout(1200); };

  await gotoHome();
  console.log('============================================================');
  console.log(' If the app needs a LOGIN, log in in the phone window now.');
  console.log(' When the app is loaded and ready, come back here and press ENTER.');
  console.log(' (Already logged in? Just press ENTER. Saved per-site for next time.)');
  console.log('============================================================\n');
  await new Promise(r => process.stdin.once('data', r));
  try { await context.storageState({ path: AUTH }); } catch (e) {}
  await waitIdle();

  // ── DISCOVER the app's features ──
  const home = await snap();
  let features = [];
  try {
    const raw = await askLLM(llm,
      'You are a QA lead mapping a web app to test it. From the screenshot + the numbered elements, list the main FEATURES/sections a real user would use — nav tabs, menu items, primary tools/pages. Skip pure login/logout/legal/footer noise. Reply ONLY JSON: {"features":[{"name":"short feature name"}]} (max ' + MAX_FEATURES + ').',
      `App: ${APP}\nHome screen:\n${JSON.stringify(home).slice(0, 6500)}\n\nList the main features to QA.`, await shot());
    const j = JSON.parse(extractJSON(raw) || raw);
    features = (j.features || []).slice(0, MAX_FEATURES).map(f => (typeof f === 'string' ? f : f.name)).filter(Boolean);
  } catch (e) { console.log('  (discovery failed: ' + e.message.slice(0, 80) + ') — testing the home screen only'); }
  if (!features.length) features = ['Home screen'];
  console.log('Features found: ' + features.join(', ') + '\n');

  const SYSTEM =
`You are a senior QA engineer testing ONE feature of a mobile web app, acting as ${PERSONA}. Overall goal: ${GOAL}. You judge FUNCTION, OUTPUT QUALITY and DESIGN/UX — you are shown a SCREENSHOT each turn, use your eyes.
Steps: (1) NAVIGATE to the feature under test by tapping the matching nav/menu item (open a "More"/menu if needed). (2) If a popup covers the screen, close it (×/close/skip) or use it — don't click behind it. (3) If it needs input, TYPE REAL, on-topic text (use the SAMPLE if it fits) — never gibberish. (4) Trigger the main action and WAIT (the harness waits for network). (5) SCROLL to read the full result. (6) VERIFY it works AND critique quality + whether the screen is visually sound (no overlap, cut-off, broken layout, unclosable popup, tiny targets, vague errors). If it needs a prerequisite you don't have (API key, paid plan) → blocked. (7) Verdict.
Each turn you get JSON {heading, busy, modalOpen, resultText (READ+JUDGE), toasts, numbered elements} + the screenshot. Choose ONE action.
Reply ONLY JSON:
{"thought":"...","action":"click|type|scroll|verdict","target":<number|null>,"text":"<for type>","verdict":{"status":"pass|fail|blocked","expected":"...","observed":"...","quality":"output-quality judgement (or n/a)","ux":"design/UX issues you SAW or 'clean'","bugs":["..."]}}
Rules: type only into real text fields. NEVER click Publish, Checkout, Buy, Upgrade, Subscribe, Delete, or Log out. Be a tough reviewer. Verdict within ~${PER_FEATURE} actions. Can't reach it = blocked.`;

  for (const fname of features) {
    current = fname;
    const errAt = allErrors.length;
    await gotoHome();
    let verdict = null, actions = 0, output = ''; const flow = [];
    while (actions < PER_FEATURE && !verdict) {
      actions++;
      const s = await snap();
      if (s.resultText && s.resultText.length > output.length) output = s.resultText;
      const user = `FEATURE UNDER TEST: ${fname}\nGet to it, then test it end-to-end.\n\nSAMPLE text if an input is needed:\n"${SAMPLE}"\n\nCurrent screen:\n${JSON.stringify(s).slice(0, 6500)}\n\nActions so far: ${flow.slice(-5).join(' | ') || 'none'}\nYour next action (or a verdict):`;
      let act, lastErr;
      for (let t = 0; t < 2 && !act; t++) { try { act = JSON.parse(extractJSON(await askLLM(llm, SYSTEM, user, await shot())) || '{}'); } catch (e) { lastErr = e; await page.waitForTimeout(700); } }
      if (!act || !act.action) { verdict = { status: 'blocked', observed: 'driver failed: ' + (lastErr ? lastErr.message.slice(0, 100) : '?') }; break; }
      if (act.action === 'verdict') { verdict = act.verdict || { status: 'blocked', observed: 'no verdict' }; break; }
      const el = (act.target != null) ? s.elements.find(e => e.i === act.target) : null;
      const label = el ? el.label : '';
      flow.push(`${act.action}${label ? ' "' + label + '"' : ''}`);
      console.log(`  ${fname} · ${act.action}${label ? ' "' + label + '"' : ''}${act.thought ? '  — ' + act.thought.slice(0, 50) : ''}`);
      if (el && act.action === 'click' && BLOCK.test(label)) { flow.push('(blocked ' + label + ')'); continue; }
      try {
        if (act.action === 'click' && el) { const h = await page.$(`[data-ai="${act.target}"]`); if (h) { await h.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {}); await h.click({ timeout: 3000 }).catch(async () => { await page.evaluate(i => { const x = document.querySelector('[data-ai="' + i + '"]'); x && x.click(); }, act.target); }); } }
        else if (act.action === 'type' && el) { await page.fill(`[data-ai="${act.target}"]`, String(act.text || '')).catch(async () => { const h = await page.$(`[data-ai="${act.target}"]`); if (h) { await h.click().catch(() => {}); await page.keyboard.type(String(act.text || '')); } }); }
        else if (act.action === 'scroll') { await page.mouse.wheel(0, 600); }
      } catch (e) { flow.push('(err ' + e.message.slice(0, 40) + ')'); }
      await page.waitForTimeout(500); await waitIdle();
    }
    if (!verdict) verdict = { status: 'blocked', observed: 'ran out of actions' };
    const errs = allErrors.slice(errAt);
    if (errs.length && verdict.status === 'pass') verdict.status = 'fail';
    results.push({ feature: fname, status: verdict.status || 'blocked', expected: verdict.expected || '', observed: verdict.observed || '', quality: verdict.quality || '', ux: (verdict.ux && !/^clean$/i.test(verdict.ux)) ? verdict.ux : '', output, bugs: verdict.bugs || [], errors: errs });
    const icon = verdict.status === 'pass' ? '✅' : verdict.status === 'fail' ? '❌' : '⚠️';
    console.log(`  ${icon} ${fname}: ${verdict.status}${(verdict.bugs && verdict.bugs.length) ? ' — ' + verdict.bugs[0] : ''}\n`);
    try { await page.screenshot({ path: path.join(OUT, 'qa-' + HOST + '-' + fname.replace(/[^a-z0-9]+/gi, '-').slice(0, 24) + '.png'), fullPage: true }); } catch (e) {}
  }

  // ── report ──
  const pass = results.filter(r => r.status === 'pass').length, fail = results.filter(r => r.status === 'fail').length, blk = results.filter(r => r.status === 'blocked').length;
  let md = `# QA pass — ${APP} — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}\n\n`;
  md += `Driver: ${llm.name} (${llm.model}) · iPhone 13 (390px)\n\n**✅ ${pass} passed · ❌ ${fail} failed · ⚠️ ${blk} blocked · ${allErrors.length} hard error(s)**\n\n`;
  md += `Watch: \`qa-runs/qa-${HOST}-video.webm\` · Scrub: \`npx playwright show-trace qa-runs/qa-${HOST}-trace.zip\`\n\n| Feature | Result | Notes |\n|---|---|---|\n`;
  for (const r of results) { const icon = r.status === 'pass' ? '✅ pass' : r.status === 'fail' ? '❌ fail' : '⚠️ blocked'; md += `| ${r.feature} | ${icon} | ${((r.bugs.length ? r.bugs.join('; ') : r.observed) || '').replace(/\|/g, '/').slice(0, 120)} |\n`; }
  md += `\n`;
  for (const r of results) {
    if (r.status === 'pass' && !r.bugs.length && !r.errors.length && !r.quality && !r.ux) continue;
    md += `## ${r.feature} — ${r.status}\n`;
    if (r.expected) md += `- **Expected:** ${r.expected}\n`;
    if (r.observed) md += `- **Observed:** ${r.observed}\n`;
    if (r.quality) md += `- **Output quality:** ${r.quality}\n`;
    if (r.ux) md += `- **Design/UX:** ${r.ux}\n`;
    for (const b of r.bugs) md += `- 🐞 ${b}\n`;
    for (const e of r.errors) md += `- 🔴 ${e.kind} — ${e.detail}\n`;
    md += `\n`;
  }
  fs.writeFileSync(REPORT, md);
  await context.tracing.stop({ path: TRACE }).catch(() => {});
  await context.close();
  if (video) { try { await video.saveAs(VIDEO); } catch (e) {} try { await video.delete(); } catch (e) {} }
  await browser.close();
  console.log(`────────────────────────────────────────`);
  console.log(`  ✅ ${pass} · ❌ ${fail} · ⚠️ ${blk} · ${allErrors.length} hard error(s)`);
  console.log(`  📄 ${path.relative(process.cwd(), REPORT)}   ▶ video + ⏱ trace in qa-runs/`);
  console.log(`────────────────────────────────────────\n`);
  process.exit(fail > 0 || allErrors.length > 0 ? 1 : 0);
})();
