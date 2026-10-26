import { SubscriptionEndReason, SubscriptionSource, SubscriptionStatus } from '@prisma/client';
import { decideWebhookCreationConflict, isExpiredOfflineRow, type CreationConflictRow } from './webhook-creation-conflict';

const NOW = new Date('2026-10-19T12:15:41Z');
const DAY = 86_400_000;
const target = { id: 'plan-full', exclusiveGroup: 'CORE' };

function row(overrides: Partial<CreationConflictRow> = {}): CreationConflictRow {
  return {
    id: 'cash-1',
    source: SubscriptionSource.CASH,
    status: SubscriptionStatus.ACTIVE,
    stripeSubscriptionId: null,
    membershipPlanId: 'plan-full',
    exclusiveGroupKey: 'CORE',
    currentPeriodStart: new Date(NOW.getTime() - 32 * DAY),
    currentPeriodEnd: new Date(NOW.getTime() - 2 * DAY),
    entitlementEndsAt: null,
    ...overrides,
  };
}

describe('isExpiredOfflineRow', () => {
  it('an ACTIVE cash row whose period ended is expired (the INC-2026-10-19 shape)', () => {
    expect(isExpiredOfflineRow(row(), NOW)).toBe(true);
  });
  it('MANUAL rows follow the same rule', () => {
    expect(isExpiredOfflineRow(row({ source: SubscriptionSource.MANUAL }), NOW)).toBe(true);
  });
  it('the access window end is exclusive: ending exactly now is expired', () => {
    expect(isExpiredOfflineRow(row({ currentPeriodEnd: NOW }), NOW)).toBe(true);
  });
  it('a cash row still inside its paid window is live', () => {
    expect(isExpiredOfflineRow(row({ currentPeriodEnd: new Date(NOW.getTime() + DAY) }), NOW)).toBe(false);
  });
  it('entitlementEndsAt overrides the period end (fixed-duration cash)', () => {
    expect(isExpiredOfflineRow(row({ entitlementEndsAt: new Date(NOW.getTime() + DAY) }), NOW)).toBe(false);
  });
  it('Stripe-backed rows are never offline', () => {
    expect(isExpiredOfflineRow(row({ source: SubscriptionSource.STRIPE, stripeSubscriptionId: 'sub_x' }), NOW)).toBe(false);
  });
  it('rows whose state is not plainly expired (PAST_DUE, PAUSED, no end) are treated as live', () => {
    expect(isExpiredOfflineRow(row({ status: SubscriptionStatus.PAST_DUE }), NOW)).toBe(false);
    expect(isExpiredOfflineRow(row({ status: SubscriptionStatus.PAUSED }), NOW)).toBe(false);
    expect(isExpiredOfflineRow(row({ currentPeriodEnd: null }), NOW)).toBe(false);
  });
  it('a future-dated row has not expired', () => {
    expect(isExpiredOfflineRow(row({ currentPeriodStart: new Date(NOW.getTime() + DAY), currentPeriodEnd: new Date(NOW.getTime() + 31 * DAY) }), NOW)).toBe(false);
  });
});

describe('decideWebhookCreationConflict', () => {
  it('same plan expired cash → supersede as SUPERSEDED_PAYMENT_METHOD', () => {
    const d = decideWebhookCreationConflict([row()], target, NOW);
    expect(d).toEqual({ action: 'supersede_then_create', supersede: [{ row: row(), endReason: SubscriptionEndReason.SUPERSEDED_PAYMENT_METHOD }] });
  });

  it('same group, other plan → supersede as SUPERSEDED_PLAN_CHANGE', () => {
    const basic = row({ id: 'cash-basic', membershipPlanId: 'plan-basic' });
    const d = decideWebhookCreationConflict([basic], target, NOW);
    expect(d).toEqual({ action: 'supersede_then_create', supersede: [{ row: basic, endReason: SubscriptionEndReason.SUPERSEDED_PLAN_CHANGE }] });
  });

  it('every same-family expired row is superseded; an expired row of another family is left alone', () => {
    const a = row({ id: 'cash-a' });
    const b = row({ id: 'cash-b', membershipPlanId: 'plan-basic' });
    const other = row({ id: 'cash-booty', membershipPlanId: 'plan-booty', exclusiveGroupKey: null });
    const d = decideWebhookCreationConflict([a, other, b], target, NOW);
    expect(d.action).toBe('supersede_then_create');
    expect(d.action === 'supersede_then_create' && d.supersede.map((s) => s.row.id)).toEqual(['cash-a', 'cash-b']);
  });

  it('a null exclusive group never matches another null group', () => {
    const other = row({ id: 'cash-booty', membershipPlanId: 'plan-booty', exclusiveGroupKey: null });
    const d = decideWebhookCreationConflict([other], { id: 'plan-yoga', exclusiveGroup: null }, NOW);
    expect(d).toEqual({ action: 'supersede_then_create', supersede: [] });
  });

  it('any live conflict acknowledges and mutates nothing, even alongside expired rows', () => {
    const live = row({ id: 'cash-live', currentPeriodEnd: new Date(NOW.getTime() + 5 * DAY) });
    const d = decideWebhookCreationConflict([row(), live], target, NOW);
    expect(d).toEqual({ action: 'acknowledge', blockingRow: live, conflictKind: 'active_cash_conflict' });
  });

  it('a Stripe-backed conflict is a stripe_backed_conflict', () => {
    const stripe = row({ id: 'stripe-1', source: SubscriptionSource.STRIPE, stripeSubscriptionId: 'sub_other', currentPeriodEnd: new Date(NOW.getTime() + 5 * DAY) });
    const d = decideWebhookCreationConflict([stripe], target, NOW);
    expect(d).toMatchObject({ action: 'acknowledge', conflictKind: 'stripe_backed_conflict' });
  });

  it('an expired Stripe-backed row is still live for this decision (never auto-superseded)', () => {
    const stripe = row({ id: 'stripe-1', source: SubscriptionSource.STRIPE, stripeSubscriptionId: 'sub_other' });
    expect(decideWebhookCreationConflict([stripe], target, NOW)).toMatchObject({ action: 'acknowledge', conflictKind: 'stripe_backed_conflict' });
  });
});
