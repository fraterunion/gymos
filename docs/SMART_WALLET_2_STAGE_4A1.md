# Smart Wallet 2.0 — Stage 4A.1: retry safety, worker liveness, release documentation

Status: **local commits on `feat/smart-wallet-foundation`, on top of `e876500`. Not pushed, not
deployed.** No migration and no new environment variable. Production is unchanged, and so is the
staging configuration.

Stage 4A was validated on staging on 2026-10-16 (§1). That run found two defects, both inert while
the refresh worker and APNs are off: §2 (retry backoff) and §3 (false WORKER_IDLE). Release and
recovery procedures are in [`SMART_WALLET_2_RELEASE_RUNBOOK.md`](./SMART_WALLET_2_RELEASE_RUNBOOK.md).

## 1. Stage 4A staging validation (2026-10-16)

**Code and CI**
- `e876500` was pushed to the feature branch only.
- CI run `38831475396` passed.

**Staging deployments (`api-staging` only)**

| Deployment | Purpose |
|---|---|
| `e1865274` | Waited for CI and applied `20261016120000_wallet_serials_listed_event` (59 migrations) |
| `d6fab973` | Refresh worker on, APNs off |
| `d08160a3` | Worker off again (current) |

**Pass integrity:** the synthetic passes kept their serial, authentication token and QR
throughout.

**Monitoring**
- **Health CLI exit codes:** 0 when clean, 3 with HIGH findings (synthetic fixture, approved,
  then removed), 0 with only MEDIUM findings.
- **304 logging:** an iPhone pull-to-refresh produced 304 responses, logged as
  `PASS_NOT_MODIFIED`.
- **Privacy:** an audit of all event and registration rows found no raw device id, push token or
  QR value.
- **UNDELIVERED_VERSION** (MEDIUM, "APNs is disabled") appeared after 30 min for the undelivered
  pass B.
- **Not observable on staging:** `SERIALS_LISTED` requires a push or a new registration, and
  `NO_ACTIVE_UPDATE_REGISTRATION` would require changing a real registration. Both are covered by
  local tests.

**Worker test (APNs off throughout)**
1. Nothing ran at boot. The first reconciliation ran 11 min after boot, and both passes came back
   `unchanged`.
2. The approved change to synthetic member B was detected 13 s after commit.
3. B was re-signed from v3 to v4 with `push_pending_apns_disabled`. Serial, token and QR were
   unchanged.
4. There was no APNs traffic, and only B's subscription row changed.

**Defects found:**
- Every change is re-detected on each 15 s poll for the 120 s overlap window (1 + 8 jobs; the same
  in Stage 3). This exposed §2.
- The first health evaluation reported HIGH WORKER_IDLE; that is §3.

## 2. Fix: retries keep their backoff under repeated triggers (P0)

**Root cause.**
- Change detection re-scans 120 s behind its cursor, so a committed change is seen on about 9
  polls.
- Each detection coalesced into the member's PENDING job with
  `run_after = LEAST(existing, now)`. A job waiting out its retry backoff was therefore pulled
  forward on every poll.
- With APNs failing, all six attempts ran at 0, 15, 30, 45, 60 and 75 s, instead of the intended
  0, 30, 90, 210, 450 and 930 s. The member then sat in the 6 h dead-letter cooldown, with a stale
  pass.

Two further paths defeated the budget:
- A trigger arriving while a job was RUNNING queued a sibling. When the attempt failed, that
  sibling replaced the job at attempt 0 and was due immediately. Crash recovery went through the
  same path, so a job that kept killing its worker never dead-lettered.
- After a dead letter, such a sibling ran on the next tick, bypassing the cooldown.

**Fix** (`wallet-refresh-queue.service.ts`)
- A PENDING row that has already been attempted is a scheduled retry: coalescing keeps its
  `run_after` and only counts the trigger. The retry recomputes the member's latest state, so a
  new change is neither lost nor run early.
- A row that has never run is still pulled forward: a change does not wait for a future
  transition.
- When a running attempt fails and a sibling exists, the job is `SUPERSEDED`. The sibling inherits
  the attempt count and the backoff, in one transaction.
- After an expired lease, the sibling inherits the attempt count but is due at once: an expired
  lease is not the job's own failure.
- A dead letter (exhausted retries, integrity failure or expired lease) holds any PENDING sibling
  until the cooldown ends. An operator (`MANUAL`) enqueue ignores the cooldown and still pulls it
  forward.

**Evidence.** `wallet-refresh-retry-safety.e2e-spec.ts` (8 tests, fake clock, local fake APNs):

| Run | Result |
|---|---|
| Before the fix (`e876500`) | 6 tests fail. Attempts run at 0, 15, 30, 45, 60 and 75 s, the staging pattern |
| After the fix | All pass. Attempts run at 0, 30, 90, 210, 450 and 930 s |

The two control tests pass both before and after:
- a never-attempted job is still pulled forward;
- crash recovery without a sibling re-queues at once.

## 3. Fix: health separates a starting worker from a stopped or stalled one (P1)

**Root cause.**
- WORKER_IDLE meant "no job completed in 2 h".
- The first reconciliation is deliberately delayed 5–15 min after start.
- So the first evaluation after the worker had been off for more than 2 h reported HIGH. On staging
  that was 01:38:49Z, `idleMinutes 356`; it cleared by itself 15 min later. It would have fired on
  every first enable in production.

**Fix**
- **Heartbeat.** The worker's own loop (`tick()`, never a CLI's `runOnce()`) records liveness in
  two rows of the existing `wallet_refresh_cursors` table:
  - `worker_heartbeat`, at most every 30 s;
  - `worker_running_since`.
- **Run boundaries.** A start after more than 5 min without a heartbeat begins a new run. A quick
  restart (a deploy) continues the current one, so a crash loop cannot keep renewing the startup
  grace.
- **Classification.** `classifyRefreshWorker` is pure and is applied the same way in-process and in
  the CLI:

| State | Meaning | Finding |
|---|---|---|
| `DISABLED` | Worker flag off | — |
| `STARTING` | The run began less than 1 min ago | — |
| `AWAITING_FIRST_RUN` | Alive. No job has completed in this run yet, but the latest first reconciliation (15 min) + 10 min of slack has not passed | — |
| `HEALTHY` | Alive and completing jobs, or there are no dynamic passes | — |
| `IDLE` | Alive, but the first run is overdue (`FIRST_RUN_OVERDUE`) or no job has completed for 2 h (`NO_RECENT_COMPLETED_JOB`) | `WORKER_IDLE` (HIGH) |
| `STOPPED` | Enabled, but no heartbeat for 5 min (`HEARTBEAT_STALE`) or ever (`NEVER_STARTED`) | `WORKER_STOPPED` (HIGH) |

- Jobs completed before the current run began do not count for it.
- The heartbeat is checked first, so the grace never hides a dead loop.
- The grace is bounded, so a run that never completes anything is still reported.
- The report and the `wallet.health.summary` line carry the worker state.

**Evidence**
- **Unit:** 11 cases for the classifier.
- **End to end** (`wallet-worker-health.e2e-spec.ts`, 7 tests, worker flag on, timer never
  started), covering:
  - a fresh start after a 6 h gap, waiting for and completing the first run;
  - a stopped loop;
  - a worker that never started;
  - an overdue first run;
  - a 2 h stall;
  - restart semantics;
  - "a CLI never writes liveness";
  - the 30 s throttle.
- **Delivery safety:** with the flag off the worker is `DISABLED`, whatever its old rows say.
- **Scratch reproduction of the staging case:**

| Code | First loop iteration reports |
|---|---|
| `e876500` | `WORKER_IDLE` HIGH, `idleMinutes 360` |
| This stage | `STARTING`, no worker finding, first-run deadline at start + 25 min |

## 4. Staging state now (left as the Stage 4A validation ended)

**Configuration.** `api-staging` runs `e876500`:

| Setting | Value |
|---|---|
| `WALLET_DYNAMIC_PASSES_ENABLED` | true |
| `WALLET_PASSKIT_ROUTES_ENABLED` | true |
| `WALLET_APNS_ENABLED` | **false** |
| `WALLET_REFRESH_WORKER_ENABLED` | **false** |
| Wait for CI | on |

**APNs stays OFF until explicitly approved.**

**Synthetic pass A** (`…ip8m`): v2, delivered (pushed version 2), status VENCIDA.

**Synthetic pass B** (`…gvz0`)
- **v4 (VENCIDA) is undelivered.** It was built at 2026-10-16 01:50:35Z; the pushed version is
  still 3.
- Devices keep showing VIGENTE until a push, or until the member pulls to refresh in Wallet.
- Health reports `UNDELIVERED_VERSION` (MEDIUM, "APNs is disabled").

**Registrations**
- Passes A and B are each registered on the operator's iPhone and on an iPad on the same Apple
  account. iCloud Wallet sync registered the iPad by itself: pass A at 2026-10-15 03:29Z, pass B
  at 23:06Z.
- So any push for A or B reaches both devices.
- The operator asked for iPhone-only testing. Before the next staging APNs test, either remove the
  passes from the iPad or turn off iCloud Wallet sync on it.
- Never recreate or forge registrations server-side.

**When APNs is next enabled together with the worker,** the pending-delivery sweep delivers B's
v4 to both devices within about a minute.

## 5. Verification (local, on the final Stage 4A.1 code, `5ea9442`)

- **Prisma, typecheck, lint:** `prisma validate`, typecheck and lint are clean.
- **Unit:** 129 suites, 1,588 tests.
- **End to end:** 52 suites, 607 tests, green in two full runs:
  - a normal run;
  - a run under the Stage 4A stress harness: 1,000 short-lived listeners on `127.0.0.1`,
    1,080,000 binds, **0 interceptions**.
- **Build:** `prisma generate && nest build` succeeds.
- **Migrations:** none added; no file under `prisma/` changed (empty diff against `e876500`).
  - A fresh install of the 59 migrations on a scratch database applies cleanly, and
    `migrate status` is up to date.
  - The pre-existing schema drift (24 lines) is byte-identical to the `e876500` baseline.
- **Production rollback target:** the two-phase test was re-run with this stage's code creating the
  pilot-shaped state. `e365d2d` reported "No pending migrations" and passed 4/4: stored passes are
  served byte-identical, the QR is the same, desk check-in works, the PassKit routes return 404,
  and no Smart Wallet row changes (runbook §5).
- **Invariants** (existing suites, green in both runs):
  - **Static passes and QR:** static artifacts are never touched; a re-signed pass keeps its token,
    serial and QR; the static flow is unchanged with the flags off.
  - **Check-in:** check-in is unaffected by a refreshed pass; an old barcode is rejected after a
    reissue; a stale VIGENTE pass does not admit an expired member.
  - **Financial data:** a full forced worker cycle changes no financial, membership or credential
    record.
  - **Flags:** `validate-env` defaults every flag to OFF; the worker is OFF unless explicitly
    enabled.

## 6. Not changed (known, accepted)

- **Re-detection:** a change still produces 1 + 8 jobs during the overlap window. The extra jobs
  are content-hash no-ops: no re-signing and no push.
- **NOT_FETCHED_AFTER_PUSH** still credits a device only for `SERIALS_LISTED`. A pass fetched
  before Stage 4A existed is a one-off LOW false positive on staging; it cannot occur in
  production.
- **Alerting:** health findings are still log lines only. Schedule `wallet-diagnostics.cli.js
  health` (exit code 3) before a staff pilot; `WORKER_STOPPED` can only be seen from outside the
  worker.
