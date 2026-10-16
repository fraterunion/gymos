# Smart Wallet 2.0 — production rollout plan (proposal)

Status: **a plan, not an authorization.** Every phase below needs its own explicit approval, and
none starts automatically. Production is unchanged today.

**The existing ARES static passes stay untouched** until migrating them is independently shown to
be safe (phase E). The 2026-10-16 read-only preflight counted 68 active Apple static passes, all
with a valid QR. The number grows with every new member, so recount before each phase rather than
relying on a fixed figure.

Stage 4A was validated on staging on 2026-10-16, and Stage 4A.1 fixed the two defects that run
found ([`SMART_WALLET_2_STAGE_4A1.md`](./SMART_WALLET_2_STAGE_4A1.md)). Release safety, the restore
point, migration-failure recovery and rollback are in
[`SMART_WALLET_2_RELEASE_RUNBOOK.md`](./SMART_WALLET_2_RELEASE_RUNBOOK.md).

**Merging to `main` is a production release.** Today, Railway deploys `main` immediately, without
waiting for CI and without a healthcheck. Its start command runs `prisma migrate deploy` against
the production database (runbook §1).

## What reaches production with the first merge

The branch adds three pending migrations, all additive:
- `20261013120000_wallet_dynamic_pass_foundation`
- `20261015120000_wallet_refresh_engine`
- `20261016120000_wallet_serials_listed_event`

> **MERGING TO MAIN WILL APPLY THESE MIGRATIONS TO PRODUCTION.**

**Services.**
- `api` redeploys and migrates.
- `billing-integrity-audit` rebuilds, because it has no watch paths; its code is unchanged.
- `admin` and `mobile` are skipped.
- No mobile code changes, so there is no OTA.

**The code is inert with every flag off, with one exception.** The Stage 1A **static plan-name
fix** changes newly built static passes: they stop naming a plan when the member is not entitled.
Stored static passes are still served byte for byte, and their template version is unchanged.

**Flags:** all default off.

| Flag | Effect when off |
|---|---|
| `WALLET_DYNAMIC_PASSES_ENABLED` | No dynamic builds or enrollment |
| `WALLET_PASSKIT_ROUTES_ENABLED` | The device web service returns 404 |
| `WALLET_APNS_ENABLED` | No pushes. **Stays OFF until explicitly approved**, in staging and production alike |
| `WALLET_REFRESH_WORKER_ENABLED` | No worker |

## Phase A — dark deployment (all Wallet flags off)

**Before the merge (read-only unless noted):**
- [x] Stage 4A validated on staging (2026-10-16).
- [ ] Stage 4A.1 is pushed with approval, then passes CI and a short staging re-validation. That
  SHA is the release candidate.
- [ ] Production `migrate status` shows exactly the three migrations above as pending and no failed
  row.
- [ ] Baselines:
  - [ ] row counts and byte checksums of `wallet_pass_artifacts` (`pkpass_data`, `template_version`)
    and of `wallet_credentials` (`credential_hash`, `revoked_at`);
  - [ ] QR integrity of every stored Apple pass;
  - [ ] row counts and checksums of the financial tables: payments, subscriptions, entitlement
    cycles, Stripe events, billing cases and day passes.
- [ ] A Neon restore branch at T_pre, verified (runbook §3).
- [ ] *Production configuration changes, each approved* (runbook §2), rehearsed on `api-staging`
  first:
  - [ ] a healthcheck on `/health`;
  - [ ] migrations as a pre-deploy command over Neon's direct endpoint;
  - [ ] 30 s draining;
  - [ ] Wait for CI on `api` and `billing-integrity-audit`.
- [ ] The migration-failure runbook (runbook §4) is read, and whoever can approve a
  `migrate resolve` is reachable during the release.

**Release:** fast-forward `main` to the validated SHA, with explicit approval.

## Phase B — verify the dark deployment

- [ ] The deploy log shows the three migrations applied, then `wallet.refresh.worker_disabled`.
  `/health` returns 200.
- [ ] `migrate status` is up to date.
- [ ] Every Phase A baseline is identical: artifacts, credentials, QR integrity and the financial
  tables. The migrations only add columns with defaults and new tables. Their only data statement
  backfills DYNAMIC rows, and production has none.
- [ ] Static compatibility:
  - [ ] a staff member downloads their existing pass (served byte-identical);
  - [ ] Mi Pase recovers the same QR;
  - [ ] a staff QR scans at the desk;
  - [ ] PassKit routes return 404.
- [ ] `wallet-diagnostics.cli.js certificate` shows the **production** Pass Type ID certificate as
  OK, with more than 30 days left. This is a prerequisite for phase C.

**Rollback:** redeploy the previous production deployment (`beb66b27`, `e365d2d`) and keep every
row. This was verified against the Stage 4A schema with pilot-shaped Smart Wallet rows (runbook
§5).

## Phase C — internal staff pilot with newly issued dynamic passes

**Prerequisites, each needing approval:**
- **Web service URL, decided permanently.** It is signed into every dynamic pass forever.
  Recommendation: a business-owned API domain (CNAME) rather than `*.up.railway.app`.
- **Pilot allowlist:** 2–5 consenting staff accounts.
- **A fresh install, not a replacement.** On each pilot device, either no GymOS pass has ever been
  added or the staff member removes it first. Replacing a pass in place can drop its update
  registration (Stage 2 finding).
- **Several devices per person.** iCloud Wallet sync registers a staff member's other Apple devices
  (an iPad, for example) on their own, as it did on staging. Every push then reaches all of them.
- **Health checked from outside the worker:** a scheduled `wallet-diagnostics.cli.js health` (exit
  code 3 on HIGH/CRITICAL). `WORKER_STOPPED` cannot be reported by a worker that has stopped.
- **Live APNs approval**, which is separate from everything above.

**Steps:**
1. Set `WALLET_PASSKIT_WEB_SERVICE_URL`, `WALLET_DYNAMIC_PASSES_ENABLED=true` and
   `WALLET_PASSKIT_ROUTES_ENABLED=true`. The worker and APNs stay off.
2. For each pilot account:
   1. the staff member opens Mi Pase, which issues the credential and the static artifact;
   2. the operator runs `wallet-dynamic-pass.cli.js enroll --credential <id> --confirm`
      **before** the staff member adds the pass;
   3. the staff member adds it from the app.

   Verify with `wallet-diagnostics.cli.js pass`: a `REGISTERED` event and `activeDeviceCount ≥ 1`.
3. Enable `WALLET_REFRESH_WORKER_ENABLED`. Watch `wallet.health.*` and run the health CLI.
   - Expect the worker to report `STARTING`, then `AWAITING_FIRST_RUN`.
   - Expect `HEALTHY` once the first reconciliation completes, 5–15 min after start.
   - Expect no HIGH findings. Before Stage 4A.1, a false `WORKER_IDLE` fired here.
4. Only with separate approval, enable `WALLET_APNS_ENABLED`, then observe real entitlement
   changes for at least 7 days.

**Success criteria:**
- every pilot pass keeps an update registration;
- each change is accepted by APNs **and** followed by `SERIALS_LISTED` from each pilot device, plus a
  visual confirmation;
- no dead letters, no repeated APNs failures, no `UNDELIVERED_VERSION` after 30 minutes;
- retries follow the 30 s / 60 s / 2 / 4 / 8 min backoff (Stage 4A.1);
- the certificate is OK.

**Rollback, in order of severity:**
1. `WALLET_APNS_ENABLED=false` (stops pushes);
2. `WALLET_REFRESH_WORKER_ENABLED=false`;
3. routes and dynamic flags off.

The passes keep working as identity passes with the same QR; only updates stop. No history or job
row is deleted.

## Phase D — limited new-member enrollment (after a successful pilot)

**Not available today.** Enrollment is an operator command per credential. Phase D needs a
Stage 4B change: allowlisted issuance-time enrollment, so a new member's **first** download is
already dynamic (a fresh install, never a replacement). That change needs:
- a per-studio cap and an allowlist;
- the same success criteria as phase C, applied per cohort;
- front-desk guidance that the QR, not the card text, decides entry. Check-in never reads the pass
  (tested).

## Phase E — the existing static passes (separate strategy)

These passes stay untouched until migrating them is independently established as safe. Recount
them first. See [`SMART_WALLET_2_MIGRATION_READINESS.md`](./SMART_WALLET_2_MIGRATION_READINESS.md):
- **Staging trials:** at least 30 on the preferred method (guided remove-and-re-add, or open-pass
  recovery after an in-place replacement) before claiming a rate.
- **Detection:** `NO_ACTIVE_UPDATE_REGISTRATION`, registration churn and `NOT_FETCHED_AFTER_PUSH`.
  Registrations are never recreated server-side.
- **Rollout:** cohorts with stop criteria and member instructions.

## Production readiness checklist

| Area | Item | State |
|---|---|---|
| Code | Refresh engine, queue, history, health, delivery safety | Done (Stage 3 + 4A) |
| Code | Retry backoff kept under repeated triggers; worker liveness states | Done locally (Stage 4A.1), not pushed |
| Code | Issuance-time allowlisted enrollment (phase D) | **Not built** (Stage 4B) |
| Tests | Unit, e2e, stress harness, migration simulations, rollback to `e365d2d` | Green locally |
| Staging | End-to-end automatic update on a real iPhone | Validated 2026-10-15 (Stage 3) |
| Staging | Stage 4A code, migration and monitoring; worker run with APNs off | Validated 2026-10-16 |
| Staging | Stage 4A.1 | **Not yet deployed** |
| Ops | Health findings in logs; health CLI with exit codes | Done; **no alert delivery and no schedule configured** |
| Ops | Production `api` healthcheck, pre-deploy migrations, draining | **Proposed** (runbook §2) |
| Ops | Wait for CI on production `api` | **Proposed**; off today |
| Ops | Neon restore point | **Procedure defined** (runbook §3); not yet taken |
| Ops | Production certificate expiry known | Read-only: 2027-09-21; re-check in phase B |
| Ops | Permanent `webServiceURL` decided | **Pending** |
| Security | Tokens never logged, device ids hashed, rate-limited device endpoint | Reviewed (Stage 4A §5) |
| Product | Member and front-desk guidance; static-pass migration strategy | Drafted; migration NO-GO |

## Gates summary

| Gate | Requires approval for | Rollback |
|---|---|---|
| Pre-A | Production config (healthcheck, pre-deploy, draining, Wait for CI); the Neon restore branch | Revert each setting |
| A | Merge to `main` (applies 3 migrations) | Redeploy `beb66b27`; schema and rows stay |
| B | — (verification only) | — |
| C1 | Production flags: dynamic + routes + URL | Flags off |
| C2 | Refresh worker on | Worker flag off |
| C3 | Live APNs | APNs flag off |
| D | Stage 4B code and new-member cohorts | Disable auto-enrollment; flags off |
| E | Any change to existing static passes | Not started |
