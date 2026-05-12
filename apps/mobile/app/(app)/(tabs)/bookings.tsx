import { useRouter } from 'expo-router';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

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
import { formatClassRange } from '@/lib/datetime';
import { scheduledClassTitle } from '@/lib/classUtils';

export default function MyBookingsScreen() {
  const router = useRouter();
  const { primaryColor } = useBranding();
  const matched = useMemberStudio().matched;
  const { classes, myBookings, myWaitlist, loading, error, refresh } = useStudioActivity();

  const timeZone = matched?.studio.timezone ?? 'UTC';

  if (!matched) {
    return <ScreenLoader />;
  }

  if (error && myBookings.length === 0 && myWaitlist.length === 0) {
    return <LoadRetryPanel message={error} onRetry={refresh} />;
  }

  const showSkeleton = loading && myBookings.length === 0 && myWaitlist.length === 0;

  return (
    <SafeAreaView className="flex-1 bg-neutral-50 dark:bg-neutral-950" edges={['left', 'right']}>
      <ScrollView
        className="flex-1 px-5 pt-2"
        contentContainerClassName="pb-12"
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={() => void refresh()} tintColor={primaryColor} />
        }>
        {error ? <ErrorBanner message={error} onRetry={refresh} /> : null}

        {showSkeleton ? (
          <View className="mt-4 gap-3">
            <SkeletonBlock className="h-8 w-1/2" />
            <SkeletonBlock />
            <SkeletonBlock />
          </View>
        ) : (
          <>
            <SectionLabel>Bookings</SectionLabel>
            {myBookings.length === 0 ? (
              <EmptyHint title="No upcoming reservations" body="Pick a class from the schedule to book a spot." />
            ) : (
              myBookings.map((b) => (
                <Pressable
                  key={b.id}
                  onPress={() => router.push(`/(app)/class/${b.scheduledClassId}`)}
                  className="mb-3 rounded-2xl border border-neutral-200 bg-white px-4 py-3.5 dark:border-neutral-800 dark:bg-neutral-900">
                  <Text className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
                    {scheduledClassTitle(b.scheduledClassId, classes)}
                  </Text>
                  <Text className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                    {formatClassRange(b.scheduledClass.startsAt, b.scheduledClass.endsAt, timeZone)}
                  </Text>
                  <Text className="mt-2 text-xs font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
                    Confirmed
                  </Text>
                </Pressable>
              ))
            )}

            <SectionLabel>Waitlist</SectionLabel>
            {myWaitlist.length === 0 ? (
              <EmptyHint title="No waitlist spots" body="Join a waitlist when a class you want is full." />
            ) : (
              myWaitlist.map((w) => (
                <Pressable
                  key={w.id}
                  onPress={() => router.push(`/(app)/class/${w.scheduledClassId}`)}
                  className="mb-3 rounded-2xl border border-neutral-200 bg-white px-4 py-3.5 dark:border-neutral-800 dark:bg-neutral-900">
                  <Text className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
                    {scheduledClassTitle(w.scheduledClassId, classes)}
                  </Text>
                  <Text className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                    {formatClassRange(w.scheduledClass.startsAt, w.scheduledClass.endsAt, timeZone)}
                  </Text>
                  <Text className="mt-2 text-xs font-medium uppercase tracking-wide text-neutral-500">
                    {w.status === 'WAITING'
                      ? `Waiting · #${w.queueRank ?? '—'} of ${w.waitingCountForClass}`
                      : w.status === 'PROMOTED'
                        ? 'Promoted — seat pending'
                        : w.status}
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
