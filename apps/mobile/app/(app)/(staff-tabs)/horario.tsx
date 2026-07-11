import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { TAB_BAR_CLEARANCE } from '@/components/FloatingTabBar';
import { LoadRetryPanel, ScreenLoader } from '@/components/StudioScreenChrome';
import {
  DayCapsule,
  ScheduleClassCard,
  StaffScreenHeader,
  WeekNavigatorBar,
} from '@/components/staff/StaffPrimitives';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import {
  calendarDayKeyInZone,
  dayOfMonthLabel,
  formatClassTime,
  todayKeyInZone,
  weekBoundsInZone,
  weekDayKeysFromStart,
  weekdayShortLabel,
} from '@/lib/datetime';
import { loadStaffScheduleWeek } from '@/lib/staffSchedule';
import { staffClassRosterHref } from '@/lib/staffClassRosterRoutes';
import { userFacingApiMessage } from '@/lib/userFacingApiMessage';
import type { ScheduledClassDto } from '@/lib/types/studio';
import { getColors, Space } from '@/constants/Theme';

export default function StaffScheduleScreen() {
  const router = useRouter();
  const C = getColors();
  const { matched, refetch } = useMemberStudio();
  const studioId = matched?.studio.id;
  const timeZone = matched?.studio.timezone ?? 'UTC';

  const [weekOffset, setWeekOffset] = useState(0);
  const [selectedDayKey, setSelectedDayKey] = useState<string | null>(null);
  const [classes, setClasses] = useState<ScheduledClassDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedOnce, setLoadedOnce] = useState(false);

  const todayKey = useMemo(() => todayKeyInZone(timeZone), [timeZone]);
  const weekBounds = useMemo(() => weekBoundsInZone(timeZone, weekOffset), [timeZone, weekOffset]);
  const weekDays = useMemo(() => weekDayKeysFromStart(weekBounds.startKey), [weekBounds.startKey]);

  useEffect(() => {
    if (!selectedDayKey || !weekDays.includes(selectedDayKey)) {
      if (weekDays.includes(todayKey)) {
        setSelectedDayKey(todayKey);
      } else {
        setSelectedDayKey(weekDays[0] ?? todayKey);
      }
    }
  }, [weekDays, todayKey, selectedDayKey]);

  const load = useCallback(
    async (isRefresh = false) => {
      if (!studioId) return;
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const rows = await loadStaffScheduleWeek(
          studioId,
          timeZone,
          weekBounds.startKey,
          weekBounds.endKey,
        );
        setClasses(rows);
      } catch (e) {
        setError(
          userFacingApiMessage(
            e,
            'No pudimos cargar el horario. Desliza hacia abajo para actualizar e inténtalo de nuevo.',
          ),
        );
        if (!isRefresh) setClasses([]);
      } finally {
        setLoading(false);
        setRefreshing(false);
        setLoadedOnce(true);
      }
    },
    [studioId, timeZone, weekBounds.startKey, weekBounds.endKey],
  );

  useFocusEffect(
    useCallback(() => {
      if (studioId) void load();
    }, [studioId, load]),
  );

  const dayClasses = useMemo(() => {
    if (!selectedDayKey) return [];
    return classes
      .filter((row) => calendarDayKeyInZone(row.startsAt, timeZone) === selectedDayKey)
      .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  }, [classes, selectedDayKey, timeZone]);

  const openRoster = useCallback(
    (classId: string, className: string) => {
      router.push(staffClassRosterHref(classId, className));
    },
    [router],
  );

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
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load(true)}
            tintColor="rgba(255,255,255,0.35)"
          />
        }
      >
        <StaffScreenHeader title="Horario" />

        <WeekNavigatorBar
          label={weekBounds.label}
          canGoPrev={weekOffset > -52}
          onPrev={() => setWeekOffset((w) => w - 1)}
          onNext={() => setWeekOffset((w) => w + 1)}
        />

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 24, gap: 0 }}
        >
          {weekDays.map((dayKey) => (
            <DayCapsule
              key={dayKey}
              label={weekdayShortLabel(dayKey, timeZone)}
              dayNum={dayOfMonthLabel(dayKey, timeZone)}
              selected={selectedDayKey === dayKey}
              isToday={dayKey === todayKey}
              onPress={() => setSelectedDayKey(dayKey)}
            />
          ))}
        </ScrollView>

        {dayClasses.length === 0 ? (
          <Animated.View entering={FadeInDown.duration(300)} style={{ marginTop: Space.sp2, paddingTop: Space.sp3 }}>
            <Text style={{ fontSize: 17, fontWeight: '600', color: C.text }}>Sin clases este día.</Text>
            <Text style={{ fontSize: 14, color: C.textSub, marginTop: 6, lineHeight: 21 }}>
              Selecciona otro día o cambia de semana.
            </Text>
          </Animated.View>
        ) : (
          dayClasses.map((item, index) => (
            <ScheduleClassCard
              key={item.id}
              className={item.classTemplate.name}
              timeLabel={`${formatClassTime(item.startsAt, timeZone)} – ${formatClassTime(item.endsAt, timeZone)}`}
              coachLabel={
                item.instructor
                  ? `${item.instructor.firstName} ${item.instructor.lastName}`
                  : 'Sin coach asignado'
              }
              booked={item.bookedCount ?? 0}
              capacity={item.capacity}
              cancelled={item.status === 'CANCELLED'}
              index={index}
              onPress={() => openRoster(item.id, item.classTemplate.name)}
            />
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
