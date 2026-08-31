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

type StripeSubWithPlan = Subscription & { membershipPlan: MembershipPlan };

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
   * Cancel Stripe immediately and mark the local row CANCELED.
   * Idempotent when local is already CANCELED (recovery after Stripe-succeeded / DB-failed).
   */
  async cancelStripeImmediately(params: {
    studioId: string;
    userId: string;
  }): Promise<(StripeSubWithPlan & { stripeIdempotencyKey: string | null }) | null> {
    const stripeSub = await this.findPrimaryStripeSubscription(params.studioId, params.userId);
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
    const stripeSub = await this.findPrimaryStripeSubscription(
      params.studioId,
      params.targetUserId,
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

    const existingScheduled = await this.findPendingScheduledCash(
      params.studioId,
      params.targetUserId,
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
        const subscription = await tx.subscription.create({
          data: {
            studioId: params.studioId,
            userId: params.targetUserId,
            membershipPlanId: params.plan.id,
            status: SubscriptionStatus.SCHEDULED,
            source: SubscriptionSource.CASH,
            stripeSubscriptionId: null,
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
        const raced = await this.findPendingScheduledCash(params.studioId, params.targetUserId);
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
    params: { studioId: string; userId: string; now?: Date },
  ): Promise<Subscription | null> {
    const now = params.now ?? new Date();
    const scheduled = await tx.subscription.findFirst({
      where: {
        studioId: params.studioId,
        userId: params.userId,
        status: SubscriptionStatus.SCHEDULED,
        source: SubscriptionSource.CASH,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!scheduled) {
      // Already activated by a concurrent worker — treat as success/no-op.
      return null;
    }

    const stripeRenewable = await tx.subscription.findFirst({
      where: {
        studioId: params.studioId,
        userId: params.userId,
        stripeSubscriptionId: { not: null },
        status: { in: RENEWABLE_SUBSCRIPTION_STATUSES },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (stripeRenewable) {
      const periodEnd = stripeRenewable.currentPeriodEnd;
      if (periodEnd && periodEnd > now) {
        return null;
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
      await tx.subscription.updateMany({
        where: {
          studioId: params.studioId,
          userId: params.userId,
          source: SubscriptionSource.STRIPE,
          status: SubscriptionStatus.CANCELED,
          supersededBySubscriptionId: null,
          endReason: SubscriptionEndReason.SUPERSEDED_PAYMENT_METHOD,
        },
        data: { supersededBySubscriptionId: scheduled.id },
      });
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
      return null;
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

  /** Reconciliation / missed-webhook fallback for one member. */
  async reconcileScheduledCashForMember(studioId: string, userId: string): Promise<boolean> {
    const activated = await this.prisma.$transaction((tx) =>
      this.activateScheduledCashIfDue(tx, { studioId, userId }),
    );
    return Boolean(activated);
  }
}
