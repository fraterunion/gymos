import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { useMemberStudio } from '@/contexts/MemberStudioContext';
import { fetchMyMemberProfile } from '@/lib/api/membershipApi';
import {
  NO_OPEN_GYM,
  resolveOpenGymEntitlement,
  type OpenGymEntitlementDto,
} from '@/lib/openGymEntitlement';

/**
 * The member's Open Gym entitlement, re-read from the API every time the screen gains focus,
 * so an Admin toggle change, plan change, cancellation or expiry is reflected on the next
 * visit without an app restart. Nothing is cached across sessions. Fail-closed: guests,
 * loading, and errors all yield "not included".
 */
export function useOpenGymEntitlement(): OpenGymEntitlementDto {
  const studioId = useMemberStudio().matched?.studio.id;
  const [entitlement, setEntitlement] = useState<OpenGymEntitlementDto>(NO_OPEN_GYM);

  useFocusEffect(
    useCallback(() => {
      if (!studioId) {
        setEntitlement(NO_OPEN_GYM);
        return undefined;
      }
      let cancelled = false;
      fetchMyMemberProfile(studioId)
        .then((profile) => {
          if (!cancelled) setEntitlement(resolveOpenGymEntitlement(profile));
        })
        .catch(() => {
          if (!cancelled) setEntitlement(NO_OPEN_GYM);
        });
      return () => {
        cancelled = true;
      };
    }, [studioId]),
  );

  return entitlement;
}
