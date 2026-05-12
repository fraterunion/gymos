# Architecture

## Monorepo

GymOS is a pnpm workspace with Turborepo.

- `apps/api` — NestJS HTTP API (studio operations, integrations, webhooks).
- `apps/admin` — Next.js staff and owner console (App Router).
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

- Domain HTTP for studios, membership plans, and directory-style members lives in `apps/api/src/studios`, `membership-plans`, and `members`.
- **`StudioMemberGuard`** ensures the JWT subject has a non-deleted `StudioMembership` and the studio is not soft-deleted. **`RolesGuard`** checks `Role` on that same membership; `studioId` is always taken from **route params**, never from the body, for scoping and authorization.

## Cross-cutting concerns

- **Idempotency** for Stripe webhooks and payment-adjacent mutations.
- **Auditability** for schedule changes, membership changes, and staff overrides (implementation later; events originate in API).
- **Time zones** — studio-local time for schedules; store UTC with studio timezone metadata.

## Stripe (high level)

Stripe is the system of record for payments and subscription state that maps to GymOS membership. Webhooks are ingested only by `apps/api`. Admin surfaces read-only payment state and deep links to Stripe Customer Portal where applicable. No Stripe secret keys in admin or mobile.

## QR and check-in (high level)

Check-in and QR flows use short-lived, signed tokens issued by the API (`JWT_QR_SECRET` in env). Tokens encode studio, member or booking context, and expiry. Mobile renders QR; scanners or staff devices validate via API; no long-lived secrets on the client.

## Documentation map

Product and process docs live under `docs/`. This file is the structural source of truth; `DATABASE_SCHEMA.md` and `ENV_VARS.md` complement it for data and configuration ownership.
