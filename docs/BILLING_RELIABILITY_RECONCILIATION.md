# Billing reliability & reconciliation

Branch `feat/billing-reliability-reconciliation` (base `a054151`, production). Follows two incidents:

- **Incident A (Booty Lab, fixed in `8f80f23`)** — Stripe collected renewals but the invoice-line
  parser could not read the dahlia payload, so no entitlement cycle was created.
- **Incident B (a Full Access member, corrected by hand on 2026-10-08)** — Stripe canceled a Full Access
  subscription for non-payment; a concurrently processed `invoice.payment_failed` left GymOS in
  `PAST_DUE`. The failure race was fixed in `8f80f23`; the local row was reconciled manually.

This change makes GymOS **detect and explain** billing inconsistencies before they become
customer-facing, without ever charging twice or silently withholding paid access. It is
detection-first: nothing here repairs membership, payment or Stripe state automatically.

## What was wrong (confirmed in the audit)

| # | Defect | Where |
|---|---|---|
| 1 | A `customer.subscription.updated` processed after `customer.subscription.deleted` set a CANCELED row back to ACTIVE — the update branch wrote `status` unconditionally. | `stripe-webhook.service.ts` upsert |
| 2 | A fixed-duration row with no paid cycle receiving a `canceled` event was left `PAST_DUE` (renewable). | same, fixed-duration post-update |
| 3 | A redelivered, unchanged event still rewrote the row, moving `updated_at` — the date analytics read as the cancellation date. | same |
| 4 | Every Stripe-ended subscription was recorded as `MEMBER_CANCELLED`, including `payment_failed`; staff cancellations from the Admin were also `MEMBER_CANCELLED`. | webhook CANCELED branch, `members.service.ts` |
| 5 | A paid invoice on a canceled/superseded monthly subscription recorded the money and nothing else — silent "paid without access". A superseded fixed-duration row went into a 3-day dead-letter retry loop instead. | `onInvoicePaid` |
| 6 | Refunds and disputes were never mirrored (events ignored). | dispatch |
| 7 | The nightly audit (`scripts/billing-integrity-audit.ts`, Railway cron `billing-integrity-audit`) only logged; the Incident B `local_orphan` sat in logs for ~10 days. It also did not cover paid-without-entitlement. | cron |
| 8 | Two private status mappers defaulted unknown Stripe statuses to ACTIVE (`unpaid`, `incomplete`). | reconciliation + lifecycle services |
| 9 | The reconciliation-audit endpoint returned member emails. | `auditStudio` |

## Design

### Stage 1 — webhook ordering protection (`stale-subscription-event.ts`)

Stripe never moves a subscription out of `canceled`/`incomplete_expired`; a new membership is
always a new subscription id. So when the local row for the same id is CANCELED and an event still
describes it as alive, the event is either stale or GymOS canceled the row itself. Event timestamps
cannot decide this (two events can share a second), so the tie-breaker is **Stripe's current
state, read live (GET) at conflict time**:

| Live Stripe says | Action |
|---|---|
| `canceled` / `incomplete_expired` / no such subscription | `IGNORE_STALE` — event marked processed, row untouched (not even `updated_at`) |
| alive (`active`, `past_due`, …) | `KEEP_LOCAL_OPEN_CASE` — row untouched, HIGH case `LOCAL_CANCELED_STRIPE_ALIVE` |
| unavailable | `RETRY_UNVERIFIED` — handler throws, event stays a visible dead letter, Stripe redelivers |

Only the terminal-conflict path consults Stripe; ordinary events never pay the GET. The live lookup
runs before the member advisory lock so the lock never waits on the network.

Defence in depth inside the transaction: existing rows are written with a **status-conditional
`updateMany`** (`WHERE status = <status read under the lock>`), so a writer that does not take the
member lock (staff override, cash sale) makes the webhook write a no-op and the event is retried
against fresh state. Unchanged events write nothing. A brand-new subscription id is never affected
(A10 in the e2e suite). Kill switch: `BILLING_STALE_EVENT_GUARD=off` restores the legacy upsert.

### Cancellation reasons (`subscription-end-reason.ts`)

Additive enum values: `PAYMENT_FAILED`, `PAYMENT_DISPUTED`, `INCOMPLETE_EXPIRED`, `STAFF_CANCELLED`.
The deletion handler now records what Stripe's facts imply; `cancellation_requested` stays
`MEMBER_CANCELLED` (a request, never a failure — Stripe does not say who clicked and GymOS never
invents an actor). A scheduled cash successor keeps `SUPERSEDED_PAYMENT_METHOD`. An end reason GymOS
already recorded is never overwritten. The Admin status override records `STAFF_CANCELLED` plus an
`audit_logs` row (`SUBSCRIPTION_STATUS_OVERRIDDEN`), and — when Stripe still bills the
subscription — opens a HIGH case immediately.

Analytics: `membershipHealth.cancellationsBreakdown { voluntary, involuntary, superseded }` is added
to the executive dashboard (additive; existing totals unchanged). Historical rows are **not**
rewritten: `scripts/cancellation-reason-backfill-dry-run.ts` is read-only and prints proposals; the
`CANCELLATION_REASON_MISMATCH` detector (LOW) keeps them visible.

### Stage 2 — late-payment policy (`paid-invoice-policy.ts`) and cases

`invoice.paid` always records the Payment first. Then `decidePaidInvoice` classifies:

| Scenario | Entitlement | Case |
|---|---|---|
| A/B/D/F/G/H active, scheduled-to-cancel, recovered failure, plan change, monthly, fixed | normal | none |
| J redelivery of a recorded invoice | idempotent | none |
| C canceled **monthly** (Stripe ended, or GymOS canceled while Stripe bills) | **none** | `PAID_WITHOUT_ENTITLEMENT` CRITICAL (`SUBSCRIPTION_ENDED` / `LOCAL_CANCELED_STRIPE_ALIVE`) |
| C canceled **fixed-duration** | the explicit paid window only; row stays CANCELED | `PAID_WITHOUT_ENTITLEMENT` MEDIUM `LATE_FIXED_WINDOW_GRANTED` (HIGH if Stripe alive) |
| E superseded membership | **none** | CRITICAL `SUPERSEDED_MEMBERSHIP` (event processed, no dead-letter loop) |
| renewal invoice with no local row | — | CRITICAL `NO_LOCAL_SUBSCRIPTION` (first-purchase races are left to the nightly run) |
| I `charge.refunded` / `charge.dispute.created` | untouched | Payment status mirrored; `PAYMENT_REFUNDED_OR_DISPUTED` MEDIUM / HIGH |

Two refinements from the adversarial reviews: a payment whose `paid_at` precedes the stored
`customer.subscription.deleted` event (a replayed or late-delivered invoice for a period the
member consumed while live) is ordinary, not a late payment; and a canceled row whose member
already holds a newer renewable/entitled membership of the same plan family never gets a second
window (`DUPLICATE_MEMBERSHIP_PAYMENT`, CRITICAL). Zero-amount (coupon/balance) invoices obey the
same policy. Refund/dispute charges carry no `invoice` on basil/dahlia payloads: Payments are
matched by PaymentIntent, else through the InvoicePayment resource (GET).

Nothing in this path refunds, voids, reactivates or writes to Stripe.

**Case model** — `billing_reconciliation_cases` (one row per `issueKey =
<studio|platform>:<category>:<ref>`, globally unique): category, severity, status
(OPEN → ACKNOWLEDGED → RESOLVED / DISMISSED), reason code, member/subscription/payment/Stripe refs,
Spanish title/summary/suggested action, PII-free evidence JSON, capped history, first/last observed,
observation and occurrence counts, acknowledgement/resolution/dismissal metadata, alert bookkeeping.
Repeated observation updates the row; a RESOLVED case observed again reopens the same row with
`occurrenceCount + 1`; DISMISSED cases stay quiet. `billing_reconciliation_runs` records each run
and a partial unique index (`run_scope WHERE status='RUNNING'`) forbids overlapping runs.

### Stage 2 — detection (`billing-detector.rules.ts`, `billing-detectors.service.ts`)

Pure rules over PII-free snapshots; the service does bounded IO. Per studio and run: one
`subscriptions.list(status=all)` per member with a Stripe customer (concurrency 4, 429/5xx retry
with backoff, 8-minute deadline, 5,000-member cap with logged truncation), one
`invoices.list(status=open)` per customer with a subscription ended in the last 120 days, and —
once per run — one `refunds.list` and one `disputes.list` over the last 45 days (plus a charge
retrieve only when a refund cannot be matched by PaymentIntent). Members flagged
`excludeFromAnalytics` (review/demo accounts with synthetic Stripe ids) are skipped.

| Brief item | Category / reason | Severity |
|---|---|---|
| 1 Stripe canceled, GymOS alive | `STRIPE_CANCELED_LOCAL_ALIVE` (`STRIPE_CANCELED`, `STRIPE_SUBSCRIPTION_NOT_FOUND`) | HIGH |
| 2 GymOS canceled, Stripe alive | `LOCAL_CANCELED_STRIPE_ALIVE` | HIGH |
| 3 paid without entitlement (monthly / unattributed) | `PAID_WITHOUT_ENTITLEMENT` | CRITICAL |
| 4 fixed-duration paid without cycle | `PAID_WITHOUT_ENTITLEMENT` / `FIXED_DURATION_NO_CYCLE` | CRITICAL |
| 5 stale renewal period | `STALE_RENEWAL_PERIOD` | HIGH (paid, not advanced) / MEDIUM (Stripe ahead) |
| 6 overlapping cycles | `OVERLAPPING_ENTITLEMENT_CYCLES` | MEDIUM |
| 7 failed webhooks | `WEBHOOK_DEAD_LETTER` | CRITICAL for money events, else MEDIUM |
| 8 stuck webhooks | `WEBHOOK_BACKLOG` | MEDIUM |
| 9 inconsistent cancellation reason | `CANCELLATION_REASON_MISMATCH` | LOW |
| 10 open invoice on ended subscription | `OPEN_INVOICE_ON_ENDED_SUBSCRIPTION` | MEDIUM |
| 11 repeated failures | `REPEATED_PAYMENT_FAILURES` | MEDIUM |
| 12 identity mismatch | `SUBSCRIPTION_IDENTITY_MISMATCH` (orphan, duplicate, metadata, customer) | HIGH (customer-not-found: LOW) |

Explicit false-positive exclusions: cash rows, `cancel_at_period_end` (scheduled cancellations),
trials, a 24-hour grace for Stripe→cash period-end handoffs, payments made while the membership was
live, pre-ledger history (before 2026-08-20), compatible multi-membership siblings, other tenants'
subscriptions on a shared customer, grandfathered prices (price drift is not a case), excluded
accounts, and anything acknowledged or dismissed.

Auto-resolution: after a run, active cases in categories whose detector **completed** and that were
not observed are RESOLVED with an automatic note (and reopen on recurrence). Guard rails: a case
first detected or last observed after the run started (a webhook opened it mid-run) is never
touched; reason codes only a webhook can observe (`LATE_FIXED_WINDOW_GRANTED`,
`DUPLICATE_MEMBERSHIP_PAYMENT`, `NO_LOCAL_SUBSCRIPTION`) are never auto-resolved; a PARTIAL run
(Stripe failures, deadline, truncation) never auto-resolves anything. When two rules name the same
issue the most severe view is kept. Refund/dispute cases are window-bounded and only closed by
operators. Webhook-created cases and nightly observations share keys (invoice id for payment
exceptions, local row id for Stripe/GymOS disagreements), so one issue is always one case.

### Stage 3 — Admin

- `GET/POST /studios/:studioId/billing/reconciliation/cases[/:id[/acknowledge|resolve|dismiss|reopen]]`
  (OWNER/ADMIN/STAFF read; OWNER/ADMIN act; every query is studio-scoped; member rendered as
  "Nombre A.", never an email), `POST …/runs` (manual detection), `GET …/runs/latest`.
- `GET …/members/:userId/billing-status` now returns `openCases` (additive).
- Admin: `/billing/exceptions` page (list, filters, detail, actions, "Revisar ahora"), a banner on
  Member 360, and the membership card copy override: while a CRITICAL/HIGH case names a
  subscription the card never says "Al corriente" and never suggests a cash charge.

### Stage 4 — alerts (`billing-alert.service.ts`)

Channels: structured log (always), HTTPS JSON webhook (Slack-compatible `text` + `gymos` object;
the URL must parse as absolute `https://` or the channel is disabled), email through the existing
`EMAIL_PROVIDER` seam. Off by default. One alert per case per channel, driven by `lastAlertedAt`;
CRITICAL/HIGH cases still OPEN after `BILLING_ALERT_ESCALATION_HOURS` are re-alerted once per
window with an `[ESCALACIÓN]` prefix; ACKNOWLEDGED cases never re-alert. At most 25 alerts per run
(a backlog drains over runs); the webhook call times out at 5 s. A provider failure is logged and
written to the case history as a sanitized class (`http_500`, `timeout`, …) — never the provider's
message, which can echo the webhook URL or recipients — and retried next run; it can never fail the
run. If one channel succeeds and another fails the case counts as alerted (no re-send on the
working channel). Each delivery writes an `audit_logs` row (`BILLING_ALERT_SENT`). Alerts carry
studio, category, severity, detection time, a safe member reference ("Nombre A." + id), impact,
recommended action and an Admin deep link; never emails, card data or raw payloads. In a small gym
that reference still identifies a person to whoever reads the channel — pick recipients
accordingly.

### Stage 5 — repair workflows (design only)

Not implemented. The only existing audited repair path (`invoice.paid` redelivery from the Stripe
Dashboard, which regenerates a missing cycle idempotently) is referenced from the
`FIXED_DURATION_NO_CYCLE` suggested action. Autonomous financial repair stays out of scope.

## Environment variables and flags

| Variable | Default | Effect |
|---|---|---|
| `BILLING_STALE_EVENT_GUARD` | on | `off` restores the pre-guard upsert |
| `BILLING_RECONCILIATION_RUN_ENABLED` | true | `false` makes the CLI exit without running |
| `BILLING_ALERTS_ENABLED` | false | outbound alerts (cases are always persisted + logged) |
| `BILLING_ALERT_WEBHOOK_URL` | — | JSON POST endpoint |
| `BILLING_ALERT_EMAIL_TO` | — | comma-separated recipients (needs `RESEND_API_KEY`) |
| `BILLING_ALERT_MIN_SEVERITY` | HIGH | CRITICAL / HIGH / MEDIUM / LOW |
| `BILLING_ALERT_ESCALATION_HOURS` | 24 | re-alert window for unacknowledged CRITICAL/HIGH |
| `BILLING_ALERT_ADMIN_BASE_URL` | — | base for Admin deep links |

## Schema changes

- `20261008200000_subscription_end_reason_involuntary` — `ALTER TYPE "SubscriptionEndReason" ADD VALUE` ×4 (own migration: Postgres cannot use a new enum value in the transaction that adds it).
- `20261008200100_billing_reconciliation_cases` — five enum types, two tables, indexes, FKs, the partial unique run-scope index. Additive only; no existing table or row is touched; FK creation on empty tables takes millisecond locks.

Tested locally with `prisma migrate deploy` on a fresh `gymos_test` (54 → 56; `migrate diff`
reports no residual drift for the new objects). **Not applied to production.**

## Rollout (every step needs explicit approval)

1. **Stage 1+2 code** — merge to `main` (Railway runs `prisma migrate deploy` then starts; the two
   migrations are additive). Webhook guard and late-payment cases activate immediately; alerts
   stay off. **MERGING TO MAIN WILL APPLY THESE MIGRATIONS TO PRODUCTION.**
2. **Cron cutover** — Railway service `billing-integrity-audit` (schedule `0 7 * * *`): change the
   start command to `cd apps/api && node dist/cli/billing-reconciliation.cli.js` (the nixpacks build
   already produces `dist/`). Exit code 0 completed or intentionally disabled / 2 partial / 1 failed.
   The old script keeps working until then. **Environment:** the CLI boots the API's config
   validation (`validateEnv`), so the cron service needs the API's variables, not just
   `DATABASE_URL` + `STRIPE_SECRET_KEY`: in production that is `NODE_ENV`, `DATABASE_URL`,
   `JWT_SECRET`, `JWT_QR_SECRET`, `CORS_ORIGIN`, the six `STRIPE_*`, `EXPO_BUILD_WEBHOOK_SECRET`,
   optionally `RESEND_API_KEY`/`EMAIL_*`, and the `BILLING_*` flags — easiest as Railway reference
   variables (`${{api.X}}`). Verified locally: the compiled CLI boots a minimal Nest context (no
   HTTP server, no schedulers), runs, writes the run row and exits in ~1 s. Optional first run:
   `railway run --service api node dist/cli/billing-reconciliation.cli.js --no-alerts`. A
   studio-scoped manual run (Admin "Revisar ahora") and the all-studio cron have different lock
   scopes and may overlap; observations are idempotent, so this is benign.
3. **Admin** — Vercel deploys from `main`; the page is role-gated (`canManageStudioSettings`).
4. **Alerts** — set `BILLING_ALERT_WEBHOOK_URL` and/or `BILLING_ALERT_EMAIL_TO`, then
   `BILLING_ALERTS_ENABLED=true` on the API service and the cron service. Verify with one run.
5. **Stripe endpoint events** — add `charge.refunded` and `charge.dispute.created` to webhook
   endpoint `we_1TiMByGuUoCXNOREfuujS8qv` (Stripe Dashboard; a Stripe configuration change, not a
   code change). Until then refunds/disputes are only detected by the nightly scan.
6. **Historical end-reason backfill** — run the dry run, review, then apply through an approved
   forward migration/script. Analytics-only.

## Rollback

- Code: redeploy the previous Railway/Vercel deployment. The new tables are ignored by the old
  build. **Rows written with the new `SubscriptionEndReason` values must first be mapped back**
  (`UPDATE subscriptions SET end_reason = 'MEMBER_CANCELLED' WHERE end_reason IN ('PAYMENT_FAILED','PAYMENT_DISPUTED','INCOMPLETE_EXPIRED','STAFF_CANCELLED')`),
  because the old Prisma client fails to read unknown enum values. Expected count: small (only
  cancellations after the release).
- Guard only: `BILLING_STALE_EVENT_GUARD=off`, no deploy (restores the legacy *semantics*: an
  alive event is applied without consulting Stripe; the write stays status-conditional).
- Alerts only: `BILLING_ALERTS_ENABLED=false`.
- Cron only: restore the previous start command.
- Migrations are additive; dropping them is possible but unnecessary.

## Cost and scaling

Per nightly run: Stripe calls ≈ members-with-customer (list, one page each) + customers with a
recent ended subscription (open invoices) + 2 (refunds, disputes) + unmatched refunds (charge
retrieve). ARES today: ~61 + ~12 + 2 ≈ 75 GET requests, well under Stripe's rate limits; the
service retries 429/5xx with exponential backoff and stops at an 8-minute per-studio deadline.
Database: a handful of bounded `findMany` per studio; cases are upserted by unique key. A 1,000-
member gym costs ~1,000 GETs ≈ 4–5 minutes at concurrency 4. The run row and partial unique index
make overlapping cron triggers a no-op (409).

## Production calibration (read-only, 2026-10-08)

The detectors were run against production with a GET-only Stripe client and read-only queries
(no cases persisted). ARES: 60 members checked, 71 Stripe calls, 4.4 s. What would be opened:

| Category | Count | Note |
|---|---|---|
| `OPEN_INVOICE_ON_ENDED_SUBSCRIPTION` (MEDIUM) | 4 | includes the Incident B renewal invoice (MXN 1,500, still open) |
| `CANCELLATION_REASON_MISMATCH` (LOW) | 2 | rows recorded as MEMBER_CANCELLED that Stripe ended for `payment_failed` |
| `REPEATED_PAYMENT_FAILURES` (MEDIUM) | 1 | a PAST_DUE member with 7 declined attempts |
| CRITICAL | 0 | — |

The demo studio yields one LOW `STRIPE_CUSTOMER_NOT_FOUND` (seed data). No dead letters, no
refunds or disputes in the last 45 days. An early rule version flagged two first-purchase payments
as "no local subscription" because the subscription had since moved to another plan; the rule now
requires the member to have no card membership row at all (unit-tested).

## Remaining known gaps

- Repair workflows (Stage 5) are design-only.
- A member whose `stripeCustomerId` was re-linked to a new Stripe customer reads as
  `STRIPE_SUBSCRIPTION_NOT_FOUND` for rows under the old customer (detection lists the current
  customer only) — acknowledge or dismiss such cases.
- FRONT_DESK cannot open the cases page, but sees a member's open-case titles through the Member
  360 billing status (the same surface that already shows that member's billing cards).
- The Admin status override's audit row is written after (not inside) the status transaction.
- Refund/dispute webhooks need the Stripe endpoint subscription (step 5) to be real-time.
- The Admin status override still allows a local-only cancellation of a Stripe-backed row; it is
  now audited and surfaced immediately, but not blocked (product decision).
- `reconcile()` (used by plan-change preflight) still promotes scheduled cash as a side effect —
  unchanged, documented.
