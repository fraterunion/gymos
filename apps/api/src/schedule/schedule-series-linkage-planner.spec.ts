import {
  buildApprovedLinkageSnapshot,
  buildExecutePatches,
  assertExecutePatchSafety,
  classifyStandaloneOccurrence,
  findIdentityCandidateTemplates,
  findRecurrenceValidTemplates,
  planStandaloneLinkage,
  simulateSeriesProjections,
  summarizeLinkagePlan,
  type LinkageOccurrenceInput,
  type LinkageTemplateRef,
} from './schedule-series-linkage-planner';
import { studioLocalTimeToUtc } from '../common/date/studio-local-date';

const TZ = 'America/Mexico_City';
const NOW = new Date('2026-08-21T12:00:00.000Z');

function tpl(overrides: Partial<LinkageTemplateRef> & Pick<LinkageTemplateRef, 'id'>): LinkageTemplateRef {
  return {
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
      name: 'Legs + HIIT',
      durationMinutes: 60,
      defaultCapacity: 12,
    },
    ...overrides,
  };
}

function row(overrides: Partial<LinkageOccurrenceInput> & Pick<LinkageOccurrenceInput, 'id'>): LinkageOccurrenceInput {
  const startsAt =
    overrides.startsAt ?? studioLocalTimeToUtc('2026-08-24', '06:00', TZ);
  return {
    studioId: 'studio-ares',
    classTemplateId: 'class-1',
    classTemplateName: 'Legs + HIIT',
    startsAt,
    status: 'SCHEDULED',
    scheduleTemplateId: null,
    bookingCount: 0,
    attendanceCount: 0,
    waitlistCount: 0,
    ...overrides,
  };
}

describe('schedule-series-linkage-planner', () => {
  it('exact weekly match', () => {
    const templates = [tpl({ id: 'tpl-a' })];
    const plan = classifyStandaloneOccurrence(row({ id: 'sc-1' }), templates, TZ, NOW, 'future_scheduled_standalone');
    expect(plan.classification).toBe('MATCH');
    expect(plan.matchedScheduleTemplateId).toBe('tpl-a');
  });

  it('no classTemplate match', () => {
    const templates = [tpl({ id: 'tpl-a', classTemplateId: 'other-class' })];
    const plan = classifyStandaloneOccurrence(row({ id: 'sc-1' }), templates, TZ, NOW, 'future_scheduled_standalone');
    expect(plan.classification).toBe('NO_MATCH');
  });

  it('same class wrong weekday', () => {
    const templates = [tpl({ id: 'tpl-a', dayOfWeek: 2 })];
    const plan = classifyStandaloneOccurrence(row({ id: 'sc-1' }), templates, TZ, NOW, 'future_scheduled_standalone');
    expect(plan.classification).toBe('NO_MATCH');
  });

  it('same class wrong time', () => {
    const templates = [tpl({ id: 'tpl-a', startTime: '07:00' })];
    const plan = classifyStandaloneOccurrence(row({ id: 'sc-1' }), templates, TZ, NOW, 'future_scheduled_standalone');
    expect(plan.classification).toBe('NO_MATCH');
  });

  it('ambiguous duplicate templates', () => {
    const templates = [tpl({ id: 'tpl-a' }), tpl({ id: 'tpl-b' })];
    const plan = classifyStandaloneOccurrence(row({ id: 'sc-1' }), templates, TZ, NOW, 'future_scheduled_standalone');
    expect(plan.classification).toBe('AMBIGUOUS');
  });

  it('bounded template before start', () => {
    const templates = [
      tpl({
        id: 'tpl-a',
        startsAt: studioLocalTimeToUtc('2026-09-01', '00:00', TZ),
      }),
    ];
    const plan = classifyStandaloneOccurrence(row({ id: 'sc-1' }), templates, TZ, NOW, 'future_scheduled_standalone');
    expect(plan.classification).toBe('OUT_OF_BOUNDARY');
  });

  it('bounded template after end', () => {
    const templates = [
      tpl({
        id: 'tpl-a',
        endsAt: studioLocalTimeToUtc('2026-08-20', '23:59', TZ),
      }),
    ];
    const plan = classifyStandaloneOccurrence(row({ id: 'sc-1' }), templates, TZ, NOW, 'future_scheduled_standalone');
    expect(plan.classification).toBe('OUT_OF_BOUNDARY');
  });

  it('biweekly valid week', () => {
    const start = studioLocalTimeToUtc('2026-08-03', '06:00', TZ);
    const templates = [tpl({ id: 'tpl-a', intervalWeeks: 2, startsAt: start })];
    const valid = studioLocalTimeToUtc('2026-08-31', '06:00', TZ);
    const plan = classifyStandaloneOccurrence(
      row({ id: 'sc-1', startsAt: valid }),
      templates,
      TZ,
      NOW,
      'future_scheduled_standalone',
    );
    expect(plan.classification).toBe('MATCH');
  });

  it('biweekly invalid week', () => {
    const start = studioLocalTimeToUtc('2026-08-03', '06:00', TZ);
    const templates = [tpl({ id: 'tpl-a', intervalWeeks: 2, startsAt: start })];
    const invalid = studioLocalTimeToUtc('2026-08-24', '06:00', TZ);
    const plan = classifyStandaloneOccurrence(
      row({ id: 'sc-1', startsAt: invalid }),
      templates,
      TZ,
      NOW,
      'future_scheduled_standalone',
    );
    expect(plan.classification).toBe('OUT_OF_BOUNDARY');
  });

  it('legacy startsAt=NULL template', () => {
    const templates = [tpl({ id: 'tpl-a', startsAt: null })];
    const plan = classifyStandaloneOccurrence(row({ id: 'sc-1' }), templates, TZ, NOW, 'future_scheduled_standalone');
    expect(plan.classification).toBe('MATCH');
  });

  it('booking-bearing row remains safe', () => {
    const templates = [tpl({ id: 'tpl-a' })];
    const plan = classifyStandaloneOccurrence(
      row({ id: 'sc-1', bookingCount: 3 }),
      templates,
      TZ,
      NOW,
      'future_scheduled_standalone',
    );
    expect(plan.classification).toBe('MATCH');
    expect(plan.bookingCount).toBe(3);
  });

  it('attendance-bearing row classification for future SCHEDULED', () => {
    const templates = [tpl({ id: 'tpl-a' })];
    const plan = classifyStandaloneOccurrence(
      row({ id: 'sc-1', attendanceCount: 1 }),
      templates,
      TZ,
      NOW,
      'future_scheduled_standalone',
    );
    expect(plan.classification).toBe('MATCH');
    expect(plan.attendanceCount).toBe(1);
  });

  it('already-linked row', () => {
    const templates = [tpl({ id: 'tpl-a' })];
    const plan = classifyStandaloneOccurrence(
      row({ id: 'sc-1', scheduleTemplateId: 'tpl-a' }),
      templates,
      TZ,
      NOW,
      'future_scheduled_standalone',
    );
    expect(plan.classification).toBe('ALREADY_LINKED');
  });

  it('standalone ad-hoc row', () => {
    const templates = [tpl({ id: 'tpl-a', classTemplateId: 'open-gym' })];
    const plan = classifyStandaloneOccurrence(
      row({ id: 'sc-1', classTemplateId: 'hyrox', classTemplateName: 'Hyrox' }),
      templates,
      TZ,
      NOW,
      'future_scheduled_standalone',
    );
    expect(plan.classification).toBe('NO_MATCH');
  });

  it('studio isolation — inactive templates ignored', () => {
    const templates = [tpl({ id: 'tpl-a', active: false })];
    const identity = findIdentityCandidateTemplates(row({ id: 'sc-1' }), templates, TZ);
    expect(identity.length).toBe(0);
  });

  it('Mexico City local-time preservation', () => {
    const templates = [tpl({ id: 'tpl-a', dayOfWeek: 0, startTime: '09:00' })];
    const startsAt = studioLocalTimeToUtc('2026-08-23', '09:00', TZ);
    const plan = classifyStandaloneOccurrence(
      row({ id: 'sc-1', startsAt }),
      templates,
      TZ,
      NOW,
      'future_scheduled_standalone',
    );
    expect(plan.localTime).toBe('09:00');
    expect(plan.weekday).toBe(0);
    expect(plan.classification).toBe('MATCH');
  });

  it('DST regression — recurrence check uses studio-local date keys', () => {
    const templates = [tpl({ id: 'tpl-a', dayOfWeek: 0, startTime: '09:00' })];
    const startsAt = studioLocalTimeToUtc('2026-11-01', '09:00', TZ);
    const valid = findRecurrenceValidTemplates({ startsAt }, templates, TZ);
    expect(valid.length).toBe(1);
  });

  it('execute patch only updates scheduleTemplateId field keys', () => {
    const snapshot = buildApprovedLinkageSnapshot('studio-ares', [
      {
        scheduledClassId: 'sc-1',
        startsAtUtc: '2026-08-24T12:00:00.000Z',
        localDate: '2026-08-24',
        localTime: '06:00',
        weekday: 1,
        classTemplateId: 'class-1',
        classTemplateName: 'Legs + HIIT',
        status: 'SCHEDULED',
        currentScheduleTemplateId: null,
        bookingCount: 0,
        attendanceCount: 0,
        waitlistCount: 0,
        classification: 'MATCH',
        matchedScheduleTemplateId: 'tpl-a',
        matchedTemplateDayOfWeek: 1,
        matchedTemplateStartTime: '06:00',
        matchedTemplateIntervalWeeks: 1,
        matchedTemplateStartsAt: null,
        matchedTemplateEndsAt: null,
        reason: 'match',
      },
    ]);
    const patches = buildExecutePatches(snapshot);
    assertExecutePatchSafety(patches[0]!);
    expect(() =>
      assertExecutePatchSafety({
        scheduledClassId: 'sc-1',
        scheduleTemplateId: 'tpl-a',
        startsAt: 'nope',
      } as never),
    ).toThrow();
  });

  it('snapshot hash stable for same mapping', () => {
    const plan = planStandaloneLinkage(
      [row({ id: 'sc-1' }), row({ id: 'sc-2', startsAt: studioLocalTimeToUtc('2026-08-31', '06:00', TZ) })],
      [tpl({ id: 'tpl-a' })],
      TZ,
      NOW,
    );
    const a = buildApprovedLinkageSnapshot('studio-ares', plan);
    const b = buildApprovedLinkageSnapshot('studio-ares', plan);
    expect(a.mappingHash).toBe(b.mappingHash);
    expect(a.mappings.length).toBe(2);
  });

  it('series simulated projection after mapping', () => {
    const templates = [tpl({ id: 'tpl-a' })];
    const plan = planStandaloneLinkage(
      [
        row({ id: 'sc-1', bookingCount: 2 }),
        row({ id: 'sc-2', startsAt: studioLocalTimeToUtc('2026-08-31', '06:00', TZ) }),
      ],
      templates,
      TZ,
      NOW,
    );
    const sim = simulateSeriesProjections(plan, templates);
    const item = sim.find((s) => s.templateId === 'tpl-a')!;
    expect(item.before.futureOccurrenceCount).toBe(0);
    expect(item.after.futureOccurrenceCount).toBe(2);
    expect(item.after.futureBookingCount).toBe(2);
    expect(item.after.nextOccurrence).toBeTruthy();
  });

  it('historical past row is HISTORICAL_PROTECTED', () => {
    const templates = [tpl({ id: 'tpl-a' })];
    const plan = classifyStandaloneOccurrence(
      row({ id: 'sc-past', startsAt: studioLocalTimeToUtc('2026-08-01', '06:00', TZ) }),
      templates,
      TZ,
      NOW,
      'future_scheduled_standalone',
    );
    expect(plan.classification).toBe('HISTORICAL_PROTECTED');
  });

  it('cancelled future row excluded from primary scope', () => {
    const templates = [tpl({ id: 'tpl-a' })];
    const plan = classifyStandaloneOccurrence(
      row({ id: 'sc-c', status: 'CANCELLED' }),
      templates,
      TZ,
      NOW,
      'future_scheduled_standalone',
    );
    expect(plan.classification).toBe('HISTORICAL_PROTECTED');
  });

  it('summary counts match rows with bookings', () => {
    const templates = [tpl({ id: 'tpl-a' })];
    const plan = planStandaloneLinkage(
      [row({ id: 'sc-1', bookingCount: 1 })],
      templates,
      TZ,
      NOW,
    );
    const summary = summarizeLinkagePlan(plan, templates);
    expect(summary.match).toBe(1);
    expect(summary.matchWithBookings).toBe(1);
  });

  it('approved hash changes when mapping changes', () => {
    const planA = planStandaloneLinkage([row({ id: 'sc-1' })], [tpl({ id: 'tpl-a' })], TZ, NOW);
    const planB = planStandaloneLinkage([row({ id: 'sc-1' })], [tpl({ id: 'tpl-b' })], TZ, NOW);
    const hashA = buildApprovedLinkageSnapshot('studio-ares', planA).mappingHash;
    const hashB = buildApprovedLinkageSnapshot('studio-ares', planB).mappingHash;
    expect(hashA).not.toBe(hashB);
  });

  it('identity vs recurrence helpers align with classify', () => {
    const templates = [tpl({ id: 'tpl-a' })];
    const input = row({ id: 'sc-1' });
    const identity = findIdentityCandidateTemplates(input, templates, TZ);
    const recurrence = findRecurrenceValidTemplates(input, identity, TZ);
    expect(recurrence.length).toBe(1);
  });
});
