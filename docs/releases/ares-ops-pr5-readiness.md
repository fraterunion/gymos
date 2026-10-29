# ARES operational features — PR #5 release preflight

**Status: DRAFT / NO PRODUCTION APPROVAL.**

**Scope rule clarified by owner:** Do not apply any price changes ourselves.
All existing charges and catalog values remain as-is. Fer alone chooses
ALL_EXISTING, FUTURE_ONLY, or SELECTED for Basic, Pro and Full when she
*later* explicitly edits a price, reviews a preview and confirms the change.
Installing the feature cannot silently alter existing renewal amounts.

This is a no-PII read-only audit summary. The feature branch includes manual
payment dates, member-specific pricing for Basic/Pro/Full, editable benefit
bullets, admin email campaigns, and permanent class-series cancellation.

## Production reconciliation (2026-10-28)

Read-only Neon project `gymos-ares-pilot` production branch and the connected
ARES Training Club **live Stripe account** were compared; no writes were made.

- GymOS: 43 STRIPE subscriptions, 27 of them locally ACTIVE.
- Connected Stripe account: 40 subscription records across statuses.
- 25/27 locally ACTIVE Stripe subscriptions match records in the connected Stripe account.
- 2 locally ACTIVE records reference IDs not present in that account (review
  placeholders / stale references; **do not** treat these as valid billable
  subscriptions or silently update them).
- Of the 25 matching active records, **one Basic Access** item is billed at
  130,000 cents (MXN 1,300), different from its catalog's 100,000 cents
  (MXN 1,000). Preserve the locked Stripe amount on future-only and excluded
  member scopes. It is not an error requiring a Stripe write.
- For active matched Stripe records with a local successful payment, live item
  amounts matched the latest captured successful payment.
- 8 locally ACTIVE Stripe records lack a local successful payment: 6 matching
  live records have the same price as their current catalogs; 2 lack a live
  Stripe match.
- 6 ACTIVE CASH Full Access records have historical succeeded payments of
  195,000 cents (MXN 1,950), versus current catalog price of 150,000 cents
  (MXN 1,500). Each has only one successful payment. **No price change
  is authorized.** The corrected initial CASH lock uses the catalog 150,000
  cents, preserving the existing default renewal amount. The 195,000 cents
  remains an unchanged historical payment; it is not a recurring price.
  No owner decision or automatic repricing is required at installation.
- Current production capture-order versus effective-date backfill price
  differences: zero. The updated migration uses capture order to protect
  future backdated entries.

## Required gates before merging to main

1. Preserve every member's current billed amount when enabling the feature;
   in particular, ensure the six historical MXN 1,950 CASH payments do NOT
   become MXN 1,950 recurring charges merely due to migration. All CASH
   initial locks follow current catalog. Review two orphan/placeholder Stripe
   references without changing, deleting or reassigning them.
2. Re-run `apps/api/prisma/audits/ares-grandfathering-preflight.sql` on a
   **read-only** production connection or fresh Neon branch just before merge.
3. Confirm CI is green for the precise latest PR head after every commit.
4. Confirm the price-change UI for three scopes, selection, retry, and
   grandfathered frontdesk CASH sale through an authenticated browser.
5. Validate in **Stripe test mode**, not the production account: no immediate
   invoice, no proration, unchanged billing anchor, partial-failure retry.
   The account available in this ChatGPT session was **live only**.
6. Configure `EMAIL_UNSUBSCRIBE_URL_BASE` to an authenticated/verified public
   HTTPS API origin in the deployment environment. Confirm the production API
   serves the link and one-click unsubscribe. Do not enable a bulk campaign
   before a single internal-only Resend test.
7. Confirm iOS/Android manual payment date and member benefit bullets via
   preview or internal OTA. Never ship production OTA without approval.
8. Read the exact migration diff. Obtain separate explicit approval for the
   production Neon migration, followed by explicit merge authorization.
   Deploying main triggers Railway migrations.

No step in this document authorizes production Stripe mutations, email
sending, migration, merge, or OTA.
