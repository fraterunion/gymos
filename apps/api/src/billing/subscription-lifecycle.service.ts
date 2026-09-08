import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  Prisma,
  SubscriptionEndReason,
  SubscriptionStatus,
  type MembershipPlan,
  type Subscription,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../stripe/stripe.service';
import { RENEWABLE_SUBSCRIPTION_STATUSES } from './subscription-lifecycle.constants';
import { SubscriptionReconciliationService } from './subscription-reconciliation.service';
import { currentlyEntitledSubscriptionWhere } from '../memberships/membership-entitlement';
import { findConflictingMemberships } from '../memberships/membership-compatibility';
import {
  buildImmediateUpgradeUpdateParams,
  readCurrentStripePriceId,
  readPendingPlanIdFromMetadata,
  resolvePlanIdForStripePrice,
} from './subscription-plan-resolution.utils';
import {
  isUpgrade,
  subscriptionLockKey,
  toPlanSummary,
  type PlanSummary,
} from './subscription-lifecycle.utils';
import { buildGymosRenewalIdempotencyKey } from './stripe-renewal-audit.utils';

export type MembershipCheckoutResponse =
  | { action: 'checkout'; url: string }
  | {
      action: 'plan_changed';
      effective: 'immediate' | 'next_period';
      message: string;
      subscriptionId: string;
      stripeSubscriptionId: string;
      previousPlan: PlanSummary;
      newPlan: PlanSummary;
      nextRenewalAt: string | null;
      requiresPayment?: boolean;
      paymentUrl?: string | null;
    };

type SubscriptionWithPlan = Subscription & { membershipPlan: MembershipPlan };

@Injectable()
export class SubscriptionLifecycleService {
  private readonly logger = new Logger(SubscriptionLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    @Optional() private readonly reconciliation?: SubscriptionReconciliationService,
  ) {}

  async findCurrentRenewableSubscription(
    studioId: string,
    userId: string,
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<SubscriptionWithPlan | null> {
    const now = new Date();
    return tx.subscription.findFirst({
      where: {
        studioId,
        userId,
        OR: [
          {
            stripeSubscriptionId: { not: null },
            status: { in: RENEWABLE_SUBSCRIPTION_STATUSES },
          },
          {
            stripeSubscriptionId: null,
            ...currentlyEntitledSubscriptionWhere(now),
          },
        ],
      },
      orderBy: [{ createdAt: 'desc' }],
      include: { membershipPlan: true },
    }) as Promise<SubscriptionWithPlan | null>;
  }

  /** MM-1: plural variant — ALL current renewable/entitled memberships, newest first. */
  async findCurrentRenewableSubscriptions(
    studioId: string,
    userId: string,
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<SubscriptionWithPlan[]> {
    const now = new Date();
    return tx.subscription.findMany({
      where: {
        studioId,
        userId,
        OR: [
          {
            stripeSubscriptionId: { not: null },
            status: { in: RENEWABLE_SUBSCRIPTION_STATUSES },
          },
          {
            stripeSubscriptionId: null,
            ...currentlyEntitledSubscriptionWhere(now),
          },
        ],
      },
      orderBy: [{ createdAt: 'desc' }],
      include: { membershipPlan: true },
    }) as Promise<SubscriptionWithPlan[]>;
  }

  async findPrimaryStripeSubscription(
    studioId: string,
    userId: string,
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<SubscriptionWithPlan | null> {
    return tx.subscription.findFirst({
      where: {
        studioId,
        userId,
        stripeSubscriptionId: { not: null },
        status: { in: RENEWABLE_SUBSCRIPTION_STATUSES },
      },
      orderBy: [{ createdAt: 'desc' }],
      include: { membershipPlan: true },
    }) as Promise<SubscriptionWithPlan | null>;
  }

  /**
   * MM-1 — plan-scoped replacement for "the member's Stripe subscription": the renewable
   * Stripe subscription that CONFLICTS with purchasing/selling `targetPlan` (same plan, or
   * same non-null exclusive group per membership-compatibility). With the multi-membership
   * gate off this returns any renewable Stripe subscription — the legacy behavior —
   * because every membership then conflicts by definition.
   */
  async findConflictingStripeSubscription(
    studioId: string,
    userId: string,
    targetPlan: { id: string; exclusiveGroup: string | null },
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<SubscriptionWithPlan | null> {
    const subs = (await tx.subscription.findMany({
      where: {
        studioId,
        userId,
        stripeSubscriptionId: { not: null },
        status: { in: RENEWABLE_SUBSCRIPTION_STATUSES },
      },
      orderBy: [{ createdAt: 'desc' }],
      include: { membershipPlan: true },
    })) as SubscriptionWithPlan[];
    const conflicts = findConflictingMemberships(
      subs.map((s) => ({
        row: s,
        membershipPlanId: s.membershipPlanId,
        exclusiveGroupKey: s.exclusiveGroupKey,
      })),
      targetPlan,
    );
    return conflicts[0]?.row ?? null;
  }

  async getPlanChangePreview(params: {
    userId: string;
    studioId: string;
    targetPlanId: string;
  }): Promise<{
    hasCurrentMembership: boolean;
    isPlanChange: boolean;
    currentPlan: PlanSummary | null;
    newPlan: PlanSummary;
    effective: 'immediate' | 'next_period' | 'checkout';
    message: string;
  }> {
    const targetPlan = await this.loadActivePlan(params.studioId, params.targetPlanId);
    const current = await this.findCurrentRenewableSubscription(params.studioId, params.userId);

    if (!current) {
      return {
        hasCurrentMembership: false,
        isPlanChange: false,
        currentPlan: null,
        newPlan: toPlanSummary(targetPlan),
        effective: 'checkout',
        message: 'Compra inicial de membresía.',
      };
    }

    if (
      current.membershipPlanId === targetPlan.id &&
      current.pendingMembershipPlanId == null
    ) {
      throw new BadRequestException('Ya tienes esta membresía activa.');
    }

    const stripePrimary = await this.findPrimaryStripeSubscription(params.studioId, params.userId);
    let upgrade: boolean;
    if (
      stripePrimary &&
      stripePrimary.membershipPlan.stripePriceId &&
      targetPlan.stripePriceId
    ) {
      upgrade = await this.resolveStripeUpgrade(
        stripePrimary.membershipPlan.stripePriceId,
        targetPlan.stripePriceId,
        current.membershipPlan.priceCents,
        targetPlan.priceCents,
      );
    } else {
      upgrade = isUpgrade(current.membershipPlan.priceCents, targetPlan.priceCents);
    }
    const effective =
      stripePrimary && !upgrade ? ('next_period' as const) : ('immediate' as const);

    return {
      hasCurrentMembership: true,
      isPlanChange: true,
      currentPlan: toPlanSummary(current.membershipPlan),
      newPlan: toPlanSummary(targetPlan),
      effective: stripePrimary ? effective : 'checkout',
      message:
        effective === 'next_period'
          ? 'El cambio se aplicará al final del periodo actual.'
          : 'Tu membresía cambiará inmediatamente.',
    };
  }

  async initiateMembershipPurchase(params: {
    targetUserId: string;
    studioId: string;
    planId: string;
    newStripePriceId: string;
    initiatedByUserId?: string;
    idempotencyKey?: string;
    createCheckout: (ctx: {
      targetUserId: string;
      studioId: string;
      planId: string;
      initiatedByUserId?: string;
      idempotencyKey?: string;
    }) => Promise<{ checkoutUrl: string }>;
  }): Promise<MembershipCheckoutResponse> {
    const targetPlan = await this.loadActivePlan(params.studioId, params.planId);

    // Reconciliation safety gate runs BEFORE the local-DB lookup so that Stripe
    // orphans (active Stripe sub with no local row) block the checkout path too.
    // Without this ordering, findPrimaryStripeSubscription returns null → checkout
    // is created → member ends up with two concurrent Stripe subscriptions.
    if (this.reconciliation) {
      await this.reconciliation.assertHealthyForPlanChange(params.studioId, params.targetUserId);
    }

    // MM-1: only a CONFLICTING Stripe subscription (same plan or same exclusive group)
    // routes to plan-change semantics. A compatible stackable plan gets its own checkout —
    // buying Booty Lab while on Full Access must never CHANGE Full Access. With the
    // multi-membership gate off, every renewable Stripe sub conflicts (legacy behavior).
    const stripeSub = await this.findConflictingStripeSubscription(
      params.studioId,
      params.targetUserId,
      targetPlan,
    );

    if (!stripeSub?.stripeSubscriptionId) {
      const { checkoutUrl } = await params.createCheckout(params);
      return { action: 'checkout', url: checkoutUrl };
    }

    if (
      stripeSub.membershipPlanId === targetPlan.id &&
      stripeSub.pendingMembershipPlanId == null
    ) {
      throw new BadRequestException('Member already has this membership plan.');
    }

    return this.changeStripeSubscriptionPlan({
      studioId: params.studioId,
      userId: params.targetUserId,
      localSubscription: stripeSub,
      targetPlan,
      newStripePriceId: params.newStripePriceId,
      initiatedByUserId: params.initiatedByUserId,
      idempotencyKey: params.idempotencyKey,
    });
  }

  async changeStripeSubscriptionPlan(params: {
    studioId: string;
    userId: string;
    localSubscription: SubscriptionWithPlan;
    targetPlan: MembershipPlan;
    newStripePriceId: string;
    initiatedByUserId?: string;
    idempotencyKey?: string;
  }): Promise<Extract<MembershipCheckoutResponse, { action: 'plan_changed' }>> {
    const { localSubscription, targetPlan, newStripePriceId } = params;
    const stripeSubscriptionId = localSubscription.stripeSubscriptionId;
    if (!stripeSubscriptionId) {
      throw new BadRequestException('No Stripe subscription to update.');
    }

    const stripeSub = await this.stripe.retrieveSubscription(stripeSubscriptionId);
    const subscriptionItem = stripeSub.items.data[0];
    if (!subscriptionItem?.id) {
      throw new BadRequestException('Stripe subscription has no items to update.');
    }

    const currentPriceId =
      typeof subscriptionItem.price === 'string'
        ? subscriptionItem.price
        : subscriptionItem.price.id;

    const upgrade = await this.resolveStripeUpgrade(
      currentPriceId,
      newStripePriceId,
      localSubscription.membershipPlan.priceCents,
      targetPlan.priceCents,
    );
    const baseMetadata = {
      userId: params.userId,
      studioId: params.studioId,
      ...(params.initiatedByUserId ? { initiatedByUserId: params.initiatedByUserId } : {}),
    };

    const stripeOptions = {
      idempotencyKey: params.idempotencyKey
        ? `gymos_renewal_${params.idempotencyKey}`
        : buildGymosRenewalIdempotencyKey(),
    };

    let effective: 'immediate' | 'next_period' = 'immediate';
    let updatedStripeSub = stripeSub;

    if (upgrade) {
      updatedStripeSub = await this.stripe.updateSubscription(
        stripeSubscriptionId,
        buildImmediateUpgradeUpdateParams({
          subscriptionItemId: subscriptionItem.id,
          newPriceId: newStripePriceId,
          metadata: {
            ...baseMetadata,
            planId: targetPlan.id,
          },
        }),
        stripeOptions,
      );
    } else {
      effective = 'next_period';
      updatedStripeSub = await this.stripe.scheduleSubscriptionPriceChangeAtPeriodEnd({
        stripeSubscriptionId,
        subscriptionItemId: subscriptionItem.id,
        currentPriceId,
        newPriceId: newStripePriceId,
        metadata: {
          ...baseMetadata,
          pendingPlanId: targetPlan.id,
        },
        idempotencyKey: stripeOptions.idempotencyKey,
      });
    }

    const paymentUrl =
      updatedStripeSub.status === 'incomplete'
        ? await this.stripe.resolveHostedInvoiceUrl(stripeSubscriptionId)
        : null;

    const periodStart = this.readPeriodStart(updatedStripeSub);
    const periodEnd = this.readPeriodEnd(updatedStripeSub);
    const currentStripePriceId = readCurrentStripePriceId(updatedStripeSub);
    const effectivePlanIdFromStripe = await resolvePlanIdForStripePrice(
      this.prisma,
      currentStripePriceId,
    );

    const upgradeApplied =
      effective === 'immediate' &&
      updatedStripeSub.status !== 'incomplete' &&
      effectivePlanIdFromStripe === targetPlan.id;

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${subscriptionLockKey(params.studioId, params.userId)}))`;

      return tx.subscription.update({
        where: { id: localSubscription.id },
        data: {
          membershipPlanId: upgradeApplied
            ? targetPlan.id
            : localSubscription.membershipPlanId,
          pendingMembershipPlanId:
            effective === 'next_period' ? targetPlan.id : null,
          cancelAtPeriodEnd: upgradeApplied ? false : updatedStripeSub.cancel_at_period_end,
          status: this.mapLocalStatus(updatedStripeSub.status),
          ...(periodStart && periodEnd
            ? { currentPeriodStart: periodStart, currentPeriodEnd: periodEnd }
            : {}),
        },
        include: { membershipPlan: true },
      });
    });

    return {
      action: 'plan_changed',
      effective,
      message:
        updatedStripeSub.status === 'incomplete'
          ? 'Se requiere completar el pago para activar el nuevo plan.'
          : effective === 'immediate'
            ? 'Tu membresía cambió inmediatamente.'
            : 'El cambio de plan se aplicará al final del periodo actual.',
      subscriptionId: result.id,
      stripeSubscriptionId,
      previousPlan: toPlanSummary(localSubscription.membershipPlan),
      newPlan: toPlanSummary(targetPlan),
      nextRenewalAt: periodEnd?.toISOString() ?? null,
      requiresPayment: updatedStripeSub.status === 'incomplete',
      paymentUrl,
    };
  }

  /**
   * Read-only detection of multiple renewable subscriptions for the same member/studio.
   * Does NOT mutate Stripe or local rows — production duplicates require manual review.
   * MM-1: two COMPATIBLE memberships (different plan, no shared non-null exclusive group)
   * are legitimate, not duplicates — only same-plan/same-group siblings are flagged.
   * Gate off → every sibling is flagged (legacy behavior).
   */
  async auditDuplicateRenewableSubscriptions(
    tx: Prisma.TransactionClient | PrismaService,
    params: {
      studioId: string;
      userId: string;
      keepSubscriptionId: string;
      keepStripeSubscriptionId?: string | null;
      source: 'webhook' | 'api';
      stripeEventType?: string;
    },
  ): Promise<void> {
    const allSiblings = await tx.subscription.findMany({
      where: {
        studioId: params.studioId,
        userId: params.userId,
        id: { not: params.keepSubscriptionId },
        status: { in: RENEWABLE_SUBSCRIPTION_STATUSES },
      },
      include: {
        membershipPlan: { select: { id: true, name: true, exclusiveGroup: true } },
      },
    });
    const keptRow = await tx.subscription.findUnique({
      where: { id: params.keepSubscriptionId },
      include: { membershipPlan: { select: { id: true, exclusiveGroup: true } } },
    });
    const siblings = keptRow
      ? findConflictingMemberships(
          allSiblings.map((s) => ({
            row: s,
            membershipPlanId: s.membershipPlanId,
            exclusiveGroupKey: s.exclusiveGroupKey,
          })),
          { id: keptRow.membershipPlanId, exclusiveGroup: keptRow.membershipPlan.exclusiveGroup },
        ).map((c) => c.row)
      : allSiblings;

    if (siblings.length === 0) return;

    this.logger.warn(
      JSON.stringify({
        event: 'renewable_subscription_duplicate_detected',
        source: params.source,
        stripeEventType: params.stripeEventType ?? null,
        studioId: params.studioId,
        userId: params.userId,
        keepSubscriptionId: params.keepSubscriptionId,
        keepStripeSubscriptionId: params.keepStripeSubscriptionId ?? null,
        duplicates: siblings.map((s) => ({
          id: s.id,
          stripeSubscriptionId: s.stripeSubscriptionId,
          membershipPlanId: s.membershipPlanId,
          planName: s.membershipPlan.name,
          status: s.status,
          source: s.source,
          cancelAtPeriodEnd: s.cancelAtPeriodEnd,
          createdAt: s.createdAt.toISOString(),
        })),
        action: 'audit_only_no_stripe_mutation',
      }),
    );
  }

  /**
   * Gate for ordinary offline cash assignment.
   * Period-end Stripe→Cash MUST use StripeToCashTransitionService.scheduleCashAtStripePeriodEnd
   * (cancel_at_period_end is rejected here — the old path created ACTIVE cash immediately).
   */
  async assertNoRenewableSubscriptionConflict(params: {
    studioId: string;
    userId: string;
    allowStripeResolution?: 'cancel_immediately' | 'cancel_at_period_end';
    /** MM-1: when provided, only a same-plan/same-group Stripe subscription conflicts. */
    targetPlan?: { id: string; exclusiveGroup: string | null };
  }): Promise<void> {
    const stripeSub = params.targetPlan
      ? await this.findConflictingStripeSubscription(params.studioId, params.userId, params.targetPlan)
      : await this.findPrimaryStripeSubscription(params.studioId, params.userId);
    if (!stripeSub?.stripeSubscriptionId) return;

    if (!params.allowStripeResolution) {
      throw new ConflictException({
        statusCode: 409,
        code: 'STRIPE_RENEWABLE_CONFLICT',
        message:
          'Este miembro tiene una suscripción activa en Stripe.',
        stripeConflict: {
          localSubscriptionId: stripeSub.id,
          stripeSubscriptionId: stripeSub.stripeSubscriptionId,
          planId: stripeSub.membershipPlanId,
          planName: stripeSub.membershipPlan.name,
          status: stripeSub.status,
          currentPeriodStart: stripeSub.currentPeriodStart?.toISOString() ?? null,
          currentPeriodEnd: stripeSub.currentPeriodEnd?.toISOString() ?? null,
          cancelAtPeriodEnd: stripeSub.cancelAtPeriodEnd,
          pendingCashTransitionId: null,
          allowedResolutions: [] as const,
        },
      });
    }

    if (params.allowStripeResolution === 'cancel_at_period_end') {
      throw new BadRequestException(
        'cancel_at_period_end must be handled via scheduleCashAtStripePeriodEnd (no immediate ACTIVE cash).',
      );
    }

    if (params.allowStripeResolution === 'cancel_immediately') {
      try {
        await this.stripe.cancelSubscription(stripeSub.stripeSubscriptionId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/already been canceled|No such subscription/i.test(message)) {
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
    }
  }

  /**
   * Reconcile local effective/pending plans from Stripe subscription state.
   * Called by webhooks — Stripe current item price is the effective plan source of truth.
   */
  async reconcileSubscriptionPlansFromStripe(
    tx: Prisma.TransactionClient,
    input: {
      stripeSubscriptionId: string;
      stripePriceId: string | null;
      metadata: Record<string, string> | null | undefined;
      fallbackPlanId?: string | null;
    },
  ): Promise<{ membershipPlanId: string | null; pendingMembershipPlanId: string | null }> {
    const effectivePlanId =
      (await resolvePlanIdForStripePrice(tx, input.stripePriceId)) ??
      input.fallbackPlanId ??
      null;

    const metadataPendingPlanId = readPendingPlanIdFromMetadata(input.metadata);
    let pendingMembershipPlanId: string | null = metadataPendingPlanId;

    if (
      effectivePlanId &&
      pendingMembershipPlanId &&
      effectivePlanId === pendingMembershipPlanId
    ) {
      pendingMembershipPlanId = null;
    }

    if (!effectivePlanId) {
      return {
        membershipPlanId: input.fallbackPlanId ?? null,
        pendingMembershipPlanId,
      };
    }

    return { membershipPlanId: effectivePlanId, pendingMembershipPlanId };
  }

  private async loadActivePlan(studioId: string, planId: string): Promise<MembershipPlan> {
    const plan = await this.prisma.membershipPlan.findFirst({
      where: { id: planId, studioId, deletedAt: null, active: true },
    });
    if (!plan) throw new NotFoundException('Membership plan not found');
    return plan;
  }

  private readPeriodStart(sub: {
    items?: { data?: Array<{ current_period_start?: number }> };
  }): Date | null {
    const raw = sub.items?.data?.[0]?.current_period_start;
    return raw && raw > 0 ? new Date(raw * 1000) : null;
  }

  private readPeriodEnd(sub: {
    items?: { data?: Array<{ current_period_end?: number }> };
  }): Date | null {
    const raw = sub.items?.data?.[0]?.current_period_end;
    return raw && raw > 0 ? new Date(raw * 1000) : null;
  }

  /**
   * Retrieve both Stripe Prices and classify the move as an upgrade (true) or
   * downgrade (false).  Falls back to local priceCents when Stripe returns
   * unit_amount=null (metered / usage-based prices).
   * Shared by getPlanChangePreview and changeStripeSubscriptionPlan so the two
   * paths can never drift apart.
   */
  private async resolveStripeUpgrade(
    currentPriceId: string,
    targetPriceId: string,
    currentFallbackCents: number,
    targetFallbackCents: number,
  ): Promise<boolean> {
    const [currentPrice, targetPrice] = await Promise.all([
      this.stripe.retrievePrice(currentPriceId),
      this.stripe.retrievePrice(targetPriceId),
    ]);
    return isUpgrade(
      currentPrice.unit_amount ?? currentFallbackCents,
      targetPrice.unit_amount ?? targetFallbackCents,
    );
  }

  private mapLocalStatus(stripeStatus: string): SubscriptionStatus {
    switch (stripeStatus) {
      case 'active':
        return SubscriptionStatus.ACTIVE;
      case 'trialing':
        return SubscriptionStatus.TRIALING;
      case 'past_due':
        return SubscriptionStatus.PAST_DUE;
      case 'paused':
        return SubscriptionStatus.PAUSED;
      case 'canceled':
        return SubscriptionStatus.CANCELED;
      default:
        return SubscriptionStatus.ACTIVE;
    }
  }
}
