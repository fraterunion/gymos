import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, {
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { ClassCard } from '@/components/ClassCard';
import { FeaturedClassTile } from '@/components/FeaturedClassTile';
import { ImageSlot } from '@/components/ImageSlot';
import { FLOATING_TAB_CLEARANCE } from '@/components/FloatingTabBar';
import {
  EmptyHint,
  ErrorBanner,
  LoadRetryPanel,
  Skeleton,
  ScreenLoader,
} from '@/components/StudioScreenChrome';
import { useAuth } from '@/contexts/AuthContext';
import { useBranding } from '@/contexts/BrandingContext';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import { useStudioActivity } from '@/contexts/StudioActivityContext';
import {
  calendarDayKeyInZone,
  formatClassTime,
  todayKeyInZone,
} from '@/lib/datetime';
import { getColors, Space } from '@/constants/Theme';
import type { BookingWithClass } from '@/lib/types/studio';

// ---------------------------------------------------------------------------
// Greeting
// ---------------------------------------------------------------------------

function buildGreeting(firstName: string | null | undefined): string {
  const h = new Date().getHours();
  const s = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  return firstName ? `${s},\n${firstName}.` : `${s}.`;
}

// ---------------------------------------------------------------------------
// Next-session hero — full-bleed cinematic card with check-in CTA inside
// ---------------------------------------------------------------------------

function NextSessionHero({
  booking,
  cls,
  timeZone,
  primaryColor,
  onPress,
  onCheckIn,
}: {
  booking: BookingWithClass;
  cls: { name: string; durationMinutes: number; instructorName: string | null } | null;
  timeZone: string;
  primaryColor: string;
  onPress: () => void;
  onCheckIn: () => void;
}) {
  const time = formatClassTime(booking.scheduledClass.startsAt, timeZone);
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Animated.View
      entering={FadeInDown.duration(560)}
      style={[{ borderRadius: 22, overflow: 'hidden', height: 280 }, animStyle]}
    >
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        onPressIn={() => { scale.value = withSpring(0.980, { damping: 22, stiffness: 340 }); }}
        onPressOut={() => { scale.value = withSpring(1.0, { damping: 14, stiffness: 200 }); }}
        style={{ flex: 1 }}
      >
        {/* Atmospheric background — will hold a real hero image in future */}
        <ImageSlot
          vignette
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        />

        {/* Brand top strip */}
        <View
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 3,
            backgroundColor: primaryColor,
          }}
        />

        {/* "YOUR NEXT CLASS" label at top-left */}
        <View style={{ position: 'absolute', top: 22, left: 22 }}>
          <Text
            style={{
              fontSize: 10,
              fontWeight: '700',
              letterSpacing: 1.4,
              textTransform: 'uppercase',
              color: primaryColor,
            }}
          >
            Your next class
          </Text>
        </View>

        {/* Content at bottom */}
        <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: 22 }}>
          {/* Class name */}
          <Text
            numberOfLines={2}
            style={{
              fontSize: 34,
              fontWeight: '800',
              letterSpacing: -1.2,
              color: '#FFFFFF',
              lineHeight: 39,
              marginBottom: 10,
            }}
          >
            {cls?.name ?? 'Class'}
          </Text>

          {/* Time · duration */}
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
            <Text style={{ fontSize: 15, color: 'rgba(255,255,255,0.72)', fontWeight: '500', letterSpacing: -0.1 }}>
              {time}
            </Text>
            {cls ? (
              <>
                <Text style={{ fontSize: 12, color: 'rgba(255,255,255,0.30)', marginHorizontal: 7 }}>·</Text>
                <Text style={{ fontSize: 14, color: 'rgba(255,255,255,0.50)' }}>
                  {cls.durationMinutes} min
                </Text>
              </>
            ) : null}
          </View>

          {/* Instructor */}
          {cls?.instructorName ? (
            <Text style={{ fontSize: 13, color: 'rgba(255,255,255,0.40)', marginBottom: 18 }}>
              {cls.instructorName}
            </Text>
          ) : (
            <View style={{ height: 18 }} />
          )}

          {/* Inline CTA */}
          <Pressable
            accessibilityRole="button"
            onPress={(e) => { e.stopPropagation?.(); onCheckIn(); }}
            hitSlop={10}
          >
            <Text
              style={{
                fontSize: 14,
                fontWeight: '700',
                color: primaryColor,
                letterSpacing: -0.1,
              }}
            >
              Check-in QR →
            </Text>
          </Pressable>
        </View>
      </Pressable>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Waitlist row
// ---------------------------------------------------------------------------

function WaitlistRow({
  name,
  rank,
  index,
  onPress,
}: {
  name: string;
  rank: number | null;
  index: number;
  onPress: () => void;
}) {
  const C = getColors();
  return (
    <Animated.View
      entering={FadeInDown.delay(index * 55).duration(360)}
      style={{ marginBottom: 8 }}
    >
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: C.surface1,
          borderRadius: 14,
          paddingHorizontal: 18,
          paddingVertical: 16,
        }}
      >
        <View style={{ flex: 1 }}>
          <Text
            numberOfLines={1}
            style={{ fontSize: 16, fontWeight: '600', color: C.text, letterSpacing: -0.2 }}
          >
            {name}
          </Text>
          {rank != null ? (
            <Text style={{ fontSize: 12, color: C.textMute, marginTop: 4 }}>
              #{rank} on waitlist
            </Text>
          ) : null}
        </View>
        <Text style={{ fontSize: 18, color: C.textMute, marginLeft: 8 }}>›</Text>
      </Pressable>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function HomeScreen() {
  const router = useRouter();
  const C = getColors();
  const { primaryColor } = useBranding();
  const { user } = useAuth();
  const matched = useMemberStudio().matched;
  const { classes, myBookings, myWaitlist, loading, error, refresh } = useStudioActivity();

  const timeZone = matched?.studio.timezone ?? 'UTC';
  const todayKey = useMemo(() => todayKeyInZone(timeZone), [timeZone]);
  const greeting = useMemo(() => buildGreeting(user?.firstName), [user?.firstName]);

  // Next confirmed upcoming booking, soonest first
  const nextBooking = useMemo(() => {
    const now = Date.now();
    return (
      [...myBookings]
        .filter(
          (b) =>
            b.status === 'CONFIRMED' &&
            new Date(b.scheduledClass.startsAt).getTime() > now,
        )
        .sort(
          (a, b) =>
            new Date(a.scheduledClass.startsAt).getTime() -
            new Date(b.scheduledClass.startsAt).getTime(),
        )[0] ?? null
    );
  }, [myBookings]);

  const nextBookingClass = useMemo(() => {
    if (!nextBooking) return null;
    const cls = classes.find((c) => c.id === nextBooking.scheduledClassId);
    if (!cls) return null;
    return {
      name: cls.classTemplate.name,
      durationMinutes: cls.classTemplate.durationMinutes,
      instructorName: cls.instructor
        ? `${cls.instructor.firstName} ${cls.instructor.lastName}`.trim()
        : null,
    };
  }, [nextBooking, classes]);

  // Upcoming classes today, sorted by start time
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

  const waitlistPreview = useMemo(
    () =>
      myWaitlist
        .filter((w) => w.status === 'WAITING' || w.status === 'PROMOTED')
        .slice(0, 3),
    [myWaitlist],
  );

  if (!matched) return <ScreenLoader />;
  if (error && classes.length === 0 && myBookings.length === 0) {
    return <LoadRetryPanel message={error} onRetry={refresh} />;
  }

  const showSkeleton = loading && classes.length === 0;

  // The first today class that isn't the booked hero
  const todayFeatured = todaysUpcoming[0] ?? null;
  const todayRest = nextBooking ? todaysUpcoming : todaysUpcoming.slice(1);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['left', 'right', 'top']}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: Space.screenH,
          paddingBottom: FLOATING_TAB_CLEARANCE,
        }}
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={() => void refresh()}
            tintColor={primaryColor}
          />
        }
      >
        {/* ── Greeting ── */}
        <Animated.View entering={FadeInDown.duration(500)} style={{ paddingTop: 28, paddingBottom: 28 }}>
          <Text
            style={{
              fontSize: 40,
              fontWeight: '800',
              letterSpacing: -1.5,
              color: C.text,
              lineHeight: 46,
            }}
          >
            {greeting}
          </Text>
          {matched?.studio.name ? (
            <Text style={{ fontSize: 14, color: C.textMute, marginTop: 8 }}>
              {matched.studio.name}
            </Text>
          ) : null}
        </Animated.View>

        {error ? (
          <View style={{ marginBottom: 16 }}>
            <ErrorBanner message={error} onRetry={refresh} />
          </View>
        ) : null}

        {showSkeleton ? (
          <View style={{ gap: 10 }}>
            <Skeleton height={280} radius={22} />
            <Skeleton width="28%" height={10} radius={4} style={{ marginTop: 36 }} />
            <Skeleton height={240} radius={20} style={{ marginTop: 16 }} />
            <Skeleton height={106} radius={16} style={{ marginTop: 8 }} />
          </View>
        ) : (
          <>
            {/* ── Hero: next booked class ── */}
            {nextBooking ? (
              <NextSessionHero
                booking={nextBooking}
                cls={nextBookingClass}
                timeZone={timeZone}
                primaryColor={primaryColor}
                onPress={() => router.push(`/(app)/class/${nextBooking.scheduledClassId}`)}
                onCheckIn={() => router.push(`/(app)/check-in/${nextBooking.id}`)}
              />
            ) : null}

            {/* ── Today's classes ── */}
            {todaysUpcoming.length > 0 ? (
              <View style={{ marginTop: nextBooking ? 44 : 0 }}>
                {/* Section label */}
                <Text
                  style={{
                    fontSize: 11,
                    fontWeight: '700',
                    letterSpacing: 1.0,
                    textTransform: 'uppercase',
                    color: primaryColor,
                    marginBottom: 16,
                  }}
                >
                  Today
                </Text>

                {/* First class gets editorial FeaturedClassTile if no booking hero shown,
                    otherwise all are standard ClassCards */}
                {!nextBooking && todayFeatured ? (
                  <>
                    <FeaturedClassTile
                      item={todayFeatured}
                      timeZone={timeZone}
                      accentColor={todayFeatured.classTemplate.color ?? primaryColor}
                      height={240}
                      label="Book now"
                      onPress={() => router.push(`/(app)/class/${todayFeatured.id}`)}
                    />
                    {todayRest.map((c, i) => (
                      <ClassCard
                        key={c.id}
                        item={c}
                        timeZone={timeZone}
                        accentColor={c.classTemplate.color ?? primaryColor}
                        index={i + 1}
                        onPress={() => router.push(`/(app)/class/${c.id}`)}
                      />
                    ))}
                  </>
                ) : (
                  todaysUpcoming.map((c, i) => (
                    <ClassCard
                      key={c.id}
                      item={c}
                      timeZone={timeZone}
                      accentColor={c.classTemplate.color ?? primaryColor}
                      index={i}
                      onPress={() => router.push(`/(app)/class/${c.id}`)}
                    />
                  ))
                )}
              </View>
            ) : !nextBooking ? (
              <View style={{ marginTop: 8 }}>
                <EmptyHint
                  title="Nothing scheduled today"
                  body="Browse the schedule for upcoming sessions."
                />
              </View>
            ) : null}

            {/* ── Waitlist ── */}
            {waitlistPreview.length > 0 ? (
              <View style={{ marginTop: 44 }}>
                <Text
                  style={{
                    fontSize: 11,
                    fontWeight: '700',
                    letterSpacing: 1.0,
                    textTransform: 'uppercase',
                    color: C.textMute,
                    marginBottom: 16,
                  }}
                >
                  Waitlist
                </Text>
                {waitlistPreview.map((w, i) => {
                  const cls = classes.find((c) => c.id === w.scheduledClassId);
                  return (
                    <WaitlistRow
                      key={w.id}
                      name={cls?.classTemplate.name ?? 'Class'}
                      rank={w.queueRank}
                      index={i}
                      onPress={() => router.push(`/(app)/class/${w.scheduledClassId}`)}
                    />
                  );
                })}
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
