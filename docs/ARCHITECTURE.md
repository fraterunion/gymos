# Architecture

## Monorepo

GymOS is a pnpm workspace with Turborepo.

- `apps/api` — NestJS HTTP API (studio operations, integrations, webhooks).
- `apps/admin` — Next.js **operational desk** (Phase 3E: staff check-in — login, studio picker, today’s classes, class workspace with **QR paste**, **manual check-in**, **attendance** + roster when API role allows). Not the full owner/admin dashboard; see **`docs/ADMIN.md`**.
- `apps/mobile` — Expo React Native member app (Expo Router).

Shared packages:

- `packages/config` — TypeScript bases, ESLint preset, Tailwind placeholder for shared styling contracts.
- `packages/types` — Shared TypeScript types and DTO shapes (no runtime).
- `packages/utils` — Shared pure helpers (no I/O, no framework imports).

Future / optional packages: `packages/ui`, CI templates, Docker compose variants.

## Module boundaries

- **API** owns persistence adapters, domain services, background jobs, and external integrations (Stripe webhooks, email, push). It is the only app that talks to the database and holds long-lived secrets for server-side use.
- **Admin** is a browser client to the API. It does not connect to Postgres directly. It uses session or token auth as defined later; no business rules duplicated that belong solely on the server.
- **Mobile** is a member-facing client. It uses the same API with member-scoped credentials. Deep links and QR flows resolve through the API.
- **packages/types** is imported by API, admin, and mobile for contracts only. **packages/utils** holds formatting and validation helpers safe to reuse in any tier.

## Multi-tenant strategy

- **Tenant** is a boutique studio (organization). Almost all domain data is scoped by `studio_id` (or equivalent tenant key).
- **Users** belong to one primary studio for staff; members may be linked across studios only when explicitly modeled (e.g. network franchises); default is single-studio membership.
- API middleware and query filters enforce tenant isolation on every mutating and listing path. Admin and mobile send tenant context via auth claims or explicit studio slug only where the product allows switching; the API remains authoritative.

### Phase 2A (API) — studio-scoped modules

- Domain HTTP for studios, membership plans, directory-style members, **billing / Stripe**, and **white-label branding** lives in `apps/api/src/studios`, `membership-plans`, `members`, `billing`, `stripe`, and `branding`.
- **`StudioMemberGuard`** ensures the JWT subject has a non-deleted `StudioMembership` and the studio is not soft-deleted. **`RolesGuard`** checks `Role` on that same membership; `studioId` is always taken from **route params**, never from the body, for scoping and authorization.

## White-label branding (Phase 3A)

- **GymOS** is the internal core platform and API template; each gym ships a **separately branded** member app in the App Store / Google Play (different app name, colors, icons, bundle IDs, store URLs).
- **One backend, many branded apps**: mobile clients resolve **studio `slug`** (and optionally cached branding) via **`GET /api/v1/public/studios/:slug/branding`** on boot — no auth, no internal fields. Tenant-specific assets are **URL references only** in this phase (no uploads or object storage in the API).
- **Studio-scoped** `GET` / `PATCH /api/v1/studios/:studioId/branding` is **OWNER** / **ADMIN** only for read/update of the same fields plus `id` for admin forms.
- **Future**: EAS / native build pipelines can consume these fields to generate per-client app config; not implemented in 3A.

## Mobile member app (Phase 3B–3C)

- **`apps/mobile`** is the Expo Router + React Native + NativeWind client. It is **not** a generic Expo demo: routing is split into **branding boot** → **auth** → **protected shell** (membership gate + activity data) → **tabs** + **stack overlays** (e.g. class detail).
- **White-label boot**: `EXPO_PUBLIC_STUDIO_SLUG` selects the tenant; **`GET /api/v1/public/studios/:slug/branding`** (no auth) drives **app name**, **primary/secondary colors**, and optional **logo URL** in UI. Missing env or failed fetch shows a dedicated error screen with retry.
- **Auth**: Same Phase 1 auth API as admin (`/auth/login`, `/auth/register`, `/auth/refresh`, `/auth/logout`, `/auth/me`). **Access JWT** lives **only in memory**; **refresh token** is stored with **Expo SecureStore**. The shared **`lib/api/client.ts`** attaches `Authorization: Bearer`, refreshes once on **401** (single-flight, no infinite loop), and clears the session if refresh fails.
- **Studio context**: **`SelectedStudioProvider`** exposes slug, display name, and timezone from **public branding** for shell copy. **Phase 3C** adds **`MemberStudioProvider`**: after login, **`GET /api/v1/me/studios`** must contain a row whose **`studio.slug`** matches the env slug; otherwise the member sees a **membership required** screen (no schedule calls). **`StudioActivityProvider`** then owns **`GET .../schedule`**, **`GET .../bookings/me`**, and **`GET .../waitlist/me`** with refetch-on-focus.
- **Member UX (3C–3D)**: Home, **Schedule**, **My bookings**, **Class detail**, and **Check-in QR** (`POST`/`GET` booking QR & attendance per API contracts). QR JWT exists **only in screen state**; attendance drives a **checked-in** state without showing a code.
- **Documentation**: `docs/MOBILE.md` describes env vars, boot order, selected-studio logic, schedule/booking/waitlist flows, and layout map.

## Cross-cutting concerns

- **Idempotency** for Stripe webhooks and payment-adjacent mutations.
- **Auditability** for schedule changes, membership changes, and staff overrides (implementation later; events originate in API).
- **Time zones** — studio-local time for schedules; store UTC with studio timezone metadata.

## Stripe (Phase 4A)

- **Direct Stripe Billing** (no Connect): `apps/api/src/stripe` wraps the official Stripe SDK; `apps/api/src/billing` owns Checkout creation, Billing Portal sessions, and **webhook processing** (`StripeWebhookService`). `MembershipPlansModule` imports `BillingModule` for the **MEMBER** Checkout route; `AppModule` imports `BillingModule` for `POST /stripe/webhook`.
- **HTTP:** `main.ts` uses **`bodyParser: false`**; `http-app.setup.ts` applies **`express.raw`** only to `POST /api/v1/stripe/webhook`, then **`express.json` / `urlencoded` for all other routes**, so Stripe signature verification always sees the **raw** bytes. Never parse the webhook body before `constructEvent`.
- **State sync:** Checkout and subscription webhooks upsert **`subscriptions`** from verified metadata + Stripe subscription payloads; **`invoice.paid`** / **`invoice.payment_failed`** upsert **`payments`** and may set subscription **`PAST_DUE`** on failure paths.

## QR and check-in (high level)

Check-in and QR flows use short-lived, signed tokens issued by the API (`JWT_QR_SECRET` in env). Tokens encode studio, member or booking context, and expiry. Mobile renders QR; scanners or staff devices validate via API; no long-lived secrets on the client.

## Documentation map

Product and process docs live under `docs/`. This file is the structural source of truth; `DATABASE_SCHEMA.md` and `ENV_VARS.md` complement it for data and configuration ownership. **`docs/MOBILE.md`** covers the Expo member app; **`docs/ADMIN.md`** covers the Next.js check-in desk. **Production / pilot:** [`PRODUCTION_DEPLOYMENT.md`](./PRODUCTION_DEPLOYMENT.md), [`PRODUCTION_CHECKLIST.md`](./PRODUCTION_CHECKLIST.md), [`ROLLBACK_RUNBOOK.md`](./ROLLBACK_RUNBOOK.md), [`REAL_DEVICE_TESTING.md`](./REAL_DEVICE_TESTING.md). **Demo seed:** [`DEMO_ENVIRONMENT.md`](./DEMO_ENVIRONMENT.md).

## Production & pilot operations (Phase 6A)

- **Reference topology:** API on **Railway**, Postgres on **Neon**, admin on **Vercel**, mobile via **EAS**, Stripe **webhooks** to the API (`POST /api/v1/stripe/webhook`). Details and ordering: [`PRODUCTION_DEPLOYMENT.md`](./PRODUCTION_DEPLOYMENT.md).
- **Health:** `GET /health` on the API host (outside `api/v1` prefix) returns `{ "status": "ok" }` for probes.
- **Migrations:** `pnpm --filter api db:migrate:deploy` (or `prisma migrate deploy` in `apps/api`) against the target `DATABASE_URL` before serving traffic that depends on new schema (see deployment doc + [`ROLLBACK_RUNBOOK.md`](./ROLLBACK_RUNBOOK.md)).
- **CORS:** API `CORS_ORIGIN` must list the Vercel admin origin(s) in production ([`apps/api/src/http-app.setup.ts`](../apps/api/src/http-app.setup.ts)).

## Observability & deploy scripts (Phase 6B)

- **Prisma:** `apps/api/package.json` defines `db:generate` and `db:migrate:deploy` for CI and operators ([`PRODUCTION_DEPLOYMENT.md`](./PRODUCTION_DEPLOYMENT.md)).
- **Smoke:** `apps/api/scripts/smoke-health.mjs` and `smoke-auth.mjs` — `pnpm --filter api smoke:health` / `smoke:auth`; env vars in [`ENV_VARS.md`](./ENV_VARS.md) § Ops scripts & smoke env.
- **Startup logs:** `apps/api/src/main.ts` logs `env` (NODE_ENV), `port`, `healthPath`, and `apiPrefix` as plain text plus one JSON line (`event: api_started`). **Do not** log secrets, JWTs, refresh tokens, or Stripe keys ([`PRODUCTION_DEPLOYMENT.md`](./PRODUCTION_DEPLOYMENT.md) § Logging).
