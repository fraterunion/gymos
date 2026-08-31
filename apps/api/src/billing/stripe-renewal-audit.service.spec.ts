import { StripeRenewalAuditService } from './stripe-renewal-audit.service';
import {
  STRIPE_RENEWAL_DISABLED,
  STRIPE_RENEWAL_EXTERNAL_CHANGE,
  STRIPE_RENEWAL_REACTIVATED,
} from './stripe-renewal-audit.constants';
import { PrismaService } from '../prisma/prisma.service';

function makePrisma(overrides: {
  findFirst?: jest.Mock;
  findMany?: jest.Mock;
  create?: jest.Mock;
} = {}) {
  const create = overrides.create ?? jest.fn().mockResolvedValue({ id: 'audit_1' });
  const findFirst = overrides.findFirst ?? jest.fn().mockResolvedValue(null);
  const findMany = overrides.findMany ?? jest.fn().mockResolvedValue([]);
  return {
    prisma: {
      auditLog: { create, findFirst, findMany },
    } as unknown as PrismaService,
    create,
    findFirst,
    findMany,
  };
}

describe('StripeRenewalAuditService', () => {
  it('logs GymOS disable with actor after successful intent', async () => {
    const { prisma, create } = makePrisma();
    const service = new StripeRenewalAuditService(prisma);

    await service.logGymosRenewalChange({
      studioId: 'studio_1',
      actorUserId: 'owner_1',
      actorRole: 'OWNER',
      memberUserId: 'member_1',
      subscriptionId: 'sub_local',
      stripeSubscriptionId: 'sub_stripe',
      previousCancelAtPeriodEnd: false,
      newCancelAtPeriodEnd: true,
      currentPeriodEnd: new Date('2026-09-13T17:19:11.000Z'),
      sourceSurface: 'ADMIN_MEMBERSHIPS',
      stripeIdempotencyKey: 'gymos_renewal_abc',
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        studioId: 'studio_1',
        actorUserId: 'owner_1',
        action: STRIPE_RENEWAL_DISABLED,
        targetUserId: 'member_1',
        entityId: 'sub_local',
        metadata: expect.objectContaining({
          origin: 'GYMOS',
          previousCancelAtPeriodEnd: false,
          newCancelAtPeriodEnd: true,
          actorRole: 'OWNER',
          stripeIdempotencyKey: 'gymos_renewal_abc',
          sourceSurface: 'ADMIN_MEMBERSHIPS',
        }),
      }),
    });
  });

  it('logs GymOS reactivate with actor', async () => {
    const { prisma, create } = makePrisma();
    const service = new StripeRenewalAuditService(prisma);

    await service.logGymosRenewalChange({
      studioId: 'studio_1',
      actorUserId: 'admin_1',
      actorRole: 'ADMIN',
      memberUserId: 'member_1',
      subscriptionId: 'sub_local',
      stripeSubscriptionId: 'sub_stripe',
      previousCancelAtPeriodEnd: true,
      newCancelAtPeriodEnd: false,
      currentPeriodEnd: null,
      sourceSurface: 'ADMIN_MEMBERSHIPS',
      stripeIdempotencyKey: 'gymos_renewal_def',
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: 'admin_1',
        action: STRIPE_RENEWAL_REACTIVATED,
        metadata: expect.objectContaining({
          previousCancelAtPeriodEnd: true,
          newCancelAtPeriodEnd: false,
        }),
      }),
    });
  });

  it('skips GymOS audit when cancel flag did not change', async () => {
    const { prisma, create } = makePrisma();
    const service = new StripeRenewalAuditService(prisma);
    await service.logGymosRenewalChange({
      studioId: 'studio_1',
      actorUserId: 'owner_1',
      actorRole: 'OWNER',
      memberUserId: 'member_1',
      subscriptionId: 'sub_local',
      stripeSubscriptionId: 'sub_stripe',
      previousCancelAtPeriodEnd: true,
      newCancelAtPeriodEnd: true,
      currentPeriodEnd: null,
      sourceSurface: 'ADMIN_MEMBERSHIPS',
      stripeIdempotencyKey: 'gymos_renewal_noop',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('writes external audit for Portal-style webhook (null request id)', async () => {
    const { prisma, create, findFirst, findMany } = makePrisma();
    const service = new StripeRenewalAuditService(prisma);

    const result = await service.maybeLogExternalRenewalChange({
      studioId: 'studio_1',
      memberUserId: 'member_1',
      subscriptionId: 'sub_local',
      stripeSubscriptionId: 'sub_stripe',
      previousCancelAtPeriodEnd: false,
      newCancelAtPeriodEnd: true,
      currentPeriodEnd: new Date('2026-09-13T17:19:11.000Z'),
      stripeEventId: 'evt_renata_style',
      stripeEventType: 'customer.subscription.updated',
      stripeRequestId: null,
      stripeIdempotencyKey: null,
      cancellationReason: 'cancellation_requested',
      cancellationFeedback: 'unused',
    });

    expect(result).toBe('written');
    expect(findFirst).toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: null,
        action: STRIPE_RENEWAL_EXTERNAL_CHANGE,
        metadata: expect.objectContaining({
          origin: 'STRIPE_EXTERNAL',
          actorUserId: null,
          stripeEventId: 'evt_renata_style',
          cancellationFeedback: 'unused',
          previousCancelAtPeriodEnd: false,
          newCancelAtPeriodEnd: true,
        }),
      }),
    });
  });

  it('writes external audit for true → false', async () => {
    const { prisma, create } = makePrisma();
    const service = new StripeRenewalAuditService(prisma);
    const result = await service.maybeLogExternalRenewalChange({
      studioId: 'studio_1',
      memberUserId: 'member_1',
      subscriptionId: 'sub_local',
      stripeSubscriptionId: 'sub_stripe',
      previousCancelAtPeriodEnd: true,
      newCancelAtPeriodEnd: false,
      currentPeriodEnd: null,
      stripeEventId: 'evt_reactivate_ext',
      stripeEventType: 'customer.subscription.updated',
      stripeRequestId: null,
      stripeIdempotencyKey: null,
      cancellationReason: null,
      cancellationFeedback: null,
    });
    expect(result).toBe('written');
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: STRIPE_RENEWAL_EXTERNAL_CHANGE,
        metadata: expect.objectContaining({
          previousCancelAtPeriodEnd: true,
          newCancelAtPeriodEnd: false,
        }),
      }),
    });
  });

  it('skips external when Stripe idempotency key is GymOS-prefixed', async () => {
    const { prisma, create } = makePrisma();
    const service = new StripeRenewalAuditService(prisma);
    const result = await service.maybeLogExternalRenewalChange({
      studioId: 'studio_1',
      memberUserId: 'member_1',
      subscriptionId: 'sub_local',
      stripeSubscriptionId: 'sub_stripe',
      previousCancelAtPeriodEnd: false,
      newCancelAtPeriodEnd: true,
      currentPeriodEnd: null,
      stripeEventId: 'evt_after_gymos',
      stripeEventType: 'customer.subscription.updated',
      stripeRequestId: 'req_123',
      stripeIdempotencyKey: 'gymos_renewal_abc',
      cancellationReason: null,
      cancellationFeedback: null,
    });
    expect(result).toBe('skipped_gymos');
    expect(create).not.toHaveBeenCalled();
  });

  it('skips external for deterministic Stripe→Cash idempotency prefix', async () => {
    const { prisma, create } = makePrisma();
    const service = new StripeRenewalAuditService(prisma);
    const result = await service.maybeLogExternalRenewalChange({
      studioId: 'studio_1',
      memberUserId: 'member_1',
      subscriptionId: 'sub_local',
      stripeSubscriptionId: 'sub_stripe',
      previousCancelAtPeriodEnd: false,
      newCancelAtPeriodEnd: true,
      currentPeriodEnd: null,
      stripeEventId: 'evt_s2c',
      stripeEventType: 'customer.subscription.updated',
      stripeRequestId: 'req_s2c',
      stripeIdempotencyKey: 'gymos_stripe_to_cash_sub_stripe_cancel_at_period_end',
      cancellationReason: null,
      cancellationFeedback: null,
    });
    expect(result).toBe('skipped_gymos');
    expect(create).not.toHaveBeenCalled();
  });

  it('does NOT suppress EXTERNAL via nearby GymOS audit with same CAPE flip (false attribution guard)', async () => {
    // T0 GymOS disable false→true (authoritative audit already exists).
    // T1 Portal reactivate true→false (external).
    // T2 Portal disable again false→true — must stay EXTERNAL / actor null,
    // even if a prior GymOS false→true audit is within 15 minutes.
    const { prisma, create, findMany } = makePrisma({
      findMany: jest.fn().mockResolvedValue([
        {
          action: STRIPE_RENEWAL_DISABLED,
          metadata: {
            stripeSubscriptionId: 'sub_stripe',
            newCancelAtPeriodEnd: true,
            previousCancelAtPeriodEnd: false,
            actorUserId: 'fernando',
            stripeIdempotencyKey: 'gymos_renewal_t0',
          },
        },
      ]),
    });
    const service = new StripeRenewalAuditService(prisma);

    const result = await service.maybeLogExternalRenewalChange({
      studioId: 'studio_1',
      memberUserId: 'member_1',
      subscriptionId: 'sub_local',
      stripeSubscriptionId: 'sub_stripe',
      previousCancelAtPeriodEnd: false,
      newCancelAtPeriodEnd: true,
      currentPeriodEnd: null,
      stripeEventId: 'evt_t2_portal_disable',
      stripeEventType: 'customer.subscription.updated',
      stripeRequestId: null,
      stripeIdempotencyKey: null,
      cancellationReason: 'cancellation_requested',
      cancellationFeedback: 'unused',
    });

    expect(result).toBe('written');
    expect(findMany).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: null,
        action: STRIPE_RENEWAL_EXTERNAL_CHANGE,
        metadata: expect.objectContaining({
          origin: 'STRIPE_EXTERNAL',
          actorUserId: null,
          stripeEventId: 'evt_t2_portal_disable',
        }),
      }),
    });
    const writtenMeta = (create.mock.calls[0][0] as { data: { metadata: Record<string, unknown> } })
      .data.metadata;
    expect(writtenMeta['actorUserId']).toBeNull();
    expect(JSON.stringify(writtenMeta)).not.toMatch(/fernando/i);
  });

  it('does not treat temporal Stripe→Cash audit alone as webhook correlation without GymOS idempotency key', async () => {
    const { prisma, create, findMany } = makePrisma({
      findMany: jest.fn().mockResolvedValue([
        {
          action: 'STRIPE_TO_CASH_PERIOD_END_SCHEDULED',
          metadata: { stripeSubscriptionId: 'sub_stripe' },
        },
      ]),
    });
    const service = new StripeRenewalAuditService(prisma);
    const result = await service.maybeLogExternalRenewalChange({
      studioId: 'studio_1',
      memberUserId: 'member_1',
      subscriptionId: 'sub_local',
      stripeSubscriptionId: 'sub_stripe',
      previousCancelAtPeriodEnd: false,
      newCancelAtPeriodEnd: true,
      currentPeriodEnd: null,
      stripeEventId: 'evt_s2c_no_key',
      stripeEventType: 'customer.subscription.updated',
      stripeRequestId: null,
      stripeIdempotencyKey: null,
      cancellationReason: null,
      cancellationFeedback: null,
    });
    // Prefer EXTERNAL unknown over guessing GymOS from nearby S2C audit.
    expect(result).toBe('written');
    expect(findMany).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: null,
        action: STRIPE_RENEWAL_EXTERNAL_CHANGE,
      }),
    });
  });

  it('skips duplicate external audit on webhook retry (same stripeEventId)', async () => {
    const { prisma, create, findFirst } = makePrisma({
      findFirst: jest.fn().mockResolvedValue({ id: 'existing' }),
    });
    const service = new StripeRenewalAuditService(prisma);
    const result = await service.maybeLogExternalRenewalChange({
      studioId: 'studio_1',
      memberUserId: 'member_1',
      subscriptionId: 'sub_local',
      stripeSubscriptionId: 'sub_stripe',
      previousCancelAtPeriodEnd: false,
      newCancelAtPeriodEnd: true,
      currentPeriodEnd: null,
      stripeEventId: 'evt_retry',
      stripeEventType: 'customer.subscription.updated',
      stripeRequestId: null,
      stripeIdempotencyKey: null,
      cancellationReason: null,
      cancellationFeedback: null,
    });
    expect(result).toBe('skipped_duplicate');
    expect(create).not.toHaveBeenCalled();
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        action: STRIPE_RENEWAL_EXTERNAL_CHANGE,
        entityId: 'sub_local',
        metadata: { path: ['stripeEventId'], equals: 'evt_retry' },
      },
      select: { id: true },
    });
  });

  it('skips when cancel_at_period_end did not transition', async () => {
    const { prisma, create } = makePrisma();
    const service = new StripeRenewalAuditService(prisma);
    const result = await service.maybeLogExternalRenewalChange({
      studioId: 'studio_1',
      memberUserId: 'member_1',
      subscriptionId: 'sub_local',
      stripeSubscriptionId: 'sub_stripe',
      previousCancelAtPeriodEnd: false,
      newCancelAtPeriodEnd: false,
      currentPeriodEnd: null,
      stripeEventId: 'evt_noop',
      stripeEventType: 'customer.subscription.updated',
      stripeRequestId: null,
      stripeIdempotencyKey: null,
      cancellationReason: null,
      cancellationFeedback: null,
    });
    expect(result).toBe('skipped_no_transition');
    expect(create).not.toHaveBeenCalled();
  });

  it('serializes EXTERNAL timeline without inventing an actor name', () => {
    const { prisma } = makePrisma();
    const service = new StripeRenewalAuditService(prisma);
    const described = service.describeTimelineEvent(
      STRIPE_RENEWAL_EXTERNAL_CHANGE,
      {
        previousCancelAtPeriodEnd: false,
        newCancelAtPeriodEnd: true,
        cancellationFeedback: 'unused',
        origin: 'STRIPE_EXTERNAL',
        actorUserId: null,
      },
      null,
    );
    expect(described.actor).toBeNull();
    expect(described.title).toBe('Renovación modificada desde Stripe');
    expect(described.description).toContain('Origen externo · actor no identificado');
    expect(described.description).not.toMatch(/Renata|Fernando|canceló/i);
  });
});
