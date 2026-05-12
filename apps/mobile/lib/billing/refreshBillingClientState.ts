import { fetchMembershipPlans, fetchMyMemberProfile, type MyMemberProfileDto } from '@/lib/api/membershipApi';

export async function refreshBillingClientState(
  studioId: string,
  refreshStudioActivity: () => Promise<void>,
): Promise<{ profile: MyMemberProfileDto }> {
  const [, , profile] = await Promise.all([
    refreshStudioActivity(),
    fetchMembershipPlans(studioId),
    fetchMyMemberProfile(studioId),
  ]);
  return { profile };
}
