import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';
import FontAwesome from '@expo/vector-icons/FontAwesome';

import { TAB_BAR_CLEARANCE } from '@/components/FloatingTabBar';
import { LoadRetryPanel, ScreenLoader } from '@/components/StudioScreenChrome';
import { StaffScreenHeader, SummaryStrip, TimelineClassRow } from '@/components/staff/StaffPrimitives';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import { Accent, getColors, Radius, Space } from '@/constants/Theme';
import { loadStaffTodayClasses } from '@/lib/staffTodaySchedule';
import { type TodayClassSummaryDto } from '@/lib/api/scheduleApi';
import { staffClassRosterHref } from '@/lib/staffClassRosterRoutes';
import { formatClassTime } from '@/lib/datetime';
import { todayScreenSubtitle } from '@/lib/staffRole';
import { canAccessExecutiveDashboard } from '@/lib/executivePermissions';
import { canAccessMembersDirectory } from '@/lib/memberProfilePermissions';
import { membersDirectoryHref } from '@/lib/memberProfileRoutes';
import { canAccessSales } from '@/lib/salesPermissions';
import { userFacingApiMessage } from '@/lib/userFacingApiMessage';

function isClassNow(item: TodayClassSummaryDto): boolean {
  const now = Date.now();
  return new Date(item.startsAt).getTime() <= now && now < new Date(item.endsAt).getTime();
}

function EntryCard({
  title,
  subtitle,
  icon,
  onPress,
}: {
  title: string;
  subtitle: string;
  icon: 'credit-card' | 'users';
  onPress: () => void;
}) {
  const C = getColors();
  return (
    <Pressable accessibilityRole="button" onPress={onPress}>
      {({ pressed }) => (
        <Animated.View
          entering={FadeInDown.duration(300)}
          style={{
            backgroundColor: C.surface1,
            borderRadius: Radius.card,
            borderWidth: 1,
            borderColor: C.separator,
            padding: 24,
            marginBottom: 16,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 16,
            opacity: pressed ? 0.92 : 1,
          }}
        >
          <View
            style={{
              width: 48,
              height: 48,
              borderRadius: 16,
              backgroundColor: 'rgba(91,92,235,0.12)',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <FontAwesome name={icon} size={18} color={Accent} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 17, fontWeight: '700', color: C.text, letterSpacing: -0.4 }}>{title}</Text>
            <Text style={{ fontSize: 14, color: C.textSub, marginTop: 4, lineHeight: 20 }}>{subtitle}</Text>
          </View>
          <FontAwesome name="chevron-right" size={12} color={C.textMute} />
        </Animated.View>
      )}
    </Pressable>
  );
}

export default function StaffTodayScreen() {
  const router = useRouter();
  const C = getColors();
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
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const data = await loadStaffTodayClasses(studioId, timeZone);
        setClasses(data);
      } catch (e) {
        setError(
          userFacingApiMessage(e, 'No pudimos cargar las clases de hoy. Desliza hacia abajo para actualizar e inténtalo de nuevo.'),
        );
        if (!isRefresh) setClasses([]);
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
      if (studioId) void load();
    }, [studioId, load]),
  );

  const openRoster = useCallback(
    (classId: string, className: string) => {
      router.push(staffClassRosterHref(classId, className));
    },
    [router],
  );

  const totalBooked = classes.reduce((sum, c) => sum + c.bookedCount, 0);
  const totalCheckedIn = classes.reduce((sum, c) => sum + c.checkedInCount, 0);
  const attendancePct = totalBooked > 0 ? Math.round((totalCheckedIn / totalBooked) * 100) : 0;

  const showSalesEntry = canAccessSales(matched?.role);
  const showMembersEntry =
    canAccessMembersDirectory(matched?.role) && !canAccessExecutiveDashboard(matched?.role);

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

  if (loading && !loadedOnce) {
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
        contentContainerStyle={{ paddingHorizontal: Space.screenH, paddingBottom: TAB_BAR_CLEARANCE }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} tintColor="rgba(255,255,255,0.35)" />
        }
      >
        <StaffScreenHeader title="Hoy" subtitle={todayScreenSubtitle(matched?.role)} />

        <SummaryStrip
          items={[
            { value: String(classes.length), label: 'Clases' },
            { value: String(totalBooked), label: 'Reservas' },
            { value: String(totalCheckedIn), label: 'Check-ins' },
            { value: `${attendancePct}%`, label: 'Asistencia' },
          ]}
        />

        {showSalesEntry ? (
          <EntryCard
            title="Ventas / Checkout"
            subtitle="Registra walk-ins, vende membresías y cobra con Stripe o efectivo."
            icon="credit-card"
            onPress={() => router.push('/(app)/staff-sales' as Href)}
          />
        ) : null}

        {showMembersEntry ? (
          <EntryCard
            title="Miembros"
            subtitle="Busca clientes y abre su perfil, membresía y carta responsiva."
            icon="users"
            onPress={() => router.push(membersDirectoryHref())}
          />
        ) : null}

        {classes.length === 0 ? (
          <View style={{ marginTop: 8, paddingTop: Space.sp3, paddingBottom: Space.sp4 }}>
            <Text style={{ fontSize: 17, fontWeight: '600', color: C.text }}>
              Sin clases hoy.
            </Text>
            <Text style={{ fontSize: 14, color: C.textSub, marginTop: 6, lineHeight: 21 }}>
              El horario de hoy está libre.
            </Text>
          </View>
        ) : (
          <View style={{ marginTop: 8 }}>
            {classes.map((item, index) => (
              <TimelineClassRow
                key={item.scheduledClassId}
                time={formatClassTime(item.startsAt, timeZone)}
                className={item.className}
                coach={
                  item.instructor
                    ? `${item.instructor.firstName} ${item.instructor.lastName}`
                    : 'Sin coach asignado'
                }
                booked={item.bookedCount}
                capacity={item.capacity}
                status={item.status}
                isNow={isClassNow(item)}
                index={index}
                isLast={index === classes.length - 1}
                onPress={() => openRoster(item.scheduledClassId, item.className)}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
