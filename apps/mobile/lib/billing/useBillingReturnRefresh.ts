import { useCallback } from 'react';

import { useMemberStudio } from '@/contexts/MemberStudioContext';
import { useStudioActivity } from '@/contexts/StudioActivityContext';
import type { MyMemberProfileDto } from '@/lib/api/membershipApi';

import { refreshBillingClientState } from './refreshBillingClientState';

export function useBillingReturnRefresh() {
  const { matched } = useMemberStudio();
  const { refresh: refreshStudioActivity } = useStudioActivity();
  const studioId = matched?.studio.id;

  const refreshAll = useCallback(async (): Promise<{ profile: MyMemberProfileDto | null }> => {
    if (!studioId) {
      return { profile: null };
    }
    const { profile } = await refreshBillingClientState(studioId, refreshStudioActivity);
    return { profile };
  }, [studioId, refreshStudioActivity]);

  return { studioId, refreshAll };
}
