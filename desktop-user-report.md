# QA pass — 2026-07-23 13:48

Driver: xAI (grok-4.5) · Desktop (1440px) · 17 features

**✅ 10 passed · ❌ 6 failed · ⚠️ 1 blocked · 0 hard error(s)**

Watch: `mobile-user-video.webm`

| Feature | Result | Notes |
|---|---|---|
| quick-post | ✅ pass | A full carousel result is on screen for BORING: save-worthy hook ('Save this for when you're dehydrated and confused.'), |
| ideas | ✅ pass | Tapped TOTAL, PENDING, APPROVED, DISMISSED in sequence. PENDING box shows lavender highlight and is the active filter (4 |
| approve-jump | ❌ fail | Approve (✓) does not immediately close the learning popup; Pipeline-confirmation toast ('added to your Pipeline — tap to |
| batch-approve | ❌ fail | Could not get two cards selected — Approve count stayed at 1 after second Select attempt, so core 'Approve 2' path faile |
| guardrail | ✅ pass | Modal present and centered over dimmed Brand Voice settings. Title exact. Body: empty brain would write like generic AI; |
| pipeline | ❌ fail | Mark Done ✓ does not work — item stays in Film & Post queue and counters (35 / 26) never update after multiple clicks; E |
| remix | ✅ pass | Side-by-side ORIGINAL summary vs YOUR VERSION titled 'Stop Getting Burned by Electrolytes': hook about electrolytes burn |
| idea-catcher | ❌ fail | Develop into a brief consistently fails with AI error after multiple retries — core feature broken; Error gives no actio |
| questions | ✅ pass | Questions flow was reachable; selecting a real question and generating produced a Q&A idea ('Is plain water enough or na |
| notebook | ✅ pass | Success toast ('Turned into a brief…') overlays and obscures the body of the next notebook card instead of sitting in a  |
| blog | ✅ pass | A full FAQ-style blog post on fasting flu (sodium deficit framing, concrete mg ranges, physiology, practical fixes) was  |
| viral-lab | ✅ pass | Analysis returned: bullet breakdown of myth-flip mechanics, HOOK/STRUCTURE/TRIGGER sections, TREND TAKEAWAY ('Flip a hyd |
| meme-image | ⚠️ blocked | Feature blocked on missing Gemini API key — no way to test image output without it |
| publishing | ✅ pass | Publishing hub loads cleanly for BORING. Shows heading, subtitle, and a 'Get started' card with exactly two numbered ste |
| settings | ✅ pass | Settings overlay is open on the Workspace tab for brand BORING. Sections visible: AI Engine (Grok · latest), Check AI st |
| brain | ❌ fail | Voice Memory was never stably scrolled-to/focused after Brain taps (feature under test: taps should force voice sections |
| assistant | ❌ fail | Starter suggestion chip '▶ Rewrite as declarative post' is partially clipped/hidden under the Brand Voice AI Assistant h |

## quick-post — pass
- **Expected:** Generate a real on-brand social carousel post for BORING, read it fully, then Approve it (or give feedback and Redo) so a usable post appears.
- **Observed:** A full carousel result is on screen for BORING: save-worthy hook ('Save this for when you're dehydrated and confused.'), tags (#Boring #hangover #electrolytes #sodium #hydration), and an 8-slide shot list (bold hook → mechanism → overnight loss → plain water mistake → sports drink fail → full dose numbers → three-ingredient list → takeaway). User approved via 'Nails our voice'; Ready to Film & Post / Sharpen / Make Slides / Try Another / Not for Me actions are available.
- **Output quality:** On-brand for BORING (electrolyte/hydration drink aimed at hangover and low-carb audiences). Concrete, useful shot list with clear slide roles; tags match product world; no placeholders, repetition, or generic AI fluff. Solid production-ready output.
- **Design/UX:** Clean desktop card layout with consistent button sizing in the action tier, readable hierarchy, and intentional sidebar. Content sits properly in the main column. Minor: shot-list labels are abbreviated outlines rather than full slide copy (acceptable for a shot list).
- **Output sample:** FAQ — about Quick Post Your brand brain what it knows & powers ▾ Your brand brain Live trends News · X · RSS Memes What you approve The most-informed writer you'll ever use — it reads your brand from every angle, remembers everything, and is sharpening from 65 signals you've fed it. A blank ChatGPT starts from zero. Fr…

## ideas — pass
- **Expected:** Four tappable stat boxes (Total, Pending, Approved, Dismissed) highlight with lavender fill when tapped and filter the list below to that status; counts roughly match box numbers.
- **Observed:** Tapped TOTAL, PENDING, APPROVED, DISMISSED in sequence. PENDING box shows lavender highlight and is the active filter (44). TOTAL/APPROVED/DISMISSED also responded when tapped earlier. List content and sidebar badge (Ideas 44) align with Pending filter. Counts 84/44/34/6 are coherent (44+34+6=84).
- **Output quality:** Stat filter behavior works as specified: boxes are tappable, highlight state is clear (lavender fill on active), and filtering switches with the selection. Brand content (BORING / fasting salt math etc.) is on-theme when ideas are shown.
- **Design/UX:** Clean desktop layout overall; stat boxes are evenly sized and aligned in a row; active lavender state is obvious. Main column is properly constrained, not full-bleed. Minor: after filtering, the idea cards sit further down so the filter effect is less immediately visible without scroll, but function is intact.
- **Output sample:** FAQ — about Ideas All Ideas & Tools 🧠 ✨ AI learns from you. Approve ideas you like, dismiss ones you don't — and say why. Each generation gets smarter. 84 TOTAL 44 PENDING 34 APPROVED 6 DISMISSED 3 ideas 5 ideas 10 ideas HOW YOU'LL MAKE IT Face-on Faceless You on camera, talking to your audience. Generate Ideas Filter…

## approve-jump — fail
- **Expected:** After tapping approve (✓), the learning popup should immediately close and a tappable Pipeline-confirmation toast should already be on screen reading approximately 'added to your Pipeline — tap to see it'.
- **Observed:** Tapping ✓ repeatedly still leaves the 'What made this one land?' learning popup open/modal covering the screen. No Pipeline toast is visible in toasts or on screen — only generic AI-learns and Steal-like-an-artist messages. The approve→close→Pipeline-toast jump (v356) did not occur.
- **Output quality:** Cannot assess Pipeline jump output; the feature under test never completed. Learning feedback UI itself is fine and on-brand for BORING.
- **Design/UX:** Modal blocks the flow and does not auto-dismiss on approve as specified for v356. User is stuck dismissing/re-approving with no Pipeline confirmation. Desktop layout behind modal looks intentional; modal itself is cleanly centered.
- **Output sample:** FAQ — about Ideas All Ideas & Tools 🧠 ✨ AI learns from you. Approve ideas you like, dismiss ones you don't — and say why. Each generation gets smarter. 84 TOTAL 44 PENDING 34 APPROVED 6 DISMISSED 3 ideas 5 ideas 10 ideas HOW YOU'LL MAKE IT Face-on Faceless You on camera, talking to your audience. Generate Ideas Filter…
- 🐞 Approve (✓) does not immediately close the learning popup
- 🐞 Pipeline-confirmation toast ('added to your Pipeline — tap to see it') never appears after approve
- 🐞 v356 approve-jump behavior not working — user remains trapped in feedback modal

## batch-approve — fail
- **Expected:** Enter select mode via full-width 'Approve several at once', tick 2 cards (lavender ring + 'Approve 2'), tap Approve → single toast '2 added to your Pipeline — tap to see them', both ideas leave Pending, no per-card feedback popup.
- **Observed:** Select mode works and checkboxes appear. After selecting one card it shows a checked lavender circle and 'Approve 1 →'. A second Select click was performed but the bar still reads Approve 1 and only one card is visibly selected; bulk approve of 2 was never completed successfully. Sticky bar is a tall stacked card (Cancel / Select all full-width rows + Approve pill) rather than a compact bar. No success toast for bulk move observed in the final state.
- **Output quality:** Could not fully verify bulk approve of 2 ideas or the required single toast / list removal / skip-feedback behavior because selection did not reliably reach Approve 2.
- **Design/UX:** Sticky select controls are poorly laid out for desktop: Cancel and Select all are huge full-width outline buttons stacked vertically inside a large rounded card, with Approve 1 as a small pill bottom-right — not a compact sticky bar. Inconsistent with sibling filter chips. Content column otherwise ok; cards have roomy checkboxes.
- **Output sample:** FAQ — about Ideas All Ideas & Tools 🧠 ✨ AI learns from you. Approve ideas you like, dismiss ones you don't — and say why. Each generation gets smarter. 84 TOTAL 38 PENDING 40 APPROVED 6 DISMISSED 3 ideas 5 ideas 10 ideas HOW YOU'LL MAKE IT Face-on Faceless You on camera, talking to your audience. Generate Ideas Filter…
- 🐞 Could not get two cards selected — Approve count stayed at 1 after second Select attempt, so core 'Approve 2' path failed
- 🐞 Sticky bar is a tall stacked card (Cancel + Select all as full-width rows) instead of a compact full-width sticky action bar — awkward desktop UX
- 🐞 Batch-approve flow did not complete: no verified single toast, no confirmed removal of 2 ideas from Pending

## guardrail — pass
- **Expected:** Centered first-run guardrail modal titled 'First, teach it your brand', body warning empty brand brain writes like generic AI, two buttons (Generate anyway + lavender primary Set up my brand brain); primary CTA leads to Brand Voice/brain settings.
- **Observed:** Modal present and centered over dimmed Brand Voice settings. Title exact. Body: empty brain would write like generic AI; spend ~2 min on voice so posts sound like YOU. Buttons: white 'Generate anyway' and lavender 'Set up my brand brain →'. Brand Voice/brain settings already loaded behind the modal from the Brain entry point.
- **Output quality:** Copy is clear, on-brand for the product voice, specific about the risk (generic AI) and the fix (~2 minutes on tone/audience/offer). No placeholders or hype. CTA hierarchy is correct.
- **Design/UX:** clean — modal centered with proper scrim, clear title/body hierarchy, primary lavender CTA vs secondary outline, closable via ×. Desktop layout of the modal is consistent; buttons same height tier.
- **Output sample:** FAQ — about Ideas All Ideas & Tools 🧠 ✨ AI learns from you. Approve ideas you like, dismiss ones you don't — and say why. Each generation gets smarter. 84 TOTAL 36 PENDING 42 APPROVED 6 DISMISSED 3 ideas 5 ideas 10 ideas HOW YOU'LL MAKE IT Face-on Faceless You on camera, talking to your audience. Generate Ideas Filter…

## pipeline — fail
- **Expected:** Review queued/approved posts in Pipeline, open/preview one with full content (script, shot list, tags), and successfully mark one Done — list should update (Film & Post count down, Done count up) and the item should move out of the queue.
- **Observed:** Pipeline list loads with on-brand BORING Q&A cards (diabetic-safe hydration, freeze powder ice cubes, Gatorade vs powder). Expanded preview showed full reel title, script, shot list, on-screen text, and tags. Repeated clicks on 'Mark Done ✓' did not move the item or change the 35 Film & Post / 26 Done counters — state change failed.
- **Output quality:** Content quality is strong and on-brand for BORING electrolytes: concise hooks ('Zero sugar. Zero sweeteners.'), factual scripts (sodium/potassium/magnesium doses, diabetic safety), usable shot lists and tags. Preview depth is good.
- **Design/UX:** Desktop layout is mostly clean — sidebar intentional, cards fill the content column, button sizes consistent within cards. But Mark Done is broken (no state change after multiple clicks), and the expanded detail view dumps REEL TITLE / FULL SCRIPT / SHOT LIST / ON-SCREEN TEXT / TAGS as one long undifferentiated block. Toast spam also clutters the session.
- 🔲 **Section separation:** BLENDED: In the expanded post detail, REEL TITLE / FULL SCRIPT / SHOT LIST / ON-SCREEN TEXT / TAGS run together with no divider lines, tinted sub-panels, or clear gaps between labelled sections
- **Output sample:** FAQ — about PipelineWhat is Pipeline?Everything you approved, ready to film and post — plus what's already done. Your production to-do list.How do I mark something done?Hit "Done" on a card once it's posted; it moves to the Done column.Under the hood — how does status persist?Every card's stage is reconciled against yo…
- 🐞 Mark Done ✓ does not work — item stays in Film & Post queue and counters (35 / 26) never update after multiple clicks
- 🐞 Expanded post detail blends REEL TITLE, FULL SCRIPT, SHOT LIST, ON-SCREEN TEXT, and TAGS into one continuous block with no visual section separators
- 🐞 Multiple stacked toasts fire on pipeline entry and obscure content
- 🐞 Assign control is a tiny circular icon with microscopic 'Assign' label — weak tap/click target and unclear affordance next to primary actions

## remix — pass
- **Expected:** Paste source text, run remix, get a coherent on-brand BORING rewrite that keeps the original structure but swaps in product voice/facts.
- **Observed:** Side-by-side ORIGINAL summary vs YOUR VERSION titled 'Stop Getting Burned by Electrolytes': hook about electrolytes burning money, 3-ingredient shortlist (Himalayan pink salt, potassium citrate, magnesium malate), full clinical doses, €0.25 serving, stop-gambling CTA, hashtags, plus a purple 'Why it works' rationale.
- **Output quality:** Strong. Structure mirrors the source (problem → process → CTA), voice and facts are specific to BORING electrolytes (not generic AI fluff), no placeholders or repetition, length fits a short video script, hashtags on-topic.
- **Design/UX:** clean — two-column Original/Your Version card, clear VIDEO/REMIX pills, action row (Remove / Copy Script / Sharpen / Send to Pipeline) evenly sized, main panel fills the content column on desktop without mobile-width orphaning.
- **Output sample:** FAQ — about Remix Steal like an artist. Paste any creator's content — the AI rewrites it in your brand voice with your product facts baked in. ★ Borrow from Manage Salte TikTok web Transparent Labs web Transparent Labs TikTok web Re-Lyte web Re-Lyte TikTok web TikTok YouTube Article Paste File Dictate the description A…

## idea-catcher — fail
- **Expected:** Typing a rough on-brand idea and clicking Develop into a brief should produce a ready-to-film brief in BORING's voice.
- **Observed:** After 5+ Develop clicks (including dismiss/retry), the only result is the error: 'The AI is having a moment and could not respond. Please try again in a few seconds.' No brief was ever generated.
- **Output quality:** No usable output — feature completely failed to develop the idea. Cannot judge content quality, brand voice, or length because nothing was produced.
- **Design/UX:** Error message is somewhat friendly but vague (no reason, no retry affordance beyond re-clicking). Main form layout looks clean on desktop; content column fills appropriately. Sticky failure with no recovery path after many retries is poor UX.
- **Output sample:** FAQ — about Idea Catcher Idea Catcher Got a half-baked idea? Dump it here — rough is fine. Add a reference video if one sparked it. I'll shape it into a ready-to-film brief in your voice. Or just say it Supporting video — optional. A reference that inspired it; I'll transcribe it. Supporting screenshot — optional. Drop…
- 🐞 Develop into a brief consistently fails with AI error after multiple retries — core feature broken
- 🐞 Error gives no actionable detail (quota? network? content filter?) and no distinct retry control

## questions — pass
- **Expected:** Fetch 'what people search' questions for BORING, select one, and successfully generate an on-brand idea from it.
- **Observed:** Questions flow was reachable; selecting a real question and generating produced a Q&A idea ('Is plain water enough or nah?') with reel title and full script about hydration limits of plain water (sweat/training/sauna/low-carb). Idea landed in Ideas (36 pending) as a Tuesday Q&A Video.
- **Output quality:** Output is coherent, specific, and on-brand for BORING—casual voice ('or nah?'), practical hydration angle, usable script opener. Not generic AI filler; length and tone fit a face-on Q&A reel.
- **Design/UX:** Desktop Ideas hub is clean: sidebar intentional, stat cards aligned, filter chips and Generate Ideas CTA consistent. No blocking modal. Main column fills width appropriately; no overlapping/cut-off text on this screen.
- **Output sample:** FAQ — about What people search Real questions people ask 35 new Real questions people search online — Google, Bing & AI assistants. Tap "Generate Idea" to turn any question into a full content idea with hook + script. ? What is the best source of electrolytes? Google PAA from "electrolytes" Generate Idea From This ? Wh…

## notebook — pass
- **Expected:** Type a substantial on-brand note, save it, see it persist in the notebook list; optionally develop into post or save as voice rule.
- **Observed:** Note about never leading with 'clean/natural' and leading with three-electrolytes-only constraint saved and shows under JUST NOW. Develop into post produced a toast confirming it became a brief in Ideas. Prior BORING notes remain in the list.
- **Output quality:** Note content is specific, on-brand for BORING (three electrolytes, no sugar/dyes, tight copy), and useful as a voice/messaging rule. Develop flow acknowledges success clearly.
- **Design/UX:** Mostly clean desktop layout: sidebar intentional, content column well-width, card buttons uniform. Transient dark toast overlays the note card below and obscures its text until dismissed — slightly disruptive but not blocking.
- **Output sample:** FAQ — about Notebook Brand Notebook Dump any thought about your brand — a line, an observation, a "never say this". Develop it into a post, save it as a voice rule, or just keep it. Save note Key benefit of BORIN: three electrolytes only — sodium, potassium, magnesium. No sugar, no dyes, no mystery blends. Founders and…
- 🐞 Success toast ('Turned into a brief…') overlays and obscures the body of the next notebook card instead of sitting in a non-blocking toast region.

## blog — pass
- **Expected:** Generate a full on-brand blog post for BORING, readable end-to-end, then approve or copy it successfully.
- **Observed:** A full FAQ-style blog post on fasting flu (sodium deficit framing, concrete mg ranges, physiology, practical fixes) was generated. Approve was clicked; feedback modal appeared with tag options and Concrete & specific was selected. Copy text / Copy HTML controls were available.
- **Output quality:** Strong, specific, on-brand for BORING: concrete numbers (1,100–5,700 mg sodium), no fluff/AI-hype, clear educational voice matching a no-nonsense health/fasting brand. Full post structure with schema/FAQ intent. Not empty or errored.
- **Design/UX:** Feedback modal after Approve is clear and useful. Tag grid is tidy; Save/Skip obvious. Minor: modal covers the post so you can't re-read while tagging, but closable. Desktop layout otherwise coherent with sidebar + main panel.
- **Output sample:** FAQ — about Blog Blog & AI-Search Full posts with schema + FAQ markup baked in — built to get cited by ChatGPT, Claude & Google AI and rank in "People Also Ask." Approve, copy, publish on your domain. Connect a site & skip copy-paste + All (1) Pending (1) Approved (0) Rejected (0) How much sodium do you lose in the fir…

## viral-lab — pass
- **Expected:** Paste on-brand BORING content about electrolytes/sauna sodium, run Analyze, and get a coherent viral breakdown plus brand-voice idea cards.
- **Observed:** Analysis returned: bullet breakdown of myth-flip mechanics, HOOK/STRUCTURE/TRIGGER sections, TREND TAKEAWAY ('Flip a hydration myth, spell the sodium-dilution chain, close on bare dose math'), and Ideas for your brand cards (e.g. 'Fasting flu is usually just salt math' with full script closing on 1000mg sodium / Stay boring).
- **Output quality:** Strong on-brand output for BORING — blunt, anti-hype, sodium-math specific, product close without fluff. Hooks and scripts are usable and voice-consistent. Analysis correctly reverse-engineered the pasted content's viral levers.
- **Design/UX:** Clean desktop layout: sidebar intentional, main column well-spaced, cards fill width, buttons uniform. Analysis card and idea cards readable with clear hierarchy. Minor: multiple toast stack on generate is noisy but not blocking.
- **Output sample:** FAQ — about Viral Lab Viral Lab Paste a video that's blowing up right now. The AI reverse-engineers why it works and turns it into ideas in your brand voice — and you can teach your brand brain the trend. Pull fresh trends from the web — latest from Google News + X, no older than your window. Only the last: 24h 48h 1 w…

## meme-image — blocked
- **Expected:** Pick meme mode/style, enter an on-brand topic for BORING, generate a meme/product image and verify a real image result.
- **Observed:** Generate CTA is disabled until a Google Gemini API key is saved. No key is present; cannot start generation.
- **Output quality:** N/A — could not generate without API key prerequisite.
- **Design/UX:** Key gate is clear (disabled button + instructional label). Layout is mostly clean on desktop; FAQ accordion and mode toggle look intentional. Minor: API key field + Save sit above the mode card with uneven visual weight vs the wide content column.
- **Output sample:** FAQ — about Meme & Image Maker Meme & Image Maker Runs on your own Google Gemini key — free to get, and currently the only image API that renders these well. Make an on-brand meme with the caption baked in, or a product / lifestyle shot guided by your product photos. Review before you post. Your Google Gemini API key —…
- 🐞 Feature blocked on missing Gemini API key — no way to test image output without it

## publishing — pass
- **Expected:** Publishing hub renders as operations hub (not blank/error). With no channel connected: 'Get started' card with two numbered steps (1 Connect a channel, 2 Turn on Auto-Pilot) and a Connect CTA. Publishing visible under MANAGE/TOOLS in nav.
- **Observed:** Publishing hub loads cleanly for BORING. Shows heading, subtitle, and a 'Get started' card with exactly two numbered steps (1 Connect a channel — WordPress/Wix or Publer; 2 Turn on Auto-Pilot) plus a 'Connect a channel →' button. Sidebar highlights Publishing under TOOLS. No blank/error state. Connect opens a modal (repeatedly dismissed in prior turns).
- **Output quality:** Copy is clear, on-brand, and matches the no-channel empty state spec. Steps are specific and actionable. Hub is not blank and deploy appears landed.
- **Design/UX:** Clean desktop layout: sidebar intentional, main content card properly constrained in the content column, consistent button styling, good spacing. No overlapping/cut-off text. Toast stack noise is minor and unrelated.
- **Output sample:** Publishing Connect your site, run Auto-Pilot, and see what has gone out — all in one place. Get started Two steps to hands-off publishing: 1 Connect a channel — your website (WordPress/Wix) for blog, or Publer for social. 2 Turn on Auto-Pilot to post on a schedule — or publish any post by hand. Connect a channel →

## settings — pass
- **Expected:** Settings opens as a slide-over overlay; Workspace tab shows AI Engine preference, cache reset, posting channels, auto-pilot, and toggles. Changing a harmless setting should save/toast; Settings icon toggles close. Engine dropdown only saves preference.
- **Observed:** Settings overlay is open on the Workspace tab for brand BORING. Sections visible: AI Engine (Grok · latest), Check AI status, Reset cache, Posting Channels Manage, Auto-Pilot Manage, Dark Mode toggle, Shrimp Mascot toggle. Brand Voice tab and collapsible sections (Posting Schedule, Content Mix, etc.) are present. Prior steps included opening Settings, switching Workspace/Brand Voice, typing social handles, and re-opening Workspace.
- **Output quality:** Workspace settings content is clear, on-brand for BORING, and functionally organized. AI Engine shows current preference without navigating away. Harmless controls (toggles, cache clear, engine dropdown) are available as specified.
- **Design/UX:** Desktop layout is mostly clean: content fills the main column, sidebar is intentional, section cards align consistently. Manage buttons are uniform. Thin horizontal rules separate major blocks. Minor: Publishing is highlighted in the left nav while Settings overlay is open (background route), which is acceptable for an overlay pattern.
- **Output sample:** Publishing Connect your site, run Auto-Pilot, and see what has gone out — all in one place. Get started Two steps to hands-off publishing: 1Connect a channel — your website (WordPress/Wix) for blog, or Publer for social. 2Turn on Auto-Pilot to post on a schedule — or publish any post by hand. Connect a channel →

## brain — fail
- **Expected:** Brain opens Settings on Voice/Brand tab with voice sections forced open and Voice Memory field focused/editable; each Brand-Voice field has exactly two small action buttons ('Make it better' and 'Ask Assistant') on one line without mid-word label wrapping; Voice Memory accepts typing and is scrollable if long.
- **Observed:** After repeated Brain clicks and Voice & Tone expansions, the UI landed on a mixed Brand Basics / Publishing view. Brand-voice textareas (product description, audience, competitors, avoid-topics, keywords) each show paired 'Make it better' + 'Ask Assistant' buttons. Voice Memory field was never reliably focused or confirmed editable; final screenshot shows collapsed Voice & Tone accordion and Publishing sidebar state rather than the forced-open Voice Memory focus target.
- **Output quality:** Brand content for BORING (electrolytes) looks substantive and on-brand where visible (product copy, audience, competitors like LMNT, avoid tags). Could not complete the core v359 Voice Memory editability check because the auto-focus/scroll behavior did not stick across retries.
- **Design/UX:** Brain → Voice Memory auto-open/focus is unreliable (required multiple dismissals and re-clicks; ended on wrong surface). Desktop layout: main settings content competes with Publishing chrome; accordion sections (Deep Personalisation, Voice & Tone, Custom Instructions) are collapsed so the forced-open behavior failed. Button pairs appear present in the element tree.
- **Output sample:** Publishing Connect your site, run Auto-Pilot, and see what has gone out — all in one place. Get started Two steps to hands-off publishing: 1Connect a channel — your website (WordPress/Wix) for blog, or Publer for social. 2Turn on Auto-Pilot to post on a schedule — or publish any post by hand. Connect a channel →
- 🐞 Voice Memory was never stably scrolled-to/focused after Brain taps (feature under test: taps should force voice sections open and focus Voice Memory, retried 3x) — could not verify typing acceptance
- 🐞 Final state shows Voice & Tone collapsed and Publishing active instead of Brand Voice tab with Voice Memory ready
- 🐞 Flow is flaky: Brain navigation repeatedly lost context / required popup dismissals and did not land on the specified field

## assistant — fail
- **Expected:** Remy chat opens with a behavior-aware greeting, clean message bubbles, clearly separated starter chips vs thread vs composer; composer (input + mic + send) fully visible and usable; one on-brand send yields a coherent BORING-voice reply.
- **Observed:** Chat overlay works and returned a sharp, on-brand reply about keto sodium loss (insulin → kidney flush → keto flu symptoms → 1000mg replaces the deficit with nothing added). Prior thread about the 3-ingredient formula also rendered. Composer is present at bottom (text field, send paper-plane, mic). However a starter chip is clipped under the header, and the latest assistant bubble appears truncated at the bottom above a waveform spinner.
- **Output quality:** Reply copy is excellent for BORING: factual, anti-hype, specific (gram-scale sodium loss, keto flu as deficit not 'carb withdrawal'), no AI fluff or placeholders. Offers a natural next step tied to existing open script. On-brand voice.
- **Design/UX:** Composer row is usable and not overlapping. But: (1) purple starter chip '▶ Rewrite as declarative post' is half-cut off behind/under the modal header — broken layout; (2) latest assistant bubble bottom edge looks clipped with a waveform loader sitting between bubble and composer; (3) earlier user bubble has brand typo 'Borin's' instead of 'Boring's'; (4) on a 1440px desktop the overlay is a narrow floating phone-like column — acceptable as modal but the clipped chip and cut bubble are real defects.
- 🔲 **Section separation:** BLENDED: starter chips bleed into/under the header with no clear chip row boundary; latest assistant bubble and the waveform/loader sit flush with weak separation before the composer bar. Greeting/header vs thread vs composer are mostly distinct, but chips vs header fail.
- **Output sample:** Publishing Connect your site, run Auto-Pilot, and see what has gone out — all in one place. Get started Two steps to hands-off publishing: 1Connect a channel — your website (WordPress/Wix) for blog, or Publer for social. 2Turn on Auto-Pilot to post on a schedule — or publish any post by hand. Connect a channel →
- 🐞 Starter suggestion chip '▶ Rewrite as declarative post' is partially clipped/hidden under the Brand Voice AI Assistant header
- 🐞 Latest assistant message bubble appears cut off at the bottom (border/text area truncated above the waveform)
- 🐞 Waveform/loader sits awkwardly between last bubble and composer with unclear state (still generating? voice?) and no status text
- 🐞 Brand name typo in prior chip/bubble copy: 'Borin's' instead of 'Boring's'
- 🐞 Desktop: chat column reads as a narrow mobile sheet floating on a wide canvas; clipped controls make it feel unfinished rather than intentional

