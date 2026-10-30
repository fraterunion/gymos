# ARES — open required deliverables: expiration alerts and member push messaging

**Status: REQUIRED, NOT IMPLEMENTED, NOT ACCEPTED AS OUT OF SCOPE.** Both items are part of the
ARES operational requirements. PR #5 does not deliver them, and nothing in PR #5 should be read as
completing them. Whether PR #5 may ship before them is an owner decision recorded separately.

## 1. Configurable membership-expiration alerts

### Requirement (as understood — confirm the open questions below)
Members are told, ahead of time, that their membership is about to end, on a schedule the studio
configures; staff see the same upcoming expirations.

### What exists today (verified in code)
- **Staff only:** the API derives an `ENDING` lifecycle status and `ENDING_7D` / `ENDING_SOON`
  attention items (fixed 7-day window) shown in the admin member list and Member 360.
- **No member notification of any kind** before or at expiry. The only transactional email is
  password reset; Communications campaigns are manual, owner-confirmed broadcasts.
- **No configuration:** no per-studio or per-plan setting for when, how, or whether to alert.

### Gaps to build
1. Studio settings: enabled flag, lead times (e.g. 7 / 3 / 1 days before, and on the day), channels
   (email now; push once §2 exists), per-plan opt-out (e.g. fixed-duration programs), message copy
   with safe placeholders (member first name, plan, end date in the studio time zone).
2. A scheduled job that finds memberships whose **effective end** (entitlement end for
   fixed-duration plans, period end otherwise) falls on a configured lead day in the studio's
   time zone, and **skips** memberships that will renew automatically (Stripe, not set to cancel),
   are already renewed, or have a successor scheduled.
3. Idempotent delivery: one alert per membership per lead time, recorded in a ledger with a unique
   key (subscription, lead time, period end), so restarts and retries never send twice.
4. Suppression and consent: honour the existing email suppressions and unsubscribes; transactional
   vs marketing classification to be decided by the owner (affects whether unsubscribe applies).
5. Admin: settings screen, preview of who would be alerted in the next N days, delivery log.
6. Kill switch (environment flag, default off) and a dry-run mode that records without sending.

### Open questions for the owner
Lead times; which plans; email copy; whether staff also receive a digest; whether expired members
get an "expired" follow-up; transactional or marketing classification.

## 2. Member push messaging

### Requirement (as understood — confirm the open questions below)
Staff can reach members with push notifications in the ARES app (and §1 alerts can use push).

### What exists today (verified in code)
- **No member push channel.** The mobile app does not include `expo-notifications`; there is no
  device push-token registration endpoint or table; the API has no Expo/FCM/APNs sender for app
  notifications. Communications is email-only.
- The only APNs code is Apple Wallet pass updates (PassKit), which cannot carry messages.

### Gaps to build
1. **Mobile (native change):** add `expo-notifications` (and its config plugin), permission prompt
   at a sensible moment, token registration on login / token refresh, deregistration on logout.
   This adds a native module, so it **requires new App Store and Play Store builds**; it cannot be
   delivered by OTA (`runtimeVersion` follows the app version). Needs the APNs key for the ARES
   bundle and Android FCM credentials configured in EAS — handled through EAS secrets, never in the
   repository.
2. **API:** device-token model (user, studio, platform, token, last seen, disabled-at), register /
   unregister endpoints scoped to the member's studio, an Expo push sender with batching, receipt
   polling, and automatic disabling of invalid tokens.
3. **Communications integration:** push as a campaign channel with the same safety model as email
   — preview, exact recipient snapshot, OWNER/ADMIN confirm, idempotent create, per-member opt-out,
   worker kill switch, no automatic sends.
4. **Preferences:** member-side toggle (push opt-out), honoured by campaigns and alerts.
5. Tests: token lifecycle, studio scoping, opt-out, idempotent delivery, invalid-token cleanup.

### Open questions for the owner
Which messages go by push (campaigns, expiration alerts, class changes/cancellations); quiet
hours; whether class cancellations should notify booked members (today they are not notified).

## Delivery plan (separate PRs after PR #5, each behind a default-off flag)

1. **Expiration alerts — email first:** settings + scheduler + ledger + admin preview/log; release
   with alerts disabled, dry-run in production, then enable for one plan.
2. **Push foundation:** device tokens API + mobile registration; new store builds; no sends.
3. **Push delivery:** sender, campaign channel and alert channel; internal-only test devices first.

Each step follows the same gates as PR #5: CI green on the exact SHA, rehearsal walkthrough, owner
approval before production configuration, migration, merge, store submission or OTA.
