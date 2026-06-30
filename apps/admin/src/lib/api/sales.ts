import { apiRequest } from "@/lib/api/client";
import type { MemberListItem } from "@/lib/api/members";

export type SalesSettings = {
  frontDeskCanCreateMember: boolean;
  frontDeskCanIssueCheckout: boolean;
  frontDeskCanRecordCash: boolean;
};

export type WalkInMemberResult = {
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    phone: string | null;
    createdAt: string;
  };
  membership: {
    id: string;
    role: string;
    createdAt: string;
  };
};

export type StaffCheckoutResult = {
  checkoutUrl: string;
};

export type OfflineSubscriptionResult = {
  subscription: {
    id: string;
    status: string;
    source: string;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    membershipPlan: {
      id: string;
      name: string;
      priceCents: number;
      currency: string;
    };
  };
  payment: {
    id: string;
    amountCents: number;
    status: string;
    paymentMethod: string;
  };
};

export async function fetchSalesSettings(studioId: string): Promise<SalesSettings> {
  return apiRequest<SalesSettings>(`/studios/${studioId}/sales/settings`, { method: "GET" });
}

export async function createWalkInMember(
  studioId: string,
  input: {
    email: string;
    firstName: string;
    lastName: string;
    phone?: string;
    temporaryPassword: string;
  },
): Promise<WalkInMemberResult> {
  return apiRequest<WalkInMemberResult>(`/studios/${studioId}/members`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function createStaffCheckoutSession(
  studioId: string,
  userId: string,
  planId: string,
): Promise<StaffCheckoutResult> {
  return apiRequest<StaffCheckoutResult>(
    `/studios/${studioId}/members/${userId}/checkout-sessions`,
    {
      method: "POST",
      body: JSON.stringify({ planId }),
    },
  );
}

export async function createOfflineSubscription(
  studioId: string,
  userId: string,
  input: {
    planId: string;
    amountCents: number;
    periodStart?: string;
    periodEnd?: string;
    paymentMethod: "CASH";
    notes?: string;
    priceOverrideNote?: string;
  },
): Promise<OfflineSubscriptionResult> {
  return apiRequest<OfflineSubscriptionResult>(
    `/studios/${studioId}/members/${userId}/offline-subscriptions`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export function memberDisplayName(member: Pick<MemberListItem, "user">): string {
  return `${member.user.firstName} ${member.user.lastName}`.trim();
}

export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}
