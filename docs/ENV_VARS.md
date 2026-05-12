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
| `CORS_ORIGIN` | Comma-separated allowed browser origins for the API (explicit CORS in `main.ts`). |
| `BCRYPT_ROUNDS` | Cost factor for password hashing (integer; validated in `validateEnv`). |
| `PORT` | HTTP listen port (from config; default in `.env.example` is `3000`). |
| `STRIPE_SECRET_KEY` | Stripe **secret** API key (server only; test vs live mode per key prefix). Required in **production**. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for `POST /api/v1/stripe/webhook` (`whsec_…`). Required in **production**. |
| `STRIPE_SUCCESS_URL` | Absolute URL Stripe Checkout redirects to after a successful payment. Required in **production**. For the **native member app**, set this to a URL that opens your app’s **billing success** route (same **URL scheme** as `expo.scheme` in the mobile app config, e.g. `<your-scheme>://billing/success`). **Do not** embed a specific gym’s brand name in the scheme; each white-label build supplies its own scheme. For **web** or server-hosted fallbacks, use an `https://` URL. Local API defaults use `http://localhost:…` (see `validate-env`). |
| `STRIPE_CANCEL_URL` | Absolute URL when the customer abandons Checkout. Same rules as success; native pattern: `<your-scheme>://billing/cancel`. |
| `STRIPE_BILLING_PORTAL_RETURN_URL` | Absolute URL when the customer leaves the Stripe Customer Portal. Native pattern: `<your-scheme>://billing/return`. |

Non-production: `apps/api` `validateEnv` supplies safe **development defaults** when these are unset so local and CI boot without real Stripe keys; replace with your Dashboard keys and real URLs before charging customers. For **mobile E2E against a device or simulator**, point the three URLs at your app’s deep links (see `docs/MOBILE.md` Phase 4C and `apps/mobile/lib/billing/stripeReturnUrlHelpers.ts`).

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

These are read by **`app.config.ts`** when Expo resolves the config (not inlined by Metro unless also prefixed with `EXPO_PUBLIC_`). Use `apps/mobile/env/.env.<WHITELABEL_PROFILE>` — see **`docs/WHITE_LABEL_BUILDS.md`**.

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

Reference hosts (**Railway / Neon / Vercel / EAS / Stripe**) and runbooks: [`PRODUCTION_DEPLOYMENT.md`](./PRODUCTION_DEPLOYMENT.md), [`PRODUCTION_CHECKLIST.md`](./PRODUCTION_CHECKLIST.md), [`ROLLBACK_RUNBOOK.md`](./ROLLBACK_RUNBOOK.md), [`REAL_DEVICE_TESTING.md`](./REAL_DEVICE_TESTING.md).

## Local development

- Copy `apps/api/.env.example` to `.env` (gitignored) and fill placeholders locally.
- Do not commit real secrets. CI should inject secrets from a vault or hosted secrets store.
