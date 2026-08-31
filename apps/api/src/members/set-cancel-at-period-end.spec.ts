import { BadRequestException } from '@nestjs/common';
import { MembersService } from './members.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { StripeService } from '../stripe/stripe.service';
import type { StripeRenewalAuditService } from '../billing/stripe-renewal-audit.service';

describe('MembersService.setCancelAtPeriodEnd', () => {
  const sub = {
    id: 'sub_local',
    studioId: 'studio_1',
    userId: 'member_1',
    stripeSubscriptionId: 'sub_stripe',
    cancelAtPeriodEnd: false,
    currentPeriodEnd: new Date('2026-09-13T17:19:11.000Z'),
  };

  function makeService(opts: {
    updateSubscription?: jest.Mock;
    logGymos?: jest.Mock;
  } = {}) {
    const updateSubscription =
      opts.updateSubscription ?? jest.fn().mockResolvedValue({ id: 'sub_stripe' });
    const logGymos = opts.logGymos ?? jest.fn().mockResolvedValue(undefined);
    const prisma = {
      subscription: {
        findFirst: jest.fn().mockResolvedValue(sub),
        findFirstOrThrow: jest.fn(),
        update: jest.fn().mockResolvedValue({
          ...sub,
          cancelAtPeriodEnd: true,
          membershipPlan: { id: 'plan_1', name: 'Full Access' },
        }),
      },
      studioMembership: {
        findFirst: jest.fn().mockResolvedValue({ role: 'OWNER' }),
      },
    } as unknown as PrismaService;

    const service = new MembersService(
      prisma,
      {} as never,
      { updateSubscription } as unknown as StripeService,
      {} as never,
      {} as never,
      {} as never,
      { logGymosRenewalChange: logGymos } as unknown as StripeRenewalAuditService,
    );

    return { service, prisma, updateSubscription, logGymos };
  }

  it('OWNER disable: Stripe succeeds → GymOS audit with actor; no audit when Stripe fails', async () => {
    const { service, updateSubscription, logGymos, prisma } = makeService();

    await service.setCancelAtPeriodEnd(
      'studio_1',
      'member_1',
      'sub_local',
      true,
      'owner_1',
      'ADMIN_MEMBERSHIPS',
    );

    expect(updateSubscription).toHaveBeenCalledWith(
      'sub_stripe',
      { cancel_at_period_end: true },
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(/^gymos_renewal_/),
      }),
    );
    expect(prisma.subscription.update).toHaveBeenCalled();
    expect(logGymos).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'owner_1',
        actorRole: 'OWNER',
        previousCancelAtPeriodEnd: false,
        newCancelAtPeriodEnd: true,
        sourceSurface: 'ADMIN_MEMBERSHIPS',
        stripeSubscriptionId: 'sub_stripe',
      }),
    );

    const failing = makeService({
      updateSubscription: jest.fn().mockRejectedValue(new Error('stripe down')),
      logGymos: jest.fn(),
    });
    await expect(
      failing.service.setCancelAtPeriodEnd(
        'studio_1',
        'member_1',
        'sub_local',
        true,
        'owner_1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(failing.logGymos).not.toHaveBeenCalled();
    expect(failing.prisma.subscription.update).not.toHaveBeenCalled();
  });

  it('ADMIN reactivate records audit actor', async () => {
    const { service, logGymos, prisma, updateSubscription } = makeService();
    (prisma.subscription.findFirst as jest.Mock).mockResolvedValue({
      ...sub,
      cancelAtPeriodEnd: true,
    });
    (prisma.subscription.update as jest.Mock).mockResolvedValue({
      ...sub,
      cancelAtPeriodEnd: false,
      membershipPlan: { id: 'plan_1', name: 'Full Access' },
    });
    (prisma.studioMembership.findFirst as jest.Mock).mockResolvedValue({ role: 'ADMIN' });

    await service.setCancelAtPeriodEnd(
      'studio_1',
      'member_1',
      'sub_local',
      false,
      'admin_1',
      'ADMIN_MEMBERSHIPS',
    );

    expect(updateSubscription).toHaveBeenCalledWith(
      'sub_stripe',
      { cancel_at_period_end: false },
      expect.any(Object),
    );
    expect(logGymos).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'admin_1',
        actorRole: 'ADMIN',
        previousCancelAtPeriodEnd: true,
        newCancelAtPeriodEnd: false,
      }),
    );
  });
});
