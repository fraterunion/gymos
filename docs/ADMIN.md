# GymOS admin (Next.js)

Browser app for **staff-facing operational tools** that are not the full product admin console. Phase **3E** ships the **front desk check-in desk**: studio selection, today’s schedule, per-class **QR paste check-in**, **manual check-in**, and **attendance** views.

## Stack

- **Next.js** (App Router), **React**, **Tailwind CSS v4** (`src/app/globals.css`).
- **API** — same GymOS Nest API as mobile; base URL from **`NEXT_PUBLIC_API_URL`** (origin only, no trailing slash). All calls use `{origin}/api/v1/...`.

## Environment

| Variable | Purpose |
|----------|---------|
| `NEXT_PUBLIC_API_URL` | API origin, e.g. `http://localhost:3000` |

Copy `apps/admin/.env.example` to `apps/admin/.env.local`.

## Auth (Phase 3E)

- **Login** — `POST /api/v1/auth/login` with email/password.
- **Access token** — kept **in memory only** (module singleton in `src/lib/auth/session.ts`), attached as `Authorization: Bearer` on each request via `src/lib/api/client.ts`.
- **Refresh token** — stored in **`localStorage`** (`gymos_admin_refresh_v1`) so the tab can survive reload. **`POST /auth/refresh`** runs on **401** once (single-flight), then retries the request; failure **clears** the session.
- **Session bootstrap** — `AuthProvider` (`src/contexts/AuthContext.tsx`) attempts refresh + **`GET /auth/me`** on load.
- **Logout** — best-effort **`POST /auth/logout`** with the refresh token, then clear memory + `localStorage`.

## Studio selection

After login, **`GET /api/v1/me/studios`** loads in **`DeskStudioProvider`**. The active **`studioId`** is stored in **`sessionStorage`** (`gymos_admin_studio_id`) so refresh keeps the same studio. Staff can switch studio from the header **select** (membership list).

## Routes

| Path | Purpose |
|------|---------|
| `/` | Redirects to `/check-in` if authenticated, else `/login`. |
| `/login` | Email/password sign-in. |
| `/check-in` | Today’s **scheduled** classes for the selected studio (studio-local “today” via timezone). |
| `/check-in/[classId]` | Class workspace: **QR paste** form (`POST .../check-ins/qr`), **attendance list** (`GET .../classes/:classId/attendance`), **confirmed roster** + **manual check-in** (`POST .../check-ins/manual`). |

## Check-in desk UX

- **QR** — Large monospace **textarea** + **Submit token** (no camera in this phase). Success and **already checked in** paths show **inline banners** (success / warning / error) and refresh attendance.
- **Manual** — Each roster row has **Check in** until the member appears in the attendance list (**In** badge). Buttons disable while the row’s request is in flight.
- **Roster** — `GET .../classes/:classId/roster` is available to **STAFF**, **INSTRUCTOR**, **ADMIN**, and **OWNER** (confirmed bookings with member summary). If the request fails (e.g. network), the UI shows a retry note.
- **Refresh** — Header **Refresh** on attendance card; pull is not implemented on web list (use button).

## Commands

From repo root: `pnpm --filter admin dev`, `pnpm --filter admin build`, `pnpm --filter admin lint`, `pnpm --filter admin typecheck`.

## Relationship to `apps/mobile`

- **Mobile** — member QR **generation** and self-service.
- **Admin desk** — staff **consumption** of pasted QR tokens and **manual** check-ins against the same attendance model.
