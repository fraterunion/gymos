import { apiRequest } from "@/lib/api/client";

export type BillingInterval = "MONTHLY" | "YEARLY" | "WEEKLY";
export type SubscriptionStatus =
  | "ACTIVE"
  | "PAST_DUE"
  | "CANCELED"
  | "TRIALING"
  | "PAUSED";
export type LifecycleStatus = SubscriptionStatus | "ENDING" | "SCHEDULED" | "EXPIRED";

export type ClassAccessTemplateDto = {
  id: string;
  name: string;
  durationMinutes: number;
  active: boolean;
  isOpenGymSlot: boolean;
  accessWindowStart: string | null;
  accessWindowEnd: string | null;
};

export type PlanClassAccessDto = {
  allClasses: boolean;
  templates: ClassAccessTemplateDto[];
};

export type MembershipPlanDto = {
  id: string;
  studioId: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  billingInterval: BillingInterval;
  classCredits: number | null;
  /** Fixed-duration entitlement window in days (e.g. Booty Lab = 45). Overrides billingInterval
   *  for both the GymOS access window and the Stripe recurring price when set. */
  entitlementDays: number | null;
  /** Legacy category-based allowlist, superseded by classAccess.templates when non-empty. */
  allowedCategories: string[];
  active: boolean;
  stripeProductId: string | null;
  stripePriceId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  activeSubscriberCount: number;
  mrrCents: number;
  classAccess: PlanClassAccessDto;
};

export type MembershipPlanInput = {
  name: string;
  description?: string | null;
  priceCents: number;
  currency?: string;
  billingInterval: BillingInterval;
  classCredits?: number | null;
  entitlementDays?: number | null;
  stripeProductId?: string | null;
  stripePriceId?: string | null;
  allClassesAccess?: boolean;
  classTemplateIds?: string[];
};

export type MembershipPlanUpdateInput = Partial<MembershipPlanInput> & {
  active?: boolean;
};

export type MembershipsOverview = {
  totalActivePlans: number;
  totalActiveSubscribers: number;
  totalMrrCents: number;
  expiringWithin7Days: number;
  requiringAttentionSubscriptions: number;
  byStatus: Record<string, number>;
};

export type SubscriptionListItem = {
  id: string;
  status: SubscriptionStatus;
  accessState: "ENTITLED" | "NOT_STARTED" | "EXPIRED" | "INACTIVE";
  lifecycleStatus: LifecycleStatus;
  primaryStatus: Exclude<LifecycleStatus, "ENDING">;
  isEntitled: boolean;
  effectiveEnd: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  source: "STRIPE" | "CASH" | "MANUAL";
  createdAt: string;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
  };
  membershipPlan: {
    id: string;
    name: string;
    billingInterval: BillingInterval;
    priceCents: number;
    currency: string;
    classCredits: number | null;
    entitlementDays: number | null;
  };
};

export type SubscriptionListResponse = {
  data: SubscriptionListItem[];
  total: number;
  page: number;
  limit: number;
};

// ── Plan billing integrity ───────────────────────────────────────────────────

export type PlanIntegrityStatus =
  | "healthy"
  | "price_mismatch"
  | "currency_mismatch"
  | "interval_mismatch"
  | "no_stripe_price"
  | "inactive_stripe_price"
  | "fetch_error";

export type PlanIntegrityResult = {
  planId: string;
  planName: string;
  stripePriceId: string | null;
  localPriceCents: number;
  localCurrency: string;
  localBillingInterval: BillingInterval;
  stripeUnitAmount: number | null;
  stripeCurrency: string | null;
  stripeInterval: string | null;
  status: PlanIntegrityStatus;
};

export function fetchPlanBillingIntegrity(
  studioId: string,
): Promise<PlanIntegrityResult[]> {
  return apiRequest<PlanIntegrityResult[]>(
    `/studios/${studioId}/membership-plans/billing-integrity`,
  );
}

// ── Plan CRUD ───────────────────────────────────────────────────────────────

export function fetchMembershipPlans(
  studioId: string,
  includeInactive = false,
): Promise<MembershipPlanDto[]> {
  const qs = includeInactive ? "?includeInactive=true" : "";
  return apiRequest<MembershipPlanDto[]>(
    `/studios/${studioId}/memberships/plans${qs}`,
  );
}

export function createMembershipPlan(
  studioId: string,
  input: MembershipPlanInput,
): Promise<MembershipPlanDto> {
  return apiRequest<MembershipPlanDto>(`/studios/${studioId}/membership-plans`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateMembershipPlan(
  studioId: string,
  planId: string,
  input: MembershipPlanUpdateInput,
): Promise<MembershipPlanDto> {
  return apiRequest<MembershipPlanDto>(
    `/studios/${studioId}/membership-plans/${planId}`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
}

export function archiveMembershipPlan(
  studioId: string,
  planId: string,
): Promise<void> {
  return apiRequest<void>(`/studios/${studioId}/membership-plans/${planId}`, {
    method: "DELETE",
  });
}

export type PlanConfigurationHistoryEntry = {
  id: string;
  action: string;
  createdAt: string;
  actor: { id: string; firstName: string; lastName: string };
  metadata: {
    planName?: string;
    changes?: Record<string, { from: unknown; to: unknown }>;
    classTemplateId?: string;
    classTemplateName?: string | null;
  };
};

export function fetchPlanConfigurationHistory(
  studioId: string,
  planId: string,
): Promise<PlanConfigurationHistoryEntry[]> {
  return apiRequest<PlanConfigurationHistoryEntry[]>(
    `/studios/${studioId}/membership-plans/${planId}/configuration-history`,
  );
}

// ── Overview + subscriptions ─────────────────────────────────────────────────

export function fetchMembershipsOverview(
  studioId: string,
): Promise<MembershipsOverview> {
  return apiRequest<MembershipsOverview>(
    `/studios/${studioId}/memberships/overview`,
  );
}

export function fetchSubscriptions(
  studioId: string,
  opts: {
    status?: SubscriptionStatus;
    planId?: string;
    attention?: boolean;
    expiringWithin7Days?: boolean;
    page?: number;
    limit?: number;
  } = {},
): Promise<SubscriptionListResponse> {
  const params = new URLSearchParams();
  if (opts.status) params.set("status", opts.status);
  if (opts.planId) params.set("planId", opts.planId);
  if (opts.attention) params.set("attention", "true");
  if (opts.expiringWithin7Days) params.set("expiringWithin7Days", "true");
  if (opts.page) params.set("page", String(opts.page));
  if (opts.limit) params.set("limit", String(opts.limit));
  const qs = params.toString() ? `?${params.toString()}` : "";
  return apiRequest<SubscriptionListResponse>(
    `/studios/${studioId}/memberships/subscriptions${qs}`,
  );
}

// ── Manual subscription assignment ───────────────────────────────────────────

export function createManualSubscription(
  studioId: string,
  userId: string,
  planId: string,
  stripeSubscriptionId?: string,
): Promise<SubscriptionListItem> {
  return apiRequest<SubscriptionListItem>(
    `/studios/${studioId}/members/${userId}/subscriptions`,
    {
      method: "POST",
      body: JSON.stringify({ planId, stripeSubscriptionId }),
    },
  );
}

// ── Subscription status change ────────────────────────────────────────────────

export function updateSubscriptionStatus(
  studioId: string,
  userId: string,
  subscriptionId: string,
  status: SubscriptionStatus,
): Promise<SubscriptionListItem> {
  return apiRequest<SubscriptionListItem>(
    `/studios/${studioId}/members/${userId}/subscriptions/${subscriptionId}/status`,
    { method: "PATCH", body: JSON.stringify({ status }) },
  );
}

// ── Cancel at period end ──────────────────────────────────────────────────────

export function setCancelAtPeriodEnd(
  studioId: string,
  userId: string,
  subscriptionId: string,
  cancel: boolean,
): Promise<SubscriptionListItem> {
  return apiRequest<SubscriptionListItem>(
    `/studios/${studioId}/members/${userId}/subscriptions/${subscriptionId}/cancel-at-period-end`,
    { method: "PATCH", body: JSON.stringify({ cancel }) },
  );
}
