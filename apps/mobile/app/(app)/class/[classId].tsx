import { useNavigation } from '@react-navigation/native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { AuthRequiredModal } from '@/components/AuthRequiredModal';
import { BrandButton } from '@/components/BrandButton';
import { ImageSlot } from '@/components/ImageSlot';
import { SubscriptionRequiredPanel } from '@/components/SubscriptionRequiredPanel';
import { EmptyHint, LoadRetryPanel, ScreenLoader } from '@/components/StudioScreenChrome';
import { useAuth } from '@/contexts/AuthContext';
import { useBranding } from '@/contexts/BrandingContext';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import { usePublicStudio } from '@/contexts/PublicStudioContext';
import { useStudioActivity } from '@/contexts/StudioActivityContext';
import { cancelBooking, createClassBooking } from '@/lib/api/bookingsApi';
import { fetchPublicSchedule } from '@/lib/api/publicScheduleApi';
import { fetchMyDayPasses, type DayPassDto } from '@/lib/api/dayPassesApi';
import { fetchMyMemberProfile, type MyMemberProfileDto } from '@/lib/api/membershipApi';
import { ApiError } from '@/lib/api/errors';
import { isActiveSubscriptionRequiredError } from '@/lib/billing/subscriptionRequired';
import { userFacingApiMessage } from '@/lib/userFacingApiMessage';
import { cancelWaitlistEntry, joinClassWaitlist } from '@/lib/api/waitlistApi';
import { isClassFullMessage } from '@/lib/classUtils';
import {
  buildScheduleQueryRange,
  calendarDayKeyInZone,
  formatClassDateLabel,
  formatClassTime,
} from '@/lib/datetime';
import { getStudioSlug } from '@/lib/env';
import { resolveCoachPortraitUri, resolveScheduledClassImageUri } from '@/lib/imagery';
import { getColors, Space } from '@/constants/Theme';
import type { ScheduledClassDto } from '@/lib/types/studio';

const PLAN_RESTRICTED_MESSAGE =
  'Your current membership does not include this class type. Upgrade your plan or get a Day Pass to book this class.';

function hasActiveDayPassForClassDate(
  dayPasses: DayPassDto[],
  classStartsAt: string,
  timeZone: string,
): boolean {
  const classDateKey = calendarDayKeyInZone(classStartsAt, timeZone);
  return dayPasses.some(
    (dp) =>
      dp.status === 'ACTIVE' &&
      calendarDayKeyInZone(dp.validForDate, timeZone) === classDateKey,
  );
}

// ---------------------------------------------------------------------------
// Instructor portrait block
// ---------------------------------------------------------------------------

function InstructorBlock({
  firstName,
  lastName,
  photoUrl,
  bio,
  accentColor,
}: {
  firstName: string;
  lastName: string;
  photoUrl?: string | null;
  bio?: string | null;
  accentColor: string;
}) {
  const C = getColors();
  const initials = `${firstName[0] ?? ''}${lastName[0] ?? ''}`.toUpperCase();
  const portraitUri = photoUrl ?? resolveCoachPortraitUri(firstName, lastName);

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        marginTop: 24,
        paddingTop: 22,
        borderTopWidth: 1,
        borderTopColor: C.separator,
      }}
    >
      {/* Avatar circle */}
      <View
        style={{
          width: 56,
          height: 56,
          borderRadius: 28,
          overflow: 'hidden',
          backgroundColor: C.surface3,
          marginRight: 14,
          borderWidth: 1,
          borderColor: `${accentColor}30`,
          flexShrink: 0,
        }}
      >
        <ImageSlot uri={portraitUri} vignette={false} style={{ flex: 1 }} />
        {/* Initials fallback behind image */}
        <View
          style={{
            position: 'absolute',
            top: 0, left: 0, right: 0, bottom: 0,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ fontSize: 16, fontWeight: '700', color: accentColor, letterSpacing: 0.5 }}>
            {initials}
          </Text>
        </View>
      </View>

      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 16, fontWeight: '700', color: C.text, letterSpacing: -0.2 }}>
          {firstName} {lastName}
        </Text>
        <Text style={{ fontSize: 12, color: C.textMute, marginTop: 2 }}>Instructor</Text>
        {bio ? (
          <Text style={{ fontSize: 14, color: C.textSub, lineHeight: 21, marginTop: 8 }}>
            {bio}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function ClassDetailScreen() {
  const navigation = useNavigation();
  const router = useRouter();
  const C = getColors();

  const raw = useLocalSearchParams<{ classId: string | string[] }>().classId;
  const classId = typeof raw === 'string' ? raw : raw?.[0] ?? '';

  const { primaryColor, appDisplayName } = useBranding();
  const { user } = useAuth();
  const isGuest = user === null;
  const matched = useMemberStudio().matched;
  const { timezone: publicTimezone } = usePublicStudio();
  const {
    myBookings,
    myWaitlist,
    loading: activityLoading,
    error: activityError,
    refresh: refreshActivity,
    getClass,
  } = useStudioActivity();

  const [guestClasses, setGuestClasses] = useState<ScheduledClassDto[]>([]);
  const [guestLoading, setGuestLoading] = useState(false);
  const [guestError, setGuestError] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [offerWaitlist, setOfferWaitlist] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [subscriptionRequired, setSubscriptionRequired] = useState(false);
  // null = access check in progress → disabled "Checking access..." CTA
  // false = no subscription or day pass for this date → "View Memberships"
  // true  = active subscription or matching day pass → "Book Class"
  const [hasAccess, setHasAccess] = useState<boolean | null>(null);
  const [memberProfile, setMemberProfile] = useState<MyMemberProfileDto | null>(null);
  const [hasMatchingDayPass, setHasMatchingDayPass] = useState(false);
  const [authModalVisible, setAuthModalVisible] = useState(false);

  const studioId = matched?.studio.id;
  const timeZone = isGuest ? publicTimezone : (matched?.studio.timezone ?? 'UTC');

  const authCls = useMemo(() => getClass(classId), [getClass, classId]);
  const guestCls = useMemo(
    () => guestClasses.find((c) => c.id === classId),
    [guestClasses, classId],
  );
  const cls = isGuest ? guestCls : authCls;

  const loading = isGuest ? guestLoading : activityLoading;
  const error = isGuest ? guestError : activityError;

  const loadGuestSchedule = useCallback(async () => {
    const slug = getStudioSlug();
    if (!slug) {
      setGuestError('App is missing studio configuration.');
      setGuestLoading(false);
      return;
    }
    setGuestLoading(true);
    setGuestError(null);
    const { from, to } = buildScheduleQueryRange();
    try {
      const data = await fetchPublicSchedule(slug, from, to);
      setGuestClasses(data);
    } catch (e) {
      setGuestError(userFacingApiMessage(e, 'We could not load this class. Pull to try again.'));
    } finally {
      setGuestLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (isGuest) void loadGuestSchedule();
    }, [isGuest, loadGuestSchedule]),
  );

  useEffect(() => {
    if (isGuest || !studioId || !cls) return;

    let cancelled = false;
    setHasAccess(null);
    setMemberProfile(null);
    setHasMatchingDayPass(false);

    void (async () => {
      const [profileResult, dayPassResult] = await Promise.allSettled([
        fetchMyMemberProfile(studioId),
        fetchMyDayPasses(studioId),
      ]);
      if (cancelled) return;

      let hasSubscription = false;
      if (profileResult.status === 'fulfilled') {
        setMemberProfile(profileResult.value);
        hasSubscription = profileResult.value.activeSubscription !== null;
      } else {
        setMemberProfile(null);
        if (__DEV__) {
          console.warn('[ClassDetail] fetchMyMemberProfile failed:', profileResult.reason);
        }
      }

      let matchingDayPass = false;
      if (dayPassResult.status === 'fulfilled') {
        matchingDayPass = hasActiveDayPassForClassDate(
          dayPassResult.value,
          cls.startsAt,
          timeZone,
        );
        setHasMatchingDayPass(matchingDayPass);
      } else {
        setHasMatchingDayPass(false);
        if (__DEV__) {
          console.warn('[ClassDetail] fetchMyDayPasses failed:', dayPassResult.reason);
        }
      }

      setHasAccess(hasSubscription || matchingDayPass);
    })();

    return () => {
      cancelled = true;
    };
  }, [isGuest, studioId, cls, timeZone]);

  const booking = useMemo(
    () =>
      isGuest
        ? undefined
        : myBookings.find((b) => b.scheduledClassId === classId && b.status === 'CONFIRMED'),
    [isGuest, myBookings, classId],
  );

  const waitlistEntry = useMemo(
    () => (isGuest ? undefined : myWaitlist.find((w) => w.scheduledClassId === classId)),
    [isGuest, myWaitlist, classId],
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
      await refreshActivity();
    } catch (e) {
      if (isActiveSubscriptionRequiredError(e)) { setSubscriptionRequired(true); return; }
      if (e instanceof ApiError && e.status === 409 && isClassFullMessage(e.message)) {
        setOfferWaitlist(true);
        return;
      }
      setInlineError(userFacingApiMessage(e, 'That action could not be completed. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  if (!isGuest && (!studioId || !matched)) return <ScreenLoader />;
  if (!classId) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['bottom']}>
        <EmptyHint title="Missing class" body="Go back and choose a class from the schedule." />
      </SafeAreaView>
    );
  }
  const refresh = isGuest ? loadGuestSchedule : refreshActivity;

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
  const accentColor = cls.classTemplate.color ?? primaryColor;
  const heroImageUri = resolveScheduledClassImageUri(cls.classTemplate, 'hero');
  const instructorProfile = cls.instructor?.staffProfiles[0] ?? null;
  const memberStudioId = studioId ?? '';

  const activeSubscription = memberProfile?.activeSubscription ?? null;
  const allowedCategories = activeSubscription?.plan.allowedCategories ?? [];
  const classCategory = cls.classTemplate.category;
  const isPlanRestricted =
    !isGuest &&
    activeSubscription !== null &&
    allowedCategories.length > 0 &&
    !!classCategory &&
    !allowedCategories.includes(classCategory) &&
    !hasMatchingDayPass;

  // CTA logic
  let primaryCTA: { label: string; onPress: () => void; disabled?: boolean; muted?: boolean } | null = null;
  let secondaryCTA: { label: string; onPress: () => void } | null = null;

  if (booking) {
    primaryCTA = {
      label: 'Cancel booking',
      onPress: () => void run(async () => { await cancelBooking(memberStudioId, booking.id); }),
    };
  } else if (waitlistEntry?.status === 'WAITING') {
    primaryCTA = {
      label: 'Leave waitlist',
      onPress: () => void run(async () => { await cancelWaitlistEntry(memberStudioId, waitlistEntry.id); }),
    };
  } else if (canAct) {
    if (isGuest) {
      primaryCTA = {
        label: 'Create Account to Book',
        onPress: () => setAuthModalVisible(true),
      };
      secondaryCTA = {
        label: 'Log In',
        onPress: () =>
          router.push({
            pathname: '/(auth)/login',
            params: {
              returnTo: `/(app)/class/${classId}`,
              intent: 'book',
            },
          }),
      };
    } else if (offerWaitlist) {
      primaryCTA = {
        label: 'Join waitlist',
        onPress: () => void run(async () => { await joinClassWaitlist(memberStudioId, classId); }),
      };
      secondaryCTA = {
        label: 'Try booking again',
        onPress: () => void run(async () => { await createClassBooking(memberStudioId, classId); }),
      };
    } else if (hasAccess === null) {
      primaryCTA = {
        label: 'Checking access...',
        onPress: () => {},
        disabled: true,
      };
    } else if (hasAccess === false) {
      primaryCTA = {
        label: 'View Memberships',
        onPress: () => router.push('/(app)/(tabs)/membership'),
      };
    } else if (isPlanRestricted) {
      primaryCTA = {
        label: 'Not in your plan',
        muted: true,
        onPress: () => Alert.alert('Not in your plan', PLAN_RESTRICTED_MESSAGE),
      };
    } else {
      primaryCTA = {
        label: 'Book Class',
        onPress: () => void run(async () => { await createClassBooking(memberStudioId, classId); }),
      };
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['bottom', 'left', 'right']}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 24 }}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={() => void refresh()} tintColor={accentColor} />
        }
      >
        <Animated.View entering={FadeInDown.duration(400)}>

          {/* ── Cinematic hero ── */}
          <View style={{ height: 300, position: 'relative' }}>
            <ImageSlot
              uri={heroImageUri}
              vignette
              style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
            />

            {/* Accent strip at top */}
            <View
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: 3,
                backgroundColor: accentColor,
              }}
            />

            {/* Text overlaid at bottom of hero */}
            <View
              style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                padding: Space.screenH,
                paddingBottom: 24,
              }}
            >
              {/* Class name */}
              <Text
                style={{
                  fontSize: 40,
                  fontWeight: '800',
                  letterSpacing: -1.4,
                  color: '#FFFFFF',
                  lineHeight: 45,
                  marginBottom: 10,
                }}
              >
                {cls.classTemplate.name}
              </Text>

              {/* Date · time · duration */}
              <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' }}>
                {isGuest ? (
                  <>
                    <Text
                      style={{
                        fontSize: 15,
                        color: 'rgba(255,255,255,0.62)',
                        fontWeight: '500',
                        letterSpacing: -0.1,
                      }}
                    >
                      {formatClassDateLabel(cls.startsAt, timeZone)}
                    </Text>
                    <Text style={{ fontSize: 13, color: 'rgba(255,255,255,0.30)', marginHorizontal: 8 }}>·</Text>
                  </>
                ) : null}
                <Text
                  style={{
                    fontSize: 16,
                    color: 'rgba(255,255,255,0.72)',
                    fontWeight: '500',
                    letterSpacing: -0.1,
                  }}
                >
                  {time}
                </Text>
                <Text style={{ fontSize: 13, color: 'rgba(255,255,255,0.30)', marginHorizontal: 8 }}>·</Text>
                <Text style={{ fontSize: 15, color: 'rgba(255,255,255,0.52)' }}>
                  {duration} min
                </Text>
                <Text style={{ fontSize: 13, color: 'rgba(255,255,255,0.25)', marginHorizontal: 8 }}>·</Text>
                <Text style={{ fontSize: 13, color: 'rgba(255,255,255,0.40)' }}>
                  Up to {cls.capacity}
                </Text>
              </View>
            </View>
          </View>

          {/* ── Body content ── */}
          <View style={{ paddingHorizontal: Space.screenH, paddingTop: 24 }}>
            {/* Instructor portrait block */}
            {cls.instructor ? (
              <InstructorBlock
                firstName={cls.instructor.firstName}
                lastName={cls.instructor.lastName}
                photoUrl={instructorProfile?.photoUrl}
                bio={instructorProfile?.bio}
                accentColor={accentColor}
              />
            ) : null}

            {/* Description */}
            {cls.classTemplate.description ? (
              <Text
                style={{
                  fontSize: 16,
                  lineHeight: 26,
                  color: C.textSub,
                  letterSpacing: -0.1,
                  marginTop: 24,
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
                  lineHeight: 23,
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
                <SubscriptionRequiredPanel accentColor={accentColor} appDisplayName={appDisplayName} />
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
            paddingBottom: 20,
            paddingTop: 14,
            borderTopWidth: 1,
            borderTopColor: C.separator,
            backgroundColor: C.bg,
            gap: 10,
          }}
        >
          {booking ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push(`/(app)/check-in/${booking.id}`)}
              style={{ paddingVertical: 10, alignItems: 'center' }}
            >
              <Text
                style={{
                  fontSize: 15,
                  fontWeight: '700',
                  color: accentColor,
                  letterSpacing: -0.2,
                }}
              >
                Check-in QR →
              </Text>
            </Pressable>
          ) : null}
          {primaryCTA ? (
            <BrandButton
              label={primaryCTA.label}
              accentColor={primaryCTA.muted ? C.surface3 : accentColor}
              loading={busy}
              disabled={primaryCTA.disabled}
              onPress={primaryCTA.onPress}
            />
          ) : null}
          {secondaryCTA ? (
            <BrandButton
              label={secondaryCTA.label}
              variant="ghost"
              accentColor={accentColor}
              loading={busy}
              onPress={secondaryCTA.onPress}
            />
          ) : null}
        </View>
      ) : null}

      <AuthRequiredModal
        visible={authModalVisible}
        title="Create your account to book"
        description="Create an account to reserve this class, manage your bookings, and check in from your phone."
        onPrimary={() => {
          setAuthModalVisible(false);
          router.push({
            pathname: '/(auth)/register',
            params: {
              returnTo: `/(app)/class/${classId}`,
              intent: 'book',
            },
          });
        }}
        onSecondary={() => {
          setAuthModalVisible(false);
          router.push({
            pathname: '/(auth)/login',
            params: {
              returnTo: `/(app)/class/${classId}`,
              intent: 'book',
            },
          });
        }}
        onClose={() => setAuthModalVisible(false)}
      />
    </SafeAreaView>
  );
}
