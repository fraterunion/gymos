/** Executive Dashboard 2.0 — business-level DTOs (no raw Stripe objects). */

export type ExecutiveKpiDto = {
  id: string;
  label: string;
  value: number;
  valueKind: 'money' | 'count' | 'percent';
  comparisonPercent: number | null;
  comparisonLabel: string | null;
  sparkline: { date: string; amountCents: number }[];
};

export type ExecutiveRevenueBreakdownDto = {
  subscriptionsCents: number;
  oneTimeCents: number;
  retailCents: number;
  otherCents: number;
  totalCents: number;
};

export type ExecutiveRevenueSectionDto = {
  period: 'daily' | 'monthly' | 'yearly';
  currency: string;
  trend: { date: string; amountCents: number; paymentCount: number }[];
  breakdown: ExecutiveRevenueBreakdownDto;
};

export type ExecutiveStripeOverviewDto = {
  connected: boolean;
  connectionLabel: string;
  lastSyncAt: string | null;
  totalSubscriptions: number;
  activeSubscriptions: number;
  trialingSubscriptions: number;
  pastDueSubscriptions: number;
  cancelledSubscriptions: number;
  pausedSubscriptions: number;
  lifetimeRevenueCents: number;
  averageRevenuePerMemberCents: number;
  currency: string;
};

export type ExecutiveActivityEventDto = {
  id: string;
  type:
    | 'payment_succeeded'
    | 'payment_failed'
    | 'subscription_created'
    | 'subscription_renewed'
    | 'invoice_paid';
  memberName: string;
  memberUserId: string;
  planName: string | null;
  amountCents: number | null;
  paymentMethod: string | null;
  occurredAt: string;
  relativeLabel: string;
};

/** Estimated renewal — not a Stripe invoice. */
export type ExecutiveUpcomingRenewalDto = {
  memberUserId: string;
  memberName: string;
  planName: string;
  /** Catalog plan price; estimated, not guaranteed collection. */
  amountCents: number;
  renewalDate: string;
  bucket: 'tomorrow' | 'this_week' | 'next_30_days';
  isEstimated: true;
};

export type ExecutiveUpcomingRevenueDto = {
  /** Sum of estimated catalog renewals — not Stripe invoice totals. */
  expected7DaysCents: number;
  expected30DaysCents: number;
  estimationNote: string;
  items: ExecutiveUpcomingRenewalDto[];
};

export type ExecutiveFailedPaymentDto = {
  paymentId: string;
  memberUserId: string;
  memberName: string;
  amountCents: number;
  currency: string;
  /** Only populated when persisted (Payment.notes); never inferred from status. */
  failureReason: string | null;
  failureReasonAvailable: boolean;
  attemptCount: null;
  retryAt: null;
  subscriptionStatus: string | null;
  occurredAt: string;
  memberHref: string;
};

export type ExecutiveMetricDefinitionsDto = {
  mrr: {
    kind: 'estimated_catalog';
    label: string;
    arrFormula: 'mrr × 12';
  };
  upcomingRevenue: {
    kind: 'estimated_renewals';
    label: string;
  };
  lifetimeRevenue: {
    kind: 'succeeded_payments';
    label: string;
  };
  averageRevenuePerMember: {
    kind: 'collected_30d_per_member';
    label: string;
  };
};

export type ExecutiveReconciliationDto = {
  methodSplitEqualsTotal: boolean;
  trendAmountEqualsTotal: boolean;
  trendCountEqualsTotal: boolean;
  breakdownEqualsMonthCollected: boolean;
  planAttributedPlusUnattributed: boolean;
};

export type ExecutiveDataQualityDto = {
  lastPaymentAt: string | null;
  warnings: string[];
};

export type ExecutiveMembershipHealthDto = {
  byPlanCategory: { label: string; count: number }[];
  newMembersThisMonth: number;
  cancelledThisMonth: number;
  netGrowth: number;
  trialConversionRatePercent: number | null;
  statusBreakdown: { status: string; count: number }[];
};

export type ExecutiveMemberRiskDto = {
  memberUserId: string;
  memberName: string;
  reason: string;
  severity: 'high' | 'medium' | 'low';
  memberHref: string;
};

export type ExecutiveTopMemberDto = {
  category: string;
  memberUserId: string;
  memberName: string;
  valueLabel: string;
  memberHref: string;
};

export type ExecutiveOperationsDto = {
  classesToday: number;
  occupancyRateToday: number;
  checkInsToday: number;
  averageAttendancePercent: number;
  mostPopularClass: { name: string; bookingCount: number } | null;
  lowestAttendanceClass: { name: string; fillPercent: number } | null;
  topCoach: { name: string; classCount: number } | null;
};

export type ExecutiveInsightDto = {
  id: string;
  tone: 'positive' | 'neutral' | 'warning' | 'critical';
  title: string;
  body: string;
  facts: Record<string, string | number | boolean | null>;
  priority: number;
};

export type ExecutiveDashboardDto = {
  currency: string;
  timezone: string;
  generatedAt: string;
  definitions: ExecutiveMetricDefinitionsDto;
  dataQuality: ExecutiveDataQualityDto;
  reconciliation: ExecutiveReconciliationDto;
  kpis: ExecutiveKpiDto[];
  revenue: ExecutiveRevenueSectionDto;
  stripe: ExecutiveStripeOverviewDto;
  activity: ExecutiveActivityEventDto[];
  upcomingRevenue: ExecutiveUpcomingRevenueDto;
  failedPayments: ExecutiveFailedPaymentDto[];
  membershipHealth: ExecutiveMembershipHealthDto;
  memberRisk: ExecutiveMemberRiskDto[];
  topMembers: ExecutiveTopMemberDto[];
  operations: ExecutiveOperationsDto;
  insights: ExecutiveInsightDto[];
};
