import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { PaymentMethod, PaymentStatus, Prisma, SubscriptionEndReason, SubscriptionSource, SubscriptionStatus } from '@prisma/client';
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

type DispatchTarget = {
  dispatch: (event: unknown) => Promise<void>;
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
      findUnique: jest.fn().mockResolvedValue(null),
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
    findPaidInvoicePaymentIntentId: jest.fn().mockResolvedValue(null),
  };

  const enrollment = {} as unknown as EnrollmentService;

  const subscriptionLifecycle = {
    auditDuplicateRenewableSubscriptions: jest.fn(),
    reconcileSubscriptionPlansFromStripe: jest.fn().mockResolvedValue({
      membershipPlanId: 'plan_1',
      pendingMembershipPlanId: null,
    }),
  };

  const stripeToCash = {
    activateScheduledCashIfDue: jest.fn().mockResolvedValue(null),
  };

  const renewalAudit = { maybeLogExternalRenewalChange: jest.fn().mockResolvedValue('skipped_no_transition') };
  const billingCases = { observe: jest.fn().mockResolvedValue({ outcome: 'created', case: {} }) };
  const service = new StripeWebhookService(
    prisma,
    stripe as unknown as StripeService,
    enrollment,
    subscriptionLifecycle as never,
    stripeToCash as never,
    renewalAudit as never,
    billingCases as never,
  );

  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

  return {
    service: service as unknown as ServiceUnderTest,
    prisma: prisma as unknown as jest.Mocked<typeof prisma>,
    stripe,
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

// ── Fixed-duration (Booty Lab) entitlement grants — REAL dahlia payloads ───────
//
// These tests drive the real service with the sanitized production payloads in
// test/fixtures/stripe-webhooks (Price at pricing.price_details.price, no top-level price).
// The in-memory store enforces what Postgres enforces — one Payment per invoice, one cycle
// per invoice, and the non-overlap ledger trigger — so a test cannot pass by mocking the
// defect away.

type StoredEvent = { processed: boolean; attemptCount: number; lastError: string | null };
type StoredCycle = {
  id: string; subscriptionId: string; startsAt: Date; endsAt: Date;
  stripeInvoiceId: string | null; creditLimit: number | null; membershipPlanId?: string;
};
type StoredPayment = PaymentRow & { id: string };
type WebhookEvent = { id: string; type: string; created: number; data: { object: Record<string, unknown> } };

function stripeFixture(name: string): WebhookEvent {
  return JSON.parse(readFileSync(join(__dirname, '../../test/fixtures/stripe-webhooks', `${name}.json`), 'utf8'));
}

const OCT_2 = new Date('2026-10-02T16:54:40.000Z');
const NOV_16 = new Date('2026-11-16T16:54:40.000Z');
const AUG_18 = new Date('2026-08-18T16:54:40.000Z');
const BACKFILL_CYCLE: StoredCycle = {
  id: 'backfill_local_sub_booty', subscriptionId: 'local_sub_booty', startsAt: AUG_18, endsAt: OCT_2,
  stripeInvoiceId: 'in_fx_booty_initial', creditLimit: 4,
};

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
}

function makeBootyHarness(options: {
  plan?: Partial<{ stripePriceId: string | null; stripeProductId: string | null; entitlementDays: number; classCredits: number | null }>;
  subscription?: Partial<{
    status: SubscriptionStatus; entitlementEndsAt: Date; currentPeriodStart: Date; currentPeriodEnd: Date;
    supersededBySubscriptionId: string | null; endReason: SubscriptionEndReason | null;
  }>;
  cycles?: StoredCycle[];
  paymentIntentLookup?: () => Promise<string | null>;
  /** What a "which fixed-duration plans bill this Price/Product?" lookup returns (plan-switch race). */
  fixedPlanBillingLine?: { id: string; entitlementDays: number; stripePriceId: string | null; stripeProductId: string | null } | null;
  /** Another studio plan owning the billed Price/Product (checkout-metadata match guard). */
  otherPlanOwningLine?: { id: string } | null;
} = {}) {
  const events = new Map<string, StoredEvent>();
  const payments = new Map<string, StoredPayment>();
  const cycles: StoredCycle[] = (options.cycles ?? [BACKFILL_CYCLE]).map((c) => ({ ...c }));
  const plan = {
    id: 'fx_plan_booty', studioId: 'fx_studio_ares', deletedAt: null, name: 'Booty Lab by Etzia',
    entitlementDays: 45, classCredits: 4, stripePriceId: 'price_fx_booty_45d', stripeProductId: 'prod_fx_booty',
    ...options.plan,
  };
  const subscription = {
    id: 'local_sub_booty', studioId: 'fx_studio_ares', userId: 'fx_user_booty_member', membershipPlanId: plan.id,
    stripeSubscriptionId: 'sub_fx_booty_member', source: SubscriptionSource.STRIPE, status: SubscriptionStatus.ACTIVE as SubscriptionStatus,
    currentPeriodStart: AUG_18, currentPeriodEnd: OCT_2, entitlementEndsAt: OCT_2,
    supersededBySubscriptionId: null as string | null, endReason: null as SubscriptionEndReason | null,
    ...options.subscription,
  };
  const subscriptionWrites: Array<Record<string, unknown>> = [];
  const state = { localSubscriptionExists: true };

  let tail = Promise.resolve<unknown>(undefined);
  const prisma = {
    stripeWebhookEvent: {
      create: jest.fn(async ({ data }: { data: { stripeEventId: string } }) => {
        if (events.has(data.stripeEventId)) throw uniqueViolation();
        events.set(data.stripeEventId, { processed: false, attemptCount: 1, lastError: null });
        return data;
      }),
      findUnique: jest.fn(async ({ where }: { where: { stripeEventId: string } }) => events.get(where.stripeEventId) ?? null),
      // Late-payment policy: "when did Stripe end this subscription?" — no stored deletion here.
      findFirst: jest.fn(async () => null),
      update: jest.fn(async ({ where }: { where: { stripeEventId: string } }) => {
        events.get(where.stripeEventId)!.attemptCount += 1;
        return {};
      }),
      updateMany: jest.fn(async ({ where, data }: { where: { stripeEventId: string; processed: boolean }; data: Partial<StoredEvent> }) => {
        const row = events.get(where.stripeEventId);
        if (!row || row.processed !== where.processed) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    user: { findFirst: jest.fn(async () => ({ id: subscription.userId, deletedAt: null })) },
    subscription: {
      findUnique: jest.fn(async ({ where }: { where: { id?: string; stripeSubscriptionId?: string } }) =>
        state.localSubscriptionExists &&
        (where.id === subscription.id || where.stripeSubscriptionId === subscription.stripeSubscriptionId)
          ? { ...subscription, membershipPlan: plan }
          : null),
      // Late-payment policy: "is there a newer same-family membership?" — none in this harness.
      findFirst: jest.fn(async () => null),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        subscriptionWrites.push(data);
        Object.assign(subscription, data);
        return subscription;
      }),
      updateMany: jest.fn(async ({ where, data }: {
        where: { id: string; status: { in: SubscriptionStatus[] }; payments?: { none: { stripeInvoiceId: string; status: PaymentStatus } } };
        data: Record<string, unknown>;
      }) => {
        if (where.id !== subscription.id || !where.status.in.includes(subscription.status)) return { count: 0 };
        const settled = where.payments?.none;
        if (settled && payments.get(settled.stripeInvoiceId)?.status === settled.status) return { count: 0 };
        subscriptionWrites.push(data);
        Object.assign(subscription, data);
        return { count: 1 };
      }),
    },
    membershipPlan: {
      // `id: { not }` = "does another plan own this billed Price/Product?" (metadata-match guard).
      findFirst: jest.fn(async ({ where }: { where: { id?: { not: string } } }) =>
        where.id?.not ? options.otherPlanOwningLine ?? null : plan),
      // "Which fixed-duration plans bill this Price/Product?" (plan-switch race check).
      findMany: jest.fn(async () => (options.fixedPlanBillingLine ? [options.fixedPlanBillingLine] : [])),
      findUnique: jest.fn(async () => plan),
    },
    studioMembership: { findFirst: jest.fn(async () => ({ id: 'membership' })) },
    payment: {
      upsert: jest.fn(async ({ where, create, update }: { where: { stripeInvoiceId: string }; create: PaymentRow; update: Partial<PaymentRow> }) => {
        const existing = payments.get(where.stripeInvoiceId);
        if (!existing) {
          payments.set(where.stripeInvoiceId, { id: `pay_${payments.size + 1}`, ...create });
        } else {
          for (const [k, v] of Object.entries(update)) if (v !== undefined) (existing as Record<string, unknown>)[k] = v;
        }
        return payments.get(where.stripeInvoiceId);
      }),
      findUnique: jest.fn(async ({ where }: { where: { stripeInvoiceId?: string; stripePaymentIntentId?: string } }) => {
        if (where.stripeInvoiceId) return payments.get(where.stripeInvoiceId) ?? null;
        return [...payments.values()].find((p) => p.stripePaymentIntentId === where.stripePaymentIntentId) ?? null;
      }),
      // Conditional writes exactly like Postgres: only rows matching every condition change.
      updateMany: jest.fn(async ({ where, data }: {
        where: { stripeInvoiceId: string; stripePaymentIntentId?: null; status?: { not: PaymentStatus } };
        data: Partial<PaymentRow>;
      }) => {
        const row = payments.get(where.stripeInvoiceId);
        if (!row) return { count: 0 };
        if (where.stripePaymentIntentId === null && row.stripePaymentIntentId !== null) return { count: 0 };
        if (where.status && row.status === where.status.not) return { count: 0 };
        for (const [k, v] of Object.entries(data)) if (v !== undefined) (row as Record<string, unknown>)[k] = v;
        return { count: 1 };
      }),
      create: jest.fn(async ({ data }: { data: PaymentRow }) => {
        if (data.stripeInvoiceId && payments.has(data.stripeInvoiceId)) throw uniqueViolation();
        const row = { id: `pay_${payments.size + 1}`, ...data };
        payments.set(data.stripeInvoiceId!, row);
        return row;
      }),
    },
    membershipEntitlementCycle: {
      findUnique: jest.fn(async ({ where }: { where: { stripeInvoiceId: string } }) =>
        cycles.find((c) => c.stripeInvoiceId === where.stripeInvoiceId) ?? null),
      findMany: jest.fn(async ({ where }: { where: { subscriptionId: string } }) =>
        cycles.filter((c) => c.subscriptionId === where.subscriptionId).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())),
      create: jest.fn(async ({ data }: { data: StoredCycle }) => {
        // Mirrors the unique index and the enforce_membership_entitlement_cycle_ledger trigger.
        if (data.stripeInvoiceId && cycles.some((c) => c.stripeInvoiceId === data.stripeInvoiceId)) throw uniqueViolation();
        if (cycles.some((c) => c.subscriptionId === data.subscriptionId && c.startsAt < data.endsAt && c.endsAt > data.startsAt)) {
          throw new Error('membership entitlement cycle overlaps an existing cycle');
        }
        const row = { ...data, id: `cycle_${cycles.length + 1}` };
        cycles.push(row);
        return row;
      }),
    },
    $executeRaw: jest.fn(async () => 1),
    $transaction: jest.fn(),
  };
  // Serialised like advisory-locked transactions.
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
    const run: Promise<unknown> = tail.then(() => fn(prisma));
    tail = run.catch(() => undefined);
    return run;
  });

  const stripe = {
    constructWebhookEvent: jest.fn(),
    retrieveSubscription: jest.fn(),
    findPaidInvoicePaymentIntentId: jest.fn(options.paymentIntentLookup ?? (async () => 'pi_fx_booty_renewal')),
    // Mutating Stripe calls — must never be used by entitlement processing.
    updateSubscription: jest.fn(),
    cancelSubscription: jest.fn(),
    scheduleSubscriptionPriceChangeAtPeriodEnd: jest.fn(),
    createRecurringPrice: jest.fn(),
    deactivatePrice: jest.fn(),
  };

  const billingCases = { observe: jest.fn(async (...args: unknown[]) => ({ outcome: 'created', case: {}, argCount: args.length })) };
  const service = new StripeWebhookService(
    prisma as unknown as PrismaService,
    stripe as unknown as StripeService,
    {} as EnrollmentService,
    { auditDuplicateRenewableSubscriptions: jest.fn(), reconcileSubscriptionPlansFromStripe: jest.fn() } as never,
    { activateScheduledCashIfDue: jest.fn() } as never,
    { maybeLogExternalRenewalChange: jest.fn() } as never,
    billingCases as never,
  );
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

  const deliver = async (event: WebhookEvent) => {
    stripe.constructWebhookEvent.mockReturnValueOnce(event);
    await service.handleIncomingWebhook(Buffer.from('{}'), 'sig');
  };
  const stripeWasMutated = () =>
    [stripe.updateSubscription, stripe.cancelSubscription, stripe.scheduleSubscriptionPriceChangeAtPeriodEnd, stripe.createRecurringPrice, stripe.deactivatePrice]
      .some((fn) => fn.mock.calls.length > 0);

  return { service, prisma, stripe, events, payments, cycles, plan, subscription, subscriptionWrites, state, deliver, errorLog, stripeWasMutated, billingCases };
}

describe('StripeWebhookService — Booty Lab renewal on the real dahlia payload', () => {
  const RENEWAL = () => stripeFixture('dahlia-invoice-paid-booty-renewal');

  it('grants Oct 2 to Nov 16 with exactly 4 credits, records one Payment and marks the event processed', async () => {
    const h = makeBootyHarness();
    await h.deliver(RENEWAL());

    expect(h.payments.size).toBe(1);
    expect(h.payments.get('in_fx_booty_renewal')).toMatchObject({
      amountCents: 80000, currency: 'mxn', status: PaymentStatus.SUCCEEDED, paymentMethod: PaymentMethod.STRIPE,
      subscriptionId: 'local_sub_booty', stripePaymentIntentId: 'pi_fx_booty_renewal',
    });
    expect(h.cycles).toHaveLength(2);
    expect(h.cycles[1]).toMatchObject({
      subscriptionId: 'local_sub_booty', startsAt: OCT_2, endsAt: NOV_16, creditLimit: 4,
      stripeInvoiceId: 'in_fx_booty_renewal', membershipPlanId: 'fx_plan_booty',
    });
    expect(h.cycles[0]).toEqual(BACKFILL_CYCLE); // prior cycle untouched
    expect(h.subscription).toMatchObject({
      status: SubscriptionStatus.ACTIVE, currentPeriodStart: OCT_2, currentPeriodEnd: NOV_16, entitlementEndsAt: NOV_16,
    });
    expect(h.events.get('evt_fx_booty_renewal_paid')).toEqual({ processed: true, attemptCount: 1, lastError: null, processedAt: expect.any(Date) });
    expect(h.stripeWasMutated()).toBe(false);
  });

  it('records the Payment before a failed grant, dead-letters loudly, and a later delivery repairs it once', async () => {
    // Simulate a paid period the plan cannot accept (plan duration edited to 30 days).
    const h = makeBootyHarness({ plan: { entitlementDays: 30 } });

    await expect(h.deliver(RENEWAL())).rejects.toThrow(
      '[fixed-duration-entitlement:PERIOD_MISMATCH] invoice in_fx_booty_renewal',
    );
    expect(h.payments.size).toBe(1);
    expect(h.cycles).toHaveLength(1);
    expect(h.events.get('evt_fx_booty_renewal_paid')).toMatchObject({
      processed: false, lastError: expect.stringContaining('PERIOD_MISMATCH'),
    });
    const failureLog = h.errorLog.mock.calls.map((c) => String(c[0])).find((m) => m.includes('fixed_duration_entitlement_grant_failed'));
    expect(failureLog).toBeDefined();
    const parsed = JSON.parse(failureLog!) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      code: 'PERIOD_MISMATCH', stripeEventId: 'evt_fx_booty_renewal_paid', stripeInvoiceId: 'in_fx_booty_renewal',
      stripeSubscriptionId: 'sub_fx_booty_member', localSubscriptionId: 'local_sub_booty', amountPaid: 80000,
    });
    expect(failureLog).not.toMatch(/@|redacted/); // ids only — no customer data

    // The plan is corrected; Stripe (or an approved operator resend) delivers the same event again.
    Object.assign(h.plan, { entitlementDays: 45 });
    await h.deliver(RENEWAL());

    expect(h.payments.size).toBe(1); // the stored Payment did not block the grant
    expect(h.cycles).toHaveLength(2);
    expect(h.cycles[1]).toMatchObject({ startsAt: OCT_2, endsAt: NOV_16, creditLimit: 4 });
    expect(h.events.get('evt_fx_booty_renewal_paid')).toMatchObject({ processed: true, attemptCount: 2 });
  });

  it('is idempotent across seven sequential deliveries and repeated direct handling', async () => {
    const h = makeBootyHarness();
    for (let i = 0; i < 7; i += 1) await h.deliver(RENEWAL());
    // Even if the processed flag were lost, the handler itself must not double-grant.
    const invoice = RENEWAL().data.object as unknown as WebhookInvoicePayload;
    await (h.service as unknown as ServiceUnderTest).onInvoicePaid(invoice);
    await (h.service as unknown as ServiceUnderTest).onInvoicePaid(invoice);

    expect(h.payments.size).toBe(1);
    expect(h.cycles.filter((c) => c.stripeInvoiceId === 'in_fx_booty_renewal')).toHaveLength(1);
    expect(h.cycles).toHaveLength(2);
    expect(h.subscriptionWrites).toHaveLength(1);
  });

  it('creates one cycle when the same event is delivered concurrently', async () => {
    const h = makeBootyHarness();
    await Promise.all(Array.from({ length: 5 }, () => h.deliver(RENEWAL())));
    expect(h.payments.size).toBe(1);
    expect(h.cycles).toHaveLength(2);
    expect(h.subscription.entitlementEndsAt).toEqual(NOV_16);
  });

  it('renews a grandfathered subscriber whose Price is no longer the catalog Price — without touching Stripe', async () => {
    const h = makeBootyHarness({ plan: { stripePriceId: 'price_fx_booty_45d_v2' } }); // owner changed the catalog price
    await h.deliver(RENEWAL());

    expect(h.cycles[1]).toMatchObject({ startsAt: OCT_2, endsAt: NOV_16, creditLimit: 4 });
    expect(h.payments.get('in_fx_booty_renewal')!.amountCents).toBe(80000); // what Stripe collected
    expect(h.plan.stripePriceId).toBe('price_fx_booty_45d_v2'); // catalog untouched
    expect(h.stripeWasMutated()).toBe(false); // no subscription price update, no migration
  });

  it('fills a historical gap behind a newer cycle without moving the live period', async () => {
    const dec31 = new Date('2026-12-31T16:54:40.000Z');
    const newer: StoredCycle = { id: 'cycle_nov16', subscriptionId: 'local_sub_booty', startsAt: NOV_16, endsAt: dec31, stripeInvoiceId: 'in_fx_next', creditLimit: 4 };
    const h = makeBootyHarness({
      cycles: [BACKFILL_CYCLE, newer],
      subscription: { currentPeriodStart: NOV_16, currentPeriodEnd: dec31, entitlementEndsAt: dec31 },
    });
    await h.deliver(RENEWAL());

    expect(h.cycles).toHaveLength(3);
    expect(h.cycles.find((c) => c.stripeInvoiceId === 'in_fx_booty_renewal')).toMatchObject({ startsAt: OCT_2, endsAt: NOV_16 });
    expect(h.subscriptionWrites).toHaveLength(0);
    expect(h.subscription.entitlementEndsAt).toEqual(dec31);
    expect(h.cycles.find((c) => c.id === 'cycle_nov16')).toEqual(newer);
  });

  it('refuses a paid period that overlaps a different cycle and keeps the Payment', async () => {
    const lateBackfill = { ...BACKFILL_CYCLE, endsAt: new Date('2026-10-02T17:54:40.000Z') };
    const h = makeBootyHarness({ cycles: [lateBackfill] });
    await expect(h.deliver(RENEWAL())).rejects.toThrow('[fixed-duration-entitlement:OVERLAPS_EXISTING_CYCLE]');
    expect(h.payments.size).toBe(1);
    expect(h.cycles).toEqual([lateBackfill]);
  });

  it('never resurrects a CANCELED subscription while still granting the paid period', async () => {
    const h = makeBootyHarness({ subscription: { status: SubscriptionStatus.CANCELED } });
    await h.deliver(RENEWAL());
    expect(h.subscription.status).toBe(SubscriptionStatus.CANCELED);
    expect(h.subscription.entitlementEndsAt).toEqual(NOV_16);
  });

  it('a second 45-day renewal adds exactly one more 4-credit cycle', async () => {
    const h = makeBootyHarness();
    await h.deliver(RENEWAL());
    const next = RENEWAL();
    const invoice = next.data.object as { id: string; lines: { data: Array<{ period: { start: number; end: number } }> } };
    next.id = 'evt_fx_booty_second_renewal';
    invoice.id = 'in_fx_booty_second_renewal';
    invoice.lines.data[0].period = { start: invoice.lines.data[0].period.end, end: invoice.lines.data[0].period.end + 45 * 86400 };
    await h.deliver(next);

    expect(h.cycles.map((c) => [c.startsAt.toISOString(), c.endsAt.toISOString(), c.creditLimit])).toEqual([
      ['2026-08-18T16:54:40.000Z', '2026-10-02T16:54:40.000Z', 4],
      ['2026-10-02T16:54:40.000Z', '2026-11-16T16:54:40.000Z', 4],
      ['2026-11-16T16:54:40.000Z', '2026-12-31T16:54:40.000Z', 4],
    ]);
    expect(h.subscription.entitlementEndsAt).toEqual(new Date('2026-12-31T16:54:40.000Z'));
  });

  it('grants the renewal when a zero-length one-off fee rides on the same invoice (Stripe-documented shape)', async () => {
    const h = makeBootyHarness();
    const event = RENEWAL();
    const invoice = event.data.object as { amount_paid: number; lines: { data: unknown[] } };
    invoice.amount_paid += 20000;
    invoice.lines.data.push({
      id: 'il_fee', object: 'line_item', amount: 20000, subtotal: 20000, currency: 'mxn', period: { start: 1790960080, end: 1790960080 },
      parent: { type: 'invoice_item_details', invoice_item_details: { invoice_item: 'ii_fee', proration: false, proration_details: { credited_items: null }, subscription: null }, subscription_item_details: null },
      pricing: { type: 'price_details', price_details: { price: 'price_fee', product: 'prod_fee' }, unit_amount_decimal: '20000' },
    });
    await h.deliver(event);
    expect(h.cycles[1]).toMatchObject({ startsAt: OCT_2, endsAt: NOV_16, creditLimit: 4 });
    expect(h.events.get('evt_fx_booty_renewal_paid')).toMatchObject({ processed: true });
  });

  it('retries a plan change INTO Booty Lab whose invoice.paid beats the local plan switch', async () => {
    // Local row still on a monthly plan, but Stripe already bills the Booty 45-day Price.
    const h = makeBootyHarness({
      plan: { entitlementDays: null as unknown as number },
      fixedPlanBillingLine: { id: 'fx_plan_booty', entitlementDays: 45, stripePriceId: 'price_fx_booty_45d', stripeProductId: 'prod_fx_booty' },
    });
    await expect(h.deliver(RENEWAL())).rejects.toThrow('[fixed-duration-entitlement:SUBSCRIPTION_PLAN_NOT_SYNCED]');
    expect(h.events.get('evt_fx_booty_renewal_paid')).toMatchObject({ processed: false });
    expect(h.payments.size).toBe(1);

    Object.assign(h.plan, { entitlementDays: 45 }); // customer.subscription.updated switched the plan
    await h.deliver(RENEWAL());
    expect(h.cycles[1]).toMatchObject({ startsAt: OCT_2, endsAt: NOV_16, creditLimit: 4 });
  });

  it('does not mistake a monthly renewal on a Product shared with a fixed plan for a plan switch', async () => {
    const h = makeBootyHarness({
      plan: { entitlementDays: null as unknown as number },
      fixedPlanBillingLine: { id: 'fx_plan_booty', entitlementDays: 45, stripePriceId: 'price_fx_booty_45d', stripeProductId: 'prod_fx_booty' },
    });
    const monthly = RENEWAL();
    const line = (monthly.data.object as { lines: { data: Array<{ period: { start: number; end: number }; pricing: { price_details: { price: string } } }> } }).lines.data[0];
    line.period = { start: line.period.start, end: line.period.start + 31 * 86400 }; // a monthly period
    line.pricing.price_details.price = 'price_fx_monthly_same_product';
    await h.deliver(monthly);
    expect(h.events.get('evt_fx_booty_renewal_paid')).toMatchObject({ processed: true, lastError: null });
    expect(h.payments.size).toBe(1);
  });

    it('grants a catalog-drifted renewal through checkout metadata, but retries when the billed Price is another plan’s', async () => {
    // Catalog drift: plan Price/Product no longer match the line, checkout metadata names this plan.
    const drifted = makeBootyHarness({ plan: { stripePriceId: 'price_new', stripeProductId: 'prod_new' } });
    await drifted.deliver(RENEWAL());
    expect(drifted.cycles[1]).toMatchObject({ startsAt: OCT_2, endsAt: NOV_16, creditLimit: 4 });

    const switching = makeBootyHarness({ plan: { stripePriceId: 'price_new', stripeProductId: 'prod_new' }, otherPlanOwningLine: { id: 'fx_plan_other_45d' } });
    await expect(switching.deliver(RENEWAL())).rejects.toThrow('[fixed-duration-entitlement:SUBSCRIPTION_PLAN_NOT_SYNCED]');
    expect(switching.cycles).toHaveLength(1);
  });

    it('never adds a paid period to a row already superseded by a successor — the money becomes a CRITICAL case, not a dead letter', async () => {
    const h = makeBootyHarness({
      subscription: { status: SubscriptionStatus.CANCELED, supersededBySubscriptionId: 'cash_successor', endReason: SubscriptionEndReason.SUPERSEDED_PAYMENT_METHOD },
    });
    h.stripe.retrieveSubscription.mockResolvedValue({ id: 'sub_fx_booty_member', status: 'active', cancellation_details: null });
    await h.deliver(RENEWAL());
    expect(h.payments.size).toBe(1); // the money is still recorded
    expect(h.cycles).toHaveLength(1); // no second paid window on a replaced membership
    expect(h.subscription.entitlementEndsAt).toEqual(OCT_2);
    expect(h.subscription.status).toBe(SubscriptionStatus.CANCELED);
    expect(h.billingCases.observe).toHaveBeenCalledTimes(1);
    expect(h.billingCases.observe.mock.calls[0]![1]).toMatchObject({
      category: 'PAID_WITHOUT_ENTITLEMENT',
      severity: 'CRITICAL',
      reasonCode: 'SUPERSEDED_MEMBERSHIP',
      stripeInvoiceId: 'in_fx_booty_renewal',
      evidence: expect.objectContaining({ entitlementGranted: false, amountCents: 80000 }),
    });
    expect(h.stripeWasMutated()).toBe(false);
    // Retrying cannot "repair" a business decision, so the event is processed, not dead-lettered.
    expect([...h.events.values()][0]).toMatchObject({ processed: true });
  });

  it('re-checks the plan under the lock and retries if it changed meanwhile', async () => {
    const h = makeBootyHarness();
    h.prisma.$transaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
      h.subscription.membershipPlanId = 'fx_plan_other'; // a concurrent plan change committed first
      return fn(h.prisma);
    });
    await expect(h.deliver(RENEWAL())).rejects.toThrow('[fixed-duration-entitlement:SUBSCRIPTION_PLAN_NOT_SYNCED]');
    expect(h.cycles).toHaveLength(1);
  });

    it('replays the member timeline: trial bridge grants nothing, the paid Oct 2 renewal grants once', async () => {
    const h = makeBootyHarness();
    await h.deliver(stripeFixture('dahlia-invoice-paid-booty-trial-bridge'));
    expect(h.payments.size).toBe(0);
    expect(h.cycles).toHaveLength(1);
    await h.deliver(RENEWAL());
    expect(h.payments.size).toBe(1);
    expect(h.cycles.map((c) => c.stripeInvoiceId)).toEqual(['in_fx_booty_initial', 'in_fx_booty_renewal']);
  });

  it('acknowledges the real Aug 20 trial bridge without Payment, cycle, exception or dead letter', async () => {
    const h = makeBootyHarness({ cycles: [] });
    await h.deliver(stripeFixture('dahlia-invoice-paid-booty-trial-bridge'));
    expect(h.payments.size).toBe(0);
    expect(h.cycles).toHaveLength(0);
    expect(h.events.get('evt_fx_booty_trial_bridge_paid')).toMatchObject({ processed: true, lastError: null });
  });

  it('grants a fully discounted exact period but writes no zero-value Payment', async () => {
    const h = makeBootyHarness();
    const event = RENEWAL();
    Object.assign(event.data.object, { amount_paid: 0, amount_due: 0, total: 0 });
    await h.deliver(event);
    expect(h.payments.size).toBe(0);
    expect(h.cycles[1]).toMatchObject({ startsAt: OCT_2, endsAt: NOV_16, creditLimit: 4 });
  });

  it('retries (never skips) a zero-value fixed-duration invoice that arrives before its subscription row', async () => {
    const h = makeBootyHarness();
    h.state.localSubscriptionExists = false;
    const event = RENEWAL();
    Object.assign(event.data.object, { amount_paid: 0, amount_due: 0, total: 0 }); // e.g. a 100% coupon
    await expect(h.deliver(event)).rejects.toThrow('[fixed-duration-entitlement:SUBSCRIPTION_NOT_LOCAL]');
    expect(h.events.get('evt_fx_booty_renewal_paid')).toMatchObject({ processed: false });

    h.state.localSubscriptionExists = true; // customer.subscription.created landed
    await h.deliver(event);
    expect(h.payments.size).toBe(0);
    expect(h.cycles[1]).toMatchObject({ startsAt: OCT_2, endsAt: NOV_16, creditLimit: 4 });
    expect(h.events.get('evt_fx_booty_renewal_paid')).toMatchObject({ processed: true, attemptCount: 2 });
  });

  it('grants nothing for an unpaid invoice', async () => {
    const h = makeBootyHarness();
    const event = RENEWAL();
    Object.assign(event.data.object, { status: 'open' });
    await h.deliver(event);
    expect(h.payments.size).toBe(0);
    expect(h.cycles).toHaveLength(1);
  });

  it('refuses a paid invoice whose only line belongs to another subscription', async () => {
    const h = makeBootyHarness();
    const event = RENEWAL();
    const line = (event.data.object as { lines: { data: Array<{ parent: { subscription_item_details: { subscription: string } } }> } }).lines.data[0];
    line.parent.subscription_item_details.subscription = 'sub_fx_other_membership';
    await expect(h.deliver(event)).rejects.toThrow('[fixed-duration-entitlement:NO_SERVICE_LINE]');
    expect(h.cycles).toHaveLength(1);
  });
});

describe('StripeWebhookService — monthly plans are unchanged', () => {
  it('records a monthly renewal Payment and grants no cycle', async () => {
    const h = makeBootyHarness({ plan: { entitlementDays: null as unknown as number } });
    const monthly = stripeFixture('dahlia-invoice-paid-monthly-renewal');
    // Route the monthly invoice to the harness subscription.
    const invoice = monthly.data.object as { parent: { subscription_details: { subscription: string } } };
    invoice.parent.subscription_details.subscription = 'sub_fx_booty_member';
    await h.deliver(monthly);
    expect(h.payments.size).toBe(1);
    expect([...h.payments.values()][0].amountCents).toBe(60000);
    expect(h.cycles).toHaveLength(1);
    expect(h.subscriptionWrites).toHaveLength(0);
  });

  it('acknowledges a zero-value monthly invoice without Payment or grant', async () => {
    const h = makeBootyHarness({ plan: { entitlementDays: null as unknown as number } });
    const monthly = stripeFixture('dahlia-invoice-paid-monthly-renewal');
    const invoice = monthly.data.object as { parent: { subscription_details: { subscription: string } } };
    invoice.parent.subscription_details.subscription = 'sub_fx_booty_member';
    Object.assign(monthly.data.object, { amount_paid: 0, amount_due: 0, total: 0 });
    await h.deliver(monthly);
    expect(h.payments.size).toBe(0);
    expect(h.cycles).toHaveLength(1);
    expect(h.events.get(monthly.id)).toMatchObject({ processed: true, lastError: null });
  });
});

describe('StripeWebhookService — PaymentIntent enrichment for basil+ invoices', () => {
  it('stores the PaymentIntent resolved from Stripe for a new dahlia Payment', async () => {
    const h = makeBootyHarness();
    await h.deliver(stripeFixture('dahlia-invoice-paid-booty-renewal'));
    expect(h.stripe.findPaidInvoicePaymentIntentId).toHaveBeenCalledWith('in_fx_booty_renewal');
    expect(h.payments.get('in_fx_booty_renewal')!.stripePaymentIntentId).toBe('pi_fx_booty_renewal');
  });

  it('looks the PaymentIntent up only after the Payment and the entitlement are written', async () => {
    const h = makeBootyHarness();
    await h.deliver(stripeFixture('dahlia-invoice-paid-booty-renewal'));
    const lookupOrder = h.stripe.findPaidInvoicePaymentIntentId.mock.invocationCallOrder[0];
    expect(h.prisma.payment.upsert.mock.invocationCallOrder[0]).toBeLessThan(lookupOrder);
    expect(h.prisma.membershipEntitlementCycle.create.mock.invocationCallOrder[0]).toBeLessThan(lookupOrder);
  });

  it('never blocks the Payment or the grant when the lookup fails', async () => {
    const h = makeBootyHarness({ paymentIntentLookup: async () => { throw new Error('stripe timeout'); } });
    await h.deliver(stripeFixture('dahlia-invoice-paid-booty-renewal'));
    expect(h.payments.get('in_fx_booty_renewal')!.stripePaymentIntentId).toBeNull();
    expect(h.cycles).toHaveLength(2);
  });

  it('never steals a PaymentIntent already linked to another Payment row', async () => {
    const h = makeBootyHarness({ paymentIntentLookup: async () => 'pi_already_used' });
    h.payments.set('in_other', { id: 'pay_other', stripeInvoiceId: 'in_other', stripePaymentIntentId: 'pi_already_used' } as StoredPayment);
    await h.deliver(stripeFixture('dahlia-invoice-paid-booty-renewal'));
    expect(h.payments.get('in_fx_booty_renewal')!.stripePaymentIntentId).toBeNull();
  });
});

describe('StripeWebhookService — invoice.payment_failed ordering', () => {
  const FAILED = () => stripeFixture('dahlia-invoice-payment-failed-after-delete');
  function routeToHarness(event: WebhookEvent): WebhookEvent {
    const invoice = event.data.object as { parent: { subscription_details: { subscription: string } } };
    invoice.parent.subscription_details.subscription = 'sub_fx_booty_member';
    return event;
  }

  it('a failure delivered after Stripe cancelled the subscription does not resurrect it', async () => {
    const h = makeBootyHarness({ subscription: { status: SubscriptionStatus.CANCELED } });
    await h.deliver(routeToHarness(FAILED()));
    expect(h.subscription.status).toBe(SubscriptionStatus.CANCELED);
    expect(h.prisma.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING, SubscriptionStatus.PAST_DUE, SubscriptionStatus.PAUSED] } }),
    }));
  });

  it('a legitimate failure on an active subscription still marks it PAST_DUE', async () => {
    const h = makeBootyHarness();
    await h.deliver(routeToHarness(FAILED()));
    expect(h.subscription.status).toBe(SubscriptionStatus.PAST_DUE);
    expect([...h.payments.values()][0]).toMatchObject({ status: PaymentStatus.FAILED });
  });

  it('a failure racing the payment that creates the row first never overwrites it nor demotes', async () => {
    const h = makeBootyHarness();
    const failed = routeToHarness(FAILED());
    const invoiceId = (failed.data.object as { id: string }).id;
    // invoice.paid commits SUCCEEDED between the failure's conditional update and its insert.
    h.prisma.payment.create.mockImplementationOnce(async () => {
      h.payments.set(invoiceId, { id: 'pay_paid', stripeInvoiceId: invoiceId, status: PaymentStatus.SUCCEEDED, amountCents: 150000 } as StoredPayment);
      throw uniqueViolation();
    });
    await h.deliver(failed);
    expect(h.payments.get(invoiceId)).toMatchObject({ status: PaymentStatus.SUCCEEDED });
    expect(h.subscription.status).toBe(SubscriptionStatus.ACTIVE);
  });

    it('a stale failure for an invoice that was already paid changes nothing', async () => {
    const h = makeBootyHarness();
    const failed = routeToHarness(FAILED());
    const invoiceId = (failed.data.object as { id: string }).id;
    h.payments.set(invoiceId, { id: 'pay_paid', stripeInvoiceId: invoiceId, status: PaymentStatus.SUCCEEDED, amountCents: 150000 } as StoredPayment);
    await h.deliver(failed);
    expect(h.payments.get(invoiceId)).toMatchObject({ status: PaymentStatus.SUCCEEDED, amountCents: 150000 });
    expect(h.subscription.status).toBe(SubscriptionStatus.ACTIVE);
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

  // The service writes an existing row with a status-conditional updateMany and a new row with
  // create; both land in `upsertCalls` so assertions read "what was written for this Stripe sub".
  let lastWritten: Record<string, unknown> | null = null;
  const txSubscription = {
    // Default: incoming sub not yet in DB (conflict check enters the CREATE branch)
    findUnique: jest.fn().mockResolvedValue(null),
    findUniqueOrThrow: jest.fn().mockImplementation(async () => lastWritten ?? { id: 'sub-local-1' }),
    // Default: no conflicting ACTIVE row (conflict check finds nothing to conflict with)
    findFirst: jest.fn().mockResolvedValue(null),
    // MM-1: renewable-conflict + scheduled-cash lookups now use findMany.
    findMany: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue({ id: 'sub-local-cash-1', status: 'CANCELED' }),
    updateMany: jest.fn().mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = { id: where.id, ...data };
      upsertCalls.push(row);
      lastWritten = row;
      return { count: 1 };
    }),
    create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: 'sub-local-new', ...data };
      createCalls.push(row);
      upsertCalls.push(row);
      lastWritten = row;
      return row;
    }),
  };

  const prisma = {
    user: { findFirst: jest.fn().mockResolvedValue({ id: 'user_1' }) },
    // Pre-transaction read used by the stale-event guard.
    subscription: { findUnique: jest.fn().mockImplementation((args: unknown) => txSubscription.findUnique(args)) },
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

  const stripeToCash = {
    activateScheduledCashIfDue: jest.fn().mockResolvedValue(null),
  };

  const renewalAudit = { maybeLogExternalRenewalChange: jest.fn().mockResolvedValue('skipped_no_transition') };
  const billingCases = { observe: jest.fn().mockResolvedValue({ outcome: 'created', case: {} }) };
  const stripe = { retrieveSubscription: jest.fn() };
  const service = new StripeWebhookService(
    prisma,
    stripe as unknown as StripeService,
    {} as EnrollmentService,
    subscriptionLifecycle as never,
    stripeToCash as never,
    renewalAudit as never,
    billingCases as never,
  );

  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

  return {
    service: service as unknown as SubscriptionWebhookService,
    subscriptionLifecycle,
    upsertCalls,
    createCalls,
    txSubscription,
    renewalAudit,
    billingCases,
    stripe,
    prisma,
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

    const service = new StripeWebhookService(prisma, stripe, {} as EnrollmentService, {} as never, { activateScheduledCashIfDue: jest.fn().mockResolvedValue(null) } as never, { maybeLogExternalRenewalChange: jest.fn() } as never, { observe: jest.fn().mockResolvedValue({ outcome: 'created', case: {} }) } as never);
    return { service, prisma, stripe, updateManyMock };
  }

  it('persists lastError via updateMany when dispatch throws', async () => {
    const { service, updateManyMock } = makeWebhookHandlerMocks();

    jest.spyOn(service as unknown as DispatchTarget, 'dispatch').mockRejectedValue(
      new Error('DB connection lost'),
    );
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

    jest.spyOn(service as unknown as DispatchTarget, 'dispatch').mockResolvedValue(undefined);

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

    jest.spyOn(service as unknown as DispatchTarget, 'dispatch').mockRejectedValue(
      new Error(longError),
    );
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
  // Still-active relative to the real clock: a hardcoded "future" date (2026-09-14) silently
  // became the past and flipped this case into the expired-cash supersede path.
  const activeCashRow = {
    ...expiredCashRow,
    id: 'local-cash-active',
    currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),  // future
    currentPeriodStart: new Date(Date.now() - 86_400_000),
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
    // A row that does not exist yet is created explicitly; existing rows use a conditional update.
    expect(txSubscription.create).toHaveBeenCalledTimes(1);
    expect(txSubscription.updateMany).not.toHaveBeenCalled();
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
    txSubscription.findMany.mockResolvedValue([{ ...(expiredCashRow), exclusiveGroupKey: null, membershipPlan: { exclusiveGroup: null } }]);

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
        data: expect.objectContaining({
          status: SubscriptionStatus.CANCELED,
          endReason: SubscriptionEndReason.SUPERSEDED_PAYMENT_METHOD,
          supersededBySubscriptionId: 'sub-local-new',
        }),
      }),
    );
    // New Stripe-backed row must be CREATED
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toMatchObject({
      status: SubscriptionStatus.ACTIVE,
      stripeSubscriptionId: activeSub.id,
      membershipPlanId: 'plan-full',
    });
    // Exactly one row was written for the incoming subscription (the explicit create above).
    expect(upsertCalls).toHaveLength(1);
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
    txSubscription.findMany.mockResolvedValue([{ ...({ ...expiredCashRow, cancelAtPeriodEnd: false }), exclusiveGroupKey: null, membershipPlan: { exclusiveGroup: null } }]);

    await service.upsertSubscriptionFromStripe(
      { ...activeSub, metadata: { userId: 'user_1', studioId: 'studio_1' } },
      { userId: 'user_1', studioId: 'studio_1' },
      'customer.subscription.created',
    );

    expect(txSubscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: SubscriptionStatus.CANCELED,
          endReason: SubscriptionEndReason.SUPERSEDED_PAYMENT_METHOD,
        }),
      }),
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
    txSubscription.findMany.mockResolvedValue([{ ...(activeCashRow), exclusiveGroupKey: null, membershipPlan: { exclusiveGroup: null } }]);

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
    txSubscription.findMany.mockResolvedValue([{ ...(stripeBackedRow), exclusiveGroupKey: null, membershipPlan: { exclusiveGroup: null } }]);

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

    // findUnique always runs to capture previous cancelAtPeriodEnd for renewal audit.
    // Conflict gate (findFirst for other renewable rows) is skipped for CANCELED.
    expect(txSubscription.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { stripeSubscriptionId: 'sub_incoming' },
        select: expect.objectContaining({ cancelAtPeriodEnd: true }),
      }),
    );
    expect(txSubscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: SubscriptionStatus.SCHEDULED }),
      }),
    );
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
    txSubscription.findMany.mockResolvedValue([{ ...(expiredCashRow), exclusiveGroupKey: null, membershipPlan: { exclusiveGroup: null } }]);

    await service.upsertSubscriptionFromStripe(
      { ...activeSub, metadata: { userId: 'user_1', studioId: 'studio_1' } },
      { userId: 'user_1', studioId: 'studio_1' },
      'customer.subscription.created',
    );

    // New Stripe-backed row is created first, then the expired CASH row is marked superseded.
    expect(txSubscription.create.mock.invocationCallOrder[0]).toBeLessThan(
      txSubscription.update.mock.invocationCallOrder[0],
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
    txSubscription.findMany.mockResolvedValue([{ ...(expiredCashRow), exclusiveGroupKey: null, membershipPlan: { exclusiveGroup: null } }]);
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
    txSubscription.findMany.mockResolvedValue([{ ...(activeCashRow), exclusiveGroupKey: null, membershipPlan: { exclusiveGroup: null } }]);
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
    txSubscription.findMany.mockResolvedValue([{ ...({
      id: 'local-basic-emilia',
      status: SubscriptionStatus.ACTIVE,
      source: SubscriptionSource.STRIPE,
      stripeSubscriptionId: 'sub_1TqKw5GuUoCXNOREO80x7acx',  // Emilia's Basic
      currentPeriodEnd: new Date('2026-09-06T00:00:00Z'),
      cancelAtPeriodEnd: false,
      membershipPlanId: 'plan-basic',
    }), exclusiveGroupKey: null, membershipPlan: { exclusiveGroup: null } }]);
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
    txSubscription.findMany.mockResolvedValue([{ ...({
      id: 'cmr5e5tl3002hm60r9s2d08cc',  // Carlo's CASH sub
      status: SubscriptionStatus.ACTIVE,
      source: SubscriptionSource.CASH,
      stripeSubscriptionId: null,
      currentPeriodEnd: new Date('2026-08-04T05:59:59Z'),  // expired Aug 4
      currentPeriodStart: new Date('2026-07-03T18:00:00Z'),
      cancelAtPeriodEnd: true,
      membershipPlanId: 'plan-full',
    }), exclusiveGroupKey: null, membershipPlan: { exclusiveGroup: null } }]);

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
        data: expect.objectContaining({
          status: SubscriptionStatus.CANCELED,
          endReason: SubscriptionEndReason.SUPERSEDED_PAYMENT_METHOD,
          supersededBySubscriptionId: 'sub-local-new',
        }),
      }),
    );
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toMatchObject({
      status: SubscriptionStatus.ACTIVE,
      stripeSubscriptionId: 'sub_1U0LZeGuUoCXNOREKzoRfHBa',
    });
  });
});

describe('StripeWebhookService — renewal CAPE audit', () => {
  const baseSub = {
    id: 'sub_stripe_1',
    status: 'active',
    customer: 'cus_test',
    cancel_at_period_end: true,
    cancellation_details: { reason: 'cancellation_requested', feedback: 'unused' },
    metadata: { userId: 'user_1', studioId: 'studio_1', planId: 'plan-full' },
    items: {
      data: [
        {
          price: { id: 'price_full' },
          current_period_start: 1786641551,
          current_period_end: 1789319951,
        },
      ],
    },
  };

  it('Portal-style CAPE false→true calls external renewal audit with null actor inputs', async () => {
    const { service, subscriptionLifecycle, renewalAudit, txSubscription } =
      makeSubscriptionWebhookMocks();
    subscriptionLifecycle.reconcileSubscriptionPlansFromStripe.mockResolvedValue({
      membershipPlanId: 'plan-full',
      pendingMembershipPlanId: null,
    });
    txSubscription.findUnique.mockResolvedValue({
      id: 'sub-local-1',
      cancelAtPeriodEnd: false,
      status: 'ACTIVE',
    });

    await (service as unknown as {
      upsertSubscriptionFromStripe: (
        sub: typeof baseSub,
        md: object,
        type: string,
        ctx: object,
      ) => Promise<void>;
    }).upsertSubscriptionFromStripe(
      baseSub,
      { userId: 'user_1', studioId: 'studio_1' },
      'customer.subscription.updated',
      {
        eventId: 'evt_portal',
        eventType: 'customer.subscription.updated',
        requestId: null,
        idempotencyKey: null,
        receivedAt: new Date('2026-08-13T17:27:05.000Z'),
      },
    );

    expect(renewalAudit.maybeLogExternalRenewalChange).toHaveBeenCalledWith(
      expect.objectContaining({
        previousCancelAtPeriodEnd: false,
        newCancelAtPeriodEnd: true,
        stripeEventId: 'evt_portal',
        stripeRequestId: null,
        stripeIdempotencyKey: null,
        cancellationFeedback: 'unused',
      }),
    );
  });

  it('does not call external audit when CAPE unchanged', async () => {
    const { service, subscriptionLifecycle, renewalAudit, txSubscription } =
      makeSubscriptionWebhookMocks();
    subscriptionLifecycle.reconcileSubscriptionPlansFromStripe.mockResolvedValue({
      membershipPlanId: 'plan-full',
      pendingMembershipPlanId: null,
    });
    txSubscription.findUnique.mockResolvedValue({
      id: 'sub-local-1',
      cancelAtPeriodEnd: true,
      status: 'ACTIVE',
    });

    await (service as unknown as {
      upsertSubscriptionFromStripe: (
        sub: typeof baseSub,
        md: object,
        type: string,
        ctx: object,
      ) => Promise<void>;
    }).upsertSubscriptionFromStripe(
      { ...baseSub, cancel_at_period_end: true },
      { userId: 'user_1', studioId: 'studio_1' },
      'customer.subscription.updated',
      {
        eventId: 'evt_noop',
        eventType: 'customer.subscription.updated',
        requestId: null,
        idempotencyKey: null,
        receivedAt: new Date(),
      },
    );

    expect(renewalAudit.maybeLogExternalRenewalChange).not.toHaveBeenCalled();
  });
});
