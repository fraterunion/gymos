import { useRouter } from 'expo-router';
import { Pressable, RefreshControl, ScrollView, Text, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { BrandButton } from '@/components/BrandButton';
import { ClassCard } from '@/components/ClassCard';
import { TAB_BAR_CLEARANCE } from '@/components/FloatingTabBar';
import { EmptyHint, ErrorBanner, LoadRetryPanel, Skeleton, ScreenLoader } from '@/components/StudioScreenChrome';
import { useAuth } from '@/contexts/AuthContext';
import { useBranding } from '@/contexts/BrandingContext';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import { useStudioActivity } from '@/contexts/StudioActivityContext';
import { bookingStatusPill } from '@/lib/bookingStatus';
import { resolveScheduledClassImageUri } from '@/lib/imagery';
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

const GUEST_FEATURES = [
  'Próximas reservas',
  'Listas de espera',
  'Check-in con QR',
  'Historial de asistencia',
] as const;

// ---------------------------------------------------------------------------
// Guest wall — no authenticated API calls
// ---------------------------------------------------------------------------

function GuestBookingsWall({ primaryColor }: { primaryColor: string }) {
  const router = useRouter();
  const C = getColors();

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['left', 'right', 'top']}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: Space.screenH,
          paddingBottom: TAB_BAR_CLEARANCE,
        }}
      >
        <Animated.View entering={FadeInDown.duration(500)} style={{ paddingTop: 28, paddingBottom: 24 }}>
          <Text
            style={{
              fontSize: 38,
              fontWeight: '800',
              letterSpacing: -1.3,
              color: C.text,
              lineHeight: 44,
            }}
          >
            Tu camino de entrenamiento
          </Text>
          <Text
            style={{
              fontSize: 15,
              color: C.textSub,
              lineHeight: 23,
              marginTop: 14,
              letterSpacing: -0.1,
            }}
          >
            Consulta tus próximas clases, listas de espera, historial de asistencia y check-ins
            después de crear tu cuenta.
          </Text>
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(80).duration(460)}>
          <View
            style={{
              backgroundColor: C.surface1,
              borderRadius: 20,
              padding: 26,
            }}
          >
            <Text
              style={{
                fontSize: 11,
                fontWeight: '700',
                letterSpacing: 1.0,
                textTransform: 'uppercase',
                color: C.textMute,
                marginBottom: 18,
              }}
            >
              Con tu cuenta
            </Text>
            {GUEST_FEATURES.map((feature, index) => (
              <View
                key={feature}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  marginBottom: index < GUEST_FEATURES.length - 1 ? 14 : 0,
                }}
              >
                <View
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 3,
                    backgroundColor: primaryColor,
                    marginRight: 12,
                  }}
                />
                <Text
                  style={{
                    fontSize: 15,
                    color: C.text,
                    fontWeight: '500',
                    letterSpacing: -0.2,
                  }}
                >
                  {feature}
                </Text>
              </View>
            ))}
          </View>
        </Animated.View>

        <Animated.View
          entering={FadeInDown.delay(140).duration(440)}
          style={{ marginTop: 28, gap: 12 }}
        >
          <BrandButton
            label="Crear cuenta"
            variant="white"
            accentColor={primaryColor}
            onPress={() => router.push('/(auth)/register')}
          />
          <BrandButton
            label="Iniciar sesión"
            variant="ghost"
            accentColor={primaryColor}
            onPress={() => router.push('/(auth)/login')}
          />
        </Animated.View>
      </ScrollView>
    </SafeAreaView>
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
              ? 'Promovido — toca para completar la reserva'
              : entry.queueRank != null
                ? `#${entry.queueRank} · ${entry.waitingCountForClass} en espera`
                : 'Lista de espera'}
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
  const { user } = useAuth();
  const isGuest = user === null;
  const matched = useMemberStudio().matched;
  const { classes, myBookings, myWaitlist, loading, error, refresh, getClass } = useStudioActivity();

  if (isGuest) {
    return <GuestBookingsWall primaryColor={primaryColor} />;
  }

  const timeZone = matched?.studio.timezone ?? 'UTC';

  if (!matched) return <ScreenLoader />;
  if (error && myBookings.length === 0 && myWaitlist.length === 0) {
    return <LoadRetryPanel message={error} onRetry={refresh} />;
  }

  const showSkeleton = loading && myBookings.length === 0 && myWaitlist.length === 0;

  function resolveClassName(classId: string): string {
    return classes.find((c) => c.id === classId)?.classTemplate.name ?? 'Clase';
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
            Mis reservas
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
                  title="Aún no tienes reservas"
                  body="Revisa el horario y aparta tu lugar."
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
                    Próximas
                  </Text>
                  {myBookings.map((b, i) => {
                    const cls = getClass(b.scheduledClassId);
                    const className = resolveClassName(b.scheduledClassId);
                    const item = resolveBookingClassItem(b, cls, className);
                    const imageUri = resolveScheduledClassImageUri(
                      cls?.classTemplate ?? {
                        name: className,
                        category: null,
                        heroImageUrl: null,
                        thumbnailImageUrl: null,
                      },
                      'thumbnail',
                    );
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
                              accessibilityLabel="Abrir código QR"
                              onPress={() => router.push(`/(app)/check-in/${b.id}`)}
                              hitSlop={8}
                            >
                              <Text style={{ fontSize: 14, fontWeight: '600', color: C.text }}>
                                Código QR →
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
                  Lista de espera
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
