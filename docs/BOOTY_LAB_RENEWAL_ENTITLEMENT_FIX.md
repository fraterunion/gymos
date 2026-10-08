# Booty Lab renewal entitlement fix — release and recovery procedure

Branch `fix/booty-renewal-entitlement` (base `origin/main` 032a228; the API code is identical to the
production deployment 5e84d2a). **No Prisma migration. No Stripe write anywhere.**

## Incident

On 2026-10-02 two ARES members on Booty Lab by Etzia (MXN 800 every 45 days) were renewed and
charged by Stripe. GymOS saved both Payments but never created their next 45-day
`MembershipEntitlementCycle`, so both lost access while paid through 2026-11-16.

Root cause: the live webhook endpoint is pinned to Stripe API `2026-05-27.dahlia`. In that shape an
invoice line has no top-level `price`; the Price is at `lines.data[].pricing.price_details.price`,
and the subscription linkage and proration flag are under `lines.data[].parent.subscription_item_details`.
`grantFixedDurationCycleForPaidInvoice` matched `line.price?.id`, found nothing, threw after the
Payment upsert, returned HTTP 500, and Stripe gave up after 7 attempts.

## What changed

| Area | Change |
| --- | --- |
| `billing/stripe-invoice-lines.ts` (new) | One runtime-validated invoice-line parser for basil/clover/dahlia and legacy shapes. Accepts Stripe's zero-length one-off item periods; reads `subtotal` (pre-discount). Unsupported shapes fail explicitly. |
| `billing/fixed-duration-invoice.ts` (new) | Pure classifier: exactly one subscription-item, non-proration, exact-`entitlementDays`, priced line of THIS subscription, whose Price is the catalog Price, any Price of the plan's Product, or belongs to a Stripe subscription sold as this plan (checkout `planId` metadata). Grandfathered Prices keep renewing. Truncated line pages are never trusted. Typed `FixedDurationEntitlementError`. |
| `billing/fixed-entitlement-cycle.ts` | `planPaidCycleInsertion`: exactly-once per invoice, overlap checked against every cycle, `live` vs `historical_gap_fill`, `already_covered` for identical legacy backfill windows. |
| `billing/stripe-webhook.service.ts` | Grant uses the classifier and planner under the member-scoped subscription-write lock plus the subscription lock; re-reads plan and status under the locks; never resurrects CANCELED; refuses rows already superseded by a successor; moves the current period only for live renewals. Payment is still recorded first. Retryable error when a plan change INTO a fixed-duration plan has not synced locally yet. PaymentIntent reference filled best-effort AFTER the grant. `invoice.payment_failed` writes FAILED conditionally (a SUCCEEDED payment always wins) and never demotes a non-renewable (e.g. CANCELED) row. |
| `billing/stripe-webhook-idempotency.ts` | A stored event an operator resolved (`resolved_at`) is never re-processed by a later delivery or resend. |
| `billing/paid-without-entitlement.ts` (new) | Read-only detection of "paid fixed-duration invoice without its cycle", ignoring pre-ledger payments and operator-acknowledged invoices. Used by Member 360 and the studio reconciliation audit (critical, manual). |
| `members/members.service.ts` | Member 360 attention item `PAID_WITHOUT_ENTITLEMENT`; EXPIRED action is `REVIEW_BILLING` (not `RENEW`) while Stripe still renews the card subscription. Additive response field `paidWithoutEntitlement`. |
| Admin Member 360 | Billing shows "Pagado sin acceso"; a past entitlement end is never shown as "Próximo cobro"; "Renovar membresía" becomes "Revisar cobro antes de renovar" for expired-but-live card subscriptions. |
| `stripe/stripe.service.ts` | Read-only `findPaidInvoicePaymentIntentId` (3 s timeout, no retries). |
| `scripts/fixed-duration-recovery-dry-run.ts` (new) | READ-ONLY recovery verification and preflight (see below). |
| Tests | Sanitized production payloads in `test/fixtures/stripe-webhooks/`; unit, harness and e2e coverage; three date-dependent test fixtures made deterministic. |

Unchanged by design: grandfathering (members keep their historical Stripe Price), Stripe
subscriptions and catalog Prices, monthly plan renewals and period sync, plan-change flows, Day
Pass, mobile.

Visible on monthly plans too: a late `invoice.payment_failed` no longer overwrites a paid invoice
or reopens a cancelled subscription; an expired-but-still-renewing card membership shows
"Revisar" instead of "Renovar"; each paid basil/dahlia invoice triggers one read-only Stripe lookup
to fill `Payment.stripePaymentIntentId`.

## Pre-release gate

1. CI green on the branch (unit, e2e, typecheck, lint, build). Commit the fixtures, e2e spec and
   this document together with the code.
2. Read-only dry-run against production returns `ALL_TARGETS_SAFE_TO_RECOVER`. That verdict
   requires every target check, the studio-wide scan matching the targets, and the preflight
   (each fixed-duration plan's catalog Price and every live subscription item on the plan's
   Product with a `day × entitlementDays` interval):
   ```
   cd apps/api
   railway run --service api npx tsx scripts/fixed-duration-recovery-dry-run.ts --json /tmp/dry-run.json
   ```
3. Explicit owner approval to release (merging to `main` deploys the API through Railway).

## Deployment (requires explicit approval)

1. Merge to `main`. Railway builds and deploys the API; `prisma migrate deploy` reports no pending
   migration.
2. The admin ships through its existing pipeline from `main` (docs list Vercel; Railway also has an
   `admin` service — confirm which one serves admin.arestrainingclub.com). All API response changes
   are additive, so the old admin bundle keeps working. No mobile OTA is needed.
3. Post-deploy read-only checks: `/health` 200; `railway logs --http` shows
   `POST /api/v1/stripe/webhook 200`; no `fixed_duration_entitlement_grant_failed` log lines.

## Recovery for the two members (separate explicit approval)

| Member | Local subscription | Invoice | Event to re-deliver | Expected cycle |
| --- | --- | --- | --- | --- |
| Member A | `cmsywkujs0009rr1yyx14cm28` | `in_1UM9kDGuUoCXNOREOOyKkEXv` | `evt_1UMAgjGuUoCXNOREqTEvNmVj` | 2026-10-02T16:54:40Z → 2026-11-16T16:54:40Z, 4 credits |
| Member B | `cmsyxnrwb000wrr1yowl06lby` | `in_1UMADXGuUoCXNORECKKIw6Gd` | `evt_1UMBAhGuUoCXNOREucU2tLEw` | 2026-10-02T17:24:56Z → 2026-11-16T17:24:56Z, 4 credits |

Before recovery: brief staff not to renew, sell cash, change plan or run a Stripe→cash transition
for either member until they are recovered (each would collect a second payment for a paid period).

Mechanism: re-run the dry-run immediately before each step (it also confirms the stored event is
still replayable: `processed = false`, `resolved_at` null), then re-deliver that member's stored
`invoice.paid` event to the production endpoint `we_1TiMByGuUoCXNOREfuujS8qv` — Stripe Dashboard
"Resend" (possible until ~2026-10-17) or
`stripe events resend <evt> --webhook-endpoint we_1TiMByGuUoCXNOREfuujS8qv` (until ~2026-11-01).
The fixed handler then increments the stored event's attempt, updates the EXISTING Payment row in
place (same amount; fills the missing PaymentIntent reference), inserts exactly one cycle, moves the
subscription's entitlement end to 2026-11-16 and marks the event processed. It never charges,
invoices, refunds or modifies anything in Stripe. Re-delivering twice is a no-op.

Order: Member A first, verify, then Member B. Settle Member B's case first (keep access vs refund):
their renewal was switched off from outside GymOS shortly after the charge. Recovery must complete
before Member A's next renewal (2026-11-16 16:54:40Z): after that the Oct 2 period could only be
added as a historical gap fill, which grants no current access.

If a member is refunded instead of recovered: the Stripe refund is its own approval; then, as a
separately approved one-row write, set `resolved_at` and `resolution_note` on that member's stored
`invoice.paid` event so the paid-without-entitlement flag clears (detection treats resolved events
as acknowledged). Do not re-deliver a refunded invoice's event.

Verification after each resend: the dry-run must report `ALREADY_RECOVERED` for that invoice and
the studio-wide scan must no longer list it; Member 360 must no longer show "Pagado sin acceso".

## Rollback

API: redeploy the previous Railway deployment (65cd7034 / 5e84d2a). There is no migration to
revert. Rows written by the new code (cycles, Payment PaymentIntent references, subscription
periods) are valid for the old code. Rolling back re-introduces the original defect for future
fixed-duration renewals. Admin: promote the previous admin deployment on whichever host serves it.

## Known limitations and follow-ups (not in this release)

- Editing a fixed-duration plan's `entitlementDays` while card subscribers exist makes their next
  renewals fail loudly (period mismatch, payment kept, dead letter). Guard that edit.
- Legacy attribution owns NULL-attributed usage through the subscription's current window, so a
  recount of an old cycle only sees explicitly attributed usage once the period moves (pre-existing).
- A paid invoice the classifier deliberately skips (proration-only, trial plus fee) is reported by
  the detector until an operator acknowledges it.
- A card row carrying a stale `supersededBySubscriptionId` (an abandoned Stripe→cash transition)
  refuses its renewal grant loudly (payment kept, dead letter) until an operator reviews it.
- The checkout-metadata Price match is disabled while a plan change is pending and refused when the
  billed Price/Product belongs to another plan; it covers catalog drift on a single fixed plan.
- Other renewal entry points (members list "Renovar", Sales purchase options, ZERO_CREDITS/ENDING
  prompts, "Cambiar plan") are not yet aware of paid-without-entitlement.
- Scheduled alerting on dead-lettered webhook events and on `paid_without_entitlement` (needs a cron
  approval); making the reconciliation audit strictly side-effect free.
- `endReason` for Stripe cancellations caused by payment failure (currently `MEMBER_CANCELLED`);
  back-filling `stripePaymentIntentId` on historical Payment rows; aligning the SDK API version
  (`2025-08-27.basil`) with the endpoint version (`2026-05-27.dahlia`).
- Observed, not verified: Checkout passes `add_invoice_items` inside `subscription_data`
  (billing.service.ts); check it before activating the enrollment fee.
