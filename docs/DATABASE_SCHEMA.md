# Database schema

## Status

No ORM or migration layer is checked in yet. This document lists the **intended** entities and constraints so the first schema (e.g. Prisma) aligns with product decisions rather than ad hoc tables.

## Tenancy and identity

- **Studio** — The tenant. Billing profile, timezone, branding, capacity defaults.
- **User** — Login identity. Staff users are tied to studios with roles; members are tied via membership.
- **Membership** — Contract between a member and a studio: plan, status, start/end, pause rules. Links to Stripe subscription or one-off products when billing applies.

## Scheduling and inventory

- **Location** — Physical site within a studio (single-site studios still use one row for consistency).
- **ClassType** — Template (name, duration, description, default capacity).
- **Instructor** — Staff person who can lead classes; availability is modeled separately from identity.
- **ClassSession** — A scheduled instance: studio, location, type, instructor, start/end, capacity, status (scheduled, cancelled, completed).
- **Booking** — Member (or guest slot) reserved for a session. Holds state: confirmed, waitlisted, cancelled, attended, no-show.

## Check-in

- **CheckIn** — Immutable or append-only record tying member (or token), session, timestamp, and source (QR, manual staff, kiosk). Must reference valid booking or controlled walk-in policy per studio rules.

## Payments (logical, not Stripe IDs only)

- **Invoice / PaymentRecord** (names TBD at implementation) — Mirror of amounts and status for reporting; Stripe remains authoritative for card state.

## Critical constraints

- Every row that represents studio-owned business data includes `studio_id` (or is strictly global reference data with no PII).
- **Bookings** are unique per member per session for active states (no double confirm).
- **ClassSession** capacity cannot go negative; waitlist ordering is deterministic (e.g. FIFO by `created_at`).
- Cancellations respect studio-defined cutoffs; late cancels may still consume credits (product rule, enforced in API).

## Booking rules (data-level)

- A member may hold at most one active booking per session unless product explicitly allows guest add-ons as separate rows.
- Waitlist promotes automatically when a spot frees, up to capacity; promotion emits notifications (out of scope for this doc).
- Studio-defined buffers between sessions can be enforced via non-overlapping session windows per room/instructor where configured.

## What is explicitly out of scope here

- Column-level DDL, indexes, and Prisma models — added when the persistence layer lands.
- Full event-sourcing; only note that audit trails are expected for sensitive mutations.
