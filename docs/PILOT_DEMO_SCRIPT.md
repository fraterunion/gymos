# Pilot demo script (sales & gym owners)

Use for **live or screen-share demos** (~6–10 minutes). Pair with seeded data in [`DEMO_ENVIRONMENT.md`](./DEMO_ENVIRONMENT.md) and QA ticks in [`PILOT_QA_CHECKLIST.md`](./PILOT_QA_CHECKLIST.md).

**Prep:** API running with seed; mobile **ARES** build (`WHITELABEL_PROFILE=ares`); admin at `NEXT_PUBLIC_API_URL` with CORS; second mobile build or profile switch for **Pilates Toluca** at the end.

---

## 1. Opening (30–45s)

> “Most boutique studios are stuck between paper schedules and one-size consumer apps that do not match their brand. We built a **white-label member experience** plus a **simple staff desk** on one modern backend—so each gym keeps their identity, and owners get bookings, waitlists, and attendance in one place.”

Pause for questions; set expectation: **demo data**, not production payments unless Stripe is explicitly configured.

---

## 2. White-label branding (45s)

Open the **ARES** member app cold start.

> “Notice there is no generic app name here—this is **ARES Fitness**: colors, logo, and tone come from the studio’s public branding feed. Every client ships their **own** App Store listing and bundle ID; the same platform powers the next example you will see.”

Point at home/schedule chrome matching brand.

---

## 3. Member journey — ARES (4–5 min)

**Login:** `member1@ares.demo` / password from [`DEMO_ENVIRONMENT.md`](./DEMO_ENVIRONMENT.md).

> “Members sign in once; the app stays scoped to **this** studio build.”

**Schedule:** open **Schedule**, scroll upcoming week.

> “Classes are driven by the studio schedule you maintain—members see what is next, not a static marketing page.”

**Book:** pick an open class → **Book**.

> “Booking writes through the API with capacity rules—no double-booking the same slot.”

**Waitlist:** open the seeded **full MetCon** (capacity 3, already booked in seed) or any full class.

> “When a class fills, we capture **demand** instead of losing it—waitlist is first-class, not a spreadsheet.”

**QR:** **Bookings** tab → **Check-in QR** on a confirmed booking.

> “Check-in is a short-lived QR the member shows at the desk—no paper sign-in sheets.”

**Staff desk (browser):** log in as `staff@ares.demo` or `admin@ares.demo` → **Check-in** → pick the same class → **paste QR** or **manual check-in**.

> “Front desk uses a lightweight web desk—same API, no separate database.”

**Attendance:** on the class workspace, show the attendance list updating.

> “You get a simple roster truth: who was in the room.”

**Membership / billing:** member app → **Membership** tab.

> “Plans and subscription state live here. In production, **Stripe Checkout and the billing portal** hook in with your real products; in this demo, IDs in the database may be placeholders. For a **real card-free test run**, we wire **`sk_test_`** and webhooks separately—see our Stripe test-mode pilot doc.”

Reference: [`STRIPE_TEST_MODE_PILOT.md`](./STRIPE_TEST_MODE_PILOT.md).

---

## 4. Second white-label — Pilates Toluca (90s)

Switch build or profile to **Pilates Toluca** (`pilates-toluca` slug) and cold-open again.

> “Same engine, **different** studio: name, palette, and schedule are independent. That is how we scale to many locations without cloning engineering for each gym.”

Quick login as `member1@pilates.demo`, show schedule + one membership screen difference.

---

## 5. Close — business value (45s)

> “You get **branded retention**—members live in your app, not a generic aggregator. Staff get a **desk that matches check-in reality**. Owners get **one place** for schedule, demand, and attendance. We can pilot with your timetable and branding when you are ready.”

Offer next step: **private pilot** on staging, **REAL_DEVICE_TESTING** pass, then Stripe test mode for money path.

---

## Demo don’ts

- Do **not** imply App Store submission or push notifications are included today.
- Do **not** run demo accounts on a **public** production URL without access controls ([`DEMO_ENVIRONMENT.md`](./DEMO_ENVIRONMENT.md)).
- Do **not** claim live payments unless Stripe test/live is actually wired for that environment.
