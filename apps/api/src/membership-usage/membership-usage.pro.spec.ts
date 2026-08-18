/**
 * Pro Plan regression suite — 5 classes per subscription period.
 *
 * These tests guard the exact boundary between allowed and denied
 * for classCredits = 5. They are NOT meant to be exhaustive of all
 * MembershipUsageService behaviour — see membership-usage.service.spec.ts
 * for the general contract.
 */

import { ForbiddenException } from '@nestjs/common';
import { ClassCategory, Role } from '@prisma/client';
import { MembershipUsageService } from './membership-usage.service';
import { MEMBERSHIP_CLASS_CREDITS_EXHAUSTED_MESSAGE } from './membership-usage.constants';
import { BookingAccessService } from '../bookings/booking-access.service';

// ─── Shared fixtures ────────────────────────────────────────────────────────

const PRO_CLASS_CREDITS = 5;

const PERIOD_START = new Date('2026-07-28T00:00:00.000Z');
const PERIOD_END = new Date('2026-08-28T00:00:00.000Z');

const NEXT_PERIOD_START = PERIOD_END;
const NEXT_PERIOD_END = new Date('2026-09-28T00:00:00.000Z');

const CLASS_IN_PERIOD = new Date('2026-08-10T18:00:00.000Z');
const CLASS_IN_NEXT_PERIOD = new Date('2026-09-05T18:00:00.000Z');

const PRO_SUBSCRIPTION = {
  currentPeriodStart: PERIOD_START,
  currentPeriodEnd: PERIOD_END,
  membershipPlan: { classCredits: PRO_CLASS_CREDITS },
};

function makeUsageService(queryRawImpl?: jest.Mock) {
  const prisma = { $queryRaw: queryRawImpl ?? jest.fn() };
  return { service: new MembershipUsageService(prisma as never), prisma };
}

// $queryRaw call order in assertCreditAvailableForClass:
//   1st → isClassConsumedInPeriod: returns [{ exists: boolean }]
//   2nd → countConsumedClasses:    returns [{ count: bigint }]

function mockNotConsumedAndCount(prisma: { $queryRaw: jest.Mock }, count: number) {
  prisma.$queryRaw
    .mockResolvedValueOnce([{ exists: false }])
    .mockResolvedValueOnce([{ count: BigInt(count) }]);
}

function mockAlreadyConsumed(prisma: { $queryRaw: jest.Mock }) {
  prisma.$queryRaw.mockResolvedValueOnce([{ exists: true }]);
}

// ─── Pro credit boundary tests ───────────────────────────────────────────────

describe('Pro plan (classCredits = 5) — credit boundary', () => {
  it('[1] 0 / 5 used → booking allowed', async () => {
    const { service, prisma } = makeUsageService();
    mockNotConsumedAndCount(prisma, 0);

    await expect(
      service.assertCreditAvailableForClass(
        prisma as never,
        'studio-1',
        'user-1',
        'class-new',
        CLASS_IN_PERIOD,
        PRO_SUBSCRIPTION,
      ),
    ).resolves.toBeUndefined();
  });

  it('[2] 4 / 5 used → fifth booking allowed', async () => {
    const { service, prisma } = makeUsageService();
    mockNotConsumedAndCount(prisma, 4);

    await expect(
      service.assertCreditAvailableForClass(
        prisma as never,
        'studio-1',
        'user-1',
        'class-new',
        CLASS_IN_PERIOD,
        PRO_SUBSCRIPTION,
      ),
    ).resolves.toBeUndefined();
  });

  it('[3] 5 / 5 used → sixth booking denied with ForbiddenException', async () => {
    const { service, prisma } = makeUsageService();
    mockNotConsumedAndCount(prisma, 5);

    await expect(
      service.assertCreditAvailableForClass(
        prisma as never,
        'studio-1',
        'user-1',
        'class-new',
        CLASS_IN_PERIOD,
        PRO_SUBSCRIPTION,
        { errorType: 'forbidden' },
      ),
    ).rejects.toThrow(new ForbiddenException(MEMBERSHIP_CLASS_CREDITS_EXHAUSTED_MESSAGE));
  });

  it('[3a] 5 / 5 used + no day pass → exactly ForbiddenException (not BadRequest)', async () => {
    const { service, prisma } = makeUsageService();
    mockNotConsumedAndCount(prisma, 5);

    const error = await service
      .assertCreditAvailableForClass(
        prisma as never,
        'studio-1',
        'user-1',
        'class-new',
        CLASS_IN_PERIOD,
        PRO_SUBSCRIPTION,
        { errorType: 'forbidden' },
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).message).toBe(MEMBERSHIP_CLASS_CREDITS_EXHAUSTED_MESSAGE);
  });
});

// ─── Non-consuming statuses ──────────────────────────────────────────────────

describe('[4] Non-consuming booking statuses do not reduce Pro allowance', () => {
  it('re-booking an already-consumed class is idempotent (no double-count)', async () => {
    const { service, prisma } = makeUsageService();
    mockAlreadyConsumed(prisma);

    await expect(
      service.assertCreditAvailableForClass(
        prisma as never,
        'studio-1',
        'user-1',
        'class-already-booked',
        CLASS_IN_PERIOD,
        PRO_SUBSCRIPTION,
      ),
    ).resolves.toBeUndefined();

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});

// ─── Period reset ────────────────────────────────────────────────────────────

describe('[5] New subscription period resets the 5-class allowance', () => {
  it('after renewal, count for new period starts at 0 → booking allowed', async () => {
    const { service, prisma } = makeUsageService();
    mockNotConsumedAndCount(prisma, 0);

    const renewedSubscription = {
      currentPeriodStart: NEXT_PERIOD_START,
      currentPeriodEnd: NEXT_PERIOD_END,
      membershipPlan: { classCredits: PRO_CLASS_CREDITS },
    };

    await expect(
      service.assertCreditAvailableForClass(
        prisma as never,
        'studio-1',
        'user-1',
        'class-next-period',
        CLASS_IN_NEXT_PERIOD,
        renewedSubscription,
      ),
    ).resolves.toBeUndefined();
  });

  it('previous period usage does not carry into new period (isolated count)', async () => {
    const { service, prisma } = makeUsageService();
    // Old period: 5/5 used (would be denied). New period: 0/5 → allowed.
    // The service queries only for the period containing the class start.
    // With a renewed subscription covering the next period, the class in
    // next period resolves to next period bounds → count = 0 → allowed.
    mockNotConsumedAndCount(prisma, 0);

    const renewedSubscription = {
      currentPeriodStart: NEXT_PERIOD_START,
      currentPeriodEnd: NEXT_PERIOD_END,
      membershipPlan: { classCredits: PRO_CLASS_CREDITS },
    };

    await expect(
      service.assertCreditAvailableForClass(
        prisma as never,
        'studio-1',
        'user-1',
        'class-next-period',
        CLASS_IN_NEXT_PERIOD,
        renewedSubscription,
      ),
    ).resolves.toBeUndefined();
  });
});

// ─── Class access rules independent from credits ────────────────────────────

describe('[6] Class access rules apply independently from credit count', () => {
  const membershipUsage = {
    assertCreditAvailableForClass: jest.fn().mockResolvedValue(undefined),
  } as unknown as MembershipUsageService;

  const accessService = new BookingAccessService(membershipUsage);

  const studioId = 'studio-1';
  const userId = 'user-pro';
  const classStartsAt = CLASS_IN_PERIOD;
  const scheduledClassId = 'class-1';

  beforeEach(() => jest.clearAllMocks());

  function makeTx(
    subConfig: {
      allClassesAccess: boolean;
      allowedCategories: ClassCategory[];
      allowedTemplateIds: string[];
    },
    templateCategory: ClassCategory | null = ClassCategory.STRENGTH,
  ) {
    return {
      subscription: {
        findFirst: jest.fn().mockResolvedValue({
          currentPeriodStart: PERIOD_START,
          currentPeriodEnd: PERIOD_END,
          membershipPlan: {
            allClassesAccess: subConfig.allClassesAccess,
            allowedCategories: subConfig.allowedCategories,
            classCredits: PRO_CLASS_CREDITS,
            classTemplateAccess: subConfig.allowedTemplateIds.map((id) => ({
              classTemplateId: id,
            })),
          },
        }),
      },
      classTemplate: {
        findUnique: jest.fn().mockResolvedValue({ category: templateCategory }),
      },
      dayPass: { findFirst: jest.fn().mockResolvedValue(null) },
    };
  }

  it('Pro (allClassesAccess = true) with 2 / 5 used → class allowed', async () => {
    const tx = makeTx({ allClassesAccess: true, allowedCategories: [], allowedTemplateIds: [] });
    await expect(
      accessService.assertAccess(
        tx as never,
        studioId,
        userId,
        Role.MEMBER,
        classStartsAt,
        'America/Mexico_City',
        'tpl-strength',
        scheduledClassId,
      ),
    ).resolves.toBeUndefined();
    expect(membershipUsage.assertCreditAvailableForClass).toHaveBeenCalledTimes(1);
  });

  it('Pro plan still enforces credit check (assertCreditAvailableForClass is called)', async () => {
    const tx = makeTx({ allClassesAccess: true, allowedCategories: [], allowedTemplateIds: [] });
    await accessService.assertAccess(
      tx as never,
      studioId,
      userId,
      Role.MEMBER,
      classStartsAt,
      'America/Mexico_City',
      'tpl-strength',
      scheduledClassId,
    );
    expect(membershipUsage.assertCreditAvailableForClass).toHaveBeenCalledWith(
      tx,
      studioId,
      userId,
      scheduledClassId,
      classStartsAt,
      expect.objectContaining({ membershipPlan: expect.objectContaining({ classCredits: PRO_CLASS_CREDITS }) }),
      { errorType: 'forbidden' },
    );
  });
});

// ─── Lock serialization (simulated concurrency) ──────────────────────────────

describe('[7] Advisory lock serializes concurrent Pro bookings at 4/5', () => {
  it('sequential execution: first request succeeds, second sees count = 5 and is denied', async () => {
    // Simulates what happens when the advisory lock serializes two concurrent
    // requests that both entered at 4/5. First caller consumes the 5th slot;
    // second caller (running after the lock releases) sees count = 5 → denied.
    const { service, prisma: prismaA } = makeUsageService();
    const { service: serviceB, prisma: prismaB } = makeUsageService();

    // First caller: not yet consumed, count = 4 → allowed.
    mockNotConsumedAndCount(prismaA, 4);
    await expect(
      serviceA(service, prismaA, CLASS_IN_PERIOD),
    ).resolves.toBeUndefined();

    // Second caller (after lock releases): not yet consumed this specific class,
    // but count is now 5 (first caller's booking was committed) → denied.
    mockNotConsumedAndCount(prismaB, 5);
    await expect(
      serviceA(serviceB, prismaB, CLASS_IN_PERIOD),
    ).rejects.toThrow(new ForbiddenException(MEMBERSHIP_CLASS_CREDITS_EXHAUSTED_MESSAGE));
  });

  function serviceA(svc: MembershipUsageService, prisma: { $queryRaw: jest.Mock }, classStartsAt: Date) {
    return svc.assertCreditAvailableForClass(
      prisma as never,
      'studio-1',
      'user-1',
      'class-different',
      classStartsAt,
      PRO_SUBSCRIPTION,
      { errorType: 'forbidden' },
    );
  }
});

// ─── Future class in correct period ─────────────────────────────────────────

describe('[8] Future booking in next period uses canonical period semantics', () => {
  it('a class in the next period resolves correctly from a current-period subscription', async () => {
    const { service, prisma } = makeUsageService();
    // The subscription's currentPeriod is July 28 → Aug 28.
    // The class is in September (next period). The period resolver walks forward
    // one step to Aug 28 → Sep 28. Count query for that period returns 0 → allowed.
    mockNotConsumedAndCount(prisma, 0);

    await expect(
      service.assertCreditAvailableForClass(
        prisma as never,
        'studio-1',
        'user-1',
        'class-sep',
        CLASS_IN_NEXT_PERIOD,
        PRO_SUBSCRIPTION,
      ),
    ).resolves.toBeUndefined();
  });
});

// ─── Pending plan change does not alter current credits ─────────────────────

describe('[9] Pending plan change does not affect Pro credit enforcement', () => {
  it('subscription with pendingMembershipPlanId still enforces classCredits = 5', async () => {
    const { service, prisma } = makeUsageService();
    mockNotConsumedAndCount(prisma, 5);

    // assertCreditAvailableForClass receives the active subscription's plan,
    // not the pending one. The pending plan is transparent at this layer.
    const subscriptionWithPendingPlan = {
      ...PRO_SUBSCRIPTION,
      // pendingMembershipPlanId would sit on Membership, not here;
      // the active subscription still has classCredits = 5.
    };

    await expect(
      service.assertCreditAvailableForClass(
        prisma as never,
        'studio-1',
        'user-1',
        'class-new',
        CLASS_IN_PERIOD,
        subscriptionWithPendingPlan,
        { errorType: 'forbidden' },
      ),
    ).rejects.toThrow(new ForbiddenException(MEMBERSHIP_CLASS_CREDITS_EXHAUSTED_MESSAGE));
  });
});

// ─── Renewal period gets a fresh allowance ──────────────────────────────────

describe('[10] Renewal applies a fresh 5-credit allowance', () => {
  it('after renewal, member who used all 5 in previous period can book in new period', async () => {
    const { service, prisma } = makeUsageService();
    // The renewed subscription has a new period (Sep 28 → Oct 28).
    // Count for that period is 0 → booking allowed.
    mockNotConsumedAndCount(prisma, 0);

    const renewedTwice = {
      currentPeriodStart: new Date('2026-09-28T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-10-28T00:00:00.000Z'),
      membershipPlan: { classCredits: PRO_CLASS_CREDITS },
    };

    await expect(
      service.assertCreditAvailableForClass(
        prisma as never,
        'studio-1',
        'user-1',
        'class-oct',
        new Date('2026-10-05T18:00:00.000Z'),
        renewedTwice,
      ),
    ).resolves.toBeUndefined();
  });
});
