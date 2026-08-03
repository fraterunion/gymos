import { Injectable, Logger } from '@nestjs/common';
import {
  PaymentMethod,
  PaymentStatus,
  SubscriptionStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  analyticsExcludedSubscriptionFilter,
  analyticsMemberMembershipWhere,
  SQL_MEMBERSHIP_ROW_INCLUDE,
} from './analytics-exclusion.utils';
import { fillStudioLocalTrendDays, assertStudioTimezone } from './analytics-timezone.utils';
import {
  EXECUTIVE_QUERY_BUDGET,
  sqlFinancialCore,
  sqlMembershipStats,
  sqlMonthTrend,
  sqlOperationsToday,
  sqlPlanAttributionMonth,
  sqlTopMembers,
} from './executive-dashboard.aggregate';
import { financialPeriodWindows, pctChange } from './financial-period.utils';
import { dayWindows, pctChange as briefingPctChange } from './owner-briefing.utils';
import {
  buildExecutiveDataQuality,
  buildExecutiveReconciliation,
  computeEstimatedMrrCents,
  paymentMethodOwnerLabel,
} from './executive-dashboard.utils';
import {
  buildExecutiveInsights,
  categorizePlan,
  relativeTimeLabel,
} from './executive-insights.utils';
import type {
  ExecutiveActivityEventDto,
  ExecutiveDashboardDto,
  ExecutiveFailedPaymentDto,
  ExecutiveKpiDto,
  ExecutiveMemberRiskDto,
  ExecutiveTopMemberDto,
  ExecutiveUpcomingRenewalDto,
} from './executive-dashboard.types';

function memberHref(userId: string): string {
  return `/members/${userId}`;
}

function fullName(firstName: string, lastName: string): string {
  return `${firstName} ${lastName}`.trim();
}

@Injectable()
export class ExecutiveDashboardService {
  private readonly logger = new Logger(ExecutiveDashboardService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Documented query budget — see executive-dashboard.aggregate.ts */
  static readonly QUERY_BUDGET = EXECUTIVE_QUERY_BUDGET;

  async getExecutiveDashboard(studioId: string): Promise<ExecutiveDashboardDto> {
    const now = new Date();
    const studio = await this.prisma.studio.findUnique({
      where: { id: studioId },
      select: { timezone: true },
    });
    const timezone = assertStudioTimezone(studio?.timezone ?? 'UTC');
    const monthWindows = financialPeriodWindows(now, timezone, 'month');
    const { todayStart, tomorrowStart } = dayWindows(now, timezone);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const prevThirtyStart = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    const inactiveSince = new Date(now.getTime() - 21 * 24 * 60 * 60 * 1000);
    const monthStartLocal = monthWindows.periodStart;

    const [
      currencyRow,
      financialCore,
      monthTrendRaw,
      planAttributionRaw,
      membershipStats,
      operations,
      topMembersRow,
      subscriptionRows,
      activityPayments,
      activityNewSubs,
      upcomingSubs,
      failedPaymentRows,
      inactiveRiskRows,
      riskSubscriptions,
      longestMembership,
      newestMembership,
      stripePlansConfigured,
    ] = await Promise.all([
      this.resolveCurrency(studioId),
      this.prisma.$queryRaw<
        import('./executive-dashboard.aggregate').ExecutiveFinancialCoreRow[]
      >(sqlFinancialCore(studioId, todayStart, now, monthWindows)),
      this.prisma.$queryRaw<
        import('./executive-dashboard.aggregate').ExecutiveMonthTrendRow[]
      >(sqlMonthTrend(studioId, monthWindows, timezone)),
      this.prisma.$queryRaw<
        import('./executive-dashboard.aggregate').ExecutivePlanAttributionRow[]
      >(sqlPlanAttributionMonth(studioId, monthWindows)),
      this.prisma.$queryRaw<
        import('./executive-dashboard.aggregate').ExecutiveMembershipStatsRow[]
      >(sqlMembershipStats(studioId, now, thirtyDaysAgo, prevThirtyStart, inactiveSince)),
      this.prisma.$queryRaw<
        import('./executive-dashboard.aggregate').ExecutiveOperationsRow[]
      >(sqlOperationsToday(studioId, todayStart, tomorrowStart)),
      this.prisma.$queryRaw<
        import('./executive-dashboard.aggregate').ExecutiveTopMembersRow[]
      >(sqlTopMembers(studioId, todayStart, monthStartLocal)),
      this.prisma.subscription.findMany({
        where: {
          studioId,
          status: {
            in: [
              SubscriptionStatus.ACTIVE,
              SubscriptionStatus.TRIALING,
              SubscriptionStatus.PAST_DUE,
              SubscriptionStatus.PAUSED,
              SubscriptionStatus.CANCELED,
            ],
          },
          ...analyticsExcludedSubscriptionFilter(studioId),
        },
        select: {
          status: true,
          cancelAtPeriodEnd: true,
          membershipPlan: { select: { name: true, priceCents: true, billingInterval: true } },
        },
      }),
      this.prisma.payment.findMany({
        where: {
          studioId,
          createdAt: { gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) },
          status: { in: [PaymentStatus.SUCCEEDED, PaymentStatus.FAILED] },
        },
        orderBy: { createdAt: 'desc' },
        take: 25,
        include: {
          user: { select: { id: true, firstName: true, lastName: true } },
          membershipPlan: { select: { name: true } },
          subscription: { select: { id: true } },
        },
      }),
      this.prisma.subscription.findMany({
        where: {
          studioId,
          createdAt: { gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) },
          ...analyticsExcludedSubscriptionFilter(studioId),
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: {
          user: { select: { id: true, firstName: true, lastName: true } },
          membershipPlan: { select: { name: true, priceCents: true } },
        },
      }),
      this.fetchUpcomingRenewals(studioId, now),
      this.fetchFailedPayments(studioId),
      this.prisma.$queryRaw<{ user_id: string; first_name: string; last_name: string }[]>`
        SELECT sm.user_id, u.first_name, u.last_name
        FROM studio_memberships sm
        INNER JOIN users u ON u.id = sm.user_id
        WHERE sm.studio_id = ${studioId}
          AND sm.role = 'MEMBER'
          AND sm.deleted_at IS NULL
          ${SQL_MEMBERSHIP_ROW_INCLUDE}
          AND NOT EXISTS (
            SELECT 1 FROM attendances a
            WHERE a.studio_id = ${studioId}
              AND a.user_id = sm.user_id
              AND a.checked_in_at >= ${inactiveSince}
          )
        LIMIT 10
      `,
      this.prisma.subscription.findMany({
        where: {
          studioId,
          OR: [
            { status: SubscriptionStatus.PAST_DUE },
            {
              cancelAtPeriodEnd: true,
              status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING] },
            },
            {
              status: SubscriptionStatus.TRIALING,
              currentPeriodEnd: {
                lte: new Date(now.getTime() + 24 * 60 * 60 * 1000),
                gt: now,
              },
            },
          ],
          ...analyticsExcludedSubscriptionFilter(studioId),
        },
        take: 15,
        include: { user: { select: { id: true, firstName: true, lastName: true } } },
      }),
      this.prisma.studioMembership.findFirst({
        where: analyticsMemberMembershipWhere(studioId),
        orderBy: { createdAt: 'asc' },
        include: { user: { select: { id: true, firstName: true, lastName: true, createdAt: true } } },
      }),
      this.prisma.studioMembership.findFirst({
        where: analyticsMemberMembershipWhere(studioId),
        orderBy: { createdAt: 'desc' },
        include: { user: { select: { id: true, firstName: true, lastName: true } } },
      }),
      this.prisma.membershipPlan.count({
        where: { studioId, active: true, stripePriceId: { not: null } },
      }),
    ]);

    const fin = financialCore[0];
    const stats = membershipStats[0];
    const ops = operations[0];
    const top = topMembersRow[0];

    const currency = currencyRow;
    const revenueTodayCents = Number(fin?.today_cents ?? 0n);
    const revenueMonthCents = Number(fin?.month_cents ?? 0n);
    const prevMonthCents = Number(fin?.prev_month_cents ?? 0n);
    const monthComparisonPercent = briefingPctChange(revenueMonthCents, prevMonthCents);
    const monthPaymentCount = Number(fin?.month_payment_count ?? 0n);
    const monthStripeCents = Number(fin?.month_stripe_cents ?? 0n);
    const monthCashCents = Number(fin?.month_cash_cents ?? 0n);
    const monthOtherCents = Number(fin?.month_other_cents ?? 0n);
    const lifetimeRevenueCents = Number(fin?.lifetime_cents ?? 0n);
    const failedTodayCount = Number(fin?.failed_today ?? 0n);
    const failed30Count = Number(fin?.failed_30d ?? 0n);
    const revenue30dCents = Number(fin?.revenue_30d_cents ?? 0n);
    const lastPaymentAt = fin?.last_payment_at ?? null;

    const revenueBreakdown = {
      subscriptionsCents: Number(fin?.subscriptions_cents ?? 0n),
      oneTimeCents: Number(fin?.one_time_cents ?? 0n),
      retailCents: 0,
      otherCents: Number(fin?.other_breakdown_cents ?? 0n),
      totalCents:
        Number(fin?.subscriptions_cents ?? 0n) +
        Number(fin?.one_time_cents ?? 0n) +
        Number(fin?.other_breakdown_cents ?? 0n),
    };

    const collectedTrend = fillStudioLocalTrendDays(
      monthTrendRaw.map((r) => ({
        d: r.d,
        amount_cents: r.amount_cents,
        payment_count: r.payment_count,
      })),
      monthWindows.periodStart,
      monthWindows.periodEnd,
      timezone,
    );

    const planAttribution = planAttributionRaw.map((r) => ({
      planId: r.plan_id,
      planName: r.plan_name ?? 'Sin atribuir',
      revenueCents: Number(r.revenue_cents),
    }));
    const monthPlanAttributed = planAttribution
      .filter((p) => p.planId != null)
      .reduce((s, p) => s + p.revenueCents, 0);
    const monthUnattributed = planAttribution
      .filter((p) => p.planId == null)
      .reduce((s, p) => s + p.revenueCents, 0);

    const reconciliation = buildExecutiveReconciliation({
      monthCollectedCents: revenueMonthCents,
      monthBreakdownTotalCents: revenueBreakdown.totalCents,
      monthTrendSumCents: collectedTrend.reduce((s, r) => s + r.amountCents, 0),
      monthTrendPaymentCount: collectedTrend.reduce((s, r) => s + r.paymentCount, 0),
      monthPaymentCount,
      monthStripeCents,
      monthCashCents,
      monthOtherCents,
      monthPlanAttributedCents: monthPlanAttributed,
      monthUnattributedCents: monthUnattributed,
    });

    this.logReconciliationFailures(studioId, reconciliation);

    const subsMissingStripeId = Number(stats?.subs_missing_stripe ?? 0n);
    const activeStripeSubsWithoutPayment = Number(stats?.active_stripe_no_payment ?? 0n);

    const dataQuality = buildExecutiveDataQuality({
      lastPaymentAt,
      subsMissingStripeId,
      activeStripeSubscriptionsWithoutPayment: activeStripeSubsWithoutPayment,
      syncMayBeIncomplete: activeStripeSubsWithoutPayment > 0,
    });

    const statusCounts = new Map<SubscriptionStatus, number>();
    for (const s of subscriptionRows) {
      statusCounts.set(s.status, (statusCounts.get(s.status) ?? 0) + 1);
    }

    const mrrCents = computeEstimatedMrrCents(subscriptionRows);
    const activeMembers = Number(stats?.active_members ?? 0n);
    const newMembers30d = Number(stats?.new_members_30d ?? 0n);
    const prevNewMembers30d = Number(stats?.prev_new_members_30d ?? 0n);
    const cancellations30d = Number(stats?.cancellations_30d ?? 0n);
    const inactive21d = Number(stats?.inactive_21d ?? 0n);
    const netGrowth = newMembers30d - cancellations30d;
    const membershipGrowthPercent = pctChange(newMembers30d, prevNewMembers30d);

    const averageRevenuePerMemberCents =
      activeMembers > 0 ? Math.round(revenue30dCents / activeMembers) : 0;

    const topPlan = planAttribution.find((p) => p.planId != null);
    const totalPlanRevenue = planAttribution.reduce((s, p) => s + p.revenueCents, 0);
    const topPlanShare =
      topPlan && totalPlanRevenue > 0
        ? Math.round((topPlan.revenueCents / totalPlanRevenue) * 1000) / 10
        : null;

    const expected7DaysCents = upcomingSubs
      .filter((i) => i.bucket === 'tomorrow' || i.bucket === 'this_week')
      .reduce((s, i) => s + i.amountCents, 0);
    const expected30DaysCents = upcomingSubs.reduce((s, i) => s + i.amountCents, 0);

    const insights = buildExecutiveInsights({
      revenueTodayCents,
      revenueMonthCents,
      revenueMonthComparisonPercent: monthComparisonPercent,
      mrrCents,
      failedPaymentsToday: failedTodayCount,
      failedPaymentsWeek: failed30Count,
      upcoming7DaysCents: expected7DaysCents,
      inactiveMembers21Plus: inactive21d,
      topPlanRevenueSharePercent: topPlanShare,
      topPlanName: topPlan?.planName ?? null,
      netMemberGrowthMonth: netGrowth,
      highestOccupancyClass: null,
      highestOccupancyPercent: null,
    });

    const activity = this.buildActivityFeed(activityPayments, activityNewSubs, now);
    const memberRisk = this.buildMemberRisk(inactiveRiskRows, riskSubscriptions);
    const topMembers = this.buildTopMembers(top, longestMembership, newestMembership, now);
    const planCategoryRows = this.buildPlanCategoryCounts(subscriptionRows);

    const bookedToday = Number(ops?.booked_today ?? 0n);
    const capacityToday = Number(ops?.capacity_today ?? 0n);
    const occupancyRateToday =
      capacityToday > 0 ? Math.round((bookedToday / capacityToday) * 1000) / 10 : 0;

    const kpis: ExecutiveKpiDto[] = [
      {
        id: 'revenue-today',
        label: 'Cobrado hoy',
        value: revenueTodayCents,
        valueKind: 'money',
        comparisonPercent: null,
        comparisonLabel: 'Pagos SUCCEEDED · zona horaria del estudio',
        sparkline: collectedTrend.slice(-7).map((r) => ({
          date: r.date,
          amountCents: r.amountCents,
        })),
      },
      {
        id: 'revenue-month',
        label: 'Cobrado este mes',
        value: revenueMonthCents,
        valueKind: 'money',
        comparisonPercent: monthComparisonPercent,
        comparisonLabel: 'vs mismo punto del mes anterior',
        sparkline: collectedTrend.map((r) => ({ date: r.date, amountCents: r.amountCents })),
      },
      {
        id: 'mrr',
        label: 'MRR estimado',
        value: mrrCents,
        valueKind: 'money',
        comparisonPercent: membershipGrowthPercent,
        comparisonLabel: 'crecimiento de miembros (30d)',
        sparkline: [],
      },
      {
        id: 'active-members',
        label: 'Miembros activos',
        value: activeMembers,
        valueKind: 'count',
        comparisonPercent: membershipGrowthPercent,
        comparisonLabel: 'vs 30 días anteriores',
        sparkline: [],
      },
      {
        id: 'checkins-today',
        label: 'Check-ins hoy',
        value: Number(ops?.checkins_today ?? 0n),
        valueKind: 'count',
        comparisonPercent: null,
        comparisonLabel: null,
        sparkline: [],
      },
      {
        id: 'upcoming-revenue',
        label: 'Ingreso esperado (7d)',
        value: expected7DaysCents,
        valueKind: 'money',
        comparisonPercent: null,
        comparisonLabel: 'Estimado · renovaciones programadas',
        sparkline: [],
      },
      {
        id: 'failed-payments',
        label: 'Pagos fallidos',
        value: failed30Count,
        valueKind: 'count',
        comparisonPercent: null,
        comparisonLabel: 'últimos 30 días',
        sparkline: [],
      },
      {
        id: 'net-growth',
        label: 'Crecimiento neto',
        value: netGrowth,
        valueKind: 'count',
        comparisonPercent: membershipGrowthPercent,
        comparisonLabel: 'ventana de 30 días',
        sparkline: [],
      },
    ];

    const canceledTotal = statusCounts.get(SubscriptionStatus.CANCELED) ?? 0;

    return {
      currency,
      timezone,
      generatedAt: now.toISOString(),
      definitions: {
        mrr: {
          kind: 'estimated_catalog',
          label:
            'MRR estimado: precio de catálogo de suscripciones ACTIVE, normalizado a mensual. Excluye TRIALING.',
          arrFormula: 'mrr × 12',
        },
        upcomingRevenue: {
          kind: 'estimated_renewals',
          label:
            'Ingreso recurrente esperado según renovaciones locales — no son facturas de Stripe.',
        },
        lifetimeRevenue: {
          kind: 'succeeded_payments',
          label: 'Histórico cobrado: pagos SUCCEEDED en GymOS (Stripe, efectivo y terminal).',
        },
        averageRevenuePerMember: {
          kind: 'collected_30d_per_member',
          label: 'Cobrado últimos 30 días ÷ miembros registrados (no LTV).',
        },
      },
      dataQuality,
      reconciliation,
      kpis,
      revenue: {
        period: 'monthly',
        currency,
        trend: collectedTrend,
        breakdown: revenueBreakdown,
      },
      stripe: {
        connected: stripePlansConfigured > 0,
        connectionLabel:
          stripePlansConfigured > 0
            ? 'Facturación Stripe configurada'
            : 'Stripe no configurado',
        lastSyncAt: lastPaymentAt?.toISOString() ?? null,
        totalSubscriptions:
          (statusCounts.get(SubscriptionStatus.ACTIVE) ?? 0) +
          (statusCounts.get(SubscriptionStatus.TRIALING) ?? 0) +
          (statusCounts.get(SubscriptionStatus.PAST_DUE) ?? 0) +
          (statusCounts.get(SubscriptionStatus.PAUSED) ?? 0) +
          canceledTotal,
        activeSubscriptions: statusCounts.get(SubscriptionStatus.ACTIVE) ?? 0,
        trialingSubscriptions: statusCounts.get(SubscriptionStatus.TRIALING) ?? 0,
        pastDueSubscriptions: statusCounts.get(SubscriptionStatus.PAST_DUE) ?? 0,
        cancelledSubscriptions: canceledTotal,
        pausedSubscriptions: statusCounts.get(SubscriptionStatus.PAUSED) ?? 0,
        lifetimeRevenueCents,
        averageRevenuePerMemberCents,
        currency,
      },
      activity,
      upcomingRevenue: {
        expected7DaysCents,
        expected30DaysCents,
        estimationNote:
          'Estimado según precio de catálogo y fecha de renovación local. No incluye descuentos, cupones, impuestos ni facturas emitidas en Stripe.',
        items: upcomingSubs,
      },
      failedPayments: failedPaymentRows,
      membershipHealth: {
        byPlanCategory: planCategoryRows,
        newMembersThisMonth: newMembers30d,
        cancelledThisMonth: cancellations30d,
        netGrowth,
        trialConversionRatePercent: null,
        statusBreakdown: (
          [
            SubscriptionStatus.ACTIVE,
            SubscriptionStatus.TRIALING,
            SubscriptionStatus.PAST_DUE,
            SubscriptionStatus.PAUSED,
            SubscriptionStatus.CANCELED,
          ] as const
        ).map((status) => ({ status, count: statusCounts.get(status) ?? 0 })),
      },
      memberRisk,
      topMembers,
      operations: {
        classesToday: Number(ops?.classes_today ?? 0n),
        occupancyRateToday,
        checkInsToday: Number(ops?.checkins_today ?? 0n),
        averageAttendancePercent: occupancyRateToday,
        mostPopularClass: null,
        lowestAttendanceClass: null,
        topCoach: null,
      },
      insights,
    };
  }

  private async resolveCurrency(studioId: string): Promise<string> {
    const [enrollment, payment, plan] = await Promise.all([
      this.prisma.studioEnrollmentSettings.findUnique({
        where: { studioId },
        select: { currency: true },
      }),
      this.prisma.payment.findFirst({
        where: { studioId, status: PaymentStatus.SUCCEEDED },
        orderBy: { createdAt: 'desc' },
        select: { currency: true },
      }),
      this.prisma.membershipPlan.findFirst({
        where: { studioId, active: true },
        orderBy: { updatedAt: 'desc' },
        select: { currency: true },
      }),
    ]);
    return enrollment?.currency ?? plan?.currency ?? payment?.currency ?? 'mxn';
  }

  private logReconciliationFailures(
    studioId: string,
    reconciliation: ReturnType<typeof buildExecutiveReconciliation>,
  ): void {
    const failed = Object.entries(reconciliation).filter(([, ok]) => !ok);
    if (failed.length === 0) return;
    this.logger.warn(
      JSON.stringify({
        event: 'executive_reconciliation_mismatch',
        studioId,
        failedChecks: failed.map(([k]) => k),
      }),
    );
  }

  private buildActivityFeed(
    payments: Array<{
      id: string;
      status: PaymentStatus;
      subscriptionId: string | null;
      amountCents: number;
      paymentMethod: PaymentMethod;
      paidAt: Date | null;
      createdAt: Date;
      user: { id: string; firstName: string; lastName: string } | null;
      membershipPlan: { name: string } | null;
    }>,
    newSubs: Array<{
      id: string;
      createdAt: Date;
      user: { id: string; firstName: string; lastName: string };
      membershipPlan: { name: string; priceCents: number };
    }>,
    now: Date,
  ): ExecutiveActivityEventDto[] {
    const paymentEvents: ExecutiveActivityEventDto[] = payments
      .filter((p) => p.user)
      .map((p) => ({
        id: `pay-${p.id}`,
        type:
          p.status === PaymentStatus.FAILED
            ? 'payment_failed'
            : p.subscriptionId
              ? 'subscription_renewed'
              : 'payment_succeeded',
        memberName: fullName(p.user!.firstName, p.user!.lastName),
        memberUserId: p.user!.id,
        planName: p.membershipPlan?.name ?? null,
        amountCents: p.amountCents,
        paymentMethod: paymentMethodOwnerLabel(p.paymentMethod),
        occurredAt: (p.paidAt ?? p.createdAt).toISOString(),
        relativeLabel: relativeTimeLabel((p.paidAt ?? p.createdAt).toISOString(), now),
      }));

    const subEvents: ExecutiveActivityEventDto[] = newSubs.map((s) => ({
      id: `sub-${s.id}`,
      type: 'subscription_created',
      memberName: fullName(s.user.firstName, s.user.lastName),
      memberUserId: s.user.id,
      planName: s.membershipPlan.name,
      amountCents: s.membershipPlan.priceCents,
      paymentMethod: paymentMethodOwnerLabel(PaymentMethod.STRIPE),
      occurredAt: s.createdAt.toISOString(),
      relativeLabel: relativeTimeLabel(s.createdAt.toISOString(), now),
    }));

    return [...paymentEvents, ...subEvents]
      .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
      .slice(0, 30);
  }

  private async fetchUpcomingRenewals(
    studioId: string,
    now: Date,
  ): Promise<ExecutiveUpcomingRenewalDto[]> {
    const in30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const tomorrowEnd = new Date(now);
    tomorrowEnd.setUTCDate(tomorrowEnd.getUTCDate() + 1);
    tomorrowEnd.setUTCHours(23, 59, 59, 999);
    const weekEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const subs = await this.prisma.subscription.findMany({
      where: {
        studioId,
        status: SubscriptionStatus.ACTIVE,
        cancelAtPeriodEnd: false,
        currentPeriodEnd: { gt: now, lte: in30 },
        ...analyticsExcludedSubscriptionFilter(studioId),
      },
      include: {
        user: { select: { id: true, firstName: true, lastName: true } },
        membershipPlan: { select: { name: true, priceCents: true } },
      },
      orderBy: { currentPeriodEnd: 'asc' },
      take: 50,
    });

    return subs.map((s) => {
      const end = s.currentPeriodEnd!;
      let bucket: ExecutiveUpcomingRenewalDto['bucket'] = 'next_30_days';
      if (end <= tomorrowEnd) bucket = 'tomorrow';
      else if (end <= weekEnd) bucket = 'this_week';
      return {
        memberUserId: s.user.id,
        memberName: fullName(s.user.firstName, s.user.lastName),
        planName: s.membershipPlan.name,
        amountCents: s.membershipPlan.priceCents,
        renewalDate: end.toISOString(),
        bucket,
        isEstimated: true as const,
      };
    });
  }

  private async fetchFailedPayments(studioId: string): Promise<ExecutiveFailedPaymentDto[]> {
    const rows = await this.prisma.payment.findMany({
      where: {
        studioId,
        status: PaymentStatus.FAILED,
        createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: {
        user: { select: { id: true, firstName: true, lastName: true } },
        subscription: { select: { status: true } },
      },
    });

    return rows
      .filter((r) => r.user)
      .map((r) => ({
        paymentId: r.id,
        memberUserId: r.user!.id,
        memberName: fullName(r.user!.firstName, r.user!.lastName),
        amountCents: r.amountCents,
        currency: r.currency,
        failureReason: r.notes,
        failureReasonAvailable: r.notes != null && r.notes.trim().length > 0,
        attemptCount: null,
        retryAt: null,
        subscriptionStatus: r.subscription?.status ?? null,
        occurredAt: r.createdAt.toISOString(),
        memberHref: memberHref(r.user!.id),
      }));
  }

  private buildMemberRisk(
    inactive: { user_id: string; first_name: string; last_name: string }[],
    subs: Array<{
      status: SubscriptionStatus;
      cancelAtPeriodEnd: boolean;
      user: { id: string; firstName: string; lastName: string };
    }>,
  ): ExecutiveMemberRiskDto[] {
    const risks: ExecutiveMemberRiskDto[] = [];
    for (const row of inactive) {
      risks.push({
        memberUserId: row.user_id,
        memberName: fullName(row.first_name, row.last_name),
        reason: 'Sin visita en 21+ días',
        severity: 'medium',
        memberHref: memberHref(row.user_id),
      });
    }
    for (const s of subs) {
      if (s.status === SubscriptionStatus.PAST_DUE) {
        risks.push({
          memberUserId: s.user.id,
          memberName: fullName(s.user.firstName, s.user.lastName),
          reason: 'Suscripción vencida (past due)',
          severity: 'high',
          memberHref: memberHref(s.user.id),
        });
      } else if (s.cancelAtPeriodEnd) {
        risks.push({
          memberUserId: s.user.id,
          memberName: fullName(s.user.firstName, s.user.lastName),
          reason: 'Cancelará al fin del periodo',
          severity: 'medium',
          memberHref: memberHref(s.user.id),
        });
      } else if (s.status === SubscriptionStatus.TRIALING) {
        risks.push({
          memberUserId: s.user.id,
          memberName: fullName(s.user.firstName, s.user.lastName),
          reason: 'Prueba expira mañana',
          severity: 'high',
          memberHref: memberHref(s.user.id),
        });
      }
    }
    return risks.slice(0, 15);
  }

  private buildPlanCategoryCounts(
    subs: { status: SubscriptionStatus; membershipPlan: { name: string } }[],
  ) {
    const buckets = new Map<string, number>();
    for (const s of subs) {
      if (
        s.status === SubscriptionStatus.CANCELED ||
        s.status === SubscriptionStatus.PAUSED
      ) {
        continue;
      }
      const cat =
        s.status === SubscriptionStatus.TRIALING
          ? 'Trial'
          : s.status === SubscriptionStatus.PAST_DUE
            ? 'Past Due'
            : categorizePlan(s.membershipPlan.name);
      buckets.set(cat, (buckets.get(cat) ?? 0) + 1);
    }
    return [...buckets.entries()].map(([label, count]) => ({ label, count }));
  }

  private buildTopMembers(
    row: import('./executive-dashboard.aggregate').ExecutiveTopMembersRow | undefined,
    longest: {
      createdAt: Date;
      user: { id: string; firstName: string; lastName: string };
    } | null,
    newest: {
      createdAt: Date;
      user: { id: string; firstName: string; lastName: string };
    } | null,
    now: Date,
  ): ExecutiveTopMemberDto[] {
    const out: ExecutiveTopMemberDto[] = [];
    if (row?.top_today_user_id && row.top_today_cents != null) {
      out.push({
        category: 'Mayor pago hoy',
        memberUserId: row.top_today_user_id,
        memberName: fullName(row.top_today_first ?? '', row.top_today_last ?? ''),
        valueLabel: `$${(Number(row.top_today_cents) / 100).toFixed(0)}`,
        memberHref: memberHref(row.top_today_user_id),
      });
    }
    if (row?.top_lifetime_user_id && row.top_lifetime_cents != null) {
      out.push({
        category: 'Mayor valor de por vida',
        memberUserId: row.top_lifetime_user_id,
        memberName: fullName(row.top_lifetime_first ?? '', row.top_lifetime_last ?? ''),
        valueLabel: `$${(Number(row.top_lifetime_cents) / 100).toFixed(0)}`,
        memberHref: memberHref(row.top_lifetime_user_id),
      });
    }
    if (longest) {
      out.push({
        category: 'Miembro más antiguo',
        memberUserId: longest.user.id,
        memberName: fullName(longest.user.firstName, longest.user.lastName),
        valueLabel: new Intl.DateTimeFormat('es-MX', {
          month: 'short',
          year: 'numeric',
        }).format(longest.createdAt),
        memberHref: memberHref(longest.user.id),
      });
    }
    if (newest) {
      out.push({
        category: 'Miembro más nuevo',
        memberUserId: newest.user.id,
        memberName: fullName(newest.user.firstName, newest.user.lastName),
        valueLabel: relativeTimeLabel(newest.createdAt.toISOString(), now),
        memberHref: memberHref(newest.user.id),
      });
    }
    if (row?.most_active_user_id && row.most_active_visits != null) {
      out.push({
        category: 'Más activo este mes',
        memberUserId: row.most_active_user_id,
        memberName: fullName(row.most_active_first ?? '', row.most_active_last ?? ''),
        valueLabel: `${row.most_active_visits} check-ins`,
        memberHref: memberHref(row.most_active_user_id),
      });
    }
    return out;
  }
}
