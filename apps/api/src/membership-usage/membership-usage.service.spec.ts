import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { MembershipUsageService } from './membership-usage.service';
import { MEMBERSHIP_CLASS_CREDITS_EXHAUSTED_MESSAGE } from './membership-usage.constants';

describe('MembershipUsageService', () => {
  const prisma = {
    $queryRaw: jest.fn(),
  };

  const service = new MembershipUsageService(prisma as never);

  const periodStart = new Date('2025-08-01T00:00:00.000Z');
  const periodEnd = new Date('2025-09-01T00:00:00.000Z');
  const subscription = {
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    membershipPlan: { classCredits: 8 },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('assertCreditAvailableForClass allows unlimited plans', async () => {
    await expect(
      service.assertCreditAvailableForClass(
        prisma as never,
        'studio-1',
        'user-1',
        'class-1',
        new Date('2025-08-10T12:00:00.000Z'),
        {
          ...subscription,
          membershipPlan: { classCredits: null },
        },
      ),
    ).resolves.toBeUndefined();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('assertCreditAvailableForClass rejects when credits exhausted', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ exists: false }])
      .mockResolvedValueOnce([{ count: 8n }]);

    await expect(
      service.assertCreditAvailableForClass(
        prisma as never,
        'studio-1',
        'user-1',
        'class-new',
        new Date('2025-08-10T12:00:00.000Z'),
        subscription,
        { errorType: 'bad_request' },
      ),
    ).rejects.toThrow(new BadRequestException(MEMBERSHIP_CLASS_CREDITS_EXHAUSTED_MESSAGE));
  });

  it('assertCreditAvailableForClass is idempotent when class already consumed', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([{ exists: true }]);

    await expect(
      service.assertCreditAvailableForClass(
        prisma as never,
        'studio-1',
        'user-1',
        'class-existing',
        new Date('2025-08-10T12:00:00.000Z'),
        subscription,
        { errorType: 'forbidden' },
      ),
    ).resolves.toBeUndefined();

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('getUsageForPeriod returns remaining credits', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([{ count: 3n }]);

    const usage = await service.getUsageForPeriod(
      prisma as never,
      'studio-1',
      'user-1',
      { start: periodStart, end: periodEnd },
      8,
    );

    expect(usage).toEqual({
      classCredits: 8,
      creditsUsed: 3,
      creditsRemaining: 5,
      period: { start: periodStart, end: periodEnd },
    });
  });

  it('throws ForbiddenException for booking gate', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ exists: false }])
      .mockResolvedValueOnce([{ count: 8n }]);

    await expect(
      service.assertCreditAvailableForClass(
        prisma as never,
        'studio-1',
        'user-1',
        'class-new',
        new Date('2025-08-10T12:00:00.000Z'),
        subscription,
        { errorType: 'forbidden' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
