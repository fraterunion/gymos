import {
  addDaysToDateKey,
  getDayOfWeekFromDateKey,
  getStudioLocalDateKey,
  studioLocalDateKeyToUtcAnchor,
  studioLocalTimeToUtc,
} from '../common/date/studio-local-date';
import { occurrenceDedupKey } from '../schedule/schedule-occurrence-key';

export type MaterializableTemplate = {
  id: string;
  classTemplateId: string;
  instructorId: string | null;
  dayOfWeek: number;
  startTime: string;
  capacity: number | null;
  /** NULL = legacy / implicit weekly rule without an explicit start boundary. */
  startsAt: Date | null;
  endsAt: Date | null;
  intervalWeeks: number;
  createdAt?: Date;
  classTemplate: {
    id: string;
    name: string;
    durationMinutes: number;
    defaultCapacity: number;
  };
};

export type MaterializationCandidate = {
  scheduleTemplateId: string;
  classTemplateId: string;
  instructorId: string | null;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  templateName: string;
  localDateKey: string;
};

export type ExistingOccurrenceRow = {
  classTemplateId: string;
  startsAt: Date;
  scheduleTemplateId: string | null;
  status: string;
};

/** Weeks elapsed between two local date keys (timezone-independent calendar math). */
export function weeksBetweenDateKeys(fromKey: string, toKey: string): number {
  const [fy, fm, fd] = fromKey.split('-').map(Number);
  const [ty, tm, td] = toKey.split('-').map(Number);
  const fromMs = Date.UTC(fy!, fm! - 1, fd!);
  const toMs = Date.UTC(ty!, tm! - 1, td!);
  return Math.floor((toMs - fromMs) / (7 * 86_400_000));
}

/** Legacy weekly templates and implicit rules have no explicit recurrence start. */
export function isLegacyUnboundedTemplate(template: MaterializableTemplate): boolean {
  return template.startsAt === null;
}

export function templateEffectiveStartKey(template: MaterializableTemplate, timezone: string): string {
  if (template.startsAt === null) {
    return '1970-01-01';
  }
  return getStudioLocalDateKey(template.startsAt, timezone);
}

export function templateEffectiveEndKey(
  template: MaterializableTemplate,
  timezone: string,
): string | null {
  if (!template.endsAt) return null;
  return getStudioLocalDateKey(template.endsAt, timezone);
}

/**
 * Last recurrence local date strictly before boundaryDateKey for this template's rule.
 * Used for series split endsAt (inclusive last active date on predecessor template).
 */
export function lastRecurrenceDateKeyStrictlyBefore(
  template: Pick<MaterializableTemplate, 'dayOfWeek' | 'intervalWeeks' | 'startsAt' | 'endsAt' | 'createdAt'>,
  boundaryDateKey: string,
  timezone: string,
): string | null {
  const materializable = template as MaterializableTemplate;
  const startKey = templateEffectiveStartKey(materializable, timezone);
  if (boundaryDateKey <= startKey) return null;

  let cursor = boundaryDateKey;
  for (let i = 0; i < 400; i++) {
    cursor = addDaysToDateKey(cursor, -1);
    if (cursor < startKey) return null;
    if (isTemplateActiveOnDateKey(materializable, cursor, timezone)) {
      return cursor;
    }
  }
  return null;
}

export function isTemplateActiveOnDateKey(
  template: MaterializableTemplate,
  dateKey: string,
  timezone: string,
): boolean {
  const startKey = templateEffectiveStartKey(template, timezone);
  if (dateKey < startKey) return false;
  const endKey = templateEffectiveEndKey(template, timezone);
  // endsAt is inclusive on the local recurrence calendar date.
  if (endKey && dateKey > endKey) return false;
  if (getDayOfWeekFromDateKey(dateKey) !== template.dayOfWeek) return false;
  const interval = template.intervalWeeks ?? 1;
  if (interval > 1) {
    const weeks = weeksBetweenDateKeys(startKey, dateKey);
    if (weeks % interval !== 0) return false;
  }
  return true;
}

export function buildCandidatesForTemplateInRange(
  template: MaterializableTemplate,
  timezone: string,
  fromDateKey: string,
  toDateKeyExclusive: string,
): MaterializationCandidate[] {
  const out: MaterializationCandidate[] = [];
  let cursor = fromDateKey;
  while (cursor < toDateKeyExclusive) {
    if (isTemplateActiveOnDateKey(template, cursor, timezone)) {
      const startsAt = studioLocalTimeToUtc(cursor, template.startTime, timezone);
      const endsAt = new Date(
        startsAt.getTime() + template.classTemplate.durationMinutes * 60_000,
      );
      const capacity = template.capacity ?? template.classTemplate.defaultCapacity;
      out.push({
        scheduleTemplateId: template.id,
        classTemplateId: template.classTemplateId,
        instructorId: template.instructorId ?? null,
        startsAt,
        endsAt,
        capacity,
        templateName: template.classTemplate.name,
        localDateKey: cursor,
      });
    }
    cursor = addDaysToDateKey(cursor, 1);
  }
  return out;
}

/** Index existing rows by template+localDate and by dedup key. */
export function indexExistingOccurrences(
  rows: ExistingOccurrenceRow[],
  timezone: string,
): {
  dedupKeys: Set<string>;
  templateDateKeys: Set<string>;
} {
  const dedupKeys = new Set<string>();
  const templateDateKeys = new Set<string>();
  for (const row of rows) {
    dedupKeys.add(occurrenceDedupKey(row.classTemplateId, row.startsAt));
    if (row.scheduleTemplateId) {
      const dk = getStudioLocalDateKey(row.startsAt, timezone);
      templateDateKeys.add(`${row.scheduleTemplateId}|${dk}`);
    }
  }
  return { dedupKeys, templateDateKeys };
}

export function shouldSkipCandidate(
  candidate: MaterializationCandidate,
  dedupKeys: Set<string>,
  templateDateKeys: Set<string>,
): boolean {
  const key = occurrenceDedupKey(candidate.classTemplateId, candidate.startsAt);
  if (dedupKeys.has(key)) return true;
  if (templateDateKeys.has(`${candidate.scheduleTemplateId}|${candidate.localDateKey}`)) {
    return true;
  }
  return false;
}

export function utcRangeToLocalDateKeys(
  from: Date,
  to: Date,
  timezone: string,
): { fromDateKey: string; toDateKeyExclusive: string } {
  const fromDateKey = getStudioLocalDateKey(from, timezone);
  const toDateKey = getStudioLocalDateKey(to, timezone);
  const toDateKeyExclusive = addDaysToDateKey(toDateKey, 1);
  return { fromDateKey, toDateKeyExclusive };
}

/**
 * The schedule generator walks UTC calendar days in [utcFrom, utcTo) and resolves a
 * studio-local date key at each step. Existing-row discovery must span every local
 * calendar day that iteration can touch — not the raw UTC bounds alone.
 *
 * Production failure (Aug 2026): utcFrom = Aug 18 00:00Z still maps to Aug 17 local
 * in America/Mexico_City, producing candidates whose startsAt can precede utcFrom.
 */
export function utcGeneratorWindowToExistingQueryRange(
  utcFrom: Date,
  utcTo: Date,
  timezone: string,
): { rangeStart: Date; rangeEnd: Date } {
  const localDateKeys = new Set<string>();
  const current = new Date(utcFrom);
  while (current < utcTo) {
    localDateKeys.add(getStudioLocalDateKey(current, timezone));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  if (localDateKeys.size === 0) {
    return { rangeStart: utcFrom, rangeEnd: utcTo };
  }
  const sorted = [...localDateKeys].sort();
  const firstKey = sorted[0]!;
  const lastKey = sorted[sorted.length - 1]!;
  return {
    rangeStart: studioLocalDateKeyToUtcAnchor(firstKey, timezone),
    rangeEnd: studioLocalDateKeyToUtcAnchor(addDaysToDateKey(lastKey, 1), timezone),
  };
}

export function localDateKeyToStartsAtAnchor(dateKey: string, timezone: string): Date {
  return studioLocalDateKeyToUtcAnchor(dateKey, timezone);
}

export function addDaysToLocalDateKey(dateKey: string, days: number): string {
  return addDaysToDateKey(dateKey, days);
}
