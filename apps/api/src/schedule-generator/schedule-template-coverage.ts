import { ClassStatus } from '@prisma/client';
import { getStudioLocalDateKey } from '../common/date/studio-local-date';
import { isTemplateActiveOnDateKey, type MaterializableTemplate } from '../schedule/schedule-materialization';

export type CoverageTemplate = MaterializableTemplate & { active: boolean };

export type TemplateCoverageRow = {
  templateId: string;
  futureLinkedCount: number;
  lastLinkedFutureStartsAt: Date | null;
  linkedHorizonDays: number;
  undercovered: boolean;
};

export type StudioTemplateCoverage = {
  activeTemplateCount: number;
  undercoveredTemplateCount: number;
  undercoveredTemplateIds: string[];
  templates: TemplateCoverageRow[];
  needsGeneration: boolean;
};

type LinkedOccurrence = {
  scheduleTemplateId: string | null;
  startsAt: Date;
};

export function computeTemplateCoverage(
  templates: CoverageTemplate[],
  linkedFutureOccurrences: LinkedOccurrence[],
  timezone: string,
  minFutureDays: number,
  now: Date = new Date(),
): StudioTemplateCoverage {
  const activeTemplates = templates.filter((t) => t.active);
  const byTemplate = new Map<string, Date[]>();

  for (const row of linkedFutureOccurrences) {
    if (!row.scheduleTemplateId) continue;
    const list = byTemplate.get(row.scheduleTemplateId) ?? [];
    list.push(row.startsAt);
    byTemplate.set(row.scheduleTemplateId, list);
  }

  const coverageRows: TemplateCoverageRow[] = activeTemplates.map((tpl) => {
    const starts = (byTemplate.get(tpl.id) ?? []).sort((a, b) => b.getTime() - a.getTime());
    const lastLinkedFutureStartsAt = starts[0] ?? null;
    const linkedHorizonDays = lastLinkedFutureStartsAt
      ? Math.floor((lastLinkedFutureStartsAt.getTime() - now.getTime()) / 86_400_000)
      : 0;

    const expectedHasFutureSlot = hasExpectedFutureRecurrence(tpl, timezone, now, minFutureDays);
    const undercovered =
      expectedHasFutureSlot &&
      (starts.length === 0 || linkedHorizonDays < minFutureDays);

    return {
      templateId: tpl.id,
      futureLinkedCount: starts.length,
      lastLinkedFutureStartsAt,
      linkedHorizonDays,
      undercovered,
    };
  });

  const undercovered = coverageRows.filter((r) => r.undercovered);

  return {
    activeTemplateCount: activeTemplates.length,
    undercoveredTemplateCount: undercovered.length,
    undercoveredTemplateIds: undercovered.map((r) => r.templateId),
    templates: coverageRows,
    needsGeneration: undercovered.length > 0,
  };
}

/** Whether cadence implies at least one occurrence within minFutureDays. */
function hasExpectedFutureRecurrence(
  tpl: CoverageTemplate,
  timezone: string,
  now: Date,
  minFutureDays: number,
): boolean {
  const end = new Date(now.getTime() + minFutureDays * 86_400_000);
  const cursor = new Date(now);
  while (cursor <= end) {
    const dateKey = getStudioLocalDateKey(cursor, timezone);
    if (isTemplateActiveOnDateKey(tpl, dateKey, timezone)) {
      return true;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return false;
}

export async function loadLinkedFutureOccurrences(
  prisma: { scheduledClass: { findMany: (args: object) => Promise<LinkedOccurrence[]> } },
  studioId: string,
  now: Date = new Date(),
): Promise<LinkedOccurrence[]> {
  return prisma.scheduledClass.findMany({
    where: {
      studioId,
      status: ClassStatus.SCHEDULED,
      startsAt: { gte: now },
      scheduleTemplateId: { not: null },
    },
    select: { scheduleTemplateId: true, startsAt: true },
  });
}
