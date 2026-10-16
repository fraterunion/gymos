# Smart Wallet 2.0 — Stage 4A: local production-readiness hardening

Status: **on the Smart Wallet feature branch (`e876500`, on top of `ed53871`), validated on staging
on 2026-10-16, and hardened by Stage 4A.1** (see
[`SMART_WALLET_2_STAGE_4A1.md`](./SMART_WALLET_2_STAGE_4A1.md)). Not merged. It adds one additive
migration (`20261016120000_wallet_serials_listed_event`), which is applied on staging only, and no
new environment variable. Production is unchanged. The staged launch plan is in
[`SMART_WALLET_2_PRODUCTION_ROLLOUT.md`](./SMART_WALLET_2_PRODUCTION_ROLLOUT.md), and release and
recovery procedures are in [`SMART_WALLET_2_RELEASE_RUNBOOK.md`](./SMART_WALLET_2_RELEASE_RUNBOOK.md).

Stage 3 was validated on staging on 2026-10-15. A real entitlement change was detected, the pass
was rebuilt and pushed, and the iPhone showed VENCIDA → VIGENTE. Stage 4A hardens what that run
could not cover: flaky tests, monitoring, multi-device delivery, restarts and scale.

## 1. Test reliability

**Symptom.** Rare full-suite runs had a single failure in an unrelated suite, such as a 404 on a
valid route or a 401 on a token that the previous request had accepted. Stage 1A also recorded a
"socket hang up". Re-running the suite alone always passed.

**Root cause, in the test harness rather than the product.**
- `createTestApp()` never bound the Nest server.
- supertest therefore called `listen(0)` for every request, which binds an OS-chosen port on the
  IPv6 wildcard `::`, and then connected to `127.0.0.1:<port>`.
- On macOS/BSD, another process may still bind `127.0.0.1:<that port>`, and that more specific
  binding receives the request. It answers with its own 404 or 401, or drops the connection.
- Linux refuses that second bind, which is why CI never failed.

**Evidence.** A local stress process held short-lived `127.0.0.1` listeners (each answering 404)
while four HTTP-heavy suites ran:

| Harness | Stress | Requests intercepted | Result |
|---|---|---|---|
| before (per-request `listen(0)` on `::`) | about 300 listeners | 2 | 54/56: **2 failures, both 404** |
| before | about 1,300 listeners (two stress processes) | 13 (7 + 6) | 43/56: **13 failures, all 404** |
| after (`app.listen(0, '127.0.0.1')` once per suite) | about 300 listeners | **0** | 56/56 |
| after | about 1,300 listeners | **0** | 56/56 |

Every failure under the old harness matched one intercepted request (2 for 2, 13 for 13). A
300-listener stress process was accidentally left running for about 30 minutes, about 2.1 million
binds. It covered every fixed-harness run, including two full suites of 578 and 590 tests, and
intercepted **nothing**.

**Fix (commit `e6e31dc`, test-only).** `createTestApp()` now listens once on `127.0.0.1`. Any
other process's bind on that port fails with EADDRINUSE, and every request in a suite reuses one
server. No retries were added; a genuine regression still fails.

## 2. Monitoring

`WalletHealthService.evaluate(now)` is read-only. It runs in the refresh worker every 15 minutes and
on demand through `wallet-diagnostics.cli.js health [--studio <id>]`. Severities use the
billing-case vocabulary.

| Code | Severity | Condition |
|---|---|---|
| `DEAD_LETTER_JOBS` | HIGH | Refresh jobs that exhausted their retries or failed an integrity check in 24 h (per studio, with error classes) |
| `REFRESH_FAILURE_SPIKE` | HIGH | Failures in the last hour ≥ 5 **and** ≥ 3× the previous day's hourly average |
| `APNS_REPEATED_FAILURES` | HIGH | ≥ 3 APNs failures for one pass in 24 h with no acceptance since |
| `APNS_FAILURE_RATE` | HIGH | ≥ 10 APNs failures across all passes in the last hour |
| `NO_ACTIVE_UPDATE_REGISTRATION` | MEDIUM | A pass that had an update registration has none now. The wording is always **"no active update registration … does not mean the pass was removed"** |
| `NEVER_REGISTERED_FOR_UPDATES` | LOW | A pass enrolled more than 24 h ago that never registered |
| `UNDELIVERED_VERSION` | MEDIUM | The newest version has not been accepted by APNs for every device after 30 min (the message says whether APNs is off) |
| `NOT_FETCHED_AFTER_PUSH` | LOW | APNs accepted the push, but a device registered at push time has not asked for its changed passes within 30 min. Lists the device hashes |
| `QUEUE_BACKLOG` | MEDIUM / HIGH | The oldest due job has waited more than 10 / 60 min |
| `STUCK_JOBS` | HIGH | A RUNNING job is well past its lease and nothing recovered it |
| `WORKER_IDLE` | HIGH | **Changed in 4A.1.** The worker is alive, but its first run is overdue (latest first reconciliation + 10 min) or no job has completed for 2 h. Before 4A.1 it fired on every first evaluation after a long disabled period |
| `WORKER_STOPPED` | HIGH | **New in 4A.1.** The worker flag is on, but the worker's loop has not recorded a heartbeat for 5 min, or ever. Only visible from outside the worker (CLI or cron) |
| `CERTIFICATE_EXPIRY` | MEDIUM / HIGH / CRITICAL | The signing (and APNs) certificate has less than 30 days left, less than 7 days, or has expired or is unreadable |

**Output.**
- **Worker logs:** one `wallet.health.summary` line and one `wallet.health.finding` line per
  finding. Lines are at error level for HIGH/CRITICAL, warn for MEDIUM, and log for LOW. They
  contain ids only.
- **CLI:** prints the full report as JSON and **exits 3** on any HIGH or CRITICAL finding, so a
  future cron can use it like `billing-integrity-audit`.

**Not activated.** No outbound alert is sent. Billing alerts are log-only by default today, and
the wallet signals use the same log channel. Turning findings into webhook or email alerts is a
later, separately approved step.

## 3. Delivery safety

**Multiple devices.** Each registration gets its own APNs outcome and its own history event:
- a 410 or invalid token prunes that registration;
- a transient failure on any device retries the job and keeps the version undelivered;
- no single device's success counts for the others.

**Duplicate suppression (new).** On a retry, the worker skips a device that APNs already accepted
for this exact version, provided its registration hasn't changed since; a new push token
re-qualifies it.
- The rule relies on the `APNS_ACCEPTED` history. That history is best-effort, so a missing event
  can only cause one extra, harmless notification, never a skipped one.
- Operator pushes from the CLI still notify every device.

**APNs acceptance is not display (new).** The change-list endpoint (`GET …/devices/:id/registrations`)
now records a `SERIALS_LISTED` event, with a device hash, for each pass it returns. The evidence
chain for a device is:
1. APNs 200;
2. `SERIALS_LISTED` from that device;
3. `PASS_RETRIEVED` of the version (Apple's download request carries no device id);
4. visual confirmation, which only a person can give.

`NOT_FETCHED_AFTER_PUSH` and the pass report's `devicesNotFetchedSinceLastPush` name the devices
missing step 2.

Each device is measured from **its own** latest APNs acceptance of the current version, falling
back to the pass's last push only when none is recorded. Measuring every device from the final
push of a retry falsely flagged devices that had fetched right after their own notification; a
test covers that case.

**Pending delivery and restarts (changed).**
- A new **pending-delivery sweep** (every minute, only while APNs is enabled) queues passes whose
  newest version is undelivered. It skips any member who already has a pending or running job, so
  it never pulls a retry forward through its backoff.
- The **first full reconciliation** after a worker starts now runs 5–15 minutes after boot (a
  random delay) instead of at boot. Restarts no longer re-render every pass, and nothing depends on
  that reconciliation: change detection resumes from its durable cursor, and the transition and
  pending-delivery sweeps run at the first tick.
- Tested: a version left pending while APNs was off is delivered by a restarted worker's first
  tick, exactly once.

**Scale (audit).**
- Detection, the sweeps and reconciliation enqueue in statements of 5,000 members.
- Each instance processes 10 jobs every 5 s, about 120 per minute. An unchanged pass costs a render
  and a hash comparison; it is not re-signed.
- About 1,000 dynamic passes reconcile in roughly 8–9 minutes per hour.
- Backlog shows up as `QUEUE_BACKLOG`.

**Retention (fixed).** The daily cleanup deleted at most 1,000 rows per table per day, so heavy
history could outgrow it. It now drains in 1,000-row statements, up to 50 per table per run, and
logs `wallet.refresh.retention_backlog` if it ever stops short. Tested with 2,500 expired rows.

## 4. Automatic transitions

Every case below runs end to end against the real database and the real HTTP or webhook flows. The
pass refreshes through the worker, never through a manual refresh command.

| Scenario | Test |
|---|---|
| Cash renewal | `wallet-refresh-engine` (HTTP cash sale) |
| Cash membership expiration | `wallet-refresh-engine` (transition sweep) |
| Stripe renewal | `wallet-refresh-engine` (signed webhook, after the boundary) |
| Payment failure and recovery | `wallet-refresh-engine` (`past_due` → `active`) |
| Cancellation with remaining entitlement | `wallet-delivery-safety` (stays VIGENTE until the period end, VENCIDA right after) |
| Immediate cancellation | `wallet-delivery-safety` (stops saying VIGENTE on the next refresh) |
| Fixed-duration entitlement expiration | `wallet-refresh-engine` (`entitlementEndsAt`) |
| Multiple simultaneous memberships | `wallet-refresh-engine` |
| Day Pass expiration at studio-local midnight | `wallet-refresh-engine` |
| Scheduled membership activation | `wallet-refresh-engine` |
| Worker restart during pending delivery | `wallet-delivery-safety` |
| Crash in the middle of a multi-device delivery | `wallet-delivery-safety` (no device notified twice) |

**No side effects outside the wallet tables:**
- **Financial data:** checksums of 11 tables (payments, subscriptions, entitlement cycles, day
  passes, credentials, memberships, plans, users, studios, attendances, bookings) are identical
  across full worker cycles.
- **Check-in authorization:** a stale pass that still says VIGENTE does **not** admit a member whose
  entitlement ended. The check-in API denies the scan with `WALLET_MEMBERSHIP_NOT_ENTITLED` before
  and after the pass refreshes, and no attendance is created. Check-in never reads the pass.

## 5. Security and privacy review

| Data | Where it lives | Exposure |
|---|---|---|
| APNs push token | `wallet_pass_registrations.push_token` (needed to send) | Never logged, never in events, diagnostics or health output (only its length). Tests assert its absence |
| Device library identifier | `wallet_pass_registrations` (raw; Apple's protocol looks passes up by it) | Events, logs and reports carry only a SHA-256 prefix. **Residual:** Apple's protocol puts it in URL paths, so the platform's HTTP access logs contain it |
| Pass authentication token | SHA-256 hash in `wallet_pass_artifacts`; the raw value exists only inside the signed `.pkpass` bytes | Never logged or printed; operator tools show 12-hex fingerprints |
| QR (credential) value | Never stored apart from the credential hash; it appears inside the `.pkpass` bytes, as for static passes since Phase 1 | Never logged |
| Error text | Job rows and logs | Runs of 32+ token-like characters are redacted; capped at 300 characters |
| History volume | `wallet_pass_events` | The change-list endpoint is unauthenticated per Apple's protocol, but it is rate-limited (120/min), needs an unguessable registered device id, and writes at most one row per listed pass. Retention 180 days |

## 6. Database: migration `20261016120000_wallet_serials_listed_event` (additive)

**What it does:** `ALTER TYPE "WalletPassEventType" ADD VALUE 'SERIALS_LISTED'`. No table, column
or row changes.

**Simulated on scratch databases:**
- fresh install of 59 migrations, with drift identical to the pre-existing baseline;
- upgrade from the exact Stage 3 schema (what staging runs) with history rows of every type: every
  existing row stays identical;
- the new value is usable after the upgrade;
- a redeploy is a no-op, and the previous build's `migrate deploy` reports no pending migrations.

**Rollback (corrected in Stage 4A.1).**
- **Code only.** The enum value and **every** history row stay; the history is the audit trail.
- **Verified:** the Stage 3 Prisma client throws `Value 'SERIALS_LISTED' not found in enum` when it
  reads *unfiltered* event history.
- In that build only the read-only diagnostics CLI does that. Devices, PassKit routes and the worker
  never read events. Production never ran Stage 3; its rollback target (`e365d2d`) has no event
  model at all.
- To inspect history after rolling back to Stage 3, use type-agnostic read-only SQL
  (`SELECT type::text, … FROM wallet_pass_events …`), or run the diagnostics from a build that knows
  every value.
- **Do not delete `SERIALS_LISTED` rows as a rollback step.** Archiving and then deleting them is a
  last resort, separately approved, after an export. See
  [`SMART_WALLET_2_RELEASE_RUNBOOK.md`](./SMART_WALLET_2_RELEASE_RUNBOOK.md) §5.
- The header comment of the migration file still suggests that `DELETE`. The file is already
  applied on staging, so it is immutable: changing a byte changes its checksum. This section and
  the runbook supersede that comment.

## 7. Verification (local)

- **Unit:** 128 suites, 1,577 tests.
- **End to end:**
  - 50 suites, 591 tests;
  - the new `wallet-delivery-safety.e2e-spec.ts` (12 tests);
  - the retention drain test;
  - all existing wallet, billing and check-in suites.
- **Repeated full-suite runs on the final commit (`24a52b4`):**
  - **10 of 10** runs green: 591/591 each, 5,910 test executions, 0 failures;
  - one more full run under a 1,000-listener stress process: 591/591, 0 interceptions;
  - before the fix, 2 of 12 full runs had one failure. Eleven clean runs alone would not prove the
    fix (the 95 % upper bound on the failure rate is still about 27 %); the 1:1 interception
    evidence above is what does.
- `prisma validate`, `nest build`, lint and typecheck are clean.
