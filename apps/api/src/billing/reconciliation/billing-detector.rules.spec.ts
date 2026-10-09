import { SubscriptionEndReason, SubscriptionStatus } from '@prisma/client';
import {
  detectCancellationReasonMismatch,
  detectIdentityMismatches,
  detectLocalCanceledStripeAlive,
  detectMonthlyPaidWithoutEntitlement,
  detectOpenInvoicesOnEndedSubscriptions,
  detectOverlappingCycles,
  detectRepeatedPaymentFailures,
  detectStalePeriods,
  detectStripeCanceledLocalAlive,
  detectWebhookProblems,
  stripeCustomerCoverage,
  type LocalSubscriptionSnapshot,
  type MemberSnapshot,
  type PaymentSnapshot,
  type RulesContext,
  type StripeSubscriptionSnapshot,
} from './billing-detector.rules';

const NOW = new Date('2026-10-09T07:00:00.000Z');
const DAY = 86_400_000;
const ctx: RulesContext = { studioId: 'studio_1', now: NOW, timeZone: 'America/Mexico_City' };

function local(overrides: Partial<LocalSubscriptionSnapshot> = {}): LocalSubscriptionSnapshot {
  return {
    id: 'local_1', userId: 'user_1', membershipPlanId: 'plan_full', planName: 'Full Access', exclusiveGroupKey: 'CORE', isFixedDuration: false,
    status: SubscriptionStatus.ACTIVE, source: 'STRIPE', stripeSubscriptionId: 'sub_1', endReason: null, supersededBySubscriptionId: null,
    cancelAtPeriodEnd: false, currentPeriodStart: new Date(NOW.getTime() - 10 * DAY), currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY),
    entitlementEndsAt: null, updatedAt: new Date(NOW.getTime() - 10 * DAY), ...overrides,
  };
}

function stripe(overrides: Partial<StripeSubscriptionSnapshot> = {}): StripeSubscriptionSnapshot {
  return {
    id: 'sub_1', customerId: 'cus_1', status: 'active', cancelAtPeriodEnd: false, canceledAt: null, cancellationReason: null,
    currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY), metadataStudioId: 'studio_1', metadataUserId: 'user_1', metadataPlanId: 'plan_full',
    priceId: 'price_full', latestInvoiceId: 'in_1', ...overrides,
  };
}

const member: MemberSnapshot = { userId: 'user_1', stripeCustomerId: 'cus_1', customerMissingInStripe: false };
const byId = (...subs: StripeSubscriptionSnapshot[]) => new Map(subs.map((s) => [s.id, s]));
const membersById = new Map([[member.userId, member]]);

describe('detector rules — Stripe canceled / local alive', () => {
  it('flags a renewable local row whose Stripe subscription ended, and one Stripe no longer returns', () => {
    const ended = detectStripeCanceledLocalAlive(ctx, [local({ status: SubscriptionStatus.PAST_DUE })], byId(stripe({ status: 'canceled', canceledAt: new Date(NOW.getTime() - 11 * DAY), cancellationReason: 'payment_failed' })), membersById);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ category: 'STRIPE_CANCELED_LOCAL_ALIVE', severity: 'HIGH', reasonCode: 'STRIPE_CANCELED', issueRef: 'local_1' });
    const missing = detectStripeCanceledLocalAlive(ctx, [local()], byId(), membersById);
    expect(missing[0]?.reasonCode).toBe('STRIPE_SUBSCRIPTION_NOT_FOUND');
  });

  it('never flags cash rows, already-canceled rows, scheduled cancellations, trials or members whose Stripe customer is missing', () => {
    expect(detectStripeCanceledLocalAlive(ctx, [local({ source: 'CASH', stripeSubscriptionId: null })], byId(), membersById)).toHaveLength(0);
    expect(detectStripeCanceledLocalAlive(ctx, [local({ status: SubscriptionStatus.CANCELED })], byId(), membersById)).toHaveLength(0);
    expect(detectStripeCanceledLocalAlive(ctx, [local({ cancelAtPeriodEnd: true })], byId(stripe({ cancelAtPeriodEnd: true })), membersById)).toHaveLength(0);
    expect(detectStripeCanceledLocalAlive(ctx, [local({ status: SubscriptionStatus.TRIALING })], byId(stripe({ status: 'trialing' })), membersById)).toHaveLength(0);
    const missingCustomer = new Map([[member.userId, { ...member, customerMissingInStripe: true }]]);
    expect(detectStripeCanceledLocalAlive(ctx, [local()], byId(), missingCustomer)).toHaveLength(0);
  });
});

describe('detector rules — local canceled / Stripe alive', () => {
  it('flags a GymOS-canceled row Stripe keeps billing', () => {
    const issues = detectLocalCanceledStripeAlive(ctx, [local({ status: SubscriptionStatus.CANCELED, endReason: SubscriptionEndReason.STAFF_CANCELLED })], byId(stripe()));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ category: 'LOCAL_CANCELED_STRIPE_ALIVE', severity: 'HIGH', subscriptionId: 'local_1' });
  });

  it('gives a Stripe→cash period-end handoff a day before calling it drift', () => {
    const endedYesterday = new Date(NOW.getTime() - 2 * 3_600_000);
    const row = local({ status: SubscriptionStatus.CANCELED, endReason: SubscriptionEndReason.SUPERSEDED_PAYMENT_METHOD });
    expect(detectLocalCanceledStripeAlive(ctx, [row], byId(stripe({ cancelAtPeriodEnd: true, currentPeriodEnd: endedYesterday })))).toHaveLength(0);
    const endedTwoDaysAgo = new Date(NOW.getTime() - 2 * DAY);
    expect(detectLocalCanceledStripeAlive(ctx, [row], byId(stripe({ cancelAtPeriodEnd: true, currentPeriodEnd: endedTwoDaysAgo })))).toHaveLength(1);
  });

  it('ignores Stripe subscriptions that are themselves over', () => {
    expect(detectLocalCanceledStripeAlive(ctx, [local({ status: SubscriptionStatus.CANCELED })], byId(stripe({ status: 'canceled' })))).toHaveLength(0);
  });
});

describe('detector rules — identity', () => {
  const groups = new Map([['plan_full', 'CORE'], ['plan_booty', null]]);

  it('reports a Stripe orphan, a duplicate in the same family, and a missing customer (LOW)', () => {
    const orphan = stripe({ id: 'sub_orphan' });
    const issues = detectIdentityMismatches(ctx, [local()], [stripe(), orphan], [member], groups);
    expect(issues.map((i) => i.reasonCode).sort()).toEqual(['DUPLICATE_RENEWABLE', 'STRIPE_ORPHAN']);
    const missing = detectIdentityMismatches(ctx, [local()], [], [{ ...member, customerMissingInStripe: true }], groups);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ reasonCode: 'STRIPE_CUSTOMER_NOT_FOUND', severity: 'LOW' });
  });

  it('a key for the wrong Stripe account (every card-billed member "missing") marks the Stripe phase incomplete; one deleted customer does not', () => {
    const billed = (userId: string) => local({ id: `local_${userId}`, userId });
    const m = (userId: string, customerMissingInStripe: boolean): MemberSnapshot => ({ userId, stripeCustomerId: `cus_${userId}`, customerMissingInStripe });
    // Wrong account/mode: nobody is recognised.
    expect(stripeCustomerCoverage([m('a', true), m('b', true), m('c', true)], [billed('a'), billed('b'), billed('c')])).toEqual({ billedByCard: 3, missingInStripe: 3, misconfigured: true });
    // One legitimately deleted customer among many: a LOW identity case, not an incomplete run.
    expect(stripeCustomerCoverage([m('a', true), m('b', false), m('c', false)], [billed('a'), billed('b'), billed('c')]).misconfigured).toBe(false);
    // A single-member studio with a missing customer (the demo seed) stays complete.
    expect(stripeCustomerCoverage([m('a', true)], [billed('a')])).toEqual({ billedByCard: 1, missingInStripe: 1, misconfigured: false });
    // Members without a renewable card membership (cash, canceled) do not count either way.
    expect(stripeCustomerCoverage([m('a', true), m('b', true)], [local({ userId: 'a', source: 'CASH', stripeSubscriptionId: null }), local({ userId: 'b', status: SubscriptionStatus.CANCELED })]).misconfigured).toBe(false);
  });

  it('does not treat compatible multi-membership siblings as duplicates', () => {
    const booty = stripe({ id: 'sub_booty', metadataPlanId: 'plan_booty', priceId: 'price_booty' });
    const locals = [local(), local({ id: 'local_2', membershipPlanId: 'plan_booty', planName: 'Booty Lab', exclusiveGroupKey: null, stripeSubscriptionId: 'sub_booty', isFixedDuration: true })];
    expect(detectIdentityMismatches(ctx, locals, [stripe(), booty], [member], groups)).toHaveLength(0);
  });

  it('ignores another tenant\'s subscriptions on a shared Stripe customer', () => {
    const other = stripe({ id: 'sub_other', metadataStudioId: 'studio_2' });
    expect(detectIdentityMismatches(ctx, [local()], [stripe(), other], [member], groups)).toHaveLength(0);
  });
});

describe('detector rules — paid without entitlement / stale periods (monthly)', () => {
  const ledger = new Date('2026-08-20T00:00:00.000Z');
  function payment(overrides: Partial<PaymentSnapshot> = {}): PaymentSnapshot {
    return { id: 'pay_1', userId: 'user_1', subscriptionId: 'local_1', membershipPlanId: 'plan_full', stripeInvoiceId: 'in_late', amountCents: 150000, currency: 'mxn', status: 'SUCCEEDED', paidAt: new Date(NOW.getTime() - 1 * DAY), createdAt: new Date(NOW.getTime() - 1 * DAY), ...overrides };
  }

  it('a payment after a canceled monthly row ended is CRITICAL; a payment made while it was live is not', () => {
    const canceled = local({ status: SubscriptionStatus.CANCELED, endReason: SubscriptionEndReason.PAYMENT_FAILED, updatedAt: new Date(NOW.getTime() - 5 * DAY), currentPeriodEnd: new Date(NOW.getTime() - 3 * DAY) });
    const late = detectMonthlyPaidWithoutEntitlement(ctx, [payment()], [canceled], { ledgerStartedAt: ledger });
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ category: 'PAID_WITHOUT_ENTITLEMENT', severity: 'CRITICAL', reasonCode: 'SUBSCRIPTION_ENDED', issueRef: 'in_late' });
    const earlier = payment({ paidAt: new Date(NOW.getTime() - 40 * DAY), createdAt: new Date(NOW.getTime() - 40 * DAY) });
    expect(detectMonthlyPaidWithoutEntitlement(ctx, [earlier], [canceled], { ledgerStartedAt: ledger })).toHaveLength(0);
  });

  it('the stored Stripe deletion time, not updatedAt, decides "paid after the end" (a later staff write cannot hide the case)', () => {
    // Row touched again yesterday (updatedAt moved), but Stripe ended it 20 days ago; paid 10 days ago → late.
    const canceled = local({ status: SubscriptionStatus.CANCELED, endReason: SubscriptionEndReason.PAYMENT_FAILED, updatedAt: new Date(NOW.getTime() - 1 * DAY), currentPeriodEnd: new Date(NOW.getTime() + 5 * DAY) });
    const paid = payment({ paidAt: new Date(NOW.getTime() - 10 * DAY), createdAt: new Date(NOW.getTime() - 10 * DAY) });
    expect(detectMonthlyPaidWithoutEntitlement(ctx, [paid], [canceled], { ledgerStartedAt: ledger })).toHaveLength(0);
    const endedAtByStripeSubscription = new Map([['sub_1', new Date(NOW.getTime() - 20 * DAY)]]);
    expect(detectMonthlyPaidWithoutEntitlement(ctx, [paid], [canceled], { ledgerStartedAt: ledger, endedAtByStripeSubscription })).toHaveLength(1);
  });

  it('an unattributed payment is flagged only after the grace period and only when the member has no card membership row at all', () => {
    const fresh = payment({ subscriptionId: null, paidAt: new Date(NOW.getTime() - 60_000), createdAt: new Date(NOW.getTime() - 60_000) });
    expect(detectMonthlyPaidWithoutEntitlement(ctx, [fresh], [], { ledgerStartedAt: ledger })).toHaveLength(0);
    const old = payment({ subscriptionId: null });
    expect(detectMonthlyPaidWithoutEntitlement(ctx, [old], [local({ status: SubscriptionStatus.CANCELED })], { ledgerStartedAt: ledger })).toHaveLength(0);
    // Production shape: the first invoice was billed under "Pro", the same Stripe subscription later
    // moved to "Basic" — the row exists under another plan, so this is NOT paid-without-access.
    expect(detectMonthlyPaidWithoutEntitlement(ctx, [old], [local({ membershipPlanId: 'plan_basic', planName: 'Basic Access' })], { ledgerStartedAt: ledger })).toHaveLength(0);
    expect(detectMonthlyPaidWithoutEntitlement(ctx, [old], [local({ source: 'CASH', stripeSubscriptionId: null })], { ledgerStartedAt: ledger })[0]?.reasonCode).toBe('NO_LOCAL_SUBSCRIPTION');
    expect(detectMonthlyPaidWithoutEntitlement(ctx, [old], [], { ledgerStartedAt: ledger })[0]?.reasonCode).toBe('NO_LOCAL_SUBSCRIPTION');
  });

  it('a renewal payment newer than the local period end means the period never advanced (HIGH)', () => {
    const stale = local({ currentPeriodEnd: new Date(NOW.getTime() - 5 * DAY) });
    const issues = detectMonthlyPaidWithoutEntitlement(ctx, [payment()], [stale], { ledgerStartedAt: ledger });
    expect(issues[0]).toMatchObject({ category: 'STALE_RENEWAL_PERIOD', severity: 'HIGH', reasonCode: 'PERIOD_NOT_ADVANCED_AFTER_PAYMENT' });
  });

  it('ignores fixed-duration rows (covered by the cycle ledger) and pre-ledger history', () => {
    expect(detectMonthlyPaidWithoutEntitlement(ctx, [payment()], [local({ status: SubscriptionStatus.CANCELED, isFixedDuration: true })], { ledgerStartedAt: ledger })).toHaveLength(0);
    const ancient = payment({ paidAt: new Date('2026-07-01T00:00:00Z'), createdAt: new Date('2026-07-01T00:00:00Z') });
    expect(detectMonthlyPaidWithoutEntitlement(ctx, [ancient], [local({ status: SubscriptionStatus.CANCELED, updatedAt: new Date('2026-06-01T00:00:00Z') })], { ledgerStartedAt: ledger })).toHaveLength(0);
  });

  it('stale period vs Stripe needs more than 36h of lag', () => {
    expect(detectStalePeriods(ctx, [local()], byId(stripe({ currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY + 3_600_000) })))).toHaveLength(0);
    const lagging = local({ currentPeriodEnd: new Date(NOW.getTime() - 10 * DAY) });
    expect(detectStalePeriods(ctx, [lagging], byId(stripe()))[0]).toMatchObject({ category: 'STALE_RENEWAL_PERIOD', reasonCode: 'STRIPE_PERIOD_AHEAD', severity: 'MEDIUM' });
  });
});

describe('detector rules — cycles, reasons, invoices, failures, webhooks', () => {
  it('flags overlapping cycles across two rows of the same plan, not consecutive ones', () => {
    const a = { id: 'c1', subscriptionId: 's1', userId: 'u1', membershipPlanId: 'p1', startsAt: new Date('2026-09-01'), endsAt: new Date('2026-10-16'), stripeInvoiceId: 'in_a' };
    const b = { id: 'c2', subscriptionId: 's2', userId: 'u1', membershipPlanId: 'p1', startsAt: new Date('2026-10-10'), endsAt: new Date('2026-11-24'), stripeInvoiceId: 'in_b' };
    const c = { id: 'c3', subscriptionId: 's2', userId: 'u1', membershipPlanId: 'p1', startsAt: new Date('2026-11-24'), endsAt: new Date('2027-01-08'), stripeInvoiceId: 'in_c' };
    const issues = detectOverlappingCycles(ctx, [a, b, c]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ reasonCode: 'CROSS_SUBSCRIPTION', severity: 'MEDIUM' });
  });

  it('reports a MEMBER_CANCELLED row Stripe actually ended for non-payment (LOW), and nothing for requested cancellations or corrected rows', () => {
    const deletion = { stripeEventId: 'evt_del', stripeSubscriptionId: 'sub_1', status: 'canceled', cancellationReason: 'payment_failed', createdAt: new Date(NOW.getTime() - 11 * DAY), endedAt: new Date(NOW.getTime() - 11 * DAY) };
    const mislabeled = local({ status: SubscriptionStatus.CANCELED, endReason: SubscriptionEndReason.MEMBER_CANCELLED });
    expect(detectCancellationReasonMismatch(ctx, [mislabeled], [deletion])[0]).toMatchObject({ category: 'CANCELLATION_REASON_MISMATCH', severity: 'LOW', reasonCode: 'EXPECTED_PAYMENT_FAILED' });
    expect(detectCancellationReasonMismatch(ctx, [local({ status: SubscriptionStatus.CANCELED, endReason: SubscriptionEndReason.PAYMENT_FAILED })], [deletion])).toHaveLength(0);
    expect(detectCancellationReasonMismatch(ctx, [mislabeled], [{ ...deletion, cancellationReason: 'cancellation_requested' }])).toHaveLength(0);
    expect(detectCancellationReasonMismatch(ctx, [local({ status: SubscriptionStatus.CANCELED, endReason: SubscriptionEndReason.SUPERSEDED_PAYMENT_METHOD })], [deletion])).toHaveLength(0);
  });

  it('flags an open invoice only when its subscription ended', () => {
    const invoice = { id: 'in_open', customerId: 'cus_1', stripeSubscriptionId: 'sub_1', amountRemainingCents: 150000, currency: 'mxn', createdAt: new Date(NOW.getTime() - 20 * DAY), attemptCount: 9, nextPaymentAttempt: null, autoAdvance: false };
    expect(detectOpenInvoicesOnEndedSubscriptions(ctx, [invoice], byId(stripe()), [local()])).toHaveLength(0);
    const flagged = detectOpenInvoicesOnEndedSubscriptions(ctx, [invoice], byId(stripe({ status: 'canceled' })), [local({ status: SubscriptionStatus.CANCELED })]);
    expect(flagged[0]).toMatchObject({ category: 'OPEN_INVOICE_ON_ENDED_SUBSCRIPTION', severity: 'MEDIUM', stripeInvoiceId: 'in_open', userId: 'user_1' });
  });

  it('repeated failures need at least 3 attempts, a PAST_DUE row, and no later success', () => {
    const failure = { stripeInvoiceId: 'in_f', stripeSubscriptionId: 'sub_1', attempts: 3, lastAttemptAt: new Date(NOW.getTime() - DAY), nextPaymentAttempt: new Date(NOW.getTime() + DAY) };
    expect(detectRepeatedPaymentFailures(ctx, [local({ status: SubscriptionStatus.PAST_DUE })], [failure], new Set())).toHaveLength(1);
    expect(detectRepeatedPaymentFailures(ctx, [local({ status: SubscriptionStatus.PAST_DUE })], [{ ...failure, attempts: 2 }], new Set())).toHaveLength(0);
    expect(detectRepeatedPaymentFailures(ctx, [local()], [failure], new Set())).toHaveLength(0);
    expect(detectRepeatedPaymentFailures(ctx, [local({ status: SubscriptionStatus.PAST_DUE })], [failure], new Set(['in_f']))).toHaveLength(0);
  });

  it('dead-lettered money events are CRITICAL, other failures MEDIUM, stuck claims are backlog; fresh events are skipped', () => {
    const old = new Date(NOW.getTime() - 2 * 3_600_000);
    const events = [
      { stripeEventId: 'evt_paid', eventType: 'invoice.paid', createdAt: old, attemptCount: 4, lastError: 'boom', studioId: 'studio_1' },
      { stripeEventId: 'evt_sub', eventType: 'customer.subscription.updated', createdAt: old, attemptCount: 2, lastError: 'boom', studioId: null },
      { stripeEventId: 'evt_stuck', eventType: 'invoice.paid', createdAt: old, attemptCount: 1, lastError: null, studioId: 'studio_1' },
      { stripeEventId: 'evt_fresh', eventType: 'invoice.paid', createdAt: new Date(NOW.getTime() - 60_000), attemptCount: 1, lastError: 'boom', studioId: 'studio_1' },
    ];
    const issues = detectWebhookProblems({ studioId: null, now: NOW, timeZone: 'UTC' }, events);
    expect(issues.map((i) => [i.issueRef, i.category, i.severity, i.studioId])).toEqual([
      ['evt_paid', 'WEBHOOK_DEAD_LETTER', 'CRITICAL', 'studio_1'],
      ['evt_sub', 'WEBHOOK_DEAD_LETTER', 'MEDIUM', null],
      ['evt_stuck', 'WEBHOOK_BACKLOG', 'MEDIUM', 'studio_1'],
    ]);
  });
});
