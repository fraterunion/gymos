# Client launch checklist (white-label member app)

Operational checklist for shipping **one** gym’s **own** App Store and Google Play apps from `apps/mobile`. Use one copy of this document **per client**; track owners and dates in your PM tool if needed.

**Related docs:** [`WHITE_LABEL_BUILDS.md`](./WHITE_LABEL_BUILDS.md) (builds & EAS), [`STORE_METADATA_TEMPLATE.md`](./STORE_METADATA_TEMPLATE.md) (store copy), [`MOBILE.md`](./MOBILE.md), [`ENV_VARS.md`](./ENV_VARS.md), [`PRODUCTION_DEPLOYMENT.md`](./PRODUCTION_DEPLOYMENT.md), [`PRODUCTION_CHECKLIST.md`](./PRODUCTION_CHECKLIST.md).

---

## Three layers (do not conflate)

| Layer | What it is | Changes without new binary? |
|-------|------------|------------------------------|
| **Runtime branding** | Public API branding for `EXPO_PUBLIC_STUDIO_SLUG` (colors, logos, `appName`, support links in app). | **Yes** — update studio branding in product / API. |
| **Native app identity** | `app.config.ts` + env: display name on home screen, bundle id, package, **URL scheme**, bundled icon/splash. | **No** — requires a **new build**; changing bundle id/package after release = **treated as a new app** by the stores. |
| **Store listing metadata** | Titles, descriptions, screenshots, privacy/terms URLs **in Apple/Google consoles**. | **Yes** — update listing (still use **unique** copy per client; do not paste identical text across all gyms). |

**Schemes:** Each client build must use a **unique** `APP_SCHEME` (and matching API **Stripe return URLs**). Reusing a scheme across brands causes deep-link and return-URL collisions.

---

## Phase 0 — Ownership & accounts

- [ ] **Client decision-maker** named for approvals (metadata, screenshots, legal URLs).
- [ ] **Apple Developer Program** — org enrolled; **Team ID** known; person who can create identifiers & certificates identified.
- [ ] **Google Play Console** — developer account; person who can create app & signing identified.
- [ ] **App signing ownership** — who holds upload keystore (Android) / distribution certs (iOS); backup policy documented (no keys in git).
- [ ] **Expo / EAS** — Expo account access for CI/humans who run `eas build` ([`WHITE_LABEL_BUILDS.md` → EAS](./WHITE_LABEL_BUILDS.md#eas-build-phase-5b)).

---

## Phase 1 — Identity & configuration (single source of truth)

Fill these in your internal runbook **before** first store draft:

- [ ] **App name** (marketing) — aligns with `APP_DISPLAY_NAME` and store title policy.
- [ ] **Studio slug** — matches production `EXPO_PUBLIC_STUDIO_SLUG` and API `Studio.slug`.
- [ ] **iOS bundle id** — `IOS_BUNDLE_IDENTIFIER` (registered in Apple Developer; **immutable** per listing after users install).
- [ ] **Android package** — `ANDROID_PACKAGE` (registered in Play Console; **immutable** per listing after go-live).
- [ ] **App scheme** — `APP_SCHEME` (unique; documented for Stripe + deep links).
- [ ] **Production API URL** — `EXPO_PUBLIC_API_URL` (HTTPS, correct environment).
- [ ] **EAS profile** — e.g. `production-<client>` in `eas.json` + `WHITELABEL_PROFILE` ([`eas.json`](../apps/mobile/eas.json)).

**Verify locally before any store submission:**

- [ ] `pnpm --filter mobile config:print` (or client-specific `eas:config:*` scripts) shows expected `name`, `scheme`, bundle id, package, icons.

---

## Phase 2 — API, Stripe, and legal endpoints

- [ ] **Stripe env (production API)** — `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL`, `STRIPE_BILLING_PORTAL_RETURN_URL` set for **this** app’s scheme (e.g. `{APP_SCHEME}://billing/success`). See [`MOBILE.md` → Membership](./MOBILE.md) / Phase 4C.
- [ ] **Production Stripe keys** — live mode only in production; rotate if exposed.
- [ ] **Privacy policy URL** — HTTPS; reachable; matches store fields and optional `privacyUrl` in runtime branding.
- [ ] **Terms URL** — HTTPS; reachable; matches store and optional `termsUrl` in branding.
- [ ] **Support email** — monitored inbox; in branding API and store “support” where required.
- [ ] **Support phone** — if shown in app or store; correct locale/format.

---

## Phase 3 — Assets (binary + store)

**In-app / binary (bundled via paths in env):**

- [ ] **App icon** — `APP_ICON_PATH` (per platform guidelines: safe zone, no illegible text at small size).
- [ ] **Splash screen** — `APP_SPLASH_PATH` (brand-safe; legible on light/dark if applicable).
- [ ] **Android adaptive icon** — `APP_ADAPTIVE_ICON_PATH` (foreground safe area; background color set in `app.config.ts` if you customize later).

**Store-only (not bundled as app UI unless you also use in marketing screens):**

- [ ] **App Store screenshots** — sizes per **current** [App Store Connect screenshot specs](https://developer.apple.com/help/app-store-connect/reference/screenshot-specifications/); real UI, correct locale.
- [ ] **Play Store screenshots** — phone (and tablet if targeting); feature graphic if required; see **Google Play Console** help for current dimensions.

**Documentation (recommended):**

- [ ] Spreadsheet or folder: filename → device size → language → version of app used.

---

## Phase 4 — EAS & secrets (cloud builds)

Gitignored `env/.env.<client>` is **not** on EAS workers by default.

- [ ] **EAS environment variables / secrets** — mirror every variable `app.config.ts` and Metro need (`APP_*`, `EXPO_PUBLIC_*`). See [`WHITE_LABEL_BUILDS.md` → EAS](./WHITE_LABEL_BUILDS.md#whitelabel_profile-and-secrets-on-eas).
- [ ] **Stripe return URLs** re-verified after final `APP_SCHEME` choice.

---

## Phase 5 — Store metadata (unique per client)

- [ ] **App Store** — title, subtitle, description, keywords, privacy URL, support URL, age rating questionnaire completed using truthful answers.
- [ ] **Google Play** — short description, full description, data safety form, privacy policy, content rating questionnaire.
- [ ] **No copy-paste across clients** — rewrite keywords/descriptions per brand (SEO + policy risk). Use [`STORE_METADATA_TEMPLATE.md`](./STORE_METADATA_TEMPLATE.md).

---

## Phase 6 — Testing gates

- [ ] **Test build verification** — internal/preview profile: login, branding load, schedule, booking, membership, billing return deep links, Stripe checkout smoke (test mode or small real charge per policy).
- [ ] **Release build verification** — production profile: same smoke on production API with **live** Stripe only when ready.
- [ ] **TestFlight / internal testing** — Apple: distribute to internal + key external testers; collect crash/symbolicated feedback.
- [ ] **Play internal testing** — closed track before production rollout.

---

## Phase 7 — Release (manual; automation out of scope)

> **Naming:** This “Phase 7” is the **client store release** checklist. Engineering **pilot RC** freeze and runbook live in [`RELEASE_CANDIDATE_CHECKLIST.md`](./RELEASE_CANDIDATE_CHECKLIST.md) and [`PILOT_RELEASE_FLOW.md`](./PILOT_RELEASE_FLOW.md).

- [ ] **Final release approval** — client sign-off on metadata + screenshots + version notes.
- [ ] **App Store submission** — human runs Apple submission (not automated here).
- [ ] **Play submission** — human runs staged rollout (not automated here).
- [ ] **Post-release** — monitor reviews, webhook dashboards, support inbox; plan hotfix build if needed (**same** bundle id/package).

---

## Quick reference — env vars (client production)

| Area | Variables / artifacts |
|------|------------------------|
| Mobile / EAS | `WHITELABEL_PROFILE`, `APP_DISPLAY_NAME`, `APP_SCHEME`, `IOS_BUNDLE_IDENTIFIER`, `ANDROID_PACKAGE`, `APP_ICON_PATH`, `APP_SPLASH_PATH`, `APP_ADAPTIVE_ICON_PATH`, `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_STUDIO_SLUG`, optional `EXPO_SLUG` |
| API (Stripe) | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL`, `STRIPE_BILLING_PORTAL_RETURN_URL` |
| Runtime branding | API public branding + studio slug (privacy, terms, support, logos) |

---

## Immutable after users install

**iOS bundle identifier** and **Android application id** define the app identity to Apple/Google. Changing them **after** release creates a **new** app listing from the stores’ perspective. Plan once; keep stable per brand.

---
