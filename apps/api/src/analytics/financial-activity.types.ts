/** Financial activity feed — payment and billing events for owner/admin analytics. */

/** Business event categories — independent from payment method. */
export type FinancialActivityEventType =
  | 'new_membership'
  | 'membership_renewal'
  | 'one_time_payment'
  | 'payment_failed'
  | 'refund'
  | 'trial_started'
  | 'subscription_cancelled';

export type FinancialActivityStatus =
  | 'collected'
  | 'pending'
  | 'failed'
  | 'refunded'
  | 'cancelled';

export type FinancialActivityMethod =
  | 'stripe'
  | 'cash'
  | 'terminal'
  | 'transfer'
  | 'other';

export type FinancialActivityMemberDto = {
  id: string;
  name: string;
};

export type FinancialActivityItemDto = {
  /** Stable deduplication key — payment:{paymentId} or subscription-*:{subscriptionId}… */
  id: string;
  occurredAt: string;
  member: FinancialActivityMemberDto;
  eventType: FinancialActivityEventType;
  eventLabel: string;
  planName: string | null;
  amountCents: number | null;
  currency: string;
  method: FinancialActivityMethod;
  methodLabel: string;
  status: FinancialActivityStatus;
  statusLabel: string;
  nextRenewalAt: string | null;
  failureReason: string | null;
  actionTarget: 'member' | 'review';
  memberHref: string;
};

export type FinancialActivitySummaryDto = {
  movementCount: number;
  stripeCollectedCents: number;
  cashCollectedCents: number;
  failedCount: number;
  refundedCents: number;
};

export type FinancialActivityPaginationDto = {
  nextCursor: string | null;
  hasMore: boolean;
  totalCount: number;
};

export type FinancialActivityResponseDto = {
  currency: string;
  timezone: string;
  period: { from: string; to: string };
  summary: FinancialActivitySummaryDto;
  items: FinancialActivityItemDto[];
  pagination: FinancialActivityPaginationDto;
  generatedAt: string;
};

export type FinancialActivityQuery = {
  from?: string;
  to?: string;
  method?: FinancialActivityMethod | 'all';
  eventType?: FinancialActivityEventType | 'all';
  status?: FinancialActivityStatus | 'all';
  category?: 'all' | 'stripe' | 'cash' | 'renewals' | 'failed' | 'refunds';
  memberSearch?: string;
  cursor?: string;
  limit?: number;
};

/** First succeeded payment id per subscription — populated by one bounded SQL lookup. */
export type FirstSucceededPaymentIndex = Map<string, string>;
