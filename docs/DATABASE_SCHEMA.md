# Database schema

## Status

The API uses **Prisma** with PostgreSQL (`apps/api/prisma/schema.prisma`). Migrations live under `apps/api/prisma/migrations/`. This document highlights **tenant-relevant** tables and constraints that affect API behavior; it is not a full column listing (see Prisma schema for that).

## Tenancy and identity

- **Studio** (`studios`) — Tenant root: `name`, `slug` (unique), `timezone`, `deleted_at`. **Phase 3A** nullable white-label fields: `app_name`, `brand_primary_color`, `brand_secondary_color`, `brand_logo_url`, `brand_icon_url`, `brand_splash_url`, `support_email`, `support_phone`, `privacy_url`, `terms_url`, `ios_bundle_id`, `android_package_name`, `app_store_url`, `play_store_url` (URLs only; no file storage in API). Soft delete via `deleted_at`. The HTTP **`StudioMemberGuard`** loads the studio with `deleted_at IS NULL`; **soft-deleted studios are rejected** even if a `studio_memberships` row still exists.
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

Booking creation runs in a transaction and calls **`pg_advisory_xact_lock((hashtext('booking_class_<scheduledClassId>'))::bigint)`** so capacity checks and insert serialize per class. This is the **only** intentional raw SQL path in the booking flow; the same lock key is reused for waitlist and promotion (Phase 2E).

## Membership plans

- **MembershipPlan** (`membership_plans`) — Belongs to `studio_id`. Fields include `price_cents`, `currency`, `billing_interval`, `active`, `deleted_at` (soft delete). **Phase 4A** adds nullable **`stripe_product_id`** / **`stripe_price_id`** for direct Stripe Billing sync (no Connect columns).

### `class_credits`

Column **`class_credits`** (`classCredits` in Prisma) was added in the same migration as `STAFF`. Type: nullable integer.

- **`NULL`** — treated as **unlimited** class credits for the plan (product semantics in the API).
- **Non-null** — finite credit allowance for the plan.

## Subscriptions (summary)

- **Subscription** — Belongs to `studio_id` / member / plan; **`stripe_subscription_id`** unique when set. **`current_period_start`**, **`current_period_end`**, **`cancel_at_period_end`** mirror Stripe after webhooks. Status is an app enum mapped from Stripe (see `mapStripeSubscriptionStatus` in API).

## Payments and Stripe webhooks (Phase 4A)

- **Payment** (`payments`) — `amount_cents`, `currency`, `status` (`PENDING`, `SUCCEEDED`, `FAILED`, …). Optional **`stripe_payment_intent_id`** and **`stripe_invoice_id`** (unique when non-null) for invoice-driven rows created from webhooks.
- **User** — nullable **`stripe_customer_id`** (unique when set) links the member to Stripe Customer records created at Checkout.
- **StripeWebhookEvent** (`stripe_webhook_events`) — **`stripe_event_id`** unique, **`event_type`**, **`payload`** (JSON), **`processed`** / **`processed_at`** for idempotent webhook ingestion.

## Other domain tables

- **WaitlistEntry** (`waitlist_entries`): **`position`** is monotonic (new joins use `max(position)+1` per class). Partial unique index allows at most one **`WAITING`** row per `(studio_id, scheduled_class_id, user_id)`. **`PROMOTED`** / **`CANCELLED`** / **`EXPIRED`** statuses; cancellations are status-only (no hard delete). Booking / waitlist / promotion paths share advisory lock key **`booking_class_<scheduledClassId>`** (see API contracts).
- **Attendance** (`attendances`): one row per `(scheduled_class_id, user_id)` (unique). **`checked_in_by_user_id`** optional — set for **manual** check-ins (staff who recorded). **`method`** uses `CheckInMethod` (`QR`, `MANUAL`, …).
- **QRToken** (`qr_tokens`): **`token_hash`** unique (SHA-256 of issued JWT). **`used_at`** set atomically when a QR check-in claims the row (single-use). Optional **`invalidated_at`** for future invalidation; claim requires it null. **`expires_at`** aligns with JWT expiry (5 minutes from issue).

## Critical constraints

- Studio-owned rows are tied to `studio_id` where applicable.
- **No hard deletes** for tenant-facing entities in Phase 2A–2C flows; use `deleted_at` (and plan `active` flags where applicable). Scheduled classes are **cancelled in place** (`status = CANCELLED`), not removed. Bookings are **cancelled in place** (`status = CANCELLED`), not removed.

## Related docs

- `docs/API_CONTRACTS.md` — HTTP routes and guard/role expectations.
- `docs/ARCHITECTURE.md` — Multi-tenant strategy and module layout.
