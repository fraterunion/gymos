import { ConflictException } from '@nestjs/common';
import { SubscriptionStatus } from '@prisma/client';
import { SubscriptionReconciliationService } from './subscription-reconciliation.service';

// ──────────────────────────────────────────────────────────────────────────────
// Shared mocks
// ──────────────────────────────────────────────────────────────────────────────

function makeStripeSub(
  id: string,
  status: string,
  cancelAtPeriodEnd: boolean,
  priceId: string,
  unitAmount: number,
  periodEndUnix: number,
  studioId = 'studio-1',
  userId = 'user-1',
) {
  return {
    id,
    status,
    cancel_at_period_end: cancelAtPeriodEnd,
    metadata: { studioId, userId },
    items: {
      data: [
        {
          price: { id: priceId, unit_amount: unitAmount },
          current_period_start: periodEndUnix - 30 * 86400,
          current_period_end: periodEndUnix,
        },
      ],
    },
  };
}

function makeLocalSub(
  id: string,
  stripeSubscriptionId: string,
  planId: string,
  planName: string,
  priceCents: number,
  stripePriceId: string,
  periodEnd: Date,
  cancelAtPeriodEnd = false,
  status = SubscriptionStatus.ACTIVE,
) {
  return {
    id,
    studioId: 'studio-1',
    userId: 'user-1',
    stripeSubscriptionId,
    status,
    cancelAtPeriodEnd,
    currentPeriodStart: new Date(periodEnd.getTime() - 30 * 86400_000),
    currentPeriodEnd: periodEnd,
    membershipPlanId: planId,
    membershipPlan: { id: planId, name: planName, priceCents, stripePriceId },
  };
}

function buildService(overrides: {
  user?: { stripeCustomerId: string | null } | null;
  localSubs?: ReturnType<typeof makeLocalSub>[];
  stripeSubs?: ReturnType<typeof makeStripeSub>[];
  planByPrice?: Record<string, { id: string } | null>;
  deadLetters?: Array<{ stripeEventId: string; eventType: string; createdAt: Date }>;
}) {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(
        'user' in overrides ? overrides.user : { stripeCustomerId: 'cus_test' },
      ),
    },
    subscription: {
      findMany: jest.fn().mockResolvedValue(overrides.localSubs ?? []),
      update: jest.fn().mockResolvedValue({}),
    },
    membershipPlan: {
      findFirst: jest.fn().mockImplementation(async (args: { where: { stripePriceId?: string } }) => {
        const priceId = args.where.stripePriceId;
        if (!priceId) return null;
        return (overrides.planByPrice ?? {})[priceId] ?? null;
      }),
    },
    stripeWebhookEvent: {
      findMany: jest.fn().mockResolvedValue(overrides.deadLetters ?? []),
    },
  };

  const stripe = {
    listSubscriptionsForCustomer: jest.fn().mockResolvedValue(overrides.stripeSubs ?? []),
  };

  return {
    service: new SubscriptionReconciliationService(prisma as never, stripe as never),
    prisma,
    stripe,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────────

const SEP_6 = new Date('2026-09-06T12:00:00Z');
const SEP_6_UNIX = Math.floor(SEP_6.getTime() / 1000);

const LOCAL_BASIC = makeLocalSub(
  'local-basic',
  'sub_basic',
  'plan-basic',
  'Basic Access',
  130000,
  'price_basic',
  SEP_6,
);

const STRIPE_BASIC = makeStripeSub('sub_basic', 'active', false, 'price_basic', 130000, SEP_6_UNIX);
const STRIPE_FULL = makeStripeSub('sub_full', 'active', false, 'price_full', 150000, SEP_6_UNIX + 30 * 86400);

// ──────────────────────────────────────────────────────────────────────────────
// healthy state
// ──────────────────────────────────────────────────────────────────────────────

describe('SubscriptionReconciliationService — healthy state', () => {
  it('returns healthy when one local sub matches one renewable Stripe sub', async () => {
    const { service } = buildService({
      localSubs: [LOCAL_BASIC],
      stripeSubs: [STRIPE_BASIC],
    });

    const result = await service.reconcile({ studioId: 'studio-1', userId: 'user-1' });

    expect(result.status).toBe('healthy');
    expect(result.issues).toHaveLength(0);
    expect(result.safeRepairs).toHaveLength(0);
    expect(result.requiresManualResolution).toBe(false);
    expect(result.canonicalStripeSubscriptionId).toBe('sub_basic');
  });

  it('returns healthy immediately when user has no stripeCustomerId', async () => {
    const { service, stripe } = buildService({ user: { stripeCustomerId: null } });

    const result = await service.reconcile({ studioId: 'studio-1', userId: 'user-1' });

    expect(result.status).toBe('healthy');
    expect(stripe.listSubscriptionsForCustomer).not.toHaveBeenCalled();
  });

  it('returns healthy immediately when user record does not exist', async () => {
    const { service, stripe } = buildService({ user: null });

    const result = await service.reconcile({ studioId: 'studio-1', userId: 'user-1' });

    expect(result.status).toBe('healthy');
    expect(stripe.listSubscriptionsForCustomer).not.toHaveBeenCalled();
  });

  it('excludes Stripe subs from other studios', async () => {
    const otherStudioSub = makeStripeSub(
      'sub_other',
      'active',
      false,
      'price_other',
      100000,
      SEP_6_UNIX,
      'studio-OTHER',
      'user-1',
    );
    const { service } = buildService({
      localSubs: [LOCAL_BASIC],
      stripeSubs: [STRIPE_BASIC, otherStudioSub],
    });

    const result = await service.reconcile({ studioId: 'studio-1', userId: 'user-1' });

    expect(result.status).toBe('healthy');
    expect(result.issues).toHaveLength(0);
    expect(result.canonicalStripeSubscriptionId).toBe('sub_basic');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Emilia's exact failure scenario
// ──────────────────────────────────────────────────────────────────────────────

describe('SubscriptionReconciliationService — Emilia-class: duplicate renewable + stripe orphan', () => {
  it('detects duplicate_renewable and stripe_orphan when Stripe has two active subs but local only has one', async () => {
    const { service } = buildService({
      localSubs: [LOCAL_BASIC],
      stripeSubs: [STRIPE_BASIC, STRIPE_FULL],
      planByPrice: {
        price_full: { id: 'plan-full' },
      },
    });

    const result = await service.reconcile({ studioId: 'studio-1', userId: 'user-1' });

    expect(result.status).toBe('duplicate_renewable');
    expect(result.requiresManualResolution).toBe(true);
    expect(result.canonicalStripeSubscriptionId).toBeNull();

    const kinds = result.issues.map((i) => i.kind);
    expect(kinds).toContain('duplicate_renewable');
    expect(kinds).toContain('stripe_orphan');

    const orphan = result.issues.find((i) => i.kind === 'stripe_orphan');
    expect(orphan).toMatchObject({
      kind: 'stripe_orphan',
      stripeSubscriptionId: 'sub_full',
      stripeStatus: 'active',
      stripePlanId: 'plan-full',
    });

    const dup = result.issues.find((i) => i.kind === 'duplicate_renewable');
    expect(dup).toMatchObject({
      kind: 'duplicate_renewable',
      stripeSubscriptionIds: expect.arrayContaining(['sub_basic', 'sub_full']),
    });

    expect(result.safeRepairs).toHaveLength(0);
  });

  it('assertHealthyForPlanChange throws ConflictException with code BILLING_STATE_REQUIRES_RECONCILIATION', async () => {
    const { service } = buildService({
      localSubs: [LOCAL_BASIC],
      stripeSubs: [STRIPE_BASIC, STRIPE_FULL],
      planByPrice: { price_full: { id: 'plan-full' } },
    });

    await expect(
      service.assertHealthyForPlanChange('studio-1', 'user-1'),
    ).rejects.toBeInstanceOf(ConflictException);

    try {
      await service.assertHealthyForPlanChange('studio-1', 'user-1');
    } catch (err) {
      expect((err as ConflictException).getResponse()).toMatchObject({
        code: 'BILLING_STATE_REQUIRES_RECONCILIATION',
        reconciliationStatus: 'duplicate_renewable',
      });
    }
  });

  it('does not apply safe repairs when requiresManualResolution is true', async () => {
    const { service, prisma } = buildService({
      localSubs: [LOCAL_BASIC],
      stripeSubs: [STRIPE_BASIC, STRIPE_FULL],
      planByPrice: { price_full: { id: 'plan-full' } },
    });

    await service.reconcile({ studioId: 'studio-1', userId: 'user-1', applyRepairs: true });

    expect(prisma.subscription.update).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Stripe orphan (single — no duplicate)
// ──────────────────────────────────────────────────────────────────────────────

describe('SubscriptionReconciliationService — single stripe_orphan', () => {
  it('detects stripe_orphan when Stripe has one renewable sub but no local row', async () => {
    const { service } = buildService({
      localSubs: [],
      stripeSubs: [STRIPE_FULL],
      planByPrice: { price_full: { id: 'plan-full' } },
    });

    const result = await service.reconcile({ studioId: 'studio-1', userId: 'user-1' });

    expect(result.status).toBe('stripe_orphan');
    expect(result.requiresManualResolution).toBe(true);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      kind: 'stripe_orphan',
      stripeSubscriptionId: 'sub_full',
      stripePlanId: 'plan-full',
    });
    expect(result.canonicalStripeSubscriptionId).toBe('sub_full');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// local_orphan
// ──────────────────────────────────────────────────────────────────────────────

describe('SubscriptionReconciliationService — local_orphan', () => {
  it('detects local_orphan when local sub exists but Stripe sub is canceled', async () => {
    const canceledStripeSub = makeStripeSub(
      'sub_basic',
      'canceled',
      false,
      'price_basic',
      130000,
      SEP_6_UNIX,
    );

    const { service } = buildService({
      localSubs: [LOCAL_BASIC],
      stripeSubs: [canceledStripeSub],
    });

    const result = await service.reconcile({ studioId: 'studio-1', userId: 'user-1' });

    expect(result.status).toBe('local_orphan');
    expect(result.requiresManualResolution).toBe(true);
    expect(result.issues[0]).toMatchObject({
      kind: 'local_orphan',
      localSubscriptionId: 'local-basic',
    });
  });

  it('detects local_orphan when Stripe has no record of the subscription', async () => {
    const { service } = buildService({
      localSubs: [LOCAL_BASIC],
      stripeSubs: [],
    });

    const result = await service.reconcile({ studioId: 'studio-1', userId: 'user-1' });

    expect(result.status).toBe('local_orphan');
    expect(result.requiresManualResolution).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// local_drift — auto-repairable
// ──────────────────────────────────────────────────────────────────────────────

describe('SubscriptionReconciliationService — local_drift (safe repairs)', () => {
  it('detects status_drift and produces safe repair', async () => {
    const pastDueStripe = makeStripeSub(
      'sub_basic',
      'past_due',
      false,
      'price_basic',
      130000,
      SEP_6_UNIX,
    );
    const { service } = buildService({
      localSubs: [LOCAL_BASIC],
      stripeSubs: [pastDueStripe],
    });

    const result = await service.reconcile({ studioId: 'studio-1', userId: 'user-1' });

    expect(result.status).toBe('local_drift');
    expect(result.requiresManualResolution).toBe(false);
    const drift = result.issues.find((i) => i.kind === 'status_drift');
    expect(drift).toMatchObject({
      kind: 'status_drift',
      localStatus: SubscriptionStatus.ACTIVE,
      stripeStatus: 'past_due',
    });
    const repair = result.safeRepairs.find((r) => r.action === 'update_local_status');
    expect(repair).toMatchObject({
      action: 'update_local_status',
      toStatus: SubscriptionStatus.PAST_DUE,
    });
  });

  it('detects cancel_at_period_end_drift and produces safe repair', async () => {
    const cancelingStripe = makeStripeSub(
      'sub_basic',
      'active',
      true, // Stripe has cancel_at_period_end=true
      'price_basic',
      130000,
      SEP_6_UNIX,
    );
    const { service } = buildService({
      localSubs: [LOCAL_BASIC], // local has cancelAtPeriodEnd=false
      stripeSubs: [cancelingStripe],
    });

    const result = await service.reconcile({ studioId: 'studio-1', userId: 'user-1' });

    expect(result.status).toBe('local_drift');
    expect(result.issues).toContainEqual(
      expect.objectContaining({ kind: 'cancel_at_period_end_drift', local: false, stripe: true }),
    );
    expect(result.safeRepairs).toContainEqual(
      expect.objectContaining({ action: 'update_local_cancel_at_period_end', to: true }),
    );
  });

  it('applies safe repairs when applyRepairs=true and state is not manually-required', async () => {
    const pastDueStripe = makeStripeSub(
      'sub_basic',
      'past_due',
      false,
      'price_basic',
      130000,
      SEP_6_UNIX,
    );
    const { service, prisma } = buildService({
      localSubs: [LOCAL_BASIC],
      stripeSubs: [pastDueStripe],
    });

    await service.reconcile({ studioId: 'studio-1', userId: 'user-1', applyRepairs: true });

    expect(prisma.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'local-basic' },
        data: { status: SubscriptionStatus.PAST_DUE },
      }),
    );
  });

  it('detects period_drift when local period end differs from Stripe by more than 1 hour', async () => {
    // Stripe says period ends Sep 7, local says Sep 6 — ~24h drift
    const sep7Unix = SEP_6_UNIX + 86400;
    const driftedStripe = makeStripeSub(
      'sub_basic',
      'active',
      false,
      'price_basic',
      130000,
      sep7Unix,
    );
    const { service } = buildService({
      localSubs: [LOCAL_BASIC],
      stripeSubs: [driftedStripe],
    });

    const result = await service.reconcile({ studioId: 'studio-1', userId: 'user-1' });

    expect(result.issues).toContainEqual(
      expect.objectContaining({ kind: 'period_drift', field: 'currentPeriodEnd' }),
    );
    expect(result.safeRepairs).toContainEqual(
      expect.objectContaining({ action: 'update_local_period_dates' }),
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// price_drift
// ──────────────────────────────────────────────────────────────────────────────

describe('SubscriptionReconciliationService — price_drift (ARES Basic plan mismatch)', () => {
  it('detects price_drift when Stripe unit_amount differs from local priceCents', async () => {
    // ARES Basic: local priceCents=100000 (MXN 1000) but Stripe charges 130000 (MXN 1300)
    const localBasicWrong = makeLocalSub(
      'local-basic',
      'sub_basic',
      'plan-basic',
      'Basic Access',
      100000, // local priceCents = MXN 1000
      'price_basic',
      SEP_6,
    );
    const stripeBasicActual = makeStripeSub(
      'sub_basic',
      'active',
      false,
      'price_basic',
      130000, // Stripe unit_amount = MXN 1300
      SEP_6_UNIX,
    );

    const { service } = buildService({
      localSubs: [localBasicWrong],
      stripeSubs: [stripeBasicActual],
    });

    const result = await service.reconcile({ studioId: 'studio-1', userId: 'user-1' });

    expect(result.status).toBe('price_drift');
    expect(result.requiresManualResolution).toBe(false);
    const drift = result.issues.find((i) => i.kind === 'price_drift');
    expect(drift).toMatchObject({
      kind: 'price_drift',
      planName: 'Basic Access',
      localPriceCents: 100000,
      stripeUnitAmount: 130000,
    });
  });

  it('does not report price_drift when amounts match', async () => {
    const { service } = buildService({
      localSubs: [LOCAL_BASIC], // priceCents=130000
      stripeSubs: [STRIPE_BASIC], // unit_amount=130000
    });

    const result = await service.reconcile({ studioId: 'studio-1', userId: 'user-1' });

    expect(result.issues.filter((i) => i.kind === 'price_drift')).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// dead_letter_webhooks
// ──────────────────────────────────────────────────────────────────────────────

describe('SubscriptionReconciliationService — dead_letter_webhooks', () => {
  it('detects dead-letter webhooks older than 24 hours with processed=false', async () => {
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25 hours ago
    const { service } = buildService({
      localSubs: [LOCAL_BASIC],
      stripeSubs: [STRIPE_BASIC],
      deadLetters: [
        {
          stripeEventId: 'evt_failed_1',
          eventType: 'customer.subscription.created',
          createdAt: oldDate,
        },
      ],
    });

    const result = await service.reconcile({ studioId: 'studio-1', userId: 'user-1' });

    expect(result.status).toBe('dead_letter_webhooks');
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        kind: 'dead_letter_webhook',
        stripeEventId: 'evt_failed_1',
        eventType: 'customer.subscription.created',
      }),
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// applySafeRepairs (standalone)
// ──────────────────────────────────────────────────────────────────────────────

describe('SubscriptionReconciliationService — applySafeRepairs', () => {
  it('applies status repair', async () => {
    const { service, prisma } = buildService({});

    const { applied } = await service.applySafeRepairs([
      { action: 'update_local_status', localSubscriptionId: 'sub-1', toStatus: SubscriptionStatus.PAST_DUE },
    ]);

    expect(applied).toBe(1);
    expect(prisma.subscription.update).toHaveBeenCalledWith({
      where: { id: 'sub-1' },
      data: { status: SubscriptionStatus.PAST_DUE },
    });
  });

  it('applies cancelAtPeriodEnd repair', async () => {
    const { service, prisma } = buildService({});

    await service.applySafeRepairs([
      { action: 'update_local_cancel_at_period_end', localSubscriptionId: 'sub-1', to: true },
    ]);

    expect(prisma.subscription.update).toHaveBeenCalledWith({
      where: { id: 'sub-1' },
      data: { cancelAtPeriodEnd: true },
    });
  });

  it('applies period date repair', async () => {
    const start = new Date('2026-08-06T00:00:00Z');
    const end = new Date('2026-09-06T00:00:00Z');
    const { service, prisma } = buildService({});

    await service.applySafeRepairs([
      {
        action: 'update_local_period_dates',
        localSubscriptionId: 'sub-1',
        currentPeriodStart: start,
        currentPeriodEnd: end,
      },
    ]);

    expect(prisma.subscription.update).toHaveBeenCalledWith({
      where: { id: 'sub-1' },
      data: { currentPeriodStart: start, currentPeriodEnd: end },
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// assertHealthyForPlanChange — healthy passes through
// ──────────────────────────────────────────────────────────────────────────────

describe('SubscriptionReconciliationService — assertHealthyForPlanChange', () => {
  it('does not throw when state is healthy', async () => {
    const { service } = buildService({
      localSubs: [LOCAL_BASIC],
      stripeSubs: [STRIPE_BASIC],
    });

    await expect(
      service.assertHealthyForPlanChange('studio-1', 'user-1'),
    ).resolves.toBeUndefined();
  });

  it('does not throw when state is local_drift (auto-repairable)', async () => {
    const pastDueStripe = makeStripeSub(
      'sub_basic',
      'past_due',
      false,
      'price_basic',
      130000,
      SEP_6_UNIX,
    );
    const { service } = buildService({
      localSubs: [LOCAL_BASIC],
      stripeSubs: [pastDueStripe],
    });

    await expect(
      service.assertHealthyForPlanChange('studio-1', 'user-1'),
    ).resolves.toBeUndefined();
  });

  it('throws ConflictException when state is stripe_orphan', async () => {
    const { service } = buildService({
      localSubs: [],
      stripeSubs: [STRIPE_FULL],
      planByPrice: { price_full: { id: 'plan-full' } },
    });

    await expect(
      service.assertHealthyForPlanChange('studio-1', 'user-1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
