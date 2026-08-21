import {
  ClassStatus,
  ScheduleOccurrenceExceptionKind,
} from '@prisma/client';
import {
  deriveSeriesStatus,
  matchesSeriesListFilter,
  occurrenceExceptionLabel,
  weekdayLabelEs,
} from './schedule-series-projection';

describe('schedule-series-projection', () => {
  const TZ = 'America/Mexico_City';

  it('derives ENDED when template inactive', () => {
    expect(
      deriveSeriesStatus({ active: false, endsAt: null }, TZ, '2026-08-20'),
    ).toBe('ENDED');
  });

  it('derives ENDING_SOON within 14 days of endsAt', () => {
    const endsAt = new Date('2026-08-30T06:00:00.000Z');
    expect(
      deriveSeriesStatus({ active: true, endsAt }, TZ, '2026-08-20'),
    ).toBe('ENDING_SOON');
  });

  it('maps detached and cancelled occurrence labels', () => {
    expect(
      occurrenceExceptionLabel(ClassStatus.SCHEDULED, ScheduleOccurrenceExceptionKind.DETACHED),
    ).toBe('DETACHED');
    expect(occurrenceExceptionLabel(ClassStatus.CANCELLED, null)).toBe('CANCELLED');
    expect(occurrenceExceptionLabel(ClassStatus.SCHEDULED, null)).toBeNull();
  });

  it('filters list by search and status', () => {
    const item = {
      status: 'ACTIVE' as const,
      classTemplateName: 'Booty Lab',
      instructorName: 'Etzia Ferrabone',
      instructorId: 'inst-1',
    };
    expect(matchesSeriesListFilter(item, { search: 'booty' })).toBe(true);
    expect(matchesSeriesListFilter(item, { search: 'hyrox' })).toBe(false);
    expect(matchesSeriesListFilter(item, { status: 'ended' })).toBe(false);
    expect(matchesSeriesListFilter(item, { instructorId: 'inst-1' })).toBe(true);
  });

  it('labels weekdays in Spanish', () => {
    expect(weekdayLabelEs(4)).toBe('jueves');
  });

  it('ends today is ENDING_SOON not ENDED', () => {
    const today = '2026-08-21';
    const endsAt = new Date('2026-08-21T06:00:00.000Z');
    expect(deriveSeriesStatus({ active: true, endsAt }, TZ, today)).toBe('ENDING_SOON');
  });

  it('inactive template is ENDED', () => {
    expect(deriveSeriesStatus({ active: false, endsAt: null }, TZ, '2026-08-21')).toBe('ENDED');
  });

  it('unbounded active template is ACTIVE', () => {
    expect(deriveSeriesStatus({ active: true, endsAt: null }, TZ, '2026-08-21')).toBe('ACTIVE');
  });
});
