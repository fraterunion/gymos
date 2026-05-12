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
| `EXPO_PUBLIC_STUDIO_SLUG` | Public studio slug for branding boot and tenant selection (must match a studio the user belongs to) |

Copy `apps/mobile/.env.example` to `apps/mobile/.env` for local dev. Values are inlined at **bundle** time; change requires restart / rebuild.

## Boot sequence

1. **Fonts / splash** — root `_layout.tsx`.
2. **Branding** — `BrandingProvider` loads public branding for the slug. Failure → full-screen retry UI (`BrandingBootGate`).
3. **Auth hydrate** — `AuthProvider` reads refresh token from SecureStore, calls `POST /auth/refresh`, then `GET /auth/me`. Failure → clear refresh token and memory access token.
4. **Routing** — `app/index.tsx` waits for branding **ready** + auth **hydrated**, then `replace` to `/(auth)/login` or `/(app)/(tabs)`.

## Selected studio (white-label)

After sign-in, the app calls **`GET /api/v1/me/studios`** and picks the row whose **`studio.slug`** equals **`EXPO_PUBLIC_STUDIO_SLUG`**.

- **Match** — `MemberStudioContext` exposes the row; `StudioActivityProvider` mounts with that **`studio.id`** for all schedule/booking/waitlist calls.
- **No match** — the user is not a member of this studio build: a full-screen **membership required** state is shown (support email from branding when present, **Try again**, **Sign out**). No schedule data is fetched.
- **Branding vs membership** — `SelectedStudioContext` + `BrandingContext` still describe the **app shell** (name, colors, logo) from public branding; **API studio timezone** for the matched row is preferred when formatting schedule times.

## Auth & API client

- **Login / register** — `POST /auth/login`, `POST /auth/register`; tokens stored as above; **`GET /auth/me`** confirms session after login/register/hydrate.
- **Logout** — best-effort `POST /auth/logout` with refresh token, then clear local session.
- **401 handling** — `lib/api/client.ts` runs a **single-flight** refresh; retries the request **once** with `_didRefresh`. Second 401 or missing refresh → clear session and emit `sessionInvalidated` (auth UI updates).

### Member API modules (Phase 3C)

| Module | Endpoints |
|--------|-----------|
| `lib/api/meStudios.ts` | `GET /me/studios` |
| `lib/api/scheduleApi.ts` | `GET /studios/:studioId/schedule?from=&to=` |
| `lib/api/bookingsApi.ts` | `GET .../bookings/me`, `POST .../classes/:classId/bookings`, `POST .../bookings/:id/cancel` |
| `lib/api/waitlistApi.ts` | `GET .../waitlist/me`, `POST .../classes/:classId/waitlist`, `POST .../waitlist/:entryId/cancel` |
| `lib/api/checkInsApi.ts` | `GET .../bookings/:bookingId/attendance`, `POST .../bookings/:bookingId/qr` |

`StudioActivityContext` loads schedule + my bookings + my waitlist in parallel, refreshes on tab **focus**, and exposes **`refresh()`** after mutations.

## QR check-in (Phase 3D)

- **Entry points** — Confirmed bookings: **My bookings** (row action) and **Class detail** (**Check-in QR**). Route: `/(app)/check-in/[bookingId]`.
- **Attendance first** — On load and on screen focus, **`GET /studios/:studioId/bookings/:bookingId/attendance`**. If **`attendance`** is non-null, the UI shows a **Checked in** success state (no QR).
- **Token issuance** — Inside the studio check-in window (client mirrors API: **15 minutes before** class start through **30 minutes after** start; see `lib/checkInWindow.ts`), the app calls **`POST /studios/:studioId/bookings/:bookingId/qr`** and receives **`{ qrToken, expiresAt }`**. The JWT is rendered with **`react-native-qrcode-svg`** on a high-contrast white card.
- **Expiry & regenerate** — A live countdown reflects **`expiresAt`**. When it reaches zero, the token is discarded from **component state** and the user can tap **Show new code** (POST again). **Refresh code** forces a new token while still valid.
- **Manual refresh** — Pull-to-refresh re-fetches attendance, then refreshes schedule/booking context; if the code was expired or missing and the window is open, a new QR is requested.
- **Errors** — User-facing copy maps **`404`** (booking not found), **`403`**, **`409`/`401`** messages (already checked in, invalid/expired/used token, confirmed-only rules), and **outside-window** states (**too early** with approximate open time, **too late** window closed). No raw JSON or debug dumps.

### Token security (mobile)

- The **QR JWT is never written to SecureStore, AsyncStorage, or files** — only **`useState`** on the check-in screen. Leaving the screen or refreshing attendance after check-in **clears** the in-memory token.
- The API stores only a **hash** of the token server-side; the member app treats the string as **display-only** for encoding into the QR graphic.

## Schedule flow

1. **Range** — Client requests a wide UTC window (`lib/datetime.ts` **`buildScheduleQueryRange`**) so the API returns every overlapping **`SCHEDULED`** class (see API contracts).
2. **Schedule tab** — Future classes (`startsAt` in the future, status **`SCHEDULED`**) are grouped by **calendar day in the studio timezone** (`calendarDayKeyInZone`). **Today** is labeled explicitly.
3. **Class detail** — `app/(app)/class/[classId].tsx` resolves the row from the in-memory schedule cache (same window). If the class is outside the window, the user sees **not found** + **Refresh**.

## Booking flow

1. **Book** — `POST /studios/:studioId/classes/:scheduledClassId/bookings` (empty JSON body). Success → `refresh()` so **My bookings** and home update.
2. **Full class** — **`409`** with a message containing **“full”** (case-insensitive) does **not** invent capacity counts. The class screen switches to **Join waitlist** as the primary action, with **Try booking again** as a secondary ghost action.
3. **Cancel** — `POST /studios/:studioId/bookings/:bookingId/cancel`; response may include **`promotion`** (handled by API; client refetches lists).

## Waitlist flow

1. **Join** — `POST .../classes/:classId/waitlist` when the class is full (or after a full response as above). **`409`** “available spots” means the user should use **Book** instead — surfaced as inline error text.
2. **My waitlist** — `GET .../waitlist/me` supplies **`WAITING`** and **`PROMOTED`** rows with **`queueRank`** / **`waitingCountForClass`** where applicable.
3. **Cancel waitlist** — `POST .../waitlist/:entryId/cancel` (**`204`**). **`PROMOTED`** entries cannot be cancelled here (**`409`** from API) — UI explains promotion state on the class page.

## Layout map (Phase 3C–3D)

| Area | Routes |
|------|--------|
| Boot | `app/index.tsx` |
| Unauthenticated | `app/(auth)/login`, `app/(auth)/register` |
| Authenticated shell | `app/(app)/_layout.tsx` — membership gate + `StudioActivityProvider` + stack |
| Tabs | `app/(app)/(tabs)/index` (home), `schedule`, `bookings`, `profile` |
| Class detail | `app/(app)/class/[classId]` |
| Check-in QR | `app/(app)/check-in/[bookingId]` |

Out of scope: payments, push, staff scanner UI, store builds, admin web, Stripe, uploads.

## Commands

From repo root: `pnpm --filter mobile dev` (Expo), or `pnpm --filter mobile build` (static web export). See root `package.json` / Turborepo for `lint` and `typecheck`.
