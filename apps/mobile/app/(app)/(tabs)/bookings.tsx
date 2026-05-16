import { useRouter } from 'expo-router';
import { Pressable, RefreshControl, ScrollView, Text, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { EmptyHint, ErrorBanner, LoadRetryPanel, Skeleton, ScreenLoader } from '@/components/StudioScreenChrome';
import { useBranding } from '@/contexts/BrandingContext';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import { useStudioActivity } from '@/contexts/StudioActivityContext';
import { formatClassTime } from '@/lib/datetime';
import { getColors, Space } from '@/constants/Theme';
import type { BookingWithClass, MyWaitlistEntry } from '@/lib/types/studio';

// ---------------------------------------------------------------------------
// Booking card
// ---------------------------------------------------------------------------

function BookingCard({
  booking,
  className,
  timeZone,
  primaryColor,
  onPress,
  onCheckIn,
  index,
}: {
  booking: BookingWithClass;
  className: string;
  timeZone: string;
  primaryColor: string;
  onPress: () => void;
  onCheckIn: () => void;
  index: number;
}) {
  const scheme = useColorScheme();
  const C = getColors(scheme);
  const time = formatClassTime(booking.scheduledClass.startsAt, timeZone);

  return (
    <Animated.View
      entering={FadeInDown.delay(index * 55).duration(400)}
      style={{ marginBottom: Space.cardGap }}
    >
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        style={{ backgroundColor: C.surface2, borderRadius: 16, overflow: 'hidden' }}
      >
        <View style={{ paddingHorizontal: Space.cardH, paddingTop: Space.cardV, paddingBottom: 14 }}>
          {/* Status + date row */}
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
            <View
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: C.positive,
                marginRight: 6,
              }}
            />
            <Text style={{ fontSize: 11, fontWeight: '600', letterSpacing: 0.5, color: C.positive }}>
              Confirmed
            </Text>
            <View style={{ flex: 1 }} />
            <Text style={{ fontSize: 12, color: C.textMute }}>{time}</Text>
          </View>

          {/* Class name */}
          <Text
            numberOfLines={1}
            style={{ fontSize: 18, fontWeight: '600', letterSpacing: -0.2, color: C.text }}
          >
            {className}
          </Text>
        </View>

        {/* Check-in action */}
        <View
          style={{ borderTopWidth: 1, borderTopColor: C.separator, paddingHorizontal: Space.cardH, paddingVertical: 12 }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open check-in QR code"
            onPress={(e) => { e.stopPropagation?.(); onCheckIn(); }}
            hitSlop={8}
          >
            <Text style={{ fontSize: 14, fontWeight: '600', color: primaryColor }}>
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
  entry,
  className,
  onPress,
  index,
}: {
  entry: MyWaitlistEntry;
  className: string;
  onPress: () => void;
  index: number;
}) {
  const scheme = useColorScheme();
  const C = getColors(scheme);

  const isPromoted = entry.status === 'PROMOTED';

  return (
    <Animated.View
      entering={FadeInDown.delay(index * 55).duration(400)}
      style={{ marginBottom: 8 }}
    >
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: C.surface1,
          borderRadius: 12,
          paddingHorizontal: Space.cardH,
          paddingVertical: 14,
        }}
      >
        <View style={{ flex: 1 }}>
          <Text
            numberOfLines={1}
            style={{ fontSize: 15, fontWeight: '500', color: C.text }}
          >
            {className}
          </Text>
          <Text style={{ fontSize: 12, color: isPromoted ? C.caution : C.textMute, marginTop: 3 }}>
            {isPromoted
              ? 'Promoted — tap to finish booking'
              : entry.queueRank != null
                ? `#${entry.queueRank} · ${entry.waitingCountForClass} waiting`
                : 'Waitlist'}
          </Text>
        </View>
        <Text style={{ fontSize: 13, color: C.textMute, marginLeft: 8 }}>›</Text>
      </Pressable>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function MyBookingsScreen() {
  const router = useRouter();
  const scheme = useColorScheme();
  const C = getColors(scheme);
  const { primaryColor } = useBranding();
  const matched = useMemberStudio().matched;
  const { classes, myBookings, myWaitlist, loading, error, refresh } = useStudioActivity();

  const timeZone = matched?.studio.timezone ?? 'UTC';

  if (!matched) return <ScreenLoader />;
  if (error && myBookings.length === 0 && myWaitlist.length === 0) {
    return <LoadRetryPanel message={error} onRetry={refresh} />;
  }

  const showSkeleton = loading && myBookings.length === 0 && myWaitlist.length === 0;

  function resolveClassName(classId: string): string {
    return classes.find((c) => c.id === classId)?.classTemplate.name ?? 'Class';
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['left', 'right', 'top']}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: Space.screenH, paddingBottom: 128 }}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={() => void refresh()} tintColor={primaryColor} />
        }
      >
        {/* Page header — replaces removed nav header */}
        <View style={{ paddingTop: 28, paddingBottom: 20 }}>
          <Text
            style={{
              fontSize: 38,
              fontWeight: '800',
              letterSpacing: -1.3,
              color: C.text,
              lineHeight: 44,
            }}
          >
            My Bookings
          </Text>
        </View>
        {error ? (
          <View style={{ paddingTop: 8 }}>
            <ErrorBanner message={error} onRetry={refresh} />
          </View>
        ) : null}

        {showSkeleton ? (
          <View style={{ paddingTop: 24, gap: 10 }}>
            <Skeleton width="30%" height={11} radius={4} style={{ marginBottom: 4 }} />
            <Skeleton height={96} radius={16} />
            <Skeleton height={96} radius={16} />
          </View>
        ) : (
          <>
            {/* ── Upcoming bookings ── */}
            <View>
              {myBookings.length === 0 ? (
                <EmptyHint
                  title="No upcoming reservations"
                  body="Reserve a spot from the schedule when you're ready."
                />
              ) : (
                <>
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
                    Upcoming
                  </Text>
                  {myBookings.map((b, i) => (
                    <BookingCard
                      key={b.id}
                      booking={b}
                      className={resolveClassName(b.scheduledClassId)}
                      timeZone={timeZone}
                      primaryColor={primaryColor}
                      index={i}
                      onPress={() => router.push(`/(app)/class/${b.scheduledClassId}`)}
                      onCheckIn={() => router.push(`/(app)/check-in/${b.id}`)}
                    />
                  ))}
                </>
              )}
            </View>

            {/* ── Waitlist ── */}
            {myWaitlist.length > 0 ? (
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
                {myWaitlist.map((w, i) => (
                  <WaitlistRow
                    key={w.id}
                    entry={w}
                    className={resolveClassName(w.scheduledClassId)}
                    onPress={() => router.push(`/(app)/class/${w.scheduledClassId}`)}
                    index={i}
                  />
                ))}
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
