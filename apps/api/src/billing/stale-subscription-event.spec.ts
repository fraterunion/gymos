import { SubscriptionStatus } from '@prisma/client';
import { judgeTerminalConflict, needsLiveVerification } from './stale-subscription-event';

describe('stale-subscription-event — terminal conflict verdicts', () => {
  it('only a CANCELED local row receiving an alive status needs Stripe consulted', () => {
    expect(needsLiveVerification(SubscriptionStatus.ACTIVE, 'active')).toBe(false);
    expect(needsLiveVerification(SubscriptionStatus.PAST_DUE, 'canceled')).toBe(false);
    expect(needsLiveVerification(SubscriptionStatus.CANCELED, 'canceled')).toBe(false);
    expect(needsLiveVerification(SubscriptionStatus.CANCELED, 'incomplete_expired')).toBe(false);
    expect(needsLiveVerification(SubscriptionStatus.CANCELED, 'active')).toBe(true);
    expect(needsLiveVerification(SubscriptionStatus.CANCELED, 'past_due')).toBe(true);
    expect(needsLiveVerification(null, 'active')).toBe(false);
  });

  it('applies normally when there is no terminal conflict, whatever Stripe says', () => {
    expect(judgeTerminalConflict({ localStatus: SubscriptionStatus.ACTIVE, incomingStripeStatus: 'active', live: null })).toEqual({ action: 'APPLY' });
    expect(judgeTerminalConflict({ localStatus: SubscriptionStatus.CANCELED, incomingStripeStatus: 'canceled', live: null })).toEqual({ action: 'APPLY' });
    expect(judgeTerminalConflict({ localStatus: null, incomingStripeStatus: 'active', live: null })).toEqual({ action: 'APPLY' });
  });

  it('a stale "alive" event for a subscription Stripe already ended is ignored', () => {
    expect(
      judgeTerminalConflict({ localStatus: SubscriptionStatus.CANCELED, incomingStripeStatus: 'active', live: { ok: true, status: 'canceled', cancellationReason: 'payment_failed' } }),
    ).toEqual({ action: 'IGNORE_STALE', liveStatus: 'canceled' });
    expect(
      judgeTerminalConflict({ localStatus: SubscriptionStatus.CANCELED, incomingStripeStatus: 'past_due', live: { ok: true, status: 'incomplete_expired', cancellationReason: null } }),
    ).toEqual({ action: 'IGNORE_STALE', liveStatus: 'incomplete_expired' });
  });

  it('a GymOS-side cancellation Stripe disagrees with is kept and surfaced, never auto-reactivated', () => {
    expect(
      judgeTerminalConflict({ localStatus: SubscriptionStatus.CANCELED, incomingStripeStatus: 'active', live: { ok: true, status: 'active', cancellationReason: null } }),
    ).toEqual({ action: 'KEEP_LOCAL_OPEN_CASE', liveStatus: 'active' });
  });

  it('fails closed (retry) when Stripe could not be consulted', () => {
    expect(judgeTerminalConflict({ localStatus: SubscriptionStatus.CANCELED, incomingStripeStatus: 'active', live: null })).toMatchObject({ action: 'RETRY_UNVERIFIED' });
    expect(judgeTerminalConflict({ localStatus: SubscriptionStatus.CANCELED, incomingStripeStatus: 'active', live: { ok: false, error: 'timeout' } })).toEqual({ action: 'RETRY_UNVERIFIED', error: 'timeout' });
  });
});
