# GymOS mobile (Expo)

White-label member app under `apps/mobile`. Each gym ships its own build; **studio identity** comes from `EXPO_PUBLIC_STUDIO_SLUG` plus **`GET /api/v1/public/studios/:slug/branding`** on boot.

## Stack

- **Expo Router** — file-based routing, `(auth)` vs `(app)` groups.
- **React Native** + **NativeWind** (`global.css`, `tailwind.config.js`).
- **expo-secure-store** — persisted **refresh token only**; **access token stays in memory** (`lib/session.ts` + `lib/api/client.ts`).
- **API** — `EXPO_PUBLIC_API_URL` (origin only, no trailing slash required); all app calls use `{origin}/api/v1/...`.

## Environment

| Variable | Purpose |
|----------|---------|
| `EXPO_PUBLIC_API_URL` | API origin, e.g. `https://api.example.com` or `http://localhost:3000` |
| `EXPO_PUBLIC_STUDIO_SLUG` | Public studio slug for branding boot and `SelectedStudio` context |

Copy `apps/mobile/.env.example` to `apps/mobile/.env` for local dev. Values are inlined at **bundle** time; change requires restart / rebuild.

## Boot sequence

1. **Fonts / splash** — root `_layout.tsx`.
2. **Branding** — `BrandingProvider` loads public branding for the slug. Failure → full-screen retry UI (`BrandingBootGate`).
3. **Auth hydrate** — `AuthProvider` reads refresh token from SecureStore, calls `POST /auth/refresh`, then `GET /auth/me`. Failure → clear refresh token and memory access token.
4. **Routing** — `app/index.tsx` waits for branding **ready** + auth **hydrated**, then `replace` to `/(auth)/login` or `/(app)/(tabs)`.

## Auth & API client

- **Login / register** — `POST /auth/login`, `POST /auth/register`; tokens stored as above; **`GET /auth/me`** confirms session after login/register/hydrate.
- **Logout** — best-effort `POST /auth/logout` with refresh token, then clear local session.
- **401 handling** — `lib/api/client.ts` runs a **single-flight** refresh; retries the request **once** with `_didRefresh`. Second 401 or missing refresh → clear session and emit `sessionInvalidated` (auth UI updates).

## Layout map (Phase 3B)

| Area | Routes |
|------|--------|
| Boot | `app/index.tsx` |
| Unauthenticated | `app/(auth)/login`, `app/(auth)/register` |
| Authenticated | `app/(app)/(tabs)/index` (home placeholder), `app/(app)/(tabs)/profile` (logout) |

Out of scope for 3B: bookings, schedule, QR, payments, push, store builds, uploads.

## Commands

From repo root: `pnpm --filter mobile dev` (Expo), or `pnpm --filter mobile build` (static web export). See root `package.json` / Turborepo for `lint` and `typecheck`.
