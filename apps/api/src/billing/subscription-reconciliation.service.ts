import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { SubscriptionStatus, type MembershipPlan, type Subscription } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../stripe/stripe.service';
import { RENEWABLE_SUBSCRIPTION_STATUSES } from './subscription-lifecycle.constants';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export type ReconciliationStatus =
  | 'healthy'
  | 'local_drift'
  | 'stripe_orphan'
  | 'local_orphan'
  | 'duplicate_renewable'
  | 'price_drift'
  | 'dead_letter_webhooks'
  | 'ambiguous';

export type ReconciliationIssue =
  | {
      kind: 'stripe_orphan';
      stripeSubscriptionId: string;
      stripeStatus: string;
      stripePlanId: string | null;
    }
  | {
      kind: 'local_orphan';
      localSubscriptionId: string;
      localStatus: SubscriptionStatus;
    }
  | {
      kind: 'duplicate_renewable';
      stripeSubscriptionIds: string[];
    }
  | {
      kind: 'status_drift';
      localSubscriptionId: string;
      localStatus: SubscriptionStatus;
      stripeStatus: string;
    }
  | {
      kind: 'cancel_at_period_end_drift';
      localSubscriptionId: string;
      local: boolean;
      stripe: boolean;
    }
  | {
      kind: 'period_drift';
      localSubscriptionId: string;
      field: 'currentPeriodEnd' | 'currentPeriodStart';
      localMs: number;
      stripeMs: number;
    }
  | {
      kind: 'price_drift';
      localSubscriptionId: string;
      planName: string;
      localPriceCents: number;
      stripeUnitAmount: number;
    }
  | {
      kind: 'dead_letter_webhook';
      stripeEventId: string;
      eventType: string;
      createdAt: Date;
    };

export type SafeRepair =
  | { action: 'update_local_status'; localSubscriptionId: string; toStatus: SubscriptionStatus }
  | { action: 'update_local_cancel_at_period_end'; localSubscriptionId: string; to: boolean }
  | {
      action: 'update_local_period_dates';
      localSubscriptionId: string;
      currentPeriodStart: Date | null;
      currentPeriodEnd: Date | null;
    };

export type ReconciliationResult = {
  status: ReconciliationStatus;
  /** True when the state cannot be resolved by safe local repairs alone. Blocks plan changes. */
  requiresManualResolution: boolean;
  /** The single canonical Stripe subscription ID if deterministic; null if ambiguous. */
  canonicalStripeSubscriptionId: string | null;
  issues: ReconciliationIssue[];
  safeRepairs: SafeRepair[];
};

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

const RENEWABLE_STRIPE_STATUSES = new Set(['active', 'trialing', 'past_due', 'paused']);

function mapStripeStatusToLocal(stripeStatus: string): SubscriptionStatus {
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

function dominantStatus(issues: ReconciliationIssue[]): ReconciliationStatus {
  const kinds = new Set(issues.map((i) => i.kind));
  if (kinds.has('duplicate_renewable')) return 'duplicate_renewable';
  if (kinds.has('stripe_orphan')) return 'stripe_orphan';
  if (kinds.has('local_orphan')) return 'local_orphan';
  if (
    kinds.has('status_drift') ||
    kinds.has('cancel_at_period_end_drift') ||
    kinds.has('period_drift')
  )
    return 'local_drift';
  if (kinds.has('price_drift')) return 'price_drift';
  if (kinds.has('dead_letter_webhook')) return 'dead_letter_webhooks';
  return 'healthy';
}

// ──────────────────────────────────────────────────────────────────────────────
// Service
// ──────────────────────────────────────────────────────────────────────────────

@Injectable()
export class SubscriptionReconciliationService {
  private readonly logger = new Logger(SubscriptionReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
  ) {}

  /**
   * Reconcile Stripe ↔ local subscription state for one member in one studio.
   *
   * This method is DETECTION ONLY — it never cancels Stripe subscriptions, issues
   * refunds, or changes prices. Safe local repairs (status sync, cancelAtPeriodEnd
   * sync, period-date sync) are queued in `safeRepairs` and applied only when
   * `applyRepairs=true` is passed AND `requiresManualResolution` is false.
   */
  async reconcile(params: {
    studioId: string;
    userId: string;
    applyRepairs?: boolean;
  }): Promise<ReconciliationResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: params.userId },
      select: { stripeCustomerId: true },
    });

    if (!user?.stripeCustomerId) {
      return {
        status: 'healthy',
        requiresManualResolution: false,
        canonicalStripeSubscriptionId: null,
        issues: [],
        safeRepairs: [],
      };
    }

    const issues: ReconciliationIssue[] = [];
    const safeRepairs: SafeRepair[] = [];

    // 1. Fetch all Stripe subscriptions for this customer, scoped to this studio via metadata
    const allStripeSubs = await this.stripe.listSubscriptionsForCustomer(user.stripeCustomerId);
    const studioStripeSubs = allStripeSubs.filter(
      (s) => s.metadata?.studioId === params.studioId,
    );

    // 2. Fetch all local renewable subscriptions for this member in this studio
    const localSubs = (await this.prisma.subscription.findMany({
      where: {
        studioId: params.studioId,
        userId: params.userId,
        stripeSubscriptionId: { not: null },
        status: { in: RENEWABLE_SUBSCRIPTION_STATUSES },
      },
      include: { membershipPlan: true },
    })) as Array<Subscription & { membershipPlan: MembershipPlan }>;

    const renewableStripeSubs = studioStripeSubs.filter((s) =>
      RENEWABLE_STRIPE_STATUSES.has(s.status),
    );

    // 3. Detect duplicate renewable Stripe subscriptions
    if (renewableStripeSubs.length > 1) {
      issues.push({
        kind: 'duplicate_renewable',
        stripeSubscriptionIds: renewableStripeSubs.map((s) => s.id),
      });
    }

    const localByStripeId = new Map(
      localSubs
        .filter((l) => l.stripeSubscriptionId)
        .map((l) => [l.stripeSubscriptionId!, l]),
    );
    const stripeById = new Map(studioStripeSubs.map((s) => [s.id, s]));

    // 4. Detect Stripe orphans: renewable Stripe sub exists, no local row
    for (const stripeSub of renewableStripeSubs) {
      if (!localByStripeId.has(stripeSub.id)) {
        const priceId =
          typeof stripeSub.items.data[0]?.price === 'string'
            ? stripeSub.items.data[0].price
            : stripeSub.items.data[0]?.price?.id ?? null;
        const planRow = priceId
          ? await this.prisma.membershipPlan.findFirst({
              where: { stripePriceId: priceId },
              select: { id: true },
            })
          : null;
        issues.push({
          kind: 'stripe_orphan',
          stripeSubscriptionId: stripeSub.id,
          stripeStatus: stripeSub.status,
          stripePlanId: planRow?.id ?? null,
        });
      }
    }

    // 5. Detect local orphans: local row exists, Stripe sub is gone or terminal
    for (const localSub of localSubs) {
      const stripeSub = localSub.stripeSubscriptionId
        ? stripeById.get(localSub.stripeSubscriptionId)
        : undefined;
      if (!stripeSub || !RENEWABLE_STRIPE_STATUSES.has(stripeSub.status)) {
        issues.push({
          kind: 'local_orphan',
          localSubscriptionId: localSub.id,
          localStatus: localSub.status,
        });
      }
    }

    // 6. Detect drift for locally-tracked subscriptions that have a Stripe counterpart
    for (const localSub of localSubs) {
      const stripeSub = localSub.stripeSubscriptionId
        ? stripeById.get(localSub.stripeSubscriptionId)
        : undefined;
      if (!stripeSub) continue;

      // Status drift
      const expectedStatus = mapStripeStatusToLocal(stripeSub.status);
      if (localSub.status !== expectedStatus) {
        issues.push({
          kind: 'status_drift',
          localSubscriptionId: localSub.id,
          localStatus: localSub.status,
          stripeStatus: stripeSub.status,
        });
        safeRepairs.push({
          action: 'update_local_status',
          localSubscriptionId: localSub.id,
          toStatus: expectedStatus,
        });
      }

      // cancelAtPeriodEnd drift
      if (localSub.cancelAtPeriodEnd !== stripeSub.cancel_at_period_end) {
        issues.push({
          kind: 'cancel_at_period_end_drift',
          localSubscriptionId: localSub.id,
          local: localSub.cancelAtPeriodEnd,
          stripe: stripeSub.cancel_at_period_end,
        });
        safeRepairs.push({
          action: 'update_local_cancel_at_period_end',
          localSubscriptionId: localSub.id,
          to: stripeSub.cancel_at_period_end,
        });
      }

      // Period-end drift (>1 hour tolerance)
      const stripeEndRaw = stripeSub.items.data[0]?.current_period_end;
      const localEnd = localSub.currentPeriodEnd;
      if (stripeEndRaw && localEnd) {
        const diffMs = Math.abs(stripeEndRaw * 1000 - localEnd.getTime());
        if (diffMs > 60 * 60 * 1000) {
          issues.push({
            kind: 'period_drift',
            localSubscriptionId: localSub.id,
            field: 'currentPeriodEnd',
            localMs: localEnd.getTime(),
            stripeMs: stripeEndRaw * 1000,
          });
          const stripeStartRaw = stripeSub.items.data[0]?.current_period_start;
          safeRepairs.push({
            action: 'update_local_period_dates',
            localSubscriptionId: localSub.id,
            currentPeriodStart: stripeStartRaw ? new Date(stripeStartRaw * 1000) : null,
            currentPeriodEnd: new Date(stripeEndRaw * 1000),
          });
        }
      }

      // Price drift: Stripe unit_amount ≠ local plan priceCents
      const stripeItem = stripeSub.items.data[0];
      const stripeUnitAmount =
        typeof stripeItem?.price === 'object' ? stripeItem.price?.unit_amount : null;
      const localPriceCents = localSub.membershipPlan?.priceCents;
      if (stripeUnitAmount != null && localPriceCents != null && stripeUnitAmount !== localPriceCents) {
        issues.push({
          kind: 'price_drift',
          localSubscriptionId: localSub.id,
          planName: localSub.membershipPlan.name,
          localPriceCents,
          stripeUnitAmount,
        });
      }
    }

    // 7. Detect permanently-failed (dead-letter) webhook events
    const deadLetters = await this.prisma.stripeWebhookEvent.findMany({
      where: {
        processed: false,
        createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    for (const dl of deadLetters) {
      issues.push({
        kind: 'dead_letter_webhook',
        stripeEventId: dl.stripeEventId,
        eventType: dl.eventType,
        createdAt: dl.createdAt,
      });
    }

    const status = issues.length === 0 ? 'healthy' : dominantStatus(issues);
    const requiresManualResolution =
      status === 'duplicate_renewable' ||
      status === 'stripe_orphan' ||
      status === 'local_orphan' ||
      status === 'ambiguous';

    // Canonical subscription: only deterministic when exactly one renewable Stripe sub
    let canonicalStripeSubscriptionId: string | null = null;
    if (renewableStripeSubs.length === 1) {
      canonicalStripeSubscriptionId = renewableStripeSubs[0].id;
    }

    if (issues.length > 0) {
      this.logger.warn(
        JSON.stringify({
          event: 'billing_reconciliation_issues_detected',
          studioId: params.studioId,
          userId: params.userId,
          status,
          issueCount: issues.length,
          issueKinds: issues.map((i) => i.kind),
          requiresManualResolution,
        }),
      );
    }

    const result: ReconciliationResult = {
      status,
      requiresManualResolution,
      canonicalStripeSubscriptionId,
      issues,
      safeRepairs,
    };

    if (params.applyRepairs && safeRepairs.length > 0 && !requiresManualResolution) {
      await this.applySafeRepairs(safeRepairs);
    }

    return result;
  }

  /**
   * Pre-flight check before any plan change. Throws ConflictException if the
   * member's billing state requires manual reconciliation (duplicate Stripe subs,
   * orphaned Stripe sub, etc.).
   *
   * Safe local drift (status, cancelAtPeriodEnd, period dates) does NOT block
   * plan changes — it is auto-repaired by incoming webhooks.
   */
  async assertHealthyForPlanChange(studioId: string, userId: string): Promise<void> {
    const result = await this.reconcile({ studioId, userId });
    if (!result.requiresManualResolution) return;
    throw new ConflictException({
      code: 'BILLING_STATE_REQUIRES_RECONCILIATION',
      message:
        'Member has an unresolved billing inconsistency. Manual reconciliation is required before changing plans.',
      reconciliationStatus: result.status,
      issues: result.issues.map((i) => i.kind),
    });
  }

  /** Apply safe local-DB-only repairs produced by reconcile(). Never touches Stripe. */
  async applySafeRepairs(repairs: SafeRepair[]): Promise<{ applied: number }> {
    let applied = 0;
    for (const repair of repairs) {
      if (repair.action === 'update_local_status') {
        await this.prisma.subscription.update({
          where: { id: repair.localSubscriptionId },
          data: { status: repair.toStatus },
        });
        applied++;
      } else if (repair.action === 'update_local_cancel_at_period_end') {
        await this.prisma.subscription.update({
          where: { id: repair.localSubscriptionId },
          data: { cancelAtPeriodEnd: repair.to },
        });
        applied++;
      } else if (repair.action === 'update_local_period_dates') {
        const data: Record<string, Date> = {};
        if (repair.currentPeriodStart) data.currentPeriodStart = repair.currentPeriodStart;
        if (repair.currentPeriodEnd) data.currentPeriodEnd = repair.currentPeriodEnd;
        if (Object.keys(data).length > 0) {
          await this.prisma.subscription.update({
            where: { id: repair.localSubscriptionId },
            data,
          });
          applied++;
        }
      }
    }
    return { applied };
  }
}
