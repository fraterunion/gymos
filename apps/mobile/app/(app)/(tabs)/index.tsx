import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { ClassCard } from '@/components/ClassCard';
import { EmptyHint, ErrorBanner, LoadRetryPanel, Skeleton, ScreenLoader } from '@/components/StudioScreenChrome';
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
// Greeting helper
// ---------------------------------------------------------------------------

function buildGreeting(firstName: string | null | undefined): string {
  const hour = new Date().getHours();
  const salutation = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  return firstName ? `${salutation},\n${firstName}.` : `${salutation}.`;
}

// ---------------------------------------------------------------------------
// Next session hero card
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
  const C = getColors();
  const time = formatClassTime(booking.scheduledClass.startsAt, timeZone);

  return (
    <Animated.View entering={FadeInDown.duration(500)}>
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        style={{
          backgroundColor: C.surface2,
          borderRadius: 20,
          overflow: 'hidden',
        }}
      >
        {/* Brand-color top strip */}
        <View style={{ height: 3, backgroundColor: primaryColor }} />

        <View style={{ paddingHorizontal: Space.cardH, paddingVertical: 26 }}>
          {/* Class name — cinematic */}
          <Text
            numberOfLines={2}
            style={{
              fontSize: 38,
              fontWeight: '800',
              letterSpacing: -1.5,
              color: C.text,
              lineHeight: 43,
              marginBottom: 14,
            }}
          >
            {cls?.name ?? 'Class'}
          </Text>

          {/* Time · duration */}
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
            <Text style={{ fontSize: 16, color: C.textSub, letterSpacing: -0.2 }}>
              {time}
            </Text>
            {cls ? (
              <>
                <Text style={{ fontSize: 13, color: C.textMute, marginHorizontal: 7 }}>·</Text>
                <Text style={{ fontSize: 15, color: C.textMute }}>
                  {cls.durationMinutes} min
                </Text>
              </>
            ) : null}
          </View>

          {/* Instructor */}
          {cls?.instructorName ? (
            <Text style={{ fontSize: 13, color: C.textMute }}>
              {cls.instructorName}
            </Text>
          ) : null}

          {/* Divider */}
          <View style={{ height: 1, backgroundColor: C.separator, marginVertical: 22 }} />

          {/* CTA */}
          <Pressable
            accessibilityRole="button"
            onPress={(e) => { e.stopPropagation?.(); onCheckIn(); }}
            hitSlop={8}
          >
            <Text style={{ fontSize: 15, fontWeight: '700', color: primaryColor, letterSpacing: -0.2 }}>
              Check-in QR →
            </Text>
          </Pressable>
        </View>
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

  // Next confirmed upcoming booking
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

  // Today's upcoming classes
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

  // Active waitlist entries (max 3)
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
        contentContainerStyle={{ paddingHorizontal: Space.screenH, paddingBottom: 56 }}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={() => void refresh()} tintColor={primaryColor} />
        }
      >
        {/* ── Greeting hero ── */}
        <Animated.View entering={FadeInDown.duration(550)} style={{ paddingTop: 28, paddingBottom: 32 }}>
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
          <View style={{ gap: 12 }}>
            <Skeleton height={210} radius={20} />
            <Skeleton width="30%" height={10} radius={4} style={{ marginTop: 28, marginBottom: 8 }} />
            <Skeleton height={100} radius={16} />
            <Skeleton height={100} radius={16} />
          </View>
        ) : (
          <>
            {/* ── Next booking hero ── */}
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

            {/* ── Today's schedule ── */}
            {todaysUpcoming.length > 0 ? (
              <View style={{ marginTop: nextBooking ? 40 : 0 }}>
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
              <View style={{ marginTop: 8 }}>
                <EmptyHint
                  title="No classes today"
                  body="Browse the schedule for upcoming sessions."
                />
              </View>
            ) : null}

            {/* ── Waitlist ── */}
            {waitlistPreview.length > 0 ? (
              <View style={{ marginTop: Space.sectionGap }}>
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
                            {cls?.classTemplate.name ?? 'Class'}
                          </Text>
                          {w.queueRank != null ? (
                            <Text style={{ fontSize: 12, color: C.textMute, marginTop: 4 }}>
                              #{w.queueRank} on waitlist
                            </Text>
                          ) : null}
                        </View>
                        <Text style={{ fontSize: 16, color: C.textMute }}>›</Text>
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
