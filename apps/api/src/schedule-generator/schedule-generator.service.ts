import { ClassStatus } from '@prisma/client';
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  getStudioLocalDateKey,
  studioLocalTimeToUtc,
} from '../common/date/studio-local-date';
import {
  indexExistingOccurrences,
  isTemplateActiveOnDateKey,
  MaterializableTemplate,
  shouldSkipCandidate,
} from '../schedule/schedule-materialization';
import { occurrenceDedupKey } from '../schedule/schedule-occurrence-key';

export interface GenerationSummary {
  generated: number;
  skipped: number;
  conflicts: number;
  errors: number;
  durationMs: number;
  breakdown: Record<string, { name: string; generated: number; skipped: number }>;
  runId?: string;
}

export interface GenerationOptions {
  isDryRun: boolean;
  triggeredBy: 'MANUAL' | 'AUTOMATIC';
  userId?: string;
}

const DEFAULT_HORIZON_DAYS = 90;

@Injectable()
export class ScheduleGeneratorService {
  constructor(private readonly prisma: PrismaService) {}

  /** Coverage stats: how far ahead the schedule currently extends. */
  async getStatus(studioId: string) {
    const studio = await this.prisma.studio.findFirst({
      where: { id: studioId, deletedAt: null },
      select: { timezone: true },
    });
    if (!studio) throw new NotFoundException('Studio not found');

    const [templateCount, lastClass] = await Promise.all([
      this.prisma.scheduleTemplate.count({
        where: { studioId, active: true, deletedAt: null },
      }),
      this.prisma.scheduledClass.findFirst({
        where: { studioId, status: ClassStatus.SCHEDULED, startsAt: { gte: new Date() } },
        orderBy: { startsAt: 'desc' },
        select: { startsAt: true },
      }),
    ]);

    const now = new Date();
    const lastClassDate = lastClass?.startsAt ?? null;
    const futureDays = lastClassDate
      ? Math.floor((lastClassDate.getTime() - now.getTime()) / 86_400_000)
      : 0;

    return { lastClassDate, futureDays, templateCount };
  }

  async preview(studioId: string, from: Date, to: Date): Promise<GenerationSummary> {
    return this.runGeneration(studioId, from, to, {
      isDryRun: true,
      triggeredBy: 'MANUAL',
    });
  }

  async generateRange(
    studioId: string,
    from: Date,
    to: Date,
    options: GenerationOptions,
  ): Promise<GenerationSummary> {
    return this.runGeneration(studioId, from, to, options);
  }

  async generateNextDays(
    studioId: string,
    days: number,
    options: GenerationOptions,
  ): Promise<GenerationSummary> {
    const from = new Date();
    const to = new Date(from.getTime() + days * 86_400_000);
    return this.runGeneration(studioId, from, to, options);
  }

  async generateToEndOfYear(
    studioId: string,
    options: GenerationOptions,
  ): Promise<GenerationSummary> {
    const from = new Date();
    const to = new Date(Date.UTC(from.getUTCFullYear(), 11, 31, 23, 59, 59));
    return this.runGeneration(studioId, from, to, options);
  }

  async listRuns(studioId: string) {
    return this.prisma.scheduleGenerationRun.findMany({
      where: { studioId },
      include: {
        user: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { startedAt: 'desc' },
      take: 50,
    });
  }

  async getAutomation(studioId: string) {
    const settings = await this.prisma.scheduleAutomationSettings.findUnique({
      where: { studioId },
    });
    return settings ?? { studioId, enabled: false, minFutureDays: 90 };
  }

  async updateAutomation(
    studioId: string,
    enabled: boolean,
    minFutureDays?: number,
  ) {
    return this.prisma.scheduleAutomationSettings.upsert({
      where: { studioId },
      create: { studioId, enabled, minFutureDays: minFutureDays ?? 90 },
      update: {
        enabled,
        ...(minFutureDays !== undefined ? { minFutureDays } : {}),
      },
    });
  }

  /** Core generation engine. Shared by all public methods. */
  async runGeneration(
    studioId: string,
    from: Date,
    to: Date,
    options: GenerationOptions,
  ): Promise<GenerationSummary> {
    const t0 = Date.now();

    const studio = await this.prisma.studio.findFirst({
      where: { id: studioId, deletedAt: null },
      select: { timezone: true },
    });
    if (!studio) throw new NotFoundException('Studio not found');

    const templates = await this.prisma.scheduleTemplate.findMany({
      where: { studioId, active: true, deletedAt: null },
      include: {
        classTemplate: {
          select: {
            id: true,
            name: true,
            durationMinutes: true,
            defaultCapacity: true,
          },
        },
      },
    });

    if (templates.length === 0) {
      return { generated: 0, skipped: 0, conflicts: 0, errors: 0, durationMs: Date.now() - t0, breakdown: {} };
    }

    const utcFrom = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
    const utcTo = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));

    type Candidate = {
      scheduleTemplateId: string;
      classTemplateId: string;
      instructorId: string | null;
      startsAt: Date;
      endsAt: Date;
      capacity: number;
      templateName: string;
      localDateKey: string;
    };

    const candidates: Candidate[] = [];
    const current = new Date(utcFrom);

    while (current < utcTo) {
      const dateKey = getStudioLocalDateKey(current, studio.timezone);

      for (const tpl of templates as MaterializableTemplate[]) {
        if (!isTemplateActiveOnDateKey(tpl, dateKey, studio.timezone)) continue;

        const startsAt = studioLocalTimeToUtc(dateKey, tpl.startTime, studio.timezone);
        const endsAt = new Date(
          startsAt.getTime() + tpl.classTemplate.durationMinutes * 60_000,
        );
        const capacity = tpl.capacity ?? tpl.classTemplate.defaultCapacity;

        candidates.push({
          scheduleTemplateId: tpl.id,
          classTemplateId: tpl.classTemplateId,
          instructorId: tpl.instructorId ?? null,
          startsAt,
          endsAt,
          capacity,
          templateName: tpl.classTemplate.name,
          localDateKey: dateKey,
        });
      }

      current.setUTCDate(current.getUTCDate() + 1);
    }

    if (candidates.length === 0) {
      return { generated: 0, skipped: 0, conflicts: 0, errors: 0, durationMs: Date.now() - t0, breakdown: {} };
    }

    const existingClasses = await this.prisma.scheduledClass.findMany({
      where: {
        studioId,
        startsAt: { gte: utcFrom, lt: utcTo },
      },
      select: {
        classTemplateId: true,
        startsAt: true,
        scheduleTemplateId: true,
        status: true,
      },
    });

    const { dedupKeys, templateDateKeys } = indexExistingOccurrences(
      existingClasses,
      studio.timezone,
    );

    const toCreate: Candidate[] = [];
    const breakdown: Record<string, { name: string; generated: number; skipped: number }> = {};

    for (const c of candidates) {
      const key = occurrenceDedupKey(c.classTemplateId, c.startsAt);
      if (!breakdown[c.classTemplateId]) {
        breakdown[c.classTemplateId] = { name: c.templateName, generated: 0, skipped: 0 };
      }
      const materialized = {
        scheduleTemplateId: c.scheduleTemplateId,
        classTemplateId: c.classTemplateId,
        instructorId: c.instructorId,
        startsAt: c.startsAt,
        endsAt: c.endsAt,
        capacity: c.capacity,
        templateName: c.templateName,
        localDateKey: c.localDateKey,
      };
      if (
        dedupKeys.has(key) ||
        shouldSkipCandidate(materialized, dedupKeys, templateDateKeys)
      ) {
        breakdown[c.classTemplateId]!.skipped++;
      } else {
        breakdown[c.classTemplateId]!.generated++;
        toCreate.push(c);
      }
    }

    const skipped = candidates.length - toCreate.length;

    if (options.isDryRun) {
      return {
        generated: toCreate.length,
        skipped,
        conflicts: 0,
        errors: 0,
        durationMs: Date.now() - t0,
        breakdown,
      };
    }

    let errors = 0;
    if (toCreate.length > 0) {
      try {
        await this.prisma.scheduledClass.createMany({
          data: toCreate.map((c) => ({
            studioId,
            classTemplateId: c.classTemplateId,
            scheduleTemplateId: c.scheduleTemplateId,
            instructorId: c.instructorId,
            startsAt: c.startsAt,
            endsAt: c.endsAt,
            capacity: c.capacity,
            status: ClassStatus.SCHEDULED,
          })),
        });
      } catch {
        errors = toCreate.length;
      }
    }

    const durationMs = Date.now() - t0;
    const generated = errors === 0 ? toCreate.length : 0;

    let runId: string | undefined;
    try {
      const run = await this.prisma.scheduleGenerationRun.create({
        data: {
          studioId,
          triggeredBy: options.triggeredBy,
          userId: options.userId ?? null,
          isDryRun: false,
          fromDate: utcFrom,
          toDate: utcTo,
          generated,
          skipped,
          conflicts: 0,
          errors,
          durationMs,
          breakdown: breakdown as object,
          finishedAt: new Date(),
        },
      });
      runId = run.id;
    } catch {
      // run logging failure does not affect the generation result
    }

    return { generated, skipped, conflicts: 0, errors, durationMs, breakdown, runId };
  }

  private async getHorizonDays(studioId: string): Promise<number> {
    const settings = await this.prisma.scheduleAutomationSettings.findUnique({
      where: { studioId },
    });
    return settings?.minFutureDays ?? DEFAULT_HORIZON_DAYS;
  }
}
