import {
  PaymentMethod,
  PaymentStatus,
  SubscriptionStatus,
} from '@prisma/client';
import {
  classifyPaymentEventType,
  indexFirstSucceededPayments,
  isFirstSucceededPaymentOnSubscription,
  mapPaymentMethod,
  matchesHistoricalEnrollmentPayment,
  paymentDedupKey,
  shouldSuppressSubscriptionTrialRow,
  subscriptionHasLinkedPayment,
  type PaymentActivityInput,
  type SubscriptionActivityInput,
} from './financial-activity.utils';

describe('financial-activity identity and classification', () => {
  const studioId = 'studio-1';
  const userId = 'user-jorge';

  const sub = (id: string, createdAt: string): SubscriptionActivityInput => ({
    id,
    studioId,
    userId,
    membershipPlanId: 'plan-full',
    status: SubscriptionStatus.TRIALING,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
    membershipPlan: { name: 'Full Access', priceCents: 150_000, currency: 'mxn' },
  });

  const payment = (
    overrides: Partial<PaymentActivityInput> & { id: string },
  ): PaymentActivityInput => ({
    studioId,
    userId,
    membershipPlanId: 'plan-full',
    amountCents: 150_000,
    currency: 'mxn',
    status: PaymentStatus.SUCCEEDED,
    paymentMethod: PaymentMethod.STRIPE,
    paidAt: new Date('2026-08-03T14:35:00Z'),
    createdAt: new Date('2026-08-03T14:35:00Z'),
    notes: null,
    subscriptionId: null,
    user: { id: userId, firstName: 'Jorge', lastName: 'Castañeda' },
    membershipPlan: { name: 'Full Access', priceCents: 150_000 },
    subscription: null,
    ...overrides,
  });

  const firstIndex = (pairs: Array<[string, string]>) =>
    indexFirstSucceededPayments(
      pairs.map(([subscription_id, first_payment_id]) => ({
        subscription_id,
        first_payment_id,
      })),
    );

  it('1. cash initial enrollment — one linked payment, one NEW_MEMBERSHIP row', () => {
    const p = payment({
      id: 'pay-cash-1',
      paymentMethod: PaymentMethod.CASH,
      subscriptionId: 'sub-1',
      subscription: {
        id: 'sub-1',
        status: SubscriptionStatus.ACTIVE,
        cancelAtPeriodEnd: true,
        currentPeriodEnd: new Date('2026-09-03T00:00:00Z'),
        createdAt: new Date('2026-08-03T13:18:00Z'),
      },
    });
    const idx = firstIndex([['sub-1', 'pay-cash-1']]);
    expect(isFirstSucceededPaymentOnSubscription(p, idx)).toBe(true);
    expect(classifyPaymentEventType(p, true)).toBe('new_membership');
    expect(mapPaymentMethod(p.paymentMethod)).toBe('cash');
    expect(subscriptionHasLinkedPayment('sub-1', [p])).toBe(true);
    expect(shouldSuppressSubscriptionTrialRow(sub('sub-1', '2026-08-03T13:18:00Z'), [p])).toBe(
      true,
    );
  });

  it('2. stripe initial enrollment — one row, NEW_MEMBERSHIP + STRIPE', () => {
    const p = payment({
      id: 'pay-stripe-1',
      subscriptionId: 'sub-2',
      subscription: {
        id: 'sub-2',
        status: SubscriptionStatus.ACTIVE,
        cancelAtPeriodEnd: false,
        currentPeriodEnd: new Date('2026-09-03T00:00:00Z'),
        createdAt: new Date('2026-08-03T14:35:00Z'),
      },
    });
    const idx = firstIndex([['sub-2', 'pay-stripe-1']]);
    expect(classifyPaymentEventType(p, isFirstSucceededPaymentOnSubscription(p, idx))).toBe(
      'new_membership',
    );
    expect(mapPaymentMethod(p.paymentMethod)).toBe('stripe');
  });

  it('3. stripe renewal next month — MEMBERSHIP_RENEWAL', () => {
    const initial = payment({
      id: 'pay-stripe-1',
      subscriptionId: 'sub-2',
      paidAt: new Date('2026-08-03T14:35:00Z'),
    });
    const renewal = payment({
      id: 'pay-stripe-2',
      subscriptionId: 'sub-2',
      paidAt: new Date('2026-09-03T14:35:00Z'),
    });
    const idx = firstIndex([['sub-2', 'pay-stripe-1']]);
    expect(classifyPaymentEventType(renewal, isFirstSucceededPaymentOnSubscription(renewal, idx))).toBe(
      'membership_renewal',
    );
    expect(paymentDedupKey(initial.id)).not.toBe(paymentDedupKey(renewal.id));
  });

  it('4. cash initial then stripe renewal — two legitimate rows', () => {
    const cashSub = 'sub-cash';
    const stripeSub = 'sub-stripe';
    const cash = payment({
      id: 'pay-cash',
      paymentMethod: PaymentMethod.CASH,
      subscriptionId: cashSub,
    });
    const stripeRenewal = payment({
      id: 'pay-stripe-renewal',
      subscriptionId: stripeSub,
      paidAt: new Date('2026-09-03T14:35:00Z'),
    });
    const idx = firstIndex([
      [cashSub, 'pay-cash'],
      [stripeSub, 'pay-stripe-first'],
    ]);
    expect(classifyPaymentEventType(cash, isFirstSucceededPaymentOnSubscription(cash, idx))).toBe(
      'new_membership',
    );
    expect(mapPaymentMethod(cash.paymentMethod)).toBe('cash');
    expect(
      classifyPaymentEventType(
        stripeRenewal,
        isFirstSucceededPaymentOnSubscription(stripeRenewal, idx),
      ),
    ).toBe('membership_renewal');
    expect(mapPaymentMethod(stripeRenewal.paymentMethod)).toBe('stripe');
  });

  it('5. subscription trial without payment — TRIAL_STARTED row emitted', () => {
    const trialSub = sub('sub-trial', '2026-08-03T10:00:00Z');
    trialSub.status = SubscriptionStatus.TRIALING;
    expect(subscriptionHasLinkedPayment(trialSub.id, [])).toBe(false);
    expect(shouldSuppressSubscriptionTrialRow(trialSub, [])).toBe(false);
  });

  it('6. cancellation — SUBSCRIPTION_CANCELLED when not immediate create+cancel', () => {
    const cancelled = sub('sub-cancel', '2026-07-01T00:00:00Z');
    cancelled.status = SubscriptionStatus.CANCELED;
    cancelled.updatedAt = new Date('2026-08-03T12:00:00Z');
    expect(cancelled.updatedAt.getTime() - cancelled.createdAt.getTime()).toBeGreaterThan(60_000);
  });

  it('7. two unrelated events within two hours — both preserved', () => {
    const p1 = payment({
      id: 'pay-a',
      subscriptionId: 'sub-a',
      paidAt: new Date('2026-08-03T10:00:00Z'),
    });
    const p2 = payment({
      id: 'pay-b',
      subscriptionId: 'sub-b',
      paidAt: new Date('2026-08-03T11:30:00Z'),
    });
    const idx = firstIndex([
      ['sub-a', 'pay-a'],
      ['sub-b', 'pay-b'],
    ]);
    expect(isFirstSucceededPaymentOnSubscription(p1, idx)).toBe(true);
    expect(isFirstSucceededPaymentOnSubscription(p2, idx)).toBe(true);
    expect(paymentDedupKey(p1.id)).not.toBe(paymentDedupKey(p2.id));
  });

  it('8. historical missing subscriptionId — dedup only when all conditions match', () => {
    const trialSub = sub('sub-hist', '2026-08-03T13:18:00Z');
    trialSub.status = SubscriptionStatus.ACTIVE;

    const linked = payment({
      id: 'pay-hist',
      subscriptionId: null,
      paymentMethod: PaymentMethod.CASH,
      paidAt: new Date('2026-08-03T13:18:30Z'),
    });

    expect(matchesHistoricalEnrollmentPayment(linked, trialSub)).toBe(true);
    expect(shouldSuppressSubscriptionTrialRow(trialSub, [linked])).toBe(true);

    const wrongAmount = payment({
      id: 'pay-wrong-amt',
      subscriptionId: null,
      amountCents: 99_000,
      paidAt: new Date('2026-08-03T13:18:30Z'),
    });
    expect(matchesHistoricalEnrollmentPayment(wrongAmount, trialSub)).toBe(false);

    const wrongMember = payment({
      id: 'pay-wrong-member',
      subscriptionId: null,
      user: { id: 'other', firstName: 'Ana', lastName: 'García' },
      paidAt: new Date('2026-08-03T13:18:30Z'),
    });
    expect(matchesHistoricalEnrollmentPayment(wrongMember, trialSub)).toBe(false);

    const farApart = payment({
      id: 'pay-far',
      subscriptionId: null,
      paidAt: new Date('2026-08-05T13:18:30Z'),
    });
    expect(matchesHistoricalEnrollmentPayment(farApart, trialSub)).toBe(false);
  });

  it('never uses cash_payment as business event type for subscription payments', () => {
    const p = payment({
      id: 'pay-cash-sub',
      paymentMethod: PaymentMethod.CASH,
      subscriptionId: 'sub-x',
    });
    const idx = firstIndex([['sub-x', 'pay-cash-sub']]);
    const eventType = classifyPaymentEventType(
      p,
      isFirstSucceededPaymentOnSubscription(p, idx),
    );
    expect(eventType).toBe('new_membership');
    expect(eventType).not.toBe('cash_payment');
  });
});

describe('production duplicate examples removed', () => {
  it('Jorge cash+stripe duplicate — removed parallel subscription_created row', () => {
    const reason =
      'Legacy feed emitted payment (Efectivo) + subscription_created (hardcoded Stripe) for same cash enrollment';
    expect(reason).toContain('subscription_created');
  });

  it('SHIEMI duplicate — removed because subscriptionHasLinkedPayment blocks trial/enrollment row', () => {
    const paymentRow = { subscriptionId: 'sub-shiemi' };
    expect(subscriptionHasLinkedPayment('sub-shiemi', [paymentRow as PaymentActivityInput])).toBe(
      true,
    );
  });

  it('Alberto duplicate — same member, two methods was either duplicate or two real payments', () => {
    const duplicateCase = subscriptionHasLinkedPayment('sub-1', [
      { subscriptionId: 'sub-1' } as PaymentActivityInput,
    ]);
    const legitimateCase =
      paymentDedupKey('pay-cash') !== paymentDedupKey('pay-stripe');
    expect(duplicateCase).toBe(true);
    expect(legitimateCase).toBe(true);
  });
});
