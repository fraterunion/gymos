import { apiRequest } from '@/lib/api/client';

export type BillingInterval = 'MONTHLY' | 'YEARLY' | 'WEEKLY';

export type MembershipPlanDto = {
  id: string;
  studioId: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  billingInterval: BillingInterval;
  classCredits: number | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type MyMemberProfileDto = {
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
  activeSubscription: {
    id: string;
    status: string;
    currentPeriodStart: string;
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
    creditsUsed: number | null;
    creditsRemaining: number | null;
    plan: {
      id: string;
      name: string;
      billingInterval: BillingInterval;
      priceCents: number;
      currency: string;
      classCredits: number | null;
      allowedCategories: string[];
    };
  } | null;
};

export async function fetchMembershipPlans(studioId: string): Promise<MembershipPlanDto[]> {
  return apiRequest<MembershipPlanDto[]>(`/studios/${studioId}/membership-plans`, { method: 'GET' });
}

export async function fetchMyMemberProfile(studioId: string): Promise<MyMemberProfileDto> {
  return apiRequest<MyMemberProfileDto>(`/studios/${studioId}/members/me`, { method: 'GET' });
}

export async function createMembershipCheckoutSession(
  studioId: string,
  planId: string,
): Promise<{ url: string }> {
  return apiRequest<{ url: string }>(`/studios/${studioId}/membership-plans/${planId}/checkout`, {
    method: 'POST',
    body: '{}',
  });
}

export async function createBillingPortalSession(studioId: string): Promise<{ url: string }> {
  return apiRequest<{ url: string }>(`/studios/${studioId}/billing-portal`, {
    method: 'POST',
    body: '{}',
  });
}

export type CheckoutPreviewDto = {
  planPriceCents: number;
  currency: string;
  enrollmentFeeApplies: boolean;
  enrollmentFeeCents: number;
  promoLikelySlotsAvailable: boolean;
  campaignName: string | null;
};

export async function fetchCheckoutPreview(
  studioId: string,
  planId: string,
): Promise<CheckoutPreviewDto> {
  return apiRequest<CheckoutPreviewDto>(
    `/studios/${studioId}/membership-plans/${planId}/checkout-preview`,
    { method: 'GET' },
  );
}
