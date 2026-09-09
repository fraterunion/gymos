import { SubscriptionStatus } from '@prisma/client';
import {
  candidateWindowCovers,
  collapseConsumptionRows,
  eventBelongsToSubscription,
  resolveLegacyEventOwner,
} from './legacy-usage-attribution';
import type {
  CanonicalConsumptionEvent,
  ConsumptionLegRow,
  LegacyOwnershipCandidate,
} from './legacy-usage-attribution';

const T = new Date('2026-09-10T12:00:00Z');
const BEFORE_T = new Date('2026-09-01T00:00:00Z');
const AFTER_T = new Date('2026-10-01T00:00:00Z');

function leg(overrides: Partial<ConsumptionLegRow>): ConsumptionLegRow {
  return {
    classId: 'class-1',
    startsAt: T,
    classTemplateId: 'tpl-strength',
    templateCategory: null,
    source: 'booking',
    subscriptionId: null,
    ...overrides,
  };
}

function candidate(overrides: Partial<LegacyOwnershipCandidate>): LegacyOwnershipCandidate {
  return {
    id: 'sub-full',
    status: SubscriptionStatus.ACTIVE,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    currentPeriodStart: BEFORE_T,
    currentPeriodEnd: AFTER_T,
    entitlementEndsAt: null,
    membershipPlan: {
      classCredits: null,
      allClassesAccess: false,
      allowedCategories: [],
      allowedTemplateIds: ['tpl-strength'],
    },
    ...overrides,
  };
}

function event(overrides: Partial<CanonicalConsumptionEvent> = {}): CanonicalConsumptionEvent {
  return {
    classId: 'class-1',
    startsAt: T,
    classTemplateId: 'tpl-strength',
    templateCategory: null,
    attributedSubscriptionId: null,
    ...overrides,
  };
}

// ── Canonical event collapse (matrix D–H, Q/R precedence) ─────────────────────

describe('collapseConsumptionRows — one canonical event per class', () => {
  it('D: Booking NULL + Attendance NULL → one legacy event', () => {
    const { events, conflicts } = collapseConsumptionRows([
      leg({ source: 'booking' }),
      leg({ source: 'attendance' }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]!.attributedSubscriptionId).toBeNull();
    expect(conflicts).toHaveLength(0);
  });

  it('E: Booking explicit + Attendance NULL → the explicit subscription owns the event', () => {
    const { events } = collapseConsumptionRows([
      leg({ source: 'booking', subscriptionId: 'sub-a' }),
      leg({ source: 'attendance' }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]!.attributedSubscriptionId).toBe('sub-a');
  });

  it('F: Booking NULL + Attendance explicit → the explicit subscription owns the event', () => {
    const { events } = collapseConsumptionRows([
      leg({ source: 'booking' }),
      leg({ source: 'attendance', subscriptionId: 'sub-b' }),
    ]);
    expect(events[0]!.attributedSubscriptionId).toBe('sub-b');
  });

  it('G: Booking explicit A + Attendance explicit A → ONE event for A, no conflict', () => {
    const { events, conflicts } = collapseConsumptionRows([
      leg({ source: 'booking', subscriptionId: 'sub-a' }),
      leg({ source: 'attendance', subscriptionId: 'sub-a' }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]!.attributedSubscriptionId).toBe('sub-a');
    expect(conflicts).toHaveLength(0);
  });

  it('conflicting explicit attributions → booking wins deterministically, conflict surfaced, never double-charged', () => {
    const { events, conflicts } = collapseConsumptionRows([
      leg({ source: 'booking', subscriptionId: 'sub-a' }),
      leg({ source: 'attendance', subscriptionId: 'sub-b' }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]!.attributedSubscriptionId).toBe('sub-a');
    expect(conflicts).toEqual([
      { classId: 'class-1', bookingSubscriptionId: 'sub-a', attendanceSubscriptionId: 'sub-b' },
    ]);
  });

  it('two different classes stay two events', () => {
    const { events } = collapseConsumptionRows([
      leg({ classId: 'class-1' }),
      leg({ classId: 'class-2' }),
    ]);
    expect(events).toHaveLength(2);
  });
});

// ── Candidate windows (H, N, O, P boundaries, SCHEDULED exclusion) ────────────

describe('candidateWindowCovers — static historical eligibility', () => {
  it('H: a subscription whose window starts after the class does not cover it', () => {
    expect(candidateWindowCovers(candidate({ currentPeriodStart: AFTER_T }), T)).toBe(false);
  });

  it('N: CANCELED-but-entitled covers via entitlementEndsAt', () => {
    const c = candidate({
      status: SubscriptionStatus.CANCELED,
      currentPeriodEnd: BEFORE_T,
      entitlementEndsAt: AFTER_T,
    });
    expect(candidateWindowCovers(c, T)).toBe(true);
  });

  it('O: fixed-duration window uses entitlementEndsAt as the end bound', () => {
    const c = candidate({ entitlementEndsAt: BEFORE_T });
    expect(candidateWindowCovers(c, T)).toBe(false);
  });

  it('P: renewal boundary — end bound is exclusive, start bound inclusive', () => {
    const c = candidate({ currentPeriodStart: T, currentPeriodEnd: AFTER_T });
    expect(candidateWindowCovers(c, T)).toBe(true);
    const prevCycle = candidate({ currentPeriodStart: BEFORE_T, currentPeriodEnd: T });
    expect(candidateWindowCovers(prevCycle, T)).toBe(false);
  });

  it('SCHEDULED successors never cover (they never granted access)', () => {
    expect(candidateWindowCovers(candidate({ status: SubscriptionStatus.SCHEDULED }), T)).toBe(false);
  });
});

// ── Deterministic owner (I, J, K, L, M, U, V) ─────────────────────────────────

describe('resolveLegacyEventOwner — exactly one static owner', () => {
  const fullUnlimited = candidate({ id: 'sub-full' });
  const bootyCredits = candidate({
    id: 'sub-booty',
    createdAt: new Date('2026-09-05T00:00:00Z'),
    entitlementEndsAt: new Date('2026-09-20T00:00:00Z'),
    membershipPlan: {
      classCredits: 4,
      allClassesAccess: false,
      allowedCategories: [],
      allowedTemplateIds: ['tpl-booty'],
    },
  });

  it('V: zero covering candidates → null owner (event contributes to no ledger)', () => {
    expect(resolveLegacyEventOwner(event(), [candidate({ currentPeriodStart: AFTER_T })])).toBeNull();
  });

  it('single candidate owns its own history (single-membership compatibility)', () => {
    expect(resolveLegacyEventOwner(event(), [fullUnlimited])).toBe('sub-full');
  });

  it('U: candidates lacking class access are dispreferred — the qualifying plan owns the event', () => {
    // Booty does not include tpl-strength; Full does → Full owns it.
    expect(resolveLegacyEventOwner(event(), [bootyCredits, fullUnlimited])).toBe('sub-full');
    // And a booty-template event goes to Booty even though Full is unlimited.
    expect(
      resolveLegacyEventOwner(event({ classTemplateId: 'tpl-booty' }), [fullUnlimited, bootyCredits]),
    ).toBe('sub-booty');
  });

  it('U-fallback: when NO candidate has class access, window-covering candidates still own history', () => {
    expect(resolveLegacyEventOwner(event({ classTemplateId: 'tpl-other' }), [fullUnlimited])).toBe('sub-full');
  });

  it('J: unlimited + credit-limited both qualifying → unlimited owns (never burns scarce credits)', () => {
    const fullAll = candidate({ id: 'sub-full', membershipPlan: { classCredits: null, allClassesAccess: true, allowedCategories: [], allowedTemplateIds: [] } });
    const bootyAll = candidate({ id: 'sub-booty', membershipPlan: { classCredits: 4, allClassesAccess: true, allowedCategories: [], allowedTemplateIds: [] } });
    expect(resolveLegacyEventOwner(event(), [bootyAll, fullAll])).toBe('sub-full');
  });

  it('K: two credit-limited plans → soonest-ending entitlement owns', () => {
    const endsSoon = candidate({ id: 'sub-soon', entitlementEndsAt: new Date('2026-09-15T00:00:00Z'), membershipPlan: { classCredits: 4, allClassesAccess: true, allowedCategories: [], allowedTemplateIds: [] } });
    const endsLater = candidate({ id: 'sub-later', entitlementEndsAt: new Date('2026-11-01T00:00:00Z'), membershipPlan: { classCredits: 12, allClassesAccess: true, allowedCategories: [], allowedTemplateIds: [] } });
    expect(resolveLegacyEventOwner(event(), [endsLater, endsSoon])).toBe('sub-soon');
  });

  it('L/M: full ties fall to createdAt then id — stable and input-order independent', () => {
    const shared = { classCredits: 4, allClassesAccess: true, allowedCategories: [], allowedTemplateIds: [] };
    const a = candidate({ id: 'sub-a', createdAt: new Date('2026-01-01T00:00:00Z'), membershipPlan: shared });
    const b = candidate({ id: 'sub-b', createdAt: new Date('2026-01-01T00:00:00Z'), membershipPlan: shared });
    expect(resolveLegacyEventOwner(event(), [b, a])).toBe('sub-a');
    expect(resolveLegacyEventOwner(event(), [a, b])).toBe('sub-a');
  });

  it('the owner rule ignores remaining credits by construction (no credit input exists)', () => {
    // Structural proof: LegacyOwnershipCandidate carries no usage/remaining-credit field;
    // identical candidates with different (hypothetical) usage cannot diverge.
    const owner1 = resolveLegacyEventOwner(event(), [fullUnlimited, bootyCredits]);
    const owner2 = resolveLegacyEventOwner(event(), [fullUnlimited, bootyCredits]);
    expect(owner1).toBe(owner2);
  });
});

// ── Query symmetry (matrix I core + §6) ───────────────────────────────────────

describe('eventBelongsToSubscription — query symmetry', () => {
  const fullUnlimited = candidate({ id: 'sub-full', membershipPlan: { classCredits: null, allClassesAccess: true, allowedCategories: [], allowedTemplateIds: [] } });
  const bootyCredits = candidate({ id: 'sub-booty', entitlementEndsAt: new Date('2026-09-20T00:00:00Z'), membershipPlan: { classCredits: 4, allClassesAccess: true, allowedCategories: [], allowedTemplateIds: [] } });
  const candidates = [fullUnlimited, bootyCredits];

  it('I/§6: a legacy NULL event inside BOTH windows lands in exactly one ledger, whichever side queries', () => {
    const e = event();
    const inFull = eventBelongsToSubscription(e, 'sub-full', candidates);
    const inBooty = eventBelongsToSubscription(e, 'sub-booty', candidates);
    expect([inFull, inBooty].filter(Boolean)).toHaveLength(1);
    expect(inFull).toBe(true); // unlimited-first precedence, same as booking-time selection
  });

  it('Q/R: explicit attribution is authoritative — never re-inferred, never redistributed', () => {
    const e = event({ attributedSubscriptionId: 'sub-booty' });
    expect(eventBelongsToSubscription(e, 'sub-booty', candidates)).toBe(true);
    expect(eventBelongsToSubscription(e, 'sub-full', candidates)).toBe(false);
  });

  it('W (Ivonne shape): Pro CORE credits + Booty NULL credits — one legacy event, one owner, both query directions agree', () => {
    const pro = candidate({ id: 'sub-pro', entitlementEndsAt: null, currentPeriodEnd: AFTER_T, membershipPlan: { classCredits: 5, allClassesAccess: true, allowedCategories: [], allowedTemplateIds: [] } });
    const booty = candidate({ id: 'sub-booty', entitlementEndsAt: new Date('2026-09-20T00:00:00Z'), membershipPlan: { classCredits: 4, allClassesAccess: true, allowedCategories: [], allowedTemplateIds: [] } });
    const e = event();
    const owners = ['sub-pro', 'sub-booty'].filter((id) => eventBelongsToSubscription(e, id, [pro, booty]));
    expect(owners).toHaveLength(1);
    // Both credit-limited: soonest-ending entitlement (Booty, Sep 20) owns it.
    expect(owners[0]).toBe('sub-booty');
  });
});
