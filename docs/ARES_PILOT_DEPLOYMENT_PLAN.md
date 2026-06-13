# Ares Training Club — first real pilot deployment plan (Phase 8A)

**Execution plan only.** This document does not deploy anything by itself. Operators follow it step-by-step on **Neon**, **Railway**, **Vercel**, **EAS**, and **Stripe test mode** to stand up the first **ARES** white-label pilot.

**Related:** [`PRODUCTION_DEPLOYMENT.md`](./PRODUCTION_DEPLOYMENT.md), [`PRODUCTION_CHECKLIST.md`](./PRODUCTION_CHECKLIST.md), [`ENV_VARS.md`](./ENV_VARS.md), [`DEMO_ENVIRONMENT.md`](./DEMO_ENVIRONMENT.md), [`WHITE_LABEL_BUILDS.md`](./WHITE_LABEL_BUILDS.md), [`STRIPE_TEST_MODE_PILOT.md`](./STRIPE_TEST_MODE_PILOT.md), [`PILOT_RELEASE_FLOW.md`](./PILOT_RELEASE_FLOW.md), [`RELEASE_CANDIDATE_CHECKLIST.md`](./RELEASE_CANDIDATE_CHECKLIST.md), [`PILOT_QA_CHECKLIST.md`](./PILOT_QA_CHECKLIST.md), [`REAL_DEVICE_TESTING.md`](./REAL_DEVICE_TESTING.md).

**Out of scope for this phase:** production `sk_live_`, public App Store / Play **production** tracks, push notifications, automated CI deploys.

---

## 1. Target architecture

| Layer | Host | Role |
|-------|------|------|
| **PostgreSQL** | [Neon](https://neon.tech/) | `DATABASE_URL`; pilot DB isolated from any future production DB. |
| **API** | [Railway](https://railway.app/) | NestJS `apps/api`; secrets; `POST /api/v1/stripe/webhook`. |
| **Admin** | [Vercel](https://vercel.com/) | Next.js `apps/admin`; browser → API only. |
| **Mobile** | [EAS](https://docs.expo.dev/eas/) | **`preview-ares`** profile ([`eas.json`](../apps/mobile/eas.json)); internal / TestFlight / Play internal. |
| **Billing** | Stripe **test mode** | `sk_test_`, test-mode webhook signing secret, test prices as in [`STRIPE_TEST_MODE_PILOT.md`](./STRIPE_TEST_MODE_PILOT.md). |

Data flow: **Mobile / Admin** → HTTPS → **Railway API** → **Neon**; **Stripe** → webhook → **Railway API**.

---

## 2. Required accounts and access

Before day-one deploy, confirm:

| System | Access needed |
|--------|----------------|
| **Neon** | Org/project; ability to create a **new database** (or branch) for this pilot; copy **connection string** with SSL. |
| **Railway** | Project; deploy from repo or container; **Variables** UI; optional custom domain. |
| **Vercel** | Team/project; deploy `apps/admin`; **Environment Variables** per environment (Preview/Production as you name them). |
| **Stripe** | Dashboard in **test mode**; Developers → API keys; Webhooks → add endpoint; (optional) Stripe CLI for local forwarding. |
| **Expo / EAS** | Expo account; `eas login`; EAS project linked to `apps/mobile` ([`WHITE_LABEL_BUILDS.md`](./WHITE_LABEL_BUILDS.md)); permission to run **`eas build`**. |
| **Apple Developer** | If **iOS** pilot: Apple ID with role to upload builds and manage **TestFlight** internal testing. |
| **Google Play Console** | If **Android** pilot: developer account; **internal testing** track; app created with package **`com.fraterunion.aresfitness`** (or your final id—must match EAS env). |

**Manual prerequisite:** Register **bundle id** / **application id** in Apple / Google consoles to match §5 before you rely on store distribution (EAS internal distribution may still proceed for dev devices per Expo docs).

---

## 3. Environment variables by service

Replace placeholders (`https://api.YOUR-PILOT.example`, `https://admin.YOUR-PILOT.example`) with your real Railway / Vercel URLs. **Never** commit secrets to git.

### 3.1 API (Railway)

| Variable | Example / notes |
|----------|-----------------|
| `NODE_ENV` | `production` |
| `PORT` | `3000` (or value Railway injects; align with listen config). |
| `DATABASE_URL` | Neon PostgreSQL URL (`?sslmode=require` as Neon recommends). |
| `JWT_SECRET` | Strong random string (unique to this env). |
| `JWT_QR_SECRET` | Separate strong random string. |
| `JWT_ACCESS_TTL` | e.g. `15m` |
| `JWT_REFRESH_TTL_DAYS` | e.g. `30` |
| `BCRYPT_ROUNDS` | e.g. `12` |
| `CORS_ORIGIN` | Comma-separated origins: **Vercel admin URL** (and `http://localhost:3000` only if you still need local admin against this API). |
| `STRIPE_SECRET_KEY` | **`sk_test_…`** only for this pilot. |
| `STRIPE_WEBHOOK_SECRET` | **`whsec_…`** from Stripe **test** webhook endpoint pointing at your Railway URL (§4.6). |
| `STRIPE_SUCCESS_URL` | `aresfitness://billing/success` |
| `STRIPE_CANCEL_URL` | `aresfitness://billing/cancel` |
| `STRIPE_BILLING_PORTAL_RETURN_URL` | `aresfitness://billing/return` |

Full semantics: [`ENV_VARS.md`](./ENV_VARS.md). Validate shape (non-production): `apps/api` `validateEnv` / boot logs—fix missing required vars before go-live.

### 3.2 Admin (Vercel)

| Variable | Example / notes |
|----------|-----------------|
| `NEXT_PUBLIC_API_URL` | `https://api.YOUR-PILOT.example` — **no** trailing slash required; must match Railway public URL. |

### 3.3 Mobile (EAS / `preview-ares`)

Set as **EAS secrets / environment variables** for the `preview-ares` profile (and mirror in `apps/mobile/env/.env.ares` locally—gitignored—per [`WHITE_LABEL_BUILDS.md`](./WHITE_LABEL_BUILDS.md)).

| Variable | Pilot value (§5) |
|----------|------------------|
| `WHITELABEL_PROFILE` | `ares` (set by `eas.json` for `preview-ares`; confirm not overridden). |
| `EXPO_PUBLIC_API_URL` | Same origin as `NEXT_PUBLIC_API_URL`. |
| `EXPO_PUBLIC_STUDIO_SLUG` | `ares-fitness` |
| `APP_DISPLAY_NAME` | `Ares Training Club` |
| `APP_SCHEME` | `aresfitness` |
| `IOS_BUNDLE_IDENTIFIER` | `com.fraterunion.aresfitness` |
| `ANDROID_PACKAGE` | `com.fraterunion.aresfitness` |
| `APP_ICON_PATH` | Paths relative to `apps/mobile/` (e.g. `./assets/images/icon.png` or brand assets). |
| `APP_SPLASH_PATH` | As above. |
| `APP_ADAPTIVE_ICON_PATH` | As above. |
| `EXPO_SLUG` | Optional; align with Expo project (see [`env/.env.ares.example`](../apps/mobile/env/.env.ares.example)). |

**Note:** Checked-in [`env/.env.ares.example`](../apps/mobile/env/.env.ares.example) may show different bundle ids for a template; **this pilot** uses the identifiers in §5—keep EAS and local `env/.env.ares` consistent.

### 3.4 Stripe webhook (Dashboard + API env)

1. **Endpoint URL:** `https://<RAILWAY_PUBLIC_HOST>/api/v1/stripe/webhook`
2. **Mode:** Test mode.
3. **Events:** per [`STRIPE_TEST_MODE_PILOT.md`](./STRIPE_TEST_MODE_PILOT.md) (e.g. `checkout.session.completed`, subscription and invoice events you support).
4. Copy **signing secret** → Railway `STRIPE_WEBHOOK_SECRET`.

---

## 4. Exact deployment order

Execute in order unless noted.

| # | Step | Actions |
|---|------|---------|
| **4.1** | **Create Neon database** | New project or branch dedicated to ARES pilot; note `DATABASE_URL`. |
| **4.2** | **Set `DATABASE_URL` on Railway** | Add variable; do not expose in client apps. |
| **4.3** | **Deploy API** | Connect repo `apps/api` (or monorepo build command Railway expects); set all §3.1 vars except webhook secret if webhook not created yet. |
| **4.4** | **Run migrations** | From machine with `DATABASE_URL` (or Railway one-off shell): `pnpm --filter api db:migrate:deploy` ([`PRODUCTION_DEPLOYMENT.md`](./PRODUCTION_DEPLOYMENT.md)). |
| **4.5** | **Seed ARES demo** | Same DB context: `pnpm --filter api db:seed` — creates `ares-fitness`, demo users, fake Stripe-shaped rows ([`DEMO_ENVIRONMENT.md`](./DEMO_ENVIRONMENT.md)). **Do not** run `migrate reset` against a shared or production database. |
| **4.6** | **Configure Stripe webhook** | Public Railway URL must be live; register test webhook; set `STRIPE_WEBHOOK_SECRET`. |
| **4.7** | **Run smoke scripts** | §7 — all green before inviting testers. |
| **4.8** | **Deploy admin** | Vercel build for `apps/admin`; `NEXT_PUBLIC_API_URL` → Railway API. |
| **4.9** | **Build mobile preview** | `pnpm --filter mobile exec eas build --profile preview-ares` (from `apps/mobile` or monorepo with correct cwd—see [`WHITE_LABEL_BUILDS.md`](./WHITE_LABEL_BUILDS.md)). |
| **4.10** | **Distribute + real-device QA** | TestFlight internal and/or Play internal; run §8 on **physical devices** ([`REAL_DEVICE_TESTING.md`](./REAL_DEVICE_TESTING.md)). |

Optional but recommended after internal QA: RC git tag per [`RC_TAGGING_GUIDE.md`](./RC_TAGGING_GUIDE.md) (e.g. `rc-pilot-ares-v1`).

---

## 5. ARES white-label env (pilot canonical)

Use these values for **this** first real pilot (EAS + any local `env/.env.ares`):

| Key | Value |
|-----|--------|
| `WHITELABEL_PROFILE` | `ares` |
| `EXPO_PUBLIC_STUDIO_SLUG` | `ares-fitness` |
| `APP_DISPLAY_NAME` | `Ares Training Club` |
| `APP_SCHEME` | `aresfitness` |
| `IOS_BUNDLE_IDENTIFIER` | `com.fraterunion.aresfitness` |
| `ANDROID_PACKAGE` | `com.fraterunion.aresfitness` |

Studio slug **`ares-fitness`** must exist in DB (included in default seed).

---

## 6. Stripe return URLs (API env)

Set on Railway (§3.1):

```text
aresfitness://billing/success
aresfitness://billing/cancel
aresfitness://billing/return
```

They must match **`APP_SCHEME`** (`aresfitness`) and the billing deep-link routes in the mobile app ([`MOBILE.md`](./MOBILE.md)).

---

## 7. Smoke test commands

Run from **monorepo root** with a shell that has the relevant env vars exported (`DATABASE_URL` on host running migrate; `API_BASE_URL` for smokes pointing at **public** Railway URL).

| Goal | Command |
|------|---------|
| Apply migrations | `pnpm --filter api db:migrate:deploy` |
| Health | `API_BASE_URL=https://<your-api-host> pnpm --filter api smoke:health` |
| Auth (seed pilot user) | `API_BASE_URL=… SMOKE_EMAIL=staff@ares.demo SMOKE_PASSWORD='DemoGymOS2026!' pnpm --filter api smoke:auth` — use **injected** secrets in CI; never commit passwords. |
| Stripe env shape (test mode) | Export `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, the three return URLs; then `pnpm --filter api smoke:stripe-env` ([`STRIPE_TEST_MODE_PILOT.md`](./STRIPE_TEST_MODE_PILOT.md)). |

Stripe Dashboard “Send test event” or CLI forwarding: confirm **`POST /api/v1/stripe/webhook`** returns **200** once.

---

## 8. QA checklist (ARES pilot)

Use after mobile build is installable and API/admin are on pilot URLs. Cross-check [`PILOT_QA_CHECKLIST.md`](./PILOT_QA_CHECKLIST.md).

- [ ] **Branding boot** — app opens for `ares-fitness`; colors / name from API; no stuck splash.
- [ ] **Login** — member account (e.g. `member1@ares.demo` / seed password from [`DEMO_ENVIRONMENT.md`](./DEMO_ENVIRONMENT.md)).
- [ ] **Schedule** — classes visible for studio.
- [ ] **Booking** — book and cancel a class.
- [ ] **Waitlist** — join/cancel if applicable to seed data.
- [ ] **QR** — member QR displays; token policy acceptable for pilot.
- [ ] **Staff desk** — `staff@ares.demo` on admin: today’s schedule, class workspace, manual check-in / QR paste path ([`ADMIN.md`](./ADMIN.md)).
- [ ] **Membership** — screen loads; if using **fake seed** Stripe ids only, expect UI without real Checkout; if **test mode** wired, continue with Checkout test.
- [ ] **Stripe test checkout** — complete or cancel test payment without 500; membership updates after webhook path if applicable.
- [ ] **Return deep link** — after Checkout / portal, app returns via `aresfitness://billing/…` without dead-end.

---

## 9. Go / no-go checklist

| Criterion | Go | No-go |
|-----------|-----|--------|
| Migrations + seed | Applied; ARES data visible | Errors or wrong DB |
| `smoke:health` | Exit 0 | Fail |
| `smoke:auth` | Exit 0 with pilot credentials | Fail |
| Stripe lane | Test mode keys + webhook **200** OR explicit **fake-seed-only** demo (no live keys) | Ambiguous or `sk_live_` |
| CORS / admin | Admin loads against API | CORS or 401 loop |
| Mobile | `preview-ares` build installs; §8 critical paths pass | Blocker bugs |
| Rollback | Prior build / redeploy owner known ([`ROLLBACK_RUNBOOK.md`](./ROLLBACK_RUNBOOK.md)) | Unknown |

**Decision:** Go / No-go — **Date:** ______ — **Approver:** ______

---

## 10. Known limitations (communicate to stakeholders)

- **No push notifications** — reminders and marketing pushes are out of scope.
- **No camera-based QR scanner in product** — desk flow uses manual / paste paths as documented; member shows QR from phone.
- **Fake / demo seed billing** — unless Stripe **test mode** is fully wired with real test prices and webhooks, Stripe rows are placeholders; see [`DEMO_ENVIRONMENT.md`](./DEMO_ENVIRONMENT.md) vs [`STRIPE_TEST_MODE_PILOT.md`](./STRIPE_TEST_MODE_PILOT.md).
- **No production store release** — preview / internal tracks only; no `sk_live_` pilot on this plan.

---

## Demo accounts (seeded)

Password for seeded demo users: **`DemoGymOS2026!`** (public; pilot DB must be access-controlled). Key emails: `staff@ares.demo`, `member1@ares.demo`, `admin@ares.demo` — full table in [`DEMO_ENVIRONMENT.md`](./DEMO_ENVIRONMENT.md).

---

## Suggested `config:print` (before EAS build)

```bash
WHITELABEL_PROFILE=ares pnpm --filter mobile config:print
```

Confirm `scheme`, bundle id, package, and API URL match §5–6.
