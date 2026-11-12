# Open Gym entitlement

**One rule:** a member has Open Gym if, and only if, at least one of their *currently entitled*
subscriptions is on a plan whose saved `MembershipPlan.openGymAccess` is `true` (Admin →
Membresías → editar plan → **Incluye Open Gym**), and — if that plan has an Open Gym window —
the relevant instant falls inside it (studio-local, `[start, end)`).

Nothing else grants Open Gym: not `allClassesAccess` ("Todas las clases"), not an Open Gym
template in the plan's class list, not plan names, not plan descriptions.

## Where the rule is enforced (server side)

| Path | Code | Instant evaluated |
|---|---|---|
| Door scan without reservation (wallet credential) → `OPEN_GYM` attendance | `CheckInsService.checkInOpenGym` | scan time |
| Book an Open Gym slot (`ClassTemplate.isOpenGymSlot`), waitlist join + promotion | `BookingAccessService.assertAccess` | slot start |
| Staff "book on behalf" | `MembersService.staffCreateBooking` | slot start |
| Front Desk walk-in attendance into an Open Gym slot | `CheckInsService.registerManualClassAttendance` | slot start |
| Check-in of an existing Open Gym slot reservation (booking QR, manual, wallet) | `CheckInsService.assertBookingAndClassEligibleForCheckIn` → `evaluateOpenGymSlotAccess` | membership now, hours at slot start |
| Walk-in candidates offered after a door denial | `CheckInsService.resolveWalkInCandidates` | slot start |

The pure policy lives in `apps/api/src/check-ins/open-gym-access.ts`; the DB loader shared by
every path is `apps/api/src/check-ins/open-gym-entitlement.ts`. The class-access rule
`isClassIncludedInPlan` requires `openGymAccess` + `templateIsOpenGymSlot`, so a new caller
cannot compile without deciding Open Gym explicitly. `isClassInPlanClassList` (class list only)
exists solely for historical credit attribution and is not an authorization decision.

Entitlement is never cached: every decision reads the plan row, so an Admin toggle change
applies to the next request.

Unchanged by design:
- Staff roles (STAFF/INSTRUCTOR/ADMIN/OWNER) bypass entitlement, as for any class.
- The ADMIN/OWNER entitlement override (mandatory reason, audit log) still works for Open Gym
  slots. It is an explicit, audited exception, not a client bypass.
- A Day Pass can book/check into an Open Gym slot only if the Admin's Day Pass allowlist
  includes that template (Admin → Day Pass).
- Ordinary classes: booking, credits, check-in rules are identical.

## Existing reservations and history

A reservation on an Open Gym slot that is no longer covered (toggle off, membership expired /
cancelled / paused) is **not** cancelled or deleted. It stays `CONFIRMED`, and check-in is refused
with the same `409 WALLET_OPEN_GYM_*` / `WALLET_MEMBERSHIP_NOT_ENTITLED` body the door uses, which
the deployed staff app already renders. Turning the toggle back on restores it. Historical
attendance is never modified.

To find such reservations: `scripts/ares-open-gym-entitlement-audit.ts` (read-only) lists future
Open Gym slot bookings not covered by an entitled plan. Any cancellation is a separate, approved
operation.

## Member app

`GET /studios/:id/members/me` returns `openGym: { included, membershipPlanName, windowStart,
windowEnd }`, computed by the same policy. The app shows the Open Gym card and Open Gym slots only
when `included === true` (fail-closed when absent), refreshed on screen focus. Visibility is
cosmetic; access is always decided by the API.

## Operations

- Read-only audit: `railway run --service api npx tsx scripts/ares-open-gym-entitlement-audit.ts`
- ARES configuration (dry run by default; `--apply` needs explicit confirmation):
  `scripts/ares-open-gym-plan-config.ts`
