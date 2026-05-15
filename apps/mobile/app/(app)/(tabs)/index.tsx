import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { ClassCard } from '@/components/ClassCard';
import { EmptyHint, ErrorBanner, LoadRetryPanel, Skeleton, ScreenLoader } from '@/components/StudioScreenChrome';
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
// Hero booking card — the first thing a member should see
// ---------------------------------------------------------------------------

function NextSessionCard({
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
  const scheme = useColorScheme();
  const C = getColors(scheme);
  const time = formatClassTime(booking.scheduledClass.startsAt, timeZone);

  return (
    <Animated.View entering={FadeInDown.duration(480)} style={{ marginBottom: 8 }}>
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        style={{
          backgroundColor: C.surface2,
          borderRadius: 20,
          paddingHorizontal: Space.cardH,
          paddingVertical: 24,
        }}
      >
        {/* Label row */}
        <Text
          style={{
            fontSize: 10,
            fontWeight: '700',
            letterSpacing: 1.2,
            textTransform: 'uppercase',
            color: C.textMute,
            marginBottom: 14,
          }}
        >
          Next session
        </Text>

        {/* Class name — the hero element */}
        <Text
          numberOfLines={2}
          style={{
            fontSize: 28,
            fontWeight: '700',
            letterSpacing: -0.6,
            color: C.text,
            lineHeight: 33,
            marginBottom: 10,
          }}
        >
          {cls?.name ?? 'Class'}
        </Text>

        {/* Time + duration */}
        <Text style={{ fontSize: 15, color: C.textSub, letterSpacing: -0.1, marginBottom: 4 }}>
          {time}
          {cls ? `  ·  ${cls.durationMinutes} min` : ''}
        </Text>

        {/* Instructor */}
        {cls?.instructorName ? (
          <Text style={{ fontSize: 13, color: C.textMute, marginBottom: 0 }}>
            {cls.instructorName}
          </Text>
        ) : null}

        {/* Separator */}
        <View
          style={{ height: 1, backgroundColor: C.separator, marginVertical: 18 }}
        />

        {/* Action */}
        <Pressable
          accessibilityRole="button"
          onPress={(e) => { e.stopPropagation?.(); onCheckIn(); }}
          hitSlop={8}
        >
          <Text
            style={{ fontSize: 14, fontWeight: '600', color: primaryColor, letterSpacing: -0.1 }}
          >
            Check-in QR →
          </Text>
        </Pressable>
      </Pressable>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function HomeScreen() {
  const router = useRouter();
  const scheme = useColorScheme();
  const C = getColors(scheme);
  const { primaryColor } = useBranding();
  const matched = useMemberStudio().matched;
  const { classes, myBookings, myWaitlist, loading, error, refresh } = useStudioActivity();

  const timeZone = matched?.studio.timezone ?? 'UTC';
  const todayKey = useMemo(() => todayKeyInZone(timeZone), [timeZone]);

  // Next confirmed upcoming booking, sorted by start time
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

  // Data to display in the hero card (cross-ref with classes for full details)
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

  // Today's upcoming classes (excluding the one already booked as hero)
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

  // Active waitlist entries (limited to 3 to avoid clutter)
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

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['left', 'right']}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: Space.screenH, paddingBottom: 48 }}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={() => void refresh()} tintColor={primaryColor} />
        }
      >
        {/* ── BUILD MARKER — remove after confirming new build renders ── */}
        <View
          style={{
            backgroundColor: '#DC2626',
            paddingVertical: 10,
            paddingHorizontal: 16,
            borderRadius: 10,
            marginTop: 16,
            marginBottom: 4,
          }}
        >
          <Text style={{ color: '#FFFFFF', fontSize: 13, fontWeight: '700', textAlign: 'center', letterSpacing: 0.5 }}>
            BUILD MARKER: PHASE19A-0e2ec91
          </Text>
          {process.env.EXPO_PUBLIC_BUILD_MARKER ? (
            <Text style={{ color: '#FFFFFF', fontSize: 11, textAlign: 'center', marginTop: 2, opacity: 0.85 }}>
              ENV: {process.env.EXPO_PUBLIC_BUILD_MARKER}
            </Text>
          ) : (
            <Text style={{ color: '#FFAAAA', fontSize: 11, textAlign: 'center', marginTop: 2 }}>
              ENV MARKER MISSING
            </Text>
          )}
        </View>

        {error ? (
          <View style={{ paddingTop: 8 }}>
            <ErrorBanner message={error} onRetry={refresh} />
          </View>
        ) : null}

        {showSkeleton ? (
          <View style={{ paddingTop: 24, gap: 12 }}>
            <Skeleton height={180} radius={20} />
            <Skeleton width="35%" height={11} radius={4} style={{ marginTop: 28, marginBottom: 8 }} />
            <Skeleton height={82} radius={16} />
            <Skeleton height={82} radius={16} />
          </View>
        ) : (
          <>
            {/* ── Hero: Next Booking ── */}
            <View style={{ paddingTop: 20 }}>
              {nextBooking ? (
                <NextSessionCard
                  booking={nextBooking}
                  cls={nextBookingClass}
                  timeZone={timeZone}
                  primaryColor={primaryColor}
                  onPress={() => router.push(`/(app)/class/${nextBooking.scheduledClassId}`)}
                  onCheckIn={() => router.push(`/(app)/check-in/${nextBooking.id}`)}
                />
              ) : null}
            </View>

            {/* ── Today's schedule ── */}
            {todaysUpcoming.length > 0 ? (
              <View style={{ marginTop: nextBooking ? 28 : 8 }}>
                <Text
                  style={{
                    fontSize: 11,
                    fontWeight: '600',
                    letterSpacing: 0.8,
                    textTransform: 'uppercase',
                    color: primaryColor,
                    marginBottom: 14,
                  }}
                >
                  Today
                </Text>
                {todaysUpcoming.map((c, i) => (
                  <ClassCard
                    key={c.id}
                    item={c}
                    timeZone={timeZone}
                    accentColor={c.classTemplate.color ?? primaryColor}
                    index={i}
                    onPress={() => router.push(`/(app)/class/${c.id}`)}
                  />
                ))}
              </View>
            ) : !nextBooking ? (
              <View style={{ marginTop: 20 }}>
                <EmptyHint
                  title="No classes today"
                  body="Browse the schedule for upcoming sessions."
                />
              </View>
            ) : null}

            {/* ── Waitlist ── (compact, only shown when present) */}
            {waitlistPreview.length > 0 ? (
              <View style={{ marginTop: Space.sectionGap }}>
                <Text
                  style={{
                    fontSize: 11,
                    fontWeight: '600',
                    letterSpacing: 0.8,
                    textTransform: 'uppercase',
                    color: C.textMute,
                    marginBottom: 14,
                  }}
                >
                  Waitlist
                </Text>
                {waitlistPreview.map((w, i) => {
                  const cls = classes.find((c) => c.id === w.scheduledClassId);
                  return (
                    <Animated.View
                      key={w.id}
                      entering={FadeInDown.delay(i * 50).duration(350)}
                      style={{ marginBottom: 8 }}
                    >
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => router.push(`/(app)/class/${w.scheduledClassId}`)}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          backgroundColor: C.surface1,
                          borderRadius: 12,
                          paddingHorizontal: 16,
                          paddingVertical: 14,
                        }}
                      >
                        <View style={{ flex: 1 }}>
                          <Text
                            numberOfLines={1}
                            style={{ fontSize: 15, fontWeight: '500', color: C.text }}
                          >
                            {cls?.classTemplate.name ?? 'Class'}
                          </Text>
                          {w.queueRank != null ? (
                            <Text style={{ fontSize: 12, color: C.textMute, marginTop: 3 }}>
                              #{w.queueRank} on waitlist
                            </Text>
                          ) : null}
                        </View>
                        <Text style={{ fontSize: 13, color: C.textMute }}>›</Text>
                      </Pressable>
                    </Animated.View>
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
