import { apiRequest } from '@/lib/api/client';

export type SubStatus = 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'TRIALING' | 'PAUSED';

export type MemberPlanDto = {
  id: string;
  name: string;
  billingInterval: 'MONTHLY' | 'YEARLY' | 'WEEKLY';
  priceCents: number;
  currency: string;
  classCredits: number | null;
};

export type MemberProfileDto = {
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    phone: string | null;
    createdAt: string;
  };
  role: string;
  membership: { id: string; createdAt: string; updatedAt: string };
  attendances: { totalInStudio: number };
  bookingStats: {
    totalBookings: number;
    attendedCount: number;
    noShowCount: number;
    cancelledCount: number;
  };
  activeSubscription: {
    id: string;
    status: SubStatus;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    plan: MemberPlanDto;
    creditsUsed: number | null;
    creditsRemaining: number | null;
  } | null;
};

export type MemberSubscriptionDto = {
  id: string;
  status: SubStatus;
  source: 'STRIPE' | 'MANUAL' | 'CASH' | string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  membershipPlan: MemberPlanDto;
};

export type MemberAttendanceDto = {
  id: string;
  checkedInAt: string;
  method: 'QR' | 'MANUAL' | 'KIOSK';
  scheduledClass: {
    id: string;
    startsAt: string;
    endsAt: string;
    classTemplate: { id: string; name: string; color: string | null };
  };
};

export type MemberPaymentDto = {
  id: string;
  amountCents: number;
  currency: string;
  status: string;
  paymentMethod: 'STRIPE' | 'CASH' | string;
  paidAt: string | null;
  createdAt: string;
};

export type MemberTimelineEventDto = {
  type: string;
  title: string;
  description?: string | null;
  occurredAt: string;
};

export async function fetchMemberProfile(
  studioId: string,
  userId: string,
): Promise<MemberProfileDto> {
  return apiRequest<MemberProfileDto>(`/studios/${studioId}/members/${userId}`, { method: 'GET' });
}

export async function fetchMemberSubscriptions(
  studioId: string,
  userId: string,
): Promise<MemberSubscriptionDto[]> {
  return apiRequest<MemberSubscriptionDto[]>(
    `/studios/${studioId}/members/${userId}/subscriptions`,
    { method: 'GET' },
  );
}

export async function fetchMemberAttendance(
  studioId: string,
  userId: string,
  limit = 5,
): Promise<{ data: MemberAttendanceDto[]; total: number }> {
  return apiRequest<{ data: MemberAttendanceDto[]; total: number; page: number; limit: number }>(
    `/studios/${studioId}/members/${userId}/attendance?page=1&limit=${limit}`,
    { method: 'GET' },
  );
}

export async function fetchMemberPayments(
  studioId: string,
  userId: string,
  limit = 5,
): Promise<{ data: MemberPaymentDto[]; total: number }> {
  return apiRequest<{ data: MemberPaymentDto[]; total: number; page: number; limit: number }>(
    `/studios/${studioId}/members/${userId}/payments?page=1&limit=${limit}`,
    { method: 'GET' },
  );
}

export async function fetchMemberTimeline(
  studioId: string,
  userId: string,
): Promise<MemberTimelineEventDto[]> {
  return apiRequest<MemberTimelineEventDto[]>(
    `/studios/${studioId}/members/${userId}/timeline`,
    { method: 'GET' },
  );
}
