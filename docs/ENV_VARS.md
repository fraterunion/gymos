# Environment variables

## Principles

- **Secrets never ship to admin or mobile bundles.** Browser and Expo clients receive only public config (e.g. API base URL, publishable keys if any).
- **API** holds database URL, JWT signing secrets, Stripe secret key, and webhook signing secrets.
- **Admin** and **mobile** use `NEXT_PUBLIC_*` / Expo `EXPO_PUBLIC_*` only where values are intentionally public.

## apps/api (server)

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection URL for Prisma (`apps/api`). Required; the API fails fast at startup if unset. |
| `JWT_SECRET` | Signs access JWTs (Phase 1B). Required; the API fails fast at startup if unset. |
| `JWT_QR_SECRET` | Signs short-lived QR / check-in JWTs; separate from user access tokens. Required. |
| `JWT_ACCESS_TTL` | Access token lifetime (e.g. `15m`). Parsed in `apps/api` for Nest `JwtModule`. |
| `JWT_REFRESH_TTL_DAYS` | Refresh token row lifetime (opaque tokens stored hashed in DB; rotation + reuse detection). |
| `CORS_ORIGIN` | Comma-separated allowed browser origins for the API (explicit CORS in `http-app.setup.ts`). |
| `BCRYPT_ROUNDS` | Cost factor for password hashing (integer; validated in `validateEnv`). |
| `PORT` | HTTP listen port (from config; default in `.env.example` is `3000`). |
| `STRIPE_SECRET_KEY` | Stripe **secret** API key (server only; test vs live mode per key prefix). Required in **production**. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for `POST /api/v1/stripe/webhook` (`whsec_…`). Required in **production**. |
| `STRIPE_SUCCESS_URL` | Absolute URL Stripe Checkout redirects to after a successful payment. Required in **production**. For the **native member app**, set this to a URL that opens your app’s **billing success** route (same **URL scheme** as `expo.scheme` in the mobile app config, e.g. `<your-scheme>://billing/success`). **Do not** embed a specific gym’s brand name in the scheme; each white-label build supplies its own scheme. For **web** or server-hosted fallbacks, use an `https://` URL. Local API defaults use `http://localhost:…` (see `validate-env`). |
| `STRIPE_CANCEL_URL` | Absolute URL when the customer abandons Checkout. Same rules as success; native pattern: `<your-scheme>://billing/cancel`. |
| `STRIPE_BILLING_PORTAL_RETURN_URL` | Absolute URL when the customer leaves the Stripe Customer Portal. Native pattern: `<your-scheme>://billing/return`. |

Non-production: `apps/api` `validateEnv` supplies safe **development defaults** when these are unset so local and CI boot without real Stripe keys; replace with your Dashboard keys and real URLs before charging customers. For **mobile E2E against a device or simulator**, point the three URLs at your app’s deep links (see `docs/MOBILE.md` Phase 4C and `apps/mobile/lib/billing/stripeReturnUrlHelpers.ts`).

### Stripe test-mode pilot (Phase 7A)

For **real** test Checkout, Customer Portal, and webhooks ( **`sk_test_`**, **`whsec_`** from a **test** endpoint or Stripe CLI), see [`STRIPE_TEST_MODE_PILOT.md`](./STRIPE_TEST_MODE_PILOT.md). Quick env shape check (no secrets printed): `pnpm --filter api smoke:stripe-env` from a shell where the Stripe variables are exported.

### Smart Wallet 2.0 (Stage 1A, all OFF by default)

Dynamic Apple Wallet passes and the PassKit web service. Every flag is normalised by `validateEnv` to `'true'` / `'false'`; only the exact word `true` enables it. See [`SMART_WALLET_2_STAGE_1A.md`](./SMART_WALLET_2_STAGE_1A.md).

| Variable | Purpose |
|----------|---------|
| `WALLET_DYNAMIC_PASSES_ENABLED` | Allows building/enrolling DYNAMIC Apple passes (operator CLI only in Stage 1A). Default `false`. |
| `WALLET_PASSKIT_ROUTES_ENABLED` | Serves the PassKit web service under `/api/v1/wallet/passkit/v1/...`. When `false` every route answers 404. Default `false`. |
| `WALLET_APNS_ENABLED` | Allows APNs pass-update pushes (production APNs only, with the pass-signing certificate). Default `false`. |
| `WALLET_PASSKIT_WEB_SERVICE_URL` | `webServiceURL` signed into every dynamic pass. Required when dynamic passes or the routes are on. Absolute, no credentials/query/fragment, must end with `/api/v1/wallet/passkit`; `https` required in production. |
| `WALLET_REFRESH_WORKER_ENABLED` | Stage 3: starts the automatic refresh worker inside the API process (change detection, transition sweep, pending-delivery sweep while APNs is on, hourly reconciliation, retention, certificate-expiry check, health evaluation every 15 min). Requires `WALLET_DYNAMIC_PASSES_ENABLED=true` (the API refuses to boot otherwise). Does not imply pushes: those still need `WALLET_APNS_ENABLED=true`. Default `false`. See [`SMART_WALLET_2_STAGE_3.md`](./SMART_WALLET_2_STAGE_3.md). |

Any of these flags on also requires the full `WALLET_APPLE_*` signing configuration; the API refuses to boot otherwise.

### Email and Communications campaigns

| Variable | Purpose |
|----------|---------|
| `RESEND_API_KEY` | Resend API key. Without it the API uses a logging provider that delivers nothing (campaign rows end `SKIPPED`). Required in production when `PASSWORD_RECOVERY_ENABLED=true`. |
| `EMAIL_FROM_ADDRESS` | Sender address on a Resend-verified domain (default `no-reply@gymos.app`). |
| `EMAIL_CAMPAIGN_WORKER` | Campaign delivery worker inside the API process. **On unless exactly `0`.** Set `0` before deploying campaigns to an environment and until an internal delivery test passes. Setting `0` pauses (rows stay `PENDING` and resume when re-enabled); it does not cancel. |
| `EMAIL_UNSUBSCRIBE_URL_BASE` | Public HTTPS **origin** of the API (no path, e.g. `https://api.example.com`) used in campaign unsubscribe links and `List-Unsubscribe` headers (`/api/v1/email/unsubscribe`). Required to confirm a campaign; there is no fallback. |
| `EMAIL_CAMPAIGN_SEND_DELAY_MS` | Delay between campaign sends within a worker tick (default `200`). |

Future (document when implemented):

- `REDIS_URL` — if caching or rate limits require it.

See `apps/api/.env.example` for the minimal placeholder set checked into the repo.

## apps/admin (Next.js)

Expected patterns once auth and API URL exist:

- `NEXT_PUBLIC_API_URL` — Base URL for browser calls to `apps/api`.
- Server-side only vars for session encryption or OAuth client secrets (never `NEXT_PUBLIC_*`).

## apps/mobile (Expo)

| Variable | Purpose |
|----------|---------|
| `EXPO_PUBLIC_API_URL` | Base URL for native client (Metro bundle). |
| `EXPO_PUBLIC_STUDIO_SLUG` | Tenant slug for branding fetch + `me/studios` match. |

### Build-time native identity (`apps/mobile`, Expo config)

These are read by **`app.config.js`** when Expo resolves the config (not inlined by Metro unless also prefixed with `EXPO_PUBLIC_`). Use `apps/mobile/env/.env.<WHITELABEL_PROFILE>` — see **`docs/WHITE_LABEL_BUILDS.md`**.

**Precedence:** explicit `process.env` (shell / EAS / CI) → `env/.env.<profile>` → root `apps/mobile/.env` (fill-only; never overwrites). Client profiles fail if the resolved API URL is loopback or the studio slug is a QA demo slug (`pnpm --filter mobile config:verify:ares`).

| Variable | Purpose |
|----------|---------|
| `WHITELABEL_PROFILE` | Selects `env/.env.<profile>` (default **`local`** = template-safe native defaults for dev only). |
| `APP_DISPLAY_NAME` | Native app display name (home screen, task switcher). **Required** for non-`local` profiles. |
| `APP_SCHEME` | URL scheme for deep links; must align with API Stripe return URLs. **Required** for non-`local` profiles. |
| `IOS_BUNDLE_IDENTIFIER` | iOS bundle id. **Required** for non-`local` profiles; must be unique per client. |
| `ANDROID_PACKAGE` | Android application id. **Required** for non-`local` profiles; must be unique per client. |
| `APP_ICON_PATH` | App icon path relative to `apps/mobile/`. **Required** for non-`local` profiles. |
| `APP_SPLASH_PATH` | Splash image path relative to `apps/mobile/`. **Required** for non-`local` profiles. |
| `APP_ADAPTIVE_ICON_PATH` | Android adaptive icon foreground path relative to `apps/mobile/`. **Required** for non-`local` profiles. |
| `EXPO_SLUG` | Expo project slug (optional; defaults for `local` only). |

**EAS:** `apps/mobile/eas.json` defines build profiles and per-profile `WHITELABEL_PROFILE`. Other variables for cloud builds must be set as **EAS Environment variables / secrets** (see `docs/WHITE_LABEL_BUILDS.md`).

**Stripe return URLs (server-side, not Expo env):** The API’s `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL`, and `STRIPE_BILLING_PORTAL_RETURN_URL` must match how users return from Stripe. For native builds, that is typically `<APP_SCHEME>://billing/success` (and `cancel` / `return`) where **`APP_SCHEME`** is set for that client in `apps/mobile/env/.env.<profile>` (resolved via **`app.config.ts`**). Use `stripeMobileReturnUrlsFromExpoLinking()` from `apps/mobile/lib/billing/stripeReturnUrlHelpers.ts` in a dev build to log the exact strings for your environment.

**Client launch:** cross-platform checklist and store listing worksheet: [`CLIENT_LAUNCH_CHECKLIST.md`](./CLIENT_LAUNCH_CHECKLIST.md), [`STORE_METADATA_TEMPLATE.md`](./STORE_METADATA_TEMPLATE.md).

## Production & pilot (Phase 6A)

Reference hosts (**Railway / Neon / Vercel / EAS / Stripe**) and runbooks: [`PRODUCTION_DEPLOYMENT.md`](./PRODUCTION_DEPLOYMENT.md), [`PRODUCTION_CHECKLIST.md`](./PRODUCTION_CHECKLIST.md), [`ROLLBACK_RUNBOOK.md`](./ROLLBACK_RUNBOOK.md), [`REAL_DEVICE_TESTING.md`](./REAL_DEVICE_TESTING.md). **Pilot RC:** [`RELEASE_CANDIDATE_CHECKLIST.md`](./RELEASE_CANDIDATE_CHECKLIST.md), [`PILOT_RELEASE_FLOW.md`](./PILOT_RELEASE_FLOW.md). **RC tags & retro:** [`RC_TAGGING_GUIDE.md`](./RC_TAGGING_GUIDE.md), [`PILOT_RETRO_TEMPLATE.md`](./PILOT_RETRO_TEMPLATE.md).

**Local / private pilot data:** [`DEMO_ENVIRONMENT.md`](./DEMO_ENVIRONMENT.md) (Prisma seed, demo password, reset notes).

## Ops scripts & smoke env (Phase 6B)

These variables are for **operators / CI** running `apps/api` smoke scripts from a shell — **not** required for the Nest process at runtime unless you invoke those scripts on the same host.

| Variable | Used by | Purpose |
|----------|---------|---------|
| `API_BASE_URL` | `pnpm --filter api smoke:health`, `smoke:auth` | Public API origin (e.g. `https://api.example.com`). No trailing slash required. |
| `SMOKE_EMAIL` | `smoke:auth` | Pilot user email (inject via secrets; never commit). |
| `SMOKE_PASSWORD` | `smoke:auth` | Pilot user password (inject via secrets; never commit). |

**API runtime (unchanged):** `DATABASE_URL`, JWT, Stripe, etc. — see table above.

**Future:** `SENTRY_DSN` — optional Sentry DSN for the API when you add `@sentry/node` (or similar); not read by the app today. Define retention/PII policy before enabling.

## Local development

- Copy `apps/api/.env.example` to `.env` (gitignored) and fill placeholders locally.
- Do not commit real secrets. CI should inject secrets from a vault or hosted secrets store.
