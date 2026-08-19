import { apiRequest } from "@/lib/api/client";

// ── Types ────────────────────────────────────────────────────────────────────

export type SubStatus = "ACTIVE" | "PAST_DUE" | "CANCELED" | "TRIALING" | "PAUSED";
export type LifecycleStatus = SubStatus | "ENDING" | "SCHEDULED" | "EXPIRED";
export type LifecycleFilter = LifecycleStatus | "NONE";
export type PaymentSource = "STRIPE" | "CASH" | "MANUAL" | "NONE";
export type ActivityFilter = "VISITED_7D" | "VISITED_30D" | "NO_VISIT_14D" | "NO_VISIT_30D" | "NEVER_ATTENDED" | "HAS_NO_SHOWS" | "HAS_FUTURE_BOOKING" | "NO_FUTURE_BOOKING" | "ENDING_7D";
export type BookingStatus = "PENDING" | "CONFIRMED" | "CANCELLED" | "NO_SHOW" | "COMPLETED";
export type PaymentStatus = "PENDING" | "SUCCEEDED" | "FAILED" | "REFUNDED" | "PARTIALLY_REFUNDED";
export type MemberRole = "MEMBER" | "INSTRUCTOR" | "STAFF" | "ADMIN" | "OWNER";

export type MemberDto = {
  membershipId: string;
  role: string;
  createdAt: string;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    phone: string | null;
    createdAt: string;
  };
};

export type MemberSubscriptionSummary = {
  id: string;
  status: SubStatus;
  accessState: "ENTITLED" | "NOT_STARTED" | "EXPIRED" | "INACTIVE";
  lifecycleStatus: LifecycleStatus;
  isEntitled: boolean;
  planName: string;
  planId: string;
  currentPeriodEnd: string | null;
  effectiveEnd: string | null;
  cancelAtPeriodEnd: boolean;
  source: Exclude<PaymentSource, "NONE">;
  classCredits: number | null;
  currentPeriodStart: string | null;
};

export type MemberListItem = {
  /** StudioMembership.id — roster/display only; never send as manual-attendance memberId. */
  membershipId: string;
  /** User.id — send as manual-attendance `memberId`. */
  userId: string;
  role: MemberRole;
  joinedAt: string;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    phone: string | null;
    createdAt: string;
  };
  totalBookings: number;
  noShowCount: number;
  lastAttendanceAt: string | null;
  nextBooking: { id: string; classId: string; startsAt: string; className: string } | null;
  usage: { limit: number | null; used: number | null; remaining: number | null } | null;
  lastPayment: { status: PaymentStatus; paymentMethod: string; amountCents: number; currency: string; paidAt: string | null; createdAt: string } | null;
  subscription: MemberSubscriptionSummary | null;
};

export type MemberListResponse = {
  data: MemberListItem[];
  total: number;
  page: number;
  limit: number;
  summary: { active: number; ending: number; expired: number; pastDue: number; noMembership: number; inactive30d: number; noShows: number };
};

export type MemberListQuery = {
  search?: string;
  role?: MemberRole;
  lifecycleStatus?: LifecycleFilter;
  planId?: string;
  paymentSource?: PaymentSource;
  activity?: ActivityFilter;
  hasNoShows?: boolean;
  sortBy?: "joinDate" | "lastAttendance" | "totalBookings" | "name";
  sortDir?: "asc" | "desc";
  page?: number;
  limit?: number;
};

export type TimelineEventType =
  | "MEMBER_CREATED"
  | "BOOKING_CREATED"
  | "BOOKING_CANCELLED"
  | "BOOKING_NO_SHOW"
  | "CHECKED_IN"
  | "MEMBERSHIP_ASSIGNED"
  | "PAYMENT_SUCCEEDED"
  | "PAYMENT_FAILED"
  | "CRM_UPDATED"
  | "NOTE_CREATED";

export type TimelineEvent = {
  type: TimelineEventType;
  title: string;
  description?: string | null;
  actor?: string | null;
  occurredAt: string;
};

export type AttendanceLogEntry = {
  id: string;
  status: BookingStatus;
  attendanceStatus: "ATTENDED" | "CANCELLED" | "NO_SHOW" | "MISSED" | "UPCOMING";
  createdAt: string;
  cancelledAt: string | null;
  canMarkNoShow: boolean;
  checkedInAt: string | null;
  checkInMethod: "QR" | "MANUAL" | "KIOSK" | null;
  scheduledClass: {
    id: string;
    startsAt: string;
    endsAt: string;
    classTemplate: { id: string; name: string; color: string | null };
    instructor: { id: string; firstName: string; lastName: string } | null;
  };
};

export type AttendanceLogResponse = {
  data: AttendanceLogEntry[];
  total: number;
  page: number;
  limit: number;
};

export type MemberPlan = {
  id: string;
  name: string;
  billingInterval: "MONTHLY" | "YEARLY" | "WEEKLY";
  priceCents: number;
  currency: string;
  classCredits: number | null;
};

export type MemberSubscription = {
  id: string;
  status: SubStatus;
  accessState: "ENTITLED" | "NOT_STARTED" | "EXPIRED" | "INACTIVE";
  lifecycleStatus: LifecycleStatus;
  isEntitled: boolean;
  effectiveEnd: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  membershipPlan: MemberPlan;
  pendingMembershipPlan?: Pick<MemberPlan, "id" | "name" | "billingInterval" | "priceCents" | "currency"> | null;
};

export type PlanChangePreview = {
  hasCurrentMembership: boolean;
  isPlanChange: boolean;
  currentPlan: Pick<MemberPlan, "id" | "name" | "priceCents" | "currency" | "billingInterval"> | null;
  newPlan: Pick<MemberPlan, "id" | "name" | "priceCents" | "currency" | "billingInterval">;
  effective: "immediate" | "next_period" | "checkout";
  message: string;
};

export type MemberProfile = {
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    phone: string | null;
    createdAt: string;
  };
  role: MemberRole;
  membership: { id: string; createdAt: string; updatedAt: string };
  attendances: { totalInStudio: number };
  bookingStats: {
    totalBookings: number;
    attendedCount: number;
    noShowCount: number;
    cancelledCount: number;
  };
  currentMembership: ({
    id: string;
    status: SubStatus;
    source: Exclude<PaymentSource, "NONE">;
    accessState: "ENTITLED" | "NOT_STARTED" | "EXPIRED" | "INACTIVE";
    lifecycleStatus: LifecycleStatus;
    isEntitled: boolean;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    effectiveEnd: string | null;
    entitlementEndsAt: string | null;
    plan: MemberPlan & { allowedCategories: string[]; allClassesAccess: boolean; allowedTemplateIds: string[] };
    pendingPlan: Pick<MemberPlan, "id" | "name" | "billingInterval" | "priceCents" | "currency"> | null;
    creditsUsed: number | null;
    creditsRemaining: number | null;
  }) | null;
  operations: {
    lastVisit: { checkedInAt: string; method: string; scheduledClass: { id: string; startsAt: string; classTemplate: { name: string } } } | null;
    nextBooking: { id: string; scheduledClass: { id: string; startsAt: string; classTemplate: { name: string } } } | null;
    lastPayment: (MemberPayment & { paymentMethod: string; membershipPlan: { id: string; name: string } | null }) | null;
    recentNoShows: number;
    attendanceRate: number | null;
    attentionItems: Array<{ code: string; priority: "critical" | "warning" | "informational"; message: string; action: string | null }>;
    segments: string[];
  };
  activeSubscription: {
    id: string;
    status: SubStatus;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    plan: MemberPlan;
  } | null;
};

export type MemberCrmProfile = {
  id: string;
  studioId: string;
  userId: string;
  birthdate: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  emergencyContactRelation: string | null;
  notes: string | null;
  tags: string[];
  goals: string | null;
  injuries: string | null;
  createdAt: string;
  updatedAt: string;
};

export type UpsertCrmProfileInput = {
  birthdate?: string | null;
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
  emergencyContactRelation?: string | null;
  notes?: string | null;
  tags?: string[];
  goals?: string | null;
  injuries?: string | null;
};

export type MemberBooking = {
  id: string;
  status: BookingStatus;
  createdAt: string;
  cancelSource: string | null;
  cancelledAt: string | null;
  scheduledClass: {
    id: string;
    startsAt: string;
    endsAt: string;
    capacity: number;
    status: string;
    classTemplate: { id: string; name: string; color: string | null };
    instructor: { id: string; firstName: string; lastName: string } | null;
  };
};

export type MemberBookingsResponse = {
  data: MemberBooking[];
  total: number;
  page: number;
  limit: number;
};

export type MemberAttendance = {
  id: string;
  checkedInAt: string;
  method: "QR" | "MANUAL" | "KIOSK";
  checkedInByUserId: string | null;
  scheduledClass: {
    id: string;
    startsAt: string;
    endsAt: string;
    classTemplate: { id: string; name: string; color: string | null };
  };
};

export type MemberAttendanceResponse = {
  data: MemberAttendance[];
  total: number;
  page: number;
  limit: number;
};

export type MemberPayment = {
  id: string;
  amountCents: number;
  currency: string;
  status: PaymentStatus;
  paymentMethod: "STRIPE" | "CASH" | "CARD" | "BANK_TRANSFER" | string;
  membershipPlanId: string | null;
  membershipPlan?: { id: string; name: string } | null;
  recordedBy?: { firstName: string; lastName: string } | null;
  stripePaymentIntentId: string | null;
  stripeInvoiceId: string | null;
  paidAt: string | null;
  createdAt: string;
};

export type MemberPaymentsResponse = {
  data: MemberPayment[];
  total: number;
  page: number;
  limit: number;
};

// ── Fetchers ─────────────────────────────────────────────────────────────────

export async function fetchStudioMembers(studioId: string): Promise<MemberDto[]> {
  // The /members endpoint returns a paginated { data, total, page, limit } object, not a plain array.
  const res = await apiRequest<{ data: MemberDto[]; total: number; page: number; limit: number }>(
    `/studios/${studioId}/members`,
    { method: "GET" },
  );
  return res.data;
}

export async function fetchMembers(
  studioId: string,
  query: MemberListQuery = {},
): Promise<MemberListResponse> {
  const params = new URLSearchParams();
  if (query.search) params.set("search", query.search);
  if (query.role) params.set("role", query.role);
  if (query.lifecycleStatus) params.set("lifecycleStatus", query.lifecycleStatus);
  if (query.planId) params.set("planId", query.planId);
  if (query.paymentSource) params.set("paymentSource", query.paymentSource);
  if (query.activity) params.set("activity", query.activity);
  if (query.hasNoShows) params.set("hasNoShows", "true");
  if (query.sortBy) params.set("sortBy", query.sortBy);
  if (query.sortDir) params.set("sortDir", query.sortDir);
  if (query.page) params.set("page", String(query.page));
  if (query.limit) params.set("limit", String(query.limit));
  const qs = params.toString();
  type ApiMemberListRow = Omit<MemberListItem, "userId">;
  const res = await apiRequest<{
    data: ApiMemberListRow[];
    total: number;
    page: number;
    limit: number;
    summary: MemberListResponse["summary"];
  }>(`/studios/${studioId}/members${qs ? `?${qs}` : ""}`, { method: "GET" });
  return {
    ...res,
    data: res.data.map((row) => ({
      ...row,
      userId: row.user.id,
    })),
  };
}

export async function fetchMemberProfile(
  studioId: string,
  userId: string,
): Promise<MemberProfile> {
  return apiRequest<MemberProfile>(`/studios/${studioId}/members/${userId}`, { method: "GET" });
}

export async function fetchMemberBookings(
  studioId: string,
  userId: string,
  page = 1,
  limit = 20,
): Promise<MemberBookingsResponse> {
  return apiRequest<MemberBookingsResponse>(
    `/studios/${studioId}/members/${userId}/bookings?page=${page}&limit=${limit}`,
    { method: "GET" },
  );
}

export async function fetchMemberAttendance(
  studioId: string,
  userId: string,
  page = 1,
  limit = 20,
): Promise<MemberAttendanceResponse> {
  return apiRequest<MemberAttendanceResponse>(
    `/studios/${studioId}/members/${userId}/attendance?page=${page}&limit=${limit}`,
    { method: "GET" },
  );
}

export async function fetchMemberPayments(
  studioId: string,
  userId: string,
  page = 1,
  limit = 20,
): Promise<MemberPaymentsResponse> {
  return apiRequest<MemberPaymentsResponse>(
    `/studios/${studioId}/members/${userId}/payments?page=${page}&limit=${limit}`,
    { method: "GET" },
  );
}

export async function fetchMemberSubscriptions(
  studioId: string,
  userId: string,
): Promise<MemberSubscription[]> {
  return apiRequest<MemberSubscription[]>(
    `/studios/${studioId}/members/${userId}/subscriptions`,
    { method: "GET" },
  );
}

export async function staffCreateBooking(
  studioId: string,
  userId: string,
  scheduledClassId: string,
): Promise<{ id: string }> {
  return apiRequest<{ id: string }>(
    `/studios/${studioId}/members/${userId}/bookings`,
    { method: "POST", body: JSON.stringify({ scheduledClassId }) },
  );
}

export async function staffCancelBooking(
  studioId: string,
  userId: string,
  bookingId: string,
): Promise<{ cancelled: boolean }> {
  return apiRequest<{ cancelled: boolean }>(
    `/studios/${studioId}/members/${userId}/bookings/${bookingId}`,
    { method: "DELETE" },
  );
}

export async function staffForceCheckIn(
  studioId: string,
  userId: string,
  bookingId: string,
): Promise<{ success: boolean }> {
  return apiRequest<{ success: boolean }>(
    `/studios/${studioId}/members/${userId}/bookings/${bookingId}/check-in`,
    { method: "POST" },
  );
}

export async function updateSubscriptionStatus(
  studioId: string,
  userId: string,
  subscriptionId: string,
  status: SubStatus,
): Promise<MemberSubscription> {
  return apiRequest<MemberSubscription>(
    `/studios/${studioId}/members/${userId}/subscriptions/${subscriptionId}/status`,
    { method: "PATCH", body: JSON.stringify({ status }) },
  );
}

export async function fetchMemberTimeline(
  studioId: string,
  userId: string,
): Promise<TimelineEvent[]> {
  return apiRequest<TimelineEvent[]>(
    `/studios/${studioId}/members/${userId}/timeline`,
    { method: "GET" },
  );
}

export async function fetchMemberAttendanceLog(
  studioId: string,
  userId: string,
  page = 1,
  limit = 25,
): Promise<AttendanceLogResponse> {
  return apiRequest<AttendanceLogResponse>(
    `/studios/${studioId}/members/${userId}/attendance-log?page=${page}&limit=${limit}`,
    { method: "GET" },
  );
}

export async function staffMarkNoShow(
  studioId: string,
  userId: string,
  bookingId: string,
): Promise<{ id: string; status: string }> {
  return apiRequest<{ id: string; status: string }>(
    `/studios/${studioId}/members/${userId}/bookings/${bookingId}/no-show`,
    { method: "POST" },
  );
}

export async function fetchMemberCrmProfile(
  studioId: string,
  userId: string,
): Promise<MemberCrmProfile | null> {
  return apiRequest<MemberCrmProfile | null>(
    `/studios/${studioId}/members/${userId}/profile`,
    { method: "GET" },
  );
}

export async function updateMemberCrmProfile(
  studioId: string,
  userId: string,
  input: UpsertCrmProfileInput,
): Promise<MemberCrmProfile> {
  return apiRequest<MemberCrmProfile>(
    `/studios/${studioId}/members/${userId}/profile`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
}

export async function fetchPlanChangePreview(
  studioId: string,
  memberId: string,
  planId: string,
): Promise<PlanChangePreview> {
  return apiRequest<PlanChangePreview>(
    `/studios/${studioId}/members/${memberId}/plan-change-preview?planId=${encodeURIComponent(planId)}`,
    { method: "GET" },
  );
}
