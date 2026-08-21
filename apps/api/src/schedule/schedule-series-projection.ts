import { ClassStatus, ScheduleOccurrenceExceptionKind } from '@prisma/client';
import { addDaysToDateKey, getStudioLocalDateKey } from '../common/date/studio-local-date';
import {
  isLegacyUnboundedTemplate,
  MaterializableTemplate,
  templateEffectiveEndKey,
  templateEffectiveStartKey,
} from './schedule-materialization';

export type SeriesUiStatus = 'ACTIVE' | 'ENDING_SOON' | 'ENDED';

export type SeriesOccurrenceExceptionLabel = 'DETACHED' | 'CANCELLED' | null;

const WEEKDAY_LABELS_ES = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
] as const;

const ENDING_SOON_DAYS = 14;

export function weekdayLabelEs(dayOfWeek: number): string {
  return WEEKDAY_LABELS_ES[dayOfWeek] ?? '—';
}

export function deriveSeriesStatus(
  template: { active: boolean; endsAt: Date | null },
  timezone: string,
  todayKey: string,
): SeriesUiStatus {
  if (!template.active) return 'ENDED';
  const endKey = template.endsAt ? getStudioLocalDateKey(template.endsAt, timezone) : null;
  if (endKey && endKey < todayKey) return 'ENDED';
  if (endKey) {
    const soonKey = addDaysToDateKey(todayKey, ENDING_SOON_DAYS);
    if (endKey <= soonKey) return 'ENDING_SOON';
  }
  return 'ACTIVE';
}

export function occurrenceExceptionLabel(
  status: ClassStatus,
  exceptionKind: ScheduleOccurrenceExceptionKind | null,
): SeriesOccurrenceExceptionLabel {
  if (status === ClassStatus.CANCELLED) return 'CANCELLED';
  if (exceptionKind === ScheduleOccurrenceExceptionKind.DETACHED) return 'DETACHED';
  return null;
}

export function recurrenceStartsOnKey(
  template: MaterializableTemplate,
  timezone: string,
  earliestOccurrenceStartsAt: Date | null | undefined,
): string | null {
  if (isLegacyUnboundedTemplate(template)) {
    if (earliestOccurrenceStartsAt) {
      return getStudioLocalDateKey(earliestOccurrenceStartsAt, timezone);
    }
    return null;
  }
  return templateEffectiveStartKey(template, timezone);
}

export function recurrenceEndsOnKey(
  template: MaterializableTemplate,
  timezone: string,
): string | null {
  return templateEffectiveEndKey(template, timezone);
}

export function matchesSeriesListFilter(
  item: {
    status: SeriesUiStatus;
    classTemplateName: string;
    instructorName: string | null;
    instructorId: string | null;
  },
  filter: {
    status?: 'all' | 'active' | 'ended';
    search?: string;
    instructorId?: string;
  },
): boolean {
  if (filter.status === 'active' && item.status === 'ENDED') return false;
  if (filter.status === 'ended' && item.status !== 'ENDED') return false;
  if (filter.instructorId && item.instructorId !== filter.instructorId) return false;
  if (filter.search?.trim()) {
    const q = filter.search.trim().toLowerCase();
    const haystack = `${item.classTemplateName} ${item.instructorName ?? ''}`.toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}
