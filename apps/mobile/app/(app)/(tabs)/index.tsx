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
import {
  resolveClassImageUri,
  resolveCoachPortraitUri,
  CATEGORY_MODULES,
  type CategoryModule,
} from '@/lib/imagery';
import { getColors, Space } from '@/constants/Theme';
import type { BookingWithClass, ScheduledClassDto } from '@/lib/types/studio';

// ---------------------------------------------------------------------------
// Greeting
// ---------------------------------------------------------------------------

function buildGreeting(firstName: string | null | undefined): string {
  const h = new Date().getHours();
  const s = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  return firstName ? `${s},\n${firstName}.` : `${s}.`;
}

// ---------------------------------------------------------------------------
// Category strip — horizontal scroll of curated fitness categories
// ---------------------------------------------------------------------------

function CategoryTile({ category, delay }: { category: CategoryModule; delay: number }) {
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Animated.View
      entering={FadeInDown.delay(delay).duration(480)}
      style={[{ width: 118, height: 162, borderRadius: 16, overflow: 'hidden' }, animStyle]}
    >
      <Pressable
        accessibilityRole="button"
        onPressIn={() => { scale.value = withSpring(0.94, { damping: 20, stiffness: 400 }); }}
        onPressOut={() => { scale.value = withSpring(1.0, { damping: 14, stiffness: 200 }); }}
        style={{ flex: 1 }}
      >
        {/* Cinematic background */}
        <ImageSlot
          uri={category.imageUri}
          vignette
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        />

        {/* Accent dot — category color identifier */}
        <View
          style={{
            position: 'absolute',
            top: 12,
            left: 12,
            width: 7,
            height: 7,
            borderRadius: 4,
            backgroundColor: category.accent,
          }}
        />

        {/* Category label */}
        <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: 14 }}>
          <Text
            style={{
              fontSize: 14,
              fontWeight: '800',
              letterSpacing: -0.4,
              color: '#FFFFFF',
              lineHeight: 16,
            }}
          >
            {category.label}
          </Text>
        </View>
      </Pressable>
    </Animated.View>
  );
}

function CategoryStrip() {
  return (
    <Animated.View entering={FadeInDown.delay(80).duration(500)} style={{ marginTop: 8, marginBottom: 36 }}>
      <Text
        style={{
          fontSize: 11,
          fontWeight: '700',
          letterSpacing: 1.0,
          textTransform: 'uppercase',
          color: 'rgba(255,255,255,0.32)',
          marginBottom: 14,
        }}
      >
        Explore
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ marginHorizontal: -Space.screenH }}
        contentContainerStyle={{ paddingHorizontal: Space.screenH, gap: 10 }}
      >
        {CATEGORY_MODULES.map((cat, i) => (
          <CategoryTile key={cat.id} category={cat} delay={100 + i * 45} />
        ))}
      </ScrollView>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Coach spotlight — instructors teaching upcoming classes
// ---------------------------------------------------------------------------

type CoachEntry = { key: string; firstName: string; lastName: string; classCount: number };

function CoachCard({ coach }: { coach: CoachEntry }) {
  const portraitUri = resolveCoachPortraitUri(coach.firstName, coach.lastName);
  const initials = `${coach.firstName[0] ?? ''}${coach.lastName[0] ?? ''}`.toUpperCase();

  return (
    <View style={{ alignItems: 'center', width: 76 }}>
      {/* Portrait circle */}
      <View
        style={{
          width: 62,
          height: 62,
          borderRadius: 31,
          overflow: 'hidden',
          backgroundColor: '#1C1C1E',
          marginBottom: 10,
          borderWidth: 1,
          borderColor: 'rgba(255,255,255,0.08)',
        }}
      >
        <ImageSlot uri={portraitUri} vignette={false} style={{ flex: 1 }} />
        {/* Initials fallback — rendered over image, hidden when image loads */}
        <View
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ fontSize: 17, fontWeight: '700', color: 'rgba(255,255,255,0.30)' }}>
            {initials}
          </Text>
        </View>
      </View>

      <Text
        numberOfLines={1}
        style={{
          fontSize: 12,
          fontWeight: '600',
          color: '#FFFFFF',
          letterSpacing: -0.2,
          textAlign: 'center',
        }}
      >
        {coach.firstName}
      </Text>
      <Text style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginTop: 2, textAlign: 'center' }}>
        {coach.classCount} {coach.classCount === 1 ? 'class' : 'classes'}
      </Text>
    </View>
  );
}

function CoachSpotlight({ classes }: { classes: ScheduledClassDto[] }) {
  const coaches: CoachEntry[] = useMemo(() => {
    const seen = new Set<string>();
    const counts = new Map<string, number>();
    for (const cls of classes) {
      if (cls.instructor) {
        const k = `${cls.instructor.firstName} ${cls.instructor.lastName}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    const result: CoachEntry[] = [];
    for (const cls of classes) {
      if (!cls.instructor) continue;
      const k = `${cls.instructor.firstName} ${cls.instructor.lastName}`;
      if (!seen.has(k)) {
        seen.add(k);
        result.push({
          key: k,
          firstName: cls.instructor.firstName,
          lastName: cls.instructor.lastName,
          classCount: counts.get(k) ?? 1,
        });
        if (result.length >= 5) break;
      }
    }
    return result;
  }, [classes]);

  if (coaches.length === 0) return null;

  return (
    <Animated.View entering={FadeInDown.delay(160).duration(480)} style={{ marginTop: 44 }}>
      <Text
        style={{
          fontSize: 11,
          fontWeight: '700',
          letterSpacing: 1.0,
          textTransform: 'uppercase',
          color: 'rgba(255,255,255,0.32)',
          marginBottom: 18,
        }}
      >
        Coaches
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ marginHorizontal: -Space.screenH }}
        contentContainerStyle={{ paddingHorizontal: Space.screenH, gap: 20 }}
      >
        {coaches.map((coach) => (
          <CoachCard key={coach.key} coach={coach} />
        ))}
      </ScrollView>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Next-session hero — full-bleed cinematic card with check-in CTA inside
// ---------------------------------------------------------------------------

function NextSessionHero({
  booking,
  cls,
  timeZone,
  primaryColor,
  imageUri,
  onPress,
  onCheckIn,
}: {
  booking: BookingWithClass;
  cls: { name: string; durationMinutes: number; instructorName: string | null } | null;
  timeZone: string;
  primaryColor: string;
  imageUri?: string;
  onPress: () => void;
  onCheckIn: () => void;
}) {
  const time = formatClassTime(booking.scheduledClass.startsAt, timeZone);
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Animated.View
      entering={FadeInDown.duration(560)}
      style={[{ borderRadius: 22, overflow: 'hidden', height: 284 }, animStyle]}
    >
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        onPressIn={() => { scale.value = withSpring(0.980, { damping: 22, stiffness: 340 }); }}
        onPressOut={() => { scale.value = withSpring(1.0, { damping: 14, stiffness: 200 }); }}
        style={{ flex: 1 }}
      >
        <ImageSlot
          uri={imageUri}
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

        {/* "YOUR NEXT CLASS" label */}
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

        {/* Content pinned to bottom */}
        <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: 22 }}>
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

          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
            <Text
              style={{
                fontSize: 15,
                color: 'rgba(255,255,255,0.72)',
                fontWeight: '500',
                letterSpacing: -0.1,
              }}
            >
              {time}
            </Text>
            {cls ? (
              <>
                <Text style={{ fontSize: 12, color: 'rgba(255,255,255,0.28)', marginHorizontal: 7 }}>·</Text>
                <Text style={{ fontSize: 14, color: 'rgba(255,255,255,0.48)' }}>
                  {cls.durationMinutes} min
                </Text>
              </>
            ) : null}
          </View>

          {cls?.instructorName ? (
            <Text style={{ fontSize: 13, color: 'rgba(255,255,255,0.38)', marginBottom: 18 }}>
              {cls.instructorName}
            </Text>
          ) : (
            <View style={{ height: 18 }} />
          )}

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

  // Next confirmed booking, soonest first
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

  const nextBookingImageUri = useMemo(
    () => (nextBookingClass ? resolveClassImageUri(nextBookingClass.name) : undefined),
    [nextBookingClass],
  );

  // Upcoming classes today
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
        <Animated.View entering={FadeInDown.duration(500)} style={{ paddingTop: 28, paddingBottom: 24 }}>
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

        {/* ── Category strip — always visible (static editorial content) ── */}
        <CategoryStrip />

        {error ? (
          <View style={{ marginBottom: 16 }}>
            <ErrorBanner message={error} onRetry={refresh} />
          </View>
        ) : null}

        {showSkeleton ? (
          <View style={{ gap: 10 }}>
            <Skeleton height={284} radius={22} />
            <Skeleton width="28%" height={10} radius={4} style={{ marginTop: 36 }} />
            <Skeleton height={240} radius={20} style={{ marginTop: 16 }} />
            <Skeleton height={92} radius={16} style={{ marginTop: 8 }} />
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
                imageUri={nextBookingImageUri}
                onPress={() => router.push(`/(app)/class/${nextBooking.scheduledClassId}`)}
                onCheckIn={() => router.push(`/(app)/check-in/${nextBooking.id}`)}
              />
            ) : null}

            {/* ── Today's classes ── */}
            {todaysUpcoming.length > 0 ? (
              <View style={{ marginTop: nextBooking ? 44 : 0 }}>
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

                {!nextBooking && todayFeatured ? (
                  <>
                    <FeaturedClassTile
                      item={todayFeatured}
                      timeZone={timeZone}
                      accentColor={todayFeatured.classTemplate.color ?? primaryColor}
                      imageUri={resolveClassImageUri(todayFeatured.classTemplate.name)}
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
                        imageUri={resolveClassImageUri(c.classTemplate.name)}
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
                      imageUri={resolveClassImageUri(c.classTemplate.name)}
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

            {/* ── Coach spotlight ── */}
            <CoachSpotlight classes={classes} />

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
