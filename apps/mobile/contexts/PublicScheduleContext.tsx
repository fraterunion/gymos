import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { fetchPublicSchedule } from '@/lib/api/publicScheduleApi';
import { buildScheduleQueryRange } from '@/lib/datetime';
import { getStudioSlug } from '@/lib/env';
import { userFacingApiMessage } from '@/lib/userFacingApiMessage';
import type { ScheduledClassDto } from '@/lib/types/studio';

type PublicScheduleContextValue = {
  classes: ScheduledClassDto[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

const PublicScheduleContext = createContext<PublicScheduleContextValue | null>(null);

export function PublicScheduleProvider({ children }: { children: ReactNode }) {
  const [classes, setClasses] = useState<ScheduledClassDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const slug = getStudioSlug();
    if (!slug) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const { from, to } = buildScheduleQueryRange();
    try {
      const data = await fetchPublicSchedule(slug, from, to);
      setClasses(data);
    } catch (e) {
      setError(userFacingApiMessage(e, 'We could not load the schedule. Pull to try again.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const value = useMemo<PublicScheduleContextValue>(
    () => ({ classes, loading, error, refresh: load }),
    [classes, loading, error, load],
  );

  return <PublicScheduleContext.Provider value={value}>{children}</PublicScheduleContext.Provider>;
}

export function usePublicSchedule(): PublicScheduleContextValue {
  const ctx = useContext(PublicScheduleContext);
  if (!ctx) {
    throw new Error('usePublicSchedule must be used within PublicScheduleProvider');
  }
  return ctx;
}
