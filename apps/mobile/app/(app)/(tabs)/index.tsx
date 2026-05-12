import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ClassCardRow } from '@/components/ClassCardRow';
import {
  EmptyHint,
  ErrorBanner,
  LoadRetryPanel,
  SectionLabel,
  SkeletonBlock,
  ScreenLoader,
} from '@/components/StudioScreenChrome';
import { useBranding } from '@/contexts/BrandingContext';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import { useStudioActivity } from '@/contexts/StudioActivityContext';
import { calendarDayKeyInZone, formatClassRange, todayKeyInZone } from '@/lib/datetime';
import { scheduledClassTitle } from '@/lib/classUtils';

export default function HomeScreen() {
  const router = useRouter();
  const { primaryColor } = useBranding();
  const matched = useMemberStudio().matched;
  const { classes, myBookings, myWaitlist, loading, error, refresh } = useStudioActivity();

  const timeZone = matched?.studio.timezone ?? 'UTC';

  const todayKey = useMemo(() => todayKeyInZone(timeZone), [timeZone]);

  const todaysUpcoming = useMemo(() => {
    const now = Date.now();
    return classes
      .filter(
        (c) =>
          c.status === 'SCHEDULED' &&
          new Date(c.startsAt).getTime() > now &&
          calendarDayKeyInZone(c.startsAt, timeZone) === todayKey,
      )
      .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  }, [classes, timeZone, todayKey]);

  const nextBooking = myBookings[0] ?? null;
  const waitlistPreview = useMemo(
    () => myWaitlist.filter((w) => w.status === 'WAITING' || w.status === 'PROMOTED').slice(0, 4),
    [myWaitlist],
  );

  if (!matched) {
    return <ScreenLoader />;
  }

  if (error && classes.length === 0 && myBookings.length === 0 && myWaitlist.length === 0) {
    return <LoadRetryPanel message={error} onRetry={refresh} />;
  }

  const showSkeleton = loading && classes.length === 0;

  return (
    <SafeAreaView className="flex-1 bg-neutral-50 dark:bg-neutral-950" edges={['left', 'right']}>
      <ScrollView
        className="flex-1 px-5 pt-2"
        contentContainerClassName="pb-10"
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refresh()} tintColor={primaryColor} />}>
        {error ? <ErrorBanner message={error} onRetry={refresh} /> : null}

        {showSkeleton ? (
          <View className="mt-4 gap-3">
            <SkeletonBlock className="h-8 w-2/3" />
            <SkeletonBlock />
            <SkeletonBlock />
            <SkeletonBlock className="h-8 w-1/2 mt-6" />
            <SkeletonBlock />
          </View>
        ) : (
          <>
            <SectionLabel>Today</SectionLabel>
            {todaysUpcoming.length === 0 ? (
              <EmptyHint
                title="No more classes today"
                body="Browse the schedule for upcoming sessions."
              />
            ) : (
              todaysUpcoming.map((c) => (
                <ClassCardRow
                  key={c.id}
                  item={c}
                  timeZone={timeZone}
                  accentColor={c.classTemplate.color ?? primaryColor}
                  onPress={() => router.push(`/(app)/class/${c.id}`)}
                />
              ))
            )}

            <SectionLabel>Next booking</SectionLabel>
            {!nextBooking ? (
              <EmptyHint title="No upcoming bookings" body="Reserve a spot from the schedule when you are ready." />
            ) : (
              <Pressable
                onPress={() => router.push(`/(app)/class/${nextBooking.scheduledClassId}`)}
                className="rounded-2xl border border-neutral-200 bg-white px-4 py-4 dark:border-neutral-800 dark:bg-neutral-900">
                <Text className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
                  {scheduledClassTitle(nextBooking.scheduledClassId, classes)}
                </Text>
                <Text className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                  {formatClassRange(
                    nextBooking.scheduledClass.startsAt,
                    nextBooking.scheduledClass.endsAt,
                    timeZone,
                  )}
                </Text>
              </Pressable>
            )}

            <SectionLabel>Waitlist</SectionLabel>
            {waitlistPreview.length === 0 ? (
              <EmptyHint title="Not on a waitlist" body="When a class is full, you can join the waitlist from the class page." />
            ) : (
              waitlistPreview.map((w) => (
                <Pressable
                  key={w.id}
                  onPress={() => router.push(`/(app)/class/${w.scheduledClassId}`)}
                  className="mb-2 rounded-2xl border border-neutral-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900">
                  <Text className="text-base font-medium text-neutral-900 dark:text-neutral-50">
                    {scheduledClassTitle(w.scheduledClassId, classes)}
                  </Text>
                  <Text className="mt-1 text-xs text-neutral-500">
                    {w.status === 'WAITING'
                      ? `Queue ${w.queueRank ?? '—'} · ${w.waitingCountForClass} waiting`
                      : 'Moved off waitlist — check bookings'}
                  </Text>
                </Pressable>
              ))
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
