import { ScheduleAutomationService } from './schedule-automation.service';
import { ScheduleGeneratorService } from './schedule-generator.service';
import { PrismaService } from '../prisma/prisma.service';

jest.mock('../schedule/schedule-occurrence-concurrency', () => ({
  tryAcquireScheduleAutomationSessionLock: jest.fn().mockResolvedValue(true),
  releaseScheduleAutomationSessionLock: jest.fn().mockResolvedValue(undefined),
}));

describe('ScheduleAutomationService', () => {
  const prisma = {
    scheduleAutomationSettings: { findMany: jest.fn() },
    $transaction: jest.fn(),
    $executeRawUnsafe: jest.fn(),
  } as unknown as PrismaService;

  const generator = {
    getTemplateCoverage: jest.fn(),
    runGeneration: jest.fn(),
  } as unknown as ScheduleGeneratorService;

  let service: ScheduleAutomationService;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ScheduleAutomationService(prisma, generator);
    logSpy = jest.spyOn((service as unknown as { logger: { log: jest.Mock } }).logger, 'log').mockImplementation();
  });

  it('logs SKIPPED_DISABLED when automation disabled', async () => {
    await service.evaluateStudio('studio-1', false, 90);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"action":"SKIPPED_DISABLED"'),
    );
  });

  it('logs SKIPPED_HEALTHY when all templates covered', async () => {
    (generator.getTemplateCoverage as jest.Mock).mockResolvedValue({
      activeTemplateCount: 3,
      undercoveredTemplateCount: 0,
      needsGeneration: false,
    });
    await service.evaluateStudio('studio-1', true, 90);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"action":"SKIPPED_HEALTHY"'),
    );
  });

  it('logs GENERATION_COMPLETED when undercovered and generation succeeds', async () => {
    (generator.getTemplateCoverage as jest.Mock).mockResolvedValue({
      activeTemplateCount: 3,
      undercoveredTemplateCount: 2,
      needsGeneration: true,
    });
    (generator.runGeneration as jest.Mock).mockResolvedValue({
      generated: 10,
      skipped: 2,
      errors: 0,
      durationMs: 50,
    });
    await service.evaluateStudio('studio-1', true, 90);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"action":"GENERATION_COMPLETED"'),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"generated":10'),
    );
  });
});
