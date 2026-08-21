import { NotFoundException } from '@nestjs/common';
import { ScheduleGeneratorService } from './schedule-generator.service';

// Minimal Prisma mock factory
function makePrisma(overrides: Record<string, unknown> = {}) {
  return {
    studio: {
      findFirst: jest.fn(),
    },
    scheduleTemplate: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
    scheduledClass: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      createMany: jest.fn(),
      count: jest.fn(),
    },
    scheduleGenerationRun: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
    scheduleAutomationSettings: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    ...overrides,
  };
}

const STUDIO = { id: 'studio-1', timezone: 'America/Mexico_City' };

// Mexico City is UTC-6. UTC midnight Oct 6 = Oct 5 evening local → local date Oct 5 (Monday).
const FROM = new Date('2026-10-06T00:00:00.000Z');
const TO = new Date('2026-10-07T00:00:00.000Z');

describe('ScheduleGeneratorService', () => {
  let service: ScheduleGeneratorService;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
    service = new ScheduleGeneratorService(prisma as never);
  });

  describe('runGeneration — empty templates', () => {
    it('returns zero counts when no active templates exist', async () => {
      (prisma.studio.findFirst as jest.Mock).mockResolvedValue(STUDIO);
      (prisma.scheduleTemplate.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.runGeneration('studio-1', FROM, TO, {
        isDryRun: true,
        triggeredBy: 'MANUAL',
      });

      expect(result.generated).toBe(0);
      expect(result.skipped).toBe(0);
    });
  });

  describe('runGeneration — throws when studio not found', () => {
    it('throws NotFoundException', async () => {
      (prisma.studio.findFirst as jest.Mock).mockResolvedValue(null);
      await expect(
        service.runGeneration('bad-id', FROM, TO, { isDryRun: true, triggeredBy: 'MANUAL' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('runGeneration — dry run', () => {
    it('counts new classes without inserting anything', async () => {
      (prisma.studio.findFirst as jest.Mock).mockResolvedValue(STUDIO);
      // Monday (dow=1) template: Upper Push at 06:00
      (prisma.scheduleTemplate.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'tpl-1',
          classTemplateId: 'ct-1',
          instructorId: null,
          dayOfWeek: 1, // Monday
          startTime: '06:00',
          capacity: null,
          startsAt: new Date('2020-01-01T00:00:00.000Z'),
          endsAt: null,
          intervalWeeks: 1,
          classTemplate: { id: 'ct-1', name: 'Upper Push', durationMinutes: 60, defaultCapacity: 15 },
        },
      ]);
      (prisma.scheduledClass.findMany as jest.Mock).mockResolvedValue([]); // nothing exists yet

      const result = await service.runGeneration('studio-1', FROM, TO, {
        isDryRun: true,
        triggeredBy: 'MANUAL',
      });

      expect(result.generated).toBe(1);
      expect(result.skipped).toBe(0);
      expect(prisma.scheduledClass.createMany).not.toHaveBeenCalled();
      expect(result.breakdown['ct-1']?.name).toBe('Upper Push');
    });

    it('skips a class that already exists (same templateId + startsAt)', async () => {
      (prisma.studio.findFirst as jest.Mock).mockResolvedValue(STUDIO);
      (prisma.scheduleTemplate.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'tpl-1',
          classTemplateId: 'ct-1',
          instructorId: null,
          dayOfWeek: 1, // Monday
          startTime: '06:00',
          capacity: null,
          startsAt: new Date('2020-01-01T00:00:00.000Z'),
          endsAt: null,
          intervalWeeks: 1,
          classTemplate: { id: 'ct-1', name: 'Upper Push', durationMinutes: 60, defaultCapacity: 15 },
        },
      ]);
      // Simulate that 06:00 Mexico City = 12:00 UTC already exists
      (prisma.scheduledClass.findMany as jest.Mock).mockResolvedValue([
        { classTemplateId: 'ct-1', startsAt: new Date('2026-10-05T12:00:00.000Z'), scheduleTemplateId: null, status: 'SCHEDULED' },
      ]);

      const result = await service.runGeneration('studio-1', FROM, TO, {
        isDryRun: true,
        triggeredBy: 'MANUAL',
      });

      expect(result.generated).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it('Aug-18 shape: skips Legs+HIIT when existing row UTC-starts before utcFrom (Mexico City)', async () => {
      const utcFrom = new Date('2026-08-18T00:00:00.000Z');
      const utcTo = new Date('2026-08-19T00:00:00.000Z');
      (prisma.studio.findFirst as jest.Mock).mockResolvedValue(STUDIO);
      (prisma.scheduleTemplate.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'tpl-legs',
          classTemplateId: 'ct-legs',
          instructorId: null,
          dayOfWeek: 1,
          startTime: '06:00',
          capacity: 10,
          startsAt: null,
          endsAt: null,
          intervalWeeks: 1,
          classTemplate: {
            id: 'ct-legs',
            name: 'Legs + HIIT',
            durationMinutes: 60,
            defaultCapacity: 10,
          },
        },
      ]);

      const existingStartsAt = new Date('2026-08-17T12:00:00.000Z');
      (prisma.scheduledClass.findMany as jest.Mock).mockImplementation(({ where }) => {
        const rows = [
          {
            classTemplateId: 'ct-legs',
            startsAt: existingStartsAt,
            scheduleTemplateId: null,
            status: 'CANCELLED',
          },
        ];
        const gte = where.startsAt.gte as Date;
        const lt = where.startsAt.lt as Date;
        expect(existingStartsAt.getTime()).toBeGreaterThanOrEqual(gte.getTime());
        expect(existingStartsAt.getTime()).toBeLessThan(lt.getTime());
        return rows.filter(
          (r) => r.startsAt >= gte && r.startsAt < lt,
        );
      });

      const result = await service.runGeneration('studio-1', utcFrom, utcTo, {
        isDryRun: true,
        triggeredBy: 'MANUAL',
      });

      expect(result.generated).toBe(0);
      expect(result.skipped).toBe(1);
      expect(prisma.scheduledClass.createMany).not.toHaveBeenCalled();
    });

    it('does not match template with wrong dayOfWeek', async () => {
      (prisma.studio.findFirst as jest.Mock).mockResolvedValue(STUDIO);
      (prisma.scheduleTemplate.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'tpl-1',
          classTemplateId: 'ct-1',
          instructorId: null,
          dayOfWeek: 2, // Tuesday — but FROM is Monday
          startTime: '06:00',
          capacity: null,
          classTemplate: { id: 'ct-1', name: 'Upper Push', durationMinutes: 60, defaultCapacity: 15 },
        },
      ]);
      (prisma.scheduledClass.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.runGeneration('studio-1', FROM, TO, {
        isDryRun: true,
        triggeredBy: 'MANUAL',
      });

      expect(result.generated).toBe(0);
      expect(result.skipped).toBe(0);
    });
  });

  describe('runGeneration — actual insert', () => {
    it('calls createMany and persists a run record', async () => {
      (prisma.studio.findFirst as jest.Mock).mockResolvedValue(STUDIO);
      (prisma.scheduleTemplate.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'tpl-1',
          classTemplateId: 'ct-1',
          instructorId: null,
          dayOfWeek: 1,
          startTime: '06:00',
          capacity: 20,
          classTemplate: { id: 'ct-1', name: 'Upper Push', durationMinutes: 60, defaultCapacity: 15 },
        },
      ]);
      (prisma.scheduledClass.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.scheduledClass.createMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.scheduleGenerationRun.create as jest.Mock).mockResolvedValue({ id: 'run-1' });

      const result = await service.runGeneration('studio-1', FROM, TO, {
        isDryRun: false,
        triggeredBy: 'MANUAL',
        userId: 'user-1',
      });

      expect(result.generated).toBe(1);
      expect(result.runId).toBe('run-1');
      expect(prisma.scheduledClass.createMany).toHaveBeenCalledTimes(1);
      expect(prisma.scheduleGenerationRun.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('getStatus', () => {
    it('returns 0 futureDays when no future classes', async () => {
      (prisma.studio.findFirst as jest.Mock).mockResolvedValue(STUDIO);
      (prisma.scheduleAutomationSettings.findUnique as jest.Mock).mockResolvedValue({
        minFutureDays: 90,
      });
      (prisma.scheduleTemplate.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.scheduledClass.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.scheduleTemplate.count as jest.Mock).mockResolvedValue(4);
      (prisma.scheduledClass.findFirst as jest.Mock).mockResolvedValue(null);

      const status = await service.getStatus('studio-1');
      expect(status.futureDays).toBe(0);
      expect(status.templateCount).toBe(4);
      expect(status.lastClassDate).toBeNull();
      expect(status.needsGeneration).toBe(false);
    });
  });
});
