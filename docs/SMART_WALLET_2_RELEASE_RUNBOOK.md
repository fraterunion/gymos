# Smart Wallet 2.0 — production release safety and recovery runbook

Status: **a design and a set of procedures (Stage 4A.1). Nothing here has been applied to
production.** Every step marked **(production change)** needs its own explicit approval,
separately from the merge. Merging to `main` is itself a production release: Railway deploys it
and runs `prisma migrate deploy` against the production database.

> **MERGING TO MAIN WILL APPLY THIS MIGRATION TO PRODUCTION.**
>
> The Smart Wallet branch carries three pending migrations, all additive:
> - `20261013120000_wallet_dynamic_pass_foundation`
> - `20261015120000_wallet_refresh_engine`
> - `20261016120000_wallet_serials_listed_event`

## 1. Current production facts (read-only inspection, 2026-10-16)

| Area | State |
|---|---|
| **Health endpoint** | `GET /health` (outside the `/api/v1` prefix) returns `200 {"status":"ok"}` in about 0.2–0.3 s. It is a liveness check and runs no query. It answers only once the start command's `prisma migrate deploy` has finished and Nest is listening. `PrismaService` connects at boot, so an unreachable database also keeps it from answering. |
| **Railway healthcheck** | **None** on `api`. Without one, Railway marks a deployment active as soon as its container starts. |
| **Start command** | `corepack pnpm --filter api exec prisma migrate deploy && corepack pnpm --filter api start:prod`. Migrations run inside the new container, after the old deployment may already be gone. |
| **Teardown** | Overlap 0 s and draining 0 s: Railway's defaults; no override variables are set. The old deployment gets SIGTERM and then SIGKILL at once. The API has Nest shutdown hooks (`app.enableShutdownHooks()`), but no time to run them. |
| **Wait for CI** | Off on all four production services (`api` trigger `38af5fb0-77ea-4c6f-92a9-37d34a8b54e9`, `billing-integrity-audit` `9edd5951-17da-41a2-afe0-4fadb67fdc5c`, `admin`, `mobile`). A `main` push whose CI had failed was still deployed to `api`: `5e84d2a`, 2026-09-24 (the Day Pass release). A later red push, `032a228`, was docs-only, so the watch paths skipped it. CI (`.github/workflows/ci.yml`) runs on every push and pull request; the latest `main` run (`e365d2d`) is green. |
| **Database** | Neon, PostgreSQL 17.11. `DATABASE_URL` is the **pooled** endpoint (`-pooler`). There is no direct URL, and `schema.prisma` has no `directUrl`. Neon documents that Prisma Migrate requires a direct connection. Production has nevertheless applied 56 migrations through the pooler, with no lock or pooler error in `_prisma_migrations`. |
| **Migration history** | 0 unresolved failed rows. Past failures were all resolved: <br>- **2026-06-23:** four migrations failed with "already exists" (42P07 / 42710); the objects had been created outside migrate, and the migrations were marked applied. <br>- **2026-08-18:** `phase29_data_entitlements` failed twice on NOT NULL violations (23502) against existing data, and was re-applied after a fix. |
| **Pending migrations** | Exactly the three above. <br>- **Collisions:** none of their types, tables, indexes, constraints or columns exist yet. <br>- **Existing rows:** the 68 existing `wallet_pass_artifacts` rows receive defaults (`STATIC`, version 0) and satisfy the new CHECK constraint. <br>- **Backfill:** touches 0 rows. |
| **What a push to `main` deploys** | <br>- `api` redeploys and migrates. <br>- `billing-integrity-audit` rebuilds, because it has no watch paths; its code is unchanged by this branch. <br>- `admin` and `mobile` are skipped. <br>- There is no mobile change, so no OTA is involved. |
| **Restore point** | Not verifiable without Neon access; see §3. |

## 2. Proposed production configuration (production changes, before the release)

Rehearse the same settings on `api-staging` first (a staging change, also approved). Then apply
them to production `api` in a quiet window. Applying service settings can redeploy the current
`main` build (`e365d2d`). That redeploy is a useful canary for the new healthcheck: confirm the
deploy log, then `/health` 200.

### 2.1 Healthcheck — the most important item

- **Path** `/health`. **Timeout:** the default 300 s (`RAILWAY_HEALTHCHECK_TIMEOUT_SEC`) covers
  migrations and boot.
- **Effect:** Railway makes the new deployment active only after a 2xx. A deployment whose
  migration or boot fails never takes traffic, and the previous deployment keeps serving.
- **Readiness semantics:** `/health` passing means the process booted, connected Prisma and is
  listening. It is deliberately not a per-request database probe. Railway checks it only during a
  deploy, and a database blip at that moment should fail the deploy, which booting already does.
  A separate `/health/ready` with `SELECT 1` is optional and not needed for gating.

### 2.2 Migrations as a pre-deploy command, over a direct connection

- **Pre-deploy:** `corepack pnpm --filter api exec prisma migrate deploy`.
- **Start:** `corepack pnpm --filter api start:prod`.
- Railway runs the pre-deploy command after the build and before the new deployment starts. If
  the command fails, it is not retried, the deployment does not proceed, and the previous version
  keeps running.
- While the new schema exists but the new code is not yet live, the previous build runs against
  the new schema. This is verified for `e365d2d` (§5).
- **Direct connection.** Add `DATABASE_URL_UNPOOLED`: Neon's direct endpoint for the same role
  and database (production change). Use it only for migrations:
  `DATABASE_URL="$DATABASE_URL_UNPOOLED" corepack pnpm --filter api exec prisma migrate deploy`.
  The application keeps the pooled URL. The alternative is `directUrl` in `schema.prisma`, which
  is a code change and needs the variable in every environment, including CI and staging. Rehearse
  on staging first: there, both URLs can point at the same database.

### 2.3 Draining and overlap

- **Draining 30 s** (`RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30`). On SIGTERM, Nest closes the HTTP
  server and disconnects Prisma, and the refresh worker stops ticking. A refresh job cut off
  mid-flight stays RUNNING until its lease expires (5 min) and is then recovered. Its writes are
  guarded and idempotent.
- **Overlap** is optional (10–20 s). Both deployments serve briefly; the refresh queue is safe
  across instances. With a healthcheck in place, overlap 0 is acceptable.

### 2.4 Wait for CI

- **Dashboard:** `api` → Settings → Source → **Wait for CI** on. Do the same for
  `billing-integrity-audit`, which rebuilds on every `main` push.
- **API alternative** (what was done for `api-staging`, trigger `7d1cf0b7`):
  `deploymentTriggerUpdate(id: "38af5fb0-77ea-4c6f-92a9-37d34a8b54e9", input: { checkSuites: true })`.
  This does not redeploy.
- **Behaviour:** the deployment waits (`WAITING`) until every GitHub Actions workflow on the commit
  has finished.
  - A failing workflow skips the deployment (`SKIPPED`).
  - Workflows still unfinished after two hours also skip it.
  - CI takes about 9 minutes, so deploys start later.
  - While `main` is red, nothing deploys, which is the intent.
- **Verify (read-only):** query the trigger (`checkSuites: true`). On the next push, the deployment
  shows `WAITING`, then `BUILDING` after CI passes.
- **Fast-forward:** fast-forwarding `main` to a SHA whose CI already passed on the branch makes the
  release commit itself CI-validated. Wait for CI then re-confirms it on `main`.

### 2.5 Order

1. Rehearsal on `api-staging` (staging change).
2. Wait for CI on production `api` and `billing-integrity-audit`. No redeploy.
3. Healthcheck, teardown and pre-deploy migration on production `api`: one redeploy of `e365d2d`.
   Verify it.
4. Restore point (§3), immediately before the release.
5. The release itself: a fast-forward of `main`, with explicit approval.

## 3. Database restore point (Neon) — verification procedure

This uses only the existing provider. Step 3.1 is read-only. Creating a branch (3.3) is a Neon
control-plane change that does not touch production data, but it still needs approval.

1. **History window (read-only).** In the Console: project → Settings → Postgres → **History
   window**.
   - Neon's defaults are 6 h on Free and 1 day on paid plans, configurable up to 7 days (Launch)
     or 30 days (Scale).
   - Require at least 1 day, and record the value.
2. **Baseline** immediately before the merge:
   - record T_pre (UTC);
   - record the read-only preflight: 56 applied migrations, no failed rows, financial and wallet
     checksums, QR integrity.
3. **Named branch at T_pre** from the production branch.
   - Console: Branches → Create branch → past data at T_pre.
   - CLI: `neon branches create --project-id <id> --name pre-sw-release-<YYYYMMDD-HHMM> --parent <T_pre, RFC 3339>`.
     The timestamp form branches from the project's default branch; confirm that is the
     production branch first.
   - A branch keeps its point in time beyond the history window.
4. **Verify the branch (read-only queries against the branch's own connection string):**
   - 56 applied migrations, and none of the three new ones;
   - row counts and checksums equal to the T_pre baseline for `payments`, `subscriptions`,
     `membership_entitlement_cycles`, `day_passes`, `wallet_credentials` and
     `wallet_pass_artifacts`;
   - QR integrity identical.

   Then let the branch's compute suspend.
5. **Record** the branch id, T_pre and the verification result in the release notes.
6. **Restore** (separate explicit approval; last resort):
   `neon branches restore <production-branch> ^self@<T_pre> --preserve-under-name <production-branch>_before_restore_<ts>`,
   or restore from the named branch.
   - This **discards every write after T_pre**: payments, check-ins and bookings. Use it only for
     data corruption.
   - Never use it for a failed migration (its transaction already undid it) or for a code
     rollback.
7. **Delete the branch** only after Phase B has passed, with approval.

## 4. Migration-failure recovery runbook — inspect first, never resolve blindly

**Symptoms.** The deploy log shows `P3018 A migration failed to apply … Migration name: <name>
Database error code: <code>`. Every later `migrate deploy` then fails with `P3009` ("migrate found
failed migrations in the target database"). This includes a redeploy of the previous build, whose
start command also runs `migrate deploy`.

### Step 1 — Restore service without touching the database

- **With §2.1/§2.2 in place:** the release deployment failed and the previous deployment is still
  serving. Confirm with `/health` and the deployment list, then go to step 2.
- **Without them (today):** the API is down.
  - The fastest route that writes nothing to the database is a production change: set the `api`
    start command to `corepack pnpm --filter api start:prod` (no `migrate deploy`) and redeploy
    `beb66b27`.
  - Prisma ran the failed migration in one transaction, so its own objects were rolled back.
    Migrations that finished earlier in the same deploy are additive, and `e365d2d` runs on them
    (§5).
  - Restore the original start command after recovery.

### Step 2 — Collect evidence (read-only)

- The failing migration's name, the database error code and message (deploy log).
- `SELECT migration_name, started_at, finished_at, rolled_back_at, applied_steps_count, logs FROM _prisma_migrations ORDER BY started_at DESC LIMIT 10;`
  Note which of the three migrations finished and which one failed.
- For the failed migration, check every object it creates:
  - tables (`to_regclass('public.<table>')`), types (`pg_type`), indexes (`pg_indexes`),
    constraints (`pg_constraint`), columns (`information_schema.columns`);
  - enum labels (`pg_enum`) for `ADD VALUE`.

  Expect none of them to exist. Verify this; do not assume it.

### Step 3 — Classify

| Class | Typical codes | Meaning |
|---|---|---|
| A. Transient / infrastructure | P1001, P1002 (connection or advisory-lock timeout), 08xxx, 57P01 | Nothing applied; safe to retry once the cause is gone |
| B. Object already exists | 42P07, 42710, 42701 | Schema drift: objects created outside migrate (as on 2026-06-23) |
| C. Data violation | 23502, 23505, 23514, 23503 | Existing rows violate a new constraint (as on 2026-08-18). In these three migrations only the CHECK `wallet_pass_artifacts_dynamic_fields_consistency` validates existing rows. Every production row is STATIC, so it holds |
| D. Lock / timeout | 55P03, 57014 | A long-running transaction blocked the DDL |
| E. Anything else | — | Stop and escalate |

### Step 4 — Decide (each write needs explicit approval at that moment)

- **A or D**, and step 2 shows none of the failed migration's objects:
  1. `prisma migrate resolve --rolled-back <name>`. This writes only the `_prisma_migrations`
     row; run it from a checkout of the release SHA.
  2. Redeploy the same release.
- **B:** compare each existing object with the migration's definition: columns, types, defaults,
  enum labels and their order, index columns, constraint expressions.
  - Only if every object matches exactly: `prisma migrate resolve --applied <name>`, then redeploy.
  - Otherwise do not resolve. Keep service on the previous build and ship a corrected forward
    migration as a new release.
- **C:** do not edit production data ad hoc.
  1. `resolve --rolled-back` only after confirming that no objects remain.
  2. Fix forward with a reviewed data-correction migration, or a revised constraint, in a new
     release.
- **Never:**
  - edit a migration that was applied anywhere;
  - `resolve --applied` without the object-by-object comparison;
  - run `migrate reset` or `db push` against production;
  - restore the database to undo a failed migration.

### Step 5 — Verify after recovery

- `migrate status` (read-only) reports up to date;
- the deploy log shows the migrations applied;
- `/health` returns 200;
- then the Phase B checks of [`SMART_WALLET_2_PRODUCTION_ROLLOUT.md`](./SMART_WALLET_2_PRODUCTION_ROLLOUT.md).

## 5. Code rollback — preserves every audit record

1. If any Wallet flag is on, turn the flags off in this order: APNs, worker, then routes and
   dynamic passes.
2. Redeploy the previous deployment (production: `beb66b27`, which is `e365d2d`).
3. Keep the schema and **every** Smart Wallet row. Do not delete `wallet_pass_events` rows,
   including `SERIALS_LISTED`, as part of a rollback: they are the audit trail.
   - Read them with type-agnostic SQL (`SELECT type::text …`), or with the diagnostics of a build
     that knows every value.
   - The only build that cannot read `SERIALS_LISTED` is Stage 3 (`ed53871`), and only in its
     diagnostics CLI. That matters for staging only; production never ran Stage 3.
   - Archiving and then deleting rows is a last resort, separately approved, after an export.
   - The header comment of migration `20261016120000_wallet_serials_listed_event` suggests a
     `DELETE` after a rollback. That comment predates this policy and is superseded by it. The file
     is applied on staging and must not be edited.

**Verified locally on 2026-10-16.** `e365d2d` ran against a 59-migration database holding
pilot-shaped rows: a DYNAMIC pass with a device registration, `SERIALS_LISTED` and `PASS_RETRIEVED`
history, and a PENDING refresh job. It:
- reported "No pending migrations" from its own `migrate deploy`;
- served both stored passes byte-identical, without rebuilding the dynamic one as static;
- returned the same QR;
- completed front-desk check-in;
- returned 404 from the PassKit routes;
- changed no Smart Wallet row.

The test was run twice: once with the Stage 4A build (`e876500`) creating the state, and once with
the Stage 4A.1 build (`5ea9442`). Both gave the same result.

After a rollback, dynamic passes stop updating but keep working as identity passes with the same
QR.

## 6. Downtime and failure modes — today versus §2 applied

| Scenario | Today | With §2 |
|---|---|---|
| Normal release | Old deployment stops as soon as the new container starts. Requests in flight are cut (no draining), and the new container serves after migrate + boot | The old deployment serves until the new one passes `/health`; 30 s of draining |
| Migration failure | Outage. `P3009` blocks every redeploy, including `beb66b27`, until resolved (§4) | The release fails and the old deployment keeps serving. Later deploys wait for §4 |
| Boot failure (bad environment, database unreachable) | Outage until a rollback | The release fails and the old deployment keeps serving |
| CI red on `main` | Deployed anyway | `SKIPPED` |
