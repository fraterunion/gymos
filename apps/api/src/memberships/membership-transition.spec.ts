import {
  SubscriptionEndReason,
  SubscriptionSource,
  SubscriptionStatus,
} from '@prisma/client';
import {
  buildLegacyInferenceContext,
  inferLegacySupersessionReason,
  isOperationalSupersessionCluster,
  projectMembershipLifecycle,
  type LegacyInferenceContext,
  type SubscriptionSibling,
  type SubscriptionTransitionInput,
} from './membership-transition';
import {
  isSubscriptionExpiringWithin7Days,
  isSubscriptionRequiringAttention,
} from './memberships.service';

const planFull = 'plan-full';
const planBasic = 'plan-basic';
const planOpenGym = 'plan-open-gym';

function baseSub(
  overrides: Partial<SubscriptionTransitionInput> & Pick<SubscriptionTransitionInput, 'id'>,
): SubscriptionTransitionInput {
  return {
    status: SubscriptionStatus.ACTIVE,
    source: SubscriptionSource.CASH,
    membershipPlanId: planFull,
    stripeSubscriptionId: null,
    currentPeriodStart: new Date('2026-07-01T00:00:00Z'),
    currentPeriodEnd: new Date('2026-08-01T00:00:00Z'),
    entitlementEndsAt: null,
    cancelAtPeriodEnd: true,
    endReason: null,
    supersededBySubscriptionId: null,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    membershipPlan: { name: 'Full Access' },
    ...overrides,
  };
}

function sibling(
  overrides: Partial<SubscriptionSibling> & Pick<SubscriptionSibling, 'id'>,
): SubscriptionSibling {
  return {
    membershipPlanId: planFull,
    source: SubscriptionSource.STRIPE,
    status: SubscriptionStatus.ACTIVE,
    stripeSubscriptionId: 'sub_stripe_new',
    createdAt: new Date('2026-08-14T17:27:33.251Z'),
    updatedAt: new Date('2026-08-14T17:27:33.251Z'),
    currentPeriodStart: new Date('2026-08-03T00:00:00Z'),
    currentPeriodEnd: new Date('2026-09-03T00:00:00Z'),
    ...overrides,
  };
}

const emptyContext: LegacyInferenceContext = {
  cashCreatedSubscriptionIds: new Set(),
  planChanges: [],
};

describe('membership-transition legacy hardening', () => {
  const now = new Date('2026-08-20T12:00:00Z');

  it('1. genuine cancellation + unrelated new membership 10 days later stays Cancelada', () => {
    const old = baseSub({
      id: 'old-cancel',
      status: SubscriptionStatus.CANCELED,
      endReason: SubscriptionEndReason.MEMBER_CANCELLED,
      updatedAt: new Date('2026-08-01T00:00:00Z'),
    });
    const newer = sibling({
      id: 'new-unrelated',
      createdAt: new Date('2026-08-11T00:00:00Z'),
      updatedAt: new Date('2026-08-11T00:00:00Z'),
    });

    const projected = projectMembershipLifecycle(old, now, [newer], emptyContext);
    expect(projected.lifecycleStatus).toBe('CANCELED');
    expect(projected.endReason).toBe(SubscriptionEndReason.MEMBER_CANCELLED);
  });

  it('2. temporal proximity alone cannot produce REPLACED', () => {
    const old = baseSub({
      id: 'old',
      status: SubscriptionStatus.CANCELED,
      updatedAt: new Date('2026-08-13T01:22:07.239Z'),
      membershipPlanId: planOpenGym,
    });
    const newer = sibling({
      id: 'new',
      source: SubscriptionSource.CASH,
      stripeSubscriptionId: null,
      membershipPlanId: planOpenGym,
      createdAt: new Date('2026-08-13T01:22:07.413Z'),
    });

    expect(inferLegacySupersessionReason(old, [newer], emptyContext)).toBeNull();
  });

  it('3. deterministic CASH → STRIPE supersession (Carlo production shape)', () => {
    const carloOld = baseSub({
      id: 'cmr5e5tl3002hm60r9s2d08cc',
      status: SubscriptionStatus.CANCELED,
      source: SubscriptionSource.CASH,
      membershipPlanId: planFull,
      currentPeriodEnd: new Date('2026-08-04T05:59:59Z'),
      updatedAt: new Date('2026-08-14T17:27:33.127Z'),
      createdAt: new Date('2026-07-03T20:34:10.311Z'),
    });
    const carloNew = sibling({
      id: 'cmst7zlvm0001entn84jauugr',
      source: SubscriptionSource.STRIPE,
      stripeSubscriptionId: 'sub_1U0LZeGuUoCXNOREKzoRfHBa',
      membershipPlanId: planFull,
      createdAt: new Date('2026-08-14T17:27:33.251Z'),
    });

    const projected = projectMembershipLifecycle(carloOld, now, [carloNew], emptyContext);
    expect(projected.lifecycleStatus).toBe('REPLACED');
    expect(projected.endReason).toBe(SubscriptionEndReason.SUPERSEDED_PAYMENT_METHOD);
    expect(projected.transitionDetail).toEqual({
      label: 'Cambio de forma de pago',
      detail: 'Efectivo → Stripe',
    });
  });

  it('4. deterministic CASH renewal replacement (Luis production shape + audit)', () => {
    const luisOld = baseSub({
      id: 'cmr3zhf4w001hm60rtiq31pgy',
      status: SubscriptionStatus.CANCELED,
      source: SubscriptionSource.CASH,
      membershipPlanId: planOpenGym,
      membershipPlan: { name: 'Open Gym' },
      currentPeriodEnd: new Date('2026-08-03T03:59:59Z'),
      updatedAt: new Date('2026-08-13T01:22:07.239Z'),
      createdAt: new Date('2026-07-02T20:55:31.041Z'),
    });
    const luisNew = sibling({
      id: 'cmsqu27ck005nph1xi5hqqkoq',
      source: SubscriptionSource.CASH,
      stripeSubscriptionId: null,
      membershipPlanId: planOpenGym,
      createdAt: new Date('2026-08-13T01:22:07.413Z'),
      updatedAt: new Date('2026-08-13T01:22:07.413Z'),
    });
    const context: LegacyInferenceContext = {
      cashCreatedSubscriptionIds: new Set(['cmsqu27ck005nph1xi5hqqkoq']),
      planChanges: [],
    };

    const projected = projectMembershipLifecycle(luisOld, now, [luisNew], context);
    expect(projected.lifecycleStatus).toBe('REPLACED');
    expect(projected.endReason).toBe(SubscriptionEndReason.SUPERSEDED_RENEWAL);
  });

  it('5. deterministic plan-change replacement requires MEMBERSHIP_PLAN_CHANGED audit', () => {
    const old = baseSub({
      id: 'old-basic',
      status: SubscriptionStatus.CANCELED,
      source: SubscriptionSource.STRIPE,
      stripeSubscriptionId: 'sub_basic',
      membershipPlanId: planBasic,
      membershipPlan: { name: 'Basic Access' },
      updatedAt: new Date('2026-08-14T17:00:40.437Z'),
    });
    const newer = sibling({
      id: 'new-full',
      membershipPlanId: planFull,
      stripeSubscriptionId: 'sub_full',
      createdAt: new Date('2026-08-14T17:00:42.523Z'),
    });
    const context: LegacyInferenceContext = {
      cashCreatedSubscriptionIds: new Set(),
      planChanges: [{
        previousPlanId: planBasic,
        newPlanId: planFull,
        createdAt: new Date('2026-08-14T17:00:42.000Z'),
      }],
    };

    const projected = projectMembershipLifecycle(old, now, [newer], context);
    expect(projected.lifecycleStatus).toBe('REPLACED');
    expect(projected.endReason).toBe(SubscriptionEndReason.SUPERSEDED_PLAN_CHANGE);
  });

  it('6. ambiguous legacy CANCELED + later different-plan subscription stays Cancelada (Emilia)', () => {
    const emiliaOld = baseSub({
      id: 'cmr9sf4iw004ym60rimrr0a7f',
      status: SubscriptionStatus.CANCELED,
      source: SubscriptionSource.STRIPE,
      stripeSubscriptionId: 'sub_1TqKw5GuUoCXNOREO80x7acx',
      membershipPlanId: planBasic,
      membershipPlan: { name: 'Basic Access' },
      updatedAt: new Date('2026-08-14T17:00:40.437Z'),
      createdAt: new Date('2026-07-06T22:24:23.721Z'),
    });
    const emiliaNew = sibling({
      id: 'cmst713170001enr44s9r29q4',
      stripeSubscriptionId: 'sub_1TyBahGuUoCXNOREC0n7bQF8',
      createdAt: new Date('2026-08-14T17:00:42.523Z'),
    });

    const projected = projectMembershipLifecycle(emiliaOld, now, [emiliaNew], emptyContext);
    expect(projected.lifecycleStatus).toBe('CANCELED');
    expect(projected.endReason).toBeNull();
  });

  it('7. persisted SUPERSEDED endReason takes precedence over empty context', () => {
    const old = baseSub({
      id: 'old',
      status: SubscriptionStatus.CANCELED,
      endReason: SubscriptionEndReason.SUPERSEDED_RENEWAL,
      supersededBySubscriptionId: 'new',
    });
    const projected = projectMembershipLifecycle(old, now, [], emptyContext);
    expect(projected.endReason).toBe(SubscriptionEndReason.SUPERSEDED_RENEWAL);
    expect(projected.lifecycleStatus).toBe('REPLACED');
  });

  it('8. MEMBER_CANCELLED is never projected as REPLACED', () => {
    const old = baseSub({
      id: 'old',
      status: SubscriptionStatus.CANCELED,
      endReason: SubscriptionEndReason.MEMBER_CANCELLED,
      updatedAt: new Date('2026-08-14T17:27:33.127Z'),
    });
    const newer = sibling({ id: 'new' });
    const projected = projectMembershipLifecycle(old, now, [newer], emptyContext);
    expect(projected.lifecycleStatus).toBe('CANCELED');
  });

  it('9. replaced records excluded from attention and expiring KPIs', () => {
    const replaced = projectMembershipLifecycle(
      baseSub({
        id: 'old',
        status: SubscriptionStatus.CANCELED,
        endReason: SubscriptionEndReason.SUPERSEDED_RENEWAL,
      }),
      now,
      [],
      emptyContext,
    );
    expect(isSubscriptionRequiringAttention(replaced)).toBe(false);
    expect(
      isSubscriptionExpiringWithin7Days(
        replaced,
        now,
        new Date(now.getTime() + 7 * 86_400_000),
      ),
    ).toBe(false);
  });

  it('10. Maky Booty entitled window unchanged', () => {
    const maky = baseSub({
      id: 'cmsywkujs0009rr1yyx14cm28',
      status: SubscriptionStatus.TRIALING,
      source: SubscriptionSource.STRIPE,
      stripeSubscriptionId: 'sub_1U5qHfGuUoCXNORE3oubMm5o',
      membershipPlanId: 'plan-booty',
      membershipPlan: { name: 'Booty Lab by Etzia' },
      currentPeriodEnd: new Date('2026-10-02T16:54:40Z'),
      entitlementEndsAt: new Date('2026-10-02T16:54:40Z'),
      createdAt: new Date('2026-08-18T16:54:45Z'),
    });
    const projected = projectMembershipLifecycle(maky, now, [], emptyContext);
    expect(projected.isEntitled).toBe(true);
    expect(projected.effectiveEnd?.toISOString()).toBe('2026-10-02T16:54:40.000Z');
  });

  it('operational cluster rejects 10-day gap even with audit', () => {
    expect(
      isOperationalSupersessionCluster(
        new Date('2026-08-01T00:00:00Z'),
        new Date('2026-08-11T00:00:00Z'),
      ),
    ).toBe(false);
  });

  it('buildLegacyInferenceContext extracts cash and plan-change audits', () => {
    const context = buildLegacyInferenceContext([
      {
        action: 'CASH_SUBSCRIPTION_CREATED',
        entityId: 'sub-cash-1',
        metadata: {},
        createdAt: new Date(),
      },
      {
        action: 'MEMBERSHIP_PLAN_CHANGED',
        entityId: 'plan-x',
        metadata: { previousPlanId: planBasic, newPlanId: planFull },
        createdAt: new Date(),
      },
    ]);
    expect(context.cashCreatedSubscriptionIds.has('sub-cash-1')).toBe(true);
    expect(context.planChanges).toHaveLength(1);
  });
});
