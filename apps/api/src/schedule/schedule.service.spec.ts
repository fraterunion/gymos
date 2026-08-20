import { BadRequestException, ConflictException } from '@nestjs/common';
import { ScheduleConflictsService } from './schedule-conflicts.service';
import { ScheduleService } from './schedule.service';

function makePrisma() {
  return {
    studio: { findFirst: jest.fn() },
    classTemplate: { findFirst: jest.fn() },
    scheduledClass: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    studioMembership: { findFirst: jest.fn() },
  };
}

describe('ScheduleService — studio-local scheduling', () => {
  let service: ScheduleService;
  let prisma: ReturnType<typeof makePrisma>;
  let conflicts: jest.Mocked<ScheduleConflictsService>;

  beforeEach(() => {
    prisma = makePrisma();
    conflicts = {
      findConflictsForSlots: jest.fn().mockResolvedValue([]),
      partitionConflicts: jest.fn().mockReturnValue({ blocking: [], warnings: [] }),
      assertCapacityNotBelowBookings: jest.fn(),
    } as unknown as jest.Mocked<ScheduleConflictsService>;
    service = new ScheduleService(prisma as never, conflicts);
  });

  it('creates class using studio-local Mexico City time', async () => {
    prisma.studio.findFirst.mockResolvedValue({ timezone: 'America/Mexico_City' });
    prisma.classTemplate.findFirst.mockResolvedValue({
      id: 'ct-1',
      defaultCapacity: 25,
      durationMinutes: 60,
    });
    prisma.scheduledClass.findFirst.mockResolvedValue(null);
    prisma.scheduledClass.create.mockImplementation(({ data }) => data);

    await service.createScheduledClass('studio-1', {
      templateId: 'ct-1',
      localStart: { date: '2026-08-26', time: '07:00' },
      localEnd: { date: '2026-08-26', time: '08:00' },
    });

    expect(prisma.scheduledClass.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          startsAt: new Date('2026-08-26T13:00:00.000Z'),
          endsAt: new Date('2026-08-26T14:00:00.000Z'),
        }),
      }),
    );
  });

  it('blocks duplicate manual creation server-side', async () => {
    prisma.studio.findFirst.mockResolvedValue({ timezone: 'America/Mexico_City' });
    prisma.classTemplate.findFirst.mockResolvedValue({
      id: 'ct-1',
      defaultCapacity: 25,
      durationMinutes: 60,
    });
    prisma.scheduledClass.findFirst.mockResolvedValue({ id: 'existing' });

    await expect(
      service.createScheduledClass('studio-1', {
        templateId: 'ct-1',
        localStart: { date: '2026-08-26', time: '07:00' },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('requires local or UTC times', () => {
    expect(() =>
      service.resolveOccurrenceTimes(undefined, undefined, undefined, undefined, 'UTC', 60),
    ).toThrow(BadRequestException);
  });
});

describe('ScheduleService — New York DST recurrence clock', () => {
  it('keeps 7:00 AM local across DST fall transition', () => {
    const service = new ScheduleService({} as never, {} as never);
    const beforeDst = service.resolveOccurrenceTimes(
      { date: '2026-11-04', time: '07:00' },
      { date: '2026-11-04', time: '08:00' },
      undefined,
      undefined,
      'America/New_York',
      60,
    );
    const afterDst = service.resolveOccurrenceTimes(
      { date: '2026-11-11', time: '07:00' },
      { date: '2026-11-11', time: '08:00' },
      undefined,
      undefined,
      'America/New_York',
      60,
    );

    const fmt = (d: Date) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(d);

    expect(fmt(beforeDst.startsAt)).toMatch(/07:00/);
    expect(fmt(afterDst.startsAt)).toMatch(/07:00/);
    expect(afterDst.startsAt.getTime() - beforeDst.startsAt.getTime()).toBe(7 * 86_400_000);
  });
});
