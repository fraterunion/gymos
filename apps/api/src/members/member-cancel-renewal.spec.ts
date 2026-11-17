import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SubscriptionSource, SubscriptionStatus } from '@prisma/client';
import { MembersService } from './members.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { StripeService } from '../stripe/stripe.service';
import type { StripeRenewalAuditService } from '../billing/stripe-renewal-audit.service';

describe('MembersService.memberCancelRenewalAtPeriodEnd', () => {
  const periodEnd = new Date('2026-12-13T18:00:00.000Z');
  const stripeSub: {
    id: string;
    source: SubscriptionSource;
    status: SubscriptionStatus;
    stripeSubscriptionId: string | null;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: Date;
  } = {
    id: 'sub_local',
    source: SubscriptionSource.STRIPE,
    status: SubscriptionStatus.ACTIVE,
    stripeSubscriptionId: 'sub_stripe',
    cancelAtPeriodEnd: false,
    currentPeriodEnd: periodEnd,
  };

  function live(overrides: Record<string, unknown> = {}) {
    return {
      id: 'sub_stripe',
      object: 'subscription',
      status: 'active',
      customer: 'cus_member',
      cancel_at_period_end: false,
      items: { data: [{ current_period_end: Math.floor(periodEnd.getTime() / 1000) }] },
      ...overrides,
    };
  }

  function makeService(opts: {
    row?: typeof stripeSub | null;
    persisted?: { cancelAtPeriodEnd: boolean; status: SubscriptionStatus } | null;
    updateCount?: number;
    updateSubscription?: jest.Mock;
    retrieveSubscription?: jest.Mock;
    listOpenInvoices?: jest.Mock;
    transactionError?: Error;
    customerId?: string | null;
    existingAudit?: boolean;
  } = {}) {
    let applied = false;
    const updateSubscription =
      opts.updateSubscription ??
      jest.fn().mockImplementation(async () => {
        applied = true;
        return live({ cancel_at_period_end: true });
      });
    const retrieveSubscription =
      opts.retrieveSubscription ?? jest.fn().mockImplementation(async () => live({ cancel_at_period_end: applied }));
    const listOpenInvoicesForSubscription = opts.listOpenInvoices ?? jest.fn().mockResolvedValue([]);
    const logGymos = jest.fn().mockResolvedValue(undefined);
    const row = opts.row === undefined ? stripeSub : opts.row;
    const persisted = opts.persisted ?? {
      cancelAtPeriodEnd: true,
      status: row?.status ?? SubscriptionStatus.ACTIVE,
    };
    const findFirst = jest.fn().mockImplementation(async () => {
      const calls = findFirst.mock.calls.length;
      if (calls === 1) return row;
      return persisted
        ? {
            id: 'sub_local',
            cancelAtPeriodEnd: persisted.cancelAtPeriodEnd,
            currentPeriodEnd: periodEnd,
            status: persisted.status,
          }
        : null;
    });
    const subscription = {
      findFirst,
      updateMany: jest.fn().mockResolvedValue({ count: opts.updateCount ?? 1 }),
    };
    const studioMembership = { findFirst: jest.fn().mockResolvedValue({ role: 'MEMBER' }) };
    const auditLog = {
      findFirst: jest.fn().mockResolvedValue(opts.existingAudit ? { id: 'audit_existing' } : null),
    };
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      subscription,
      studioMembership,
      auditLog,
    };
    const prisma = {
      subscription,
      studioMembership,
      auditLog,
      user: {
        findFirst: jest.fn().mockResolvedValue(
          opts.customerId === null ? { stripeCustomerId: null } : { stripeCustomerId: opts.customerId ?? 'cus_member' },
        ),
      },
      $transaction: opts.transactionError
        ? jest.fn().mockRejectedValue(opts.transactionError)
        : jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaService;

    const service = new MembersService(
      prisma,
      {} as never,
      {
        updateSubscription,
        retrieveSubscription,
        listOpenInvoicesForSubscription,
      } as unknown as StripeService,
      {} as never,
      {} as never,
      {} as never,
      { logGymosRenewalChange: logGymos } as unknown as StripeRenewalAuditService,
      {} as never,
      {} as never,
    );

    return { service, prisma, updateSubscription, retrieveSubscription, listOpenInvoicesForSubscription, logGymos };
  }

  it('schedules an ACTIVE subscription only after Stripe confirms, and audits the member', async () => {
    const { service, prisma, updateSubscription, logGymos } = makeService();

    const result = await service.memberCancelRenewalAtPeriodEnd('studio_1', 'member_1', 'sub_local');

    expect(updateSubscription).toHaveBeenCalledWith(
      'sub_stripe',
      { cancel_at_period_end: true },
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/^gymos_renewal_/) }),
    );
    expect(prisma.subscription.updateMany).toHaveBeenCalledWith({
      where: { id: 'sub_local', studioId: 'studio_1', userId: 'member_1', cancelAtPeriodEnd: false },
      data: { cancelAtPeriodEnd: true },
    });
    expect(logGymos).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'member_1',
        memberUserId: 'member_1',
        actorRole: 'MEMBER',
        previousCancelAtPeriodEnd: false,
        newCancelAtPeriodEnd: true,
        sourceSurface: 'MEMBER_APP',
        stripeSubscriptionId: 'sub_stripe',
        liveStripeStatus: 'active',
      }),
    );
    expect(result).toMatchObject({
      outcome: 'scheduled',
      verifiedAgainstStripe: true,
      cancelAtPeriodEnd: true,
      status: 'ACTIVE',
    });
  });

  it('schedules TRIALING and PAST_DUE, including Stripe unpaid, without changing local status', async () => {
    for (const [local, stripeStatus] of [
      [SubscriptionStatus.TRIALING, 'trialing'],
      [SubscriptionStatus.PAST_DUE, 'past_due'],
      [SubscriptionStatus.PAST_DUE, 'unpaid'],
    ] as const) {
      let applied = false;
      const updateSubscription = jest.fn().mockImplementation(async () => {
        applied = true;
        return live({ status: stripeStatus, cancel_at_period_end: true });
      });
      const { service } = makeService({
        row: { ...stripeSub, status: local },
        persisted: { cancelAtPeriodEnd: true, status: local },
        updateSubscription,
        retrieveSubscription: jest.fn().mockImplementation(async () => live({ status: stripeStatus, cancel_at_period_end: applied })),
      });
      const result = await service.memberCancelRenewalAtPeriodEnd('studio_1', 'member_1', 'sub_local');
      expect(updateSubscription).toHaveBeenCalledWith('sub_stripe', { cancel_at_period_end: true }, expect.any(Object));
      expect(result.status).toBe(local);
      expect(result.verifiedAgainstStripe).toBe(true);
    }
  });

  it('returns already_scheduled when Stripe already has the flag, without a second mutation or audit', async () => {
    const { service, updateSubscription, logGymos } = makeService({
      retrieveSubscription: jest.fn().mockResolvedValue(live({ cancel_at_period_end: true, status: 'past_due' })),
      persisted: { cancelAtPeriodEnd: true, status: SubscriptionStatus.PAST_DUE },
      updateCount: 0,
    });

    const result = await service.memberCancelRenewalAtPeriodEnd('studio_1', 'member_1', 'sub_local');

    expect(result).toMatchObject({ outcome: 'already_scheduled', verifiedAgainstStripe: true, cancelAtPeriodEnd: true });
    expect(updateSubscription).not.toHaveBeenCalled();
    expect(logGymos).not.toHaveBeenCalled();
  });

  it('reconciles a verified timeout by re-reading Stripe before saving', async () => {
    const retrieve = jest
      .fn()
      .mockResolvedValueOnce(live({ cancel_at_period_end: false }))
      .mockResolvedValueOnce(live({ cancel_at_period_end: true }));
    const timeout = Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' });
    const { service, prisma, logGymos } = makeService({
      retrieveSubscription: retrieve,
      updateSubscription: jest.fn().mockRejectedValue(timeout),
    });

    const result = await service.memberCancelRenewalAtPeriodEnd('studio_1', 'member_1', 'sub_local');

    expect(result.outcome).toBe('scheduled');
    expect(result.verifiedAgainstStripe).toBe(true);
    expect(prisma.subscription.updateMany).toHaveBeenCalled();
    expect(logGymos).toHaveBeenCalled();
  });

  it('does not save or claim success when Stripe stays unconfirmed', async () => {
    const { service, prisma, logGymos } = makeService({
      updateSubscription: jest.fn().mockRejectedValue(Object.assign(new Error('stripe timeout'), { code: 'ETIMEDOUT' })),
      retrieveSubscription: jest.fn().mockResolvedValue(live({ cancel_at_period_end: false })),
    });

    await expect(service.memberCancelRenewalAtPeriodEnd('studio_1', 'member_1', 'sub_local')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.subscription.updateMany).not.toHaveBeenCalled();
    expect(logGymos).not.toHaveBeenCalled();
  });

  it('returns 503 when Stripe succeeded and the local write failed, and still audits the verified Stripe result', async () => {
    const { service, logGymos } = makeService({ transactionError: new Error('db down') });

    await expect(service.memberCancelRenewalAtPeriodEnd('studio_1', 'member_1', 'sub_local')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(logGymos).toHaveBeenCalledWith(
      expect.objectContaining({ memberUserId: 'member_1', liveStripeStatus: 'active', sourceSurface: 'MEMBER_APP' }),
    );
  });

  it('skips a second audit when a concurrent request already recorded the flag', async () => {
    const { service, logGymos } = makeService({ updateCount: 0, existingAudit: true });
    const result = await service.memberCancelRenewalAtPeriodEnd('studio_1', 'member_1', 'sub_local');
    expect(logGymos).not.toHaveBeenCalled();
    expect(result.cancelAtPeriodEnd).toBe(true);
    expect(result.verifiedAgainstStripe).toBe(true);
  });

  it('audits the request that changed Stripe even if another request saved the flag first', async () => {
    const { service, logGymos } = makeService({ updateCount: 0 });
    const result = await service.memberCancelRenewalAtPeriodEnd('studio_1', 'member_1', 'sub_local');
    expect(result.verifiedAgainstStripe).toBe(true);
    expect(logGymos).toHaveBeenCalledTimes(1);
  });

  it('returns open invoices and does not require an empty balance on ACTIVE', async () => {
    const { service, updateSubscription } = makeService({
      listOpenInvoices: jest.fn().mockResolvedValue([
        {
          id: 'in_open',
          amount_remaining: 45000,
          amount_due: 45000,
          currency: 'mxn',
          parent: { subscription_details: { subscription: 'sub_stripe' } },
        },
      ]),
    });

    const result = await service.memberCancelRenewalAtPeriodEnd('studio_1', 'member_1', 'sub_local');

    expect(result.openInvoices).toEqual([{ id: 'in_open', amountDueCents: 45000, currency: 'mxn' }]);
    expect(updateSubscription).toHaveBeenCalledWith('sub_stripe', { cancel_at_period_end: true }, expect.any(Object));
  });

  it('refuses to schedule when open invoices cannot be read', async () => {
    const { service, updateSubscription } = makeService({
      listOpenInvoices: jest.fn().mockRejectedValue(new Error('invoice timeout')),
    });
    await expect(service.memberCancelRenewalAtPeriodEnd('studio_1', 'member_1', 'sub_local')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(updateSubscription).not.toHaveBeenCalled();
  });

  it('explains a Stripe status that cannot be scheduled and does not write', async () => {
    const { service, updateSubscription, prisma } = makeService({
      retrieveSubscription: jest.fn().mockResolvedValue(live({ status: 'paused' })),
    });
    await expect(service.memberCancelRenewalAtPeriodEnd('studio_1', 'member_1', 'sub_local')).rejects.toThrow(/pausa/);
    expect(updateSubscription).not.toHaveBeenCalled();
    expect(prisma.subscription.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a Stripe customer that is not this member', async () => {
    const { service, updateSubscription, listOpenInvoicesForSubscription } = makeService({
      retrieveSubscription: jest.fn().mockResolvedValue(live({ customer: 'cus_other' })),
    });
    await expect(service.memberCancelRenewalAtPeriodEnd('studio_1', 'member_1', 'sub_local')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(updateSubscription).not.toHaveBeenCalled();
    expect(listOpenInvoicesForSubscription).not.toHaveBeenCalled();
  });

  it('does not cancel cash or manual memberships', async () => {
    for (const source of [SubscriptionSource.CASH, SubscriptionSource.MANUAL]) {
      const { service, updateSubscription, retrieveSubscription } = makeService({
        row: { ...stripeSub, source, stripeSubscriptionId: null },
      });
      await expect(service.memberCancelRenewalAtPeriodEnd('studio_1', 'member_1', 'sub_local')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(updateSubscription).not.toHaveBeenCalled();
      expect(retrieveSubscription).not.toHaveBeenCalled();
    }
  });

  it('explains paused and canceled local rows instead of scheduling them', async () => {
    for (const status of [SubscriptionStatus.PAUSED, SubscriptionStatus.CANCELED]) {
      const { service, updateSubscription } = makeService({ row: { ...stripeSub, status } });
      await expect(service.memberCancelRenewalAtPeriodEnd('studio_1', 'member_1', 'sub_local')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(updateSubscription).not.toHaveBeenCalled();
    }
  });

  it('404s when the subscription is not this member in this studio', async () => {
    const { service, updateSubscription } = makeService({ row: null });
    await expect(service.memberCancelRenewalAtPeriodEnd('studio_1', 'member_1', 'other')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(updateSubscription).not.toHaveBeenCalled();
  });
});
