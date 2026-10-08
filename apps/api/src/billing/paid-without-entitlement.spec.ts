import { findPaidWithoutEntitlement, loadPaidWithoutEntitlement, type CycleRef, type PaidPaymentRef } from './paid-without-entitlement';

const at = (iso: string) => new Date(iso);
const bootySub = { id: 'sub_booty', userId: 'user_member_a', membershipPlanId: 'plan_booty' };
const backfill: CycleRef = { id: 'backfill_sub_booty', subscriptionId: 'sub_booty', startsAt: at('2026-08-18T16:54:40.000Z'), stripeInvoiceId: 'in_aug18' };

function payment(overrides: Partial<PaidPaymentRef>): PaidPaymentRef {
  return {
    id: 'pay_oct2', userId: 'user_member_a', subscriptionId: 'sub_booty', membershipPlanId: 'plan_booty',
    stripeInvoiceId: 'in_oct2', amountCents: 80000, currency: 'mxn',
    paidAt: at('2026-10-02T17:55:59.000Z'), createdAt: at('2026-10-02T17:56:06.000Z'),
    ...overrides,
  };
}

function evaluate(payments: PaidPaymentRef[], cycles: CycleRef[] = [backfill]) {
  return findPaidWithoutEntitlement({
    payments, fixedDurationSubscriptions: [bootySub], fixedDurationPlanIds: ['plan_booty'], cycles,
  });
}

describe('findPaidWithoutEntitlement', () => {
  it('flags the incident state: a paid renewal whose invoice has no cycle', () => {
    expect(evaluate([payment({})])).toEqual([{
      paymentId: 'pay_oct2', userId: 'user_member_a', subscriptionId: 'sub_booty', stripeInvoiceId: 'in_oct2',
      amountCents: 80000, currency: 'mxn', paidAt: at('2026-10-02T17:55:59.000Z'),
    }]);
  });

  it('is clear once the invoice has its cycle', () => {
    const cycle = { id: 'c2', subscriptionId: 'sub_booty', startsAt: at('2026-10-02T16:54:40.000Z'), stripeInvoiceId: 'in_oct2' };
    expect(evaluate([payment({})], [backfill, cycle])).toEqual([]);
  });

  it('ignores the initial payment linked to its migration backfill cycle', () => {
    expect(evaluate([payment({ id: 'pay_aug18', stripeInvoiceId: 'in_aug18', paidAt: at('2026-08-18T16:54:40.000Z') })])).toEqual([]);
  });

  it('ignores a legacy backfill cycle that lost its invoice link when it starts with the payment', () => {
    const unlinkedBackfill = { ...backfill, stripeInvoiceId: null };
    expect(evaluate([payment({ id: 'pay_aug18', stripeInvoiceId: 'in_aug18', paidAt: at('2026-08-18T16:54:45.000Z') })], [unlinkedBackfill])).toEqual([]);
  });

  it('attributes an unlinked payment by member and plan', () => {
    expect(evaluate([payment({ subscriptionId: null })])).toMatchObject([{ subscriptionId: 'sub_booty' }]);
  });

  it('ignores payments made before the entitlement ledger existed', () => {
    expect(evaluate([payment({ id: 'pay_jul', stripeInvoiceId: 'in_jul', paidAt: at('2026-07-18T16:54:40.000Z') })])).toEqual([]);
  });

  it('honours an operator acknowledgement (e.g. a refunded renewal that needs no cycle)', () => {
    expect(findPaidWithoutEntitlement({
      payments: [payment({})], fixedDurationSubscriptions: [bootySub], fixedDurationPlanIds: ['plan_booty'], cycles: [backfill],
      acknowledgedInvoiceIds: ['in_oct2'],
    })).toEqual([]);
  });

    it('ignores zero-value, non-fixed and other-membership payments', () => {
    expect(evaluate([
      payment({ amountCents: 0 }),
      payment({ id: 'p2', subscriptionId: 'sub_full_access', stripeInvoiceId: 'in_full' }),
      payment({ id: 'p3', subscriptionId: null, membershipPlanId: 'plan_full', stripeInvoiceId: 'in_full2' }),
    ])).toEqual([]);
  });
});

describe('loadPaidWithoutEntitlement', () => {
  it('issues reads only and short-circuits when the studio has no fixed-duration plan', async () => {
    const db = {
      membershipPlan: { findMany: jest.fn().mockResolvedValue([]) },
      subscription: { findMany: jest.fn() },
      payment: { findMany: jest.fn() },
      membershipEntitlementCycle: { findMany: jest.fn() },
    };
    await expect(loadPaidWithoutEntitlement(db as never, { studioId: 's1' })).resolves.toEqual([]);
    expect(db.subscription.findMany).not.toHaveBeenCalled();
  });

  it('loads one member’s fixed-duration payments and cycles and evaluates them', async () => {
    const db = {
      membershipPlan: { findMany: jest.fn().mockResolvedValue([{ id: 'plan_booty' }]) },
      subscription: { findMany: jest.fn().mockResolvedValue([bootySub]) },
      payment: { findMany: jest.fn().mockResolvedValue([payment({})]) },
      membershipEntitlementCycle: { findMany: jest.fn().mockResolvedValue([backfill]) },
      stripeWebhookEvent: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const findings = await loadPaidWithoutEntitlement(db as never, { studioId: 's1', userId: 'user_member_a' });
    expect(findings).toHaveLength(1);
    expect(db.payment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ studioId: 's1', userId: 'user_member_a', status: 'SUCCEEDED', paymentMethod: 'STRIPE' }),
    }));
  });
});

describe('loadPaidWithoutEntitlement — acknowledgement', () => {
  it('drops an invoice whose stored invoice.paid event an operator resolved', async () => {
    const db = {
      membershipPlan: { findMany: jest.fn().mockResolvedValue([{ id: 'plan_booty' }]) },
      subscription: { findMany: jest.fn().mockResolvedValue([bootySub]) },
      payment: { findMany: jest.fn().mockResolvedValue([payment({})]) },
      membershipEntitlementCycle: { findMany: jest.fn().mockResolvedValue([backfill]) },
      stripeWebhookEvent: { findFirst: jest.fn().mockResolvedValue({ id: 'evt_row' }) },
    };
    await expect(loadPaidWithoutEntitlement(db as never, { studioId: 's1' })).resolves.toEqual([]);
    expect(db.stripeWebhookEvent.findFirst).toHaveBeenCalledWith({
      where: { eventType: 'invoice.paid', resolvedAt: { not: null }, payload: { path: ['data', 'object', 'id'], equals: 'in_oct2' } },
      select: { id: true }, // never the payload
    });
  });
});
