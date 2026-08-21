import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { PrismaService } from '../prisma/prisma.service';
import {
  releaseScheduleAutomationSessionLock,
  tryAcquireScheduleAutomationSessionLock,
} from '../schedule/schedule-occurrence-concurrency';
import { ScheduleGeneratorService } from './schedule-generator.service';

const AUTOMATION_CRON = '0 8 * * *';
const AUTOMATION_JOB_NAME = 'schedule-automation-daily';

export type ScheduleAutomationAction =
  | 'SKIPPED_DISABLED'
  | 'SKIPPED_HEALTHY'
  | 'GENERATION_STARTED'
  | 'GENERATION_COMPLETED'
  | 'GENERATION_FAILED';

@Injectable()
export class ScheduleAutomationService implements OnModuleInit {
  private readonly logger = new Logger(ScheduleAutomationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly generator: ScheduleGeneratorService,
    @Optional() private readonly schedulerRegistry?: SchedulerRegistry,
  ) {}

  /** Runs daily at 08:00 UTC (≈ 02:00 America/Mexico_City). Skipped in e2e. */
  onModuleInit(): void {
    if (process.env['GYMOS_E2E'] === '1' || !this.schedulerRegistry) {
      return;
    }
    const job = new CronJob(AUTOMATION_CRON, () => {
      void this.runDailyAutomation();
    });
    this.schedulerRegistry.addCronJob(AUTOMATION_JOB_NAME, job);
    job.start();
  }

  async runDailyAutomation(): Promise<void> {
    const settings = await this.prisma.scheduleAutomationSettings.findMany({
      include: { studio: { select: { id: true, deletedAt: true } } },
    });

    for (const cfg of settings) {
      if (cfg.studio.deletedAt) continue;
      try {
        await this.evaluateStudio(cfg.studio.id, cfg.enabled, cfg.minFutureDays);
      } catch (err) {
        this.logEvaluation({
          studioId: cfg.studio.id,
          evaluatedAt: new Date().toISOString(),
          enabled: cfg.enabled,
          minFutureDays: cfg.minFutureDays,
          activeTemplateCount: 0,
          undercoveredTemplateCount: 0,
          action: 'GENERATION_FAILED',
          reason: err instanceof Error ? err.message : 'unknown error',
        });
        this.logger.error(`Automation failed for studio ${cfg.studio.id}`, err);
      }
    }
  }

  /** Evaluates one studio and optionally runs generation under advisory lock. */
  async evaluateStudio(
    studioId: string,
    enabled: boolean,
    minFutureDays: number,
  ): Promise<void> {
    const evaluatedAt = new Date().toISOString();

    if (!enabled) {
      this.logEvaluation({
        studioId,
        evaluatedAt,
        enabled: false,
        minFutureDays,
        activeTemplateCount: 0,
        undercoveredTemplateCount: 0,
        action: 'SKIPPED_DISABLED',
        reason: 'automation disabled for studio',
      });
      return;
    }

    const coverage = await this.generator.getTemplateCoverage(studioId, minFutureDays);

    if (!coverage.needsGeneration) {
      this.logEvaluation({
        studioId,
        evaluatedAt,
        enabled: true,
        minFutureDays,
        activeTemplateCount: coverage.activeTemplateCount,
        undercoveredTemplateCount: 0,
        action: 'SKIPPED_HEALTHY',
        reason: 'all active templates have sufficient linked coverage',
      });
      return;
    }

    this.logEvaluation({
      studioId,
      evaluatedAt,
      enabled: true,
      minFutureDays,
      activeTemplateCount: coverage.activeTemplateCount,
      undercoveredTemplateCount: coverage.undercoveredTemplateCount,
      action: 'GENERATION_STARTED',
      reason: `${coverage.undercoveredTemplateCount} template(s) undercovered`,
    });

    const acquired = await tryAcquireScheduleAutomationSessionLock(this.prisma, studioId);
    if (!acquired) {
      this.logEvaluation({
        studioId,
        evaluatedAt: new Date().toISOString(),
        enabled: true,
        minFutureDays,
        activeTemplateCount: coverage.activeTemplateCount,
        undercoveredTemplateCount: coverage.undercoveredTemplateCount,
        action: 'SKIPPED_HEALTHY',
        reason: 'another replica holds automation lock',
      });
      return;
    }

    const from = new Date();
    const to = new Date(from.getTime() + minFutureDays * 86_400_000);

    try {
      const result = await this.generator.runGeneration(studioId, from, to, {
        isDryRun: false,
        triggeredBy: 'AUTOMATIC',
      });

      this.logEvaluation({
        studioId,
        evaluatedAt: new Date().toISOString(),
        enabled: true,
        minFutureDays,
        activeTemplateCount: coverage.activeTemplateCount,
        undercoveredTemplateCount: coverage.undercoveredTemplateCount,
        action: 'GENERATION_COMPLETED',
        reason: 'generation finished',
        generated: result.generated,
        skipped: result.skipped,
        errors: result.errors,
        elapsedMs: result.durationMs,
      });
    } catch (err) {
      this.logEvaluation({
        studioId,
        evaluatedAt: new Date().toISOString(),
        enabled: true,
        minFutureDays,
        activeTemplateCount: coverage.activeTemplateCount,
        undercoveredTemplateCount: coverage.undercoveredTemplateCount,
        action: 'GENERATION_FAILED',
        reason: err instanceof Error ? err.message : 'generation failed',
      });
      throw err;
    } finally {
      await releaseScheduleAutomationSessionLock(this.prisma, studioId);
    }
  }

  private logEvaluation(payload: {
    studioId: string;
    evaluatedAt: string;
    enabled: boolean;
    minFutureDays: number;
    activeTemplateCount: number;
    undercoveredTemplateCount: number;
    action: ScheduleAutomationAction;
    reason: string;
    generated?: number;
    skipped?: number;
    errors?: number;
    elapsedMs?: number;
  }) {
    this.logger.log(
      JSON.stringify({
        event: 'scheduleAutomation.evaluated',
        ...payload,
      }),
    );
  }
}
