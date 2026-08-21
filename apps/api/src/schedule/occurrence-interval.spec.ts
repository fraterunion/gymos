import { BadRequestException } from '@nestjs/common';
import { assertStartsBeforeEnds, endsAtFromDuration } from './occurrence-interval';

describe('occurrence interval invariants', () => {
  it('rejects endsAt equal to startsAt', () => {
    const t = new Date('2026-08-22T14:00:00.000Z');
    expect(() => assertStartsBeforeEnds(t, t)).toThrow(BadRequestException);
  });

  it('rejects endsAt before startsAt', () => {
    expect(() =>
      assertStartsBeforeEnds(
        new Date('2026-08-22T15:00:00.000Z'),
        new Date('2026-08-22T14:00:00.000Z'),
      ),
    ).toThrow(BadRequestException);
  });

  it('accepts a positive interval', () => {
    expect(() =>
      assertStartsBeforeEnds(
        new Date('2026-08-22T14:00:00.000Z'),
        new Date('2026-08-22T15:00:00.000Z'),
      ),
    ).not.toThrow();
  });

  it('derives endsAt from durationMinutes', () => {
    const start = new Date('2026-08-22T14:00:00.000Z');
    expect(endsAtFromDuration(start, 60).toISOString()).toBe('2026-08-22T15:00:00.000Z');
  });
});
