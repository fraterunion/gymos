import { SubscriptionStatus } from '@prisma/client';
import {
  currentlyEntitledSubscriptionWhere,
  deriveMembershipLifecycle,
  isSubscriptionCurrentlyEntitled,
} from './membership-entitlement';

describe('canonical membership entitlement', () => {
  const end = new Date('2026-08-19T12:00:00.000Z');
  const subscription = {
    status: SubscriptionStatus.ACTIVE,
    currentPeriodStart: new Date('2026-07-19T12:00:00.000Z'),
    currentPeriodEnd: end,
    entitlementEndsAt: null,
  };

  it('allows an ACTIVE recurring subscription before currentPeriodEnd', () => {
    expect(isSubscriptionCurrentlyEntitled(subscription, new Date(end.getTime() - 1))).toBe(true);
  });

  it('denies at the exact currentPeriodEnd boundary', () => {
    expect(isSubscriptionCurrentlyEntitled(subscription, end)).toBe(false);
  });

  it('denies after currentPeriodEnd despite stale ACTIVE status and remaining credits', () => {
    expect(isSubscriptionCurrentlyEntitled(subscription, new Date(end.getTime() + 1))).toBe(false);
  });

  it('allows cancel-at-period-end semantics before the end (status remains ACTIVE)', () => {
    expect(isSubscriptionCurrentlyEntitled(subscription, new Date(end.getTime() - 1))).toBe(true);
  });

  it('allows a renewed cash row with a future period', () => {
    expect(
      isSubscriptionCurrentlyEntitled(
        { ...subscription, currentPeriodEnd: new Date('2026-09-19T12:00:00.000Z') },
        end,
      ),
    ).toBe(true);
  });

  it('uses the fixed-duration entitlement end instead of the Stripe billing period', () => {
    const fixed = {
      status: SubscriptionStatus.CANCELED,
      currentPeriodStart: new Date('2026-07-01T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-08-01T00:00:00.000Z'),
      entitlementEndsAt: end,
    };
    expect(isSubscriptionCurrentlyEntitled(fixed, new Date(end.getTime() - 1))).toBe(true);
    expect(isSubscriptionCurrentlyEntitled(fixed, end)).toBe(false);
  });

  it('does not activate a future entitlement early', () => {
    const future = {
      ...subscription,
      currentPeriodStart: new Date('2026-08-20T12:00:00.000Z'),
      currentPeriodEnd: new Date('2026-09-20T12:00:00.000Z'),
    };
    expect(isSubscriptionCurrentlyEntitled(future, end)).toBe(false);
    expect(deriveMembershipLifecycle(future, end)).toMatchObject({
      accessState: 'NOT_STARTED',
      lifecycleStatus: 'SCHEDULED',
    });
  });

  it('keeps payment problems and pauses distinct from expiration', () => {
    expect(
      deriveMembershipLifecycle({ ...subscription, status: SubscriptionStatus.PAST_DUE }, end),
    ).toMatchObject({ accessState: 'INACTIVE', lifecycleStatus: 'PAST_DUE' });
    expect(
      deriveMembershipLifecycle({ ...subscription, status: SubscriptionStatus.PAUSED }, end),
    ).toMatchObject({ accessState: 'INACTIVE', lifecycleStatus: 'PAUSED' });
  });

  it('derives ENDING before cancel-at-period-end and EXPIRED at the boundary', () => {
    const ending = { ...subscription, cancelAtPeriodEnd: true };
    expect(deriveMembershipLifecycle(ending, new Date(end.getTime() - 1))).toMatchObject({
      accessState: 'ENTITLED',
      lifecycleStatus: 'ENDING',
    });
    expect(deriveMembershipLifecycle(ending, end)).toMatchObject({
      accessState: 'EXPIRED',
      lifecycleStatus: 'EXPIRED',
    });
  });

  it('builds a strict greater-than database predicate for both effective end types', () => {
    expect(currentlyEntitledSubscriptionWhere(end)).toEqual(
      expect.objectContaining({
        AND: expect.arrayContaining([
          expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({ currentPeriodStart: { lte: end } }),
            ]),
          }),
          expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({ currentPeriodEnd: { gt: end } }),
              expect.objectContaining({ entitlementEndsAt: { gt: end } }),
            ]),
          }),
        ]),
      }),
    );
  });
});
