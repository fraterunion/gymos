import { apiRequest } from "@/lib/api/client";

// ── Types ────────────────────────────────────────────────────────────────────

export type SubStatus = "ACTIVE" | "PAST_DUE" | "CANCELED" | "TRIALING" | "PAUSED";
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
  planName: string;
  planId: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
};

export type MemberListItem = {
  membershipId: string;
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
  lastAttendanceAt: string | null;
  subscription: MemberSubscriptionSummary | null;
};

export type MemberListResponse = {
  data: MemberListItem[];
  total: number;
  page: number;
  limit: number;
};

export type MemberListQuery = {
  search?: string;
  subStatus?: SubStatus;
  sortBy?: "joinDate" | "lastAttendance" | "totalBookings" | "name";
  sortDir?: "asc" | "desc";
  page?: number;
  limit?: number;
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
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  membershipPlan: MemberPlan;
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
  activeSubscription: {
    id: string;
    status: SubStatus;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    plan: MemberPlan;
  } | null;
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
  stripePaymentIntentId: string | null;
  stripeInvoiceId: string | null;
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
  if (query.subStatus) params.set("subStatus", query.subStatus);
  if (query.sortBy) params.set("sortBy", query.sortBy);
  if (query.sortDir) params.set("sortDir", query.sortDir);
  if (query.page) params.set("page", String(query.page));
  if (query.limit) params.set("limit", String(query.limit));
  const qs = params.toString();
  return apiRequest<MemberListResponse>(
    `/studios/${studioId}/members${qs ? `?${qs}` : ""}`,
    { method: "GET" },
  );
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
