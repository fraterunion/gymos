import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  PaymentMethod,
  PaymentStatus,
  Prisma,
  Role,
  SubscriptionEndReason,
  SubscriptionSource,
  SubscriptionStatus,
  type MembershipPlan,
  type Subscription,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../stripe/stripe.service';
import {
  STRIPE_RENEWABLE_CONFLICT_CODE,
  STRIPE_RENEWABLE_CONFLICT_MESSAGE,
  type StripeConflictPayload,
  type StripeResolution,
} from './stripe-to-cash.constants';
import { RENEWABLE_SUBSCRIPTION_STATUSES } from './subscription-lifecycle.constants';
import {
  buildGymosStripeToCashImmediateIdempotencyKey,
  buildGymosStripeToCashPeriodEndIdempotencyKey,
} from './stripe-renewal-audit.utils';
import { findConflictingMemberships } from '../memberships/membership-compatibility';
import { acquireSubscriptionWriteAdvisoryLock } from './subscription-write-advisory-lock';

type StripeSubWithPlan = Subscription & { membershipPlan: MembershipPlan };

/** MM-3: the membership family a transition/activation is scoped to. */
export type TransitionPlanScope = { id: string; exclusiveGroup: string | null };

export type ScheduledCashResult = {
  subscription: {
    id: string;
    status: SubscriptionStatus;
    source: SubscriptionSource;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
    membershipPlan: {
      id: string;
      name: string;
      billingInterval: string;
      priceCents: number;
      currency: string;
    };
  };
  payment: {
    id: string;
    amountCents: number;
    status: PaymentStatus;
    paymentMethod: PaymentMethod;
  };
  stripe: {
    localSubscriptionId: string;
    stripeSubscriptionId: string;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: Date | null;
    previousCancelAtPeriodEnd: boolean;
    stripeIdempotencyKey: string | null;
  };
};

@Injectable()
export class StripeToCashTransitionService {
  private readonly logger = new Logger(StripeToCashTransitionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
  ) {}

  assertCanResolveStripe(actorRole: Role): void {
    if (actorRole !== Role.OWNER && actorRole !== Role.ADMIN) {
      throw new ForbiddenException(
        'Only OWNER or ADMIN can change a Stripe subscription to cash.',
      );
    }
  }

  allowedResolutionsForRole(actorRole: Role): StripeResolution[] {
    if (actorRole === Role.OWNER || actorRole === Role.ADMIN) {
      return ['cancel_at_period_end', 'cancel_immediately'];
    }
    return [];
  }

  buildConflictException(
    stripeSub: StripeSubWithPlan,
    actorRole: Role,
    pendingCashTransitionId: string | null = null,
  ): ConflictException {
    const payload: StripeConflictPayload = {
      statusCode: 409,
      code: STRIPE_RENEWABLE_CONFLICT_CODE,
      message: STRIPE_RENEWABLE_CONFLICT_MESSAGE,
      stripeConflict: {
        localSubscriptionId: stripeSub.id,
        stripeSubscriptionId: stripeSub.stripeSubscriptionId!,
        planId: stripeSub.membershipPlanId,
        planName: stripeSub.membershipPlan.name,
        status: stripeSub.status,
        currentPeriodStart: stripeSub.currentPeriodStart?.toISOString() ?? null,
        currentPeriodEnd: stripeSub.currentPeriodEnd?.toISOString() ?? null,
        cancelAtPeriodEnd: stripeSub.cancelAtPeriodEnd,
        pendingCashTransitionId,
        allowedResolutions: this.allowedResolutionsForRole(actorRole),
      },
    };
    return new ConflictException(payload);
  }

  async findPendingScheduledCash(
    studioId: string,
    userId: string,
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<Subscription | null> {
    return tx.subscription.findFirst({
      where: {
        studioId,
        userId,
        status: SubscriptionStatus.SCHEDULED,
        source: SubscriptionSource.CASH,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * MM-3: the pending SCHEDULED CASH successor that belongs to `forPlan`'s membership
   * family (same plan or same non-null exclusive group). Successors from other families
   * (e.g. a Booty Lab successor while transitioning Full Access) are invisible here.
   */
  async findPendingScheduledCashForPlan(
    studioId: string,
    userId: string,
    forPlan: TransitionPlanScope,
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<Subscription | null> {
    const rows = await tx.subscription.findMany({
      where: {
        studioId,
        userId,
        status: SubscriptionStatus.SCHEDULED,
        source: SubscriptionSource.CASH,
      },
      include: { membershipPlan: { select: { exclusiveGroup: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return (
      findConflictingMemberships(
        rows.map((r) => ({
          row: r as Subscription,
          membershipPlanId: r.membershipPlanId,
          exclusiveGroupKey: r.exclusiveGroupKey,
        })),
        forPlan,
      )[0]?.row ?? null
    );
  }

  async findPrimaryStripeSubscription(
    studioId: string,
    userId: string,
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<StripeSubWithPlan | null> {
    return tx.subscription.findFirst({
      where: {
        studioId,
        userId,
        stripeSubscriptionId: { not: null },
        status: { in: RENEWABLE_SUBSCRIPTION_STATUSES },
      },
      orderBy: [{ createdAt: 'desc' }],
      include: { membershipPlan: true },
    }) as Promise<StripeSubWithPlan | null>;
  }

  /**
   * MM-3: plan-scoped replacement for "the member's Stripe subscription" in transition
   * flows — the renewable Stripe subscription in the SAME membership family as `forPlan`.
   * With the multi-membership gate off every Stripe subscription conflicts (legacy).
   */
  async findConflictingStripeSubscription(
    studioId: string,
    userId: string,
    forPlan: TransitionPlanScope,
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<StripeSubWithPlan | null> {
    const subs = (await tx.subscription.findMany({
      where: {
        studioId,
        userId,
        stripeSubscriptionId: { not: null },
        status: { in: RENEWABLE_SUBSCRIPTION_STATUSES },
      },
      orderBy: [{ createdAt: 'desc' }],
      include: { membershipPlan: true },
    })) as StripeSubWithPlan[];
    return (
      findConflictingMemberships(
        subs.map((s) => ({
          row: s,
          membershipPlanId: s.membershipPlanId,
          exclusiveGroupKey: s.exclusiveGroupKey,
        })),
        forPlan,
      )[0]?.row ?? null
    );
  }

  /**
   * Cancel Stripe immediately and mark the local row CANCELED.
   * Idempotent when local is already CANCELED (recovery after Stripe-succeeded / DB-failed).
   */
  async cancelStripeImmediately(params: {
    studioId: string;
    userId: string;
    /** MM-3: scope to this membership family. Without it, legacy newest-first lookup. */
    forPlan?: TransitionPlanScope;
  }): Promise<(StripeSubWithPlan & { stripeIdempotencyKey: string | null }) | null> {
    const stripeSub = params.forPlan
      ? await this.findConflictingStripeSubscription(params.studioId, params.userId, params.forPlan)
      : await this.findPrimaryStripeSubscription(params.studioId, params.userId);
    if (!stripeSub?.stripeSubscriptionId) {
      // Recovery: Stripe already canceled locally — allow cash creation to proceed.
      return null;
    }

    const stripeIdempotencyKey = buildGymosStripeToCashImmediateIdempotencyKey(
      stripeSub.stripeSubscriptionId,
    );
    try {
      await this.stripe.cancelSubscription(stripeSub.stripeSubscriptionId, {}, {
        idempotencyKey: stripeIdempotencyKey,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Stripe may already be canceled after a prior partial failure.
      if (!/already been canceled|No such subscription/i.test(message)) {
        this.logger.error(
          JSON.stringify({
            event: 'stripe_to_cash_immediate_cancel_failed',
            studioId: params.studioId,
            userId: params.userId,
            localSubscriptionId: stripeSub.id,
            stripeSubscriptionId: stripeSub.stripeSubscriptionId,
            error: message,
          }),
        );
        throw err;
      }
    }

    await this.prisma.subscription.update({
      where: { id: stripeSub.id },
      data: {
        status: SubscriptionStatus.CANCELED,
        cancelAtPeriodEnd: false,
        endReason: SubscriptionEndReason.SUPERSEDED_PAYMENT_METHOD,
      },
    });

    this.logger.log(
      JSON.stringify({
        event: 'stripe_to_cash_immediate_canceled',
        studioId: params.studioId,
        userId: params.userId,
        localSubscriptionId: stripeSub.id,
        stripeSubscriptionId: stripeSub.stripeSubscriptionId,
      }),
    );

    return { ...stripeSub, stripeIdempotencyKey };
  }

  /**
   * Period-end path: Stripe stays ACTIVE + cancel_at_period_end; create SCHEDULED CASH.
   * Cash payment is recorded now (Ventas); entitlement starts at Stripe period end.
   */
  async scheduleCashAtStripePeriodEnd(params: {
    studioId: string;
    actorUserId: string;
    targetUserId: string;
    plan: MembershipPlan;
    amountCents: number;
    notes: string | null;
    defaultPeriodEnd: (start: Date, interval: MembershipPlan['billingInterval']) => Date;
  }): Promise<ScheduledCashResult> {
    // MM-3: the transition targets the Stripe subscription in the SAME membership family
    // as the cash plan being sold — a sibling membership (e.g. Booty Lab while
    // transitioning Full Access) receives zero mutations from this entire flow.
    const planScope: TransitionPlanScope = { id: params.plan.id, exclusiveGroup: params.plan.exclusiveGroup };
    const stripeSub = await this.findConflictingStripeSubscription(
      params.studioId,
      params.targetUserId,
      planScope,
    );
    if (!stripeSub?.stripeSubscriptionId) {
      throw new BadRequestException(
        'No renewable Stripe subscription found for period-end cash transition.',
      );
    }
    if (!stripeSub.currentPeriodEnd) {
      throw new BadRequestException(
        'Stripe subscription is missing currentPeriodEnd; cannot schedule cash start.',
      );
    }

    const existingScheduled = await this.findPendingScheduledCashForPlan(
      params.studioId,
      params.targetUserId,
      planScope,
    );
    if (existingScheduled) {
      return this.buildIdempotentScheduledResult({
        existingScheduled,
        stripeSub,
        planId: params.plan.id,
        amountCents: params.amountCents,
      });
    }

    const cancelResult = await this.ensureStripeCancelAtPeriodEnd(stripeSub);

    const periodStart = stripeSub.currentPeriodEnd;
    const entitlementEndsAt =
      params.plan.entitlementDays != null
        ? new Date(periodStart.getTime() + params.plan.entitlementDays * 86_400_000)
        : null;
    const periodEnd =
      entitlementEndsAt ??
      params.defaultPeriodEnd(periodStart, params.plan.billingInterval);

    const planInclude = {
      membershipPlan: {
        select: {
          id: true,
          name: true,
          billingInterval: true,
          priceCents: true,
          currency: true,
        },
      },
    } as const;

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        // MM-1 concurrency: serialize compatibility check + successor creation per member.
        await acquireSubscriptionWriteAdvisoryLock(tx, params.studioId, params.targetUserId);
        const subscription = await tx.subscription.create({
          data: {
            studioId: params.studioId,
            userId: params.targetUserId,
            membershipPlanId: params.plan.id,
            status: SubscriptionStatus.SCHEDULED,
            source: SubscriptionSource.CASH,
            stripeSubscriptionId: null,
            exclusiveGroupKey: params.plan.exclusiveGroup,
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
            cancelAtPeriodEnd: true,
            createdByUserId: params.actorUserId,
            notes: params.notes,
            ...(entitlementEndsAt !== null ? { entitlementEndsAt } : {}),
          },
          include: planInclude,
        });

        await tx.subscription.update({
          where: { id: stripeSub.id },
          data: {
            cancelAtPeriodEnd: true,
            supersededBySubscriptionId: subscription.id,
          },
        });

        if (params.plan.entitlementDays != null) {
          await tx.membershipEntitlementCycle.create({
            data: {
              studioId: params.studioId,
              userId: params.targetUserId,
              subscriptionId: subscription.id,
              membershipPlanId: params.plan.id,
              startsAt: periodStart,
              endsAt: entitlementEndsAt!,
              creditLimit: params.plan.classCredits,
              source: SubscriptionSource.CASH,
            },
          });
        }

        const payment = await tx.payment.create({
          data: {
            studioId: params.studioId,
            userId: params.targetUserId,
            subscriptionId: subscription.id,
            membershipPlanId: params.plan.id,
            amountCents: params.amountCents,
            currency: params.plan.currency,
            status: PaymentStatus.SUCCEEDED,
            paymentMethod: PaymentMethod.CASH,
            recordedByUserId: params.actorUserId,
            notes: params.notes,
            paidAt: new Date(),
          },
        });

        return { subscription, payment };
      });

      this.logger.log(
        JSON.stringify({
          event: 'stripe_to_cash_period_end_scheduled',
          studioId: params.studioId,
          userId: params.targetUserId,
          stripeLocalId: stripeSub.id,
          stripeSubscriptionId: stripeSub.stripeSubscriptionId,
          scheduledCashId: result.subscription.id,
          effectiveAt: periodStart.toISOString(),
          planId: params.plan.id,
        }),
      );

      return {
        subscription: result.subscription,
        payment: result.payment,
        stripe: {
          localSubscriptionId: stripeSub.id,
          stripeSubscriptionId: stripeSub.stripeSubscriptionId,
          cancelAtPeriodEnd: true,
          currentPeriodEnd: stripeSub.currentPeriodEnd,
          previousCancelAtPeriodEnd: cancelResult.previousCancelAtPeriodEnd,
          stripeIdempotencyKey: cancelResult.stripeIdempotencyKey,
        },
      };
    } catch (e) {
      // Concurrent period-end requests: unique SCHEDULED index wins; return existing row + payment.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const raced = await this.findPendingScheduledCashForPlan(
          params.studioId,
          params.targetUserId,
          planScope,
        );
        if (raced) {
          return this.buildIdempotentScheduledResult({
            existingScheduled: raced,
            stripeSub,
            planId: params.plan.id,
            amountCents: params.amountCents,
          });
        }
        throw new ConflictException(
          'Ya hay una transición a efectivo programada para este miembro.',
        );
      }
      throw e;
    }
  }

  private async buildIdempotentScheduledResult(params: {
    existingScheduled: Subscription;
    stripeSub: StripeSubWithPlan;
    planId: string;
    amountCents: number;
  }): Promise<ScheduledCashResult> {
    if (params.existingScheduled.membershipPlanId !== params.planId) {
      throw new ConflictException(
        'Ya hay una transición a efectivo programada con otro plan. Resuélvela antes de continuar.',
      );
    }
    const payment = await this.prisma.payment.findFirst({
      where: {
        subscriptionId: params.existingScheduled.id,
        paymentMethod: PaymentMethod.CASH,
        status: PaymentStatus.SUCCEEDED,
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!payment) {
      throw new ConflictException(
        'Hay una transición a efectivo programada sin pago asociado. Requiere revisión manual.',
      );
    }
    if (!params.stripeSub.cancelAtPeriodEnd) {
      await this.ensureStripeCancelAtPeriodEnd(params.stripeSub);
    }
    const planRow = await this.prisma.membershipPlan.findFirstOrThrow({
      where: { id: params.existingScheduled.membershipPlanId },
      select: {
        id: true,
        name: true,
        billingInterval: true,
        priceCents: true,
        currency: true,
      },
    });
    return {
      subscription: {
        id: params.existingScheduled.id,
        status: params.existingScheduled.status,
        source: params.existingScheduled.source,
        currentPeriodStart: params.existingScheduled.currentPeriodStart,
        currentPeriodEnd: params.existingScheduled.currentPeriodEnd,
        membershipPlan: planRow,
      },
      payment: {
        id: payment.id,
        amountCents: payment.amountCents,
        status: payment.status,
        paymentMethod: payment.paymentMethod,
      },
      stripe: {
        localSubscriptionId: params.stripeSub.id,
        stripeSubscriptionId: params.stripeSub.stripeSubscriptionId!,
        cancelAtPeriodEnd: true,
        currentPeriodEnd: params.stripeSub.currentPeriodEnd,
        previousCancelAtPeriodEnd: params.stripeSub.cancelAtPeriodEnd,
        stripeIdempotencyKey: null,
      },
    };
  }

  private async ensureStripeCancelAtPeriodEnd(stripeSub: StripeSubWithPlan): Promise<{
    previousCancelAtPeriodEnd: boolean;
    stripeIdempotencyKey: string | null;
  }> {
    if (!stripeSub.stripeSubscriptionId) {
      return { previousCancelAtPeriodEnd: stripeSub.cancelAtPeriodEnd, stripeIdempotencyKey: null };
    }
    const previousCancelAtPeriodEnd = stripeSub.cancelAtPeriodEnd;
    let stripeIdempotencyKey: string | null = null;
    if (!stripeSub.cancelAtPeriodEnd) {
      stripeIdempotencyKey = buildGymosStripeToCashPeriodEndIdempotencyKey(
        stripeSub.stripeSubscriptionId,
      );
      await this.stripe.updateSubscription(
        stripeSub.stripeSubscriptionId,
        { cancel_at_period_end: true },
        { idempotencyKey: stripeIdempotencyKey },
      );
    }
    await this.prisma.subscription.update({
      where: { id: stripeSub.id },
      data: { cancelAtPeriodEnd: true },
    });
    return { previousCancelAtPeriodEnd, stripeIdempotencyKey };
  }

  /**
   * Promote SCHEDULED CASH → ACTIVE once Stripe entitlement has ended.
   * Idempotent under concurrent webhook + reconciliation (conditional SCHEDULED update).
   */
  async activateScheduledCashIfDue(
    tx: Prisma.TransactionClient,
    params: {
      studioId: string;
      userId: string;
      now?: Date;
      /**
       * MM-3: scope activation to this membership family (the plan of the subscription
       * that just ended). Without it — reconciliation fallback — every SCHEDULED row is
       * evaluated against the Stripe subscriptions of ITS OWN family only, so a Booty Lab
       * cancellation can never activate a Full Access successor and vice versa.
       */
      forPlan?: TransitionPlanScope;
    },
  ): Promise<Subscription | null> {
    const now = params.now ?? new Date();
    const allScheduled = await tx.subscription.findMany({
      where: {
        studioId: params.studioId,
        userId: params.userId,
        status: SubscriptionStatus.SCHEDULED,
        source: SubscriptionSource.CASH,
      },
      include: { membershipPlan: { select: { id: true, exclusiveGroup: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const scheduledCandidates = params.forPlan
      ? findConflictingMemberships(
          allScheduled.map((r) => ({
            row: r,
            membershipPlanId: r.membershipPlanId,
            exclusiveGroupKey: r.exclusiveGroupKey,
          })),
          params.forPlan,
        ).map((c) => c.row)
      : allScheduled;
    if (scheduledCandidates.length === 0) {
      // Already activated by a concurrent worker — treat as success/no-op.
      return null;
    }

    const stripeRenewables = (await tx.subscription.findMany({
      where: {
        studioId: params.studioId,
        userId: params.userId,
        stripeSubscriptionId: { not: null },
        status: { in: RENEWABLE_SUBSCRIPTION_STATUSES },
      },
      include: { membershipPlan: true },
      orderBy: { createdAt: 'desc' },
    })) as StripeSubWithPlan[];

    for (const scheduled of scheduledCandidates) {
      const familyScope: TransitionPlanScope = {
        id: scheduled.membershipPlanId,
        exclusiveGroup: scheduled.exclusiveGroupKey,
      };
      // Only a Stripe subscription in the SAME family blocks this successor's activation.
      const stripeRenewable =
        findConflictingMemberships(
          stripeRenewables.map((s) => ({
            row: s,
            membershipPlanId: s.membershipPlanId,
            exclusiveGroupKey: s.exclusiveGroupKey,
          })),
          familyScope,
        )[0]?.row ?? null;

      if (stripeRenewable) {
        const periodEnd = stripeRenewable.currentPeriodEnd;
        if (periodEnd && periodEnd > now) {
          continue;
        }
        await tx.subscription.update({
          where: { id: stripeRenewable.id },
          data: {
            status: SubscriptionStatus.CANCELED,
            cancelAtPeriodEnd: false,
            endReason: SubscriptionEndReason.SUPERSEDED_PAYMENT_METHOD,
            supersededBySubscriptionId: scheduled.id,
          },
        });
      } else {
        // Orphan-link recovery, scoped to this successor's own family: only a CANCELED
        // Stripe row it actually superseded may be linked to it.
        const cancelledStripeRows = await tx.subscription.findMany({
          where: {
            studioId: params.studioId,
            userId: params.userId,
            source: SubscriptionSource.STRIPE,
            status: SubscriptionStatus.CANCELED,
            supersededBySubscriptionId: null,
            endReason: SubscriptionEndReason.SUPERSEDED_PAYMENT_METHOD,
          },
          include: { membershipPlan: { select: { exclusiveGroup: true } } },
        });
        const linkable = findConflictingMemberships(
          cancelledStripeRows.map((r) => ({
            row: r,
            membershipPlanId: r.membershipPlanId,
            exclusiveGroupKey: r.exclusiveGroupKey,
          })),
          familyScope,
        ).map((c) => c.row.id);
        if (linkable.length > 0) {
          await tx.subscription.updateMany({
            where: { id: { in: linkable } },
            data: { supersededBySubscriptionId: scheduled.id },
          });
        }
      }

      // Conditional promote: only one concurrent transaction can move SCHEDULED → ACTIVE.
      const promoted = await tx.subscription.updateMany({
        where: {
          id: scheduled.id,
          status: SubscriptionStatus.SCHEDULED,
        },
        data: { status: SubscriptionStatus.ACTIVE },
      });
      if (promoted.count === 0) {
        continue;
      }

      const activated = await tx.subscription.findUniqueOrThrow({
        where: { id: scheduled.id },
      });

      this.logger.log(
        JSON.stringify({
          event: 'stripe_to_cash_scheduled_activated',
          studioId: params.studioId,
          userId: params.userId,
          scheduledCashId: activated.id,
          activatedAt: now.toISOString(),
        }),
      );

      return activated;
    }

    return null;
  }

  /** Reconciliation / missed-webhook fallback for one member (all families evaluated). */
  async reconcileScheduledCashForMember(studioId: string, userId: string): Promise<boolean> {
    const activated = await this.prisma.$transaction((tx) =>
      this.activateScheduledCashIfDue(tx, { studioId, userId }),
    );
    return Boolean(activated);
  }
}
