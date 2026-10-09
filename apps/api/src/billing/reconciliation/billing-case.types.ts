import type { BillingCaseCategory, BillingCaseSeverity } from '@prisma/client';

/**
 * One observation of a billing exception. Detectors and webhook handlers emit these; the case
 * service turns them into durable rows keyed by `issueKey` (never duplicates across runs).
 * Evidence is operator-facing JSON: ids, amounts, dates, statuses — never card data, secrets,
 * emails or raw Stripe payloads.
 */
export type ObservedIssue = {
  /** Null = platform scope (e.g. a dead-lettered event that names no studio). */
  studioId: string | null;
  category: BillingCaseCategory;
  severity: BillingCaseSeverity;
  /** Finer classification within the category; shown to operators and used by copy. */
  reasonCode: string | null;
  /** Primary reference the issue is keyed on (invoice id, subscription id, event id...). */
  issueRef: string;
  userId?: string | null;
  subscriptionId?: string | null;
  paymentId?: string | null;
  stripeSubscriptionId?: string | null;
  stripeInvoiceId?: string | null;
  stripeCustomerId?: string | null;
  stripeEventId?: string | null;
  title: string;
  summary: string;
  suggestedAction: string;
  evidence: Record<string, unknown>;
};

export const PLATFORM_SCOPE = 'platform';

export function buildIssueKey(studioId: string | null, category: BillingCaseCategory, issueRef: string): string {
  return `${studioId ?? PLATFORM_SCOPE}:${category}:${issueRef}`;
}

export type CaseHistoryEntry = {
  at: string;
  type:
    | 'DETECTED'
    | 'REOPENED'
    | 'ACKNOWLEDGED'
    | 'RESOLVED'
    | 'AUTO_RESOLVED'
    | 'DISMISSED'
    | 'ALERT_SENT'
    | 'ALERT_FAILED'
    | 'SEVERITY_CHANGED';
  byUserId?: string | null;
  note?: string | null;
  channel?: string | null;
  from?: string | null;
  to?: string | null;
  runId?: string | null;
};

/** History is append-only but capped so a long-lived case cannot grow without bound. */
export const CASE_HISTORY_LIMIT = 40;

export type ObserveOutcome = 'created' | 'updated' | 'reopened' | 'dismissed_unchanged';

export const SEVERITY_RANK: Record<BillingCaseSeverity, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
