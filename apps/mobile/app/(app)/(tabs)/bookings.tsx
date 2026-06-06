import { useRouter } from 'expo-router';
import { Pressable, RefreshControl, ScrollView, Text, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { ClassCard } from '@/components/ClassCard';
import { TAB_BAR_CLEARANCE } from '@/components/FloatingTabBar';
import { EmptyHint, ErrorBanner, LoadRetryPanel, Skeleton, ScreenLoader } from '@/components/StudioScreenChrome';
import { useBranding } from '@/contexts/BrandingContext';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import { useStudioActivity } from '@/contexts/StudioActivityContext';
import { bookingStatusPill } from '@/lib/bookingStatus';
import { resolveClassImageUri } from '@/lib/imagery';
import { getColors, Space } from '@/constants/Theme';
import type { BookingWithClass, MyWaitlistEntry, ScheduledClassDto } from '@/lib/types/studio';

function bookingDurationMinutes(booking: BookingWithClass): number {
  const start = new Date(booking.scheduledClass.startsAt).getTime();
  const end = new Date(booking.scheduledClass.endsAt).getTime();
  return Math.max(1, Math.round((end - start) / 60_000));
}

function resolveBookingClassItem(
  booking: BookingWithClass,
  cls: ScheduledClassDto | undefined,
  fallbackName: string,
): ScheduledClassDto {
  if (cls) return cls;

  return {
    id: booking.scheduledClassId,
    studioId: booking.scheduledClass.studioId,
    startsAt: booking.scheduledClass.startsAt,
    endsAt: booking.scheduledClass.endsAt,
    capacity: booking.scheduledClass.capacity,
    status: booking.scheduledClass.status,
    instructorId: booking.scheduledClass.instructorId,
    classTemplateId: booking.scheduledClass.classTemplateId,
    classTemplate: {
      id: booking.scheduledClass.classTemplateId,
      name: fallbackName,
      durationMinutes: bookingDurationMinutes(booking),
      description: null,
      defaultCapacity: booking.scheduledClass.capacity,
      color: null,
      intensityLevel: null,
      category: null,
      equipment: [],
      heroImageUrl: null,
      thumbnailImageUrl: null,
      tags: [],
      isFeatured: false,
      difficultyLabel: null,
      caloriesEstimateMin: null,
      caloriesEstimateMax: null,
      cancellationWindowHours: null,
      waitlistCapacity: null,
    },
    instructor: null,
  };
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
  const { classes, myBookings, myWaitlist, loading, error, refresh, getClass } = useStudioActivity();

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
        contentContainerStyle={{ paddingHorizontal: Space.screenH, paddingBottom: TAB_BAR_CLEARANCE }}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={() => void refresh()} tintColor={primaryColor} />
        }
      >
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
            <Skeleton height={120} radius={16} />
            <Skeleton height={120} radius={16} />
          </View>
        ) : (
          <>
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
                  {myBookings.map((b, i) => {
                    const cls = getClass(b.scheduledClassId);
                    const className = resolveClassName(b.scheduledClassId);
                    const item = resolveBookingClassItem(b, cls, className);
                    const imageUri =
                      cls?.classTemplate.heroImageUrl ??
                      cls?.classTemplate.thumbnailImageUrl ??
                      resolveClassImageUri(className);
                    const showCheckIn = b.status === 'CONFIRMED';

                    return (
                      <ClassCard
                        key={b.id}
                        item={item}
                        timeZone={timeZone}
                        accentColor={primaryColor}
                        imageUri={imageUri}
                        index={i}
                        statusPill={bookingStatusPill(b.status)}
                        onPress={() => router.push(`/(app)/class/${b.scheduledClassId}`)}
                        footer={
                          showCheckIn ? (
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel="Open check-in QR code"
                              onPress={() => router.push(`/(app)/check-in/${b.id}`)}
                              hitSlop={8}
                            >
                              <Text style={{ fontSize: 14, fontWeight: '600', color: primaryColor }}>
                                Check-in QR →
                              </Text>
                            </Pressable>
                          ) : undefined
                        }
                      />
                    );
                  })}
                </>
              )}
            </View>

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
