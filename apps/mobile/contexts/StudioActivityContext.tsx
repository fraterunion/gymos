import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { fetchMyBookings } from '@/lib/api/bookingsApi';
import { fetchStudioSchedule } from '@/lib/api/scheduleApi';
import { fetchMyWaitlist } from '@/lib/api/waitlistApi';
import { ApiError } from '@/lib/api/errors';
import { buildScheduleQueryRange } from '@/lib/datetime';
import type { BookingWithClass, MyWaitlistEntry, ScheduledClassDto } from '@/lib/types/studio';

type StudioActivityContextValue = {
  classes: ScheduledClassDto[];
  myBookings: BookingWithClass[];
  myWaitlist: MyWaitlistEntry[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  getClass: (id: string) => ScheduledClassDto | undefined;
};

const StudioActivityContext = createContext<StudioActivityContextValue | null>(null);

export function StudioActivityProvider({
  studioId,
  children,
}: {
  studioId: string;
  children: ReactNode;
}) {
  const [classes, setClasses] = useState<ScheduledClassDto[]>([]);
  const [myBookings, setMyBookings] = useState<BookingWithClass[]>([]);
  const [myWaitlist, setMyWaitlist] = useState<MyWaitlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const range = buildScheduleQueryRange();
    try {
      const [c, b, w] = await Promise.all([
        fetchStudioSchedule(studioId, range.from, range.to),
        fetchMyBookings(studioId),
        fetchMyWaitlist(studioId),
      ]);
      setClasses(c);
      setMyBookings(b);
      setMyWaitlist(w);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Something went wrong.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [studioId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const getClass = useCallback(
    (id: string) => classes.find((x) => x.id === id),
    [classes],
  );

  const value = useMemo<StudioActivityContextValue>(
    () => ({
      classes,
      myBookings,
      myWaitlist,
      loading,
      error,
      refresh: load,
      getClass,
    }),
    [classes, myBookings, myWaitlist, loading, error, load, getClass],
  );

  return <StudioActivityContext.Provider value={value}>{children}</StudioActivityContext.Provider>;
}

export function useStudioActivity(): StudioActivityContextValue {
  const ctx = useContext(StudioActivityContext);
  if (!ctx) {
    throw new Error('useStudioActivity must be used within StudioActivityProvider');
  }
  return ctx;
}
