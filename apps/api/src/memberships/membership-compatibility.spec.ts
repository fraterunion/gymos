import {
  CORE_EXCLUSIVE_GROUP,
  allowNewMembershipStacks,
  findConflictingMemberships,
  findCreationConflicts,
  isConflictingMembership,
  orderEntitlementCandidates,
  selectPrimaryMembership,
} from './membership-compatibility';

/** ARES-shaped fixtures — names are illustrative only; the logic never sees names. */
const fullAccess = { id: 'plan-full', exclusiveGroup: CORE_EXCLUSIVE_GROUP };
const basicAccess = { id: 'plan-basic', exclusiveGroup: CORE_EXCLUSIVE_GROUP };
const pro = { id: 'plan-pro', exclusiveGroup: CORE_EXCLUSIVE_GROUP };
const openGym = { id: 'plan-open-gym', exclusiveGroup: CORE_EXCLUSIVE_GROUP };
const bootyLab = { id: 'plan-booty', exclusiveGroup: null };

function owns(plan: { id: string; exclusiveGroup: string | null }) {
  return { membershipPlanId: plan.id, exclusiveGroupKey: plan.exclusiveGroup };
}

describe('membership-compatibility — canonical family rules (always on, never gated)', () => {

  it.each([
    ['Full Access', fullAccess],
    ['Basic Access', basicAccess],
    ['Pro', pro],
    ['Open Gym', openGym],
  ])('%s + Booty Lab → compatible (stackable specialty)', (_name, corePlan) => {
    expect(isConflictingMembership(owns(corePlan), bootyLab)).toBe(false);
    expect(isConflictingMembership(owns(bootyLab), corePlan)).toBe(false);
  });

  it.each([
    ['Full + Basic', fullAccess, basicAccess],
    ['Full + Pro', fullAccess, pro],
    ['Basic + Pro', basicAccess, pro],
    ['Open Gym + Full', openGym, fullAccess],
  ])('%s → conflict (same CORE exclusive group)', (_name, a, b) => {
    expect(isConflictingMembership(owns(a), b)).toBe(true);
    expect(isConflictingMembership(owns(b), a)).toBe(true);
  });

  it('Full + Full duplicate → conflict (same plan)', () => {
    expect(isConflictingMembership(owns(fullAccess), fullAccess)).toBe(true);
  });

  it('Booty + Booty duplicate → conflict even though the plan is stackable (same plan always conflicts)', () => {
    expect(isConflictingMembership(owns(bootyLab), bootyLab)).toBe(true);
  });

  it('two DIFFERENT stackable (null-group) plans are compatible', () => {
    const nutrition = { id: 'plan-nutrition', exclusiveGroup: null };
    expect(isConflictingMembership(owns(bootyLab), nutrition)).toBe(false);
  });

  it('uses the subscription SNAPSHOT (exclusiveGroupKey), never the plan\'s current group', () => {
    // Sold as stackable; the plan was later edited into CORE. The live row keeps the
    // contract it was sold under — later plan edits never re-classify existing rows.
    const soldAsStackable = { membershipPlanId: 'plan-x', exclusiveGroupKey: null };
    expect(isConflictingMembership(soldAsStackable, fullAccess)).toBe(false);
    // And the reverse: sold as CORE stays CORE-conflicting even if the plan later goes stackable.
    const soldAsCore = { membershipPlanId: 'plan-y', exclusiveGroupKey: CORE_EXCLUSIVE_GROUP };
    expect(isConflictingMembership(soldAsCore, fullAccess)).toBe(true);
  });

  it('findConflictingMemberships returns only the conflicting subset', () => {
    const rows = [
      { ...owns(fullAccess), label: 'full' },
      { ...owns(bootyLab), label: 'booty' },
    ];
    const conflicts = findConflictingMemberships(rows, basicAccess);
    expect(conflicts.map((c) => c.label)).toEqual(['full']);
  });
});

describe('membership-compatibility — MM-4 creation gate (findCreationConflicts)', () => {
  it('stacking disabled: EVERY existing membership blocks creation, even compatible ones', () => {
    const rows = [
      { ...owns(fullAccess), label: 'full' },
      { ...owns(bootyLab), label: 'booty' },
    ];
    const blockers = findCreationConflicts(rows, bootyLab, false);
    expect(blockers.map((b) => b.label)).toEqual(['full', 'booty']);
  });

  it('stacking enabled: creation is blocked only by the family conflicts', () => {
    const rows = [
      { ...owns(fullAccess), label: 'full' },
      { ...owns(bootyLab), label: 'booty' },
    ];
    expect(findCreationConflicts(rows, bootyLab, true).map((b) => b.label)).toEqual(['booty']);
    expect(findCreationConflicts(rows, basicAccess, true).map((b) => b.label)).toEqual(['full']);
  });

  it('the gate NEVER affects family scoping: isConflictingMembership has no gate parameter', () => {
    // Full + Booty stay compatible as existing rows regardless of the env flag.
    const prev = process.env['MULTI_MEMBERSHIP_ENABLED'];
    try {
      process.env['MULTI_MEMBERSHIP_ENABLED'] = 'false';
      expect(isConflictingMembership(owns(fullAccess), bootyLab)).toBe(false);
      expect(findConflictingMemberships([owns(fullAccess)], bootyLab)).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env['MULTI_MEMBERSHIP_ENABLED'];
      else process.env['MULTI_MEMBERSHIP_ENABLED'] = prev;
    }
  });

  it('allowNewMembershipStacks reads the env gate (default off)', () => {
    const prev = process.env['MULTI_MEMBERSHIP_ENABLED'];
    delete process.env['MULTI_MEMBERSHIP_ENABLED'];
    expect(allowNewMembershipStacks()).toBe(false);
    process.env['MULTI_MEMBERSHIP_ENABLED'] = 'true';
    expect(allowNewMembershipStacks()).toBe(true);
    if (prev === undefined) delete process.env['MULTI_MEMBERSHIP_ENABLED'];
    else process.env['MULTI_MEMBERSHIP_ENABLED'] = prev;
  });
});

describe('selectPrimaryMembership — canonical PRIMARY for singular API fields', () => {
  it('prefers the entitled CORE-group membership over a newer stackable one', () => {
    const core = { id: 's1', exclusiveGroupKey: CORE_EXCLUSIVE_GROUP, createdAt: new Date('2026-01-01') };
    const specialty = { id: 's2', exclusiveGroupKey: null, createdAt: new Date('2026-06-01') };
    expect(selectPrimaryMembership([specialty, core])).toBe(core);
  });

  it('falls back to newest entitled when no CORE membership exists', () => {
    const older = { id: 's1', exclusiveGroupKey: null, createdAt: new Date('2026-01-01') };
    const newer = { id: 's2', exclusiveGroupKey: null, createdAt: new Date('2026-06-01') };
    expect(selectPrimaryMembership([older, newer])).toBe(newer);
  });

  it('returns null for an empty set and is deterministic on ties', () => {
    expect(selectPrimaryMembership([])).toBeNull();
    const t = new Date('2026-01-01');
    const a = { id: 'a', exclusiveGroupKey: null, createdAt: t };
    const b = { id: 'b', exclusiveGroupKey: null, createdAt: t };
    expect(selectPrimaryMembership([b, a])).toBe(a);
    expect(selectPrimaryMembership([a, b])).toBe(a);
  });
});

describe('orderEntitlementCandidates — canonical consumption precedence', () => {
  const base = { currentPeriodEnd: new Date('2026-12-01'), entitlementEndsAt: null };

  it('unlimited memberships come first — scarce credits are never burned when unlimited covers the class', () => {
    const limited = { ...base, id: 'booty', createdAt: new Date('2026-01-02'), membershipPlan: { classCredits: 4 } };
    const unlimited = { ...base, id: 'full', createdAt: new Date('2026-06-01'), membershipPlan: { classCredits: null } };
    expect(orderEntitlementCandidates([limited, unlimited]).map((c) => c.id)).toEqual(['full', 'booty']);
  });

  it('among credit-limited, the soonest-ending entitlement is consumed first (use-it-or-lose-it)', () => {
    const endsLater = {
      id: 'later', createdAt: new Date('2026-01-01'),
      currentPeriodEnd: new Date('2026-12-01'), entitlementEndsAt: null,
      membershipPlan: { classCredits: 5 },
    };
    const endsSoon = {
      id: 'soon', createdAt: new Date('2026-01-02'),
      currentPeriodEnd: new Date('2026-10-01'), entitlementEndsAt: new Date('2026-09-15'),
      membershipPlan: { classCredits: 4 },
    };
    expect(orderEntitlementCandidates([endsLater, endsSoon]).map((c) => c.id)).toEqual(['soon', 'later']);
  });

  it('is stable/deterministic on full ties (createdAt asc, then id)', () => {
    const t = new Date('2026-01-01');
    const a = { ...base, id: 'a', createdAt: t, membershipPlan: { classCredits: 4 } };
    const b = { ...base, id: 'b', createdAt: t, membershipPlan: { classCredits: 4 } };
    expect(orderEntitlementCandidates([b, a]).map((c) => c.id)).toEqual(['a', 'b']);
  });
});
