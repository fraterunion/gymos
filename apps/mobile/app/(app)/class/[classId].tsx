import { useNavigation } from '@react-navigation/native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useLayoutEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
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

// Instructor avatar with initials
function InstructorBlock({ firstName, lastName }: { firstName: string; lastName: string }) {
  const C = getColors();
  const initials = `${firstName[0] ?? ''}${lastName[0] ?? ''}`.toUpperCase();
  const fullName = `${firstName} ${lastName}`.trim();

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 28 }}>
      <View
        style={{
          width: 44,
          height: 44,
          borderRadius: 22,
          backgroundColor: C.surface3,
          alignItems: 'center',
          justifyContent: 'center',
          marginRight: 14,
        }}
      >
        <Text style={{ fontSize: 14, fontWeight: '700', color: C.text, letterSpacing: 0.5 }}>
          {initials}
        </Text>
      </View>
      <View>
        <Text style={{ fontSize: 15, fontWeight: '600', color: C.text, letterSpacing: -0.1 }}>
          {fullName}
        </Text>
        <Text style={{ fontSize: 12, color: C.textMute, marginTop: 2 }}>Instructor</Text>
      </View>
    </View>
  );
}

export default function ClassDetailScreen() {
  const navigation = useNavigation();
  const router = useRouter();
  const C = getColors();

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
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['bottom', 'left', 'right']}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 24 }}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={() => void refresh()} tintColor={primaryColor} />
        }
      >
        <Animated.View entering={FadeInDown.duration(380)}>
          {/* ── Hero header — different surface for depth ── */}
          <View
            style={{
              backgroundColor: C.surface1,
              paddingHorizontal: Space.screenH,
              paddingTop: 32,
              paddingBottom: 28,
            }}
          >
            {/* Class name — cinematic */}
            <Text
              style={{
                fontSize: 42,
                fontWeight: '800',
                letterSpacing: -1.5,
                color: C.text,
                lineHeight: 48,
              }}
            >
              {cls.classTemplate.name}
            </Text>

            {/* Time + duration row */}
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 16 }}>
              <Text style={{ fontSize: 17, color: C.textSub, letterSpacing: -0.2 }}>
                {time}
              </Text>
              <Text style={{ fontSize: 14, color: C.textMute, marginHorizontal: 8 }}>·</Text>
              <Text style={{ fontSize: 16, color: C.textMute }}>
                {duration} min
              </Text>
            </View>

            {/* Capacity */}
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}>
              <Text style={{ fontSize: 13, color: C.textMute }}>
                Up to {cls.capacity} spots
              </Text>
            </View>

            {/* Instructor block */}
            {cls.instructor ? (
              <InstructorBlock
                firstName={cls.instructor.firstName}
                lastName={cls.instructor.lastName}
              />
            ) : null}
          </View>

          {/* ── Body ── */}
          <View style={{ paddingHorizontal: Space.screenH, paddingTop: 24 }}>
            {/* Description */}
            {cls.classTemplate.description ? (
              <Text
                style={{
                  fontSize: 16,
                  lineHeight: 25,
                  color: C.textSub,
                  letterSpacing: -0.1,
                }}
              >
                {cls.classTemplate.description}
              </Text>
            ) : null}

            {/* Status messages */}
            {!isScheduled ? (
              <View style={{ marginTop: 32 }}>
                <EmptyHint title="Not bookable" body="This session is not open for new bookings." />
              </View>
            ) : hasStarted ? (
              <View style={{ marginTop: 32 }}>
                <EmptyHint title="Class has started" body="Booking and waitlist changes are closed." />
              </View>
            ) : waitlistEntry?.status === 'PROMOTED' && !booking ? (
              <View style={{ marginTop: 32 }}>
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
                  fontSize: 15,
                  lineHeight: 22,
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
                  lineHeight: 21,
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
          </View>
        </Animated.View>
      </ScrollView>

      {/* ── Sticky CTA bar ── */}
      {(primaryCTA || booking) ? (
        <View
          style={{
            paddingHorizontal: Space.screenH,
            paddingBottom: 16,
            paddingTop: 14,
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
