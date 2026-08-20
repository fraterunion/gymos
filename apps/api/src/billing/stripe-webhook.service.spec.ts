import { Logger } from '@nestjs/common';
import { PaymentMethod, PaymentStatus, SubscriptionSource, SubscriptionStatus } from '@prisma/client';
import { StripeWebhookService } from './stripe-webhook.service';
import type { WebhookInvoicePayload } from './stripe-webhook-payloads';
import type { PrismaService } from '../prisma/prisma.service';
import type { StripeService } from '../stripe/stripe.service';
import type { EnrollmentService } from '../enrollment/enrollment.service';

// ── Payload builders ──────────────────────────────────────────────────────────

function basilInvoice(overrides: Partial<WebhookInvoicePayload> = {}): WebhookInvoicePayload {
  return {
    id: 'in_basil',
    status: 'paid',
    customer: 'cus_test',
    subscription: null,
    payment_intent: null,
    currency: 'mxn',
    amount_paid: 60000,
    amount_due: 60000,
    total: 60000,
    status_transitions: { paid_at: 1782764245 },
    lines: null,
    period_start: null,
    period_end: null,
    parent: {
      type: 'subscription_details',
      subscription_details: {
        subscription: 'sub_basil',
        metadata: {
          planId: 'plan_1',
          userId: 'user_1',
          studioId: 'studio_1',
        },
      },
    },
    ...overrides,
  };
}

function legacyInvoice(overrides: Partial<WebhookInvoicePayload> = {}): WebhookInvoicePayload {
  return {
    id: 'in_legacy',
    status: 'paid',
    customer: 'cus_test',
    subscription: 'sub_legacy',
    payment_intent: 'pi_legacy',
    currency: 'usd',
    amount_paid: 5000,
    amount_due: 5000,
    total: 5000,
    status_transitions: { paid_at: 1700000000 },
    lines: null,
    period_start: null,
    period_end: null,
    parent: null,
    ...overrides,
  };
}

// ── Mock factory ──────────────────────────────────────────────────────────────

type PaymentRow = {
  studioId: string;
  userId: string;
  subscriptionId: string | null;
  membershipPlanId: string | null;
  amountCents: number;
  currency: string;
  status: PaymentStatus;
  paymentMethod: PaymentMethod;
  stripeInvoiceId: string | null;
  stripePaymentIntentId: string | null;
  paidAt: Date | null;
};

type ServiceUnderTest = {
  onInvoicePaid: (invoice: WebhookInvoicePayload) => Promise<void>;
};

function makeMocks() {
  const payments = new Map<string, PaymentRow>();

  const user = { id: 'user_1', deletedAt: null };
  const dbSubscription = {
    id: 'db_sub_1',
    studioId: 'studio_1',
    membershipPlanId: 'plan_1',
    stripeSubscriptionId: 'sub_basil',
  };
  const plan = { id: 'plan_1', studioId: 'studio_1', deletedAt: null };
  const membership = { id: 'mem_1', userId: 'user_1', studioId: 'studio_1', deletedAt: null };

  const prisma = {
    stripeWebhookEvent: {
      create: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    user: {
      findFirst: jest.fn().mockResolvedValue(user),
    },
    subscription: {
      findUnique: jest.fn().mockImplementation(async (args: { where: { id?: string; stripeSubscriptionId?: string } }) =>
        args.where.id ? null : dbSubscription),
    },
    membershipPlan: {
      findFirst: jest.fn().mockResolvedValue(plan),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    studioMembership: {
      findFirst: jest.fn().mockResolvedValue(membership),
    },
    payment: {
      upsert: jest.fn().mockImplementation(
        async ({ where, create }: { where: { stripeInvoiceId?: string | null }; create: PaymentRow }) => {
          const key = where.stripeInvoiceId ?? '';
          if (!payments.has(key)) payments.set(key, create);
          return payments.get(key)!;
        },
      ),
    },
  } as unknown as PrismaService;

  const stripeSubscriptionWithNoMetadata = {
    id: 'sub_basil',
    metadata: null,
    items: null,
    status: 'active',
    cancel_at_period_end: false,
  };

  const stripe = {
    // Default: no studioId in metadata → Stripe path also fails gracefully
    retrieveSubscription: jest.fn().mockResolvedValue(stripeSubscriptionWithNoMetadata),
    constructWebhookEvent: jest.fn(),
  } as unknown as StripeService;

  const enrollment = {} as unknown as EnrollmentService;

  const subscriptionLifecycle = {
    auditDuplicateRenewableSubscriptions: jest.fn(),
    reconcileSubscriptionPlansFromStripe: jest.fn().mockResolvedValue({
      membershipPlanId: 'plan_1',
      pendingMembershipPlanId: null,
    }),
  };

  const service = new StripeWebhookService(prisma, stripe, enrollment, subscriptionLifecycle as never);

  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

  return {
    service: service as unknown as ServiceUnderTest,
    prisma: prisma as unknown as jest.Mocked<typeof prisma>,
    stripe: stripe as unknown as jest.Mocked<typeof stripe>,
    payments,
  };
}

// ── Part 2: context resolution via onInvoicePaid ──────────────────────────────

describe('StripeWebhookService — context resolution via onInvoicePaid', () => {
  it('resolves basil invoice via DB subscription lookup', async () => {
    const { service, payments } = makeMocks();
    await service.onInvoicePaid(basilInvoice());
    const row = payments.get('in_basil');
    expect(row).toBeDefined();
    expect(row!.studioId).toBe('studio_1');
    expect(row!.userId).toBe('user_1');
    expect(row!.subscriptionId).toBe('db_sub_1');
    expect(row!.membershipPlanId).toBe('plan_1');
  });

  it('resolves legacy invoice via DB subscription lookup', async () => {
    const { service, payments } = makeMocks();
    await service.onInvoicePaid(legacyInvoice());
    const row = payments.get('in_legacy');
    expect(row).toBeDefined();
    expect(row!.studioId).toBe('studio_1');
  });

  it('resolves via basil metadata fallback when subscription not in DB', async () => {
    const { service, prisma, payments } = makeMocks();
    (prisma as unknown as { subscription: { findUnique: jest.Mock } }).subscription.findUnique.mockResolvedValue(null);
    await service.onInvoicePaid(basilInvoice());
    const row = payments.get('in_basil');
    expect(row).toBeDefined();
    expect(row!.studioId).toBe('studio_1');
    expect(row!.userId).toBe('user_1');
    expect(row!.subscriptionId).toBeNull();
    expect(row!.membershipPlanId).toBe('plan_1');
  });

  it('rejects basil metadata when userId does not match customer user', async () => {
    const { service, prisma } = makeMocks();
    (prisma as unknown as { subscription: { findUnique: jest.Mock } }).subscription.findUnique.mockResolvedValue(null);
    const inv = basilInvoice({
      parent: {
        subscription_details: {
          subscription: 'sub_basil',
          metadata: { planId: 'plan_1', userId: 'user_ATTACKER', studioId: 'studio_1' },
        },
      },
    });
    const logSpy = jest.spyOn(Logger.prototype, 'error');
    await service.onInvoicePaid(inv);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('context_resolution_failed'));
  });

  it('rejects basil metadata when plan does not belong to studio', async () => {
    const { service, prisma } = makeMocks();
    (prisma as unknown as { subscription: { findUnique: jest.Mock } }).subscription.findUnique.mockResolvedValue(null);
    (prisma as unknown as { membershipPlan: { findFirst: jest.Mock } }).membershipPlan.findFirst.mockResolvedValue(null);
    const logSpy = jest.spyOn(Logger.prototype, 'error');
    await service.onInvoicePaid(basilInvoice());
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('context_resolution_failed'));
  });

  it('rejects basil metadata when user has no membership in the studio', async () => {
    const { service, prisma } = makeMocks();
    (prisma as unknown as { subscription: { findUnique: jest.Mock } }).subscription.findUnique.mockResolvedValue(null);
    (prisma as unknown as { studioMembership: { findFirst: jest.Mock } }).studioMembership.findFirst.mockResolvedValue(null);
    const logSpy = jest.spyOn(Logger.prototype, 'error');
    await service.onInvoicePaid(basilInvoice());
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('context_resolution_failed'));
  });

  it('returns null context when customer is not found in DB', async () => {
    const { service, prisma } = makeMocks();
    (prisma as unknown as { user: { findFirst: jest.Mock } }).user.findFirst.mockResolvedValue(null);
    const logSpy = jest.spyOn(Logger.prototype, 'error');
    await service.onInvoicePaid(basilInvoice());
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('context_resolution_failed'));
  });

  it('skips when invoice status is not paid', async () => {
    const { service, payments } = makeMocks();
    await service.onInvoicePaid(basilInvoice({ status: 'open' }));
    expect(payments.size).toBe(0);
  });
});

describe('StripeWebhookService — fixed entitlement cycle grants', () => {
  it('duplicate paid invoice creates exactly one 45-day cycle', async () => {
    const cycles = new Map<string, { endsAt: Date }>();
    const subscription = {
      id: 'db_booty', studioId: 'studio_1', userId: 'user_1', membershipPlanId: 'plan_booty',
      source: SubscriptionSource.STRIPE,
      membershipPlan: { entitlementDays: 45, classCredits: 4, stripePriceId: 'price_booty_45d' },
    };
    const prisma = {
      subscription: {
        findUnique: jest.fn().mockResolvedValue(subscription),
        update: jest.fn(),
      },
      membershipEntitlementCycle: {
        findUnique: jest.fn(async ({ where }: { where: { stripeInvoiceId: string } }) => cycles.get(where.stripeInvoiceId) ?? null),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(async ({ data }: { data: { stripeInvoiceId: string; endsAt: Date } }) => {
          cycles.set(data.stripeInvoiceId, { endsAt: data.endsAt });
          return data;
        }),
      },
      $executeRaw: jest.fn(),
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    };
    const service = new StripeWebhookService(prisma as never, {} as never, {} as never, {} as never);
    const grant = (service as unknown as {
      grantFixedDurationCycleForPaidInvoice: (ctx: unknown, invoice: WebhookInvoicePayload) => Promise<void>;
    }).grantFixedDurationCycleForPaidInvoice.bind(service);
    const periodStart = Math.floor(new Date('2026-10-02T18:00:00.000Z').getTime() / 1000);
    const invoice = basilInvoice({
      id: 'in_booty_renewal',
      lines: { data: [{ price: { id: 'price_booty_45d' }, period: { start: periodStart, end: periodStart + 45 * 86400 } }] },
    });
    const ctx = { userId: 'user_1', studioId: 'studio_1', dbSubscriptionId: 'db_booty', membershipPlanId: 'plan_booty' };

    await grant(ctx, invoice);
    await grant(ctx, invoice);

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
    expect(prisma.membershipEntitlementCycle.create).toHaveBeenCalledTimes(1);
    expect(prisma.subscription.update).toHaveBeenCalledTimes(1);
  });

  it('concurrent delivery of the same paid invoice creates one cycle', async () => {
    const cycles = new Map<string, { endsAt: Date }>();
    const subscription = {
      id: 'db_booty', studioId: 'studio_1', userId: 'user_1', membershipPlanId: 'plan_booty',
      source: SubscriptionSource.STRIPE,
      membershipPlan: { entitlementDays: 45, classCredits: 4, stripePriceId: 'price_booty_45d' },
    };
    let transactionTail = Promise.resolve<unknown>(undefined);
    const prisma = {
      subscription: { findUnique: jest.fn().mockResolvedValue(subscription), update: jest.fn() },
      membershipEntitlementCycle: {
        findUnique: jest.fn(async ({ where }: { where: { stripeInvoiceId: string } }) => cycles.get(where.stripeInvoiceId) ?? null),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(async ({ data }: { data: { stripeInvoiceId: string; endsAt: Date } }) => {
          cycles.set(data.stripeInvoiceId, { endsAt: data.endsAt });
          return data;
        }),
      },
      $executeRaw: jest.fn(),
      $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => {
        const run = transactionTail.then(() => fn(prisma));
        transactionTail = run.catch(() => undefined);
        return run;
      }),
    };
    const service = new StripeWebhookService(prisma as never, {} as never, {} as never, {} as never);
    const grant = (service as unknown as {
      grantFixedDurationCycleForPaidInvoice: (ctx: unknown, invoice: WebhookInvoicePayload) => Promise<void>;
    }).grantFixedDurationCycleForPaidInvoice.bind(service);
    const periodStart = Math.floor(new Date('2026-10-02T18:00:00.000Z').getTime() / 1000);
    const invoice = basilInvoice({
      id: 'in_booty_concurrent',
      lines: { data: [{ price: { id: 'price_booty_45d' }, period: { start: periodStart, end: periodStart + 45 * 86400 } }] },
    });
    const ctx = { userId: 'user_1', studioId: 'studio_1', dbSubscriptionId: 'db_booty', membershipPlanId: 'plan_booty' };

    await Promise.all([grant(ctx, invoice), grant(ctx, invoice)]);

    expect(prisma.membershipEntitlementCycle.create).toHaveBeenCalledTimes(1);
    expect(prisma.subscription.update).toHaveBeenCalledTimes(1);
  });
});

describe('StripeWebhookService — zero-value paid invoice classification', () => {
  const cycleStart = Math.floor(new Date('2026-10-02T16:54:40.000Z').getTime() / 1000);
  const fixedSubscription = {
    id: 'db_sub_1', studioId: 'studio_1', userId: 'user_1', membershipPlanId: 'plan_1',
    source: SubscriptionSource.STRIPE,
    membershipPlan: { entitlementDays: 45, classCredits: 4, stripePriceId: 'price_booty_45d' },
  };

  function configureFixedSubscription(prisma: unknown) {
    const findUnique = (prisma as { subscription: { findUnique: jest.Mock } }).subscription.findUnique;
    findUnique.mockImplementation(async (args: { where: { id?: string; stripeSubscriptionId?: string } }) =>
      args.where.id ? fixedSubscription : {
        id: 'db_sub_1', studioId: 'studio_1', membershipPlanId: 'plan_1', stripeSubscriptionId: 'sub_basil',
      });
  }

  it('acknowledges a trial bridge invoice without Payment, cycle, exception, or dead letter', async () => {
    const { service, prisma, stripe, payments } = makeMocks();
    configureFixedSubscription(prisma);
    const grantSpy = jest.spyOn(service as never, 'grantFixedDurationCycleForPaidInvoice');
    const trialInvoice = basilInvoice({
      id: 'in_trial_bridge', amount_paid: 0, amount_due: 0, total: 0,
      billing_reason: 'subscription_update',
      lines: { data: [{ price: { id: 'price_booty_45d' }, period: { start: cycleStart - 43 * 86400, end: cycleStart }, proration: false }] },
    });
    stripe.constructWebhookEvent.mockReturnValue({
      id: 'evt_trial_bridge', type: 'invoice.paid', data: { object: trialInvoice },
    });
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await (service as unknown as StripeWebhookService).handleIncomingWebhook(Buffer.from('{}'), 'sig');

    expect(payments.size).toBe(0);
    expect(grantSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('stripe_invoice_paid_non_entitlement'));
    expect(prisma.stripeWebhookEvent.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { stripeEventId: 'evt_trial_bridge', processed: false },
      data: expect.objectContaining({ processed: true }),
    }));
    expect(prisma.stripeWebhookEvent.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastError: expect.anything() }),
    }));
  });

  it.each([
    ['fully discounted', 'subscription_cycle'],
    ['customer-balance-covered', 'subscription_cycle'],
  ])('grants an exact fixed-duration cycle for a %s invoice but creates no zero-value Payment', async (_label, billingReason) => {
    const { service, prisma, payments } = makeMocks();
    configureFixedSubscription(prisma);
    const grantSpy = jest.spyOn(service as never, 'grantFixedDurationCycleForPaidInvoice').mockResolvedValue(undefined);
    const invoice = basilInvoice({
      id: `in_${_label}`, amount_paid: 0, amount_due: 0, total: 0, billing_reason: billingReason,
      lines: { data: [{ price: { id: 'price_booty_45d' }, period: { start: cycleStart, end: cycleStart + 45 * 86400 }, proration: false }] },
    });

    await service.onInvoicePaid(invoice);

    expect(payments.size).toBe(0);
    expect(grantSpy).toHaveBeenCalledTimes(1);
  });

  it('skips a zero-value unrelated non-fixed-duration invoice without breaking its subscription', async () => {
    const { service, payments } = makeMocks();
    const grantSpy = jest.spyOn(service as never, 'grantFixedDurationCycleForPaidInvoice');
    await service.onInvoicePaid(basilInvoice({
      id: 'in_free_non_fixed', amount_paid: 0, amount_due: 0, total: 0,
      lines: { data: [{ price: { id: 'price_full_monthly' }, period: { start: cycleStart, end: cycleStart + 31 * 86400 } }] },
    }));
    expect(payments.size).toBe(0);
    expect(grantSpy).not.toHaveBeenCalled();
  });

  it('requires the mapped Price and exact fixed-duration period for zero-paid entitlement', async () => {
    const { service, prisma } = makeMocks();
    configureFixedSubscription(prisma);
    const grantSpy = jest.spyOn(service as never, 'grantFixedDurationCycleForPaidInvoice');
    await service.onInvoicePaid(basilInvoice({
      id: 'in_wrong_period', amount_paid: 0, amount_due: 0,
      lines: { data: [{ price: { id: 'price_booty_45d' }, period: { start: cycleStart, end: cycleStart + 44 * 86400 } }] },
    }));
    await service.onInvoicePaid(basilInvoice({
      id: 'in_wrong_price', amount_paid: 0, amount_due: 0,
      lines: { data: [{ price: { id: 'price_other' }, period: { start: cycleStart, end: cycleStart + 45 * 86400 } }] },
    }));
    expect(grantSpy).not.toHaveBeenCalled();
  });

  it('re-simulates the Maky bridge then grants exactly one fresh Oct 2–Nov 16 cycle on the paid renewal', async () => {
    const { service, prisma, payments } = makeMocks();
    configureFixedSubscription(prisma);
    const createdCycles: Array<Record<string, unknown>> = [];
    const subscriptionUpdates: Array<Record<string, unknown>> = [];
    Object.assign(prisma, {
      membershipEntitlementCycle: {
        findUnique: jest.fn(async ({ where }: { where: { stripeInvoiceId: string } }) =>
          createdCycles.find((cycle) => cycle['stripeInvoiceId'] === where.stripeInvoiceId) ?? null),
        findFirst: jest.fn().mockResolvedValue({ endsAt: new Date(cycleStart * 1000) }),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          createdCycles.push(data);
          return data;
        }),
      },
      $executeRaw: jest.fn(),
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    });
    (prisma.subscription as unknown as { update: jest.Mock }).update = jest.fn(async ({ data }) => {
      subscriptionUpdates.push(data);
      return data;
    });

    const trialInvoice = basilInvoice({
      id: 'in_maky_trial', amount_paid: 0, amount_due: 0, total: 0,
      billing_reason: 'subscription_update',
      lines: { data: [{ price: { id: 'price_booty_45d' }, period: { start: cycleStart - 43 * 86400, end: cycleStart } }] },
    });
    await service.onInvoicePaid(trialInvoice);
    expect(payments.size).toBe(0);
    expect(createdCycles).toHaveLength(0);
    expect(subscriptionUpdates).toHaveLength(0);

    const renewalInvoice = basilInvoice({
      id: 'in_maky_oct_2', amount_paid: 80000, amount_due: 80000, total: 80000,
      billing_reason: 'subscription_cycle',
      lines: { data: [{ price: { id: 'price_booty_45d' }, period: { start: cycleStart, end: cycleStart + 45 * 86400 }, proration: false }] },
    });
    await service.onInvoicePaid(renewalInvoice);
    await service.onInvoicePaid(renewalInvoice);

    expect(payments.size).toBe(1);
    expect(payments.get('in_maky_oct_2')!.amountCents).toBe(80000);
    expect(createdCycles).toHaveLength(1);
    expect(createdCycles[0]).toMatchObject({
      stripeInvoiceId: 'in_maky_oct_2',
      startsAt: new Date('2026-10-02T16:54:40.000Z'),
      endsAt: new Date('2026-11-16T16:54:40.000Z'),
      creditLimit: 4,
    });
    expect(subscriptionUpdates).toHaveLength(1);
  });
});

// ── Part 3: payment write correctness ─────────────────────────────────────────

describe('StripeWebhookService — payment write', () => {
  it('sets amountCents from Stripe amount_paid, not plan price', async () => {
    const { service, payments } = makeMocks();
    await service.onInvoicePaid(basilInvoice({ amount_paid: 99999 }));
    expect(payments.get('in_basil')!.amountCents).toBe(99999);
  });

  it('sets paidAt from status_transitions.paid_at', async () => {
    const { service, payments } = makeMocks();
    await service.onInvoicePaid(basilInvoice());
    expect(payments.get('in_basil')!.paidAt).toEqual(new Date(1782764245 * 1000));
  });

  it('sets status = SUCCEEDED', async () => {
    const { service, payments } = makeMocks();
    await service.onInvoicePaid(basilInvoice());
    expect(payments.get('in_basil')!.status).toBe(PaymentStatus.SUCCEEDED);
  });

  it('sets paymentMethod = STRIPE', async () => {
    const { service, payments } = makeMocks();
    await service.onInvoicePaid(basilInvoice());
    expect(payments.get('in_basil')!.paymentMethod).toBe(PaymentMethod.STRIPE);
  });

  it('sets stripeInvoiceId on the payment row', async () => {
    const { service, payments } = makeMocks();
    await service.onInvoicePaid(basilInvoice());
    expect(payments.get('in_basil')!.stripeInvoiceId).toBe('in_basil');
  });

  it('sets stripePaymentIntentId from legacy payment_intent string', async () => {
    const { service, payments } = makeMocks();
    await service.onInvoicePaid(legacyInvoice());
    expect(payments.get('in_legacy')!.stripePaymentIntentId).toBe('pi_legacy');
  });

  it('sets stripePaymentIntentId to null when payment_intent absent (basil)', async () => {
    const { service, payments } = makeMocks();
    await service.onInvoicePaid(basilInvoice());
    expect(payments.get('in_basil')!.stripePaymentIntentId).toBeNull();
  });

  it('is idempotent on duplicate invoice.paid webhook', async () => {
    const { service, prisma } = makeMocks();
    const upsertMock = (prisma as unknown as { payment: { upsert: jest.Mock } }).payment.upsert;
    await service.onInvoicePaid(basilInvoice());
    await service.onInvoicePaid(basilInvoice());
    expect(upsertMock).toHaveBeenCalledTimes(2);
  });

  it('emits structured error and skips write when context is unresolvable', async () => {
    const { service, prisma, payments } = makeMocks();
    (prisma as unknown as { user: { findFirst: jest.Mock } }).user.findFirst.mockResolvedValue(null);
    (prisma as unknown as { subscription: { findUnique: jest.Mock } }).subscription.findUnique.mockResolvedValue(null);
    const logSpy = jest.spyOn(Logger.prototype, 'error');

    await service.onInvoicePaid(basilInvoice());

    expect(payments.size).toBe(0);
    const call = logSpy.mock.calls.find(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('invoice_paid_skipped'),
    );
    expect(call).toBeDefined();
    const parsed = JSON.parse(call![0] as string) as Record<string, unknown>;
    expect(parsed['event']).toBe('invoice_paid_skipped');
    expect(parsed['reason']).toBe('context_resolution_failed');
    expect(parsed['invoiceId']).toBe('in_basil');
    expect(parsed['customerId']).toBe('cus_test');
    expect(parsed['stripeSubscriptionIdBasil']).toBe('sub_basil');
  });
});

// ── Part 4: subscription webhook plan reconciliation ─────────────────────────

type SubscriptionWebhookService = {
  upsertSubscriptionFromStripe: (
    sub: {
      id: string;
      status: string;
      customer: string;
      metadata: Record<string, string> | null;
      cancel_at_period_end: boolean;
      items: {
        data: Array<{
          price: { id: string };
          current_period_start?: number;
          current_period_end?: number;
        }>;
      };
    },
    md: { userId?: string; studioId?: string; planId?: string },
    stripeEventType: string,
  ) => Promise<void>;
};

function makeSubscriptionWebhookMocks() {
  const upsertCalls: Array<Record<string, unknown>> = [];
  const createCalls: Array<Record<string, unknown>> = [];

  const txSubscription = {
    upsert: jest.fn().mockImplementation(async ({ update, create }: { update: Record<string, unknown>; create: Record<string, unknown> }) => {
      const row = { id: 'sub-local-1', ...create, ...update };
      upsertCalls.push(row);
      return row;
    }),
    // Default: incoming sub not yet in DB (conflict check enters the CREATE branch)
    findUnique: jest.fn().mockResolvedValue(null),
    // Default: no conflicting ACTIVE row (conflict check finds nothing to conflict with)
    findFirst: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue({ id: 'sub-local-cash-1', status: 'CANCELED' }),
    create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: 'sub-local-new', ...data };
      createCalls.push(row);
      return row;
    }),
  };

  const prisma = {
    user: { findFirst: jest.fn().mockResolvedValue({ id: 'user_1' }) },
    membershipPlan: {
      findFirst: jest.fn().mockImplementation(async (args: { where: { id?: string; stripePriceId?: string } }) => {
        if (args.where.stripePriceId === 'price_full') return { id: 'plan-full', studioId: 'studio_1' };
        if (args.where.stripePriceId === 'price_basic') return { id: 'plan-basic', studioId: 'studio_1' };
        if (args.where.id === 'plan-full') return { id: 'plan-full', studioId: 'studio_1', deletedAt: null };
        if (args.where.id === 'plan-basic') return { id: 'plan-basic', studioId: 'studio_1', deletedAt: null };
        return null;
      }),
    },
    $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        membershipPlan: prisma.membershipPlan,
        $executeRaw: jest.fn().mockResolvedValue(undefined),
        subscription: txSubscription,
      }),
    ),
  } as unknown as PrismaService;

  const subscriptionLifecycle = {
    reconcileSubscriptionPlansFromStripe: jest.fn(),
    auditDuplicateRenewableSubscriptions: jest.fn(),
  };

  const service = new StripeWebhookService(
    prisma,
    {} as StripeService,
    {} as EnrollmentService,
    subscriptionLifecycle as never,
  );

  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

  return {
    service: service as unknown as SubscriptionWebhookService,
    subscriptionLifecycle,
    upsertCalls,
    createCalls,
    txSubscription,
  };
}

describe('StripeWebhookService — subscription plan lifecycle', () => {
  const baseSub = {
    id: 'sub_stripe_1',
    status: 'active',
    customer: 'cus_test',
    cancel_at_period_end: false,
    items: {
      data: [
        {
          price: { id: 'price_full' },
          current_period_start: 1_722_489_600,
          current_period_end: 1_725_168_000,
        },
      ],
    },
  };

  it('keeps Full effective with pending Basic before scheduled downgrade activates', async () => {
    const { service, subscriptionLifecycle, upsertCalls } = makeSubscriptionWebhookMocks();
    subscriptionLifecycle.reconcileSubscriptionPlansFromStripe.mockResolvedValue({
      membershipPlanId: 'plan-full',
      pendingMembershipPlanId: 'plan-basic',
    });

    await service.upsertSubscriptionFromStripe(
      { ...baseSub, metadata: { pendingPlanId: 'plan-basic', userId: 'user_1', studioId: 'studio_1' } },
      { userId: 'user_1', studioId: 'studio_1' },
      'customer.subscription.updated',
    );

    expect(upsertCalls[0]).toMatchObject({
      membershipPlanId: 'plan-full',
      pendingMembershipPlanId: 'plan-basic',
    });
    expect(subscriptionLifecycle.auditDuplicateRenewableSubscriptions).toHaveBeenCalled();
  });

  it('activates Basic effective plan when Stripe price transitions at period end', async () => {
    const { service, subscriptionLifecycle, upsertCalls } = makeSubscriptionWebhookMocks();
    subscriptionLifecycle.reconcileSubscriptionPlansFromStripe.mockResolvedValue({
      membershipPlanId: 'plan-basic',
      pendingMembershipPlanId: null,
    });

    await service.upsertSubscriptionFromStripe(
      {
        ...baseSub,
        metadata: { userId: 'user_1', studioId: 'studio_1' },
        items: {
          data: [{ price: { id: 'price_basic' }, current_period_start: 1_725_168_000, current_period_end: 1_727_846_400 }],
        },
      },
      { userId: 'user_1', studioId: 'studio_1' },
      'customer.subscription.updated',
    );

    expect(upsertCalls[0]).toMatchObject({
      membershipPlanId: 'plan-basic',
      pendingMembershipPlanId: null,
    });
  });

  it('audits unknown historical duplicates without Stripe cancellation', async () => {
    const { service, subscriptionLifecycle } = makeSubscriptionWebhookMocks();
    subscriptionLifecycle.reconcileSubscriptionPlansFromStripe.mockResolvedValue({
      membershipPlanId: 'plan-full',
      pendingMembershipPlanId: null,
    });

    await service.upsertSubscriptionFromStripe(
      { ...baseSub, metadata: { userId: 'user_1', studioId: 'studio_1', planId: 'plan-full' } },
      { userId: 'user_1', studioId: 'studio_1', planId: 'plan-full' },
      'customer.subscription.updated',
    );

    expect(subscriptionLifecycle.auditDuplicateRenewableSubscriptions).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        source: 'webhook',
        stripeEventType: 'customer.subscription.updated',
      }),
    );
  });

  it('is idempotent on webhook replay', async () => {
    const { service, subscriptionLifecycle, upsertCalls } = makeSubscriptionWebhookMocks();
    subscriptionLifecycle.reconcileSubscriptionPlansFromStripe.mockResolvedValue({
      membershipPlanId: 'plan-full',
      pendingMembershipPlanId: null,
    });

    const payload = { ...baseSub, metadata: { userId: 'user_1', studioId: 'studio_1', planId: 'plan-full' } };
    await service.upsertSubscriptionFromStripe(payload, { userId: 'user_1', studioId: 'studio_1' }, 'customer.subscription.updated');
    await service.upsertSubscriptionFromStripe(payload, { userId: 'user_1', studioId: 'studio_1' }, 'customer.subscription.updated');

    expect(upsertCalls).toHaveLength(2);
    expect(upsertCalls[0]).toEqual(upsertCalls[1]);
  });

  it('reconciles cancelAtPeriodEnd=false from Stripe after plan change clears scheduled cancellation', async () => {
    const { service, subscriptionLifecycle, upsertCalls } = makeSubscriptionWebhookMocks();
    subscriptionLifecycle.reconcileSubscriptionPlansFromStripe.mockResolvedValue({
      membershipPlanId: 'plan-full',
      pendingMembershipPlanId: null,
    });

    await service.upsertSubscriptionFromStripe(
      { ...baseSub, cancel_at_period_end: false, metadata: { userId: 'user_1', studioId: 'studio_1' } },
      { userId: 'user_1', studioId: 'studio_1' },
      'customer.subscription.updated',
    );

    expect(upsertCalls[0]).toMatchObject({ cancelAtPeriodEnd: false });
  });

  it('persists cancelAtPeriodEnd=true to local DB when Stripe reports cancel_at_period_end=true', async () => {
    const { service, subscriptionLifecycle, upsertCalls } = makeSubscriptionWebhookMocks();
    subscriptionLifecycle.reconcileSubscriptionPlansFromStripe.mockResolvedValue({
      membershipPlanId: 'plan-full',
      pendingMembershipPlanId: null,
    });

    await service.upsertSubscriptionFromStripe(
      { ...baseSub, cancel_at_period_end: true, metadata: { userId: 'user_1', studioId: 'studio_1' } },
      { userId: 'user_1', studioId: 'studio_1' },
      'customer.subscription.updated',
    );

    expect(upsertCalls[0]).toMatchObject({ cancelAtPeriodEnd: true });
  });
});

// ── Part 5: handleIncomingWebhook — error observability ───────────────────────

describe('StripeWebhookService — handleIncomingWebhook error observability', () => {
  function makeWebhookHandlerMocks() {
    const updateManyMock = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      stripeWebhookEvent: {
        create: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
        updateMany: updateManyMock,
      },
    } as unknown as PrismaService;

    const stripe = {
      constructWebhookEvent: jest.fn().mockReturnValue({
        id: 'evt_obs_1',
        type: 'customer.subscription.created',
        data: { object: {} },
      }),
    } as unknown as StripeService;

    const service = new StripeWebhookService(prisma, stripe, {} as EnrollmentService, {} as never);
    return { service, prisma, stripe, updateManyMock };
  }

  it('persists lastError via updateMany when dispatch throws', async () => {
    const { service, updateManyMock } = makeWebhookHandlerMocks();

    jest.spyOn(service as never, 'dispatch').mockRejectedValue(new Error('DB connection lost'));
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(
      service.handleIncomingWebhook(Buffer.from('{}'), 'sig'),
    ).rejects.toThrow('DB connection lost');

    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { stripeEventId: 'evt_obs_1', processed: false },
        data: expect.objectContaining({ lastError: 'DB connection lost' }),
      }),
    );
  });

  it('does not persist lastError when dispatch succeeds — only processed=true is written', async () => {
    const { service, updateManyMock } = makeWebhookHandlerMocks();

    jest.spyOn(service as never, 'dispatch').mockResolvedValue(undefined);

    await service.handleIncomingWebhook(Buffer.from('{}'), 'sig');

    // updateMany should only be called by markStripeWebhookEventProcessed
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ processed: true }),
      }),
    );
    // lastError must NOT appear
    expect(updateManyMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastError: expect.anything() }),
      }),
    );
  });

  it('truncates lastError to 500 chars for pathologically long error messages', async () => {
    const { service, updateManyMock } = makeWebhookHandlerMocks();
    const longError = 'X'.repeat(600);

    jest.spyOn(service as never, 'dispatch').mockRejectedValue(new Error(longError));
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(
      service.handleIncomingWebhook(Buffer.from('{}'), 'sig'),
    ).rejects.toThrow();

    const call = updateManyMock.mock.calls.find(
      (args: Array<{ data?: { lastError?: string } }>) => args[0]?.data?.lastError,
    );
    expect(call).toBeDefined();
    expect((call![0] as { data: { lastError: string } }).data.lastError).toHaveLength(500);
  });
});

// ── Part 6: Active-subscription conflict handling ─────────────────────────────
//
// These tests cover the new handleWebhookActiveConflict logic introduced to prevent
// P2002 violations on the partial unique index: (studio_id, user_id) WHERE status='ACTIVE'.
//
// Scenario matrix:
//  A. No conflicting row           → normal upsert (CREATE or UPDATE)
//  B. Expired CASH row             → safe supersede (CANCEL cash, CREATE stripe row)
//  C. Active CASH row              → acknowledge without mutation, log error
//  D. Stripe-backed row (different)→ acknowledge without mutation, log error
//  E. Same stripeSubscriptionId    → normal upsert (UPDATE path, no conflict check)

describe('StripeWebhookService — active subscription conflict handling', () => {
  const activeSub = {
    id: 'sub_incoming',
    status: 'active',
    customer: 'cus_test',
    cancel_at_period_end: false,
    metadata: { userId: 'user_1', studioId: 'studio_1', planId: 'plan-full' },
    items: {
      data: [
        {
          price: { id: 'price_full' },
          current_period_start: 1_754_265_600,  // 2026-08-03
          current_period_end:   1_756_944_000,  // 2026-09-03
        },
      ],
    },
  };

  // Expired CASH row: period ended in the past
  const expiredCashRow = {
    id: 'local-cash-expired',
    status: SubscriptionStatus.ACTIVE,
    source: SubscriptionSource.CASH,
    stripeSubscriptionId: null,
    currentPeriodEnd: new Date('2026-08-04T00:00:00Z'),  // 10 days ago
    currentPeriodStart: new Date('2026-07-03T00:00:00Z'),
    cancelAtPeriodEnd: true,
    membershipPlanId: 'plan-full',
    studioId: 'studio_1',
    userId: 'user_1',
  };

  // Still-active CASH row: period ends in the future
  const activeCashRow = {
    ...expiredCashRow,
    id: 'local-cash-active',
    currentPeriodEnd: new Date('2026-09-14T00:00:00Z'),  // future
    currentPeriodStart: new Date('2026-08-14T00:00:00Z'),
  };

  // Stripe-backed row pointing to a DIFFERENT Stripe subscription
  const stripeBackedRow = {
    id: 'local-stripe-other',
    status: SubscriptionStatus.ACTIVE,
    source: SubscriptionSource.STRIPE,
    stripeSubscriptionId: 'sub_different_existing',
    currentPeriodEnd: new Date('2026-09-14T00:00:00Z'),
    currentPeriodStart: new Date('2026-08-14T00:00:00Z'),
    cancelAtPeriodEnd: false,
    membershipPlanId: 'plan-full',
    studioId: 'studio_1',
    userId: 'user_1',
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // 1. First Stripe subscription, no local membership → normal upsert
  it('1. first Stripe subscription with no existing local row: proceeds normally via upsert', async () => {
    const { service, subscriptionLifecycle, upsertCalls, txSubscription } = makeSubscriptionWebhookMocks();
    subscriptionLifecycle.reconcileSubscriptionPlansFromStripe.mockResolvedValue({
      membershipPlanId: 'plan-full',
      pendingMembershipPlanId: null,
    });
    // No existing local row for this sub, no conflicting row
    txSubscription.findUnique.mockResolvedValue(null);
    txSubscription.findFirst.mockResolvedValue(null);

    await service.upsertSubscriptionFromStripe(
      { ...activeSub, metadata: { userId: 'user_1', studioId: 'studio_1' } },
      { userId: 'user_1', studioId: 'studio_1' },
      'customer.subscription.created',
    );

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]).toMatchObject({ membershipPlanId: 'plan-full', status: 'ACTIVE' });
    expect(txSubscription.update).not.toHaveBeenCalled();
    expect(txSubscription.create).not.toHaveBeenCalled();
  });

  // 2. Expired CASH row + incoming Stripe → safe supersede
  it('2. expired CASH local row is canceled and Stripe-backed row is created (safe supersede)', async () => {
    const { service, subscriptionLifecycle, upsertCalls, createCalls, txSubscription } = makeSubscriptionWebhookMocks();
    subscriptionLifecycle.reconcileSubscriptionPlansFromStripe.mockResolvedValue({
      membershipPlanId: 'plan-full',
      pendingMembershipPlanId: null,
    });
    txSubscription.findUnique.mockResolvedValue(null);
    txSubscription.findFirst.mockResolvedValue(expiredCashRow);

    const logSpy = jest.spyOn(Logger.prototype, 'log');

    await service.upsertSubscriptionFromStripe(
      { ...activeSub, metadata: { userId: 'user_1', studioId: 'studio_1' } },
      { userId: 'user_1', studioId: 'studio_1' },
      'customer.subscription.created',
    );

    // CASH row must be CANCELED
    expect(txSubscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: expiredCashRow.id },
        data: { status: SubscriptionStatus.CANCELED },
      }),
    );
    // New Stripe-backed row must be CREATED
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toMatchObject({
      status: SubscriptionStatus.ACTIVE,
      stripeSubscriptionId: activeSub.id,
      membershipPlanId: 'plan-full',
    });
    // Upsert must NOT be called (CREATE path replaced by explicit create)
    expect(upsertCalls).toHaveLength(0);
    // Supersede logged
    const supersededLog = logSpy.mock.calls.find(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('webhook_superseded_expired_cash_subscription'),
    );
    expect(supersededLog).toBeDefined();
    expect(JSON.parse(supersededLog![0] as string)).toMatchObject({
      event: 'webhook_superseded_expired_cash_subscription',
      canceledLocalId: expiredCashRow.id,
      incomingStripeSubId: activeSub.id,
    });
  });

  // 3. Same scenario: cancelAtPeriodEnd can be false — period expiry is what counts
  it('3. expired CASH row with cancelAtPeriodEnd=false is still superseded when period ended', async () => {
    const { service, subscriptionLifecycle, createCalls, txSubscription } = makeSubscriptionWebhookMocks();
    subscriptionLifecycle.reconcileSubscriptionPlansFromStripe.mockResolvedValue({
      membershipPlanId: 'plan-full',
      pendingMembershipPlanId: null,
    });
    txSubscription.findUnique.mockResolvedValue(null);
    txSubscription.findFirst.mockResolvedValue({ ...expiredCashRow, cancelAtPeriodEnd: false });

    await service.upsertSubscriptionFromStripe(
      { ...activeSub, metadata: { userId: 'user_1', studioId: 'studio_1' } },
      { userId: 'user_1', studioId: 'studio_1' },
      'customer.subscription.created',
    );

    expect(txSubscription.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: SubscriptionStatus.CANCELED } }),
    );
    expect(createCalls).toHaveLength(1);
  });

  // 4. Active CASH row whose service period is NOT over → must not destroy current access
  it('4. CASH row with still-active period: webhook acknowledged without mutation, error logged', async () => {
    const { service, subscriptionLifecycle, upsertCalls, createCalls, txSubscription } = makeSubscriptionWebhookMocks();
    subscriptionLifecycle.reconcileSubscriptionPlansFromStripe.mockResolvedValue({
      membershipPlanId: 'plan-full',
      pendingMembershipPlanId: null,
    });
    txSubscription.findUnique.mockResolvedValue(null);
    txSubscription.findFirst.mockResolvedValue(activeCashRow);

    const errorSpy = jest.spyOn(Logger.prototype, 'error');

    await service.upsertSubscriptionFromStripe(
      { ...activeSub, metadata: { userId: 'user_1', studioId: 'studio_1' } },
      { userId: 'user_1', studioId: 'studio_1' },
      'customer.subscription.created',
    );

    // Must NOT mutate local DB
    expect(txSubscription.update).not.toHaveBeenCalled();
    expect(createCalls).toHaveLength(0);
    expect(upsertCalls).toHaveLength(0);
    // Must log structured error
    const errLog = errorSpy.mock.calls.find(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('webhook_subscription_conflict_acknowledged'),
    );
    expect(errLog).toBeDefined();
    const parsed = JSON.parse(errLog![0] as string) as Record<string, unknown>;
    expect(parsed['conflictKind']).toBe('active_cash_conflict');
    expect(parsed['action']).toBe('acknowledged_no_local_mutation');
    expect(parsed['incomingStripeSubId']).toBe(activeSub.id);
  });

  // 5. Two renewable Stripe subscriptions: no auto-cancel, no auto-winner
  it('5. existing Stripe-backed row with a different sub ID: no automatic winner, error logged', async () => {
    const { service, subscriptionLifecycle, upsertCalls, createCalls, txSubscription } = makeSubscriptionWebhookMocks();
    subscriptionLifecycle.reconcileSubscriptionPlansFromStripe.mockResolvedValue({
      membershipPlanId: 'plan-full',
      pendingMembershipPlanId: null,
    });
    txSubscription.findUnique.mockResolvedValue(null);
    txSubscription.findFirst.mockResolvedValue(stripeBackedRow);

    const errorSpy = jest.spyOn(Logger.prototype, 'error');

    await service.upsertSubscriptionFromStripe(
      { ...activeSub, metadata: { userId: 'user_1', studioId: 'studio_1' } },
      { userId: 'user_1', studioId: 'studio_1' },
      'customer.subscription.created',
    );

    // Absolutely no Stripe mutations simulated — and no local mutations either
    expect(txSubscription.update).not.toHaveBeenCalled();
    expect(createCalls).toHaveLength(0);
    expect(upsertCalls).toHaveLength(0);
    // Conflict kind must identify it as a stripe_backed conflict
    const errLog = errorSpy.mock.calls.find(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('webhook_subscription_conflict_acknowledged'),
    );
    expect(errLog).toBeDefined();
    const parsed = JSON.parse(errLog![0] as string) as Record<string, unknown>;
    expect(parsed['conflictKind']).toBe('stripe_backed_conflict');
    expect(parsed['existingLocalStripeSubId']).toBe('sub_different_existing');
    expect(parsed['incomingStripeSubId']).toBe(activeSub.id);
    expect(parsed['action']).toBe('acknowledged_no_local_mutation');
  });

  // 6. Incoming webhook is for the same stripeSubscriptionId that already exists locally → UPDATE path
  it('6. existing local row for the same stripeSubscriptionId: normal UPDATE via upsert, no conflict check', async () => {
    const { service, subscriptionLifecycle, upsertCalls, txSubscription } = makeSubscriptionWebhookMocks();
    subscriptionLifecycle.reconcileSubscriptionPlansFromStripe.mockResolvedValue({
      membershipPlanId: 'plan-full',
      pendingMembershipPlanId: null,
    });
    // The row already exists locally — findUnique returns it
    txSubscription.findUnique.mockResolvedValue({ id: 'sub-local-existing', stripeSubscriptionId: activeSub.id });

    await service.upsertSubscriptionFromStripe(
      { ...activeSub, metadata: { userId: 'user_1', studioId: 'studio_1' } },
      { userId: 'user_1', studioId: 'studio_1' },
      'customer.subscription.updated',
    );

    // findFirst (conflict check) must NOT be called — we detected UPDATE path via findUnique
    expect(txSubscription.findFirst).not.toHaveBeenCalled();
    // Upsert must run normally
    expect(upsertCalls).toHaveLength(1);
  });

  // 7. customer.subscription.deleted: CANCELED status — conflict check skipped (not renewable)
  it('7. customer.subscription.deleted does not trigger conflict check (CANCELED is not renewable)', async () => {
    const { service, subscriptionLifecycle, upsertCalls, txSubscription } = makeSubscriptionWebhookMocks();
    subscriptionLifecycle.reconcileSubscriptionPlansFromStripe.mockResolvedValue({
      membershipPlanId: 'plan-full',
      pendingMembershipPlanId: null,
    });

    await service.upsertSubscriptionFromStripe(
      { ...activeSub, status: 'canceled', metadata: { userId: 'user_1', studioId: 'studio_1' } },
      { userId: 'user_1', studioId: 'studio_1' },
      'customer.subscription.deleted',
    );

    // Neither findUnique nor findFirst should be called — the status is not renewable
    expect(txSubscription.findUnique).not.toHaveBeenCalled();
    expect(txSubscription.findFirst).not.toHaveBeenCalled();
    // Normal upsert runs
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]).toMatchObject({ status: 'CANCELED' });
  });

  // 8. After a safe supersede, the unique index invariant is satisfied (one ACTIVE row)
  it('8. after safe supersede the transaction produces exactly one ACTIVE row (no concurrent active rows)', async () => {
    const { service, subscriptionLifecycle, createCalls, txSubscription } = makeSubscriptionWebhookMocks();
    subscriptionLifecycle.reconcileSubscriptionPlansFromStripe.mockResolvedValue({
      membershipPlanId: 'plan-full',
      pendingMembershipPlanId: null,
    });
    txSubscription.findUnique.mockResolvedValue(null);
    txSubscription.findFirst.mockResolvedValue(expiredCashRow);

    await service.upsertSubscriptionFromStripe(
      { ...activeSub, metadata: { userId: 'user_1', studioId: 'studio_1' } },
      { userId: 'user_1', studioId: 'studio_1' },
      'customer.subscription.created',
    );

    // Old ACTIVE CASH row canceled first, then new ACTIVE Stripe row created:
    // update(CANCELED) is called before create(ACTIVE) — order within the transaction.
    expect(txSubscription.update.mock.invocationCallOrder[0]).toBeLessThan(
      txSubscription.create.mock.invocationCallOrder[0],
    );
    expect(createCalls[0]).toMatchObject({ status: SubscriptionStatus.ACTIVE });
  });

  // 9. Conflict handler failure → lastError populated, webhook retryable
  it('9. conflict handler internal failure propagates correctly and does not silently swallow the error', async () => {
    const { service, subscriptionLifecycle, txSubscription } = makeSubscriptionWebhookMocks();
    subscriptionLifecycle.reconcileSubscriptionPlansFromStripe.mockResolvedValue({
      membershipPlanId: 'plan-full',
      pendingMembershipPlanId: null,
    });
    txSubscription.findUnique.mockResolvedValue(null);
    txSubscription.findFirst.mockResolvedValue(expiredCashRow);
    // Simulate DB failure during the CASH row update
    txSubscription.update.mockRejectedValue(new Error('connection timeout'));

    await expect(
      service.upsertSubscriptionFromStripe(
        { ...activeSub, metadata: { userId: 'user_1', studioId: 'studio_1' } },
        { userId: 'user_1', studioId: 'studio_1' },
        'customer.subscription.created',
      ),
    ).rejects.toThrow('connection timeout');
  });

  // 10. Acknowledged conflict does not throw → webhook is marked processed=true by the caller
  it('10. acknowledged conflict (active CASH) returns without throwing so the webhook can be marked processed', async () => {
    const { service, subscriptionLifecycle, txSubscription } = makeSubscriptionWebhookMocks();
    subscriptionLifecycle.reconcileSubscriptionPlansFromStripe.mockResolvedValue({
      membershipPlanId: 'plan-full',
      pendingMembershipPlanId: null,
    });
    txSubscription.findUnique.mockResolvedValue(null);
    txSubscription.findFirst.mockResolvedValue(activeCashRow);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    // Must resolve (not reject) so the outer handleIncomingWebhook marks processed=true
    await expect(
      service.upsertSubscriptionFromStripe(
        { ...activeSub, metadata: { userId: 'user_1', studioId: 'studio_1' } },
        { userId: 'user_1', studioId: 'studio_1' },
        'customer.subscription.created',
      ),
    ).resolves.toBeUndefined();
  });

  // 11. Emilia historical scenario: active Basic (Stripe-backed) + incoming Full → stripe_backed_conflict
  //     (In practice Emilia's Basic was Stripe-backed, not CASH — the webhook acknowledges without mutation)
  it('11. Emilia historical scenario: Stripe-backed Basic + incoming Full → acknowledged, no auto-cancel', async () => {
    const { service, subscriptionLifecycle, upsertCalls, createCalls, txSubscription } = makeSubscriptionWebhookMocks();
    subscriptionLifecycle.reconcileSubscriptionPlansFromStripe.mockResolvedValue({
      membershipPlanId: 'plan-full',
      pendingMembershipPlanId: null,
    });
    txSubscription.findUnique.mockResolvedValue(null);
    txSubscription.findFirst.mockResolvedValue({
      id: 'local-basic-emilia',
      status: SubscriptionStatus.ACTIVE,
      source: SubscriptionSource.STRIPE,
      stripeSubscriptionId: 'sub_1TqKw5GuUoCXNOREO80x7acx',  // Emilia's Basic
      currentPeriodEnd: new Date('2026-09-06T00:00:00Z'),
      cancelAtPeriodEnd: false,
      membershipPlanId: 'plan-basic',
    });
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await service.upsertSubscriptionFromStripe(
      {
        ...activeSub,
        id: 'sub_1TyBahGuUoCXNOREC0n7bQF8',  // Emilia's Full Access
        metadata: { userId: 'cmr27x7vc0004m60rgy4bqjpq', studioId: 'cmp33m0gp0000qomlj9p42ia5' },
      },
      { userId: 'cmr27x7vc0004m60rgy4bqjpq', studioId: 'cmp33m0gp0000qomlj9p42ia5' },
      'customer.subscription.created',
    );

    // No auto-cancellation of either subscription
    expect(txSubscription.update).not.toHaveBeenCalled();
    expect(createCalls).toHaveLength(0);
    expect(upsertCalls).toHaveLength(0);
  });

  // 12. Carlo historical scenario: expired CASH Full + incoming Stripe Full → safe supersede
  it('12. Carlo historical scenario: expired CASH Full → superseded by incoming Stripe Full', async () => {
    const { service, subscriptionLifecycle, createCalls, txSubscription } = makeSubscriptionWebhookMocks();
    subscriptionLifecycle.reconcileSubscriptionPlansFromStripe.mockResolvedValue({
      membershipPlanId: 'plan-full',
      pendingMembershipPlanId: null,
    });
    txSubscription.findUnique.mockResolvedValue(null);
    txSubscription.findFirst.mockResolvedValue({
      id: 'cmr5e5tl3002hm60r9s2d08cc',  // Carlo's CASH sub
      status: SubscriptionStatus.ACTIVE,
      source: SubscriptionSource.CASH,
      stripeSubscriptionId: null,
      currentPeriodEnd: new Date('2026-08-04T05:59:59Z'),  // expired Aug 4
      currentPeriodStart: new Date('2026-07-03T18:00:00Z'),
      cancelAtPeriodEnd: true,
      membershipPlanId: 'plan-full',
    });

    await service.upsertSubscriptionFromStripe(
      {
        ...activeSub,
        id: 'sub_1U0LZeGuUoCXNOREKzoRfHBa',  // Carlo's Stripe sub
        metadata: {
          userId: 'cmqzsizk9004rqo0rtq4hvgvm',
          studioId: 'cmp33m0gp0000qomlj9p42ia5',
          planId: 'plan-full',
        },
      },
      { userId: 'cmqzsizk9004rqo0rtq4hvgvm', studioId: 'cmp33m0gp0000qomlj9p42ia5' },
      'customer.subscription.created',
    );

    expect(txSubscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'cmr5e5tl3002hm60r9s2d08cc' },
        data: { status: SubscriptionStatus.CANCELED },
      }),
    );
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toMatchObject({
      status: SubscriptionStatus.ACTIVE,
      stripeSubscriptionId: 'sub_1U0LZeGuUoCXNOREKzoRfHBa',
    });
  });
});
