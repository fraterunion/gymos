# Day Pass purchase lifecycle — audit, root cause and durable fix

**Status:** approved for controlled release 2026-09-23. API ships first; the hourly lapse sweep ships **disabled** (`DAY_PASS_SWEEP_ENABLED=0`) so the deploy changes no existing row. Mobile OTA follows after the API production gate.
**Scope:** ARES (`ares-fitness`, studio `cmp33m0gp0000qomlj9p42ia5`), API + mobile. Audit date 2026-09-23.
**Reviewer decision required:** GO / NO-GO (section 19) and the four operator actions in section 16.

---

## 1. Executive summary

A member who opens PaymentSheet for a Day Pass and closes it without paying (or is declined) can never buy that day's pass again: every retry answers **409 "A Day Pass already exists for this date"** in English. The cause is a modelling error, not an infrastructure fault: the API creates the `day_passes` row **before** money moves, with `status = PENDING`, and then treats that row as ownership in both its pre-check and the status-agnostic unique index. Nothing ever moves a PENDING row again unless Stripe reports success, and the only Stripe signal the API listens for (and the only one the production endpoint is subscribed to) is `payment_intent.succeeded`.

Production confirms it exactly: ARES has 21 Day Pass rows, **13 PENDING**, and every one of the 13 maps to a Stripe PaymentIntent still in `requires_payment_method` (abandoned, never paid). 8 rows are ACTIVE and healthy. No member was double-charged and no paid member lacks a pass.

The fix keeps the one-row-per-member-per-day slot but redefines it as a **retry-safe attempt slot**: only `ACTIVE` is ownership, and only a Stripe-confirmed success sets it (one shared routine used by the webhook, the API's live Stripe check on retry, a new post-payment sync endpoint and reconciliation). A retry re-presents the same PaymentIntent while Stripe still allows it, or replaces it with an idempotency-keyed new one. Every slot write is a compare-and-swap so a payment that lands mid-retry can never be downgraded or double-intented. Additive migration only; Spanish copy end to end; 68 new automated tests (unit + e2e + mobile) all green.

## 2. Root causes (ranked)

| # | Defect | Where | Severity |
|---|--------|-------|----------|
| 1 | PENDING treated as ownership: pre-check `status IN (ACTIVE, PENDING)` → 409, and the unique `(studio_id,user_id,valid_for_date)` index → P2002 → same 409. No transition exists for cancel/decline. | `day-passes.service.ts` (old lines 85–96, 133–138) | **Critical — the reported bug** |
| 2 | No handling of `payment_intent.payment_failed` / `payment_intent.canceled`, and the production webhook endpoint is subscribed to `payment_intent.succeeded` only. Failed attempts are invisible to GymOS. | `stripe-webhook.service.ts` dispatch; Stripe Dashboard | High |
| 3 | Client cancel is swallowed silently on mobile and never reported; the server-side rollback only covers server-side exceptions. | `membership.tsx` (old buyDayPass); `rollbackNewPendingDayPass` | High |
| 4 | PaymentIntent created without an idempotency key; the unique index was doing double duty as concurrency guard and ownership guard. | `stripe.service.ts` `createPaymentIntent` | Medium |
| 5 | English 409 leaks verbatim to the member (`userFacingApiMessage` has no mapping; message < 180 chars passes through). | `apps/mobile/lib/userFacingApiMessage.ts` | Medium (UX) |
| 6 | Client decides the target date (`todayKeyInZone(timeZone)` with a `'UTC'` fallback); server accepted any non-canonical future key (e.g. `2026-13-01`). | `membership.tsx`, DTO regex | Medium |
| 7 | Mobile declares "Pase diario activado." from the PaymentSheet result before the webhook activates anything. | `membership.tsx` | Medium (UX/trust) |
| 8 | Coverage: no unit spec for the service; the one e2e hit only the 201/400 path (in the settings suite), never the 409, the webhook activation, or the rollback. | tests | Medium |
| 9 | No expiry of lapsed attempts (schema anticipated a sweep that was never built); `listMyDayPasses` showed PENDING rows as "Pendiente" forever. | service, mobile list | Low |

Adversarial verification: each claim above was attacked by three independent reviewers reading the code; all held. The only correction was to #8's original wording ("zero coverage"): a shallow 201/400 e2e exists in `day-pass-settings.e2e-spec.ts`.

## 3. Current (pre-fix) state machine

```
(no row) --POST payment-sheet--> PENDING (row created BEFORE PaymentIntent)
PENDING  --payment_intent.succeeded webhook--> ACTIVE  (only transition that existed)
PENDING  --server-side exception during PI/ephemeral key--> (row deleted)
PENDING  --member cancels sheet / card declined / app killed--> PENDING (forever)
PENDING  --POST payment-sheet (retry)--> 409 "A Day Pass already exists for this date"
EXPIRED, REFUNDED: unreachable (never written anywhere)
```

## 4. Why abandoning blocks (traced)

1. Tap "Comprar pase diario" → `POST /studios/:id/day-passes/payment-sheet {validForDate: today}`.
2. Server: waiver check → price resolve → `dayPass.findFirst(status IN ACTIVE,PENDING)` → none → `dayPass.create(PENDING)` → `paymentIntents.create` → `dayPass.update(stripePaymentIntentId)` → ephemeral key → 201.
3. PaymentSheet opens with that intent. Member closes it. Stripe: intent stays `requires_payment_method`; **no webhook fires** (abandonment is not an event). Mobile: `presentError.code === 'Canceled'` → `return` (no API call).
4. Tap again → step 2's `findFirst` finds the PENDING row → `ConflictException('A Day Pass already exists for this date')`.
5. Mobile `userFacingApiMessage` has no rule for it → raw English string rendered.

Stripe Dashboard shows one "Incomplete" MX$250 intent per tap that reached step 2 on a fresh day; the second and later taps never reach Stripe at all (they 409 first), which is why the operator sees several incomplete intents across days but one per day.

## 5. Production impact (ARES, read-only forensics)

| Metric | Value |
|--------|-------|
| Day Pass rows (lifetime) | 21 |
| ACTIVE (paid) | 8 — all have a `succeeded` intent and a `SUCCEEDED` Payment row |
| PENDING | 13 — **all 13 intents live status `requires_payment_method`** (abandoned; none canceled, none paid) |
| EXPIRED / REFUNDED | 0 / 0 |
| Distinct members holding a PENDING row | 9 |
| PENDING amounts | 1 × MX$10 (2026-06-14, launch QA era), 6 × MX$200, 6 × MX$250 |
| Duplicate rows per member-day / duplicate ACTIVE | 0 / 0 |
| Local SUCCEEDED payment without ACTIVE pass / ACTIVE without payment | 0 / 0 |
| Members blocked at audit time | 1 (PENDING row for 2026-09-22, the operator's repro); the other 12 rows are past dates and only blocked on their own day |
| Webhook events `payment_intent.succeeded` (lifetime) | 50, all processed; 0 `payment_failed`/`canceled` ever received |
| Production webhook endpoint | subscribed to 7 events, **only `payment_intent.succeeded` among `payment_intent.*`**; endpoint API version `2026-05-27.dahlia` vs SDK `2025-08-27.basil` |
| Stripe-side check: `succeeded` day-pass intents for ARES | 9. 8 match the ACTIVE rows. **1 anomaly:** MX$10 intent of 2026-06-14 whose `dayPassId` row and user no longer exist locally (user hard-deleted; consistent with launch-QA demo cleanup). Its webhook was processed and logged "DayPass not found; skipping". No member impact; no Payment row. Operator may refund the MX$10 test charge or leave it. |

Anonymised PENDING examples (slot / member / date / amount / age): `cmqe…jg1 / cmqc…6q0 / 2026-06-14 / MX$10 / 100d`; `cmtr…0q5 / cmtr…vad / 2026-09-07 / MX$250 / 15d`; `cmu0…170 + cmu2…8cf / cmu0…6ps / 2026-09-13, 09-15 / MX$250` (same member blocked twice on two days); `cmud…j71 / cmu6…5pn / 2026-09-22 / MX$250 / 0d` (repro).

## 6. Stripe ↔ DB correctness audit

| Item | Before | After |
|------|--------|-------|
| Amount / currency authoritative server-side | ✅ (`resolveCheckoutSalePrice`, cross-checked with Stripe Price) | ✅ unchanged |
| Metadata for correlation | ✅ type/dayPassId/studioId/userId/validForDate/stripePriceId | ✅ + `attempt` |
| Idempotency key on `paymentIntents.create` | ❌ none | ✅ `day_pass:<slot>:a<n>:<price>:<currency>` — a retried HTTP call or a crash between Stripe and DB replays the same intent |
| Double tap cannot double-charge | ✅ (only via unique index / busy flag) | ✅ busy flag + synchronous in-flight ref + slot unique index + idempotency key + CAS bind |
| PaymentIntent reuse | ❌ never; 409 | ✅ re-present same `client_secret` when `requires_payment_method`/`requires_confirmation` and amount/currency/customer/metadata still match |
| `canceled` intent | ❌ blocks forever | ✅ replaced with a new intent; old id kept in slot history |
| `requires_action` (stuck 3DS) | ❌ blocks | ✅ canceled + replaced (never re-presented, no loop) |
| Replace only after the old intent is dead | n/a | ✅ a stale or `requires_action` intent must be confirmed **canceled** before a replacement is minted; if the cancel fails the live status decides (succeeded → activate + "owned", processing → "en proceso", still payable → "intento en curso", nothing minted) |
| Idempotency key never replays a failure | n/a | ✅ the attempt number is reserved (compare-and-swap) **before** calling Stripe; a failed create burns that number, so the next retry uses a new key instead of replaying a stored 5xx all day |
| Refunded payments | n/a | ✅ an intent refunded at Stripe (expanded `latest_charge.amount_refunded`) or whose Payment row is REFUNDED never activates; a REFUNDED slot answers "Contacta a tu estudio" instead of re-opening |
| `processing` | n/a (blocked earlier) | ✅ 409 "Tu pago está en proceso…" — never re-present, never cancel |
| `succeeded` but webhook missing | ❌ blocks with wrong message | ✅ activated on retry from live Stripe status, then 409 "Ya tienes un pase diario activo…" |
| `payment_failed` webhook | ❌ not handled, not subscribed | ✅ handler caches decline code on the CURRENT intent only; slot stays reusable; **endpoint subscription is an operator action** |
| `canceled` webhook | ❌ | ✅ handler (same guards) |
| Signature verification | ✅ raw body + `constructEvent` | ✅ unchanged |
| Webhook idempotency | ✅ event-id claim + Payment upsert | ✅ + activation routine idempotent (`already_active`) |
| Ordering: failure after success | ✅ (no handler) | ✅ ACTIVE never downgraded (tested) |
| Replay cannot grant twice | ✅ | ✅ tested (e2e E3: same event id twice + second event id) |
| Client cannot forge paid | ✅ | ✅ sync endpoint asks Stripe; client status is never written |
| Stale intent does not block | ❌ | ✅ (the fix) |
| Amount validated on success | ❌ Payment written with DB price | ✅ Payment records the intent's real amount; mismatch logged (warn), entitlement still follows the money |
| Paid replaced intent | ❌ ignored ("already linked to different PI") | ✅ honoured: becomes intent of record, unpaid replacement canceled; if slot already ACTIVE on another intent → Payment recorded + `double_payment_suspected` error event for refund |
| API version consistency | ⚠️ endpoint `dahlia` ≠ SDK `basil` (pre-existing; invoice code already handles both shapes; the `payment_intent` fields used here are stable across both) | unchanged — recommend aligning the endpoint version to `2025-08-27.basil` in the Dashboard (operator) |

## 7. Timezone / target-date audit

* Server: `getStudioLocalDateKey(now, studio.timezone)` (Intl, formatToParts) and `studioLocalDateKeyToUtcAnchor` (DST-safe, round-trip verified). ARES = `America/Mexico_City` (no DST since 2023; handled by tzdata, not code). ✅
* Booking access keys off the **class start** date with strict anchor equality; yesterday's/tomorrow's rows cannot leak into today. ✅
* Client previously computed the date with `matched?.studio.timezone ?? 'UTC'`; with the UTC fallback after 18:00 CDMX it would buy tomorrow. **Fixed:** the app now omits the date and the **server picks today in the studio timezone**. `validForDate` remains optional for older app builds and is now (a) canonical-form checked (`2026-13-01` is rejected instead of silently becoming 2027-01-01), (b) not in the past, (c) within `MAX_DAYS_AHEAD = 30`.
* Midnight edge: a sheet opened at 23:59 and confirmed at 00:01 activates a pass for a day that just ended. Money is honoured (ACTIVE), logged at warn. Residual, rare; policy is the operator's (section 18).

## 8. Corrected state machine

```
STATES (enum unchanged: PENDING | ACTIVE | EXPIRED | REFUNDED)
  ACTIVE   = purchased. The ONLY ownership state. Written by exactly one routine
             (day-pass-activation.ts) from a Stripe-reported `succeeded` intent.
  PENDING  = open attempt slot for that member-day. NOT ownership. Sub-state is the LIVE
             Stripe status of its current intent (cached in last_stripe_status, never authority).
  EXPIRED  = attempt whose studio-local day lapsed unpaid (sweep / reconciliation).
  REFUNDED = terminal; set only by an operator. Never re-opened automatically (409 "contacta a tu estudio").

TRANSITIONS
  none ──POST──▶ PENDING(a1)                 create slot, mint intent a1 (idempotency-keyed), CAS-bind
  PENDING ──POST, intent requires_payment_method|requires_confirmation & matches sale──▶ PENDING(a+1)   REUSE same client_secret
  PENDING ──POST, intent canceled|missing──▶ PENDING(a+1)                                  REPLACE (old → history)
  PENDING ──POST, intent requires_action|stale price/customer──▶ cancel at Stripe; CONFIRMED canceled ──▶ PENDING(a+1) REPLACE
                                                                   cancel failed ──▶ live status decides (owned / processing / in progress), nothing minted
  PENDING ──POST, intent processing──▶ 409 dayPassPaymentProcessing (no write to intent)
  PENDING ──POST, intent succeeded──▶ ACTIVE, then 409 dayPassAlreadyOwned   (self-heal)
  PENDING ──POST, slot has no intent and is younger than 60 s──▶ 409 dayPassAttemptInProgress (concurrent creation)
  PENDING ──POST, slot has no intent, older than 60 s──▶ PENDING(a+1) takeover (crashed request)
  PENDING|EXPIRED ──payment_intent.succeeded (webhook) | sync | retry | sweep──▶ ACTIVE (+ Payment upsert)
  PENDING ──payment_intent.payment_failed──▶ PENDING (decline code cached; only if intent is current)
  PENDING ──payment_intent.canceled──▶ PENDING (last_stripe_status=canceled; retry replaces)
  PENDING ──sweep (only if DAY_PASS_SWEEP_ENABLED=1), day lapsed, Stripe says requires_*|canceled|missing──▶ EXPIRED
  PENDING ──sweep (only if enabled), day lapsed, Stripe says succeeded──▶ ACTIVE (never expire a paid attempt)
  ACTIVE  ──POST──▶ 409 dayPassAlreadyOwned
  ACTIVE  ──payment_failed|canceled──▶ ACTIVE (ignored; out-of-order safe)
  REFUNDED ──POST──▶ 409 dayPassNeedsSupport (operator decides; no automatic re-open)
  any ──succeeded intent refunded at Stripe / Payment REFUNDED──▶ no activation (flagged by reconciliation)

INVARIANTS ENFORCED
  * at most one row per member-day (unique index) ⇒ at most one ACTIVE per member-day
  * every slot write after a Stripe read is a compare-and-swap on (status ≠ ACTIVE, same intent);
    a miss re-reads the slot and answers 409 owned / in-progress — never overwrites, never downgrades
  * activation itself is a compare-and-swap on (the status and intent it read); a concurrent replace
    makes it re-read (up to 3 times) and rebind the PAID intent while pushing the unpaid replacement
    into the trail and cancelling it — so no issued intent is ever lost from the slot's history
  * an intent minted by a CAS loser is canceled ONLY if the slot is not now bound to it
  * the attempt number (and therefore the idempotency key) is reserved by compare-and-swap before
    Stripe is called: concurrent replacers cannot both reach Stripe, and a failed create never
    leaves a key that replays the failure
  * the Payment row is written (idempotently) before the slot is promoted, so a crash between the
    two completes on redelivery instead of stranding an unpaid replacement intent
  * an intent is re-presented only while Stripe can still confirm it; canceled/processing/succeeded never
  * the mobile client's PaymentSheet result never writes state; it triggers a server→Stripe check
```

## 9. Architectural decision

Three options were designed independently and evaluated against the twelve invariants in the brief (the scoring panel could not run because the agent session limit was hit; evaluation below is mine, informed by the two completed architect write-ups and the audits):

* **A — attempt slot with server-authoritative reuse (CHOSEN).** Keeps the existing unique row; adds only telemetry columns; no enum change; no index change; no lock held across Stripe calls (CAS instead). Smallest blast radius, fully additive, rollback-safe, and the existing 8 ACTIVE rows and their Payments are untouched by construction.
* **B — separate attempt table from entitlement.** Cleanest ledger, but requires a new table, dual-path webhook handling for in-flight legacy intents, and larger review surface for a bug whose whole footprint is one row per member-day. Deferred; the `previous_stripe_payment_intent_ids` trail gives the audit value of a ledger without it.
* **C — partial unique index `WHERE status='ACTIVE'` + per-row ledger.** Needs dropping/replacing the production unique index (not purely additive), partial indexes invisible to Prisma (future `migrate dev` may propose dropping them), and an advisory lock held across up to three Stripe calls. Rejected for this incident.

## 10. Implementation changes (local, uncommitted)

**API — new**
* `apps/api/src/day-passes/day-pass-activation.ts` — the single activation routine (webhook, API retry, sync, sweep, reconciliation all use it).
* `apps/api/src/day-passes/day-pass-attempt-sweep.service.ts` — hourly Stripe-aware lapse sweep (`20 * * * *`). **Registers no cron unless `DAY_PASS_SWEEP_ENABLED=1`**; skipped under `GYMOS_E2E`.
* `apps/api/src/day-passes/day-pass-events.ts` — structured `DAY_PASS_*` events.
* `apps/api/prisma/migrations/20260923120000_day_pass_attempt_lifecycle/migration.sql` — additive.
* `apps/api/scripts/day-pass-reconcile.ts` — dry-run/apply reconciliation (section 14). **Note:** `apps/api/scripts/` holds untracked ad-hoc files; this one must be staged explicitly.
* Specs: `day-passes.service.spec.ts` (27), `stripe-webhook.service.day-pass.spec.ts` (14), `day-pass-attempt-sweep.service.spec.ts` (7), `validate-env.day-pass.spec.ts` (2), `test/day-pass-lifecycle.e2e-spec.ts` (11).

**API — modified**
* `day-passes.service.ts` — rewritten around the slot (reuse / replace / self-heal / CAS), `syncDayPassFromStripe`, `listMyDayPasses` returns ACTIVE only, server-decided date + canonical/horizon guards, Spanish errors.
* `day-passes.controller.ts` — `POST /studios/:studioId/day-passes/:dayPassId/sync` (member-scoped).
* `dto/create-day-pass-payment-sheet.dto.ts` — `validForDate` optional.
* `day-passes.module.ts` — registers the sweep.
* `billing/stripe-webhook.service.ts` — `payment_intent.succeeded` delegates to the shared routine (+ cancels a superseded intent); new `payment_intent.payment_failed` / `payment_intent.canceled` handler.
* `billing/stripe-webhook-payloads.ts` — `last_payment_error`, `cancellation_reason`, `canceled_at`.
* `stripe/stripe.service.ts` — `createPaymentIntent(params, options)`, `retrievePaymentIntent`, `cancelPaymentIntent`.
* `member-facing/member-errors.ts` — five Day Pass messages.
* `config/validate-env.ts`, `.env.example` — `DAY_PASS_SWEEP_ENABLED` and `DAY_PASS_SWEEP_CANCEL_STRIPE_INTENTS`, both normalised to `0`/`1`, both default off.
* `prisma/schema.prisma` — DayPass model only (formatter churn removed; 21-line diff).
* `test/helpers/stripe-service.e2e-mock.ts`, `test/day-pass-settings.e2e-spec.ts` — mock + assertion for the new call shape.

**Mobile — new/modified (JS only)**
* `lib/dayPassPurchase.ts` (+ `__tests__/dayPassPurchase.test.ts`, 9) — pure outcome mapping, Spanish copy, double-tap guard.
* `lib/api/dayPassesApi.ts` — date optional; `syncDayPass`.
* `lib/userFacingApiMessage.ts` (+ tests) — Day Pass messages incl. the legacy English 409 (mapped to retry copy, never to "you already own it").
* `app/(app)/(tabs)/membership.tsx` — `buyDayPass` rewritten (section 12).

## 11. DB / migration changes

`ALTER TABLE day_passes ADD COLUMN …` × 8, all nullable or constant-default: `previous_stripe_payment_intent_ids TEXT[] DEFAULT '{}'`, `attempt_count INT DEFAULT 1`, `last_attempt_at`, `last_stripe_status`, `last_payment_error_code`, `last_payment_decline_code`, `activated_at`, `expired_at`. No enum value added, no index/constraint touched, no row updated. Postgres ≥ 11 stores constant defaults in the catalog (no rewrite); 21 rows anyway. Safe under Railway's `prisma migrate deploy && start:prod`: the previous build keeps working against the new columns, so a code rollback needs no schema rollback. Applied and exercised on the local `gymos_test` database only.

## 12. Mobile UX changes (all Spanish)

| Scenario | Behaviour now |
|----------|---------------|
| SUCCESS | Card step completes → `POST …/sync` → server asks Stripe → if `ACTIVE`: "Pase diario activado." + list refresh. |
| SUCCESS but webhook/sync lag | "Pago recibido. Estamos confirmando tu pase; aparecerá aquí en unos segundos." → list re-fetched after 4 s. Never shown as a failure. A later tap that finds the payment confirmed shows "Ya tienes un pase diario activo…" neutrally and reloads the list. |
| USER CANCELS | Silent (as before); the attempt stays reusable, the next tap re-presents the same intent. |
| CARD DECLINED / sheet failure | "No se pudo completar el pago. Revisa los datos de tu tarjeta o intenta con otra." (Stripe's raw message never shown). Retry re-presents the intent. |
| INCOMPLETE 3DS (`requires_action`) | Next tap: server cancels and replaces the intent; member sees a fresh sheet. |
| ALREADY OWNS | 409 "Ya tienes un pase diario activo para esta fecha." |
| PAYMENT PROCESSING | 409 "Tu pago está en proceso. En cuanto se confirme verás tu pase aquí; no vuelvas a pagar." |
| REFUNDED / refunded-at-Stripe edge | 409 "No pudimos confirmar el estado de tu pase diario para esta fecha. Contacta a tu estudio." |
| NETWORK ERROR / timeout | "La operación tardó demasiado…" / "No se pudo iniciar la compra del pase diario. Inténtalo de nuevo." |
| DOUBLE TAP | `dayPassBusy` state + synchronous in-flight ref; server returns 409 "Ya hay un intento de compra en curso…" for a true race. |
| Old app build (pre-OTA) | Still works: it sends `validForDate` (accepted), never calls sync (webhook activates), shows the optimistic success as before; the legacy 409 can no longer occur. |

"Tus pases" lists purchased (ACTIVE) passes only; "Pendiente" rows no longer appear.

## 13. Test matrix and results

| Suite | Tests | Result |
|-------|-------|--------|
| `day-passes.service.spec.ts` — first purchase/idempotency key (T1), ACTIVE→409 (T2), reuse (T3), requires_action replace (T3b), CAS after mid-retry payment (T3c), canceled→replace (T4), CAS loser cancels own intent (T4b) / never the winner's (T4c), price rotation→cancel+replace (T5), succeeded→self-heal (T6), processing→wait (T7), in-progress 60 s (T8), orphan takeover (T9), fresh CAS (T9b), P2002→409 (T10), past date (T11), server-decided date (T11b), canonical/horizon (T11c), refunded repurchase (T11d), PI failure releases slot (T12), ephemeral failure keeps slot (T13), resource_missing (T14), Stripe outage propagates (T15), list ACTIVE only (T16), sync activate (T17) / no-activate (T18) / tenant (T19) | 27 | ✅ |
| `stripe-webhook.service.day-pass.spec.ts` — activate (W1), replay idempotent (W2), unknown intent (W3), paid replaced intent rebinds + cancels replacement (W4), double charge recorded & flagged (W4b), REFUNDED terminal (W5), EXPIRED paid→ACTIVE (W6), tenant (W7), non-day-pass ignored (W8), payment_failed caches (W9), canceled caches (W10), stale intent ignored (W11), out-of-order never downgrades (W12), amount mismatch recorded (W13) | 14 | ✅ |
| `day-pass-attempt-sweep.service.spec.ts` — timezone selection, CAS expire, never expire paid, defer processing/unreachable, env-gated Stripe cancel, no-intent/missing, no-op | 7 | ✅ |
| `validate-env.day-pass.spec.ts` | 2 | ✅ |
| `test/day-pass-lifecycle.e2e-spec.ts` (real Postgres, real signature verification) — E1 repro+fix, E2 canceled→replace, E3 webhook activate + replays + 409 Spanish, E4 list hides attempts, E5 decline keeps slot, E6 sync, E7 late webhook self-heal, E8 triple concurrent POST → one slot ≤ one intent, E9 sweep, E9b sweep activates paid, E10 past date | 11 | ✅ |
| `test/day-pass-settings.e2e-spec.ts`, `test/billing.e2e-spec.ts` (regression) | 9 + 17 | ✅ |
| Full API unit suite | 1236 | ✅ except 1 **pre-existing** failure (`stripe-webhook.service.spec.ts › CASH row with still-active period`, fails identically on untouched HEAD) |
| Mobile `__tests__/dayPassPurchase.test.ts`, `userFacingApiMessage.test.ts` | 9 + 5 | ✅ |
| API `tsc`, API eslint (changed files), mobile `tsc`, mobile eslint | — | ✅ (mobile eslint reports 1 **pre-existing** unused `MembershipCard`, present at HEAD) |

## 14. Reconciliation plan (dry run executed read-only against production)

`railway run npx tsx scripts/day-pass-reconcile.ts --studio cmp33m0gp0000qomlj9p42ia5` (2026-09-23 14:13 UTC):

```
EXPIRE_LAPSED_ATTEMPT              13   (all 13 PENDING; all requires_payment_method; all past studio-local day)
HEALTHY_ACTIVE                     8
PAID_INTENT_WITHOUT_ACTIVE_PASS    1    (MX$10, 2026-06-14, user + row deleted — QA era; no member impact)
```

The script reads the new columns, so it runs only after the migration is deployed. Classification rules: ACTIVE rows are verified (intent succeeded, charge not refunded, Payment row present) and **never modified** except repairing a missing Payment row via the shared routine; non-ACTIVE rows are classified from the live intent: `succeeded` → `ACTIVATE_PAID_ATTEMPT`, `processing` → wait, lapsed day + `requires_*|canceled|missing` → `EXPIRE_LAPSED_ATTEMPT`, today/future → left for the API to resume. Stripe Search is also queried for paid day-pass intents with no ACTIVE slot.

Apply mode (`--apply --confirm-apply`, double flag) performs only `ACTIVATE_PAID_ATTEMPT` and `EXPIRE_LAPSED_ATTEMPT`; `--cancel-stripe` additionally cancels lapsed intents at Stripe (`abandoned`). Idempotent (second run: 0 actions). Never deletes, never refunds, never touches an ACTIVE row's status. Rollback: `EXPIRED → PENDING` is a plain status update (the API re-evaluates live anyway); activations are true state. The hourly sweep can perform the same EXPIRE step once `DAY_PASS_SWEEP_ENABLED=1` is set; it ships disabled, so the 13 historical rows stay PENDING until an operator decides. `--cancel-stripe` (or `DAY_PASS_SWEEP_CANCEL_STRIPE_INTENTS=1` with the sweep on) is the only way the 13 "Incomplete" intents leave the Dashboard.

## 15. Observability

Structured one-line JSON events (PII-free; ids + enums only) via `logDayPassEvent`: `DAY_PASS_CHECKOUT_CREATED | _REUSED | _REPLACED`, `DAY_PASS_RETRY`, `DAY_PASS_CONFLICT{reason}`, `DAY_PASS_PAYMENT_SUCCEEDED | _FAILED | _CANCELED`, `DAY_PASS_ACTIVATED`, `DAY_PASS_ATTEMPT_EXPIRED`, `DAY_PASS_RECONCILED`, `DAY_PASS_WEBHOOK_IGNORED{reason}`. Suggested metrics/alerts (Railway log search): checkout→activation ratio, `DAY_PASS_CONFLICT` by reason, any `DAY_PASS_PAYMENT_SUCCEEDED` with `reason=double_payment_suspected` (page), `DAY_PASS_RECONCILED reason=paid_but_never_activated` (webhook health), `DAY_PASS_WEBHOOK_IGNORED reason=unknown_intent_for_slot|day_pass_not_found` (investigate). The reconcile script exits 1 when actionable anomalies exist (cron-friendly).

## 16. Deployment plan

Classification: **API deploy + additive migration (auto) + mobile OTA (JS-only, runtime 1.1 compatible) + Stripe Dashboard change + optional env flag.** No admin, no worker, no native change.

1. Review & commit (untracked files listed in section 10; do not stage `old-schema.tmp.prisma` or other ad-hoc `scripts/*`).
2. Deploy API to Railway. Boot runs `prisma migrate deploy` (additive) then starts. Verify `/health` and the boot log line "Day Pass attempt sweep disabled". No existing row changes.
3. Stripe Dashboard (operator): add `payment_intent.payment_failed` and `payment_intent.canceled` to the production webhook endpoint. Correctness does not depend on it; decline/cancel telemetry does. Optionally align the endpoint API version to `2025-08-27.basil`.
4. Later, operator decision: enable `DAY_PASS_SWEEP_ENABLED=1` (and optionally `DAY_PASS_SWEEP_CANCEL_STRIPE_INTENTS=1`), or run `scripts/day-pass-reconcile.ts --apply --confirm-apply [--cancel-stripe]` once, to close the 13 historical attempts.
5. Mobile: publish OTA to `preview-ares`, run the acceptance test (section 20), then `production-ares`. The API is backward compatible, so ordering API-first is safe and the OTA can lag.

## 17. Rollback

* **API:** redeploy the previous build (`87113ee8`, commit `13d4570`). The new columns are ignored by old code; no schema rollback. With the sweep disabled no row was changed by the deploy, so there is nothing to revert in data.
* **Mobile:** republish the previous OTA group (`a46b2d2d-f427-4bf2-b962-a36a39887dfe` remains the known-good rollback for production-ares). Old app + new API works.
* **Order after the OTA ships:** the new app omits `validForDate` (server-decided date) and the previous API requires it. Once the new OTA is live, roll back the **OTA first**, then the API. Before the OTA ships (this phase), the API can be rolled back alone.
* **Stripe events:** removing the two subscriptions only silences telemetry.

## 18. Remaining risks

* The production webhook endpoint must still be subscribed to the two new events by hand (telemetry only).
* Idempotency keys replay for 24 h; a crash between Stripe and DB retried after that mints a second intent (auditable via the slot trail; the sweep/reconcile expire the orphan).
* Midnight edge (sheet confirmed after the day ended) and price rotation mid-attempt are honoured as money-first and flagged; the refund/credit policy is a business decision.
* Refunds are still manual (`charge.refunded` is not handled; pre-existing gap). The API, sweep and reconciliation refuse to activate a refunded intent; the webhook path cannot see refunds (its payload carries only the charge id), so a refund issued while a success event is still being redelivered could activate — reconciliation flags that as `ACTIVE_INTENT_REFUNDED` (full or partial).
* An intent created at Stripe but left unbound by a process crash (between create and bind) stays unused in Stripe; it was never presented, so it cannot be paid. Cosmetic.
* Analytics attribute a subscriber's day-pass payment to their plan (pre-existing); check-ins/front desk have no day-pass surface (pre-existing, out of scope).
* `IN_FLIGHT_GRACE_MS = 60 s` takeover: if Stripe is slower than 60 s two intents can be minted for one slot; the CAS bind keeps one and the loser cancels its own (tested), so no double charge.
* Final release review (two adversarial passes) found and closed: replace-after-failed-cancel (possible double charge), idempotency-key replay of a Stripe 5xx (day-long block), refunded-intent re-activation, non-conditional activation write, and a sweep that would have mutated the 13 historical rows on deploy (now disabled by default).

## 19. GO / NO-GO

**GO for review and controlled release**, conditional on: (a) code review of the diff, (b) operator adds the two Stripe events, (c) OTA published to `preview-ares` first and the acceptance test below passes with a real card in test mode or a MX$10 live price. Nothing has been deployed, committed or mutated; production reads were GET/search only.

## 20. Operator acceptance test (preview-ares, one member)

1. Tap "Comprar pase diario" → sheet opens → close it. Expect: no message; Stripe shows one Incomplete intent.
2. Tap again. Expect: sheet opens immediately, **no 409**, same intent (Stripe still shows one Incomplete, not two).
3. Pay with a declining test card. Expect: Spanish decline message; tap again → sheet opens (same intent).
4. Pay successfully. Expect: "Pase diario activado." within ~2 s (sync), pass listed under "Tus pases" as Activo; Stripe: intent Succeeded; DB: one row ACTIVE, one Payment.
5. Tap "Comprar pase diario" again. Expect: "Ya tienes un pase diario activo para esta fecha."
6. Book a Day-Pass-eligible class today. Expect: booking succeeds.
7. Next day: previous slot untouched (ACTIVE); a new purchase creates a new slot. Yesterday's abandoned attempts (if any) show EXPIRED after the :20 sweep.
