import {
  buildCandidatesForTemplateInRange,
  indexExistingOccurrences,
  isLegacyUnboundedTemplate,
  isTemplateActiveOnDateKey,
  shouldSkipCandidate,
} from './schedule-materialization';
import { studioLocalDateKeyToUtcAnchor, studioLocalTimeToUtc } from '../common/date/studio-local-date';

/** Production-shaped ARES legacy template after Calendar 2.1 migration (pre-2.1.1 fix). */
function productionLegacyTemplateAfterCalendar21Migration() {
  return {
    id: 'c19effe2f6d70002ac927426b',
    classTemplateId: 'ct-hyrox',
    instructorId: null,
    dayOfWeek: 1,
    startTime: '07:00',
    capacity: 25,
    startsAt: new Date('2026-08-20T23:52:38.760Z'),
    endsAt: null,
    intervalWeeks: 1,
    createdAt: new Date('2026-06-25T17:45:24.766Z'),
    classTemplate: {
      id: 'ct-hyrox',
      name: 'Hyrox',
      durationMinutes: 60,
      defaultCapacity: 25,
    },
  };
}

/** Same template after corrective migration (startsAt NULL). */
function productionLegacyTemplateAfterHotfix() {
  return { ...productionLegacyTemplateAfterCalendar21Migration(), startsAt: null };
}

const TZ = 'America/Mexico_City';

describe('Calendar 2.1.1 — legacy template hotfix', () => {
  describe('production migration backfill shape (692509a bug)', () => {
    const buggy = productionLegacyTemplateAfterCalendar21Migration();

    it('is NOT recognized as legacy by timestamp heuristic', () => {
      expect(isLegacyUnboundedTemplate(buggy)).toBe(false);
    });

    it('artificially bounds generation to deploy date — excludes pre-deploy Mondays', () => {
      expect(isTemplateActiveOnDateKey(buggy, '2026-08-17', TZ)).toBe(false);
      expect(isTemplateActiveOnDateKey(buggy, '2026-08-24', TZ)).toBe(true);
    });

    it('would fail to generate historical dates in August before deploy', () => {
      const candidates = buildCandidatesForTemplateInRange(
        buggy,
        TZ,
        '2026-08-01',
        '2026-08-20',
      );
      expect(candidates).toHaveLength(0);
    });
  });

  describe('corrected NULL startsAt semantics', () => {
    const fixed = productionLegacyTemplateAfterHotfix();

    it('is recognized as legacy unbounded', () => {
      expect(isLegacyUnboundedTemplate(fixed)).toBe(true);
    });

    it('generates across historical weekly pattern (not bounded to Aug 20)', () => {
      expect(isTemplateActiveOnDateKey(fixed, '2026-08-17', TZ)).toBe(true);
      expect(isTemplateActiveOnDateKey(fixed, '2026-08-24', TZ)).toBe(true);
    });

    it('builds candidates before migration deploy date', () => {
      const candidates = buildCandidatesForTemplateInRange(
        fixed,
        TZ,
        '2026-08-01',
        '2026-08-20',
      );
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.every((c) => c.startsAt < new Date('2026-08-20T23:52:38.760Z'))).toBe(true);
    });

    it('skips existing future occurrences idempotently', () => {
      const candidate = buildCandidatesForTemplateInRange(
        fixed,
        TZ,
        '2026-08-17',
        '2026-08-18',
      )[0]!;
      const existingStartsAt = studioLocalTimeToUtc('2026-08-17', '07:00', TZ);
      const { dedupKeys, templateDateKeys } = indexExistingOccurrences(
        [
          {
            classTemplateId: 'ct-hyrox',
            startsAt: existingStartsAt,
            scheduleTemplateId: null,
            status: 'SCHEDULED',
          },
        ],
        TZ,
      );
      expect(shouldSkipCandidate(candidate, dedupKeys, templateDateKeys)).toBe(true);
    });
  });

  describe('explicit Calendar 2.1 series (NOT NULL startsAt)', () => {
    const bounded = {
      ...productionLegacyTemplateAfterHotfix(),
      startsAt: studioLocalDateKeyToUtcAnchor('2031-09-01', TZ),
      endsAt: studioLocalDateKeyToUtcAnchor('2031-11-24', TZ),
    };

    it('is not legacy unbounded', () => {
      expect(isLegacyUnboundedTemplate(bounded)).toBe(false);
    });

    it('respects explicit startsAt (inclusive endsAt)', () => {
      expect(isTemplateActiveOnDateKey(bounded, '2031-08-25', TZ)).toBe(false);
      expect(isTemplateActiveOnDateKey(bounded, '2031-09-01', TZ)).toBe(true);
      expect(isTemplateActiveOnDateKey(bounded, '2031-11-24', TZ)).toBe(true);
      expect(isTemplateActiveOnDateKey(bounded, '2031-12-01', TZ)).toBe(false);
    });

    it('honors intervalWeeks', () => {
      const biweekly = { ...bounded, intervalWeeks: 2 };
      expect(isTemplateActiveOnDateKey(biweekly, '2031-09-01', TZ)).toBe(true);
      expect(isTemplateActiveOnDateKey(biweekly, '2031-09-08', TZ)).toBe(false);
      expect(isTemplateActiveOnDateKey(biweekly, '2031-09-15', TZ)).toBe(true);
    });
  });
});
