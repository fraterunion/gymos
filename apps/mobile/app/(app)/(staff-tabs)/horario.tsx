import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, RefreshControl, SectionList, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { TAB_BAR_CLEARANCE } from '@/components/FloatingTabBar';
import { LoadRetryPanel, ScreenLoader } from '@/components/StudioScreenChrome';
import { useBranding } from '@/contexts/BrandingContext';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import {
  calendarDayKeyInZone,
  formatClassDateLabel,
  formatClassTime,
  todayKeyInZone,
  weekBoundsInZone,
} from '@/lib/datetime';
import { loadStaffScheduleWeek } from '@/lib/staffSchedule';
import { staffClassRosterHref } from '@/lib/staffClassRosterRoutes';
import { userFacingApiMessage } from '@/lib/userFacingApiMessage';
import type { ScheduledClassDto } from '@/lib/types/studio';
import { getColors, Space } from '@/constants/Theme';

type Section = {
  key: string;
  title: string;
  isToday: boolean;
  data: ScheduledClassDto[];
};

function cardStyle() {
  const C = getColors();
  return {
    backgroundColor: '#141416',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: C.separator,
    padding: 18,
  } as const;
}

function WeekNavigator({
  label,
  weekOffset,
  onChange,
}: {
  label: string;
  weekOffset: number;
  onChange: (next: number) => void;
}) {
  const C = getColors();
  const canGoPrev = weekOffset > -52;

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingTop: 20,
        paddingBottom: 8,
        gap: 12,
      }}
    >
      <Pressable
        accessibilityRole="button"
        onPress={() => canGoPrev && onChange(weekOffset - 1)}
        disabled={!canGoPrev}
        hitSlop={10}
        style={{ opacity: canGoPrev ? 1 : 0.35, minWidth: 72 }}
      >
        <Text style={{ fontSize: 14, fontWeight: '600', color: C.text }}>← Anterior</Text>
      </Pressable>
      <View style={{ flex: 1, alignItems: 'center' }}>
        <Text style={{ fontSize: 13, color: C.textSub, textAlign: 'center' }}>{label}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        onPress={() => onChange(weekOffset + 1)}
        hitSlop={10}
        style={{ minWidth: 72, alignItems: 'flex-end' }}
      >
        <Text style={{ fontSize: 14, fontWeight: '600', color: C.text }}>Siguiente →</Text>
      </Pressable>
    </View>
  );
}

function StaffClassRow({
  item,
  timeZone,
  accent,
  onPress,
}: {
  item: ScheduledClassDto;
  timeZone: string;
  accent: string;
  onPress: () => void;
}) {
  const C = getColors();
  const isCancelled = item.status === 'CANCELLED';
  const timeRange = `${formatClassTime(item.startsAt, timeZone)} – ${formatClassTime(item.endsAt, timeZone)}`;

  return (
    <Animated.View entering={FadeInDown.duration(360)} style={{ marginBottom: 12 }}>
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        style={({ pressed }) => [
          cardStyle(),
          { opacity: isCancelled ? 0.55 : pressed ? 0.92 : 1, overflow: 'hidden' },
        ]}
      >
        <View style={{ height: 3, backgroundColor: isCancelled ? C.negative : accent, marginBottom: 14, marginHorizontal: -18, marginTop: -18 }} />
        <Text style={{ fontSize: 17, fontWeight: '800', color: C.text, letterSpacing: -0.3 }}>
          {item.classTemplate.name}
        </Text>
        <Text style={{ fontSize: 14, color: C.textSub, marginTop: 6 }}>{timeRange}</Text>
        <Text style={{ fontSize: 13, color: C.textMute, marginTop: 4 }}>
          {item.instructor
            ? `${item.instructor.firstName} ${item.instructor.lastName}`
            : 'Sin coach asignado'}
        </Text>
        <Text style={{ fontSize: 13, color: C.textSub, marginTop: 10 }}>
          {item.bookedCount ?? 0} / {item.capacity} reservados
        </Text>
      </Pressable>
    </Animated.View>
  );
}

export default function StaffScheduleScreen() {
  const router = useRouter();
  const C = getColors();
  const { primaryColor } = useBranding();
  const { matched, refetch } = useMemberStudio();
  const studioId = matched?.studio.id;
  const timeZone = matched?.studio.timezone ?? 'UTC';

  const [weekOffset, setWeekOffset] = useState(0);
  const [classes, setClasses] = useState<ScheduledClassDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedOnce, setLoadedOnce] = useState(false);

  const todayKey = useMemo(() => todayKeyInZone(timeZone), [timeZone]);
  const weekBounds = useMemo(() => weekBoundsInZone(timeZone, weekOffset), [timeZone, weekOffset]);

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

  const sections: Section[] = useMemo(() => {
    const map = new Map<string, ScheduledClassDto[]>();
    for (const row of classes) {
      const key = calendarDayKeyInZone(row.startsAt, timeZone);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(row);
    }
    return [...map.keys()]
      .sort()
      .map((key) => {
        const first = map.get(key)![0]!;
        return {
          key,
          title: key === todayKey ? 'Hoy' : formatClassDateLabel(first.startsAt, timeZone),
          isToday: key === todayKey,
          data: map.get(key)!,
        };
      });
  }, [classes, timeZone, todayKey]);

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
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ paddingHorizontal: Space.screenH, paddingBottom: TAB_BAR_CLEARANCE }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load(true)}
            tintColor="rgba(255,255,255,0.4)"
          />
        }
        ListHeaderComponent={
          <>
            <Text
              style={{
                fontSize: 38,
                fontWeight: '800',
                letterSpacing: -1.3,
                color: C.text,
                lineHeight: 44,
                paddingTop: 28,
                paddingBottom: 8,
              }}
            >
              Horario
            </Text>
            <Text style={{ fontSize: 15, color: C.textSub, lineHeight: 22, marginBottom: 8 }}>
              Consulta clases de cualquier fecha y abre la lista de reservas.
            </Text>
            <WeekNavigator
              label={weekBounds.label}
              weekOffset={weekOffset}
              onChange={setWeekOffset}
            />
          </>
        }
        ListEmptyComponent={
          <View style={[cardStyle(), { alignItems: 'center', paddingVertical: 36, marginTop: 24 }]}>
            <Text style={{ fontSize: 16, fontWeight: '700', color: C.text, textAlign: 'center' }}>
              No hay clases programadas en esta semana.
            </Text>
          </View>
        }
        renderSectionHeader={({ section }) => (
          <Text
            style={{
              fontSize: section.isToday ? 30 : 22,
              fontWeight: '800',
              letterSpacing: -0.6,
              color: C.text,
              paddingTop: section.isToday ? 28 : 32,
              paddingBottom: 14,
            }}
          >
            {section.title}
          </Text>
        )}
        renderItem={({ item }) => (
          <StaffClassRow
            item={item}
            timeZone={timeZone}
            accent={item.classTemplate.color?.trim() || primaryColor}
            onPress={() => openRoster(item.id, item.classTemplate.name)}
          />
        )}
      />
    </SafeAreaView>
  );
}
