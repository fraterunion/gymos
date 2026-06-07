import { apiRequest } from '@/lib/api/client';
import type { BillingInterval } from '@/lib/api/membershipApi';

export type PublicStudioDto = {
  id: string;
  name: string;
  timezone: string;
};

export type PublicMembershipPlanDto = {
  id: string;
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

export async function fetchPublicStudio(slug: string): Promise<PublicStudioDto> {
  return apiRequest<PublicStudioDto>(`/public/studios/${slug}`, {
    method: 'GET',
    skipAuth: true,
  });
}

export async function fetchPublicMembershipPlans(slug: string): Promise<PublicMembershipPlanDto[]> {
  return apiRequest<PublicMembershipPlanDto[]>(`/public/studios/${slug}/membership-plans`, {
    method: 'GET',
    skipAuth: true,
  });
}
