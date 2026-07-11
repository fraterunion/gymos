import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { BrandButton } from '@/components/BrandButton';
import { TAB_BAR_CLEARANCE } from '@/components/FloatingTabBar';
import { LoadRetryPanel, ScreenLoader } from '@/components/StudioScreenChrome';
import { useBranding } from '@/contexts/BrandingContext';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import {
  loadStaffTodayClasses,
} from '@/lib/staffTodaySchedule';
import {
  type TodayClassSummaryDto,
} from '@/lib/api/scheduleApi';
import { staffClassRosterHref } from '@/lib/staffClassRosterRoutes';
import { formatClassTime } from '@/lib/datetime';
import { todayScreenSubtitle } from '@/lib/staffRole';
import { canAccessExecutiveDashboard } from '@/lib/executivePermissions';
import { canAccessMembersDirectory } from '@/lib/memberProfilePermissions';
import { membersDirectoryHref } from '@/lib/memberProfileRoutes';
import { canAccessSales } from '@/lib/salesPermissions';
import { userFacingApiMessage } from '@/lib/userFacingApiMessage';
import { getColors, Space, type ThemeColors } from '@/constants/Theme';

function cardStyle(C: ThemeColors) {
  return {
    backgroundColor: '#141416',
    borderRadius: 28,
    borderWidth: 1,
    borderColor: C.separator,
    padding: 24,
  } as const;
}

function SectionLabel({ children }: { children: string }) {
  const C = getColors();
  return (
    <Text
      style={{
        fontSize: 11,
        fontWeight: '700',
        letterSpacing: 1.2,
        textTransform: 'uppercase',
        color: C.textMute,
        marginBottom: 14,
        marginTop: 32,
      }}
    >
      {children}
    </Text>
  );
}

function attendancePercent(checkedIn: number, booked: number): number {
  if (booked <= 0) return 0;
  return Math.round((checkedIn / booked) * 100);
}

function SummaryStat({ value, label }: { value: string; label: string }) {
  const C = getColors();
  return (
    <View style={{ flex: 1, alignItems: 'center' }}>
      <Text
        style={{
          fontSize: 26,
          fontWeight: '800',
          letterSpacing: -0.8,
          color: C.text,
          lineHeight: 30,
        }}
      >
        {value}
      </Text>
      <Text
        style={{
          fontSize: 10,
          fontWeight: '700',
          letterSpacing: 0.7,
          textTransform: 'uppercase',
          color: C.textMute,
          marginTop: 4,
          textAlign: 'center',
        }}
      >
        {label}
      </Text>
    </View>
  );
}

function TodaySummaryCard({ classes }: { classes: TodayClassSummaryDto[] }) {
  const C = getColors();

  const classCount = classes.length;
  const totalBooked = classes.reduce((sum, c) => sum + c.bookedCount, 0);
  const totalCheckedIn = classes.reduce((sum, c) => sum + c.checkedInCount, 0);
  const overallPct = attendancePercent(totalCheckedIn, totalBooked);

  return (
    <View style={cardStyle(C)}>
      <Text
        style={{
          fontSize: 11,
          fontWeight: '700',
          letterSpacing: 1.2,
          textTransform: 'uppercase',
          color: C.textMute,
          marginBottom: 20,
        }}
      >
        Clases de hoy
      </Text>
      <View style={{ flexDirection: 'row' }}>
        <SummaryStat value={String(classCount)} label="Clases" />
        <SummaryStat value={String(totalBooked)} label="Reservados" />
        <SummaryStat value={String(totalCheckedIn)} label="Check-in" />
        <SummaryStat value={`${overallPct}%`} label="Asistencia" />
      </View>
    </View>
  );
}

function TodayClassCard({
  item,
  timeZone,
  accentFallback,
  index,
  onViewRoster,
}: {
  item: TodayClassSummaryDto;
  timeZone: string;
  accentFallback: string;
  index: number;
  onViewRoster: () => void;
}) {
  const C = getColors();
  const { primaryColor } = useBranding();
  const isCancelled = item.status === 'CANCELLED';
  const accent = item.color?.trim() || accentFallback;
  const timeRange = `${formatClassTime(item.startsAt, timeZone)} – ${formatClassTime(item.endsAt, timeZone)}`;
  const coach = item.instructor
    ? `Coach ${item.instructor.firstName} ${item.instructor.lastName}`.trim()
    : 'Sin coach asignado';
  const progress = item.bookedCount > 0 ? item.checkedInCount / item.bookedCount : 0;

  return (
    <Animated.View entering={FadeInDown.delay(index * 60).duration(420)} style={{ marginBottom: Space.cardGap }}>
      <Pressable
        accessibilityRole="button"
        onPress={onViewRoster}
        style={({ pressed }) => ({
          backgroundColor: '#141416',
          borderRadius: 28,
          borderWidth: 1,
          borderColor: C.separator,
          overflow: 'hidden',
          opacity: isCancelled ? 0.55 : pressed ? 0.92 : 1,
        })}
      >
        <View style={{ height: 3, backgroundColor: isCancelled ? C.negative : accent }} />

        <View style={{ padding: 24 }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              marginBottom: 8,
            }}
          >
            <Text
              style={{
                flex: 1,
                fontSize: 18,
                fontWeight: '800',
                letterSpacing: -0.4,
                color: C.text,
                lineHeight: 24,
                marginRight: 12,
              }}
              numberOfLines={2}
            >
              {item.className}
            </Text>
            {isCancelled ? (
              <View
                style={{
                  backgroundColor: 'rgba(248,113,113,0.14)',
                  borderRadius: 100,
                  paddingVertical: 4,
                  paddingHorizontal: 10,
                }}
              >
                <Text
                  style={{
                    fontSize: 9,
                    fontWeight: '800',
                    letterSpacing: 0.8,
                    color: C.negative,
                  }}
                >
                  CANCELADA
                </Text>
              </View>
            ) : null}
          </View>

          <Text style={{ fontSize: 14, color: C.textSub, marginBottom: 6, letterSpacing: -0.1 }}>
            {timeRange}
          </Text>
          <Text style={{ fontSize: 13, color: C.textMute, marginBottom: 16 }}>
            {coach}
          </Text>

          <Text style={{ fontSize: 14, color: C.textSub, marginBottom: 10 }}>
            {item.bookedCount} / {item.capacity} reservados · {item.checkedInCount} con check-in
          </Text>

          <View
            style={{
              height: 4,
              borderRadius: 2,
              backgroundColor: 'rgba(255,255,255,0.08)',
              overflow: 'hidden',
              marginBottom: 18,
            }}
          >
            <View
              style={{
                height: '100%',
                width: `${Math.min(100, progress * 100)}%`,
                backgroundColor: isCancelled ? C.textMute : accent,
                borderRadius: 2,
              }}
            />
          </View>

          <BrandButton
            label="Ver lista"
            variant="ghost"
            accentColor={primaryColor}
            onPress={onViewRoster}
          />
        </View>
      </Pressable>
    </Animated.View>
  );
}

export default function StaffTodayScreen() {
  const router = useRouter();
  const C = getColors();
  const { primaryColor } = useBranding();
  const { matched, refetch } = useMemberStudio();
  const studioId = matched?.studio.id;
  const timeZone = matched?.studio.timezone ?? 'UTC';

  const [classes, setClasses] = useState<TodayClassSummaryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedOnce, setLoadedOnce] = useState(false);

  const load = useCallback(
    async (isRefresh = false) => {
      if (!studioId) return;
      if (isRefresh) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError(null);
      try {
        const data = await loadStaffTodayClasses(studioId, timeZone);
        setClasses(data);
      } catch (e) {
        setError(
          userFacingApiMessage(e, 'No pudimos cargar las clases de hoy. Desliza hacia abajo para actualizar e inténtalo de nuevo.'),
        );
        if (!isRefresh) {
          setClasses([]);
        }
      } finally {
        setLoading(false);
        setRefreshing(false);
        setLoadedOnce(true);
      }
    },
    [studioId, timeZone],
  );

  useFocusEffect(
    useCallback(() => {
      if (studioId) {
        void load();
      }
    }, [studioId, load]),
  );

  const openRoster = useCallback(
    (classId: string, className: string) => {
      router.push(staffClassRosterHref(classId, className));
    },
    [router],
  );

  const openSales = useCallback(() => {
    router.push('/(app)/staff-sales' as Href);
  }, [router]);

  const openMembersDirectory = useCallback(() => {
    router.push(membersDirectoryHref());
  }, [router]);

  const showSalesEntry = canAccessSales(matched?.role);
  const showMembersEntry =
    canAccessMembersDirectory(matched?.role) && !canAccessExecutiveDashboard(matched?.role);

  const showInitialLoader = loading && !loadedOnce;

  if (!studioId) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <LoadRetryPanel
          message="No pudimos cargar tu estudio. Revisa tu conexión e inténtalo de nuevo."
          onRetry={() => void refetch()}
        />
      </SafeAreaView>
    );
  }

  if (showInitialLoader) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <ScreenLoader />
      </SafeAreaView>
    );
  }

  if (error && classes.length === 0) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <LoadRetryPanel message={error} onRetry={() => void load()} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['left', 'right', 'top']}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: Space.screenH,
          paddingBottom: TAB_BAR_CLEARANCE,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load(true)}
            tintColor="rgba(255,255,255,0.4)"
          />
        }
      >
        <Animated.View entering={FadeInDown.duration(450)} style={{ paddingTop: 28, paddingBottom: 24 }}>
          <Text
            style={{
              fontSize: 38,
              fontWeight: '800',
              letterSpacing: -1.3,
              color: C.text,
              lineHeight: 44,
            }}
          >
            Hoy
          </Text>
          <Text
            style={{
              fontSize: 15,
              color: C.textSub,
              lineHeight: 22,
              marginTop: 10,
              letterSpacing: -0.1,
            }}
          >
            {todayScreenSubtitle(matched?.role)}
          </Text>
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(60).duration(420)}>
          <TodaySummaryCard classes={classes} />
        </Animated.View>

        {showSalesEntry ? (
          <Animated.View entering={FadeInDown.delay(90).duration(420)}>
            <Pressable
              accessibilityRole="button"
              onPress={openSales}
              style={[
                cardStyle(C),
                {
                  marginTop: 20,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 16,
                  paddingVertical: 22,
                },
              ]}
            >
              <View
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 16,
                  backgroundColor: `${primaryColor}22`,
                  borderWidth: 1,
                  borderColor: `${primaryColor}44`,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ fontSize: 22 }}>💳</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text
                  style={{
                    fontSize: 18,
                    fontWeight: '800',
                    letterSpacing: -0.4,
                    color: C.text,
                    marginBottom: 4,
                  }}
                >
                  Ventas / Checkout
                </Text>
                <Text style={{ fontSize: 14, lineHeight: 20, color: C.textSub }}>
                  Registra walk-ins, vende membresías y cobra con Stripe o efectivo.
                </Text>
              </View>
              <Text style={{ fontSize: 20, color: C.textMute }}>›</Text>
            </Pressable>
          </Animated.View>
        ) : null}

        {showMembersEntry ? (
          <Animated.View entering={FadeInDown.delay(showSalesEntry ? 120 : 90).duration(420)}>
            <Pressable
              accessibilityRole="button"
              onPress={openMembersDirectory}
              style={[
                cardStyle(C),
                {
                  marginTop: showSalesEntry ? 12 : 20,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 16,
                  paddingVertical: 22,
                },
              ]}
            >
              <View
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 16,
                  backgroundColor: 'rgba(255,255,255,0.06)',
                  borderWidth: 1,
                  borderColor: C.separator,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ fontSize: 22 }}>👥</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text
                  style={{
                    fontSize: 18,
                    fontWeight: '800',
                    letterSpacing: -0.4,
                    color: C.text,
                    marginBottom: 4,
                  }}
                >
                  Miembros
                </Text>
                <Text style={{ fontSize: 14, lineHeight: 20, color: C.textSub }}>
                  Busca clientes y abre su perfil, membresía y carta responsiva.
                </Text>
              </View>
              <Text style={{ fontSize: 20, color: C.textMute }}>›</Text>
            </Pressable>
          </Animated.View>
        ) : null}

        {classes.length === 0 ? (
          <Animated.View entering={FadeInDown.delay(120).duration(420)}>
            <View style={[cardStyle(C), { alignItems: 'center', paddingVertical: 40, marginTop: 32 }]}>
              <Text
                style={{
                  fontSize: 18,
                  fontWeight: '700',
                  letterSpacing: -0.3,
                  color: C.text,
                  textAlign: 'center',
                  marginBottom: 8,
                }}
              >
                No hay clases programadas para hoy.
              </Text>
              <Text style={{ fontSize: 14, color: C.textSub, lineHeight: 21, textAlign: 'center' }}>
                El horario de hoy está libre.
              </Text>
            </View>
          </Animated.View>
        ) : (
          <>
            <SectionLabel>Clases de hoy</SectionLabel>
            {classes.map((item, index) => (
              <TodayClassCard
                key={item.scheduledClassId}
                item={item}
                timeZone={timeZone}
                accentFallback={primaryColor}
                index={index}
                onViewRoster={() => openRoster(item.scheduledClassId, item.className)}
              />
            ))}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
