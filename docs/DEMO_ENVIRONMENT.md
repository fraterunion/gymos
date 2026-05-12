# Demo & pilot data (GymOS)

This document describes the **Prisma seed** in `apps/api/prisma/seed.ts`: two white-label studios (**ARES Fitness**, **Pilates Toluca**), realistic schedules, roles, billing-shaped rows with **fake Stripe identifiers only**, and a **single shared demo password** for local or private pilot machines.

**This is not Stripe test mode:** rows like `cus_demo_*` / `price_demo_*` are placeholders for UI and API shape only. For **real** Checkout, webhooks, and `sub_…` IDs, use a separate lane documented in [`STRIPE_TEST_MODE_PILOT.md`](./STRIPE_TEST_MODE_PILOT.md) (`sk_test_`, real test prices created or synced by the API). The seed file is **unchanged** in Phase 7A — do not replace fake IDs with live keys in seed data.

**Related:** [`WHITE_LABEL_BUILDS.md`](./WHITE_LABEL_BUILDS.md) (mobile `EXPO_PUBLIC_STUDIO_SLUG`), [`PRODUCTION_CHECKLIST.md`](./PRODUCTION_CHECKLIST.md) (never treat demo as production), [`PRODUCTION_DEPLOYMENT.md`](./PRODUCTION_DEPLOYMENT.md), [`STRIPE_TEST_MODE_PILOT.md`](./STRIPE_TEST_MODE_PILOT.md).

---

## Security warnings

- **Do not** expose a database seeded with these accounts on a **public URL** without network access controls. The demo password is documented below and is trivial to guess.
- **Do not** use demo Stripe IDs (`cus_demo_*`, `sub_demo_*`, `pi_demo_*`, etc.) in **live** Stripe Dashboard or production API env expecting real webhooks to reconcile.
- **Do not** confuse this seed with **Stripe test mode** — for real `sk_test_` Checkout + webhooks, follow [`STRIPE_TEST_MODE_PILOT.md`](./STRIPE_TEST_MODE_PILOT.md) on a suitable database/env.
- **Do not** run `prisma migrate reset` or re-seed against **production** or any database containing real member data.

---

## Shared demo password

All seeded users share the same password (bcrypt-hashed in the database):

**`DemoGymOS2026!`**

This is **intentionally weak** and **public** — suitable only for local dev, CI, or a **private** demo environment behind VPN / IP allowlist.

---

## Studios

| Studio | Slug | Mobile env (`EXPO_PUBLIC_STUDIO_SLUG`) |
|--------|------|----------------------------------------|
| ARES Fitness | `ares-fitness` | Matches `apps/mobile/env/.env.ares.example` |
| Pilates Toluca | `pilates-toluca` | Matches `apps/mobile/env/.env.pilates-toluca.example` |

Branding includes display name, primary/secondary colors, support contacts, placeholder legal URLs, and sample logo image URLs (Unsplash — replace for real clients).

---

## Demo accounts (password: `DemoGymOS2026!`)

### ARES Fitness (`ares-fitness`)

| Email | Role | Notes |
|-------|------|--------|
| `admin@ares.demo` | ADMIN | Admin / owner-style access for API + desk tests |
| `staff@ares.demo` | STAFF | Front desk; used as manual check-in actor in seed attendance |
| `instructor@ares.demo` | INSTRUCTOR | Default instructor on templates & scheduled classes |
| `member1@ares.demo` … `member6@ares.demo` | MEMBER | Bookings, waitlist, cancellations, promoted waitlist narrative |

### Pilates Toluca (`pilates-toluca`)

| Email | Role | Notes |
|-------|------|--------|
| `owner@pilates.demo` | OWNER | Studio owner |
| `admin@pilates.demo` | ADMIN | Staff admin |
| `instructor@pilates.demo` | INSTRUCTOR | Reformer + mat classes |
| `member1@pilates.demo` | MEMBER | Active subscription |
| `member2@pilates.demo` | MEMBER | Canceled subscription (history) |

---

## What the seed creates

- **Membership plans** per studio (unlimited / credit packs; MXN for Pilates) with **fake** `stripeProductId` / `stripePriceId` where applicable.
- **Subscriptions:** active, one **PAST_DUE** (ARES), one **CANCELED** (Pilates) with fake `stripeSubscriptionId`.
- **Payments:** at least one **SUCCEEDED** row with fake `stripePaymentIntentId` / `stripeInvoiceId`.
- **Scheduled classes** for roughly the **next 7 days** (plus same window pattern), three templates at ARES (Power Hour, MetCon, Mobility), two at Pilates (Reformer, Mat).
- **Full MetCon class:** capacity **3**, three **CONFIRMED** bookings, two **WAITING** waitlist entries.
- **Power Hour scenario:** one **MEMBER-cancelled** booking, multiple confirmed seats, one **PROMOTED** waitlist entry plus **CONFIRMED** booking for the promoted member.
- **Past completed class** with **attendance** (QR + manual with `staff@ares.demo` as recorder) where a past instance exists relative to seed time.

Times are generated from the **host clock** when the seed runs (wall-clock `Date`); they are not timezone-perfect for every city but are fine for UX and flow testing.

---

## Fake Stripe identifiers

All `stripeCustomerId`, `stripeSubscriptionId`, `stripePaymentIntentId`, `stripeInvoiceId`, and catalog-style `prod_demo_*` / `price_demo_*` values are **placeholders**. They let you exercise UI and API paths that display or join on these fields without calling Stripe. **Stripe’s API will not recognize them.**

---

## Running and resetting the seed

**Prerequisites:** `DATABASE_URL` pointing at a **disposable** Postgres (local Docker, Neon branch, etc.).

From monorepo root:

```bash
# Apply migrations, then seed (destructive reset = drop all + migrate + seed)
pnpm --filter api exec prisma migrate reset --force

# Or keep schema and only re-run seed (seed.ts clears prior demo rows first)
pnpm --filter api exec prisma db seed
```

From `apps/api` with `.env` loaded:

```bash
pnpm exec prisma db seed
```

**Help banner** (prints warnings only, does not modify data):

```bash
pnpm --filter api demo:reset-help
```

---

## Idempotent demo cleanup

`seed.ts` begins by removing data for slugs `ares-fitness`, `pilates-toluca`, and legacy `gymos-dev`, and users whose emails end with `@ares.demo`, `@pilates.demo`, or `@gymos.local`. Then it recreates the full demo graph. **Non-demo rows** in the same database are left untouched unless they collide on unique fields (unlikely if you only use demo emails for demo users).

---

## Flows to test end-to-end

- **Branding:** `GET /api/v1/public/studios/:slug/branding` for `ares-fitness` and `pilates-toluca`.
- **Auth:** login as any row above; `GET /api/v1/auth/me`.
- **Member:** schedule, bookings, waitlist, class detail (ARES MetCon full + waitlist; Power Hour cancel + promote narrative).
- **Staff / admin:** login as `staff@ares.demo` or `admin@*.demo`; desk flows against API (see `docs/ADMIN.md`).
- **Billing-shaped data:** subscription and payment rows exist; **Checkout** still requires real Stripe test mode if you want a live round-trip.

---

## Pilot demo & QA (Phase 6D)

- **Sales / walkthrough script** — [`PILOT_DEMO_SCRIPT.md`](./PILOT_DEMO_SCRIPT.md).
- **Pre-demo QA checklist** — [`PILOT_QA_CHECKLIST.md`](./PILOT_QA_CHECKLIST.md) (seed, ARES/Pilates branding, mobile, desk, Stripe caveat, devices).

## Stripe test-mode pilot (Phase 7A)

- **Real test keys + webhooks** (separate from fake seed IDs) — [`STRIPE_TEST_MODE_PILOT.md`](./STRIPE_TEST_MODE_PILOT.md).

---

## Recommended next phase

- Optional **Stripe test mode** checkout smoke using **test** keys and real test prices, separate from this static seed.
- Per-tenant **seed profiles** (minimal vs full) for faster CI.
