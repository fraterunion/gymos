import { apiRequest } from "./client";

export type BillingCaseCategory =
  | "STRIPE_CANCELED_LOCAL_ALIVE"
  | "LOCAL_CANCELED_STRIPE_ALIVE"
  | "PAID_WITHOUT_ENTITLEMENT"
  | "STALE_RENEWAL_PERIOD"
  | "OVERLAPPING_ENTITLEMENT_CYCLES"
  | "WEBHOOK_DEAD_LETTER"
  | "WEBHOOK_BACKLOG"
  | "CANCELLATION_REASON_MISMATCH"
  | "OPEN_INVOICE_ON_ENDED_SUBSCRIPTION"
  | "REPEATED_PAYMENT_FAILURES"
  | "SUBSCRIPTION_IDENTITY_MISMATCH"
  | "PAYMENT_REFUNDED_OR_DISPUTED";

export type BillingCaseSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type BillingCaseStatus = "OPEN" | "ACKNOWLEDGED" | "RESOLVED" | "DISMISSED";

export type BillingCaseHistoryEntry = {
  at: string;
  type: string;
  byUserId?: string | null;
  note?: string | null;
  channel?: string | null;
  from?: string | null;
  to?: string | null;
};

export type BillingCase = {
  id: string;
  category: BillingCaseCategory;
  categoryLabel: string;
  severity: BillingCaseSeverity;
  severityLabel: string;
  status: BillingCaseStatus;
  statusLabel: string;
  statusSentence: string;
  reasonCode: string | null;
  title: string;
  summary: string;
  suggestedAction: string;
  member: { id: string; reference: string } | null;
  subscriptionId: string | null;
  paymentId: string | null;
  stripeSubscriptionId: string | null;
  stripeInvoiceId: string | null;
  stripeEventId: string | null;
  evidence: Record<string, unknown>;
  firstDetectedAt: string;
  lastObservedAt: string;
  observationCount: number;
  occurrenceCount: number;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  dismissedAt: string | null;
  dismissReason: string | null;
  lastAlertedAt: string | null;
  alertCount: number;
  history: BillingCaseHistoryEntry[];
};

export type BillingCaseListResponse = {
  items: BillingCase[];
  nextCursor: string | null;
  counts: { status: BillingCaseStatus; severity: BillingCaseSeverity; count: number }[];
};

export type BillingCaseListQuery = {
  status?: BillingCaseStatus[];
  severity?: BillingCaseSeverity[];
  category?: BillingCaseCategory[];
  userId?: string;
  cursor?: string | null;
  limit?: number;
};

export type BillingReconciliationRun = {
  id: string;
  studioId: string | null;
  trigger: "CRON" | "MANUAL";
  status: "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED";
  startedAt: string;
  finishedAt: string | null;
  stats: Record<string, unknown>;
  error: string | null;
};

const base = (studioId: string) => `/studios/${studioId}/billing/reconciliation`;

export async function fetchBillingCases(studioId: string, query: BillingCaseListQuery = {}): Promise<BillingCaseListResponse> {
  const params = new URLSearchParams();
  if (query.status?.length) params.set("status", query.status.join(","));
  if (query.severity?.length) params.set("severity", query.severity.join(","));
  if (query.category?.length) params.set("category", query.category.join(","));
  if (query.userId) params.set("userId", query.userId);
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.limit) params.set("limit", String(query.limit));
  const qs = params.toString();
  return apiRequest<BillingCaseListResponse>(`${base(studioId)}/cases${qs ? `?${qs}` : ""}`, { method: "GET" });
}

export async function fetchBillingCase(studioId: string, caseId: string): Promise<BillingCase> {
  return apiRequest<BillingCase>(`${base(studioId)}/cases/${caseId}`, { method: "GET" });
}

export type BillingCaseAction = "acknowledge" | "resolve" | "dismiss" | "reopen";

export async function applyBillingCaseAction(studioId: string, caseId: string, action: BillingCaseAction, note?: string): Promise<BillingCase> {
  return apiRequest<BillingCase>(`${base(studioId)}/cases/${caseId}/${action}`, {
    method: "POST",
    body: JSON.stringify(note ? { note } : {}),
  });
}

export async function runBillingReconciliation(studioId: string): Promise<Record<string, unknown>> {
  return apiRequest<Record<string, unknown>>(`${base(studioId)}/runs`, { method: "POST", body: JSON.stringify({}) });
}

export async function fetchLatestBillingReconciliationRun(studioId: string): Promise<BillingReconciliationRun | null> {
  return apiRequest<BillingReconciliationRun | null>(`${base(studioId)}/runs/latest`, { method: "GET" });
}
