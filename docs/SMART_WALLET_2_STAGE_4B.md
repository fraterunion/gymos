# Smart Wallet 2.0 — Stage 4B first-issuance automatic enrollment

Status: **feature branch only; disabled by default; no production deployment authorized by this document**.

## Purpose

New Apple Wallet passes for a bounded group of ARES members should be dynamic **before the first installation**, without replacing any already-installed static pass.

This change reuses the existing tested `WalletDynamicPassService.enroll()` implementation. There is no new migration, no change to check-in policy, no bulk database update, no mobile change, and no APNs activation.

## Runtime guardrails

- `WALLET_AUTO_ENROLL_ENABLED` defaults to `false`. All previous behavior is preserved until explicitly enabled.
- `WALLET_AUTO_ENROLL_STUDIO_ID` identifies exactly one studio by its database ID.
- `WALLET_AUTO_ENROLL_USER_IDS` is a comma-separated allowlist of **user IDs** (not email addresses). Wildcards and duplicate IDs are forbidden.
- `WALLET_AUTO_ENROLL_STUDIO_CAP` is a required integer from 1 to 200. The allowlist length must not exceed the cap.
- Boot-time validation requires both `WALLET_DYNAMIC_PASSES_ENABLED=true` and `WALLET_PASSKIT_ROUTES_ENABLED=true` when auto-enrollment is on.
- Enroll on **first credential issuance** when the raw credential is available, after the static Apple artifact has been created, before the initial response.
- If enrollment fails, the existing static pass remains usable and the request falls back safely. No credential rotation and no silent bulk retry.
- Existing credentials are **never** auto-enrolled by this feature; a security reissue does not opt the user into the rollout.
- Google Wallet remains unchanged. APNs and background refresh worker remain under their independent feature flags.
- The rollout cap bounds the configured cohort, not the number of passes already in the database.

## Pilot order

1. Release with `WALLET_AUTO_ENROLL_ENABLED=false` and verify existing static-pass fingerprints, health, and migrations.
2. Validate registration and push delivery on real iPhones for a small, separately approved cohort.
3. Set the exact studio ID and member IDs for a small pilot, e.g., 2–5 users, with a matching cap. Enable Stage 4B **only after** the cohort and rollback are approved.
4. For those users, the first `Mi Pase` screen produces a dynamic Apple pass. Confirm mode, URL, serial, QR, signature and device registration **before** growing the allowlist.
5. Increase allowlist and cap gradually only when real-device results meet success criteria.
6. Existing static passes remain explicitly excluded; they require an independent user-assisted migration.

## Rollback

Set `WALLET_AUTO_ENROLL_ENABLED=false` and redeploy, or roll back to the preceding build. Already-issued dynamic passes continue working with their original QR as identity passes; the existing dynamic service and PassKit routes remain independently controlled.

## Tests

- Default OFF; exact studio/user match; invalid, duplicate and wildcard identifiers; cap enforcement; required feature flags.
- First-issuance dynamic enrollment; unauthorized user stays static; existing credential stays static; transient enrollment failure keeps usable QR; direct Apple-first issuance returns newly converted bytes.
- Before release, execute full Wallet unit and API e2e, Prisma migration status and production fingerprint verification; no production DB mutation as part of these tests.

## Staging validation — synthetic member C (first issue, then one device)

Staging only (`smart-wallet-staging`; the staging CLI refuses any other environment or a database
off Railway's private network). Members A and B are never touched: `seed` never creates C, and C's
commands accept only `--member c`.

1. **Prepare C without a credential** — `node apps/api/dist/cli/wallet-staging.cli.js prepare-first-issue --member c`
   creates C's synthetic user, studio membership and active synthetic subscription in the seeded
   studio, issues **no** wallet credential, and prints C's user id, the studio id and the exact
   allowlist for C only (`WALLET_AUTO_ENROLL_ENABLED=true`, studio id, C's user id, cap `1`). The
   allowlist is checked with the API's own boot validator and eligibility policy before it is
   printed: no wildcard, cap 1, and no other user in the database admitted. Refuses once C holds
   any credential.
2. **Activate** — set exactly those four variables on staging (dynamic passes and PassKit routes
   on; refresh worker off) and redeploy; boot validation re-checks them.
3. **First issue** — `wallet-staging.cli.js issue-first --member c` refuses unless the LIVE
   allowlist is exactly C (synthetic studio, cap 1, no wildcard, no user holding a credential,
   dynamic + routes on, worker off) and C has no credential. It then calls
   `WalletPassService.getBarcode` — the "Mi Pase" path — and proves C's Apple pass is DYNAMIC with a
   web service URL, serial = credential id, zero registrations, and every pre-existing pass artifact
   byte-identical. It sends no push and is one-shot.
4. **Export** — `wallet-staging.cli.js export --member c` (pass bytes on stdout between markers).
   Install on the single test iPhone only, with iCloud Wallet sync prevented from reaching any other
   device.
5. **Prove one device** — `wallet-diagnostics.cli.js pass --credential <C>` must show exactly one
   active registration, the intended iPhone's device hash, before any entitlement change or push.
6. **Single update** — `wallet-staging.cli.js set-entitlement --member c --state expired`, then
   `wallet-dynamic-pass.cli.js refresh --credential <C> --confirm` and, only after every gate passes,
   one `push --credential <C> --confirm`. Note: the push service prunes a registration APNs reports
   as permanently invalid (410).
