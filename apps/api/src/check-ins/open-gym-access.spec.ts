import { evaluateOpenGymEligibility, isWithinOpenGymWindow, type OpenGymPlanPolicy } from './open-gym-access';

/**
 * ARES plan configuration, mirroring the structured data the Open Gym migration writes.
 * Hours are studio-local; America/Mexico_City is UTC-6 year-round (Mexico abolished DST in
 * 2022), so every instant below is written as local time + 6h and is stable forever.
 */
const ARES_TZ = 'America/Mexico_City';

function plan(overrides: Partial<OpenGymPlanPolicy> = {}): OpenGymPlanPolicy {
  return {
    membershipPlanId: 'plan-1',
    membershipPlanName: 'Test Plan',
    openGymAccess: true,
    openGymWindowStart: '11:00',
    openGymWindowEnd: '22:00',
    ...overrides,
  };
}

const basicAccess = plan({
  membershipPlanId: 'basic',
  membershipPlanName: 'Basic Access',
  openGymWindowStart: '11:00',
  openGymWindowEnd: '22:00',
});
const fullAccess = plan({
  membershipPlanId: 'full',
  membershipPlanName: 'Full Access',
  openGymWindowStart: '11:00',
  openGymWindowEnd: '22:00',
});
const openGymPlan = plan({
  membershipPlanId: 'og',
  membershipPlanName: 'Open Gym',
  openGymWindowStart: '11:00',
  openGymWindowEnd: '17:00',
});
const proPlan = plan({
  membershipPlanId: 'pro',
  membershipPlanName: 'Pro',
  openGymAccess: false,
  openGymWindowStart: null,
  openGymWindowEnd: null,
});
const bootyLab = plan({
  membershipPlanId: 'booty',
  membershipPlanName: 'Booty Lab by Etzia',
  openGymAccess: false,
  openGymWindowStart: null,
  openGymWindowEnd: null,
});

/** Studio-local wall time in Mexico City -> the UTC instant it corresponds to. */
function aresLocal(dateIso: string): Date {
  return new Date(dateIso);
}

// 2026-08-24 is a Monday. Local 12:00 = 18:00Z, local 22:30 = 04:30Z the next day.
const AT_1200_LOCAL = aresLocal('2026-08-24T18:00:00.000Z');
const AT_1630_LOCAL = aresLocal('2026-08-24T22:30:00.000Z');
const AT_1800_LOCAL = aresLocal('2026-08-25T00:00:00.000Z');
const AT_2230_LOCAL = aresLocal('2026-08-25T04:30:00.000Z');
const AT_1059_LOCAL = aresLocal('2026-08-24T16:59:00.000Z');

describe('isWithinOpenGymWindow', () => {
  it('treats the window as half-open so the closing minute is already outside', () => {
    expect(isWithinOpenGymWindow('11:00', '11:00', '22:00')).toBe(true);
    expect(isWithinOpenGymWindow('21:59', '11:00', '22:00')).toBe(true);
    expect(isWithinOpenGymWindow('22:00', '11:00', '22:00')).toBe(false);
    expect(isWithinOpenGymWindow('10:59', '11:00', '22:00')).toBe(false);
  });

  it('admits any time when the plan sets no window', () => {
    expect(isWithinOpenGymWindow('03:14', null, null)).toBe(true);
  });

  it('reads an inverted window as crossing midnight rather than as a lockout', () => {
    expect(isWithinOpenGymWindow('23:30', '22:00', '06:00')).toBe(true);
    expect(isWithinOpenGymWindow('05:59', '22:00', '06:00')).toBe(true);
    expect(isWithinOpenGymWindow('12:00', '22:00', '06:00')).toBe(false);
  });

  it('matches nothing when the window is empty', () => {
    expect(isWithinOpenGymWindow('11:00', '11:00', '11:00')).toBe(false);
  });
});

describe('evaluateOpenGymEligibility — ARES plan matrix', () => {
  it('Basic Access at 12:00 local is allowed', () => {
    const result = evaluateOpenGymEligibility([basicAccess], AT_1200_LOCAL, ARES_TZ);
    expect(result).toEqual({
      outcome: 'allowed',
      membershipPlanId: 'basic',
      membershipPlanName: 'Basic Access',
      windowStart: '11:00',
      windowEnd: '22:00',
    });
  });

  it('Basic Access at 22:30 local is denied for hours, and reports the plan window', () => {
    const result = evaluateOpenGymEligibility([basicAccess], AT_2230_LOCAL, ARES_TZ);
    expect(result).toEqual({
      outcome: 'outside_hours',
      membershipPlanName: 'Basic Access',
      windowStart: '11:00',
      windowEnd: '22:00',
      localTime: '22:30',
    });
  });

  it('Basic Access one minute before opening is denied', () => {
    const result = evaluateOpenGymEligibility([basicAccess], AT_1059_LOCAL, ARES_TZ);
    expect(result).toMatchObject({ outcome: 'outside_hours', localTime: '10:59' });
  });

  it('Full Access inside its hours is allowed', () => {
    const result = evaluateOpenGymEligibility([fullAccess], AT_1630_LOCAL, ARES_TZ);
    expect(result).toMatchObject({ outcome: 'allowed', membershipPlanName: 'Full Access' });
  });

  it('Full Access is allowed at 18:00, when the Open Gym plan would already be closed', () => {
    expect(evaluateOpenGymEligibility([fullAccess], AT_1800_LOCAL, ARES_TZ)).toMatchObject({
      outcome: 'allowed',
    });
    expect(evaluateOpenGymEligibility([openGymPlan], AT_1800_LOCAL, ARES_TZ)).toMatchObject({
      outcome: 'outside_hours',
    });
  });

  it('Open Gym plan at 16:30 local is allowed', () => {
    const result = evaluateOpenGymEligibility([openGymPlan], AT_1630_LOCAL, ARES_TZ);
    expect(result).toMatchObject({ outcome: 'allowed', membershipPlanName: 'Open Gym' });
  });

  it('Open Gym plan at 18:00 local is denied for hours', () => {
    const result = evaluateOpenGymEligibility([openGymPlan], AT_1800_LOCAL, ARES_TZ);
    expect(result).toEqual({
      outcome: 'outside_hours',
      membershipPlanName: 'Open Gym',
      windowStart: '11:00',
      windowEnd: '17:00',
      localTime: '18:00',
    });
  });

  it('Pro is denied as not included, at any hour', () => {
    expect(evaluateOpenGymEligibility([proPlan], AT_1200_LOCAL, ARES_TZ)).toEqual({
      outcome: 'not_included',
    });
    expect(evaluateOpenGymEligibility([proPlan], AT_1630_LOCAL, ARES_TZ)).toEqual({
      outcome: 'not_included',
    });
  });

  it('Booty Lab is denied as not included', () => {
    expect(evaluateOpenGymEligibility([bootyLab], AT_1200_LOCAL, ARES_TZ)).toEqual({
      outcome: 'not_included',
    });
  });

  it('a member with no entitled subscription is not_entitled, never not_included', () => {
    expect(evaluateOpenGymEligibility([], AT_1200_LOCAL, ARES_TZ)).toEqual({
      outcome: 'not_entitled',
    });
  });
});

describe('evaluateOpenGymEligibility — studio timezone', () => {
  it('decides on studio-local time, so one instant admits in one zone and refuses in another', () => {
    // 18:00Z is 12:00 in Mexico City (inside 11:00-22:00) and 03:00 the next day in Tokyo.
    expect(evaluateOpenGymEligibility([basicAccess], AT_1200_LOCAL, ARES_TZ)).toMatchObject({
      outcome: 'allowed',
    });
    expect(evaluateOpenGymEligibility([basicAccess], AT_1200_LOCAL, 'Asia/Tokyo')).toMatchObject({
      outcome: 'outside_hours',
      localTime: '03:00',
    });
  });

  it('never falls back to the host process timezone', () => {
    // 04:30Z is 22:30 in Mexico City (closed) but 05:30 in Kolkata and 21:30 in Los Angeles.
    expect(evaluateOpenGymEligibility([basicAccess], AT_2230_LOCAL, ARES_TZ)).toMatchObject({
      outcome: 'outside_hours',
    });
    expect(
      evaluateOpenGymEligibility([basicAccess], AT_2230_LOCAL, 'America/Los_Angeles'),
    ).toMatchObject({ outcome: 'allowed' });
  });
});

describe('evaluateOpenGymEligibility — multiple entitled subscriptions', () => {
  it('admits when any plan allows the current hour', () => {
    const result = evaluateOpenGymEligibility([openGymPlan, fullAccess], AT_1800_LOCAL, ARES_TZ);
    expect(result).toMatchObject({ outcome: 'allowed', membershipPlanName: 'Full Access' });
  });

  it('ignores plans without Open Gym when another plan grants it', () => {
    const result = evaluateOpenGymEligibility([proPlan, basicAccess], AT_1200_LOCAL, ARES_TZ);
    expect(result).toMatchObject({ outcome: 'allowed', membershipPlanName: 'Basic Access' });
  });

  it('is not_included only when no plan grants Open Gym at all', () => {
    expect(evaluateOpenGymEligibility([proPlan, bootyLab], AT_1200_LOCAL, ARES_TZ)).toEqual({
      outcome: 'not_included',
    });
  });

  it('names the widest window when every Open Gym plan refuses on hours', () => {
    const early = plan({
      membershipPlanId: 'early',
      membershipPlanName: 'Early',
      openGymWindowStart: '06:00',
      openGymWindowEnd: '09:00',
    });
    const result = evaluateOpenGymEligibility([openGymPlan, early], AT_1800_LOCAL, ARES_TZ);
    expect(result).toMatchObject({ outcome: 'outside_hours', membershipPlanName: 'Early' });
  });

  it('an unrestricted Open Gym plan admits at any hour', () => {
    const unrestricted = plan({
      membershipPlanName: 'Unrestricted',
      openGymWindowStart: null,
      openGymWindowEnd: null,
    });
    expect(evaluateOpenGymEligibility([unrestricted], AT_2230_LOCAL, ARES_TZ)).toMatchObject({
      outcome: 'allowed',
      windowStart: null,
      windowEnd: null,
    });
  });
});
