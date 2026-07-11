import { Logger } from '@nestjs/common';
import { PaymentMethod, PaymentStatus } from '@prisma/client';
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
    user: {
      findFirst: jest.fn().mockResolvedValue(user),
    },
    subscription: {
      findUnique: jest.fn().mockResolvedValue(dbSubscription),
    },
    membershipPlan: {
      findFirst: jest.fn().mockResolvedValue(plan),
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

  const service = new StripeWebhookService(prisma, stripe, enrollment);

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
