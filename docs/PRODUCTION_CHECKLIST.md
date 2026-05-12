# Production checklist (pre-flight & post-deploy)

**Demo data:** never use [`DEMO_ENVIRONMENT.md`](./DEMO_ENVIRONMENT.md) accounts, passwords, or fake Stripe IDs on a **public production** API or shared live database. Pilot demos belong on private hosts or VPN-scoped envs.

Use for **staging** and **production** cutovers. Complement with [`PRODUCTION_DEPLOYMENT.md`](./PRODUCTION_DEPLOYMENT.md), [`ROLLBACK_RUNBOOK.md`](./ROLLBACK_RUNBOOK.md), and [`REAL_DEVICE_TESTING.md`](./REAL_DEVICE_TESTING.md).

---

## A. Environment & config

- [ ] **API env vars present** — `DATABASE_URL`, JWT secrets/TTLs, `CORS_ORIGIN`, `BCRYPT_ROUNDS`, `PORT`, Stripe keys + URLs ([`ENV_VARS.md`](./ENV_VARS.md)).
- [ ] **Admin `NEXT_PUBLIC_API_URL`** — points at correct API host (staging vs prod).
- [ ] **Mobile EAS secrets** — mirror `EXPO_PUBLIC_*`, `APP_*`, `WHITELABEL_PROFILE` ([`WHITE_LABEL_BUILDS.md`](./WHITE_LABEL_BUILDS.md)).
- [ ] **Neon `DATABASE_URL`** — SSL mode appropriate; not committed to git.

---

## B. Database

- [ ] **Migrations applied** — `pnpm --filter api db:migrate:deploy` (from monorepo root) or `pnpm db:migrate:deploy` from `apps/api`, against target DB **before** or **with** API rollout ([`PRODUCTION_DEPLOYMENT.md`](./PRODUCTION_DEPLOYMENT.md)).
- [ ] **Backup** taken (or verified auto-backup) before risky migration.

---

## C. API health & auth

- [ ] **`smoke:health`** — `API_BASE_URL=https://<api-host> pnpm --filter api smoke:health` exits **0** (or manual `GET /health` → `200` + `{ "status": "ok" }`).
- [ ] **Optional `smoke:auth`** — `API_BASE_URL`, `SMOKE_EMAIL`, `SMOKE_PASSWORD` set; `pnpm --filter api smoke:auth` exits **0** (pilot user only; never commit credentials).
- [ ] **Auth smoke (manual)** — `POST /api/v1/auth/login`; `GET /api/v1/auth/me` with bearer token if not using `smoke:auth`.
- [ ] **CORS** — browser admin login succeeds (no CORS console errors). **Vercel admin** is not covered by API smoke scripts — confirm in browser after deploy.

---

## D. Stripe (live when appropriate)

- [ ] **Webhook endpoint** — `https://<api>/api/v1/stripe/webhook` registered; **live** signing secret matches `STRIPE_WEBHOOK_SECRET`.
- [ ] **Webhook smoke** — Dashboard “Send test event” (or test mode first on staging) returns **200**; check API logs for idempotent handling.
- [ ] **Checkout smoke** — member **Subscribe** completes or cancels without 500; **success/cancel URLs** match mobile scheme ([`MOBILE.md`](./MOBILE.md)).
- [ ] **Billing portal** — opens and returns; API has `User.stripeCustomerId` when expected.

---

## E. Mobile (member)

- [ ] **Branding boot** — public branding loads for slug.
- [ ] **Login** — pilot member; schedule visible.
- [ ] **Booking** — book + cancel path.
- [ ] **Waitlist** — join/cancel as applicable.
- [ ] **QR** — token displays in window; attendance path works.
- [ ] **TestFlight / internal track** — build distributed to pilot group.

---

## F. Admin (staff desk)

- [ ] **Login** — staff user with role for target studio.
- [ ] **Staff desk check-in** — class workspace loads; **manual check-in** works.
- [ ] **QR paste** — paste member QR payload from device; API accepts within policy.

---

## G. Post-deploy monitoring (first 24–48h)

- [ ] **API logs** — Railway (or host) shows `api_started` / listen line after deploy; **no** passwords, tokens, or Stripe secrets in stdout rules enforced ([`PRODUCTION_DEPLOYMENT.md`](./PRODUCTION_DEPLOYMENT.md) § Logging).
- [ ] **Error rate** — no spike in 5xx.
- [ ] **Stripe webhook delivery** — no sustained 4xx/5xx from API URL.
- [ ] **Support inbox** — pilot channel monitored.

---

## Sign-off

- [ ] Owner name + date + environment (staging/prod) recorded.
- [ ] Rollback owner identified ([`ROLLBACK_RUNBOOK.md`](./ROLLBACK_RUNBOOK.md)).
