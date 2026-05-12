import { useNavigation } from '@react-navigation/native';
import { useLocalSearchParams } from 'expo-router';
import { useLayoutEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BrandButton } from '@/components/BrandButton';
import { EmptyHint, LoadRetryPanel, ScreenLoader } from '@/components/StudioScreenChrome';
import { useBranding } from '@/contexts/BrandingContext';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import { useStudioActivity } from '@/contexts/StudioActivityContext';
import { cancelBooking, createClassBooking } from '@/lib/api/bookingsApi';
import { ApiError } from '@/lib/api/errors';
import { cancelWaitlistEntry, joinClassWaitlist } from '@/lib/api/waitlistApi';
import { isClassFullMessage } from '@/lib/classUtils';
import { formatClassRange } from '@/lib/datetime';

export default function ClassDetailScreen() {
  const navigation = useNavigation();
  const raw = useLocalSearchParams<{ classId: string | string[] }>().classId;
  const classId = typeof raw === 'string' ? raw : raw?.[0] ?? '';
  const { primaryColor } = useBranding();
  const matched = useMemberStudio().matched;
  const { myBookings, myWaitlist, loading, error, refresh, getClass } = useStudioActivity();

  const [busy, setBusy] = useState(false);
  const [offerWaitlist, setOfferWaitlist] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);

  const studioId = matched?.studio.id;
  const timeZone = matched?.studio.timezone ?? 'UTC';

  const cls = useMemo(() => getClass(classId), [getClass, classId]);

  const booking = useMemo(
    () => myBookings.find((b) => b.scheduledClassId === classId && b.status === 'CONFIRMED'),
    [myBookings, classId],
  );

  const waitlistEntry = useMemo(
    () => myWaitlist.find((w) => w.scheduledClassId === classId),
    [myWaitlist, classId],
  );

  useLayoutEffect(() => {
    navigation.setOptions({
      title: cls?.classTemplate.name ?? 'Class',
    });
  }, [navigation, cls]);

  const now = Date.now();
  const hasStarted = cls ? new Date(cls.startsAt).getTime() <= now : true;
  const isScheduled = cls?.status === 'SCHEDULED';

  async function run(action: () => Promise<void>) {
    setInlineError(null);
    setBusy(true);
    try {
      await action();
      setOfferWaitlist(false);
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && isClassFullMessage(e.message)) {
        setOfferWaitlist(true);
        return;
      }
      setInlineError(e instanceof ApiError ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  if (!studioId || !matched) {
    return <ScreenLoader />;
  }

  if (!classId) {
    return (
      <SafeAreaView className="flex-1 bg-neutral-50 px-5 dark:bg-neutral-950">
        <EmptyHint title="Missing class" body="Go back and choose a class from the schedule." />
      </SafeAreaView>
    );
  }

  if (error && !cls && !loading) {
    return <LoadRetryPanel message={error} onRetry={refresh} />;
  }

  if (!cls && loading) {
    return <ScreenLoader />;
  }

  if (!cls) {
    return (
      <SafeAreaView className="flex-1 bg-neutral-50 px-5 pt-4 dark:bg-neutral-950">
        <EmptyHint
          title="Class not found"
          body="It may be outside the current schedule window. Try refreshing from the schedule tab."
        />
        <View className="mt-6">
          <BrandButton label="Refresh" accentColor={primaryColor} onPress={() => void refresh()} />
        </View>
      </SafeAreaView>
    );
  }

  const ins = cls.instructor
    ? `${cls.instructor.firstName} ${cls.instructor.lastName}`.trim()
    : null;

  const canAct = isScheduled && !hasStarted;

  let primary:
    | { label: string; onPress: () => void }
    | null = null;
  let secondary: { label: string; onPress: () => void } | null = null;

  if (booking) {
    primary = {
      label: 'Cancel booking',
      onPress: () =>
        void run(async () => {
          await cancelBooking(studioId, booking.id);
        }),
    };
  } else if (waitlistEntry?.status === 'WAITING') {
    primary = {
      label: 'Leave waitlist',
      onPress: () =>
        void run(async () => {
          await cancelWaitlistEntry(studioId, waitlistEntry.id);
        }),
    };
  } else if (waitlistEntry?.status === 'PROMOTED' && !booking) {
    primary = null;
  } else if (canAct) {
    if (offerWaitlist) {
      primary = {
        label: 'Join waitlist',
        onPress: () =>
          void run(async () => {
            await joinClassWaitlist(studioId, classId);
          }),
      };
      secondary = {
        label: 'Try booking again',
        onPress: () =>
          void run(async () => {
            await createClassBooking(studioId, classId);
          }),
      };
    } else {
      primary = {
        label: 'Book class',
        onPress: () =>
          void run(async () => {
            await createClassBooking(studioId, classId);
          }),
      };
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-neutral-50 dark:bg-neutral-950" edges={['bottom', 'left', 'right']}>
      <ScrollView
        className="flex-1 px-5 pt-2"
        contentContainerClassName="pb-10"
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={() => void refresh()} tintColor={primaryColor} />
        }>
        <Text className="text-2xl font-semibold text-neutral-900 dark:text-neutral-50">
          {cls.classTemplate.name}
        </Text>
        <Text className="mt-2 text-base text-neutral-600 dark:text-neutral-400">
          {formatClassRange(cls.startsAt, cls.endsAt, timeZone)}
        </Text>
        {ins ? (
          <Text className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">Instructor · {ins}</Text>
        ) : null}
        <Text className="mt-4 text-sm text-neutral-500 dark:text-neutral-400">
          Status · <Text className="font-medium text-neutral-700 dark:text-neutral-200">{cls.status}</Text>
        </Text>
        <Text className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">Capacity · {cls.capacity}</Text>

        {!isScheduled ? (
          <View className="mt-8">
            <EmptyHint title="Not bookable" body="This session is not open for new bookings." />
          </View>
        ) : hasStarted ? (
          <View className="mt-8">
            <EmptyHint title="Class has started" body="Booking and waitlist changes are closed for this time." />
          </View>
        ) : waitlistEntry?.status === 'PROMOTED' && !booking ? (
          <View className="mt-8">
            <EmptyHint
              title="You have been promoted"
              body="A seat may be held for you. Pull to refresh or check My bookings."
            />
          </View>
        ) : null}

        {inlineError ? (
          <Text className="mt-6 text-center text-sm text-red-600 dark:text-red-400">{inlineError}</Text>
        ) : null}

        {offerWaitlist ? (
          <Text className="mt-4 text-center text-sm text-neutral-600 dark:text-neutral-400">
            This class is full. Join the waitlist to be notified if a spot opens.
          </Text>
        ) : null}

        <View className="mt-10 gap-3">
          {primary ? (
            <BrandButton
              label={primary.label}
              accentColor={primaryColor}
              loading={busy}
              onPress={primary.onPress}
            />
          ) : null}
          {secondary ? (
            <BrandButton
              label={secondary.label}
              variant="ghost"
              accentColor={primaryColor}
              loading={busy}
              onPress={secondary.onPress}
            />
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
