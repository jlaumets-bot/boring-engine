# Content Shrimp — Live Mobile Audit (iPhone, 393px)

How this was done: I rendered the real app at a **true iPhone viewport (393×852,
dpr 3)** — the `≤600px` mobile CSS actually fires — and measured every screen for
horizontal overflow, tap-target size, and overlapping fixed elements, plus a
screenshot of each. (The in-app Chrome tool floors at ~614px and can't do this;
this ran headless Chromium driven by agent-browser.) Content-dependent screens
were also covered by a code-level read of the render functions + CSS.

Nothing in the app was changed to produce this. Everything below is analysis +
suggested fixes — I'll only implement what you approve.

---

## The headline: the base layout is solid

Across all 14 surfaces (Quick Post, Ideas, Pipeline, Remix, Idea Catcher,
What-people-search, Notebook, Blog, Viral Lab, Meme/Image, Done-for-you,
Settings, Brain, login) at 393px:

- **No horizontal page scroll anywhere.** Nothing spills off the screen at the
  page level.
- **Header and bottom nav fit exactly** (both span 0–393, header z100 / nav z200).
- Every tool input screen, Settings, and the list views render **cleanly in one
  column** with full-width inputs.

So this is polish, not a broken layout.

---

## Confirmed live at 393px (visible in the screenshots)

**1. Remix source-tab row clips.** The row TikTok / YouTube / Article / Paste + a
5th tab runs to x:439 — past the 393 edge — and it is **not scrolling**, so the
last tab is cut off. Fix: make the tab row `overflow-x:auto; flex-wrap:nowrap`
(with momentum scroll) or `flex-wrap:wrap`. (There's a scroll rule near
app.html:3057 that isn't taking effect on mobile — worth checking why.)

**2. The mascot overlaps bottom-right buttons.** On Remix it sits on top of the
"Add reference screenshot" button. The mascot is fixed at ~[64,672,377,772]. Fix:
on mobile, add bottom padding to the scroll area so the last control clears the
mascot, and/or shrink/lower the mascot.

**3. PWA install banner is heavy on mobile.** It occupies the top ~180px of
**every** screen, and its close "×" is only ~12–20px — hard to tap. Fix: give the
× a ≥40px tap area, and consider a slimmer banner (or show it once, not on every
view).

**4. A few sub-40px tap targets.** Meme "retry" 50×22, banner "Install" 67×30,
card "×" closes. Fix: `min-height:40px` on these small controls at ≤600px.

**5. Meme mode toggle is lopsided.** "😀 Meme" vs "Product / lifestyle image" —
the second wraps to two lines, so the two buttons are uneven. Fix: shorten to
"📸 Product image" or stack the two on mobile.

---

## Content-dependent (needs your logged-in data to see live; found in code)

These don't appear in the empty preview because there's no content yet, but the
code shows they'll bite with real data:

**6. Pipeline card buttons cram.** A "filming" card renders up to 4 actions
(Teleprompter / ← Ready / Done → / ↶) in one no-wrap row (~app.html:2928). On a
~336px card "Teleprompter" can't fit and wraps into tall, uneven buttons. Fix:
`.pipeline-card-actions{flex-wrap:wrap}` and/or shorten "Teleprompter".

**7. Usage pill overlaps the mascot.** The "N days left · used/limit" pill is
fixed bottom-right (right:14, bottom:96) in the same corner as the mascot
(app.html:10179 vs 2877). Fix: move the pill to `left:14px` on mobile so the two
don't stack.

**8. Guided-tour tooltip mis-behaves on narrow phones.** `max-width:340px` +
padding exceeds 360–393px and can clip off the left edge; it also adds
`window.scrollY` to a fixed target so it drifts off-screen once scrolled
(app.html:3511 / 14304 / 14268). Fix: `max-width:calc(100vw-24px)`, clamp `left`
to ≥12px, and don't add scrollY for fixed elements.

**9. "Getting started" card can cover Settings.** The 330px onboarding card
(app.html:10286, fixed top-right) sits over the Settings/Brain panel for
trial users. Fix: hide `#csOnbCard` while Settings/Brain/Assistant overlays are open.

**10. Viral Lab visual row is cramped.** The paste-textarea and mic button are
forced side-by-side (app.html:2427) — squeezed, though not clipped. Fix:
`flex-direction:column` on mobile.

---

## Suggested priority

1. Remix tab clip (#1) + mascot overlap (#2) — both visible and on a core screen.
2. Pipeline button wrap (#6) + usage-pill/mascot stack (#7) — hit real daily use.
3. PWA banner size + tap targets (#3, #4).
4. Tour tooltip (#8), onboarding card (#9), meme toggle (#5), Viral row (#10) — polish.

None of these are page-breaking; they're the difference between "works on a phone"
and "feels made for a phone." Say which you want and I'll implement them (small,
contained CSS changes) and give you the deploy command.

---

## The reusable setup

The mobile harness now exists and works — I can re-render and re-measure any screen
at true iPhone width on demand. To see screens with your **real content**, one
magic-link login into the test browser is all that's missing (the automated
email-fetch hit a rate limit today). `mobile-audit.sh` in this folder re-runs the
whole sweep.
