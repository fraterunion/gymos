# Billing — expired cash membership blocks a Stripe purchase (INC-2026-10-19)

## Incident

A member whose **cash** membership had lapsed bought the same plan online. Stripe charged the
card and the subscription is active, but GymOS showed the old cash membership as expired and the
member could not book or check in.

## Root cause

1. Cash sales create the row with `status = ACTIVE`, `cancel_at_period_end = true` and a period
   end. Nothing ever moves a lapsed offline row out of `ACTIVE`: access checks use the dates, so
   the row *looks* expired everywhere, but its **status** stays renewable.
2. Since the multi-membership constraint swap, two partial unique indexes allow one renewable row
   per member per plan and per exclusive group:
   `subscriptions_one_renewable_per_member_plan_idx` and `..._group_idx`
   (`status IN (ACTIVE, TRIALING, PAST_DUE, PAUSED)`).
3. The webhook's "expired cash" branch **inserted the Stripe row first and cancelled the cash row
   second**. The insert violated the index (P2002), the transaction rolled back, and
   `customer.subscription.created` / `checkout.session.completed` dead-lettered (every Stripe retry
   failed the same way). The cash-sale path already did this the right way round ("must
   supersede before create").
4. `invoice.paid` does not go through that path, so it recorded a **SUCCEEDED Payment with no
   subscription**, and for a first purchase the policy deliberately opened no case (a benign race
   is indistinguishable from a failure there). Detection was left to the nightly run.

The unit test for this branch used mocks and asserted the create-then-update order, so the real
index was never exercised.

## Fix (no migration, no new configuration)

`src/billing/webhook-creation-conflict.ts` decides, for the conflicts found under the member lock:

| Conflicting row | Action |
|---|---|
| Offline (CASH/MANUAL, no Stripe id) and its access window has **ended**, same plan | superseded **before** the insert, `SUPERSEDED_PAYMENT_METHOD` |
| Same, other plan in the same exclusive group | superseded before the insert, `SUPERSEDED_PLAN_CHANGE` |
| Expired offline row of another family | untouched (cannot collide with any index) |
| Anything live (Stripe-backed, offline inside its paid window, PAST_DUE/PAUSED offline) | never mutated; webhook acknowledged as before |

`stripe-webhook.service.ts`:

- Supersedes with a status-guarded `updateMany` inside the existing locked transaction (a writer
  outside the lock → `ConcurrentSubscriptionWriteError`, event retried, nothing overwritten),
  then creates the row through the **normal** create path (so fixed-duration plans still start
  `PAST_DUE` until their paid cycle exists — the old branch inserted them `ACTIVE`), then links
  `superseded_by_subscription_id`.
- Links the first-invoice Payment (`latest_invoice`) when the subscription row is created after
  `invoice.paid` already recorded it.
- Immediate detection, keyed exactly like the nightly detectors (one case, never two):
  - acknowledged live conflict → `SUBSCRIPTION_IDENTITY_MISMATCH / STRIPE_ORPHAN` (HIGH);
  - first invoice paid + subscription creation failed (either order) →
    `PAID_WITHOUT_ENTITLEMENT / NO_LOCAL_SUBSCRIPTION` (CRITICAL). The benign race (invoice
    first, creation succeeds) still opens nothing.

Second purchases while an orphaned live Stripe subscription exists were **already** refused
(`assertHealthyForPlanChange` → `BILLING_STATE_REQUIRES_RECONCILIATION`); now covered by e2e.

## Tests

- `test/billing-cash-to-stripe.e2e-spec.ts` (real Postgres, real indexes, real lock, signed
  webhooks): incident order, invoice-first race + payment linking, checkout-first, concurrent and
  repeated deliveries, same-group plan change, live cash never cancelled + immediate orphan case +
  second purchase refused, creation failure in both orders → immediate CRITICAL case,
  fixed-duration variant. **All 9 fail on the previous code** (500 / no case) and pass with the fix.
- Unit: `webhook-creation-conflict.spec.ts`, `paid-invoice-policy.spec.ts`, and the webhook
  conflict tests rewritten to assert cancel → create → link ordering.

## Not in this change

- **Production recovery of affected members** is a separate, operator-approved data procedure
  (guarded single-row supersede under the member lock, then redelivery of the original Stripe
  events, then a guarded link). It does not depend on this code being deployed.
- **Historical backfill** of other lapsed offline rows still marked `ACTIVE` is a separate,
  approval-gated change. With this fix they no longer block an online purchase of the same
  family; expiring their status is a lifecycle decision of its own.
- Cash-sale supersessions and webhook supersessions bump `updated_at`, which the financial feed
  reads as a cancellation date: pre-existing behaviour, unchanged here.
- `last_error` keeps the last failure text after a later successful delivery (cosmetic).
