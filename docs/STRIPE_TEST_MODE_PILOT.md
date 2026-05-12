# Stripe test-mode pilot lane

Use this path for **real pilot demos** where money must **never** move on live Stripe: **test API keys**, **test-mode Dashboard webhooks**, and (optionally) **Stripe CLI** for local forwarding. This is separate from the **Prisma demo seed**, which uses **fake** `cus_demo_*` / `sub_demo_*` / `price_demo_*` IDs that Stripe does not recognize ([`DEMO_ENVIRONMENT.md`](./DEMO_ENVIRONMENT.md)).

**Related:** [`ENV_VARS.md`](./ENV_VARS.md), [`MOBILE.md`](./MOBILE.md) (return URLs + deep links), [`PRODUCTION_DEPLOYMENT.md`](./PRODUCTION_DEPLOYMENT.md), [`PRODUCTION_CHECKLIST.md`](./PRODUCTION_CHECKLIST.md).

---

## Fake-seed billing vs Stripe test-mode billing

| Topic | Fake seed (`prisma db seed`) | Stripe test-mode pilot |
|--------|------------------------------|-------------------------|
| **Stripe keys** | None required for UX-only demos | **`sk_test_…`** on the API |
| **Customer / sub / payment IDs** | Placeholders in Postgres (`cus_demo_*`, …) | **Real** Stripe test IDs created by Checkout / webhooks |
| **Checkout / Portal** | Will fail or no-op against real Stripe unless you replace IDs | Works end-to-end against **test mode** |
| **Webhooks** | Not meaningful for fake IDs | **Required** for subscription + invoice sync |
| **Risk** | Data is obviously non-production | Still use a **non-prod DB**; never `sk_live_` on shared demos |

**Do not** remove or replace fake IDs in `seed.ts` for Phase 7A — keep seed for layout demos; use a **different database** or re-seed after wiping if you want a clean switch from fake-only to Stripe-test.

---

## Required Stripe test env vars (API)

Set on the machine running **`apps/api`** (local `.env`, Railway **staging**, etc.):

| Variable | Test-mode rule |
|----------|----------------|
| `STRIPE_SECRET_KEY` | Must start with **`sk_test_`**. **Never** `sk_live_` for pilot/dev. |
| `STRIPE_WEBHOOK_SECRET` | **`whsec_…`** from the **test-mode** webhook endpoint in Dashboard, or from `stripe listen` (CLI prints a signing secret). |
| `STRIPE_SUCCESS_URL` | Absolute URL: **`https://…`** or native **`{APP_SCHEME}://billing/success`** matching the mobile build ([`MOBILE.md`](./MOBILE.md), `app.config.ts` / `APP_SCHEME`). |
| `STRIPE_CANCEL_URL` | Same pattern → `…/billing/cancel`. |
| `STRIPE_BILLING_PORTAL_RETURN_URL` | Same pattern → `…/billing/return`. |

**Quick check (no secrets printed):**

```bash
cd apps/api
export STRIPE_SECRET_KEY=sk_test_…
export STRIPE_WEBHOOK_SECRET=whsec_…
export STRIPE_SUCCESS_URL=https://example.com/billing/success
export STRIPE_CANCEL_URL=https://example.com/billing/cancel
export STRIPE_BILLING_PORTAL_RETURN_URL=https://example.com/billing/return
pnpm smoke:stripe-env
# or: pnpm --filter api smoke:stripe-env
```

The script exits **0** only if the secret key is **test** mode, the webhook secret looks like **`whsec_`**, and all three URLs are non-empty absolute URLs (http(s) or `scheme://`).

---

## Products & prices (Dashboard vs auto-sync)

GymOS **`BillingService.ensureMembershipPlanStripePrice`** (`apps/api/src/billing/billing.service.ts`) will:

1. **Create a Stripe Product** if `MembershipPlan.stripeProductId` is missing.
2. **Create or replace a recurring Price** if `stripePriceId` is missing or **out of sync** with plan amount / currency / billing interval (compared via Stripe API).

So for pilot you can either:

- **Let the API create them** — first successful Checkout path for a plan ensures Product + Price in **test** Stripe and persists IDs on the plan row, **or**
- **Pre-create** Product + Price in the Stripe **test** Dashboard and set `stripeProductId` / `stripePriceId` on the plan (e.g. via admin SQL or a future admin UI).

**Seed fake `price_demo_*` IDs:** the first Checkout attempt will treat them as invalid/out of sync and **create real test prices** — that is expected.

---

## Webhook endpoint

- **Path:** `POST /api/v1/stripe/webhook`  
- **Full URL (example):** `https://<your-api-host>/api/v1/stripe/webhook`  
- **Raw body:** the API uses Express **`raw`** body only for this route — do not put a proxy that re-serializes JSON between Stripe and Nest ([`PRODUCTION_DEPLOYMENT.md`](./PRODUCTION_DEPLOYMENT.md)).

Register the URL on a **Test mode** webhook endpoint in the Stripe Dashboard, or forward with CLI (below).

---

## Webhook events to enable (test endpoint)

Handlers in `apps/api/src/billing/stripe-webhook.service.ts` **dispatch** these types:

| Event | Purpose |
|-------|---------|
| `checkout.session.completed` | Subscription Checkout → fetch subscription → upsert `subscriptions` row |
| `customer.subscription.created` | Upsert subscription |
| `customer.subscription.updated` | Upsert subscription |
| `customer.subscription.deleted` | Upsert / terminal status |
| `invoice.paid` | Upsert `payments` (succeeded), refresh subscription context when linked |
| `invoice.payment_failed` | Record failed payment row; may set subscription **past due** paths |

Enable at least the set above on the **test** webhook. Stripe’s “Send test webhook” from the Dashboard is useful for connectivity; **Checkout** exercises `checkout.session.completed` realistically.

---

## Stripe CLI (local)

1. [Install Stripe CLI](https://stripe.com/docs/stripe-cli).
2. Login: `stripe login`
3. Forward events to local API (adjust host/port):

```bash
stripe listen --forward-to localhost:3000/api/v1/stripe/webhook
```

4. Copy the printed **`whsec_…`** into **`STRIPE_WEBHOOK_SECRET`** for that shell / `.env` (this secret is **different** from Dashboard webhooks; it pairs with `stripe listen`).

5. Optional: `stripe trigger checkout.session.completed` — metadata must still allow your handler to resolve `studioId` / user; real Checkout from the app is usually easier for pilots.

---

## Checkout from the mobile app (test mode)

1. API running with **`sk_test_`** and return URLs matching the app’s **`APP_SCHEME`** (see `apps/mobile/env/.env.*.example` and [`MOBILE.md`](./MOBILE.md)).
2. Member logs in → **Membership** → **Subscribe** → browser opens Stripe **test** Checkout.
3. Use a [Stripe test card](https://stripe.com/docs/testing), e.g. **`4242 4242 4242 4242`**, any future expiry, any CVC.
4. Success redirect should open the app on **`/billing/success`** (or your configured path); then **pull to refresh** on Membership so the client refetches server state.

---

## Billing portal (test mode)

1. User must have a **real** `stripeCustomerId` (created on first Checkout or by API).
2. **Membership** → **Manage billing** → Stripe **test** Customer Portal.
3. Return URL must match **`STRIPE_BILLING_PORTAL_RETURN_URL`**.

---

## Verify data after a successful test Checkout

**Subscription row**

- Table: `subscriptions` (Prisma).
- Expect: `stripeSubscriptionId` like `sub_…` (test), status aligned with Stripe, `membershipPlanId` / `userId` / `studioId` consistent with Checkout metadata.

**Payment row**

- Table: `payments`.
- Often created/updated from **`invoice.paid`** webhook for subscription invoices.
- Expect: `stripeInvoiceId` / optional `stripePaymentIntentId`, `SUCCEEDED` for successful test card flow.

Use Prisma Studio, SQL, or logs — do not paste **`sk_test_`** into chat logs.

---

## Failed payment (test card)

Use Stripe’s **`4000 0000 0000 0341`** (or other [decline / insufficient funds](https://stripe.com/docs/testing#declined-payments) test numbers) in Checkout to drive **`invoice.payment_failed`** paths. Confirm:

- API logs show handler ran without unhandled exceptions.
- `payments` row and/or subscription status reflect your product rules (e.g. **PAST_DUE**).

---

## Safely resetting local test data

- **Database:** `pnpm --filter api exec prisma migrate reset --force` **only** on disposable DBs — destroys all rows ([`DEMO_ENVIRONMENT.md`](./DEMO_ENVIRONMENT.md)).
- **Stripe test mode:** cancel/delete test customers or subscriptions from the **Stripe Dashboard → Test mode** if you need a clean slate; GymOS rows may still reference old ids until you re-seed or delete DB rows.
- **Never** paste **`sk_live_`** into `.env` for dev/demo; **`smoke:stripe-env`** fails on live keys by design.

---

## Billing smoke checklist (test mode)

Use before a pilot call when Stripe test lane is wired:

- [ ] **`pnpm --filter api smoke:stripe-env`** exits **0** (or fix reported lines).
- [ ] **Dashboard test webhook** points at `https://<host>/api/v1/stripe/webhook` **or** CLI `stripe listen` with `STRIPE_WEBHOOK_SECRET` updated.
- [ ] **Events** enabled: `checkout.session.completed`, `customer.subscription.*`, `invoice.paid`, `invoice.payment_failed`.
- [ ] **Member** with **MEMBER** role and studio match; plan **active** in DB.
- [ ] **Checkout** — `4242…` completes; app returns; **Membership** shows active subscription after refresh.
- [ ] **`subscriptions`** row has real **`sub_`** id (test).
- [ ] **`invoice.paid`** path — **`payments`** row appears when applicable.
- [ ] **Billing portal** opens and returns without 500.
- [ ] **Decline path** — failed test card updates state as expected.
- [ ] **No `sk_live_`** in env for this stack.

---

## Recommended next phase

- **Staging-only** Dashboard webhook + fixed staging URL (no CLI) for CI replay tests.
- **Automated e2e** (already partially present) extended with guarded `stripe listen` or Stripe mock for CI.
