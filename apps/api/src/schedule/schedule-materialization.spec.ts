import {
  isLegacyUnboundedTemplate,
  isTemplateActiveOnDateKey,
  lastRecurrenceDateKeyStrictlyBefore,
  shouldSkipCandidate,
  indexExistingOccurrences,
  buildCandidatesForTemplateInRange,
} from './schedule-materialization';
import { studioLocalDateKeyToUtcAnchor } from '../common/date/studio-local-date';

describe('schedule-materialization — series invariants', () => {
  const baseTemplate = {
    id: 'tpl-a',
    classTemplateId: 'ct-1',
    instructorId: null,
    dayOfWeek: 3,
    startTime: '07:00',
    capacity: 25,
    startsAt: studioLocalDateKeyToUtcAnchor('2031-08-06', 'America/Mexico_City'),
    endsAt: studioLocalDateKeyToUtcAnchor('2031-11-26', 'America/Mexico_City'),
    intervalWeeks: 1,
    createdAt: new Date('2031-08-01T00:00:00.000Z'),
    classTemplate: {
      id: 'ct-1',
      name: 'Full Body',
      durationMinutes: 60,
      defaultCapacity: 20,
    },
  };

  it('includes first and final local recurrence dates (inclusive endsAt)', () => {
    expect(isTemplateActiveOnDateKey(baseTemplate, '2031-08-06', 'America/Mexico_City')).toBe(true);
    expect(isTemplateActiveOnDateKey(baseTemplate, '2031-11-26', 'America/Mexico_City')).toBe(true);
    expect(isTemplateActiveOnDateKey(baseTemplate, '2031-12-03', 'America/Mexico_City')).toBe(false);
  });

  it('excludes dates before startsAt for explicit series', () => {
    expect(isTemplateActiveOnDateKey(baseTemplate, '2031-08-05', 'America/Mexico_City')).toBe(false);
  });

  it('computes predecessor end as last recurrence strictly before split boundary', () => {
    const endKey = lastRecurrenceDateKeyStrictlyBefore(
      baseTemplate,
      '2031-09-17',
      'America/Mexico_City',
    );
    expect(endKey).toBe('2031-09-10');
  });

  it('treats legacy templates with startsAt≈createdAt as unbounded start', () => {
    const legacy = {
      ...baseTemplate,
      startsAt: new Date('2031-08-01T12:00:00.000Z'),
      createdAt: new Date('2031-08-01T12:00:00.000Z'),
    };
    expect(isLegacyUnboundedTemplate(legacy)).toBe(true);
    expect(isTemplateActiveOnDateKey(legacy, '2031-08-06', 'America/Mexico_City')).toBe(true);
  });

  it('skips regeneration for template+localDate even when startsAt changed (detached)', () => {
    const candidate = buildCandidatesForTemplateInRange(
      baseTemplate,
      'America/Mexico_City',
      '2031-09-17',
      '2031-09-18',
    )[0]!;
    const detachedAt8 = new Date(candidate.startsAt.getTime() + 3_600_000);
    const { dedupKeys, templateDateKeys } = indexExistingOccurrences(
      [
        {
          classTemplateId: 'ct-1',
          startsAt: detachedAt8,
          scheduleTemplateId: 'tpl-a',
          status: 'SCHEDULED',
        },
      ],
      'America/Mexico_City',
    );
    expect(shouldSkipCandidate(candidate, dedupKeys, templateDateKeys)).toBe(true);
  });

  it('does not skip different class template at same concrete startsAt via templateDateKeys alone', () => {
    const candidate = buildCandidatesForTemplateInRange(
      { ...baseTemplate, id: 'tpl-b', classTemplateId: 'ct-2', classTemplate: { ...baseTemplate.classTemplate, id: 'ct-2' } },
      'America/Mexico_City',
      '2031-09-17',
      '2031-09-18',
    )[0]!;
    const { dedupKeys, templateDateKeys } = indexExistingOccurrences(
      [
        {
          classTemplateId: 'ct-1',
          startsAt: candidate.startsAt,
          scheduleTemplateId: 'tpl-a',
          status: 'SCHEDULED',
        },
      ],
      'America/Mexico_City',
    );
    expect(shouldSkipCandidate(candidate, dedupKeys, templateDateKeys)).toBe(false);
  });

  it('preserves New York local clock across DST when building candidates', () => {
    const nyTemplate = {
      ...baseTemplate,
      startsAt: studioLocalDateKeyToUtcAnchor('2020-01-01', 'America/New_York'),
      createdAt: new Date('2020-01-01T00:00:00.000Z'),
      endsAt: null,
    };
    const before = buildCandidatesForTemplateInRange(
      nyTemplate,
      'America/New_York',
      '2026-11-04',
      '2026-11-05',
    )[0]!;
    const after = buildCandidatesForTemplateInRange(
      nyTemplate,
      'America/New_York',
      '2026-11-11',
      '2026-11-12',
    )[0]!;
    const fmt = (d: Date) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(d);
    expect(fmt(before.startsAt)).toMatch(/07:00/);
    expect(fmt(after.startsAt)).toMatch(/07:00/);
  });
});
