# Database schema

## Status

The API uses **Prisma** with PostgreSQL (`apps/api/prisma/schema.prisma`). Migrations live under `apps/api/prisma/migrations/`. This document highlights **tenant-relevant** tables and constraints that affect API behavior; it is not a full column listing (see Prisma schema for that).

## Tenancy and identity

- **Studio** (`studios`) — Tenant root: `name`, `slug` (unique), `timezone`, `deleted_at`. Soft delete via `deleted_at`. The HTTP **`StudioMemberGuard`** loads the studio with `deleted_at IS NULL`; **soft-deleted studios are rejected** even if a `studio_memberships` row still exists.
- **User** (`users`) — Auth identity; `deleted_at` for soft delete. API rejects soft-deleted users where guards check membership.
- **StudioMembership** (`studio_memberships`) — Links `user_id` to `studio_id` with a **`Role`**. Unique `(user_id, studio_id)`. Soft delete via `deleted_at`. Guards require an active membership for routes under `/studios/:studioId/...`.

### `Role` enum

Stored on `studio_memberships.role`. Values (Prisma / PostgreSQL):

- `MEMBER`, `INSTRUCTOR`, `STAFF`, `ADMIN`, `OWNER`

**`STAFF`** was added in migration `20260512120000_phase2a_role_staff_and_plan_class_credits` (`ALTER TYPE "Role" ADD VALUE 'STAFF'`). Use it for staff-scoped directory/read endpoints as defined in the API layer.

## Class templates and schedule

- **ClassTemplate** (`class_templates`) — `studio_id`, `name`, `duration_minutes`, `description`, **`default_capacity`** (default seat count for new scheduled classes), **`color`** (optional UI token), **`default_instructor_id`** (optional FK to `users`; must be an active member of the same studio in API rules), `deleted_at` (soft delete). Migration: `20260512140000_phase2b_class_template_schedule_fields`.

- **ScheduledClass** (`scheduled_classes`) — see Phase 2B. Bookings only allowed when `status = SCHEDULED` and start time is in the future.

- **Booking** (`bookings`) — `studio_id`, `scheduled_class_id`, `user_id`, `status`, optional `cancel_source` / `cancelled_at`. **No hard deletes** in Phase 2C: cancel updates status to `CANCELLED` only.

### One CONFIRMED booking per member per class

Partial unique index `bookings_one_confirmed_per_user_per_class_idx` on `(studio_id, scheduled_class_id, user_id)` **where `status = 'CONFIRMED'`** (see init migration). API maps duplicate insert (**P2002**) to HTTP **409** “Already booked for this class”.

### Advisory lock (API)

Booking creation runs in a transaction and calls **`pg_advisory_xact_lock((hashtext(...))::bigint)`** so capacity checks and insert serialize per class. This is the **only** intentional raw SQL path in the booking flow.

## Membership plans

- **MembershipPlan** (`membership_plans`) — Belongs to `studio_id`. Fields include `price_cents`, `currency`, `billing_interval`, `active`, `deleted_at` (soft delete).

### `class_credits`

Column **`class_credits`** (`classCredits` in Prisma) was added in the same migration as `STAFF`. Type: nullable integer.

- **`NULL`** — treated as **unlimited** class credits for the plan (product semantics in the API).
- **Non-null** — finite credit allowance for the plan.

## Subscriptions (summary)

- **Subscription** — Belongs to `studio_id` / member / plan; Stripe ids stored but not exposed on member directory endpoints.

## Other domain tables

- **WaitlistEntry**, **Attendance**, etc. exist in Prisma for later phases. Row-level **`studio_id`** scoping applies where modeled.

## Critical constraints

- Studio-owned rows are tied to `studio_id` where applicable.
- **No hard deletes** for tenant-facing entities in Phase 2A–2C flows; use `deleted_at` (and plan `active` flags where applicable). Scheduled classes are **cancelled in place** (`status = CANCELLED`), not removed. Bookings are **cancelled in place** (`status = CANCELLED`), not removed.

## Related docs

- `docs/API_CONTRACTS.md` — HTTP routes and guard/role expectations.
- `docs/ARCHITECTURE.md` — Multi-tenant strategy and module layout.
