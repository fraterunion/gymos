import { ForbiddenException } from '@nestjs/common';
import { ClassCategory, Role } from '@prisma/client';
import { BookingAccessService } from './booking-access.service';
import { MembershipUsageService } from '../membership-usage/membership-usage.service';
import { MEMBERSHIP_CLASS_ACCESS_DENIED_MESSAGE } from '../membership-plans/membership-plan-class-access.utils';

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
    } | null;
    templateCategory?: ClassCategory | null;
    dayPass?: boolean;
  }) {
    return {
      subscription: {
        findFirst: jest.fn().mockResolvedValue(
          overrides.sub
            ? {
                currentPeriodStart: new Date('2026-08-01T00:00:00.000Z'),
                currentPeriodEnd: new Date('2026-09-01T00:00:00.000Z'),
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
          category: overrides.templateCategory !== undefined ? overrides.templateCategory : ClassCategory.STRENGTH,
        }),
      },
      dayPass: {
        findFirst: jest.fn().mockResolvedValue(overrides.dayPass ? { id: 'pass-1' } : null),
      },
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
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
    ).rejects.toThrow('Active membership or Day Pass required to book this class.');
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
      new ForbiddenException('Membership class credits exhausted.'),
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
      new ForbiddenException('Membership class credits exhausted.'),
    );
    await expect(
      service.assertAccess(tx as never, studioId, userId, Role.MEMBER, classStartsAt, 'America/Mexico_City', classTemplateId, scheduledClassId),
    ).rejects.toThrow('Membership class credits exhausted.');
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
});
