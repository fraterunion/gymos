import { createHash } from 'node:crypto';
import {
  getDayOfWeekFromDateKey,
  getStudioLocalDateKey,
  getStudioLocalHHmm,
  studioLocalTimeToUtc,
} from '../common/date/studio-local-date';
import {
  isTemplateActiveOnDateKey,
  MaterializableTemplate,
  type MaterializationCandidate,
} from './schedule-materialization';

export type LinkageClassification =
  | 'MATCH'
  | 'NO_MATCH'
  | 'AMBIGUOUS'
  | 'OUT_OF_BOUNDARY'
  | 'HISTORICAL_PROTECTED'
  | 'ALREADY_LINKED'
  | 'INVALID';

export type LinkageTemplateRef = {
  id: string;
  classTemplateId: string;
  instructorId: string | null;
  dayOfWeek: number;
  startTime: string;
  capacity: number | null;
  intervalWeeks: number;
  startsAt: Date | null;
  endsAt: Date | null;
  active: boolean;
  classTemplate: MaterializableTemplate['classTemplate'];
};

export type LinkageOccurrenceInput = {
  id: string;
  studioId: string;
  classTemplateId: string;
  classTemplateName: string;
  startsAt: Date;
  status: string;
  scheduleTemplateId: string | null;
  bookingCount: number;
  attendanceCount: number;
  waitlistCount: number;
};

export type LinkagePlanRow = {
  scheduledClassId: string;
  startsAtUtc: string;
  localDate: string;
  localTime: string;
  weekday: number;
  classTemplateId: string;
  classTemplateName: string;
  status: string;
  currentScheduleTemplateId: string | null;
  bookingCount: number;
  attendanceCount: number;
  waitlistCount: number;
  classification: LinkageClassification;
  matchedScheduleTemplateId: string | null;
  matchedTemplateDayOfWeek: number | null;
  matchedTemplateStartTime: string | null;
  matchedTemplateIntervalWeeks: number | null;
  matchedTemplateStartsAt: string | null;
  matchedTemplateEndsAt: string | null;
  reason: string;
};

export type LinkageSummary = {
  totalFutureStandaloneScheduled: number;
  match: number;
  noMatch: number;
  ambiguous: number;
  outOfBoundary: number;
  invalid: number;
  historicalProtected: number;
  alreadyLinked: number;
  matchWithBookings: number;
  matchWithAttendance: number;
  matchWithWaitlist: number;
  templatesReceivingLinkedRows: number;
  templatesReceivingZeroLinkedRows: number;
  byClass: Array<{
    className: string;
    match: number;
    noMatch: number;
    ambiguous: number;
    outOfBoundary: number;
  }>;
  byTemplate: Array<{
    templateId: string;
    className: string;
    weekday: number;
    startTime: string;
    eligibleRows: number;
    first: string | null;
    last: string | null;
  }>;
};

export type LinkageSnapshot = {
  studioId: string;
  generatedAt: string;
  scope: 'future_scheduled_standalone';
  mappingHash: string;
  counts: Pick<
    LinkageSummary,
    'match' | 'noMatch' | 'ambiguous' | 'outOfBoundary' | 'invalid'
  >;
  mappings: Array<{ scheduledClassId: string; scheduleTemplateId: string }>;
};

export type SimulatedSeriesProjection = {
  templateId: string;
  className: string;
  weekday: number;
  startTime: string;
  before: {
    nextOccurrence: string | null;
    futureOccurrenceCount: number;
    futureBookingCount: number;
  };
  after: {
    nextOccurrence: string | null;
    futureOccurrenceCount: number;
    futureBookingCount: number;
  };
};

const WEEKDAY_LABELS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

function weekdayLabel(day: number): string {
  return WEEKDAY_LABELS[day] ?? `day-${day}`;
}

/** Identity candidates: same class, local weekday, local HH:mm — no recurrence yet. */
export function findIdentityCandidateTemplates(
  row: Pick<LinkageOccurrenceInput, 'classTemplateId' | 'startsAt'>,
  templates: LinkageTemplateRef[],
  timezone: string,
): LinkageTemplateRef[] {
  const localDate = getStudioLocalDateKey(row.startsAt, timezone);
  const localTime = getStudioLocalHHmm(row.startsAt, timezone);
  const weekday = getDayOfWeekFromDateKey(localDate);

  return templates.filter(
    (tpl) =>
      tpl.active &&
      tpl.classTemplateId === row.classTemplateId &&
      tpl.dayOfWeek === weekday &&
      tpl.startTime === localTime,
  );
}

/** Recurrence-valid owners using Calendar 2.1 materialization rules. */
export function findRecurrenceValidTemplates(
  row: Pick<LinkageOccurrenceInput, 'startsAt'>,
  identityMatches: LinkageTemplateRef[],
  timezone: string,
): LinkageTemplateRef[] {
  const localDate = getStudioLocalDateKey(row.startsAt, timezone);

  return identityMatches.filter((tpl) => {
    const materializable = tpl as unknown as MaterializableTemplate;
    if (!isTemplateActiveOnDateKey(materializable, localDate, timezone)) {
      return false;
    }
    const expectedStartsAt = studioLocalTimeToUtc(localDate, tpl.startTime, timezone);
    return expectedStartsAt.getTime() === row.startsAt.getTime();
  });
}

export function classifyStandaloneOccurrence(
  row: LinkageOccurrenceInput,
  templates: LinkageTemplateRef[],
  timezone: string,
  now: Date,
  scope: 'future_scheduled_standalone',
): LinkagePlanRow {
  const base = buildBasePlanRow(row, timezone);

  if (!row.id || !row.startsAt || !row.classTemplateId) {
    return {
      ...base,
      classification: 'INVALID',
      reason: 'Missing required scheduled class identity fields',
    };
  }

  if (row.scheduleTemplateId) {
    return {
      ...base,
      classification: 'ALREADY_LINKED',
      matchedScheduleTemplateId: row.scheduleTemplateId,
      reason: 'scheduleTemplateId already populated',
    };
  }

  if (scope === 'future_scheduled_standalone') {
    if (row.startsAt < now) {
      return {
        ...base,
        classification: 'HISTORICAL_PROTECTED',
        reason: 'Past occurrence outside approved future remediation scope',
      };
    }
    if (row.status !== 'SCHEDULED') {
      return {
        ...base,
        classification: 'HISTORICAL_PROTECTED',
        reason: `Non-SCHEDULED status (${row.status}) excluded from initial remediation scope`,
      };
    }
  }

  const identityMatches = findIdentityCandidateTemplates(row, templates, timezone);
  if (identityMatches.length === 0) {
    return {
      ...base,
      classification: 'NO_MATCH',
      reason: 'No active ScheduleTemplate matches classTemplateId + local weekday + local time',
    };
  }

  const recurrenceMatches = findRecurrenceValidTemplates(row, identityMatches, timezone);
  if (recurrenceMatches.length === 0) {
    const ids = identityMatches.map((t) => t.id).join(', ');
    return {
      ...base,
      classification: 'OUT_OF_BOUNDARY',
      reason: `Template identity match (${ids}) but occurrence date ${base.localDate} is outside template recurrence bounds/cadence per isTemplateActiveOnDateKey`,
    };
  }

  if (recurrenceMatches.length > 1) {
    return {
      ...base,
      classification: 'AMBIGUOUS',
      reason: `${recurrenceMatches.length} active templates match classTemplateId + ${weekdayLabel(base.weekday)} ${base.localTime} local + valid recurrence date`,
    };
  }

  const tpl = recurrenceMatches[0]!;
  return {
    ...base,
    classification: 'MATCH',
    matchedScheduleTemplateId: tpl.id,
    matchedTemplateDayOfWeek: tpl.dayOfWeek,
    matchedTemplateStartTime: tpl.startTime,
    matchedTemplateIntervalWeeks: tpl.intervalWeeks,
    matchedTemplateStartsAt: tpl.startsAt?.toISOString() ?? null,
    matchedTemplateEndsAt: tpl.endsAt?.toISOString() ?? null,
    reason: `Exact classTemplateId + ${weekdayLabel(tpl.dayOfWeek)} ${tpl.startTime} local + occurrence ${base.localDate} is valid under intervalWeeks=${tpl.intervalWeeks} template cadence (Calendar 2.1 isTemplateActiveOnDateKey)`,
  };
}

function emptyMatchFields(): Pick<
  LinkagePlanRow,
  | 'matchedScheduleTemplateId'
  | 'matchedTemplateDayOfWeek'
  | 'matchedTemplateStartTime'
  | 'matchedTemplateIntervalWeeks'
  | 'matchedTemplateStartsAt'
  | 'matchedTemplateEndsAt'
> {
  return {
    matchedScheduleTemplateId: null,
    matchedTemplateDayOfWeek: null,
    matchedTemplateStartTime: null,
    matchedTemplateIntervalWeeks: null,
    matchedTemplateStartsAt: null,
    matchedTemplateEndsAt: null,
  };
}

function buildBasePlanRow(
  row: LinkageOccurrenceInput,
  timezone: string,
): Omit<LinkagePlanRow, 'classification' | 'reason'> {
  const localDate = getStudioLocalDateKey(row.startsAt, timezone);
  return {
    scheduledClassId: row.id,
    startsAtUtc: row.startsAt.toISOString(),
    localDate,
    localTime: getStudioLocalHHmm(row.startsAt, timezone),
    weekday: getDayOfWeekFromDateKey(localDate),
    classTemplateId: row.classTemplateId,
    classTemplateName: row.classTemplateName,
    status: row.status,
    currentScheduleTemplateId: row.scheduleTemplateId,
    bookingCount: row.bookingCount,
    attendanceCount: row.attendanceCount,
    waitlistCount: row.waitlistCount,
    ...emptyMatchFields(),
  };
}

export function planStandaloneLinkage(
  rows: LinkageOccurrenceInput[],
  templates: LinkageTemplateRef[],
  timezone: string,
  now: Date = new Date(),
  scope: 'future_scheduled_standalone' = 'future_scheduled_standalone',
): LinkagePlanRow[] {
  return rows.map((row) =>
    classifyStandaloneOccurrence(row, templates, timezone, now, scope),
  );
}

export function summarizeLinkagePlan(
  plan: LinkagePlanRow[],
  activeTemplates: LinkageTemplateRef[],
): LinkageSummary {
  const matchRows = plan.filter((r) => r.classification === 'MATCH');
  const byClassMap = new Map<
    string,
    { match: number; noMatch: number; ambiguous: number; outOfBoundary: number }
  >();
  const byTemplateMap = new Map<
    string,
    { className: string; weekday: number; startTime: string; starts: string[] }
  >();

  for (const row of plan) {
    if (row.classification === 'HISTORICAL_PROTECTED' || row.classification === 'ALREADY_LINKED') {
      continue;
    }
    const entry = byClassMap.get(row.classTemplateName) ?? {
      match: 0,
      noMatch: 0,
      ambiguous: 0,
      outOfBoundary: 0,
    };
    if (row.classification === 'MATCH') entry.match++;
    else if (row.classification === 'NO_MATCH') entry.noMatch++;
    else if (row.classification === 'AMBIGUOUS') entry.ambiguous++;
    else if (row.classification === 'OUT_OF_BOUNDARY') entry.outOfBoundary++;
    byClassMap.set(row.classTemplateName, entry);
  }

  for (const row of matchRows) {
    const tid = row.matchedScheduleTemplateId!;
    const cur = byTemplateMap.get(tid) ?? {
      className: row.classTemplateName,
      weekday: row.matchedTemplateDayOfWeek!,
      startTime: row.matchedTemplateStartTime!,
      starts: [],
    };
    cur.starts.push(row.startsAtUtc);
    byTemplateMap.set(tid, cur);
  }

  const templatesReceiving = new Set(matchRows.map((r) => r.matchedScheduleTemplateId!));

  return {
    totalFutureStandaloneScheduled: plan.filter(
      (r) =>
        r.classification !== 'HISTORICAL_PROTECTED' &&
        r.classification !== 'ALREADY_LINKED' &&
        r.classification !== 'INVALID',
    ).length,
    match: matchRows.length,
    noMatch: plan.filter((r) => r.classification === 'NO_MATCH').length,
    ambiguous: plan.filter((r) => r.classification === 'AMBIGUOUS').length,
    outOfBoundary: plan.filter((r) => r.classification === 'OUT_OF_BOUNDARY').length,
    invalid: plan.filter((r) => r.classification === 'INVALID').length,
    historicalProtected: plan.filter((r) => r.classification === 'HISTORICAL_PROTECTED').length,
    alreadyLinked: plan.filter((r) => r.classification === 'ALREADY_LINKED').length,
    matchWithBookings: matchRows.filter((r) => r.bookingCount > 0).length,
    matchWithAttendance: matchRows.filter((r) => r.attendanceCount > 0).length,
    matchWithWaitlist: matchRows.filter((r) => r.waitlistCount > 0).length,
    templatesReceivingLinkedRows: templatesReceiving.size,
    templatesReceivingZeroLinkedRows: activeTemplates.filter((t) => !templatesReceiving.has(t.id))
      .length,
    byClass: [...byClassMap.entries()]
      .map(([className, counts]) => ({ className, ...counts }))
      .sort((a, b) => a.className.localeCompare(b.className)),
    byTemplate: [...byTemplateMap.entries()]
      .map(([templateId, data]) => ({
        templateId,
        className: data.className,
        weekday: data.weekday,
        startTime: data.startTime,
        eligibleRows: data.starts.length,
        first: data.starts.sort()[0] ?? null,
        last: data.starts.sort().at(-1) ?? null,
      }))
      .sort((a, b) =>
        `${a.className}-${a.weekday}-${a.startTime}`.localeCompare(
          `${b.className}-${b.weekday}-${b.startTime}`,
        ),
      ),
  };
}

export function buildApprovedLinkageSnapshot(
  studioId: string,
  plan: LinkagePlanRow[],
): LinkageSnapshot {
  const mappings = plan
    .filter((r) => r.classification === 'MATCH' && r.matchedScheduleTemplateId)
    .map((r) => ({
      scheduledClassId: r.scheduledClassId,
      scheduleTemplateId: r.matchedScheduleTemplateId!,
    }))
    .sort((a, b) => a.scheduledClassId.localeCompare(b.scheduledClassId));

  const payload = JSON.stringify(mappings);
  const mappingHash = createHash('sha256').update(payload).digest('hex');

  return {
    studioId,
    generatedAt: new Date().toISOString(),
    scope: 'future_scheduled_standalone',
    mappingHash,
    counts: {
      match: plan.filter((r) => r.classification === 'MATCH').length,
      noMatch: plan.filter((r) => r.classification === 'NO_MATCH').length,
      ambiguous: plan.filter((r) => r.classification === 'AMBIGUOUS').length,
      outOfBoundary: plan.filter((r) => r.classification === 'OUT_OF_BOUNDARY').length,
      invalid: plan.filter((r) => r.classification === 'INVALID').length,
    },
    mappings,
  };
}

/** Simulate Series list metrics after applying MATCH mappings only. */
export function simulateSeriesProjections(
  plan: LinkagePlanRow[],
  activeTemplates: LinkageTemplateRef[],
): SimulatedSeriesProjection[] {
  const matchByTemplate = new Map<string, LinkagePlanRow[]>();
  for (const row of plan) {
    if (row.classification !== 'MATCH' || !row.matchedScheduleTemplateId) continue;
    const arr = matchByTemplate.get(row.matchedScheduleTemplateId) ?? [];
    arr.push(row);
    matchByTemplate.set(row.matchedScheduleTemplateId, arr);
  }

  return activeTemplates.map((tpl) => {
    const matched = (matchByTemplate.get(tpl.id) ?? []).sort((a, b) =>
      a.startsAtUtc.localeCompare(b.startsAtUtc),
    );
    const futureBookingCount = matched.reduce((s, r) => s + r.bookingCount, 0);

    return {
      templateId: tpl.id,
      className: tpl.classTemplate.name,
      weekday: tpl.dayOfWeek,
      startTime: tpl.startTime,
      before: {
        nextOccurrence: null,
        futureOccurrenceCount: 0,
        futureBookingCount: 0,
      },
      after: {
        nextOccurrence: matched[0]?.startsAtUtc ?? null,
        futureOccurrenceCount: matched.length,
        futureBookingCount,
      },
    };
  });
}

/** Future execute patch — ONLY scheduleTemplateId may change. */
export type LinkageExecutePatch = {
  scheduledClassId: string;
  scheduleTemplateId: string;
};

export function buildExecutePatches(snapshot: LinkageSnapshot): LinkageExecutePatch[] {
  return snapshot.mappings.map((m) => ({
    scheduledClassId: m.scheduledClassId,
    scheduleTemplateId: m.scheduleTemplateId,
  }));
}

export function assertExecutePatchSafety(
  patch: LinkageExecutePatch,
): asserts patch is LinkageExecutePatch {
  const keys = Object.keys(patch).sort();
  if (keys.length !== 2 || keys[0] !== 'scheduleTemplateId' || keys[1] !== 'scheduledClassId') {
    throw new Error('Execute patch may only contain scheduledClassId and scheduleTemplateId');
  }
}

/** Verify a candidate would match generator materialization for its template/date. */
export function candidateMatchesGeneratorSlot(
  candidate: MaterializationCandidate,
  rowStartsAt: Date,
): boolean {
  return candidate.startsAt.getTime() === rowStartsAt.getTime();
}
