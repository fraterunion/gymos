# ARES Mobile Sales / POS — OTA QA checklist

Pre-release device QA for **Mobile Sales / Checkout** (`/(app)/staff-sales`) on the **ARES** build (`EXPO_PUBLIC_STUDIO_SLUG=ares-fitness`).

**Scope:** Manual testing on physical iOS/Android after OTA (or TestFlight/internal track). Complements [`PILOT_QA_CHECKLIST.md`](./PILOT_QA_CHECKLIST.md), [`REAL_DEVICE_TESTING.md`](./REAL_DEVICE_TESTING.md), [`STRIPE_TEST_MODE_PILOT.md`](./STRIPE_TEST_MODE_PILOT.md).

**Not in scope:** Admin Web `/sales` parity (spot-check optional), backend schema changes.

---

## Prerequisites

- [ ] **OTA / build** — Mobile build includes committed Sales / POS module; channel matches environment under test.
- [ ] **API deployed** — Walk-in sales migration + sales endpoints live (`GET …/sales/settings`, `POST …/members`, checkout, offline-subscriptions, waiver attestation).
- [ ] **Stripe lane** — For real Checkout + membership activation, API uses **`sk_test_…`** + test webhook (**not** fake seed IDs). See [`STRIPE_TEST_MODE_PILOT.md`](./STRIPE_TEST_MODE_PILOT.md).
- [ ] **Waiver document** — Active Carta Responsiva on studio (`pnpm --filter api seed:ares-waiver` on prod/staging if missing).
- [ ] **Active membership plans** — At least one active plan (e.g. Full Access) with valid or auto-syncable Stripe price IDs.
- [ ] **Device** — Physical iPhone + Android; correct date/time; stable network.

---

## Test accounts & roles

Passwords below are **documented for pilot/staging**. Use production credentials from your vault for live ARES; never share production passwords in tickets.

| Role | Sales entry? | Attest waiver? | Cash (default)? | Account (environment) |
|------|--------------|----------------|-----------------|------------------------|
| **OWNER** | Yes | Yes | Yes | Production: studio owner login. Demo: *no ARES OWNER in `seed.ts`* — use prod or temporarily promote a test user. |
| **ADMIN** | Yes | Yes | Yes | Demo: `admin@ares.demo` / `DemoGymOS2026!` |
| **FRONT_DESK** | Yes | Yes | **No** (unless DB setting) | Prod: `recepcion@arestrainingclub.com` / `AresFrontDesk2026!` (`pnpm --filter api seed:ares-front-desk`). Review: `staff.review@fraterunion.com` / `Review2026!` |
| **STAFF** | **No** | No | No | Demo: `staff@ares.demo` / `DemoGymOS2026!` — **not** FRONT_DESK; confirms guard. |
| **INSTRUCTOR** | **No** | No | No | Demo: any coach e.g. `yayo@ares.demo` / `DemoGymOS2026!` |
| **MEMBER** | **No** (member tabs) | N/A | N/A | Demo: `member1@ares.demo` / `DemoGymOS2026!` |

### QA data to prepare

| Data | Purpose | How |
|------|---------|-----|
| **Existing member (waiver OK)** | Search + Stripe path | `member1@ares.demo` or any member with accepted waiver |
| **Existing member (waiver pending)** | Waiver + cash block | Member with no acceptance on active waiver version (or create walk-in) |
| **New walk-in email** | Create-customer path | Unique email e.g. `walkin.qa+{date}@example.com` |
| **FRONT_DESK cash enabled** | Cash visibility for recepción | DB upsert (no admin UI yet): set `front_desk_can_record_cash = true` on `studio_sales_settings` for ARES studio id |
| **Stripe test card** | Checkout completion | `4242 4242 4242 4242`, any future expiry, any CVC |

### Seed commands (staging / disposable DB only)

```bash
# Front desk account (production-safe upsert)
DATABASE_URL="…" pnpm --filter api seed:ares-front-desk

# Active waiver document
DATABASE_URL="…" pnpm --filter api seed:ares-waiver

# Apple review accounts (FRONT_DESK + MEMBER)
DATABASE_URL="…" pnpm --filter api seed:ares-review
```

---

## A. Entry & route guards

- [ ] **ADMIN / FRONT_DESK / OWNER** — Staff **Hoy** tab shows **Ventas / Checkout** card.
- [ ] **STAFF** — No Ventas card on Hoy; staff shell (scan/today) unchanged.
- [ ] **INSTRUCTOR** — No Ventas card; coach **Hoy** view only.
- [ ] **MEMBER** — Member tabs only; no sales entry.
- [ ] **Direct route (unauthorized)** — While logged in as STAFF or INSTRUCTOR, navigate to `/(app)/staff-sales` → **“No tienes permiso…”** + Volver (no crash).
- [ ] **Direct route (authorized)** — FRONT_DESK opens flow; header title **Ventas**.

---

## B. Step 1 — Cliente

- [ ] **Search** — Find member by **name** or **email** (phone search **not** supported by API).
- [ ] **Empty search** — Sensible empty state after search with no results.
- [ ] **Select existing** — Advances to step 2 with correct name/email.
- [ ] **Create walk-in** — Required fields validate; success advances to step 2.
- [ ] **Temp password (create only)** — Shown **once** on waiver step with security warning + **Copiar contraseña**; disappears after **Continuar** or **Atrás**.
- [ ] **FRONT_DESK create** — Works when `frontDeskCanCreateMember` true (default); if disabled in DB, **Nuevo** tab disabled.

---

## C. Step 2 — Carta responsiva

- [ ] **Waiver accepted** — Success badge; can continue without attestation.
- [ ] **Waiver pending** — Pending badge; copy explains Stripe OK, cash needs attestation.
- [ ] **Staff attestation (OWNER / ADMIN / FRONT_DESK)** — Register presencial signature; status updates to accepted.
- [ ] **Continue without waiver** — Allowed to step 3 (Stripe path); cash blocked later if still pending.

---

## D. Step 3 — Plan

- [ ] **Plans load** — Active plans as premium cards (price, interval, benefits).
- [ ] **Selection** — **Continuar** disabled until plan picked.
- [ ] **Empty plans** — Friendly empty state if no active plans.

---

## E. Step 4 — Pago

### Stripe

- [ ] **FRONT_DESK / ADMIN / OWNER** — **Stripe QR / link** chip visible when checkout allowed.
- [ ] **Generate** — Step 5 shows QR + link + share.

### Cash

- [ ] **ADMIN / OWNER** — **Efectivo** chip always visible.
- [ ] **FRONT_DESK default** — **Efectivo** chip **hidden** (`frontDeskCanRecordCash` false).
- [ ] **FRONT_DESK + setting enabled** — After DB flag true, **Efectivo** appears; record cash succeeds with waiver OK.
- [ ] **Cash + waiver pending** — **Registrar efectivo** disabled; warning visible.

---

## F. Step 5 — Confirmación (Stripe test mode)

Use **`sk_test_`** API + webhooks per [`STRIPE_TEST_MODE_PILOT.md`](./STRIPE_TEST_MODE_PILOT.md).

- [ ] **Checkout link created** — Step 5 shows non-empty URL after **Generar pago**.
- [ ] **QR renders** — Scannable QR on device screen.
- [ ] **QR / link opens** — Customer opens Stripe Checkout; page loads.
- [ ] **Pending copy** — Badge **Pago pendiente** + *“Pago pendiente — la membresía se activará automáticamente cuando Stripe confirme el pago.”*
- [ ] **Not real-time disclaimer** — Footer states consult is not guaranteed real-time.
- [ ] **Complete payment** — Test card `4242…`; webhook fires.
- [ ] **Consultar membresía** — After webhook, tap **Consultar membresía** → **Membresía activa** (retry OK if delayed).
- [ ] **Before payment** — **Consultar membresía** stays **pending** with *“Aún no detectamos…”* — **not** failure.
- [ ] **Compartir link** — Share sheet opens with checkout URL.

### Cash confirmation

- [ ] **Immediate success** — **Membresía activa** + period end without Stripe QR block.

---

## G. Flow completion

- [ ] **Nueva venta** — Resets to step 1; no stale QR/password.
- [ ] **Listo** — Returns to Hoy tab.

---

## H. Regression (same OTA build)

- [ ] **Member QR check-in** — Booking → Check-in QR renders.
- [ ] **Staff Hoy** — Classes list, summary card, roster navigation.
- [ ] **Staff scan** — QR scan tab still works for eligible roles.
- [ ] **Schedule (member)** — Filters, future classes, Open Gym copy.
- [ ] **Auth / session** — Kill app → relaunch → session restores; logout/login.

---

## Known blockers & caveats

| Item | Impact | Mitigation |
|------|--------|------------|
| **Fake seed Stripe IDs** | Checkout fails or no activation | Use **Stripe test mode** on API |
| **`staff@ares.demo` is STAFF** | Cannot test sales on default reception demo | Use `seed:ares-front-desk` or `admin@ares.demo` |
| **No ARES OWNER in demo seed** | OWNER QA needs prod account | Document prod tester |
| **No admin UI for `frontDeskCanRecordCash`** | FRONT_DESK cash test needs SQL/DB | Upsert `studio_sales_settings` |
| **No payment poll API** | Consult is best-effort | Webhook + retry |
| **Phone member search** | Not supported | Search name/email only |

---

## Sign-off

| Tester | Device / OS | Build / OTA channel | Date | Pass? |
|--------|-------------|---------------------|------|-------|
| | | | | |

Notes:
