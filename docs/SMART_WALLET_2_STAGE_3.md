# Smart Wallet 2.0 — Stage 3: automatic refresh and registration reliability

Status: **implemented locally on the Smart Wallet feature branch. Not pushed, not deployed.
The new worker is OFF by default (`WALLET_REFRESH_WORKER_ENABLED=false`). No existing ARES pass
has been migrated. Migrating existing production passes remains NO-GO.** The migration question
is evaluated separately in [`SMART_WALLET_2_MIGRATION_READINESS.md`](./SMART_WALLET_2_MIGRATION_READINESS.md).

Stage 3 makes a dynamic pass follow the member's entitlement on its own, and makes the state of
Wallet's device registrations observable. It does not change who may enter, book or pay. Check-in
and booking never read anything introduced here.

## 0. Stage 2 closure: what the real-iPhone test established

The Stage 2 test used one iPhone, the isolated `smart-wallet-staging` Railway environment, a
staging-only Pass Type ID and two synthetic members (A, B). All times are UTC.

| # | Observation | Status |
|---|---|---|
| 1 | Fresh dynamic install (A): the pass installed and registered, a push was accepted, Wallet downloaded the new version and the card changed state | **Established** |
| 2 | Static → dynamic replacement (B), same serial: the card was replaced in place and now shows `ESTADO`; serial, QR and authentication token are unchanged | **Established** |
| 3 | After that replacement, Wallet registered and then unregistered the pass twice within about a minute. The DELETEs were sent by Wallet at 2026-10-14 18:47:35 and 18:48:17. The pass stayed installed with no registration, and the backend answered every request per Apple's contract | **Observed once.** Replaced passes may silently lose their registration |
| 4 | Recovery: Wallet registered B again at 2026-10-15 04:07:48, **before** the operator toggled Automatic Updates. The toggle that followed produced an unregister (04:07:56) and a register (04:08:07). The registration then stayed stable for more than 18 minutes | **Observed once.** Opening the pass may be enough. The toggle was **not** shown to be necessary |
| 5 | After recovery, one push to B was accepted (HTTP 200). The phone then fetched the changed serials and the new pass version, and the card showed `VENCIDA` with the same serial and QR | **Established** for this device |
| 6 | With iCloud Wallet sync on, a second device on the same Apple account registered pass A as a separate device | Noted; not studied further (out of scope by decision) |

**Not established:**
- why Wallet dropped the registration after the replacement (Apple does not document it, and no device log was captured);
- how often it happens: one replacement was observed;
- whether opening the pass reliably restores the registration, how quickly, and on which iOS versions;
- behaviour with Apple Watch, several devices, or at member scale.

Three device-level observations are anecdotes, not a rate.

## 1. What Stage 3 adds

| Component | Where |
|---|---|
| Automatic refresh engine (change detection, transition sweep, reconciliation, durable queue, worker) | `apps/api/src/wallet/refresh/` |
| Delivery bookkeeping: `pushedPassVersion`, `lastPushedAt`; no push for unchanged content | `wallet-pass-push.service.ts`, `wallet-refresh-processor.service.ts` |
| Pass lifecycle history (`wallet_pass_events`) and registration analysis | `wallet-pass-events.service.ts` |
| Explicit `304 Not Modified` handling and accurate request logs | `passkit.controller.ts`, `passkit.service.ts` |
| Signing-certificate expiry monitoring | `wallet-refresh-worker.service.ts`, `apple-wallet-provider.service.ts` |
| Operator CLIs: queue/refresh control and read-only diagnostics | `src/cli/wallet-refresh.cli.ts`, `src/cli/wallet-diagnostics.cli.ts` |
| One additive migration | `20261015120000_wallet_refresh_engine` |

## 2. Automatic refresh engine

### Three independent ways a stale pass is found

| Source | Cadence | Catches |
|---|---|---|
| **Change detection** (`detectChanges`) | every 15 s | Committed rows changed since a cursor (minus a 120 s overlap), for members holding a dynamic pass |
| **Transition sweep** (`sweepTransitions`) | every 60 s | Passes whose stored `nextTransitionAt` is due within 5 min. The job runs at the boundary + 1 s |
| **Reconciliation** (`reconcileAll`) | hourly, and when the worker starts | Every dynamic pass. This is the safety net for anything the other two miss |

**Why change detection instead of hooks in billing or sales code:**
- **It is post-commit by construction.** It reads only committed rows, so a rolled-back sale or webhook leaves nothing to refresh, and no wallet code runs inside anyone else's transaction.
- **It needs no change to financial code.** Cash sales, Stripe webhooks, day passes, credential reissue and check-in are untouched. A wallet failure cannot fail or slow a payment, a sale or a check-in.
- **It covers every write path,** including ones added later, provided they write through Prisma, which maintains `updated_at`. All of the application's writes to these tables do; its raw SQL on them is limited to reads and locks. A manual SQL correction that deliberately preserves `updated_at` is picked up by the hourly reconciliation instead.
- **Latency** is at most about 20 s for a detected change (poll plus tick) and at most an hour for anything only reconciliation finds.

**The durable job table is the outbox.** A trigger only inserts or coalesces a row in
`wallet_pass_refresh_jobs`. Signing and APNs happen later, in the worker, outside any
transaction.

| Detected change | Column read | Covers |
|---|---|---|
| `subscriptions.updated_at` | member's rows | cash sale and renewal, Stripe renewal, payment failure and recovery, cancellation, plan switch, scheduled activation, staff edits |
| `day_passes.updated_at` | member's rows | day-pass purchase and status changes |
| `wallet_credentials.updated_at` | member's rows | revocation and reissue: the old dynamic pass becomes `REEMPLAZADO` (voided) |
| `studio_memberships.updated_at` | member's row | removal from the studio, role changes |
| `membership_entitlement_cycles.created_at` | member's rows | new entitlement cycles (append-only table) |
| `membership_plans.updated_at` | plans of the member's subscriptions | plan rename, access-scope change |
| `users.updated_at` | the member | name changes (other user updates cause a harmless recompute) |
| `studios.updated_at` | the studio | studio name, timezone, branding |

The scan iterates only the members who hold a dynamic Apple pass. It uses existing
`(studio_id, user_id)` indexes, and no index was added to any existing table except
`wallet_pass_artifacts (pass_mode, next_transition_at)` for the sweep. Every candidate is
enqueued, in statements of at most 5,000 members, before the cursor advances. A crash in between
only means the next run detects the same members again and coalesces them.

**Time-based transitions.** Every refresh persists `nextTransitionAt`, even when the content is
unchanged, so the sweep never loops on a stale instant. The value comes from the canonical
entitlement rules:
- the end of an entitled period, or `entitlementEndsAt` for fixed-duration plans;
- the start of a scheduled membership;
- the studio-local midnight boundaries of day passes.

### Processing one job

`WalletRefreshProcessorService.processMember(studio, member)`:

1. Loads every DYNAMIC Apple artifact of that member in that studio, including those of revoked
   credentials, so a reissue voids the old pass.
2. Calls the existing `WalletDynamicPassService.refresh`. It re-signs only when the
   member-visible content hash changed, writes with an optimistic guard, and recovers the token
   from the stored pass, failing closed rather than rotating it.
3. Pushes only if `passVersion > pushedPassVersion`, and only with `WALLET_APNS_ENABLED=true`.

It reads entitlement data and writes only `wallet_pass_artifacts`,
`wallet_pass_registrations` (removing tokens APNs reports invalid) and the new tables.
Re-running the same job changes nothing and sends no second push.

### Coverage of the required scenarios

| Scenario | Mechanism | e2e test (`wallet-refresh-engine.e2e-spec.ts`) |
|---|---|---|
| Cash sale / renewal | change detection | cash renewal at the desk (real HTTP sale) |
| Stripe renewal | change detection | Stripe renewal after the period boundary (signed webhook) |
| Stripe payment failure and recovery | change detection | `past_due` → `PAGO PENDIENTE` → `active` → `VIGENTE` |
| Membership expiration by time | transition sweep | cash period ends |
| Entitlement cycle boundaries | transition sweep | fixed-duration (`entitlementEndsAt`) boundary |
| Scheduled activation | transition sweep | `PROGRAMADA` → `VIGENTE` |
| Multiple memberships | either | Full Access ends, Booty Lab remains |
| Day Pass validity | detection + sweep | valid today, not after local midnight |
| Plan changes | change detection | owner renames the plan; member switches plan |
| Credential revocation / reissue | change detection | reissue voids the old dynamic pass; the new static pass is untouched |

## 3. Reliability

- **Coalescing.** A partial unique index keeps one PENDING job per member. Further triggers
  coalesce into that row: `run_after` keeps the earliest time and `trigger_count` counts the
  triggers.
- **Claiming.** Workers claim with `FOR UPDATE SKIP LOCKED` and hold a 5-minute lease, so several
  API instances are safe.
- **One member at a time.** A member with a live RUNNING job is not claimed again. A change that
  arrives meanwhile waits as a new PENDING row.
- **Guarded transitions.** Every state change after a claim is guarded by
  `status = RUNNING AND locked_by = <worker>`. A worker whose lease was recovered cannot overwrite
  newer state.
- **Retries.** Retryable failures use exponential backoff (30 s, 60 s, 2 min … capped at 30 min,
  ±20 % jitter), up to 6 attempts. After that the job becomes `FAILED` (a dead letter) and
  `wallet.refresh.dead_letter` is logged at error level. Automatic triggers then leave that
  member alone for 6 hours, while operator requests still work.
- **Permanent failures.** If the stored pass cannot prove its own token or QR, the job
  dead-letters at once. The token is never rotated and nothing is written.
- **Crash recovery.** RUNNING jobs whose lease has expired go back to PENDING, or to FAILED if
  their attempts are spent, so a job that kills its worker cannot loop forever. A retry that
  collides with a newer PENDING row is marked `SUPERSEDED`.
- **Single-flight scheduling.** Detection, the sweep and reconciliation each run under
  `pg_try_advisory_xact_lock` inside a short, database-only transaction.
- **No external call inside a transaction.** Signing happens before the single guarded UPDATE,
  and APNs is called afterwards.
- **No push for unchanged content.** Delivery is tracked by `pushedPassVersion`, which advances
  only when no registration failed transiently and only if the pass is still at the pushed
  version.

**APNs outcomes:**
- **200:** delivered.
- **410, or reason `BadDeviceToken` / `Unregistered` / `DeviceTokenNotForTopic`:** the registration is pruned, recorded as `APNS_INVALID_TOKEN`, and not retried.
- **429, 5xx or a network error:** the job is retried and the version stays undelivered.
- **APNs disabled:** the job succeeds and the version stays undelivered. The first reconciliation after APNs is enabled delivers it.

**On deploy:** existing DYNAMIC rows are backfilled as already pushed at their current version,
so a deploy never triggers a burst of pushes.

**Monitoring, as logs only.** No alert routing is configured, and none was added because this
stage does not touch alerts.

| Event | Level | Meaning |
|---|---|---|
| `wallet.refresh.build_failed` | error | Signing or rendering failed; the job is retried |
| `wallet.refresh.dead_letter` | error | A job exhausted its attempts or hit an integrity failure |
| `wallet.refresh.transition_sweep_capped` | warn | More than 5,000 transitions due at once; the most urgent go first and the rest are taken by the next sweep |
| `wallet.refresh.leases_recovered` | warn | Crash recovery happened |
| `wallet.certificate.expiry` | log / **warn** (< 30 days) / **error** (< 7 days or expired) | Hourly check of the pass-signing certificate, which is also the APNs identity |
| `wallet.certificate.unreadable` | error | The certificate could not be parsed |

## 4. Registration visibility

`wallet_pass_events` is an append-only history:

| Type | Recorded when | Device |
|---|---|---|
| `REGISTERED` | a device registers (`detail.outcome` is `created` or `existing`, plus `pushTokenChanged`) | hash |
| `UNREGISTERED` | a device unregisters (`detail.removed`, `registrationAgeMs`) | hash |
| `PASS_RETRIEVED` | `GET` of the latest pass answered 200 with the `.pkpass` (`detail.bytes`) | none: Apple's request does not identify the device |
| `PASS_NOT_MODIFIED` | the same request answered 304 | none |
| `APNS_ACCEPTED` / `APNS_INVALID_TOKEN` / `APNS_FAILED` | each APNs attempt (`detail.apnsId`, `reason`, `pruned`) | hash |

**What is and is not stored:**
- A device appears only as the first 16 hex characters of SHA-256 of its device library
  identifier. Raw identifiers, push tokens, authentication tokens and QR values are never stored
  or logged; the e2e suite checks the table for each of them.
- `detail` is allow-listed and bounded.
- History is best-effort: a failed insert is logged and never fails the device request.
- **Registrations are never created, recreated or forged server-side.**

**Derived signals** (`analyzeRegistrationHistory`, shown by the diagnostics CLI):
- active device count;
- last registration, last unregistration and last APNs acceptance;
- last APNs failure;
- last retrieval and its version, and whether the current version was retrieved;
- churn: a device that unregistered within 10 minutes of registering and has not re-registered,
  which is the Stage 2 replacement pattern.

**Wording rule:** zero registrations is reported as "no device is currently registered for
updates", never as "pass removed". Wallet can drop a registration while keeping the pass.

**Retention**, applied daily in batches of 1,000:

| Data | Kept |
|---|---|
| `wallet_pass_events` | 180 days (and deleted with their artifact) |
| `wallet_pass_refresh_jobs` SUCCEEDED / SUPERSEDED | 30 days after completion |
| `wallet_pass_refresh_jobs` FAILED | 90 days after completion |

## 5. HTTP: 200 versus 304

The latest-pass route compares `If-Modified-Since` with the pass's `Last-Modified` at
one-second precision, the precision of HTTP dates.

| Response | What happens |
|---|---|
| **304** | Empty body, `Last-Modified`, `Cache-Control: no-store`. Log `wallet.passkit.pass_not_modified`, event `PASS_NOT_MODIFIED` |
| **200** | `.pkpass` body. Log `wallet.passkit.pass_served` with `bytes`, event `PASS_RETRIEVED` |

Before Stage 3, Express's automatic freshness check could answer 304 while the log still said
"pass served".

`Last-Modified` now moves to a strictly later second on every new version. Two versions written
within the same second can no longer share a timestamp, which would let a stale 304 hide the
second one.

| What happened | Log event | History event |
|---|---|---|
| Registration attempt | `wallet.passkit.registered` (`created` / `existing`) | `REGISTERED` |
| Unregistration | `wallet.passkit.unregistered` (`removed`, `registrationAgeMs`) | `UNREGISTERED` |
| Changed serials listed | none (visible in the platform's HTTP request log) | (none) |
| 200 with the pass | `wallet.passkit.pass_served` | `PASS_RETRIEVED` |
| 304 | `wallet.passkit.pass_not_modified` | `PASS_NOT_MODIFIED` |
| APNs accepted / rejected | `wallet.apns.pass_update` (per-registration `apnsId`) | `APNS_*` |

## 6. Flags and operations

| Flag | Default | Effect |
|---|---|---|
| `WALLET_REFRESH_WORKER_ENABLED` | `false` | Starts the refresh worker inside the API process. It requires `WALLET_DYNAMIC_PASSES_ENABLED=true`, and the API refuses to boot otherwise. It does **not** imply pushes, which still need `WALLET_APNS_ENABLED=true` |

The worker ticks every 5 s and never overlaps itself. Each tick:
1. recovers expired leases;
2. runs whichever phases are due: detection 15 s, sweep 60 s, reconciliation 1 h, retention 24 h, certificate check 1 h;
3. processes up to 10 due jobs.

The cadences are constants (`wallet-refresh.constants.ts`), not environment variables. A CLI
never starts the worker.

| CLI | Command | Writes |
|---|---|---|
| `wallet-refresh.cli.js` | `queue` | no |
| | `enqueue --credential <id> [--confirm]` | one job row (dry run without `--confirm`) |
| | `process [--limit n] --confirm` | processes due jobs; pushes only with `WALLET_APNS_ENABLED` |
| | `tick [--limit n] --confirm` | one full cycle, including reconciliation of **every** dynamic pass |
| `wallet-diagnostics.cli.js` | `pass --credential <id>` / `studio --studio <id>` / `certificate` | never |

Exit codes are 0 done, 2 refused (nothing written), and 1 failure. Output never contains device
identifiers, push tokens, authentication tokens or QR values.

## 7. Database: migration `20261015120000_wallet_refresh_engine` (additive)

**What it adds:**
- **Tables:** `wallet_pass_refresh_jobs`, `wallet_refresh_cursors`, `wallet_pass_events`.
- **Enums:** `WalletPassRefreshStatus`, `WalletPassEventType`.
- **Columns:** `wallet_pass_artifacts.pushed_pass_version` (default 0) and `last_pushed_at`.
- **Indexes:**
  - `wallet_pass_artifacts (pass_mode, next_transition_at)`;
  - the partial unique index `wallet_pass_refresh_jobs_one_pending_per_member`.
- **Foreign keys:** jobs → studio and user (RESTRICT); events → studio (RESTRICT) and artifact (CASCADE).

**Data changes:** the only data statement backfills `pushed_pass_version = pass_version` for
DYNAMIC rows. Production has none: the Stage 1A and Stage 3 migrations exist only on this
branch.

**Lock impact:** the new tables are empty, and `ADD COLUMN` with a constant default is
metadata-only. The new index covers about 130 rows.

**Rollback (recommended): code only.** The previous build never reads these objects. Full removal
is a separate, deliberate step, listed in the migration header. Its last statement deletes the
migration's `_prisma_migrations` row and is required: after the DROPs alone, `prisma migrate
status` still reports "up to date", and a later deploy of this code would run against missing
tables. This was reproduced on a scratch database.

## 8. Verification (local only)

- **Unit tests:** 128 suites, 1,572 tests. New coverage:
  - backoff and jitter bounds;
  - certificate expiry grading;
  - error redaction;
  - registration-history analysis (healthy pass, replacement churn, recovery, slow unregistration, 304 versus retrieval, APNs failures);
  - events stored as hashes with allow-listed detail, and best-effort writes;
  - `If-Modified-Since` parsing;
  - `nextLastModifiedAt`;
  - the worker flag rule;
  - signing-certificate info.
- **e2e tests:** 49 suites, 578 tests, including every existing wallet, billing and check-in
  suite. Two suites are new:
  - `wallet-refresh-engine.e2e-spec.ts` (26 tests): the scenarios in §2 plus the defaults, the queue (coalescing, concurrent claims, per-member serialization, lease recovery, supersede, poison job and cooldown), APNs 503 retry and backoff, dead letter after six attempts, 410 pruning, APNs disabled then enabled, no financial mutation (checksums of 11 tables), check-in with a refreshed pass, and the advisory lock;
  - `wallet-registration-history.e2e-spec.ts` (8 tests): the event sequence including 200 versus 304, no secrets in the table, per-device APNs events, same-second `Last-Modified`, the diagnostics wording and scoping, the certificate report, and retention.
- **Migration simulation on throwaway local databases:**
  - **Fresh install** of all 58 migrations: the drift is identical to the pre-existing baseline, so Stage 3 adds none.
  - **Upgrade** from the 57 earlier migrations with representative rows: existing artifact and registration rows are byte-identical; the backfill is correct (DYNAMIC versions 3 and 1 marked pushed, STATIC and Google rows 0); the tables, enums, indexes and FKs are as specified; a second PENDING row per member is rejected (23505) while RUNNING, SUCCEEDED and FAILED rows coexist.
  - **No-op re-deploy.**
  - **Documented rollback:** the schema is exactly the pre-Stage-3 schema and the data is preserved.
  - **Re-apply after rollback** (with the `_prisma_migrations` row removed): identical result.
- `prisma validate`, `nest build`, lint and typecheck are clean.
- **CLI smoke** against the local test database: usage, `queue`, refusals without `--confirm` or with dynamic passes off, unknown credential, and the three diagnostics commands.

## 9. Known limitations

- **No alerting.** Dead letters, build failures and certificate warnings are log lines only.
- **Re-processing within the overlap.** A change is re-detected for 120 s after it happened and
  recomputed: harmless and unchanged, but extra work. Logins and other user-row updates also
  trigger a recompute.
- **Every worker start reconciles every dynamic pass.** That is cheap at today's scale, but it
  is load proportional to the number of dynamic passes on each deploy.
- **Retrieval events carry no device.** Apple's latest-pass request does not identify the
  device, so "current version retrieved" is per pass, not per device.
- **Stale cards.** A pass whose registration Wallet has dropped keeps showing its last state
  until the member opens it or re-adds it. Diagnostics surface it; the server cannot repair it.
- **Google Wallet is unchanged.**
