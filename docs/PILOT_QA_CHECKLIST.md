# Pilot & demo QA checklist

Run before **investor demos**, **gym owner pilots**, or **regression** after meaningful API/mobile/admin changes. Complement with [`DEMO_ENVIRONMENT.md`](./DEMO_ENVIRONMENT.md), [`REAL_DEVICE_TESTING.md`](./REAL_DEVICE_TESTING.md), and [`PILOT_DEMO_SCRIPT.md`](./PILOT_DEMO_SCRIPT.md).

---

## A. Environment & seed

- [ ] **Disposable DB** — not production; `DATABASE_URL` points at local or dedicated demo instance.
- [ ] **Seed reset** — `pnpm --filter api exec prisma db seed` (or `migrate reset` for full wipe) completed without errors; see [`DEMO_ENVIRONMENT.md`](./DEMO_ENVIRONMENT.md).
- [ ] **API + admin env** — `EXPO_PUBLIC_API_URL` / `NEXT_PUBLIC_API_URL` match the running API; CORS allows admin origin if testing browser desk.
- [ ] **Mobile profiles** — `env/.env.ares` and `env/.env.pilates-toluca` (or EAS secrets) present with correct **`EXPO_PUBLIC_STUDIO_SLUG`** (`ares-fitness`, `pilates-toluca`).

---

## B. Branding boot

- [ ] **ARES** — cold open: logo/name/colors load; no raw env-var error text on failure (retry path works after intentional offline/online test if desired).
- [ ] **Pilates Toluca** — same; visually distinct from ARES.

---

## C. Mobile — auth & shell

- [ ] **Login** — `member1@ares.demo` with demo password; session survives background/foreground (spot-check).
- [ ] **Logout / second user** — optional: `member2@ares.demo` to see different booking state.

---

## D. Mobile — schedule & class

- [ ] **Schedule tab** — future classes listed; empty state copy acceptable when no data.
- [ ] **Class detail** — times, template name, capacity/waitlist hints; **Book** succeeds when eligible.
- [ ] **Full class** — MetCon seed: class shows full; **Join waitlist** succeeds; waitlist appears under **Bookings**.
- [ ] **Subscription gate** — e.g. Pilates `member2` (canceled sub) or API path without active sub: friendly **membership** panel, not raw API jargon.

---

## E. Mobile — bookings, QR, billing

- [ ] **Bookings tab** — confirmed booking rows; **Check-in QR** opens; QR regenerates or loads without crash.
- [ ] **Waitlist row** — **WAITING** and **PROMOTED** copy readable (seed has examples on ARES).
- [ ] **Membership tab** — plans list; subscription summary when present; **Subscribe** / **Manage billing** errors are user-friendly if API misconfigured.
- [ ] **Stripe caveat** — demo seed uses **fake** `cus_` / `sub_` / `pi_` IDs; **no real money** moves unless you configure real Stripe test/live and real price IDs ([`DEMO_ENVIRONMENT.md`](./DEMO_ENVIRONMENT.md)).

---

## F. Staff desk (admin web)

- [ ] **Browser** — Chrome or Safari; login as `staff@ares.demo` or `admin@ares.demo`.
- [ ] **Studio selector** — ARES studio selected; today’s classes load.
- [ ] **Class workspace** — roster loads; **manual check-in** works for a confirmed member.
- [ ] **QR paste** — paste token from member QR flow; success or clear “already checked in” path.
- [ ] **Attendance list** — shows checked-in members after actions.

---

## G. Real-device & network (spot)

- [ ] **Physical phone** — at least one iOS or Android build from [`REAL_DEVICE_TESTING.md`](./REAL_DEVICE_TESTING.md) checklist (subset ok for timeboxed QA).
- [ ] **Poor network** — airplane mode toggle: app shows **retry-friendly** messaging, not stack traces.

---

## H. Known limitations (set expectations)

- **No push notifications**; no App Store submission in this phase.
- **Admin QR** is **paste**, not camera scan (call out in demos).
- **Checkout** requires Stripe + return URLs configured for meaningful end-to-end; demo DB alone is **not** a payment test.
- **Seed times** are relative to seed run host clock—not a substitute for production timezone QA.

---

## Sign-off

- [ ] Tester name + date + build identifiers (mobile profile, API commit, admin commit).
