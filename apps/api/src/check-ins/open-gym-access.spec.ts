import { getStudioLocalHHmm, studioLocalTimeToUtc } from '../common/date/studio-local-date';
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
/**
 * Full Access is unrestricted: openGymAccess with NO window. Its plan copy promises "Sin
 * restricciones de horario", so encoding any range here — including a cosmetic 00:00–23:59 —
 * would create a restriction that can refuse a member, which is exactly what it must not do.
 */
const fullAccess = plan({
  membershipPlanId: 'full',
  membershipPlanName: 'Full Access',
  openGymWindowStart: null,
  openGymWindowEnd: null,
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

describe('evaluateOpenGymEligibility — hour boundary matrix', () => {
  /** The UTC instant at which the ARES studio clock reads this local 'HH:mm'. */
  function atAresLocal(hhmm: string): Date {
    return studioLocalTimeToUtc('2026-08-24', hhmm, ARES_TZ);
  }

  it('the local-time helper round-trips, so the cases below assert what they claim', () => {
    for (const hhmm of ['00:01', '10:59', '11:00', '17:00', '22:00', '23:59']) {
      expect(getStudioLocalHHmm(atAresLocal(hhmm), ARES_TZ)).toBe(hhmm);
    }
  });

  describe('Full Access — unrestricted, admits at every hour', () => {
    it.each(['00:01', '10:59', '11:00', '21:59', '22:00', '23:59'])(
      'allows entry at %s local',
      (hhmm) => {
        expect(evaluateOpenGymEligibility([fullAccess], atAresLocal(hhmm), ARES_TZ)).toEqual({
          outcome: 'allowed',
          membershipPlanId: 'full',
          membershipPlanName: 'Full Access',
          windowStart: null,
          windowEnd: null,
        });
      },
    );
  });

  describe('Basic Access — 11:00 to 22:00', () => {
    it.each([
      ['10:59', 'outside_hours'],
      ['11:00', 'allowed'],
      ['21:59', 'allowed'],
      ['22:00', 'outside_hours'],
    ])('at %s local the outcome is %s', (hhmm, expected) => {
      expect(evaluateOpenGymEligibility([basicAccess], atAresLocal(hhmm), ARES_TZ)).toMatchObject({
        outcome: expected,
      });
    });
  });

  describe('Open Gym plan — 11:00 to 17:00', () => {
    it.each([
      ['10:59', 'outside_hours'],
      ['11:00', 'allowed'],
      ['16:59', 'allowed'],
      ['17:00', 'outside_hours'],
    ])('at %s local the outcome is %s', (hhmm, expected) => {
      expect(evaluateOpenGymEligibility([openGymPlan], atAresLocal(hhmm), ARES_TZ)).toMatchObject({
        outcome: expected,
      });
    });
  });

  describe('Pro and Booty Lab — never, at any hour', () => {
    it.each(['00:01', '10:59', '11:00', '16:00', '21:59', '23:59'])(
      'denies both plans at %s local',
      (hhmm) => {
        const at = atAresLocal(hhmm);
        expect(evaluateOpenGymEligibility([proPlan], at, ARES_TZ)).toEqual({
          outcome: 'not_included',
        });
        expect(evaluateOpenGymEligibility([bootyLab], at, ARES_TZ)).toEqual({
          outcome: 'not_included',
        });
      },
    );
  });

  it('unrestricted access still requires a current membership', () => {
    // The empty list is how the caller reports "no currently-entitled subscription". Being
    // unrestricted must never become a way around that check.
    expect(evaluateOpenGymEligibility([], atAresLocal('12:00'), ARES_TZ)).toEqual({
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
