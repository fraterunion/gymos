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
    entitlementEndsAt: string | null;
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
      allClassesAccess: boolean;
      allowedTemplateIds: string[];
    };
  } | null;
};

export async function fetchMembershipPlans(studioId: string): Promise<MembershipPlanDto[]> {
  return apiRequest<MembershipPlanDto[]>(`/studios/${studioId}/membership-plans`, { method: 'GET' });
}

export async function fetchMyMemberProfile(studioId: string): Promise<MyMemberProfileDto> {
  return apiRequest<MyMemberProfileDto>(`/studios/${studioId}/members/me`, { method: 'GET' });
}

export type MembershipPurchaseResponse =
  | { action: 'checkout'; url: string }
  | {
      action: 'plan_changed';
      effective: 'immediate' | 'next_period';
      message: string;
      subscriptionId: string;
      stripeSubscriptionId: string;
      previousPlan: {
        id: string;
        name: string;
        priceCents: number;
        currency: string;
        billingInterval: BillingInterval;
      };
      newPlan: {
        id: string;
        name: string;
        priceCents: number;
        currency: string;
        billingInterval: BillingInterval;
      };
      nextRenewalAt: string | null;
      requiresPayment?: boolean;
      paymentUrl?: string | null;
    };

export type PlanChangePreviewDto = {
  hasCurrentMembership: boolean;
  isPlanChange: boolean;
  currentPlan: {
    id: string;
    name: string;
    priceCents: number;
    currency: string;
    billingInterval: BillingInterval;
  } | null;
  newPlan: {
    id: string;
    name: string;
    priceCents: number;
    currency: string;
    billingInterval: BillingInterval;
  };
  effective: 'immediate' | 'next_period' | 'checkout';
  message: string;
};

export async function fetchPlanChangePreview(
  studioId: string,
  planId: string,
): Promise<PlanChangePreviewDto> {
  return apiRequest<PlanChangePreviewDto>(
    `/studios/${studioId}/membership-plans/${planId}/plan-change-preview`,
    { method: 'GET' },
  );
}

export async function createMembershipCheckoutSession(
  studioId: string,
  planId: string,
): Promise<MembershipPurchaseResponse> {
  return apiRequest<MembershipPurchaseResponse>(`/studios/${studioId}/membership-plans/${planId}/checkout`, {
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
