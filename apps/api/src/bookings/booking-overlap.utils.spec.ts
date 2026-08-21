import {
  effectiveOccurrenceEnd,
  findEffectiveOverlapBooking,
  intervalsOverlap,
  occurrencesOverlapEffective,
} from './booking-overlap.utils';

describe('intervalsOverlap', () => {
  const h = (n: number) => new Date(`2026-08-22T${String(n).padStart(2, '0')}:00:00.000Z`);

  it('exact same time conflicts', () => {
    expect(intervalsOverlap(h(8), h(9), h(8), h(9))).toBe(true);
  });

  it('partial overlap conflicts', () => {
    expect(intervalsOverlap(h(7), h(8), h(7), h(10))).toBe(true);
  });

  it('existing contains target conflicts', () => {
    expect(intervalsOverlap(h(6), h(10), h(7), h(8))).toBe(true);
  });

  it('target contains existing conflicts', () => {
    expect(intervalsOverlap(h(7), h(8), h(6), h(10))).toBe(true);
  });

  it('existing ends when target starts — no conflict', () => {
    expect(intervalsOverlap(h(7), h(8), h(8), h(9))).toBe(false);
  });

  it('existing starts when target ends — no conflict', () => {
    expect(intervalsOverlap(h(8), h(9), h(7), h(8))).toBe(false);
  });
});

describe('effectiveOccurrenceEnd', () => {
  it('uses nominal duration when endsAt is corrupt (far future)', () => {
    const start = new Date('2026-08-19T12:00:00.000Z');
    const corruptEnd = new Date('2027-06-19T13:00:00.000Z');
    const effective = effectiveOccurrenceEnd(start, corruptEnd, 60);
    expect(effective.toISOString()).toBe('2026-08-19T13:00:00.000Z');
  });
});

describe('occurrencesOverlapEffective', () => {
  it('Street Bars 08:00 does not conflict with corrupt past Full Body 06:00', () => {
    const fullBody = {
      startsAt: new Date('2026-08-19T12:00:00.000Z'),
      endsAt: new Date('2027-06-19T13:00:00.000Z'),
      durationMinutes: 60,
    };
    const streetBars = {
      startsAt: new Date('2026-08-22T14:00:00.000Z'),
      endsAt: new Date('2026-08-22T15:00:00.000Z'),
      durationMinutes: 60,
    };
    expect(occurrencesOverlapEffective(fullBody, streetBars)).toBe(false);
  });

  it('legitimate overlap still conflicts', () => {
    const a = {
      startsAt: new Date('2026-08-22T14:00:00.000Z'),
      endsAt: new Date('2026-08-22T15:00:00.000Z'),
      durationMinutes: 60,
    };
    const b = {
      startsAt: new Date('2026-08-22T14:30:00.000Z'),
      endsAt: new Date('2026-08-22T15:30:00.000Z'),
      durationMinutes: 60,
    };
    expect(occurrencesOverlapEffective(a, b)).toBe(true);
  });
});

describe('findEffectiveOverlapBooking', () => {
  it('ignores candidate whose effective interval does not overlap', () => {
    const target = {
      startsAt: new Date('2026-08-22T14:00:00.000Z'),
      endsAt: new Date('2026-08-22T15:00:00.000Z'),
      durationMinutes: 60,
    };
    const candidates = [
      {
        id: 'b1',
        scheduledClass: {
          startsAt: new Date('2026-08-19T12:00:00.000Z'),
          endsAt: new Date('2027-06-19T13:00:00.000Z'),
          classTemplate: { durationMinutes: 60 },
        },
      },
    ];
    expect(findEffectiveOverlapBooking(candidates, target)).toBeUndefined();
  });

  it('in-progress existing booking blocks overlapping future target', () => {
    const now = new Date('2026-08-22T14:10:00.000Z');
    const inProgress = {
      startsAt: new Date('2026-08-22T14:00:00.000Z'),
      endsAt: new Date('2026-08-22T15:00:00.000Z'),
      durationMinutes: 60,
    };
    const futureTarget = {
      startsAt: new Date('2026-08-22T14:30:00.000Z'),
      endsAt: new Date('2026-08-22T15:30:00.000Z'),
      durationMinutes: 60,
    };
    expect(occurrencesOverlapEffective(inProgress, futureTarget)).toBe(true);
    const past = {
      startsAt: new Date('2026-08-22T12:00:00.000Z'),
      endsAt: new Date('2026-08-22T13:00:00.000Z'),
      durationMinutes: 60,
    };
    expect(occurrencesOverlapEffective(past, futureTarget)).toBe(false);
    expect(now.getTime()).toBeLessThan(effectiveOccurrenceEnd(inProgress.startsAt, inProgress.endsAt, 60).getTime());
  });

  it('corrupt target endsAt uses canonical duration for overlap decision', () => {
    const existing = {
      startsAt: new Date('2026-08-22T14:00:00.000Z'),
      endsAt: new Date('2026-08-22T15:00:00.000Z'),
      durationMinutes: 60,
    };
    const corruptTarget = {
      startsAt: new Date('2026-08-22T16:00:00.000Z'),
      endsAt: new Date('2027-06-22T17:00:00.000Z'),
      durationMinutes: 60,
    };
    expect(occurrencesOverlapEffective(existing, corruptTarget)).toBe(false);
  });
});
