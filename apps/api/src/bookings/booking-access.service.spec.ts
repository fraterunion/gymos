import { ForbiddenException } from '@nestjs/common';
import { ClassCategory, Role } from '@prisma/client';
import { BookingAccessService, CLASS_TIME_WINDOW_DENIED_MESSAGE } from './booking-access.service';
import { MembershipUsageService } from '../membership-usage/membership-usage.service';
import { MEMBERSHIP_CLASS_ACCESS_DENIED_MESSAGE } from '../membership-plans/membership-plan-class-access.utils';
import { MEMBER_ERRORS } from '../member-facing/member-errors';

describe('BookingAccessService', () => {
  const membershipUsage = {
    assertCreditAvailableForClass: jest.fn(),
  } as unknown as MembershipUsageService;

  const service = new BookingAccessService(membershipUsage);

  const studioId = 'studio-1';
  const userId = 'user-1';
  const classStartsAt = new Date('2026-08-10T18:00:00.000Z');
  const classTemplateId = 'tpl-push';
  const scheduledClassId = 'class-1';

  function makeTx(overrides: {
    sub?: {
      allClassesAccess: boolean;
      allowedCategories: ClassCategory[];
      classCredits: number | null;
      allowedTemplateIds: string[];
      entitlementEndsAt?: Date | null;
    } | null;
    templateCategory?: ClassCategory | null;
    templateTimeWindow?: { start: string; end: string } | null;
    /** Whether the class template is in the DayPassClassAccess allowlist. Defaults to !!dayPass. */
    dayPassClassEligible?: boolean;
    /** Whether the member has an active Day Pass for the booking date. */
    dayPass?: boolean;
  }) {
    const isEligible =
      overrides.dayPassClassEligible !== undefined
        ? overrides.dayPassClassEligible
        : !!overrides.dayPass;

    return {
      subscription: {
        findFirst: jest.fn().mockResolvedValue(
          overrides.sub
            ? {
                currentPeriodStart: new Date('2026-08-01T00:00:00.000Z'),
                currentPeriodEnd: new Date('2026-09-01T00:00:00.000Z'),
                entitlementEndsAt: overrides.sub.entitlementEndsAt ?? null,
                membershipPlan: {
                  allClassesAccess: overrides.sub.allClassesAccess,
                  allowedCategories: overrides.sub.allowedCategories,
                  classCredits: overrides.sub.classCredits,
                  classTemplateAccess: overrides.sub.allowedTemplateIds.map((id) => ({
                    classTemplateId: id,
                  })),
                },
              }
            : null,
        ),
      },
      classTemplate: {
        findUnique: jest.fn().mockResolvedValue({
          category:
            overrides.templateCategory !== undefined
              ? overrides.templateCategory
              : ClassCategory.STRENGTH,
          isOpenGymSlot: false,
          accessWindowStart: overrides.templateTimeWindow?.start ?? null,
          accessWindowEnd: overrides.templateTimeWindow?.end ?? null,
        }),
      },
      dayPassClassAccess: {
        findFirst: jest.fn().mockResolvedValue(isEligible ? { id: 'dpa-1' } : null),
      },
      dayPass: {
        findFirst: jest.fn().mockResolvedValue(overrides.dayPass ? { id: 'pass-1' } : null),
      },
    };
  }

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('allows staff without checking membership', async () => {
    const tx = makeTx({ sub: null });
    await expect(
      service.assertAccess(
        tx as never,
        studioId,
        userId,
        Role.STAFF,
        classStartsAt,
        'America/Mexico_City',
        classTemplateId,
        scheduledClassId,
      ),
    ).resolves.toBeUndefined();
    expect(tx.subscription.findFirst).not.toHaveBeenCalled();
  });

  it('allows unlimited plan members for any class', async () => {
    const tx = makeTx({
      sub: {
        allClassesAccess: true,
        allowedCategories: [],
        classCredits: null,
        allowedTemplateIds: [],
      },
    });

    await expect(
      service.assertAccess(
        tx as never,
        studioId,
        userId,
        Role.MEMBER,
        classStartsAt,
        'America/Mexico_City',
        classTemplateId,
        scheduledClassId,
      ),
    ).resolves.toBeUndefined();
  });

  it('denies a stale ACTIVE subscription whose effective period has expired', async () => {
    const tx = makeTx({ sub: null });
    tx.subscription.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'expired-sub' });

    await expect(
      service.assertAccess(
        tx as never,
        studioId,
        userId,
        Role.MEMBER,
        classStartsAt,
        'America/Mexico_City',
        classTemplateId,
        scheduledClassId,
      ),
    ).rejects.toThrow(MEMBER_ERRORS.membershipExpired);
  });

  it('selects entitlement with a strict end-exclusive database predicate', async () => {
    const tx = makeTx({ sub: null });
    await expect(
      service.assertAccess(
        tx as never,
        studioId,
        userId,
        Role.MEMBER,
        classStartsAt,
        'America/Mexico_City',
        classTemplateId,
        scheduledClassId,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(tx.subscription.findFirst).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            expect.objectContaining({ OR: expect.any(Array) }),
          ]),
        }),
      }),
    );
  });

  it('allows member to book allowed template', async () => {
    const tx = makeTx({
      sub: {
        allClassesAccess: false,
        allowedCategories: [],
        classCredits: null,
        allowedTemplateIds: ['tpl-push', 'tpl-pull'],
      },
    });

    await expect(
      service.assertAccess(
        tx as never,
        studioId,
        userId,
        Role.MEMBER,
        classStartsAt,
        'America/Mexico_City',
        'tpl-push',
        scheduledClassId,
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects member booking disallowed template', async () => {
    const tx = makeTx({
      sub: {
        allClassesAccess: false,
        allowedCategories: [],
        classCredits: null,
        allowedTemplateIds: ['tpl-pull'],
      },
    });

    await expect(
      service.assertAccess(
        tx as never,
        studioId,
        userId,
        Role.MEMBER,
        classStartsAt,
        'America/Mexico_City',
        'tpl-push',
        scheduledClassId,
      ),
    ).rejects.toThrow(new ForbiddenException(MEMBERSHIP_CLASS_ACCESS_DENIED_MESSAGE));
  });

  it('allows waitlist-eligible member via same access path (restricted deny)', async () => {
    const tx = makeTx({
      sub: {
        allClassesAccess: false,
        allowedCategories: [],
        classCredits: 8,
        allowedTemplateIds: ['tpl-legs'],
      },
      templateCategory: ClassCategory.HIIT,
    });

    await expect(
      service.assertAccess(
        tx as never,
        studioId,
        userId,
        Role.MEMBER,
        classStartsAt,
        'America/Mexico_City',
        'tpl-hiit',
        scheduledClassId,
      ),
    ).rejects.toThrow(MEMBERSHIP_CLASS_ACCESS_DENIED_MESSAGE);
  });

  it('allows legacy category-restricted plan when category matches', async () => {
    const tx = makeTx({
      sub: {
        allClassesAccess: false,
        allowedCategories: [ClassCategory.HYROX],
        classCredits: null,
        allowedTemplateIds: [],
      },
      templateCategory: ClassCategory.HYROX,
    });

    await expect(
      service.assertAccess(
        tx as never,
        studioId,
        userId,
        Role.MEMBER,
        classStartsAt,
        'America/Mexico_City',
        'tpl-hyrox',
        scheduledClassId,
      ),
    ).resolves.toBeUndefined();
  });

  it('day pass overrides class access restriction', async () => {
    const tx = makeTx({
      sub: {
        allClassesAccess: false,
        allowedCategories: [],
        classCredits: null,
        allowedTemplateIds: ['tpl-other'],
      },
      dayPass: true,
    });

    await expect(
      service.assertAccess(
        tx as never,
        studioId,
        userId,
        Role.MEMBER,
        classStartsAt,
        'America/Mexico_City',
        classTemplateId,
        scheduledClassId,
      ),
    ).resolves.toBeUndefined();
  });

  it('no subscription + no day pass → ForbiddenException with generic message', async () => {
    const tx = makeTx({ sub: null, dayPass: false });
    await expect(
      service.assertAccess(tx as never, studioId, userId, Role.MEMBER, classStartsAt, 'America/Mexico_City', classTemplateId, scheduledClassId),
    ).rejects.toThrow(MEMBER_ERRORS.membershipOrDayPassRequired);
  });

  it('no subscription + valid day pass → allowed', async () => {
    const tx = makeTx({ sub: null, dayPass: true });
    await expect(
      service.assertAccess(tx as never, studioId, userId, Role.MEMBER, classStartsAt, 'America/Mexico_City', classTemplateId, scheduledClassId),
    ).resolves.toBeUndefined();
  });

  it('day pass overrides exhausted credits', async () => {
    const tx = makeTx({
      sub: {
        allClassesAccess: true,
        allowedCategories: [],
        classCredits: 5,
        allowedTemplateIds: [],
      },
      dayPass: true,
    });
    (membershipUsage.assertCreditAvailableForClass as jest.Mock).mockRejectedValue(
      new ForbiddenException(MEMBER_ERRORS.creditsExhausted),
    );
    await expect(
      service.assertAccess(tx as never, studioId, userId, Role.MEMBER, classStartsAt, 'America/Mexico_City', classTemplateId, scheduledClassId),
    ).resolves.toBeUndefined();
  });

  it('credits exhausted + no day pass → ForbiddenException with credit message', async () => {
    const tx = makeTx({
      sub: {
        allClassesAccess: true,
        allowedCategories: [],
        classCredits: 5,
        allowedTemplateIds: [],
      },
      dayPass: false,
    });
    (membershipUsage.assertCreditAvailableForClass as jest.Mock).mockRejectedValue(
      new ForbiddenException(MEMBER_ERRORS.creditsExhausted),
    );
    await expect(
      service.assertAccess(tx as never, studioId, userId, Role.MEMBER, classStartsAt, 'America/Mexico_City', classTemplateId, scheduledClassId),
    ).rejects.toThrow(MEMBER_ERRORS.creditsExhausted);
  });

  it('category-restricted plan denies when template category is null', async () => {
    const tx = makeTx({
      sub: {
        allClassesAccess: false,
        allowedCategories: [ClassCategory.STRENGTH],
        classCredits: null,
        allowedTemplateIds: [],
      },
      templateCategory: null,
    });
    await expect(
      service.assertAccess(tx as never, studioId, userId, Role.MEMBER, classStartsAt, 'America/Mexico_City', classTemplateId, scheduledClassId),
    ).rejects.toThrow(MEMBERSHIP_CLASS_ACCESS_DENIED_MESSAGE);
  });

  it.each([Role.INSTRUCTOR, Role.ADMIN, Role.OWNER])(
    'bypasses access check for %s role without querying subscription',
    async (role) => {
      const tx = makeTx({ sub: null });
      await expect(
        service.assertAccess(tx as never, studioId, userId, role, classStartsAt, 'America/Mexico_City', classTemplateId, scheduledClassId),
      ).resolves.toBeUndefined();
      expect(tx.subscription.findFirst).not.toHaveBeenCalled();
    },
  );

  describe('time-window enforcement', () => {
    // Use Etc/GMT+6 (UTC-6, no DST) for stable timezone arithmetic.
    // 10:00 local = 16:00 UTC, 07:00 local = 13:00 UTC, 17:00 local = 23:00 UTC.
    const withinWindow = new Date('2026-08-10T16:00:00.000Z'); // 10:00 local
    const beforeWindow = new Date('2026-08-10T13:00:00.000Z'); // 07:00 local
    const atWindowEnd  = new Date('2026-08-10T23:00:00.000Z'); // 17:00 local (closed, end is exclusive)

    const openGymSub = {
      allClassesAccess: false,
      allowedCategories: [] as ClassCategory[],
      classCredits: null,
      allowedTemplateIds: ['tpl-open-gym'],
    };

    it('allows booking within time window', async () => {
      const tx = makeTx({ sub: openGymSub, templateTimeWindow: { start: '10:00', end: '17:00' } });
      await expect(
        service.assertAccess(tx as never, studioId, userId, Role.MEMBER, withinWindow, 'Etc/GMT+6', 'tpl-open-gym', scheduledClassId),
      ).resolves.toBeUndefined();
    });

    it('denies booking before time window opens', async () => {
      const tx = makeTx({ sub: openGymSub, templateTimeWindow: { start: '10:00', end: '17:00' } });
      await expect(
        service.assertAccess(tx as never, studioId, userId, Role.MEMBER, beforeWindow, 'Etc/GMT+6', 'tpl-open-gym', scheduledClassId),
      ).rejects.toThrow(CLASS_TIME_WINDOW_DENIED_MESSAGE);
    });

    it('denies booking at the exact window end time (end is exclusive)', async () => {
      const tx = makeTx({ sub: openGymSub, templateTimeWindow: { start: '10:00', end: '17:00' } });
      await expect(
        service.assertAccess(tx as never, studioId, userId, Role.MEMBER, atWindowEnd, 'Etc/GMT+6', 'tpl-open-gym', scheduledClassId),
      ).rejects.toThrow(CLASS_TIME_WINDOW_DENIED_MESSAGE);
    });

    it('does not enforce time window when template has none', async () => {
      const tx = makeTx({
        sub: { allClassesAccess: true, allowedCategories: [], classCredits: null, allowedTemplateIds: [] },
      });
      // classStartsAt is at 18:00 UTC — any time, no window set → no enforcement
      await expect(
        service.assertAccess(tx as never, studioId, userId, Role.MEMBER, classStartsAt, 'Etc/GMT+6', classTemplateId, scheduledClassId),
      ).resolves.toBeUndefined();
    });

    // ── Boundary conditions (09:59 / 10:00 / 16:59 / 17:00 / 17:01 local) ──────
    // All in Etc/GMT+6 (UTC-6, no DST). Window: 10:00–17:00, 17:00 exclusive.
    it('denies at 09:59 local (boundary: one minute before window opens)', async () => {
      const at0959 = new Date('2026-08-10T15:59:00.000Z'); // 09:59 Etc/GMT+6
      const tx = makeTx({ sub: openGymSub, templateTimeWindow: { start: '10:00', end: '17:00' } });
      await expect(
        service.assertAccess(tx as never, studioId, userId, Role.MEMBER, at0959, 'Etc/GMT+6', 'tpl-open-gym', scheduledClassId),
      ).rejects.toThrow(CLASS_TIME_WINDOW_DENIED_MESSAGE);
    });

    it('allows at 10:00 local (window open, inclusive)', async () => {
      const at1000 = new Date('2026-08-10T16:00:00.000Z'); // 10:00 Etc/GMT+6
      const tx = makeTx({ sub: openGymSub, templateTimeWindow: { start: '10:00', end: '17:00' } });
      await expect(
        service.assertAccess(tx as never, studioId, userId, Role.MEMBER, at1000, 'Etc/GMT+6', 'tpl-open-gym', scheduledClassId),
      ).resolves.toBeUndefined();
    });

    it('allows at 16:59 local (one minute before window closes)', async () => {
      const at1659 = new Date('2026-08-10T22:59:00.000Z'); // 16:59 Etc/GMT+6
      const tx = makeTx({ sub: openGymSub, templateTimeWindow: { start: '10:00', end: '17:00' } });
      await expect(
        service.assertAccess(tx as never, studioId, userId, Role.MEMBER, at1659, 'Etc/GMT+6', 'tpl-open-gym', scheduledClassId),
      ).resolves.toBeUndefined();
    });

    it('denies at 17:00 local (window end is exclusive)', async () => {
      const at1700 = new Date('2026-08-10T23:00:00.000Z'); // 17:00 Etc/GMT+6
      const tx = makeTx({ sub: openGymSub, templateTimeWindow: { start: '10:00', end: '17:00' } });
      await expect(
        service.assertAccess(tx as never, studioId, userId, Role.MEMBER, at1700, 'Etc/GMT+6', 'tpl-open-gym', scheduledClassId),
      ).rejects.toThrow(CLASS_TIME_WINDOW_DENIED_MESSAGE);
    });

    it('denies at 17:01 local (past window end)', async () => {
      const at1701 = new Date('2026-08-10T23:01:00.000Z'); // 17:01 Etc/GMT+6
      const tx = makeTx({ sub: openGymSub, templateTimeWindow: { start: '10:00', end: '17:00' } });
      await expect(
        service.assertAccess(tx as never, studioId, userId, Role.MEMBER, at1701, 'Etc/GMT+6', 'tpl-open-gym', scheduledClassId),
      ).rejects.toThrow(CLASS_TIME_WINDOW_DENIED_MESSAGE);
    });
  });

  describe('Day Pass allowlist (DayPassClassAccess)', () => {
    it('Day Pass cannot book a class not in the allowlist (e.g. Booty Lab)', async () => {
      const tx = makeTx({ sub: null, dayPass: true, dayPassClassEligible: false });
      await expect(
        service.assertAccess(tx as never, studioId, userId, Role.MEMBER, classStartsAt, 'America/Mexico_City', 'tpl-booty-lab', scheduledClassId),
      ).rejects.toThrow(MEMBER_ERRORS.membershipOrDayPassRequired);
      expect(tx.dayPassClassAccess.findFirst).toHaveBeenCalledWith({
        where: { studioId, classTemplateId: 'tpl-booty-lab' },
        select: { id: true },
      });
      expect(tx.dayPass.findFirst).not.toHaveBeenCalled();
    });

    it('Day Pass can book a class in the allowlist', async () => {
      const tx = makeTx({ sub: null, dayPass: true, dayPassClassEligible: true });
      await expect(
        service.assertAccess(tx as never, studioId, userId, Role.MEMBER, classStartsAt, 'America/Mexico_City', classTemplateId, scheduledClassId),
      ).resolves.toBeUndefined();
    });

    it('Day Pass allowlist check runs even when subscription is restricted', async () => {
      const tx = makeTx({
        sub: { allClassesAccess: false, allowedCategories: [], classCredits: null, allowedTemplateIds: ['tpl-other'] },
        dayPass: true,
        dayPassClassEligible: true,
      });
      await expect(
        service.assertAccess(tx as never, studioId, userId, Role.MEMBER, classStartsAt, 'America/Mexico_City', classTemplateId, scheduledClassId),
      ).resolves.toBeUndefined();
      expect(tx.dayPassClassAccess.findFirst).toHaveBeenCalled();
    });
  });

  describe('fixed-duration entitlement (entitlementEndsAt)', () => {
    it('uses entitlementEndsAt as effective period end for credit checks', async () => {
      const entitlementEndsAt = new Date('2026-10-02T00:00:00.000Z');
      const tx = makeTx({
        sub: {
          allClassesAccess: true,
          allowedCategories: [],
          classCredits: 4,
          allowedTemplateIds: [],
          entitlementEndsAt,
        },
      });
      await service.assertAccess(
        tx as never, studioId, userId, Role.MEMBER, classStartsAt, 'America/Mexico_City', classTemplateId, scheduledClassId,
      );
      expect(membershipUsage.assertCreditAvailableForClass).toHaveBeenCalledWith(
        tx,
        studioId,
        userId,
        scheduledClassId,
        classStartsAt,
        expect.objectContaining({ currentPeriodEnd: entitlementEndsAt }),
        { errorType: 'forbidden' },
      );
    });

    it('falls back to currentPeriodEnd when entitlementEndsAt is null', async () => {
      const currentPeriodEnd = new Date('2026-09-01T00:00:00.000Z');
      const tx = makeTx({
        sub: {
          allClassesAccess: true,
          allowedCategories: [],
          classCredits: 4,
          allowedTemplateIds: [],
          entitlementEndsAt: null,
        },
      });
      await service.assertAccess(
        tx as never, studioId, userId, Role.MEMBER, classStartsAt, 'America/Mexico_City', classTemplateId, scheduledClassId,
      );
      expect(membershipUsage.assertCreditAvailableForClass).toHaveBeenCalledWith(
        tx,
        studioId,
        userId,
        scheduledClassId,
        classStartsAt,
        expect.objectContaining({ currentPeriodEnd }),
        { errorType: 'forbidden' },
      );
    });
  });
});
