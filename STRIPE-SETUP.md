# Stripe Setup — activate paid plans

The billing **code is built and deployed**. It stays inert until the steps below are done — until then the app answers "Billing is not configured yet" if anyone clicks upgrade, which is safe. No code changes are needed; you create the Stripe products and paste keys into Vercel.

**This file is the checklist for the live-mode flip. It must match the code.** Every number below was checked against `api/_usage.js` and `app.html` on the day it was written; if you change a price or a limit, change it here in the same pass.

## How it works (so you know what you're setting up)

1. A user hits their limit → paywall → picks a plan → **Stripe Checkout** (hosted by Stripe, you never touch card data).
2. Stripe redirects back to the app; the app calls `/api/checkout-confirm`, which verifies the payment with Stripe and sets the user's `plan` in Supabase. This is the fast path — it is what makes the upgrade feel instant.
3. **In parallel, `/api/stripe-webhook` grants the same purchase from `checkout.session.completed`.** This is the safety net: if the customer closes the tab before the redirect lands, step 2 never runs, and without the webhook they would be charged and left on `free` with nothing able to retry it. Whichever path arrives first wins; the other sees the row is already correct and skips the write.
4. The webhook also keeps the plan in sync on renewals/price changes and downgrades to `free` on cancel, lapse, or failed payment.

Plan → credit limits live in `api/_usage.js` (`PLAN_LIMITS`). As of this writing:

| plan | credits per period | notes |
|---|---|---|
| `trial` | **150** | 7 days (`TRIAL_DAYS`), full access, no card |
| `free` | **40** | post-trial floor; blog / meme / brand-image are locked |
| `starter` | **200** | plan key exists in code; not sold in the UI today |
| `pro` | **750** | |
| `agency` | **2500** | |

The usage window is **not** the calendar month. It rolls from the trial start for a trial, and from the subscription anniversary implied by `current_period_end` for a paid plan, falling back to the calendar month when neither is known (`periodStartForRow` in `api/_usage.js`).

## Step 1 — Create the subscription products in Stripe

Stripe Dashboard → **Product catalog → Add product**. Create **two**, each **recurring / monthly**:

- **Pro** — **$24/mo**
- **Agency** — **$79/mo**

Copy each **Price ID** (looks like `price_1Q…`).

`starter` exists as a plan key in the code but is not offered anywhere in the app. Only create a Starter product if you decide to sell it; if you do, set `STRIPE_PRICE_STARTER` as well.

> The paywall in `app.html` shows **$24 (Pro)** and **$79 (Agency)**. Make the Stripe prices match, or tell me and I will change the labels. The plan **keys** must stay `starter`, `pro`, `agency` — the webhook and `PLAN_LIMITS` key off them.

## Step 2 — Get your Secret key

Stripe → **Developers → API keys** → copy the **Secret key** (`sk_test_…` for testing, `sk_live_…` for real charges). Start in **test mode**.

## Step 3 — Add the env vars in Vercel

Vercel → project **boring-engine** → Settings → Environment Variables (Production):

- `STRIPE_SECRET_KEY` = your `sk_…` key
- `STRIPE_PRICE_PRO` = the Pro `price_…`
- `STRIPE_PRICE_AGENCY` = the Agency `price_…`
- `STRIPE_PRICE_STARTER` = the Starter `price_…` — **only if** you created a Starter product (`api/create-checkout.js` reads it; without it, `plan:'starter'` returns "Unknown or unconfigured plan", which is the correct behaviour when you don't sell it)

Then **redeploy** (`DEPLOY.command`, or Vercel → Deployments → Redeploy). Env changes only take effect on a new deploy.

**If a price id is wrong or rotated**, the webhook now falls back to the plan we stamped on the subscription at checkout, grants it anyway, and logs a line starting `stripe-webhook: CONFIG ERROR`. Grep for that after any env change.

## Step 4 — Add the webhook (do this BEFORE taking a real payment)

The webhook is **built** (`/api/stripe-webhook`). It is not optional: it is what grants a purchase when the browser never makes it back, and what downgrades a cancelled customer.

1. Stripe Dashboard → **Developers → Webhooks → Add endpoint**.
2. Endpoint URL: `https://contentshrimp.com/api/stripe-webhook` (use your live domain).
3. **Events to send** — select exactly these five:
   - `checkout.session.completed` — grants a first purchase
   - `customer.subscription.created` — grants a subscription created outside Checkout
   - `customer.subscription.updated` — plan changes, renewals, `past_due`
   - `customer.subscription.deleted` — cancellation → `free`
   - `invoice.payment_failed` — acknowledged; the matching `subscription.updated` does the downgrade
4. Save. **No extra env var is needed** — the webhook re-fetches every event from Stripe by id to verify it, so there is nothing secret to paste. (It also ignores any event older than 72h, so a replayed id cannot re-trigger a state change.)

## Step 5 — Test it

1. With your **test** key set, open the app, trigger the paywall, click a plan.
2. Use Stripe's test card: **4242 4242 4242 4242**, any future expiry, any CVC/ZIP.
3. After paying you are redirected back and should see the **"You're on Pro"** confirmation modal (`showCheckoutSuccess()`), with the plan and limit updated.
4. Confirm in Supabase → `user_plans` that your row shows the new `plan`, `stripe_customer_id`, `stripe_subscription_id` and `current_period_end`.
5. **Test the tab-closed case**, because it is the one that used to lose money: pay, then close the tab the instant Stripe starts redirecting. The row should still flip to the paid plan within a few seconds, from the webhook. Stripe → Developers → Webhooks → your endpoint shows each delivery and our response.
6. Cancel that test subscription in Stripe → the row should flip back to `free`.
7. Try clicking upgrade again **while still subscribed** → the API answers `409 already_subscribed` and the app sends you to the billing portal. It must not open a second Checkout; that would charge the customer twice.
8. When all of that works in test mode, swap `STRIPE_SECRET_KEY` to `sk_live_…`, re-create the products/prices **in live mode**, update the `STRIPE_PRICE_*` vars to the live ids, and redeploy.

## Already built (no longer "coming later")

- **Manage subscription** — `api/create-portal-session.js` opens the Stripe Billing Portal, and Settings → Account shows a "Manage plan & billing" button. Activate it once per mode: Stripe → Settings → Billing → **Customer portal → Activate**, and enable "Customers can switch plans" with both products listed if you want in-portal upgrades.
- **Plan switching / proration** — handled by the portal. Paid users are deliberately routed there instead of Checkout, and `api/create-checkout.js` refuses them server-side (`409 already_subscribed`) so a double subscription is not possible even if the UI is bypassed.

## Files involved (FYI)

- `api/create-checkout.js` — starts Checkout; refuses callers who already have a subscription.
- `api/checkout-confirm.js` — verifies payment on the redirect and sets the plan (fast path).
- `api/stripe-webhook.js` — grants first purchases, keeps plans in sync, downgrades on cancel/lapse (safety net).
- `api/create-portal-session.js` — opens the Stripe Billing Portal.
- `api/_usage.js` — plan limits, credit weights, the usage window, `setPlan`, `userIdByStripe`, `getPlanSnapshot`.
- `app.html` — paywall buttons, `startCheckout()`, `showCheckoutSuccess()`, redirect handler, portal button.
- Supabase `user_plans` — `plan`, `trial_started_at`, `trial_ends_at`, `stripe_customer_id`, `stripe_subscription_id`, `current_period_end`.
- `scripts/verify/money-path.mjs` — the gate. Run it before any billing change.
