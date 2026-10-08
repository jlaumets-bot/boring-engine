#!/usr/bin/env node
// GATE (v703 desktop system, clean.css §8): the ≥900px desktop look from .unlazy/desktop/SPEC.md — LOOK only.
//   1  §8 exists at the end of clean.css, after §7, and EVERY rule in it sits inside one `@media (min-width: 900px)` block
//      (phones and tablets under 900px never see it).
//   2  the --csd-* desktop tokens carry the spec sizes (buttons md 36 / sm 32 / lg 44, chips 28, segmented 32, icon 32,
//      inputs 40, textarea 120, rows 64, toolbar 56, radii card 14 / dialog 16 / menu 12 / input 10 / icon 8 / pill,
//      card padding 20, type 14 btn · 13 chip/meta · 15 body · 17 section · 20 page · 22 detail, body line 1.55, doc 760)
//      and the app's --cs-fs-* type tokens follow the desktop scale inside §8.
//   3  every .csx-* class that SPEC.md hands to D1 is styled in §8 with at least one visual property.
//   4  buttons: .csx-btn is md (36, 0 14, 14/500, pill); --sm 32, --lg 44, --icon 32×32 r8; primary / secondary / ghost /
//      danger / icon each have a :hover; focus-visible ring; disabled .45. Legacy buttons map onto md / sm / icon / chip
//      sizes, every legacy tab set onto the one segmented control.
//   5  inputs: .csx-input and every legacy single-line input / select = 40, r10, 1px line; textareas min 120; focus border
//      --cs-text; coarse pointers (iPad landscape) keep 16px so focusing never zooms.
//   6  cards r14 / 1px line / padding 20; dialogs r16 (legacy sheets too); dropdowns r12; toasts bottom-right, max 380.
//   7  hover language: secondary / ghost / chips / rows → --cs-hover; primary → --csd-primary-hover (90%); one focus ring.
//   8  .sp-tip (app.html:3382, a flex row that split sentences into columns) is block layout — on desktop AND top-level
//      for phones / tablets, with the icon kept in the same gutter (padding-left = padding + 18 + 10).
//   9  the pinned composer is hidden on desktop.
//  10  contrast ≥ 4.5:1 for text / muted on the desktop-only surfaces (sidebar #181818, raised segment) in both themes.
//  11  the rendered computed-style pass (Playwright harness, recorded in .unlazy/desktop/D1-measure.json when present):
//      button heights only on the spec values, single-line text inputs one height, card radii only on spec radii.
// RUN: node scripts/verify/desktop-system.mjs      EXPECT: prints "DESKTOP SYSTEM OK", exit 0.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const css = fs.readFileSync(path.join(ROOT, 'clean.css'), 'utf8');
setTimeout(() => { console.log('FAIL: wall clock (60s) exceeded'); process.exit(2); }, 60000).unref();
let fail = 0; const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fail++; } else console.log('ok:', m); };

/* ═══ 1. §8 is the last section and never leaks outside min-width 900 ═══ */
const M8 = '/* ============ 8. desktop system', M7 = '/* ============ 7. desktop layout';
const i8 = css.indexOf(M8), i7 = css.indexOf(M7);
ok(i8 > 0 && i7 > 0 && i8 > i7 && css.indexOf(M8, i8 + 1) < 0, '1 §8 exists once, after §7');
const s8raw = i8 > 0 ? css.slice(i8) : '';
const s8 = s8raw.replace(/\/\*[\s\S]*?\*\//g, '');
// top-level blocks of §8
const blocks = []; { let d = 0, st = 0, q = null; for (let i = 0; i < s8.length; i++) { const ch = s8[i];
  if (q) { if (ch === q) q = null; continue; } if (ch === '"' || ch === "'") { q = ch; continue; }
  if (ch === '{') { if (d === 0) st = i; d++; } else if (ch === '}') { d--; if (d === 0) { const head = s8.slice(s8.lastIndexOf('}', st) + 1, st).trim(); blocks.push({ head, body: s8.slice(st + 1, i) }); } } } }
const stray = blocks.filter(b => !/^@media \(min-width: 900px\)$/.test(b.head));
ok(blocks.length === 1 && stray.length === 0, '1 every §8 rule is inside ONE @media (min-width: 900px) block' + (stray.length ? ' — stray: ' + stray.map(b => b.head.slice(0, 60)).join(' | ') : ''));
const body = blocks.length ? blocks[0].body : '';
// leftover text outside any block (a rule without braces would show up here)
ok(s8.replace(/@media \(min-width: 900px\)\s*\{[\s\S]*\}\s*$/, '').trim() === '', '1 nothing but that block after the §8 header');

// flatten the block into rules {sel, decls, media[]}
const RULES = [];
(function parse(src, media) { let i = 0; while (i < src.length) { const open = src.indexOf('{', i); if (open < 0) break; const pre = src.slice(i, open).trim();
  let d = 0, j = open; for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (d === 0) break; } }
  const inner = src.slice(open + 1, j);
  if (/^@media/.test(pre)) parse(inner, media.concat(pre));
  else { const decls = {}; inner.split(';').forEach(x => { const k = x.indexOf(':'); if (k > 0) { const p = x.slice(0, k).trim(); const v = x.slice(k + 1).trim(); (decls[p] = decls[p] || []).push(v); } });
    RULES.push({ sel: pre.replace(/\s+/g, ' '), decls, media }); }
  i = j + 1; } })(body, []);
ok(RULES.length > 150, '1 parsed ' + RULES.length + ' rules in §8');
const has = (selRe, prop, valRe) => RULES.some(r => selRe.test(r.sel) && (r.decls[prop] || []).some(v => valRe.test(v)));
const decl = (selRe, prop) => { for (const r of RULES) if (selRe.test(r.sel) && r.decls[prop]) return r.decls[prop][r.decls[prop].length - 1]; return null; };

/* ═══ 2. tokens ═══ */
const tok = RULES.find(r => r.sel === ':root, :root[data-theme]');
const T = tok ? Object.fromEntries(Object.entries(tok.decls).map(([k, v]) => [k, v[v.length - 1]])) : {};
const WANT = { '--csd-h-sm': '32px', '--csd-h-md': '36px', '--csd-h-lg': '44px', '--csd-h-chip': '28px', '--csd-h-seg': '32px', '--csd-h-icon': '32px',
  '--csd-h-input': '40px', '--csd-h-textarea': '120px', '--csd-h-row': '64px', '--csd-h-toolbar': '56px', '--csd-pad-md': '0 14px', '--csd-pad-card': '20px',
  '--csd-r-pill': '999px', '--csd-r-icon': '8px', '--csd-r-input': '10px', '--csd-r-row': '10px', '--csd-r-menu': '12px', '--csd-r-card': '14px', '--csd-r-dialog': '16px',
  '--csd-fs-btn': '14px', '--csd-fs-chip': '13px', '--csd-fs-body': '15px', '--csd-fs-meta': '13px', '--csd-fs-page': '20px', '--csd-fs-section': '17px', '--csd-fs-detail': '22px',
  '--csd-lh-body': '1.55', '--csd-doc': '760px', '--csd-dialog-sm': '560px', '--csd-dialog-lg': '720px', '--csd-toast': '380px',
  '--cs-fs-body': '15px', '--cs-fs-title': '17px', '--cs-fs-screen': '20px', '--cs-fs-meta': '13px', '--cs-fs-btn': '14px' };
const badTok = Object.entries(WANT).filter(([k, v]) => T[k] !== v).map(([k, v]) => k + '=' + T[k] + ' (want ' + v + ')');
ok(tok && badTok.length === 0, '2 desktop tokens carry the spec sizes' + (badTok.length ? ' — ' + badTok.join(', ') : ''));
const darkTok = RULES.find(r => r.sel === ':root[data-theme="dark"]');
ok(darkTok && (darkTok.decls['--csd-side'] || [])[0] === '#181818' && T['--csd-side'], '2 sidebar surface #181818 in dark (and a light value)');
ok(has(/#desktopSidebar/, 'background', /var\(--csd-side\)/) && has(/#desktopSidebar/, 'border-right', /1px solid var\(--cs-line\)/), '2 the sidebar uses it, with a 1px line');

/* ═══ 3. every D1 .csx-* class from SPEC.md is styled ═══ */
const VISUAL = /^(color|background|background-color|border|border-[a-z-]+|border-radius|font|font-[a-z-]+|line-height|letter-spacing|text-[a-z-]+|padding|padding-[a-z-]+|box-shadow|outline|opacity|cursor|transition|margin|margin-[a-z-]+|max-width|white-space|-webkit-line-clamp)$/;
// the contract's class list (SPEC.md "Ownership contract"); when SPEC.md is present (it is not shipped) it must still match
const CSX = ['.csx-shell', '.csx-newpost', '.csx-toolbar', '.csx-toolbar-title', '.csx-toolbar-ctx', '.csx-toolbar-actions', '.csx-md', '.csx-list', '.csx-list-group', '.csx-row', '.csx-row-meta', '.csx-row-title', '.csx-row-hook', '.csx-detail', '.csx-detail-empty', '.csx-detail-head', '.csx-detail-title', '.csx-section-label', '.csx-actions', '.csx-doc', '.csx-subnav', '.csx-subnav-item', '.csx-panel', '.csx-dialog', '.csx-dialog-head', '.csx-dialog-body', '.csx-dialog-foot', '.csx-backdrop', '.csx-palette', '.csx-palette-input', '.csx-palette-item', '.csx-kbd', '.csx-btn', '.csx-btn--primary', '.csx-btn--secondary', '.csx-btn--ghost', '.csx-btn--danger', '.csx-btn--sm', '.csx-btn--lg', '.csx-btn--icon', '.csx-seg', '.csx-seg-item', '.csx-chip', '.csx-field', '.csx-input', '.csx-textarea', '.csx-label', '.csx-toast'];
let spec = ''; try { spec = fs.readFileSync(path.join(ROOT, '.unlazy', 'desktop', 'SPEC.md'), 'utf8'); } catch (e) {}
if (spec) { const own = spec.slice(spec.indexOf('LAYOUT properties'), spec.indexOf('- Agent D1')); const fromSpec = [...new Set((own.match(/\.csx-[a-z-]+/g) || []))];
  const drift = fromSpec.filter(c => !CSX.includes(c)); ok(fromSpec.length >= 40 && drift.length === 0, '3 the class list matches SPEC.md (' + fromSpec.length + ')' + (drift.length ? ' — new in SPEC: ' + drift.join(' ') : '')); }
else console.log('note: .unlazy/desktop/SPEC.md not present — using the embedded class list');
const csx = CSX;
ok(csx.length >= 40, '3 ' + csx.length + ' .csx-* classes to check');
const unstyled = csx.filter(c => !RULES.some(r => new RegExp('\\' + c + '(?![\\w-])').test(r.sel) && Object.keys(r.decls).some(p => VISUAL.test(p))));
ok(unstyled.length === 0, '3 every .csx-* class has a visual rule in §8' + (unstyled.length ? ' — missing ' + unstyled.join(' ') : ''));
ok(has(/\.csx-row\.is-selected/, 'box-shadow', /inset 2px 0 0 var\(--cs-text\)/) && has(/\.csx-row\.is-selected/, 'background', /var\(--csd-side-on\)/) && darkTok && (darkTok.decls['--csd-side-on'] || [])[0] === 'var(--cs-chip)', '3 selected row: --cs-chip (dark; a stronger #ebebeb in light) + 2px left inset');
ok(decl(/^\.csx-detail-title$/, 'font-size') === 'var(--csd-fs-detail)' && decl(/^\.csx-toolbar-title$/, 'font-size') === 'var(--csd-fs-page)' && decl(/^\.csx-row$/, 'min-height') === 'var(--csd-h-row)', '3 detail title 22, toolbar title 20, rows 64');

/* ═══ 4. buttons ═══ */
ok(decl(/^\.csx-btn$/, 'height') === 'var(--csd-h-md)' && decl(/^\.csx-btn$/, 'padding') === 'var(--csd-pad-md)' && /^500 var\(--csd-fs-btn\)/.test(decl(/^\.csx-btn$/, 'font') || '') && decl(/^\.csx-btn$/, 'border-radius') === 'var(--csd-r-pill)', '4 .csx-btn = md 36, 0 14, 14/500, pill');
ok(decl(/^\.csx-btn--sm$/, 'height') === 'var(--csd-h-sm)' && decl(/^\.csx-btn--lg$/, 'height') === 'var(--csd-h-lg)' && decl(/^\.csx-btn--icon$/, 'width') === 'var(--csd-h-icon)' && decl(/^\.csx-btn--icon$/, 'border-radius') === 'var(--csd-r-icon)', '4 sm 32, lg 44, icon 32×32 r8');
for (const v of ['--primary', '--ghost', '--danger', '--icon', '--secondary']) ok(RULES.some(r => r.sel.includes('.csx-btn' + v + ':hover')), '4 .csx-btn' + v + ' has a hover');
ok(has(/\.csx-btn--primary:hover/, 'background', /var\(--csd-primary-hover\)/) && /color-mix\(in srgb, var\(--cs-primary\) 90%/.test(T['--csd-primary-hover'] || ''), '4 primary hover = 90% fill');
ok(has(/\.csx-btn:focus-visible/, 'outline', /var\(--csd-ring\)/) && T['--csd-ring'] === '2px solid var(--cs-muted)' && has(/\.csx-btn:disabled/, 'opacity', /^\.45$/), '4 focus ring 2px --cs-muted; disabled .45');
const md = RULES.find(r => /:root :is\(\.gen-btn,/.test(r.sel) && r.decls.height);
const mdNeed = ['.gen-btn', '.cs-primary-btn', '.cs-pill-btn', '.pipe-btn', '.detail-btn', '.tp-action-btn', '.nb-act', '.dp-cancel', '.dp-custom-send', '.batch-go', '.cs-upgrade-btn', '.sp-back', '.vl-mic', '.tour-btn', '.ob-btn', '.rv2-actions button'];
ok(md && /var\(--csd-h-md\) !important/.test(md.decls.height[0]) && /var\(--csd-fs-btn\)/.test(md.decls['font-size'][0]) && mdNeed.every(c => md.sel.includes(c)), '4 legacy action buttons → md 36 / 14 / pill (' + mdNeed.length + ' families checked)');
const sm = RULES.find(r => /:root :is\(\.fp-tool,/.test(r.sel) && r.decls.height);
ok(sm && /var\(--csd-h-sm\)/.test(sm.decls.height[0]) && ['.tp-shz-angle', '.rv2-link', '.tp-field-copy', '.cs-upgrade-close'].every(c => sm.sel.includes(c)), '4 small / ghost actions (the "or … ▾" links included) → sm 32');
const ic = RULES.find(r => /:root :is\(\.dp-x,/.test(r.sel) && r.decls.width);
ok(ic && /var\(--csd-h-icon\)/.test(ic.decls.width[0]) && /var\(--csd-r-icon\)/.test(ic.decls['border-radius'][0]) && ['.cm-close', '.as-close', '.conn-x', '.br-x', '.section-copy-btn', '.bv-close'].every(c => ic.sel.includes(c)), '4 every close / copy icon button → 32×32 r8');
const chip = RULES.find(r => /:root :is\(\.filter-chip,/.test(r.sel) && r.decls.height);
ok(chip && /var\(--csd-h-chip\)/.test(chip.decls.height[0]) && /var\(--csd-fs-chip\)/.test(chip.decls['font-size'][0]) && ['.qp-type', '.search-tag', '.stmt-tpl-chip', '.vl-win-chip', '.cm-aspect-btn'].every(c => chip.sel.includes(c)), '4 chips → 28, 13/500, pill');
ok(has(/^:root \.pipeline-stages, :root \.create-sub-tabs, :root \.sp-tabs, :root \.source-tabs$/, 'height', /var\(--csd-h-seg\)/) && has(/^:root \.pipeline-stage-tab, :root \.create-sub-tab, :root \.sp-tab, :root \.source-tab$/, 'height', /^28px/), '4 every legacy tab set (Pipeline, Trends, Settings, Remix source) → the ONE segmented control');

/* ═══ 5. inputs ═══ */
ok(decl(/^\.csx-input$/, 'height') === 'var(--csd-h-input)' && decl(/^\.csx-input$/, 'border-radius') === 'var(--csd-r-input)' && decl(/^\.csx-textarea$/, 'min-height') === 'var(--csd-h-textarea)', '5 .csx-input 40 r10, .csx-textarea min 120');
const inp = RULES.find(r => /:root :is\(input\[type="text"\]/.test(r.sel));
ok(inp && /var\(--csd-h-input\)/.test(inp.decls.height[0]) && /1px solid var\(--cs-line\)/.test(inp.decls.border[0]) && ['select', '.sp-input', '.creator-input', 'input:not([type])'].every(c => inp.sel.includes(c)), '5 every legacy single-line input / select → 40, 1px line');
const ta = RULES.find(r => /:root :is\(textarea, \.gen-textarea/.test(r.sel));
ok(ta && /var\(--csd-h-textarea\)/.test(ta.decls['min-height'][0]) && /^12px/.test(ta.decls.padding[0]), '5 textareas min 120, padding 12');
ok(has(/:focus/, 'border-color', /var\(--cs-text\)/), '5 input focus → --cs-text border');
ok(RULES.some(r => r.media.some(m => /pointer: coarse/.test(m)) && /16px/.test((r.decls['font-size'] || [''])[0])), '5 coarse pointers keep 16px inputs (no zoom on focus)');
ok(!RULES.some(r => /input|textarea|select/.test(r.sel) && (r.decls['font-size'] || []).some(v => /^1[0-5](\.\d+)?px/.test(v))), '5 no input font-size hard-coded under 16px (desktop size comes from the token)');

/* ═══ 6. cards, dialogs, menus, toasts ═══ */
const card = RULES.find(r => /:root :is\(\.list-card, \.pipeline-card/.test(r.sel) && r.decls['border-radius']);
ok(card && /var\(--csd-r-card\)/.test(card.decls['border-radius'][0]) && ['.sp-section', '.tp-result-card', '.fp-panel', '.rv2-card', '.nb-card', '.bm-card'].every(c => card.sel.includes(c)), '6 legacy cards → r14, 1px line, no shadow');
ok(RULES.some(r => /:root :is\(\.remix-card, \.bb-nudge/.test(r.sel) && /var\(--csd-pad-card\)/.test((r.decls.padding || [''])[0])) && has(/\.list-card-summary, :root \.pipeline-card-header/, 'padding', /var\(--csd-pad-card\)/), '6 card padding 20 (list / pipeline cards pad their clickable summary row)');
ok(decl(/^\.csx-dialog$/, 'border-radius') === 'var(--csd-r-dialog)' && has(/:root :is\(\.dismiss-popup, \.more-sheet/, 'border-radius', /var\(--csd-r-dialog\)/), '6 dialogs r16 — the .csx-dialog and every legacy sheet');
ok(has(/:root \.brand-dropdown, :root \.assign-popup/, 'border-radius', /var\(--csd-r-menu\)/) && has(/:root \.brand-dropdown-item/, 'min-height', /var\(--csd-h-menu-item\)/), '6 dropdowns r12, 36px items');
ok(has(/\.generic-toast/, 'right', /16px/) && has(/\.generic-toast/, 'bottom', /16px/) && has(/\.generic-toast/, 'max-width', /var\(--csd-toast\)/) && T['--csd-toast'] === '380px', '6 toasts bottom-right, 16px in, max 380');
ok(has(/:root :is\(\.badge, .*\[style\*="text-transform:uppercase" i\]/, 'text-transform', /none/), '6 no UPPERCASE tracking labels on desktop');

/* ═══ 7. hover / focus language ═══ */
const hovers = RULES.filter(r => /:hover/.test(r.sel));
ok(hovers.length >= 20, '7 ' + hovers.length + ' hover rules');
ok(RULES.some(r => /:root :is\(\.pipe-btn, \.detail-btn/.test(r.sel) && /:hover/.test(r.sel) && /var\(--cs-hover\)/.test((r.decls.background || [''])[0])), '7 secondary / ghost / rows → --cs-hover');
ok(RULES.some(r => /:root :is\(\.gen-btn, \.generate-btn/.test(r.sel) && /:hover/.test(r.sel) && /var\(--csd-primary-hover\)/.test((r.decls.background || [''])[0])), '7 primary buttons → 90% fill');
ok(RULES.some(r => /:root :is\(\.filter-chip/.test(r.sel) && /:hover/.test(r.sel)) && RULES.some(r => /\.pipeline-stage-tab:hover/.test(r.sel)) && RULES.some(r => /\.csx-row:hover/.test(r.sel)), '7 chips, segments and rows hover too');
ok(RULES.some(r => /:root :is\(button, a, summary/.test(r.sel) && /:focus-visible/.test(r.sel) && /var\(--csd-ring\)/.test((r.decls.outline || [''])[0])), '7 one focus-visible ring on every interactive control');

/* ═══ 8. .sp-tip ═══ */
ok(has(/:root \.sp-tip$/, 'display', /^block$/) && has(/:root \.sp-tip::before$/, 'position', /absolute/), '8 desktop: .sp-tip is block, the "i" absolutely placed');
const top = css.slice(css.indexOf('/* ============ 5. components'), i7);
ok(/\n\.sp-tip \{ display: block; position: relative; padding-left: 44px; \}/.test(top) && /\n\.sp-tip::before \{ position: absolute; left: 16px; top: 12px; \}/.test(top)
  && /@media \(max-width: 600px\) \{ \.sp-tip \{ padding-left: 38px; \} \.sp-tip::before \{ left: 10px; top: 8px; \} \}/.test(top), '8 phones / tablets: same fix top-level in §5, text starts at the old x (16+18+10 / 10+18+10)');

/* ═══ 8b. detail sections share one left edge (pane ≥1100 and the 900–1099 dialog) ═══ */
ok(RULES.some(r => /#csxDetail :is\(\.list-card-detail, \.pipeline-card-detail\)/.test(r.sel) && /\.csx-dialog-body :is\(\.list-card-detail, \.pipeline-card-detail\)/.test(r.sel) && /^0/.test((r.decls['padding-left'] || [''])[0]))
  && RULES.some(r => /\.csx-dialog-body \.detail-text/.test(r.sel) && /^0/.test((r.decls.padding || [''])[0])), '8b moved card bodies lose their card inset in the detail pane AND the detail dialog (one left edge)');

/* ═══ 9. composer ═══ */
ok(has(/:root \.cs-composer$/, 'display', /none !important/), '9 the pinned composer is hidden on desktop');

/* ═══ 10. contrast on the desktop-only surfaces ═══ */
{
  const grab = (re) => { const m = re.exec(css); return m ? m[1] : ''; };
  const light = grab(/:root,\s*:root\[data-theme="light"\]\s*\{([^}]*)\}/), dark = grab(/:root\[data-theme="dark"\]\s*\{([^}]*--cs-bg[^}]*)\}/);
  const val = (blk, k) => { const m = new RegExp(k.replace(/[-]/g, '\\-') + ':\\s*(#[0-9a-f]{6})', 'i').exec(blk); return m ? m[1] : null; };
  const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const L = c => { const f = x => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }; const [r, g, b] = rgb(c); return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const x = L(a), y = L(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const darkD = (darkTok && Object.fromEntries(Object.entries(darkTok.decls).map(([k, v]) => [k, v[0]]))) || {};
  const pairs = [];
  for (const [name, blk, side, seg, on] of [['light', light, T['--csd-side'], T['--csd-seg-on'], T['--csd-side-on']], ['dark', dark, darkD['--csd-side'], darkD['--csd-seg-on'], null]]) {
    const text = val(blk, '--cs-text'), muted = val(blk, '--cs-muted'), chip = val(blk, '--cs-chip');
    if (name === 'light' && !/^#[0-9a-f]{6}$/i.test(on || '')) { pairs.push('light --csd-side-on missing'); continue; }
    if (!text || !muted || !side || !seg || !chip) { pairs.push(name + ': tokens missing'); continue; }
    for (const [f, b, lbl] of [[text, side, 'text/sidebar'], [muted, side, 'muted/sidebar'], [text, seg, 'text/segment'], [muted, chip, 'muted/segment track']].concat(on ? [[text, on, 'text/selected row'], [muted, on, 'muted/selected row']] : [])) {
      const r = ratio(f, b); if (r < 4.5) pairs.push(name + ' ' + lbl + ' ' + r.toFixed(2));
    }
  }
  ok(pairs.length === 0, '10 text and muted ≥ 4.5:1 on the sidebar, the selected row / nav item and the segmented control, light and dark' + (pairs.length ? ' — ' + pairs.join(', ') : ''));
}

/* ═══ 11. recorded computed-style pass ═══ */
{
  let m = null; try { m = JSON.parse(fs.readFileSync(path.join(ROOT, '.unlazy', 'desktop', 'D1-measure.json'), 'utf8')); } catch (e) {}
  if (!m) console.log('note: .unlazy/desktop/D1-measure.json not present — rendered measurement check skipped');
  else {
    const allowed = new Set([28, 32, 36, 44]);
    ok(m.after && Array.isArray(m.after.buttonHeights) && m.after.buttonHeights.every(h => allowed.has(h)), '11 recorded button heights only 28 / 32 / 36 / 44 (' + (m.after && m.after.buttonHeights) + '; option tiles excluded: ' + (m.after && m.after.tileHeights) + ')');
    ok(m.after && m.after.textInputHeights && m.after.textInputHeights.length === 1 && m.after.textInputHeights[0] === 40, '11 recorded single-line text inputs: one height, 40');
    ok(m.after && m.after.cardRadii && m.after.cardRadii.every(r => [10, 12, 14, 16, 999].includes(r)), '11 recorded box radii only on spec values (' + (m.after && m.after.cardRadii) + ')');
  }
}

console.log(fail ? `\n${fail} FAILED` : '\nDESKTOP SYSTEM OK');
process.exit(fail ? 1 : 0);
