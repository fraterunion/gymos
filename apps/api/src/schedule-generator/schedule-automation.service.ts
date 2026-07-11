import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { PrismaService } from '../prisma/prisma.service';
import { ScheduleGeneratorService } from './schedule-generator.service';

const AUTOMATION_CRON = '0 8 * * *';
const AUTOMATION_JOB_NAME = 'schedule-automation-daily';

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
      where: { enabled: true },
      include: { studio: { select: { id: true, deletedAt: true } } },
    });

    for (const cfg of settings) {
      if (cfg.studio.deletedAt) continue;
      try {
        await this.runForStudio(cfg.studio.id, cfg.minFutureDays);
      } catch (err) {
        this.logger.error(`Automation failed for studio ${cfg.studio.id}`, err);
      }
    }
  }

  private async runForStudio(studioId: string, minFutureDays: number) {
    const status = await this.generator.getStatus(studioId);
    if (status.futureDays >= minFutureDays) return;

    const from = new Date();
    const to = new Date(from.getTime() + minFutureDays * 86_400_000);

    const result = await this.generator.runGeneration(studioId, from, to, {
      isDryRun: false,
      triggeredBy: 'AUTOMATIC',
    });

    this.logger.log(
      `Studio ${studioId}: generated ${result.generated}, skipped ${result.skipped} (${result.durationMs}ms)`,
    );
  }
}
