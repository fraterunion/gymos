import { useNavigation } from '@react-navigation/native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useLayoutEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, Text, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { BrandButton } from '@/components/BrandButton';
import { SubscriptionRequiredPanel } from '@/components/SubscriptionRequiredPanel';
import { EmptyHint, LoadRetryPanel, ScreenLoader } from '@/components/StudioScreenChrome';
import { useBranding } from '@/contexts/BrandingContext';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import { useStudioActivity } from '@/contexts/StudioActivityContext';
import { cancelBooking, createClassBooking } from '@/lib/api/bookingsApi';
import { ApiError } from '@/lib/api/errors';
import { isActiveSubscriptionRequiredError } from '@/lib/billing/subscriptionRequired';
import { userFacingApiMessage } from '@/lib/userFacingApiMessage';
import { cancelWaitlistEntry, joinClassWaitlist } from '@/lib/api/waitlistApi';
import { isClassFullMessage } from '@/lib/classUtils';
import { formatClassTime } from '@/lib/datetime';
import { getColors, Space } from '@/constants/Theme';

export default function ClassDetailScreen() {
  const navigation = useNavigation();
  const router = useRouter();
  const scheme = useColorScheme();
  const C = getColors(scheme);

  const raw = useLocalSearchParams<{ classId: string | string[] }>().classId;
  const classId = typeof raw === 'string' ? raw : raw?.[0] ?? '';

  const { primaryColor, appDisplayName } = useBranding();
  const matched = useMemberStudio().matched;
  const { myBookings, myWaitlist, loading, error, refresh, getClass } = useStudioActivity();

  const [busy, setBusy] = useState(false);
  const [offerWaitlist, setOfferWaitlist] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [subscriptionRequired, setSubscriptionRequired] = useState(false);

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
    navigation.setOptions({ title: cls?.classTemplate.name ?? 'Class' });
  }, [navigation, cls]);

  const now = Date.now();
  const hasStarted = cls ? new Date(cls.startsAt).getTime() <= now : true;
  const isScheduled = cls?.status === 'SCHEDULED';
  const canAct = isScheduled && !hasStarted;

  async function run(action: () => Promise<void>) {
    setInlineError(null);
    setSubscriptionRequired(false);
    setBusy(true);
    try {
      await action();
      setOfferWaitlist(false);
      setSubscriptionRequired(false);
      await refresh();
    } catch (e) {
      if (isActiveSubscriptionRequiredError(e)) {
        setSubscriptionRequired(true);
        return;
      }
      if (e instanceof ApiError && e.status === 409 && isClassFullMessage(e.message)) {
        setOfferWaitlist(true);
        return;
      }
      setInlineError(userFacingApiMessage(e, 'That action could not be completed. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  if (!studioId || !matched) return <ScreenLoader />;
  if (!classId) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['bottom']}>
        <EmptyHint title="Missing class" body="Go back and choose a class from the schedule." />
      </SafeAreaView>
    );
  }
  if (error && !cls && !loading) return <LoadRetryPanel message={error} onRetry={refresh} />;
  if (!cls && loading) return <ScreenLoader />;
  if (!cls) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg, paddingHorizontal: Space.screenH }} edges={['bottom']}>
        <EmptyHint
          title="Class not found"
          body="It may be outside the current schedule window. Try refreshing from the schedule tab."
        />
        <View style={{ marginTop: 24 }}>
          <BrandButton label="Refresh" accentColor={primaryColor} onPress={() => void refresh()} />
        </View>
      </SafeAreaView>
    );
  }

  const ins = cls.instructor
    ? `${cls.instructor.firstName} ${cls.instructor.lastName}`.trim()
    : null;

  const time = formatClassTime(cls.startsAt, timeZone);
  const duration = cls.classTemplate.durationMinutes;

  // CTA logic
  let primaryCTA: { label: string; onPress: () => void } | null = null;
  let secondaryCTA: { label: string; onPress: () => void } | null = null;

  if (booking) {
    primaryCTA = {
      label: 'Cancel booking',
      onPress: () => void run(async () => { await cancelBooking(studioId, booking.id); }),
    };
  } else if (waitlistEntry?.status === 'WAITING') {
    primaryCTA = {
      label: 'Leave waitlist',
      onPress: () => void run(async () => { await cancelWaitlistEntry(studioId, waitlistEntry.id); }),
    };
  } else if (canAct) {
    if (offerWaitlist) {
      primaryCTA = {
        label: 'Join waitlist',
        onPress: () => void run(async () => { await joinClassWaitlist(studioId, classId); }),
      };
      secondaryCTA = {
        label: 'Try booking again',
        onPress: () => void run(async () => { await createClassBooking(studioId, classId); }),
      };
    } else {
      primaryCTA = {
        label: 'Book class',
        onPress: () => void run(async () => { await createClassBooking(studioId, classId); }),
      };
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#0A0A0A' }} edges={['bottom', 'left', 'right']}>
      {/* Scrollable content */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: Space.screenH, paddingBottom: 24 }}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={() => void refresh()} tintColor={primaryColor} />
        }
      >
        <Animated.View entering={FadeInDown.duration(380)}>
          {/* Class name — hero */}
          <Text
            style={{
              fontSize: 30,
              fontWeight: '700',
              letterSpacing: -0.7,
              color: C.text,
              marginTop: 28,
              lineHeight: 36,
            }}
          >
            {cls.classTemplate.name}
          </Text>

          {/* Time + duration — second tier */}
          <Text
            style={{
              fontSize: 16,
              color: C.textSub,
              marginTop: 10,
              letterSpacing: -0.1,
            }}
          >
            {time}{'  ·  '}{duration} min
          </Text>

          {/* Instructor — whispered */}
          {ins ? (
            <Text style={{ fontSize: 14, color: C.textMute, marginTop: 6 }}>
              {ins}
            </Text>
          ) : null}

          {/* Description if available */}
          {cls.classTemplate.description ? (
            <Text
              style={{
                fontSize: 15,
                lineHeight: 23,
                color: C.textSub,
                marginTop: 24,
              }}
            >
              {cls.classTemplate.description}
            </Text>
          ) : null}

          {/* Status messages — minimal, no "Status · SCHEDULED" labels */}
          {!isScheduled ? (
            <View style={{ marginTop: 36 }}>
              <EmptyHint title="Not bookable" body="This session is not open for new bookings." />
            </View>
          ) : hasStarted ? (
            <View style={{ marginTop: 36 }}>
              <EmptyHint title="Class has started" body="Booking and waitlist changes are closed." />
            </View>
          ) : waitlistEntry?.status === 'PROMOTED' && !booking ? (
            <View style={{ marginTop: 36 }}>
              <EmptyHint
                title="You've been promoted"
                body="A seat may be held for you. Pull to refresh or check My bookings."
              />
            </View>
          ) : null}

          {offerWaitlist ? (
            <Text
              style={{
                marginTop: 20,
                textAlign: 'center',
                fontSize: 14,
                lineHeight: 21,
                color: C.textMute,
              }}
            >
              This class is full. Join the waitlist and we'll notify you if a spot opens.
            </Text>
          ) : null}

          {inlineError ? (
            <Text
              style={{
                marginTop: 20,
                textAlign: 'center',
                fontSize: 14,
                color: C.negative,
              }}
            >
              {inlineError}
            </Text>
          ) : null}

          {subscriptionRequired ? (
            <View style={{ marginTop: 24 }}>
              <SubscriptionRequiredPanel accentColor={primaryColor} appDisplayName={appDisplayName} />
            </View>
          ) : null}
        </Animated.View>
      </ScrollView>

      {/* ── Sticky CTA bar ── always visible, never scrolls away */}
      {(primaryCTA || booking) ? (
        <View
          style={{
            paddingHorizontal: Space.screenH,
            paddingBottom: 12,
            paddingTop: 12,
            borderTopWidth: 1,
            borderTopColor: C.separator,
            backgroundColor: C.bg,
            gap: 10,
          }}
        >
          {booking ? (
            <BrandButton
              label="Check-in QR"
              variant="ghost"
              accentColor={primaryColor}
              onPress={() => router.push(`/(app)/check-in/${booking.id}`)}
            />
          ) : null}
          {primaryCTA ? (
            <BrandButton
              label={primaryCTA.label}
              accentColor={primaryColor}
              loading={busy}
              onPress={primaryCTA.onPress}
            />
          ) : null}
          {secondaryCTA ? (
            <BrandButton
              label={secondaryCTA.label}
              variant="ghost"
              accentColor={primaryColor}
              loading={busy}
              onPress={secondaryCTA.onPress}
            />
          ) : null}
        </View>
      ) : null}
    </SafeAreaView>
  );
}
