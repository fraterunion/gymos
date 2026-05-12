# Production deployment (pilot foundation)

This document describes a **concrete** reference layout for deploying GymOS to managed hosts: **API on Railway**, **PostgreSQL on Neon**, **Admin on Vercel**, **Mobile via EAS**, **Stripe webhooks** to the API. Swap host names for your org if you self-host elsewhere—the **ordering and env contracts** still apply.

**Related:** [`ENV_VARS.md`](./ENV_VARS.md), [`PRODUCTION_CHECKLIST.md`](./PRODUCTION_CHECKLIST.md), [`ROLLBACK_RUNBOOK.md`](./ROLLBACK_RUNBOOK.md), [`WHITE_LABEL_BUILDS.md`](./WHITE_LABEL_BUILDS.md), [`ARCHITECTURE.md`](./ARCHITECTURE.md).

**Phase 6B (ops scripts):** `apps/api` exposes `db:migrate:deploy`, `db:generate`, `smoke:health`, and optional `smoke:auth` — see [Deploy scripts & smoke checks](#deploy-scripts--smoke-checks-phase-6b) below.

---

## Deployment targets (reference)

| Tier | Service | Role |
|------|---------|------|
| **API** | [Railway](https://railway.app/) | Runs NestJS `apps/api`; holds secrets; exposes HTTPS. |
| **DB** | [Neon](https://neon.tech/) PostgreSQL | `DATABASE_URL`; SSL; optional branches for preview DBs. |
| **Admin** | [Vercel](https://vercel.com/) | Next.js `apps/admin`; browser → API only. |
| **Mobile** | [EAS](https://docs.expo.dev/eas/) | Native builds from `apps/mobile` ([`WHITE_LABEL_BUILDS.md`](./WHITE_LABEL_BUILDS.md)). |
| **Stripe** | Stripe Dashboard | Webhooks → API `POST /api/v1/stripe/webhook`. |

---

## Environment matrix (where each variable lives)

| Variable / concern | API (Railway) | Neon | Admin (Vercel) | Mobile (EAS) | Stripe Dashboard |
|-------------------|---------------|------|------------------|----------------|-------------------|
| `DATABASE_URL` | ✓ (from Neon) | ✓ source | — | — | — |
| `JWT_SECRET`, `JWT_QR_SECRET`, JWT TTLs | ✓ | — | — | — | — |
| `CORS_ORIGIN` | ✓ (include **Vercel admin origin(s)**) | — | — | — | — |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | ✓ | — | — | — | signing secret from webhook endpoint |
| `STRIPE_SUCCESS_URL` / `CANCEL` / `BILLING_PORTAL_RETURN_URL` | ✓ | — | — | align with **mobile scheme** | — |
| `EXPO_PUBLIC_*`, `APP_*`, `WHITELABEL_PROFILE` | — | — | — | ✓ EAS env / secrets | — |
| `NEXT_PUBLIC_API_URL` | — | — | ✓ | — | — |
| Webhook URL | public API host | — | — | — | `https://<api-host>/api/v1/stripe/webhook` |

**Principle:** secrets never in Vercel/mobile bundles except intentionally public `NEXT_PUBLIC_*` / `EXPO_PUBLIC_*` ([`ENV_VARS.md`](./ENV_VARS.md)).

---

## Health check

- **URL:** `GET https://<api-public-host>/health`  
- **Response:** `{ "status": "ok" }` (outside global prefix `api/v1`; see `apps/api/src/app.controller.ts` + `http-app.setup.ts`).  
- **Use:** load balancers, Railway health checks, smoke after deploy.

---

## Deployment order (recommended)

1. **Neon** — Create database (prod). Note **connection string** (`DATABASE_URL` with `sslmode=require` as Neon recommends). Optional: create **preview branch** DB for staging.
2. **API (Railway)** — Create service from repo; root directory `apps/api` (or monorepo build command you use); set **all** API env vars (below). **Do not** start traffic until migrations succeed.
3. **Migrations** — From CI or a trusted operator machine with `DATABASE_URL` pointed at **that** Neon DB:  
   **From repo root:** `pnpm --filter api db:migrate:deploy`  
   **Or** from `apps/api`: `pnpm db:migrate:deploy` (runs `prisma migrate deploy`).  
   Uses committed migrations under `apps/api/prisma/migrations`. Run **before** the new API revision serves traffic that depends on the new schema (or in the same release window with zero-downtime discipline).
4. **Smoke API** — `pnpm --filter api smoke:health` with `API_BASE_URL=https://<api-public-host>`; optional `pnpm --filter api smoke:auth` with pilot `SMOKE_EMAIL` / `SMOKE_PASSWORD` (see [Deploy scripts & smoke checks](#deploy-scripts--smoke-checks-phase-6b)). Manual `POST /api/v1/auth/login` remains valid.
5. **Stripe** — Create **live** webhook endpoint → same URL as table above; set `STRIPE_WEBHOOK_SECRET` on API; run **Send test webhook** from Dashboard.
6. **CORS** — Set `CORS_ORIGIN` on API to include `https://<admin>.vercel.app` (add `http://localhost:<admin-dev-port>` only for local dev, not prod).
7. **Admin (Vercel)** — Deploy `apps/admin`; set `NEXT_PUBLIC_API_URL=https://<api-public-host>`; verify login in browser.
8. **Mobile (EAS)** — Configure EAS secrets to mirror production `env` ([`WHITE_LABEL_BUILDS.md`](./WHITE_LABEL_BUILDS.md)); build **preview** profile first; then **production** when checklist green ([`PRODUCTION_CHECKLIST.md`](./PRODUCTION_CHECKLIST.md)).

---

## Railway (API) — env vars checklist

Set in Railway **Variables** (same names as [`ENV_VARS.md`](./ENV_VARS.md) § apps/api):

- `NODE_ENV=production`
- `DATABASE_URL` — Neon connection string
- `JWT_SECRET`, `JWT_QR_SECRET`, `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL_DAYS`
- `BCRYPT_ROUNDS`
- `PORT` — Railway usually injects `PORT`; align Nest listen (default `3000` in code if unset)
- `CORS_ORIGIN` — comma-separated origins (**Vercel admin** required)
- `STRIPE_SECRET_KEY` (live), `STRIPE_WEBHOOK_SECRET`, `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL`, `STRIPE_BILLING_PORTAL_RETURN_URL`

**Build/start (typical):** install workspace deps or use Nixpacks/Dockerfile you maintain; run `pnpm --filter api build` then `pnpm --filter api start` or `node apps/api/dist/main.js` depending on your artifact layout.

---

## Neon (PostgreSQL)

- Use Neon’s **pooled** connection string for serverless-friendly pools if Railway recommends it; otherwise direct.  
- **Backups:** enable Neon backup / PITR per Neon plan; document RPO/RTO in your ops runbook ([`ROLLBACK_RUNBOOK.md`](./ROLLBACK_RUNBOOK.md)).  
- **Rotate `DATABASE_URL`** in Railway if credentials rotate; restart API.

---

## Vercel (Admin)

- **Root:** `apps/admin` (or monorepo turbo build with output).  
- **Env:** `NEXT_PUBLIC_API_URL=https://<api-public-host>` (no trailing slash per your client conventions).  
- **Preview deployments:** each preview URL must appear in API `CORS_ORIGIN` **or** use a single staging admin URL policy.

---

## Mobile (EAS)

See [`WHITE_LABEL_BUILDS.md`](./WHITE_LABEL_BUILDS.md) — EAS **secrets** must mirror `app.config.ts` + `EXPO_PUBLIC_*`. **Stripe return URLs** on the API must match **production** `APP_SCHEME`.

---

## Stripe webhook (production)

- **Endpoint URL:** `https://<api-public-host>/api/v1/stripe/webhook`  
- **Raw body:** API uses `express.raw` for this path only; do not put a proxy that re-serializes JSON between Stripe and Nest.  
- **Events:** at minimum those documented in [`API_CONTRACTS.md`](./API_CONTRACTS.md) / architecture (checkout, subscription lifecycle, invoices).  
- **Idempotency:** handled in API; still avoid duplicate endpoints in Stripe for the same mode.

---

## Database migrations (runbook)

| Step | Action |
|------|--------|
| 1 | Freeze writes (optional) or announce maintenance if breaking migration. |
| 2 | **Backup** Neon (manual snapshot or automated) before `migrate deploy`. |
| 3 | Run `pnpm --filter api db:migrate:deploy` (or `cd apps/api && pnpm db:migrate:deploy`) with **`DATABASE_URL`** for **target** DB. |
| 4 | Verify with `pnpm --filter api smoke:health` (`API_BASE_URL=…`) and optional `smoke:auth`, or manual `GET /health` + login. |
| 5 | If app expects new columns, deploy **API** that contains new code **after** migration succeeds (or same window with zero-downtime discipline). |

**Rollback:** Prisma does not auto-downgrade production. See [`ROLLBACK_RUNBOOK.md`](./ROLLBACK_RUNBOOK.md).

---

## CORS (`CORS_ORIGIN`)

`apps/api` reads comma-separated origins (`http-app.setup.ts`). **Production** must list every browser origin that calls the API with credentials:

- Vercel production admin: `https://your-admin.vercel.app`
- Optional: separate staging admin URL

Omit wildcards unless you fully understand browser credential rules.

---

## Deploy scripts & smoke checks (Phase 6B)

| Script | When | Notes |
|--------|------|--------|
| `pnpm --filter api db:generate` | After dependency / Prisma schema changes locally or in CI build | `prisma generate`; `api` `build` already runs generate. |
| `pnpm --filter api db:migrate:deploy` | **Before** or **with** each production API rollout that needs new DB schema | Requires `DATABASE_URL` in the environment of the shell or CI job (Neon URL). |
| `pnpm --filter api smoke:health` | After Railway (or any) deploy, in CI release step, or manually | Set `API_BASE_URL` to the public API origin (no trailing slash required). Exits **0** if `GET /health` returns `{ "status": "ok" }`, else **1**. |
| `pnpm --filter api smoke:auth` | Optional; when a disposable pilot user exists | Set `API_BASE_URL`, `SMOKE_EMAIL`, `SMOKE_PASSWORD`. Exits **0** if login + `GET /api/v1/auth/me` succeed. **Never** commit real credentials; inject via CI secrets or local env only. |

**Railway deployment smoke flow (typical):**

1. Run `db:migrate:deploy` in a release phase or one-off job with production `DATABASE_URL` (many teams run this **before** `railway up` / redeploy).
2. Deploy the API service.
3. In the same pipeline or manually: `API_BASE_URL=https://<your-railway-host> pnpm --filter api smoke:health`.
4. Optionally: set `SMOKE_*` from secrets and run `smoke:auth`.

If `API_BASE_URL` is unset or the host is down, `smoke:health` exits **1** with a short message (no stack traces with secrets).

**Admin (Vercel) smoke:** these Node scripts only hit the **API**. The admin app still needs a **manual** browser check (login, CORS) as in [`PRODUCTION_CHECKLIST.md`](./PRODUCTION_CHECKLIST.md) — Vercel does not run `smoke:health` unless you add a CI workflow that invokes it against your deployed API.

---

## Logging & errors (Phase 6B)

- **Startup:** the API logs a single human-readable line and one **JSON** line (`event: api_started`, `env`, `port`, `healthPath`, `apiPrefix`) — **no** secrets, tokens, or Stripe keys.  
- **Runtime:** unhandled exceptions return JSON error responses; do **not** log **passwords**, **refresh tokens**, **Stripe signing secrets**, or **full JWTs** in request/response logs.  
- **Railway:** stdout/stderr; alert on **5xx rate** or health check failures.  
- **Stripe Dashboard:** webhook delivery tab for 4xx/5xx from the API URL.

**Future (not wired in code):** optional error tracking via `SENTRY_DSN` on the API — see [`ENV_VARS.md`](./ENV_VARS.md). Prefer adding `@sentry/node` only when you want release tracking and PII policies defined.

---

## Minimal “go live” doc set

| Doc | Use |
|-----|-----|
| [`PRODUCTION_CHECKLIST.md`](./PRODUCTION_CHECKLIST.md) | Pre-flight + post-deploy ticks |
| [`ROLLBACK_RUNBOOK.md`](./ROLLBACK_RUNBOOK.md) | When something breaks |
| [`REAL_DEVICE_TESTING.md`](./REAL_DEVICE_TESTING.md) | Pilot QA on phones |
| [`CLIENT_LAUNCH_CHECKLIST.md`](./CLIENT_LAUNCH_CHECKLIST.md) | White-label store + ops |
