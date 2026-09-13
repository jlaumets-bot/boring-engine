// measure-consistency.js — enumerate every button/card/input across all views and
// cluster them so size/radius/color outliers are provable, not eyeballed.
// Runs true mobile (iPhone 13, 390px) by default; DESKTOP=1 for 1200px.
// Injects the in-progress v261 CSS deltas so it measures the INTENDED final state.
const { chromium, devices } = require('playwright');
const path = require('path');
const fs = require('fs');

const APP = process.env.APP_URL || 'https://contentshrimp.com/app.html';
const AUTH = path.join(__dirname, 'mobile-shots', '.auth.json');
const IS_DESKTOP = !!process.env.DESKTOP;

// The CSS changes already made in app.html (not yet deployed) — inject so measurement
// reflects the real intended state on the live (older) deploy.
const DELTAS = `
:root{--success:#4A6B5A;--warning:#B45309;}
.gen-btn.hero{border-radius:999px;background:#E7DAF9;color:#16130F;border:1.5px solid #16130F;}
@media (hover:hover){.export-btn:hover{color:#fff;}}
.filter-chip.fmt-statement{background:#E0E4E8;color:#4A5560;border-color:transparent;}
.filter-chip.fmt-statement.active{background:#4A5560;color:#fff;border-color:#4A5560;}
.generate-ideas-btn{padding:14px 28px;font-size:15px;gap:8px;}
.generate-ideas-btn svg{width:16px;height:16px;}
`;

(async () => {
  if (!fs.existsSync(AUTH)) { console.log('NO_AUTH'); process.exit(0); }
  const browser = await chromium.launch({ headless: true });
  const ctxOpts = { storageState: AUTH };
  if (!IS_DESKTOP) Object.assign(ctxOpts, devices['iPhone 13']);
  else Object.assign(ctxOpts, { viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
  const context = await browser.newContext(ctxOpts);

  await context.addInitScript((deltas) => {
    try { localStorage.setItem('bc_tour_done', '1'); } catch (e) {}
    try { window.__onbDismissed = true; } catch (e) {}
    const add = () => { try { const s=document.createElement('style'); s.textContent=deltas; document.head.appendChild(s);}catch(e){} };
    if (document.head) add(); else document.addEventListener('DOMContentLoaded', add);
    const KILL=/finish these last fields|Welcome to Content Shrimp|Quick tour|WHAT EACH FIELD POWERS|Almost there/i;
    function nuke(){ try{ document.querySelectorAll('.tour-overlay,#csOnbCard,.pwa-banner,#pwaGuideOverlay').forEach(e=>e.remove());
      document.querySelectorAll('div').forEach(e=>{ const t=e.textContent||''; if(t.length<600&&KILL.test(t)){ let n=e; for(let i=0;i<6&&n&&n.parentElement;i++){ const p=n.parentElement; let pos=''; try{pos=getComputedStyle(p).position;}catch(x){} if(pos==='fixed'||(p.className||'').toString().match(/overlay|modal|backdrop|onb/i)){p.remove();return;} n=p;} } });
    }catch(e){} }
    const start=()=>{ nuke(); try{ new MutationObserver(nuke).observe(document.body,{childList:true,subtree:true}); }catch(e){} setInterval(nuke,800); };
    if(document.body) start(); else document.addEventListener('DOMContentLoaded', start);
  }, DELTAS);

  const page = await context.newPage();
  await page.goto(APP, { waitUntil: 'domcontentloaded' }).catch(()=>{});
  await page.waitForTimeout(3000);

  const loggedIn = await page.evaluate(() => !!document.querySelector('.nav-tab, #navTabs .nav-tab, [id^=view-]') && typeof window.switchView === 'function');
  if (!loggedIn) { console.log('NOT_LOGGED_IN at ' + APP); await browser.close(); process.exit(0); }

  const collect = () => page.evaluate(() => {
    const px = v => Math.round(parseFloat(v)||0);
    const vis = el => { const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>1&&r.height>1&&s.visibility!=='hidden'&&s.display!=='none'&&r.height<420; };
    const btnSel = 'button,.gen-btn,.tp-generate-btn,.generate-ideas-btn,[role=button],.detail-btn,.pipe-btn,.filter-chip,.tp-cat,.tp-deliv-chip,.meme-mode-btn,.meme-style-btn,.export-btn,.blog-generate-btn,.header-btn,.ob-btn,.source-tab,.create-sub-tab,.search-tag';
    const btns=[]; const seen=new Set();
    document.querySelectorAll(btnSel).forEach(el=>{ if(!vis(el))return; const s=getComputedStyle(el); const r=el.getBoundingClientRect();
      const o={ t:(el.textContent||'').trim().replace(/\s+/g,' ').slice(0,18), w:Math.round(r.width), h:Math.round(r.height), fs:px(s.fontSize), fw:s.fontWeight,
        pv:px(s.paddingTop)+'/'+px(s.paddingBottom), ph:px(s.paddingLeft)+'/'+px(s.paddingRight),
        br: (s.borderTopLeftRadius.indexOf('%')>-1?'50%':px(s.borderTopLeftRadius)),
        bg:s.backgroundColor, col:s.color, bw:px(s.borderTopWidth),
        cls:(el.className||'').toString().split(' ').filter(Boolean).slice(0,2).join('.') };
      const k=o.cls+o.t+o.w+o.h; if(seen.has(k))return; seen.add(k); btns.push(o); });
    const ins=[]; document.querySelectorAll('input:not([type=file]):not([type=hidden]),textarea,select').forEach(el=>{ if(!vis(el))return; const s=getComputedStyle(el); const r=el.getBoundingClientRect();
      ins.push({ tag:el.tagName.toLowerCase(), h:Math.round(r.height), fs:px(s.fontSize), pv:px(s.paddingTop), ph:px(s.paddingLeft), br:px(s.borderTopLeftRadius), bw:px(s.borderTopWidth), cls:(el.className||'').toString().split(' ').filter(Boolean)[0]||'' }); });
    const cards=[]; const cseen=new Set();
    document.querySelectorAll('[class*=card],[class*=panel],[class*=hero],[class*=modal],[class*=box],[class*=-sheet]').forEach(el=>{ if(!vis(el))return; const s=getComputedStyle(el); const r=el.getBoundingClientRect(); if(r.height<30||r.width<80)return;
      const o={ br:px(s.borderTopLeftRadius), pv:px(s.paddingTop), ph:px(s.paddingLeft), bw:px(s.borderTopWidth), bc:s.borderTopColor, sh:(s.boxShadow&&s.boxShadow!=='none')?'y':'n', cls:(el.className||'').toString().split(' ').filter(Boolean).slice(0,2).join('.') };
      const k=o.cls+o.br+o.pv; if(cseen.has(k))return; cseen.add(k); cards.push(o); });
    return { btns, ins, cards };
  });

  const views = ['today','ideas','pipeline','create','blog','notebook','assistant','settings'];
  const all = { btns:[], ins:[], cards:[] };
  for (const v of views) {
    try { await page.evaluate(view=>{ try{ switchView(view);}catch(e){}
      if(view==='ideas'){ try{ var s=document.getElementById('proToolsSection'); if(s){s.style.display='block';s.style.opacity='1';} document.querySelectorAll('#proToolsSection *').forEach(e=>{e.style.opacity='1';e.style.transform='none';}); }catch(e){} }
      if(view==='create'){ try{ ['remixStage2','remixStage2b'].forEach(id=>{var e=document.getElementById(id); if(e)e.style.display='block';}); }catch(e){} }
    }, v); } catch(e){}
    await page.waitForTimeout(700);
    const d = await collect();
    d.btns.forEach(b=>{ b.view=v; all.btns.push(b); });
    d.ins.forEach(b=>{ b.view=v; all.ins.push(b); });
    d.cards.forEach(b=>{ b.view=v; all.cards.push(b); });
  }
  await browser.close();

  // ---- cluster analysis ----
  const norm = s => (s||'').replace(/\s/g,'');
  // Buttons grouped by visual type (bg|color) -> distinct size/radius variants
  const fam = {};
  all.btns.forEach(b=>{
    const key = norm(b.bg)+' | '+norm(b.col)+' | bw'+b.bw;
    const variant = 'fs'+b.fs+' pv'+b.pv+' ph'+b.ph+' r'+b.br;
    fam[key] = fam[key] || {};
    fam[key][variant] = fam[key][variant] || { n:0, ex:[], views:new Set() };
    fam[key][variant].n++; if(fam[key][variant].ex.length<4) fam[key][variant].ex.push(b.t+'@'+b.view); fam[key][variant].views.add(b.view);
  });
  const MODE = IS_DESKTOP ? 'DESKTOP(1200)' : 'MOBILE(390)';
  console.log('\n================ BUTTON FAMILIES — '+MODE+' ================');
  Object.keys(fam).sort().forEach(k=>{
    const variants = Object.keys(fam[k]);
    const flag = variants.length>1 ? '  <-- INCONSISTENT ('+variants.length+' sizes)' : '';
    console.log('\nBG/COL '+k+flag);
    variants.forEach(vk=>{ const o=fam[k][vk]; console.log('   ['+vk+']  x'+o.n+'  '+o.ex.join(', ')); });
  });

  // Inputs: distinct height/fs/radius
  const inv = {};
  all.ins.forEach(i=>{ const key='h'+i.h+' fs'+i.fs+' r'+i.br+' bw'+i.bw; inv[key]=inv[key]||{n:0,ex:[]}; inv[key].n++; if(inv[key].ex.length<4)inv[key].ex.push((i.cls||i.tag)+'@'+i.view); });
  console.log('\n================ INPUTS/SELECTS/TEXTAREAS — '+MODE+' ================');
  Object.keys(inv).sort().forEach(k=>console.log('   ['+k+']  x'+inv[k].n+'  '+inv[k].ex.join(', ')));

  // Cards: distinct radius
  const cr = {};
  all.cards.forEach(c=>{ const key='r'+c.br; cr[key]=cr[key]||{n:0,ex:new Set()}; cr[key].n++; if(cr[key].ex.size<6)cr[key].ex.add(c.cls+'@'+c.view); });
  console.log('\n================ CARD/PANEL RADII — '+MODE+' ================');
  Object.keys(cr).sort((a,b)=>parseInt(a.slice(1))-parseInt(b.slice(1))).forEach(k=>console.log('   ['+k+'px]  x'+cr[k].n+'  '+[...cr[k].ex].join(', ')));

  console.log('\nDONE '+MODE+' — buttons:'+all.btns.length+' inputs:'+all.ins.length+' cards:'+all.cards.length);
})();
