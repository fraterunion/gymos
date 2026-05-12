# Real-device testing (pilot QA)

Run on **physical** iOS and Android devices against **staging** first, then **production** when approved. Simulators do not replace checks for secure storage, deep links, or network edge cases.

**Related:** [`PRODUCTION_CHECKLIST.md`](./PRODUCTION_CHECKLIST.md), [`MOBILE.md`](./MOBILE.md), [`ADMIN.md`](./ADMIN.md).

---

## Devices & setup

- [ ] **iOS** — physical iPhone; production or TestFlight build; date/time correct.
- [ ] **Android** — physical device; internal track or Play testing build.
- [ ] **API** — `EXPO_PUBLIC_API_URL` / admin URL point at environment under test.
- [ ] **Stripe** — test vs live mode matches build intent (no accidental live charges on dev builds).

---

## Auth & session

- [ ] **Register** (if enabled) or **login** with pilot account.
- [ ] **Kill app** completely → relaunch → **session restores** via refresh token (Expo SecureStore path).
- [ ] **Logout** clears session; login again works.

---

## Branding & tenant

- [ ] **Branding boot** completes for `EXPO_PUBLIC_STUDIO_SLUG` (or controlled error if slug wrong).
- [ ] **Member studio match** — user is member of configured studio; schedule loads.

---

## Billing & deep links

- [ ] **Stripe Checkout** — start from Membership; complete or cancel; **return URL** opens correct screen ([`MOBILE.md`](./MOBILE.md) Phase 4C).
- [ ] **Billing portal** — open, change nothing or safe change, **return** refreshes state.
- [ ] **Deep links** — cold start via `billing/success` / `billing/return` links (scheme matches production `APP_SCHEME`).

---

## Schedule, booking, waitlist

- [ ] **Schedule** loads; pull to refresh.
- [ ] **Book** a class; appears under My bookings.
- [ ] **Cancel** booking if policy allows.
- [ ] **Waitlist** — join when class full; cancel waitlist if applicable.

---

## QR (member + staff)

- [ ] **Member:** open **Check-in QR** inside window; code renders; refresh behavior sane.
- [ ] **Staff:** use **admin** desk flow — **paste QR** or **manual check-in** against same booking ([`ADMIN.md`](./ADMIN.md)).

---

## Poor network & resilience

- [ ] **Airplane mode toggle** during schedule load → graceful error; retry succeeds.
- [ ] **401 refresh** — force access token expiry (long idle) if testable; single-flight refresh does not loop.
- [ ] **Stripe in browser** — checkout with intermittent network; return to app still handled (may need manual refresh per product copy).

---

## Sign-off

- [ ] Tester name + device model + OS version + build id recorded.
- [ ] Blockers filed before production pilot.
