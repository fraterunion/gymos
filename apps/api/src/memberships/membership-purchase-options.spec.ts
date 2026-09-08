import { SubscriptionStatus } from '@prisma/client';
import {
  resolvePurchaseAction,
  type PurchaseOptionMembershipRow,
} from './membership-purchase-options';

const fullPlan = { id: 'plan-full', name: 'Full Access', exclusiveGroup: 'CORE' };
const basicPlan = { id: 'plan-basic', name: 'Basic Access', exclusiveGroup: 'CORE' };
const bootyPlan = { id: 'plan-booty', name: 'Booty Lab by Etzia', exclusiveGroup: null };

function row(overrides: Partial<PurchaseOptionMembershipRow>): PurchaseOptionMembershipRow {
  return {
    id: 'sub-1',
    membershipPlanId: 'plan-full',
    exclusiveGroupKey: 'CORE',
    status: SubscriptionStatus.ACTIVE,
    stripeSubscriptionId: 'sub_stripe_1',
    isEntitled: true,
    currentPeriodStart: new Date('2026-09-01'),
    planName: 'Full Access',
    ...overrides,
  };
}

describe('resolvePurchaseAction — canonical catalog CTA semantics', () => {
  it('A: no current membership → SUBSCRIBE', () => {
    expect(resolvePurchaseAction(fullPlan, [], [], true).purchaseAction).toBe('SUBSCRIBE');
    expect(resolvePurchaseAction(bootyPlan, [], [], false).purchaseAction).toBe('SUBSCRIBE');
  });

  it('B: own same renewable entitled plan → CURRENT, related to the OWN row', () => {
    const opt = resolvePurchaseAction(fullPlan, [row({})], [], true);
    expect(opt.purchaseAction).toBe('CURRENT');
    expect(opt.relatedSubscriptionId).toBe('sub-1');
    expect(opt.relatedPlanName).toBe('Full Access');
  });

  it('C: same exclusive group with a Stripe membership → CHANGE targeting that row', () => {
    const opt = resolvePurchaseAction(basicPlan, [row({})], [], true);
    expect(opt.purchaseAction).toBe('CHANGE');
    expect(opt.relatedSubscriptionId).toBe('sub-1');
    expect(opt.relatedPlanName).toBe('Full Access');
  });

  it('C-cash: same family held as CASH → BLOCKED/IN_PERSON (self-serve checkout would orphan the payment)', () => {
    const opt = resolvePurchaseAction(basicPlan, [row({ stripeSubscriptionId: null })], [], true);
    expect(opt.purchaseAction).toBe('BLOCKED');
    expect(opt.reasonCode).toBe('IN_PERSON');
  });

  it('D: compatible independent plan → ADD only while stacking is enabled', () => {
    expect(resolvePurchaseAction(bootyPlan, [row({})], [], true).purchaseAction).toBe('ADD');
  });

  it('D-gate-off: would-be ADD degrades to BLOCKED/STACKING_DISABLED — never advertises ADD', () => {
    const opt = resolvePurchaseAction(bootyPlan, [row({})], [], false);
    expect(opt.purchaseAction).toBe('BLOCKED');
    expect(opt.reasonCode).toBe('STACKING_DISABLED');
  });

  it('E: canceled-but-entitled own plan → RENEW (fresh window)', () => {
    const opt = resolvePurchaseAction(
      fullPlan,
      [row({ status: SubscriptionStatus.CANCELED, stripeSubscriptionId: null })],
      [],
      true,
    );
    expect(opt.purchaseAction).toBe('RENEW');
    expect(opt.reasonCode).toBe('RESUBSCRIBE');
  });

  it('E-lapsed: own renewable plan no longer entitled → RENEW', () => {
    const opt = resolvePurchaseAction(fullPlan, [row({ isEntitled: false })], [], true);
    expect(opt.purchaseAction).toBe('RENEW');
  });

  it('F: existing scheduled successor in the family → SCHEDULED with its start date', () => {
    const start = new Date('2026-10-13');
    const opt = resolvePurchaseAction(
      fullPlan,
      [row({})],
      [row({ id: 'sub-sched', status: SubscriptionStatus.SCHEDULED, currentPeriodStart: start })],
      true,
    );
    expect(opt.purchaseAction).toBe('SCHEDULED');
    expect(opt.relatedSubscriptionId).toBe('sub-sched');
    expect(opt.effectiveDate).toBe(start);
  });

  it('G: own past-due plan → BLOCKED/PAST_DUE (payment resolution, never a second subscription)', () => {
    const opt = resolvePurchaseAction(fullPlan, [row({ status: SubscriptionStatus.PAST_DUE, isEntitled: false })], [], true);
    expect(opt.purchaseAction).toBe('BLOCKED');
    expect(opt.reasonCode).toBe('PAST_DUE');
  });

  it('paused own plan → BLOCKED/PAUSED', () => {
    const opt = resolvePurchaseAction(fullPlan, [row({ status: SubscriptionStatus.PAUSED, isEntitled: false })], [], true);
    expect(opt.purchaseAction).toBe('BLOCKED');
    expect(opt.reasonCode).toBe('PAUSED');
  });

  it('dual member: each plan resolves from the member\'s OWN row for that plan, never the primary', () => {
    const fullRow = row({});
    const bootyRow = row({
      id: 'sub-booty',
      membershipPlanId: 'plan-booty',
      exclusiveGroupKey: null,
      stripeSubscriptionId: null,
      planName: 'Booty Lab by Etzia',
    });
    const fullOpt = resolvePurchaseAction(fullPlan, [bootyRow, fullRow], [], true);
    const bootyOpt = resolvePurchaseAction(bootyPlan, [bootyRow, fullRow], [], true);
    expect(fullOpt.purchaseAction).toBe('CURRENT');
    expect(fullOpt.relatedSubscriptionId).toBe('sub-1');
    expect(bootyOpt.purchaseAction).toBe('CURRENT');
    expect(bootyOpt.relatedSubscriptionId).toBe('sub-booty');
  });

  it('family conflict prefers the Stripe-backed row over a cash one for CHANGE targeting', () => {
    const cashCore = row({ id: 'sub-cash', stripeSubscriptionId: null, planName: 'Old Cash Full' });
    const stripeCore = row({ id: 'sub-stripe', planName: 'Full Access' });
    const opt = resolvePurchaseAction(basicPlan, [cashCore, stripeCore], [], true);
    expect(opt.purchaseAction).toBe('CHANGE');
    expect(opt.relatedSubscriptionId).toBe('sub-stripe');
  });
});
