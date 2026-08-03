import { Injectable } from '@nestjs/common';
import { PaymentStatus, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { analyticsExcludedSubscriptionFilter } from './analytics-exclusion.utils';
import { assertStudioTimezone } from './analytics-timezone.utils';
import type {
  FinancialActivityItemDto,
  FinancialActivityQuery,
  FinancialActivityResponseDto,
  FinancialActivitySummaryDto,
  FirstSucceededPaymentIndex,
} from './financial-activity.types';
import {
  classifyPaymentEventType,
  decodeActivityCursor,
  encodeActivityCursor,
  financialActivityEventLabel,
  financialActivityMethodLabel,
  financialActivityStatusLabel,
  FINANCIAL_ACTIVITY_DEFAULT_LIMIT,
  FINANCIAL_ACTIVITY_MAX_LIMIT,
  indexFirstSucceededPayments,
  isFirstSucceededPaymentOnSubscription,
  mapPaymentMethod,
  mapPaymentStatus,
  matchesCategoryFilter,
  paymentDedupKey,
  paymentFailureReason,
  resolveNextRenewalAt,
  shouldSuppressSubscriptionTrialRow,
  subscriptionCancelDedupKey,
  subscriptionTrialDedupKey,
  type PaymentActivityInput,
  type SubscriptionActivityInput,
} from './financial-activity.utils';

function fullName(firstName: string, lastName: string): string {
  return `${firstName} ${lastName}`.trim();
}

function memberHref(userId: string): string {
  return `/members/${userId}`;
}

type SupplementalSubscription = SubscriptionActivityInput & {
  user: { id: string; firstName: string; lastName: string };
};

/**
 * Query strategy for first-payment vs renewal classification:
 * 1. Fetch all payments in the requested period (single findMany).
 * 2. Collect distinct subscriptionIds from those payments.
 * 3. One bounded SQL query (DISTINCT ON) returns the earliest SUCCEEDED payment id
 *    per subscription across all time — no N+1 per payment row.
 */
@Injectable()
export class FinancialActivityService {
  constructor(private readonly prisma: PrismaService) {}

  async getFinancialActivity(
    studioId: string,
    query: FinancialActivityQuery,
  ): Promise<FinancialActivityResponseDto> {
    const now = new Date();
    const studio = await this.prisma.studio.findUnique({
      where: { id: studioId },
      select: { timezone: true },
    });
    const timezone = assertStudioTimezone(studio?.timezone ?? 'UTC');

    const { from, to } = this.resolvePeriod(query, now, timezone);
    const limit = Math.min(
      Math.max(query.limit ?? FINANCIAL_ACTIVITY_DEFAULT_LIMIT, 1),
      FINANCIAL_ACTIVITY_MAX_LIMIT,
    );

    const paymentsRaw = await this.fetchPayments(studioId, from, to);
    const payments: PaymentActivityInput[] = paymentsRaw.map((p) => ({
      id: p.id,
      studioId: p.studioId,
      userId: p.userId,
      membershipPlanId: p.membershipPlanId,
      amountCents: p.amountCents,
      currency: p.currency,
      status: p.status,
      paymentMethod: p.paymentMethod,
      paidAt: p.paidAt,
      createdAt: p.createdAt,
      notes: p.notes,
      subscriptionId: p.subscriptionId,
      user: p.user,
      membershipPlan: p.membershipPlan,
      subscription: p.subscription,
    }));

    const subscriptionIds = [
      ...new Set(
        payments
          .map((p) => p.subscriptionId)
          .filter((id): id is string => id != null),
      ),
    ];

    const [currency, firstSucceededBySub, supplementalSubs] = await Promise.all([
      this.resolveCurrency(studioId),
      this.fetchFirstSucceededPaymentIds(studioId, subscriptionIds),
      this.fetchSupplementalSubscriptions(studioId, from, to),
    ]);

    const paymentEvents = this.buildPaymentEvents(
      payments,
      firstSucceededBySub,
      currency,
    );
    const subscriptionEvents = this.buildSubscriptionEvents(
      supplementalSubs,
      payments,
      currency,
    );

    const merged = this.deduplicateAndSort([...paymentEvents, ...subscriptionEvents]);
    const filtered = this.applyFilters(merged, query);
    const summary = this.buildSummary(filtered);
    const paginated = this.paginate(filtered, query.cursor, limit);

    return {
      currency,
      timezone,
      period: { from: from.toISOString(), to: to.toISOString() },
      summary,
      items: paginated.items,
      pagination: {
        nextCursor: paginated.nextCursor,
        hasMore: paginated.hasMore,
        totalCount: filtered.length,
      },
      generatedAt: now.toISOString(),
    };
  }

  private resolvePeriod(
    query: FinancialActivityQuery,
    now: Date,
    timezone: string,
  ): { from: Date; to: Date } {
    if (query.from && query.to) {
      const from = new Date(query.from);
      const to = new Date(query.to);
      if (!Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime())) {
        return { from, to: to.getTime() >= from.getTime() ? to : now };
      }
    }

    const to = now;
    const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    void timezone;
    return { from, to };
  }

  private async fetchPayments(studioId: string, from: Date, to: Date) {
    return this.prisma.payment.findMany({
      where: {
        studioId,
        OR: [
          { paidAt: { gte: from, lte: to } },
          { paidAt: null, createdAt: { gte: from, lte: to } },
        ],
      },
      orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }],
      include: {
        user: { select: { id: true, firstName: true, lastName: true } },
        membershipPlan: { select: { name: true, priceCents: true } },
        subscription: {
          select: {
            id: true,
            status: true,
            cancelAtPeriodEnd: true,
            currentPeriodEnd: true,
            createdAt: true,
            userId: true,
            membershipPlanId: true,
          },
        },
      },
    });
  }

  /** One bounded lookup: earliest SUCCEEDED payment id per subscription. */
  private async fetchFirstSucceededPaymentIds(
    studioId: string,
    subscriptionIds: string[],
  ): Promise<FirstSucceededPaymentIndex> {
    if (subscriptionIds.length === 0) return new Map();

    const rows = await this.prisma.$queryRaw<
      Array<{ subscription_id: string; first_payment_id: string }>
    >`
      SELECT DISTINCT ON (p.subscription_id)
        p.subscription_id,
        p.id AS first_payment_id
      FROM payments p
      WHERE p.studio_id = ${studioId}
        AND p.subscription_id = ANY(${subscriptionIds}::text[])
        AND p.status = 'SUCCEEDED'
      ORDER BY p.subscription_id, COALESCE(p.paid_at, p.created_at) ASC, p.id ASC
    `;

    return indexFirstSucceededPayments(rows);
  }

  private async fetchSupplementalSubscriptions(
    studioId: string,
    from: Date,
    to: Date,
  ): Promise<SupplementalSubscription[]> {
    const rows = await this.prisma.subscription.findMany({
      where: {
        studioId,
        ...analyticsExcludedSubscriptionFilter(studioId),
        OR: [
          {
            status: SubscriptionStatus.TRIALING,
            createdAt: { gte: from, lte: to },
          },
          {
            status: SubscriptionStatus.CANCELED,
            updatedAt: { gte: from, lte: to },
          },
        ],
      },
      select: {
        id: true,
        studioId: true,
        userId: true,
        membershipPlanId: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        membershipPlan: { select: { name: true, priceCents: true, currency: true } },
        user: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    return rows.map((s) => ({
      id: s.id,
      studioId: s.studioId,
      userId: s.userId,
      membershipPlanId: s.membershipPlanId,
      status: s.status,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      membershipPlan: s.membershipPlan,
      user: s.user,
    }));
  }

  private buildPaymentEvents(
    payments: PaymentActivityInput[],
    firstSucceededBySub: FirstSucceededPaymentIndex,
    currency: string,
  ): FinancialActivityItemDto[] {
    const items: FinancialActivityItemDto[] = [];

    for (const p of payments) {
      if (!p.user) continue;

      const method = mapPaymentMethod(p.paymentMethod);
      const status = mapPaymentStatus(p.status);
      const isFirst = isFirstSucceededPaymentOnSubscription(p, firstSucceededBySub);
      const eventType = classifyPaymentEventType(p, isFirst);
      const occurredAt = (p.paidAt ?? p.createdAt).toISOString();
      const resolvedCurrency = p.currency?.toLowerCase() || currency;
      const failureReason =
        status === 'failed'
          ? paymentFailureReason(p.notes) ?? 'Motivo no disponible'
          : null;

      items.push({
        id: paymentDedupKey(p.id),
        occurredAt,
        member: {
          id: p.user.id,
          name: fullName(p.user.firstName, p.user.lastName),
        },
        eventType,
        eventLabel: financialActivityEventLabel(eventType),
        planName: p.membershipPlan?.name ?? null,
        amountCents: p.amountCents,
        currency: resolvedCurrency,
        method,
        methodLabel: financialActivityMethodLabel(method),
        status,
        statusLabel: financialActivityStatusLabel(status),
        nextRenewalAt: resolveNextRenewalAt(p.subscription),
        failureReason,
        actionTarget: status === 'failed' ? 'review' : 'member',
        memberHref: memberHref(p.user.id),
      });
    }

    return items;
  }

  private buildSubscriptionEvents(
    subscriptions: SupplementalSubscription[],
    payments: PaymentActivityInput[],
    currency: string,
  ): FinancialActivityItemDto[] {
    const items: FinancialActivityItemDto[] = [];

    for (const s of subscriptions) {
      const member = {
        id: s.user.id,
        name: fullName(s.user.firstName, s.user.lastName),
      };

      if (s.status === SubscriptionStatus.TRIALING) {
        if (shouldSuppressSubscriptionTrialRow(s, payments)) continue;

        const eventType = 'trial_started' as const;
        items.push({
          id: subscriptionTrialDedupKey(s.id),
          occurredAt: s.createdAt.toISOString(),
          member,
          eventType,
          eventLabel: financialActivityEventLabel(eventType),
          planName: s.membershipPlan.name,
          amountCents: s.membershipPlan.priceCents,
          currency: s.membershipPlan.currency?.toLowerCase() || currency,
          method: 'stripe',
          methodLabel: financialActivityMethodLabel('stripe'),
          status: 'pending',
          statusLabel: financialActivityStatusLabel('pending'),
          nextRenewalAt: null,
          failureReason: null,
          actionTarget: 'member',
          memberHref: memberHref(s.user.id),
        });
        continue;
      }

      if (s.status === SubscriptionStatus.CANCELED) {
        if (s.updatedAt.getTime() - s.createdAt.getTime() < 60_000) continue;

        const eventType = 'subscription_cancelled' as const;
        items.push({
          id: subscriptionCancelDedupKey(s.id, s.updatedAt),
          occurredAt: s.updatedAt.toISOString(),
          member,
          eventType,
          eventLabel: financialActivityEventLabel(eventType),
          planName: s.membershipPlan.name,
          amountCents: null,
          currency: s.membershipPlan.currency?.toLowerCase() || currency,
          method: 'other',
          methodLabel: financialActivityMethodLabel('other'),
          status: 'cancelled',
          statusLabel: financialActivityStatusLabel('cancelled'),
          nextRenewalAt: null,
          failureReason: null,
          actionTarget: 'member',
          memberHref: memberHref(s.user.id),
        });
      }
    }

    return items;
  }

  private deduplicateAndSort(items: FinancialActivityItemDto[]): FinancialActivityItemDto[] {
    const byId = new Map<string, FinancialActivityItemDto>();
    for (const item of items) {
      if (!byId.has(item.id)) {
        byId.set(item.id, item);
      }
    }
    return [...byId.values()].sort(
      (a, b) =>
        new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime() ||
        b.id.localeCompare(a.id),
    );
  }

  private applyFilters(
    items: FinancialActivityItemDto[],
    query: FinancialActivityQuery,
  ): FinancialActivityItemDto[] {
    const search = query.memberSearch?.trim().toLowerCase();

    return items.filter((item) => {
      if (query.method && query.method !== 'all' && item.method !== query.method) {
        return false;
      }
      if (query.eventType && query.eventType !== 'all' && item.eventType !== query.eventType) {
        return false;
      }
      if (query.status && query.status !== 'all' && item.status !== query.status) {
        return false;
      }
      if (!matchesCategoryFilter(query.category, item)) return false;
      if (search && !item.member.name.toLowerCase().includes(search)) return false;
      return true;
    });
  }

  private buildSummary(items: FinancialActivityItemDto[]): FinancialActivitySummaryDto {
    let stripeCollectedCents = 0;
    let cashCollectedCents = 0;
    let failedCount = 0;
    let refundedCents = 0;

    for (const item of items) {
      if (item.status === 'collected' && item.amountCents != null) {
        if (item.method === 'stripe') stripeCollectedCents += item.amountCents;
        if (item.method === 'cash') cashCollectedCents += item.amountCents;
      }
      if (item.status === 'failed') failedCount += 1;
      if (item.status === 'refunded' && item.amountCents != null) {
        refundedCents += item.amountCents;
      }
    }

    return {
      movementCount: items.length,
      stripeCollectedCents,
      cashCollectedCents,
      failedCount,
      refundedCents,
    };
  }

  private paginate(
    items: FinancialActivityItemDto[],
    cursor: string | undefined,
    limit: number,
  ): { items: FinancialActivityItemDto[]; nextCursor: string | null; hasMore: boolean } {
    let startIndex = 0;
    if (cursor) {
      const decoded = decodeActivityCursor(cursor);
      if (decoded) {
        const idx = items.findIndex(
          (item) =>
            item.id === decoded.id &&
            item.occurredAt === decoded.occurredAt,
        );
        if (idx >= 0) startIndex = idx + 1;
      }
    }

    const slice = items.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < items.length;
    const last = slice[slice.length - 1];
    const nextCursor =
      hasMore && last ? encodeActivityCursor(last.occurredAt, last.id) : null;

    return { items: slice, nextCursor, hasMore };
  }

  private async resolveCurrency(studioId: string): Promise<string> {
    const payment = await this.prisma.payment.findFirst({
      where: { studioId, status: PaymentStatus.SUCCEEDED },
      select: { currency: true },
      orderBy: { createdAt: 'desc' },
    });
    if (payment?.currency) return payment.currency.toLowerCase();

    const plan = await this.prisma.membershipPlan.findFirst({
      where: { studioId, active: true },
      select: { currency: true },
    });
    return plan?.currency?.toLowerCase() ?? 'mxn';
  }
}
