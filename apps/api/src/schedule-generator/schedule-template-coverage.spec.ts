import { computeTemplateCoverage } from './schedule-template-coverage';
import { studioLocalTimeToUtc } from '../common/date/studio-local-date';

const TZ = 'America/Mexico_City';
const NOW = new Date('2026-08-20T12:00:00.000Z');

function template(overrides = {}) {
  return {
    id: 'tpl-1',
    classTemplateId: 'class-1',
    instructorId: null,
    dayOfWeek: 1,
    startTime: '06:00',
    capacity: null,
    intervalWeeks: 1,
    startsAt: null,
    endsAt: null,
    active: true,
    classTemplate: {
      id: 'class-1',
      name: 'Pull',
      durationMinutes: 60,
      defaultCapacity: 12,
    },
    ...overrides,
  };
}

describe('schedule-template-coverage', () => {
  it('standalone far-future class does NOT mark template healthy', () => {
    const farFuture = studioLocalTimeToUtc('2027-01-15', '06:00', TZ);
    const coverage = computeTemplateCoverage([template()], [], TZ, 90, NOW);
    expect(coverage.needsGeneration).toBe(true);
    expect(coverage.undercoveredTemplateCount).toBe(1);

    const withStandaloneOnly = computeTemplateCoverage(
      [template()],
      [{ scheduleTemplateId: null, startsAt: farFuture }],
      TZ,
      90,
      NOW,
    );
    expect(withStandaloneOnly.needsGeneration).toBe(true);
  });

  it('healthy linked template → skip generation', () => {
    const linked = studioLocalTimeToUtc('2026-12-28', '06:00', TZ);
    const coverage = computeTemplateCoverage(
      [template()],
      [{ scheduleTemplateId: 'tpl-1', startsAt: linked }],
      TZ,
      90,
      NOW,
    );
    expect(coverage.needsGeneration).toBe(false);
  });

  it('one undercovered template triggers generation among mixed templates', () => {
    const healthy = studioLocalTimeToUtc('2026-12-28', '06:00', TZ);
    const coverage = computeTemplateCoverage(
      [template({ id: 'tpl-1' }), template({ id: 'tpl-2', dayOfWeek: 2, startTime: '07:00' })],
      [{ scheduleTemplateId: 'tpl-1', startsAt: healthy }],
      TZ,
      90,
      NOW,
    );
    expect(coverage.needsGeneration).toBe(true);
    expect(coverage.undercoveredTemplateIds).toContain('tpl-2');
    expect(coverage.undercoveredTemplateIds).not.toContain('tpl-1');
  });

  it('biweekly template respects cadence for undercoverage', () => {
    const offWeek = studioLocalTimeToUtc('2026-08-25', '06:00', TZ);
    const onWeek = studioLocalTimeToUtc('2026-12-28', '06:00', TZ);
    const biweekly = template({
      intervalWeeks: 2,
      startsAt: new Date('2026-08-18T12:00:00.000Z'),
    });
    const under = computeTemplateCoverage(
      [biweekly],
      [{ scheduleTemplateId: 'tpl-1', startsAt: offWeek }],
      TZ,
      90,
      NOW,
    );
    expect(under.needsGeneration).toBe(true);

    const covered = computeTemplateCoverage(
      [biweekly],
      [{ scheduleTemplateId: 'tpl-1', startsAt: onWeek }],
      TZ,
      90,
      NOW,
    );
    expect(covered.needsGeneration).toBe(false);
  });

  it('inactive templates are excluded from active count', () => {
    const coverage = computeTemplateCoverage(
      [template({ active: false })],
      [],
      TZ,
      90,
      NOW,
    );
    expect(coverage.activeTemplateCount).toBe(0);
    expect(coverage.needsGeneration).toBe(false);
  });

  it('linked occurrences extend horizon days', () => {
    const linked = studioLocalTimeToUtc('2026-12-28', '06:00', TZ);
    const coverage = computeTemplateCoverage(
      [template()],
      [{ scheduleTemplateId: 'tpl-1', startsAt: linked }],
      TZ,
      90,
      NOW,
    );
    expect(coverage.templates[0]?.futureLinkedCount).toBe(1);
    expect(coverage.templates[0]?.linkedHorizonDays).toBeGreaterThan(90);
  });
});
