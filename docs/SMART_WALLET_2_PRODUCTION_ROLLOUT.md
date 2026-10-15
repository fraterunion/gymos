# Smart Wallet 2.0 — production rollout plan (proposal)

Status: **a plan, not an authorization.** Every phase below needs its own explicit approval, and
none starts automatically. Production is unchanged today. **The 65 existing ARES static passes stay
untouched** until migrating them is independently shown to be safe (phase E).

Merging to `main` is a production release. Railway deploys `main` immediately, without waiting for
CI, and its start command runs `prisma migrate deploy` against the production database.

## What reaches production with the first merge

The branch adds three pending migrations, all additive:
- `20261013120000_wallet_dynamic_pass_foundation`
- `20261015120000_wallet_refresh_engine`
- `20261016120000_wallet_serials_listed_event`

> **MERGING TO MAIN WILL APPLY THESE MIGRATIONS TO PRODUCTION.**

**The code is inert with every flag off, with one exception.** The Stage 1A **static plan-name
fix** changes newly built static passes: they stop naming a plan when the member is not entitled.
Stored static passes are still served byte for byte, and their template version is unchanged.

**Flags:** all default off.

| Flag | Effect when off |
|---|---|
| `WALLET_DYNAMIC_PASSES_ENABLED` | No dynamic builds or enrollment |
| `WALLET_PASSKIT_ROUTES_ENABLED` | The device web service returns 404 |
| `WALLET_APNS_ENABLED` | No pushes |
| `WALLET_REFRESH_WORKER_ENABLED` | No worker |

## Phase A — dark deployment (all Wallet flags off)

**Before the merge (read-only unless noted):**
- [ ] Stage 4A reviewed; CI green on the branch HEAD.
- [ ] Production `migrate status` shows exactly the three migrations above as pending.
- [ ] Baseline:
  - [ ] row counts and byte checksums of `wallet_pass_artifacts` (`pkpass_data`, `template_version`);
  - [ ] row counts and byte checksums of `wallet_credentials` (`credential_hash`, `revoked_at`);
  - [ ] row counts and byte checksums of the financial tables (payments, subscriptions, entitlement cycles).
- [ ] A Neon branch or point-in-time restore point of production taken just before the merge.
- [ ] *Recommended, a production config change:* enable "Wait for CI" on the production `api`
  service, as already done for `api-staging`.

**Release:** merge `feat/smart-wallet-foundation` into `main`, with explicit approval.

## Phase B — verify the dark deployment

- [ ] The deploy log shows the three migrations applied, then `wallet.refresh.worker_disabled`.
  `/health` returns 200.
- [ ] `migrate status` is up to date.
- [ ] Every Phase A baseline checksum is identical: artifacts, credentials and financial tables.
  The migrations only add columns with defaults and new tables; the only data statement backfills
  DYNAMIC rows, and production has none.
- [ ] Static compatibility:
  - [ ] a staff member downloads their existing pass (served byte-identical);
  - [ ] Mi Pase recovers the same QR;
  - [ ] a staff QR scans at the desk;
  - [ ] PassKit routes return 404.
- [ ] `wallet-diagnostics.cli.js certificate` shows the **production** Pass Type ID certificate as
  OK, with more than 30 days left. This is a prerequisite for phase C.

**Rollback:** redeploy the previous production deployment (`beb66b27`, `e365d2d`). The old build
boots against the new schema (verified), and the schema objects stay.

## Phase C — internal staff pilot with newly issued dynamic passes

**Prerequisites, each needing approval:**
- **Web service URL, decided permanently.** It is signed into every dynamic pass forever.
  Recommendation: a business-owned API domain (CNAME) rather than `*.up.railway.app`.
- **Pilot allowlist:** 2–5 consenting staff accounts.
- **A fresh install, not a replacement.** On each pilot device, either no GymOS pass has ever been
  added or the staff member removes it first. Replacing a pass in place can drop its update
  registration (Stage 2 finding).
- **Live APNs approval.**

**Steps:**
1. Set `WALLET_PASSKIT_WEB_SERVICE_URL`, `WALLET_DYNAMIC_PASSES_ENABLED=true` and
   `WALLET_PASSKIT_ROUTES_ENABLED=true`. Worker and APNs stay off.
2. For each pilot account:
   1. the staff member opens Mi Pase, which issues the credential and the static artifact;
   2. the operator runs `wallet-dynamic-pass.cli.js enroll --credential <id> --confirm`
      **before** the staff member adds the pass;
   3. the staff member adds it from the app.

   Verify with `wallet-diagnostics.cli.js pass`: a `REGISTERED` event and `activeDeviceCount ≥ 1`.
3. Enable `WALLET_REFRESH_WORKER_ENABLED`. Watch `wallet.health.*` and run the health CLI. Expect no
   HIGH findings.
4. With separate approval, enable `WALLET_APNS_ENABLED`, then observe real entitlement changes for
   at least 7 days.

**Success criteria:**
- every pilot pass keeps an update registration;
- each change is accepted by APNs **and** followed by `SERIALS_LISTED` from each pilot device, plus a
  visual confirmation;
- no dead letters, no repeated APNs failures, no `UNDELIVERED_VERSION` after 30 minutes;
- the certificate is OK.

**Rollback, in order of severity:**
1. `WALLET_APNS_ENABLED=false` (stops pushes);
2. `WALLET_REFRESH_WORKER_ENABLED=false`;
3. routes and dynamic flags off.

The passes keep working as identity passes with the same QR; only updates stop.

## Phase D — limited new-member enrollment (after a successful pilot)

**Not available today.** Enrollment is an operator command per credential. Phase D needs a
Stage 4B change: allowlisted issuance-time enrollment, so a new member's **first** download is
already dynamic (a fresh install, never a replacement). That change needs:
- a per-studio cap and an allowlist;
- the same success criteria as phase C, applied per cohort;
- front-desk guidance that the QR, not the card text, decides entry. Check-in never reads the pass
  (tested).

## Phase E — the 65 existing static passes (separate strategy)

These passes stay untouched until migrating them is independently established as safe. See
[`SMART_WALLET_2_MIGRATION_READINESS.md`](./SMART_WALLET_2_MIGRATION_READINESS.md):
- **Staging trials:** at least 30 on the preferred method (guided remove-and-re-add, or open-pass
  recovery after an in-place replacement) before claiming a rate.
- **Detection:** `NO_ACTIVE_UPDATE_REGISTRATION`, registration churn and `NOT_FETCHED_AFTER_PUSH`.
  Registrations are never recreated server-side.
- **Rollout:** cohorts with stop criteria and member instructions.

## Production readiness checklist

| Area | Item | State |
|---|---|---|
| Code | Refresh engine, queue, history, health, delivery safety | Done locally (Stage 3 + 4A) |
| Code | Issuance-time allowlisted enrollment (phase D) | **Not built** (Stage 4B) |
| Tests | Unit, e2e, migration simulations | Green locally; e2e harness flake fixed |
| Staging | End-to-end automatic update on a real iPhone | Validated 2026-10-15 (one device, one update) |
| Staging | Stage 4A code (dedup, pending sweep, `SERIALS_LISTED`, health) | **Not yet deployed to staging** |
| Ops | Health findings in logs; health CLI with exit codes | Done; **no alert delivery and no cron configured** |
| Ops | Production certificate expiry known | **Pending** (phase B) |
| Ops | Permanent `webServiceURL` decided | **Pending** |
| Ops | Wait for CI on production `api` | Recommended, not set |
| Security | Tokens never logged, device ids hashed, rate-limited device endpoint | Reviewed (Stage 4A §5) |
| Product | Member and front-desk guidance; static-pass migration strategy | Drafted; migration NO-GO |

## Gates summary

| Gate | Requires approval for | Rollback |
|---|---|---|
| A | Merge to `main` (applies 3 migrations) | Redeploy `beb66b27`; schema stays |
| B | — (verification only) | — |
| C1 | Production flags: dynamic + routes + URL | Flags off |
| C2 | Refresh worker on | Worker flag off |
| C3 | Live APNs | APNs flag off |
| D | Stage 4B code and new-member cohorts | Disable auto-enrollment; flags off |
| E | Any change to existing static passes | Not started |
