# White-label mobile builds

Each gym ships its **own** App Store / Google Play listing from the shared codebase under `apps/mobile`. This document describes **native build identity** (name, scheme, bundle IDs, icons) vs **runtime branding** (colors, logos from the API).

## Concepts

| Layer | Source | What it controls |
|-------|--------|------------------|
| **Native build identity** | `app.config.ts` + env files under `apps/mobile/env/` | Home screen app name, URL scheme, iOS bundle id, Android package, default splash/icon assets bundled into the binary. |
| **Runtime branding** | `GET /api/v1/public/studios/:slug/branding` + `EXPO_PUBLIC_STUDIO_SLUG` | In-app colors, optional logos, support links, display name **inside** the app shell when the API supplies `appName` / `name`. |

Changing **only** runtime branding does **not** require a new store binary. Changing **bundle id**, **package name**, **scheme**, or bundled **icon/splash** files requires a **new build** and usually a **new store listing** (same listing can receive updates only when the app id is unchanged).

## Profiles and env files

1. Choose a profile id (e.g. `local`, `ares`, `pilates-toluca`).
2. Copy the matching example file in `apps/mobile/env/` to a **non-example** name:
   - `env/.env.local.example` → `env/.env.local`
   - `env/.env.ares.example` → `env/.env.ares`
   - `env/.env.pilates-toluca.example` → `env/.env.pilates-toluca`
3. Set **`WHITELABEL_PROFILE`** to that id when running Expo or CI (e.g. `WHITELABEL_PROFILE=ares`).

Load order (later overrides earlier):

1. `apps/mobile/env/.env.<WHITELABEL_PROFILE>` (if it exists)
2. `apps/mobile/.env` (optional; common for quick `EXPO_PUBLIC_*` overrides)

`app.config.ts` reads **non–`EXPO_PUBLIC_*`** keys for the native shell. Metro still inlines **`EXPO_PUBLIC_*`** from the same files when present (see Expo env rules).

## Required variables (client / production-like profiles)

For any profile **other than** `local`, the following **must** be set (no template defaults):

| Variable | Purpose |
|----------|---------|
| `APP_DISPLAY_NAME` | App name under the icon and in system UI (store listing should match). |
| `APP_SCHEME` | Deep link / OAuth-style scheme; must match **Stripe return URLs** on the API (see below). |
| `IOS_BUNDLE_IDENTIFIER` | iOS bundle id (reverse-DNS, unique per client). |
| `ANDROID_PACKAGE` | Android application id (unique per client). |
| `APP_ICON_PATH` | Path to app icon **relative to `apps/mobile/`** (e.g. `./assets/brands/client/icon.png`). |
| `APP_SPLASH_PATH` | Splash image path (relative). |
| `APP_ADAPTIVE_ICON_PATH` | Android adaptive foreground path (relative). |
| `EXPO_PUBLIC_API_URL` | API origin for the app. |
| `EXPO_PUBLIC_STUDIO_SLUG` | Public studio slug for branding fetch and tenant match. |

**Recommended:** `EXPO_SLUG` — Expo project slug (updates channel / EAS project identity). Defaults for `local` only.

## Local / template profile (`WHITELABEL_PROFILE=local`)

If unset, profile defaults to **`local`**. Missing native keys fall back to **internal template** values (see `app.config.ts`). Use this only on developer machines, not for store builds.

## Stripe return URLs and `APP_SCHEME`

The API uses `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL`, and `STRIPE_BILLING_PORTAL_RETURN_URL`. For native returns, those URLs must use the **same scheme** as `APP_SCHEME` in the built app, with paths `billing/success`, `billing/cancel`, and `billing/return` (see `docs/MOBILE.md` and `lib/billing/stripeReturnUrlHelpers.ts`).

Example pattern: `<APP_SCHEME>://billing/success` (replace `<APP_SCHEME>` with the value from that client’s env file).

## Store identity warning

**Changing `IOS_BUNDLE_IDENTIFIER` or `ANDROID_PACKAGE` after release creates a different app** from the store’s perspective (new listing, new reviews, users must install the new app). Plan ids before the first public release and keep them stable per brand.

## Verify resolved config

From repo root:

```bash
pnpm --filter mobile config:print
# or
pnpm mobile:config:print
```

With a profile (after copying an example to `env/.env.ares`):

```bash
WHITELABEL_PROFILE=ares pnpm --filter mobile config:print
```

This prints a JSON summary: profile, `name`, `slug`, `scheme`, bundle id / package, icon paths.

## Creating a new gym app (checklist)

1. **Apple / Google** — Register new bundle id / package in developer consoles (unique per client).
2. **Env file** — Add `apps/mobile/env/.env.<profile>.example` (copy from `env/.env.ares.example` as a template) and fill client-specific values; commit the **`.example`** only, not secrets.
3. **Assets** — Add icon, splash, and adaptive foreground under `apps/mobile/assets/...` and point `APP_*_PATH` at them.
4. **API** — Set `EXPO_PUBLIC_API_URL`, studio slug, and Stripe return URLs to match `APP_SCHEME` + billing paths.
5. **Build** — Run `WHITELABEL_PROFILE=<profile> pnpm exec expo prebuild` (or EAS Build with the same env). Submit the generated native projects per store process (automation out of scope).

Runtime colors and marketing logos that change without a store update remain on the **branding** API for that studio slug.
