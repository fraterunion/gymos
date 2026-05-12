# White-label mobile builds

Each gym ships its **own** App Store / Google Play listing from the shared codebase under `apps/mobile`. This document describes **native build identity** (name, scheme, bundle IDs, icons) vs **runtime branding** (colors, logos from the API).

## Concepts

| Layer | Source | What it controls |
|-------|--------|------------------|
| **Native build identity** | `app.config.ts` + env files under `apps/mobile/env/` | Home screen app name, URL scheme, iOS bundle id, Android package, default splash/icon assets bundled into the binary. |
| **Runtime branding** | `GET /api/v1/public/studios/:slug/branding` + `EXPO_PUBLIC_STUDIO_SLUG` | In-app colors, optional logos, support links, display name **inside** the app shell when the API supplies `appName` / `name`. |

Changing **only** runtime branding does **not** require a new store binary. Changing **bundle id**, **package name**, **scheme**, or bundled **icon/splash** files requires a **new build** and usually a **new store listing** (same listing can receive updates only when the app id is unchanged).

**Launch operations (Phase 5C):** use [`CLIENT_LAUNCH_CHECKLIST.md`](./CLIENT_LAUNCH_CHECKLIST.md) (end-to-end checklist) and [`STORE_METADATA_TEMPLATE.md`](./STORE_METADATA_TEMPLATE.md) (App Store / Play copy worksheet). **Store submission** itself stays a manual process outside this repo.

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
5. **Build** — Local: `WHITELABEL_PROFILE=<profile> pnpm exec expo prebuild`. Cloud: **`eas build`** with a profile from **`apps/mobile/eas.json`** (see `docs/WHITE_LABEL_BUILDS.md` → EAS); mirror env in EAS secrets. Store submission automation is out of scope.

Runtime colors and marketing logos that change without a store update remain on the **branding** API for that studio slug.

---

## EAS Build (Phase 5B)

Configuration lives in **`apps/mobile/eas.json`**. It does **not** run builds by itself; you run the EAS CLI locally or from a future CI job.

### Install and log in

1. Install the CLI (already a **devDependency** of `apps/mobile`): `pnpm --filter mobile exec eas --version`
2. Log in once per machine: `pnpm --filter mobile exec eas login` (Expo account with access to the EAS project).

Do **not** commit tokens. CI can use `EXPO_TOKEN` later (out of scope for this phase).

### Link the app to an EAS project (first time)

From `apps/mobile` (or with `--filter mobile`), run **`eas init`** when prompted to create or link an Expo project. That writes **`extra.eas.projectId`** into app config / project state—run interactively when you are ready; this repo does not require a project id for `pnpm build` / `expo export`.

We intentionally do **not** run `eas build:configure --non-interactive` in automation here.

### Build profiles (`eas.json`)

| Profile | Intent |
|---------|--------|
| **`development`** | Dev client (`developmentClient: true`), internal distribution, **iOS simulator** + Android **APK**. Sets `WHITELABEL_PROFILE=local`. |
| **`preview`** | Internal preview builds (TestFlight internal / installable Android). `WHITELABEL_PROFILE=local` unless you override. |
| **`production`** | Store-facing pipeline. `WHITELABEL_PROFILE=local` for the template; real gyms use client profiles below. |
| **`preview-ares`** / **`production-ares`** | Same as preview/production, with **`WHITELABEL_PROFILE=ares`**. |
| **`preview-pilates-toluca`** / **`production-pilates-toluca`** | Same with **`WHITELABEL_PROFILE=pilates-toluca`**. |

`extends` reuses the base profile’s options; **`env`** adds variables available when **`app.config.ts`** runs on EAS builders.

### `WHITELABEL_PROFILE` and secrets on EAS

`eas.json` only sets **`WHITELABEL_PROFILE`** per client profile. **`app.config.ts`** still needs every **native** and **`EXPO_PUBLIC_*`** variable (see tables above).

- **Gitignored files** such as `env/.env.ares` are **not** uploaded to EAS by default. Cloud builds will **not** see them unless you use a different workflow.
- For **preview/production** client builds, configure the same variables in **EAS Environment variables** or **EAS Secrets** (Expo dashboard: Project → Environment variables, or `eas env:create` / `eas secret:create`). Names must match what `app.config.ts` reads (`APP_DISPLAY_NAME`, `APP_SCHEME`, `EXPO_PUBLIC_API_URL`, etc.).

After secrets exist, use the **Expo dashboard** (Project → **Environment variables** / **Secrets**) or your installed **`eas-cli`** commands as the source of truth—not committed `.env` files.

### Stripe and `APP_SCHEME`

Set API **`STRIPE_*_URL`** values to the **same `APP_SCHEME`** as the binary you ship (see [Stripe return URLs](#stripe-return-urls-and-app_scheme)). Preview and production binaries for the same client must use the **same** scheme if they share one Stripe mode; if you use different schemes per track, align API env per environment.

### Verify config before `eas build`

Always print resolved native identity locally (with the same profile and env files you expect EAS to mirror):

```bash
pnpm --filter mobile config:print
pnpm --filter mobile eas:config:ares
pnpm --filter mobile eas:config:pilates
```

### Example commands (manual; do not run in CI without credentials)

**iOS preview (template `local`):**

```bash
pnpm --filter mobile eas:build:ios:preview
```

**Android preview (template `local`):**

```bash
pnpm --filter mobile eas:build:android:preview
```

**Production (template `local`):**

```bash
pnpm --filter mobile eas:build:ios:production
pnpm --filter mobile eas:build:android:production
```

**Client preview (examples in `package.json`):**

```bash
pnpm --filter mobile eas:build:ios:ares
pnpm --filter mobile eas:build:android:ares
pnpm --filter mobile eas:build:ios:pilates
pnpm --filter mobile eas:build:android:pilates
```

**Client production** (swap profile name):

```bash
pnpm --filter mobile exec eas build --platform ios --profile production-ares
pnpm --filter mobile exec eas build --platform android --profile production-pilates-toluca
```

### Bundle id / package immutability (again)

EAS does not change Apple/Google rules: **changing `IOS_BUNDLE_IDENTIFIER` or `ANDROID_PACKAGE` after users install the app is treated as a new app.** Keep one pair per brand per store listing.

### Scripts reference (`apps/mobile/package.json`)

| Script | Purpose |
|--------|---------|
| `config:print` | Resolved Expo config (default / current env). |
| `eas:config:ares` | `config:print` with `WHITELABEL_PROFILE=ares` (needs `env/.env.ares` locally). |
| `eas:config:pilates` | Same for `pilates-toluca`. |
| `eas:build:ios:ares` | `eas build --platform ios --profile preview-ares` |
| `eas:build:android:ares` | `eas build --platform android --profile preview-ares` |
| `eas:build:ios:pilates` | `eas build --platform ios --profile preview-pilates-toluca` |
| `eas:build:android:pilates` | `eas build --platform android --profile preview-pilates-toluca` |
| `eas:build:ios:preview` | Base **preview** profile, iOS. |
| `eas:build:android:preview` | Base **preview** profile, Android. |
| `eas:build:ios:production` | Base **production** profile, iOS. |
| `eas:build:android:production` | Base **production** profile, Android. |

All `eas build` commands require **EAS login** and a linked project when you actually run them; they are not executed in this repo’s validation scripts.

---

## Production & pilot (Phase 6A)

Target layout (**Railway API**, **Neon DB**, **Vercel admin**, **EAS mobile**, **Stripe webhooks**) and ordering: [`PRODUCTION_DEPLOYMENT.md`](./PRODUCTION_DEPLOYMENT.md). Use [`PRODUCTION_CHECKLIST.md`](./PRODUCTION_CHECKLIST.md) before widening pilot traffic.

### Release candidate & pilot flow (Phase 7B)

- **RC freeze & sign-off** — [`RELEASE_CANDIDATE_CHECKLIST.md`](./RELEASE_CANDIDATE_CHECKLIST.md).
- **Ordered pilot runbook** — [`PILOT_RELEASE_FLOW.md`](./PILOT_RELEASE_FLOW.md) (reset → seed → build → migrate → smoke → Stripe → admin → EAS preview → TestFlight → RC git tag → walkthrough).

### RC tagging & pilot retro (Phase 7C)

- **Git tag discipline** — [`RC_TAGGING_GUIDE.md`](./RC_TAGGING_GUIDE.md).
- **Structured retro** — [`PILOT_RETRO_TEMPLATE.md`](./PILOT_RETRO_TEMPLATE.md).
