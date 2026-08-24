import { BadRequestException, ConflictException } from '@nestjs/common';
import { ScheduleConflictsService } from './schedule-conflicts.service';
import { ScheduleService } from './schedule.service';

function makePrisma() {
  const scheduledClass = {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  };
  return {
    studio: { findFirst: jest.fn() },
    classTemplate: { findFirst: jest.fn() },
    scheduledClass,
    studioMembership: { findFirst: jest.fn() },
    $transaction: jest.fn(async (fn) => {
      const tx = {
        scheduledClass,
        $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
      };
      return fn(tx);
    }),
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
    prisma.scheduledClass.findFirst.mockResolvedValue({
      id: 'existing',
      status: 'SCHEDULED',
      scheduleTemplateId: null,
      exceptionKind: null,
      _count: { bookings: 0, attendances: 0, waitlist: 0 },
    });

    await expect(
      service.createScheduledClass('studio-1', {
        templateId: 'ct-1',
        localStart: { date: '2026-08-26', time: '07:00' },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('reactivates an empty CANCELLED tombstone instead of inserting', async () => {
    prisma.studio.findFirst.mockResolvedValue({ timezone: 'America/Mexico_City' });
    prisma.classTemplate.findFirst.mockResolvedValue({
      id: 'ct-1',
      defaultCapacity: 25,
      durationMinutes: 60,
    });
    prisma.scheduledClass.findFirst.mockResolvedValue({
      id: 'tomb-1',
      status: 'CANCELLED',
      scheduleTemplateId: null,
      exceptionKind: null,
      _count: { bookings: 0, attendances: 0, waitlist: 0 },
    });
    prisma.scheduledClass.update.mockImplementation(({ where, data }) => ({
      id: where.id,
      ...data,
    }));

    const row = await service.createScheduledClass('studio-1', {
      templateId: 'ct-1',
      localStart: { date: '2026-08-26', time: '07:00' },
      localEnd: { date: '2026-08-26', time: '08:00' },
      capacity: 12,
    });

    expect(prisma.scheduledClass.create).not.toHaveBeenCalled();
    expect(prisma.scheduledClass.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tomb-1' },
        data: expect.objectContaining({
          status: 'SCHEDULED',
          cancelReason: null,
          capacity: 12,
          scheduleTemplateId: null,
          exceptionKind: null,
        }),
      }),
    );
    expect(row.id).toBe('tomb-1');
  });

  it('blocks CANCELLED-with-history without updating', async () => {
    prisma.studio.findFirst.mockResolvedValue({ timezone: 'America/Mexico_City' });
    prisma.classTemplate.findFirst.mockResolvedValue({
      id: 'ct-1',
      defaultCapacity: 25,
      durationMinutes: 60,
    });
    prisma.scheduledClass.findFirst.mockResolvedValue({
      id: 'tomb-hist',
      status: 'CANCELLED',
      scheduleTemplateId: null,
      exceptionKind: null,
      _count: { bookings: 1, attendances: 0, waitlist: 0 },
    });

    await expect(
      service.createScheduledClass('studio-1', {
        templateId: 'ct-1',
        localStart: { date: '2026-08-26', time: '07:00' },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.scheduledClass.update).not.toHaveBeenCalled();
    expect(prisma.scheduledClass.create).not.toHaveBeenCalled();
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
