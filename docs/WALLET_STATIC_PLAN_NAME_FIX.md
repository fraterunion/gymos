# Wallet static pass: plan name from canonical entitlement

Smart Wallet 2.0, Stage 1A, Workstream B. Commits `ac04f61` (access snapshot module) and
`aadf081` (this fix). Neither commit contains a database migration, so the pair can be released
on its own, ahead of or without the dynamic-pass work.

## The defect

A newly built static Apple pass shows the member's plan in its header (`PLAN <name>`, the only
field visible while the card is stacked in Wallet). A newly created Google Wallet object shows
the same name as its subheader. Both came from one query: the newest subscription row whose
stored `status` was `ACTIVE` or `TRIALING`.

Stored status is not entitlement. A cash membership keeps `status = ACTIVE` after its paid period
ends; nothing transitions it. So a member whose cash plan had expired still received a pass
reading `PLAN Full Access`, which the October 2026 front-desk investigation identified as
misleading.

## The fix

The plan named on a newly built pass is now the canonical **primary membership the member is
entitled to right now**, or no plan at all. It uses the same primitives as check-in and booking:
`deriveMembershipLifecycle` decides entitlement, and `selectPrimaryMembership` picks the CORE
membership first, then the newest.

## Exact observable changes

Only passes **built after the deploy** change. "Built" means one of these existing events:

- a member's first Apple pass (first "Mi Pase" view or first Wallet tap);
- a member's first Google object;
- a security reissue;
- an automatic rebuild of a stored Apple pass whose template version is not 2.

| Member's subscriptions at build time | Before | After |
|---|---|---|
| Cash plan, stored `ACTIVE`, paid period already ended | `PLAN <expired plan>` | no plan field |
| Stripe or cash plan currently entitled (single membership) | `PLAN <plan>` | `PLAN <plan>` (unchanged) |
| `CANCELED`, still inside its paid window (`entitlementEndsAt` in the future) | no plan field | `PLAN <plan>` |
| Several entitled memberships (e.g. Full Access + a stackable class pack) | newest row's plan | the CORE membership's plan |
| Only a membership that has not started yet (future-dated or `SCHEDULED`) | `PLAN <future plan>` (if stored `ACTIVE`) | no plan field |
| `PAST_DUE`, `PAUSED`, or no membership | no plan field | no plan field (unchanged) |

The Google Wallet subheader follows the same rules, but only for objects created after the
deploy. Existing Google objects are never updated: creation is insert-only, and a 409 means
"already exists".

## What does not change

- **Existing passes.** Every stored Apple artifact (65 at the Smart Wallet Phase 0 audit) is
  served byte-for-byte as before.
  `APPLE_PASS_TEMPLATE_VERSION` stays at 2 and the static template fingerprint is unchanged, so
  nothing triggers a rebuild.
- **Identity.** Serial numbers (the WalletCredential id) and QR values (`gymos:v1:…`) are untouched.
- **Access.** Check-in and booking authorization do not read this value. The pass remains
  informational: "El acceso se confirma en recepción."
- **Pass layout.** No new fields. The header is either `PLAN <name>` or empty, exactly as before.

## Evidence

- `src/wallet/wallet-pass.service.spec.ts`, "static pass plan name — canonical entitlement",
  covers each row of the table above for both the Apple and Google builders.
- `test/wallet-dynamic-pass.e2e-spec.ts`, "October 2026 expired-cash regression on the real
  database", builds a real static pass for the incident shape and asserts an empty header.
- `src/wallet/apple/apple-pass-template-fingerprint.spec.ts` still passes with the pinned v2
  fingerprint.
- The signing code was refactored in the dynamic-pass commit. Static passes built by the base
  commit's provider and by the refactored provider, from identical inputs, were byte-identical
  in every file except the time-stamped signature. This held for three cases: brand assets with
  a plan, brand assets without a plan, and placeholder icons.
