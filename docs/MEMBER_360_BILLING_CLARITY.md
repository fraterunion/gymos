# Member 360: per-membership billing clarity

Branch `feat/admin-membership-payment-clarity`. **No Prisma migration. No Stripe writes. No change to
pricing or grandfathering. No mobile change.** One additive response field is shared with the member
app: `memberships[].primaryStatus` on the profile (the same operational status `currentMembership`
already carries; mobile ignores unknown fields).

## Problem

The top of the Admin member page summarised only one "primary" membership (status badge,
validity, payment method, a `+1 membresía` chip). Members with two memberships (e.g. a card Pro
plan and a cash Booty Lab plan) could not be read at a glance. Payment states ("Pago pendiente",
"Pago fallido", "Renovación modificada desde Stripe") never said why.

## Root cause (verified against production, read-only, 2026-10-08)

| Gap | Evidence |
| --- | --- |
| Decline reasons are not stored anywhere for memberships | `invoice.payment_failed` writes a FAILED `Payment` with no reason; dahlia invoice payloads carry no decline data; `payment_intent.payment_failed` / `charge.failed` are not enabled on the endpoint (decline codes exist only in Stripe) |
| "Who disabled renewal" is half captured | `AuditLog` records GymOS vs external changes; the customer-portal survey answer arrives in a second Stripe event that is not audited; the timeline never showed the reason or the plan |
| `PAST_DUE` has four causes that look identical | Stripe decline; GymOS demotion after `invoice.payment_failed`; fixed-term plan awaiting its paid cycle; stale row after Stripe already cancelled (pre-2026-10 race) |
| The top card and attention items were primary-only | `currentMembership`-driven badge/validity/method; attention items without plan name; `lastPayment` of any status shown as "Último pago" |

## Design

`GET /studios/:studioId/members/:userId/billing-status` (OWNER, ADMIN, STAFF, FRONT_DESK) returns
one canonical explanation per subscription. It is **staff-only**: the member-facing profile
(`/members/me`) never carries decline codes or Stripe risk outcomes.

Sources, in order of authority:

1. Local rows: subscriptions, payments, `deriveMembershipLifecycle`, paid-without-entitlement.
2. Stored Stripe webhook payloads (`stripe_webhook_events`, filtered by the member's own Stripe
   ids, newest first, capped at 500): Stripe status (a deletion is terminal),
   `cancellation_details` (reason + survey feedback), `cancel_at`, the request id / idempotency key
   of the renewal change, invoice attempt count, next retry and billing reason. No date bound:
   local rows can be linked to a Stripe subscription long after its first events.
3. `AuditLog`: the GymOS actor for GymOS renewal changes; Stripe→cash audits belong to the card
   subscription they stopped.
4. Live, read-only Stripe lookup (`invoices.retrieve`, `invoicePayments.list`,
   `paymentIntents.retrieve`) for failed invoices: decline code, outcome, invoice status. Bounded:
   5 lookups per request, 2.5 s per call, no retries, 4 s deadline, 2 min cache (30 s for errors)
   keyed by studio + member + invoice, concurrent requests share one call. On failure the reason is reported as unknown, never guessed.

A failure is current while Stripe shows its invoice open (a later paid invoice does not resolve
it); without Stripe data, a later paid or refunded payment on the subscription does.

States: `AUTO_RENEW_OK`, `RENEWAL_DISABLED`, `PAYMENT_FAILED` (retry schedule unknown),
`PAYMENT_FAILED_RETRYING` (scheduled or due), `PAYMENT_FAILED_FINAL` (Stripe said no more retries, or
the invoice is closed), `PAYMENT_ACTION_REQUIRED`, `PAYMENT_PENDING`, `INVOICE_PAID_IN_STRIPE`,
`STATUS_MISMATCH` (GymOS ended/paused/current while Stripe says otherwise), `CANCELED_PAYMENT_FAILED`,
`CANCELED`, `ENDED_NOT_RENEWED`, `EXPIRED_UNPAID`, `PAID_WITHOUT_ENTITLEMENT`, `MANUAL_ACTIVE`,
`MANUAL_EXPIRED`, `REPLACED`, `SCHEDULED`, `PAUSED`, `UNKNOWN`. Each carries `certainty`
(`confirmed` / `inferred`), `paymentFailure.detailSource` (`stripe_live` / `webhook_history` /
`local`) and `liveLookup` (`ok` / `unavailable` / `skipped`).

Renewal-change origin:

| Origin | Evidence required |
| --- | --- |
| `GYMOS_STAFF` | a GymOS renewal audit row naming the actor |
| `GYMOS` | a GymOS idempotency key (`gymos_`) without a staff audit (e.g. a plan change) |
| `STRIPE_TO_CASH` | `gymos_stripe_to_cash_` key or Stripe→cash audit row |
| `CUSTOMER_PORTAL` | no API request **and** a cancellation-survey answer |
| `STRIPE_NO_REQUEST` | no API request, no survey answer (worded "probablemente desde el portal") |
| `STRIPE_API` | an API request without a GymOS key (Dashboard or another integration) |

Subscription endings: non-payment / dispute / incomplete first payment are Stripe's own
(`STRIPE_AUTOMATIC`); an end at period end is `PERIOD_END`, attributed to whoever switched renewal
off earlier, never to the automatic deletion event.

Decline codes for lost/stolen/fraud cards are withheld from staff copy (generic decline), following
Stripe's guidance not to reveal them.

## Admin

- Top area: one card per current membership (status from the API, payment state, validity,
  credits, renewal, payment method), the reason in plain Spanish, a caution wherever a manual charge
  could double-charge, and the next action. The `+1 membresía` chip and the primary-only badge are
  gone. Manual renewals point to Ventas.
- "Atención requerida" only drops the items the primary membership's card already explains;
  credit and "ending soon" nudges stay.
- "Pagos" KPI, the Resumen "Facturación" block and the Facturación tab name the plan with the
  problem; a failed charge is never labelled "Último pago".
- Timeline: failed payments say plan, amount, reason and running attempt totals; renewal changes
  say who and when (no consequence that may have changed since); Stripe cancellations (including
  period ends) and Stripe→cash changes appear.

Copy lives in `apps/admin/src/lib/membershipBilling.ts` (tested in `membershipBilling.spec.ts`).

## Known limitations / follow-ups

- Decline reasons rely on a live Stripe read. Durable per-attempt history would need either a
  schema change (failure columns on `Payment` or an attempts table) or enabling
  `payment_intent.payment_failed` on the endpoint (a Stripe configuration change). Not done here.
- Stored events are matched by JSON path on `stripe_webhook_events` (no object-id column or index).
  Fine at today's size (hundreds of rows); add an indexed column if it grows.
- A subscription GymOS still shows as `PAST_DUE` after Stripe cancelled it (pre-fix race) is now
  flagged; correcting the row is a separate, approved production write.
- `endReason` still records Stripe cancellations for non-payment as `MEMBER_CANCELLED`; the
  explanation uses Stripe's `cancellation_details.reason` instead.
- The member directory list and other surfaces still use their own status summaries.
