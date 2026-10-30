# ARES operational features (PR #5) — production release runbook

**Status: PREPARED, NOT APPROVED.** Nothing in this document authorizes a production
configuration change, migration, merge, deployment, email or OTA. Each stage below names the
approval it needs; stop at every gate. Read with
[`ares-ops-pr5-readiness.md`](./ares-ops-pr5-readiness.md) (preflight) and
[`../ROLLBACK_RUNBOOK.md`](../ROLLBACK_RUNBOOK.md).

> **MERGING TO MAIN WILL APPLY THIS MIGRATION TO PRODUCTION.**
> `20261028223000_price_grandfathering_and_email_campaigns` runs automatically in the Railway
> pre-deploy step of the production API when `main` moves.

## What installing the release does (and does not) change

- **Schema (additive only):** 6 enum types, 5 empty tables (price-change ledger and items, email
  campaigns, recipients, suppressions) and one nullable column `subscriptions.price_cents`, added
  without a default (no table rewrite).
- **One data statement:** `price_cents` is filled once for every existing subscription — CASH from
  the current catalog price, STRIPE from the latest captured succeeded payment (catalog fallback).
  No period, entitlement, status, payment, Stripe id or Stripe object is modified.
- **No Stripe call, price change or email is triggered by installation.** Price changes only
  happen when the owner edits a Basic/Pro/Full price and explicitly confirms ALL_EXISTING,
  FUTURE_ONLY or SELECTED. Campaigns only send after an OWNER/ADMIN preview + confirm **and**
  with the campaign worker enabled.
- **Rollback-compatible:** the previous API build ignores the new column and tables; the new build
  falls back to the catalog price wherever a lock is NULL.

## Stage 0 — Gates before any production action

All must be PASS on the exact commit to be merged (see the readiness report for current status):
CI green on that SHA (API, admin, mobile config); migration preflight re-run read-only the same
day; Stripe test-mode validation of the three scopes; rehearsal series-cancellation walkthrough;
Communications rollout prerequisites. Configurable expiration alerts and member push messaging are
**required deliverables not included in PR #5** (see
[`ares-open-requirements-expiration-alerts-and-push.md`](./ares-open-requirements-expiration-alerts-and-push.md));
the owner decides explicitly whether PR #5 may ship before them.

## Stage 1 — Backup and baseline (owner action in Neon; read-only elsewhere)

1. In the Neon console for the production project, confirm the point-in-time-restore history
   window covers the release window, and create a named branch of production immediately before
   the release (e.g. `pre-ares-pr5-YYYYMMDD`). Record its creation time. *(Owner approval: Neon
   branch creation.)*
2. Read-only baselines, captured within the hour before merging:
   - migration history: exactly one pending migration (this one), none failed;
   - `apps/api/prisma/audits/ares-grandfathering-preflight.sql` output;
   - backfill dry run (the migration's `CASE` expression as a `SELECT`, grouped by
     source/status/plan/lock);
   - subscription fingerprint: `md5(string_agg(id||status||source||coalesce(stripe_subscription_id,'')||coalesce(current_period_start::text,'')||coalesce(current_period_end::text,'')||cancel_at_period_end::text, ',' ORDER BY id))`
     plus counts by source/status;
   - production API `/health`.

## Stage 2 — Pre-configure the production API (approval: production configuration change)

Apply **before** the new API can boot. A variable change redeploys the *current* `main` build,
which ignores these variables; verify `/health` afterwards.

| Variable | Value | Why |
| --- | --- | --- |
| `EMAIL_CAMPAIGN_WORKER` | `0` | The campaign worker starts unless this is exactly `0`. Keep it off until Stage 7. |
| `EMAIL_UNSUBSCRIBE_URL_BASE` | the production API's public HTTPS origin, no path (the same origin the mobile app uses as its API URL) | Required to confirm any campaign; links resolve to `/api/v1/email/unsubscribe` on the API. |

Read-only checks in the same step: `RESEND_API_KEY` present, `EMAIL_FROM_ADDRESS` on a
Resend-verified domain, Resend plan quota/rate limit (shared with password-reset mail). Tell
OWNER/ADMIN staff not to use Comunicaciones until Stage 7 is signed off.

Do not change any Wallet, Stripe or CORS variable as part of this release.

## Stage 3 — Migration approval gate (approval: owner, separately from merge)

Owner reviews the migration file and the Stage 1 dry run, and explicitly approves applying it to
production. Restate: **MERGING TO MAIN WILL APPLY THIS MIGRATION TO PRODUCTION.**

## Stage 4 — Backend deployment (approval: merge to `main`)

1. Mark PR #5 ready; merge only a commit whose `ci` check passed (the `main` ruleset rejects
   anything else). Railway builds the API, runs `prisma migrate deploy`, health-checks `/health`
   and drains the old instance.
2. Watch the deploy logs: the migration applies once; the API boots without env-validation
   errors; no campaign worker start.
3. Stop and roll back (Rollback A) on: migration failure, boot failure, `/health` not 200,
   elevated 5xx, or any unexpected Stripe event.

## Stage 5 — Admin deployment

Vercel deploys `gymos-admin` to production from the same `main` commit. The new admin pages call
the new endpoints, so confirm the API deployment is healthy first; if the admin finishes first,
new screens may show errors until the API is up (no data impact). Confirm the production admin's
`NEXT_PUBLIC_API_URL` is the production API.

## Stage 6 — Read-only production smoke

- Migration history: all applied, none pending or failed.
- `price_cents` populated for every subscription; distribution equals the Stage 1 dry run.
- Price-change and campaign tables: zero rows.
- Subscription fingerprint equals the Stage 1 value (apart from renewals that happened in
  between — explain any difference before continuing).
- Stripe dashboard (read-only): no subscription updates or invoices caused by the release.
- Admin, logged in as OWNER: plans page (open a price-change preview, **do not confirm**),
  Communications page (**do not create a campaign**), Ventas cash step shows "Fecha del pago" and
  rejects a future date (**do not submit**), Member 360 "Asignar membresía", schedule series
  actions visible (**do not cancel**).

## Stage 7 — Communications enablement (approval: one internal test email, then worker)

Separate approval; no bulk email. Campaign audiences contain only MEMBER-role accounts, so the
owner's own account cannot receive the test: use an internal MEMBER account whose inbox the team
controls (verify read-only that it exists in the studio; creating one is a production write that
needs its own approval).

1. With the worker still `0`: in Comunicaciones, no filters, "all members" unchecked, include
   only the internal account, preview — exactly 1 recipient with the expected address — confirm.
   The campaign waits as `SENDING`.
2. Read-only: exactly one `SENDING` campaign in the database, `recipient_count = 1`, one recipient
   row. Any other `SENDING` campaign would also send in the next step — stop if there is one.
3. Set `EMAIL_CAMPAIGN_WORKER=1` (redeploys). Expect the row `SENT` with a provider message id,
   the campaign `COMPLETED`, exactly one email in the Resend log. Set it back to `0`.
4. In the inbox: sender, reply-to, DKIM pass; `List-Unsubscribe` and `List-Unsubscribe-Post`
   point at the API origin.
5. Open the unsubscribe link (GET): no suppression row is written. Confirm the unsubscribe: one
   `email_suppressions` row (reason `UNSUBSCRIBE`). Preview the same audience again: 0 recipients,
   1 suppressed. Do not create it.
6. Only then, with owner approval, set `EMAIL_CAMPAIGN_WORKER=1` permanently after confirming no
   unexpected `SENDING` campaign exists.

**Kill switch:** `EMAIL_CAMPAIGN_WORKER=0` pauses after the redeploy (minutes, up to ~5 more sends
from the old container); pending rows resume automatically when re-enabled — it is not a cancel.
Revoking the Resend key stops immediately but also stops password-reset and billing email. Do not
remove `RESEND_API_KEY` from Railway while `PASSWORD_RECOVERY_ENABLED=true` (the new deploy would
refuse to boot while the old one keeps running).

## Stage 8 — Mobile OTA to production-ares (separate approval)

Per `AGENTS.md`: API healthy → `pnpm --filter mobile config:verify:ares` → dry run
`pnpm --filter mobile ota:ares` → publish only with explicit approval
`pnpm --filter mobile ota:ares:publish`. Until the OTA ships, staff devices run the previous
bundle against the new API; state that gap in the release note.

## Rollback

- **Rollback A — application only (default):** redeploy the previous production API deployment
  in Railway and promote the previous Vercel admin deployment. Leave the additive schema in
  place. After any roll-forward, check read-only for subscriptions created meanwhile with a NULL
  `price_cents` and fix them with a reviewed forward migration if needed.
- **Rollback B — communications:** set `EMAIL_CAMPAIGN_WORKER=0` (redeploys) to stop sending.
- **Rollback C — a confirmed price change was wrong:** do not edit the database by hand; run a
  new explicit price change back to the previous price with the appropriate scope, after owner
  approval.
- **Rollback D — data corruption only:** stop API traffic, restore the Stage 1 Neon branch / PITR
  point, repoint `DATABASE_URL`, verify migration state, restart, smoke. Never edit the applied
  migration file (checksum) — correct schema with a new forward migration.

## Incident procedure

Stop on any stop condition above. Freeze further changes, capture the deployment id, logs and the
read-only checks that failed, notify the owner, and choose the narrowest rollback (A → B → C → D).
Record the timeline in the release note.
