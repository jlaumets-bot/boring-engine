# Content Shrimp — Pricing & Trial Plan (decided)

Status: agreed strategy, NOT yet built. Implementation is a post-freeze task.

## The core insight
Value **compounds** — the brand brain only writes like the user after repeated corrections, and the "wow" needs breadth (quick posts + blog + viral + memes). So the trial must give **time**, and onboarding must **pull users through** long enough for the brain to feel like theirs. The trained brain is the moat and the upsell.

## Model (agreed)
1. **Long full-access trial — no card.** 14 days minimum; consider 21–30. Generous usage allowance during it so they can train the brain and touch every function. No card wall while we're still unknown (maximizes signups + word-of-mouth). Add card-up-front later once we have proof/testimonials.
2. **Strong onboarding / activation is the real conversion driver.** Checklist + progress + daily push:
   - "Train your brain" (do N edits/approvals so the learning loop distills coach notes)
   - "Generate your first post"
   - "Try the blog", "Run a viral twist", "Make a meme", "Drop a half-baked idea"
   - Progress indicator (e.g. "Brain trained 4/10", "Functions tried 5/8")
   - Use the (now-fixed) daily push to bring them back day after day.
3. **Trained-brain paywall (reverse trial).** When the trial ends, drop to a small **free tier that KEEPS the trained brain but caps output** → "Your brand brain is trained and ready. Upgrade to keep generating with it." Losing a brain you personally taught is the strongest reason to pay.
4. **Cheap first paid tier to lower the leap**, then Pro as the real target.

## Draft tiers (Grok-routed economics; calibrate after real usage)
Per-generation cost ≈ $0.006 on Grok 4.3 vs ≈ $0.04 on Opus 4.8 — so route routine generation to the cheaper model and reserve Opus for a premium toggle/tier. This single choice matters more than the price tag.

| Tier | Price | Allowance (shown as "posts/mo") | Est. AI cost (Grok) |
|---|---|---|---|
| Free (post-trial) | $0 | ~5 posts/mo, brain kept | ~$0.03 |
| Starter | ~$19 | ~40 posts | ~$0.30 |
| Pro (target) | ~$49 | ~150 posts | ~$1.10 |
| Agency | ~$99 | ~500 posts | ~$3.70 |

Rule of thumb: set caps so worst-case AI cost ≤ ~20–25% of the plan price. Weight heavy actions (blog = ~3 posts, transcription = ~2).

## What must be BUILT to enable this (post-freeze checklist)
- [ ] **Usage metering** — log tokens/generations per user per month in Supabase (LLM responses already return a usage count). Foundation for BOTH trial caps and plan caps.
- [ ] **Cap enforcement + soft gate** — when over limit: "You're out of posts — upgrade or wait for reset" (never a hard crash).
- [ ] **Trial state** — trial start/end per user, full access during, downgrade to free tier after.
- [ ] **Reverse-trial paywall** — free tier keeps the trained brain (read + limited generate), gates full output behind upgrade.
- [ ] **Onboarding checklist + progress UI + activation nudges.**
- [ ] **Billing** — Stripe (or similar): plans, trial-to-paid, upgrade/downgrade, easy cancel.
- [ ] **(High-leverage) model routing** — default routine generation to Grok 4.3 / Sonnet; reserve Opus for premium. Needs a quality check first, and it's a tone/output-affecting change → confirm before shipping.

## Open questions to settle before build
- Primary buyer: solo creators vs businesses/agencies? (sets the price anchor)
- Exact trial length: 14 / 21 / 30 days?
- Which model runs the default engine after the quality check?
- Card-up-front now or after we have testimonials?
