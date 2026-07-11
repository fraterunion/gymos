import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { ClassCard } from '@/components/ClassCard';
import { FeaturedClassTile } from '@/components/FeaturedClassTile';
import { TAB_BAR_CLEARANCE } from '@/components/FloatingTabBar';
import { MemberDaySelector } from '@/components/member/MemberDaySelector';
import { MemberScheduleEmptyState } from '@/components/member/MemberScheduleEmptyState';
import { MemberWeekNavigator } from '@/components/member/MemberWeekNavigator';
import { OpenGymBenefitCard } from '@/components/OpenGymBenefitCard';
import { ScheduleFilterBar } from '@/components/ScheduleFilterBar';
import {
  ARES_CLASS_FILTER_ALL,
  ARES_CLASS_FILTERS,
  matchesAresClassFilter,
} from '@/lib/aresScheduleFilters';
import {
  ErrorBanner,
  LoadRetryPanel,
  Skeleton,
  ScreenLoader,
} from '@/components/StudioScreenChrome';
import { usePublicSchedule } from '@/contexts/PublicScheduleContext';
import { usePublicStudio } from '@/contexts/PublicStudioContext';
import { todayKeyInZone, weekBoundsInZone } from '@/lib/datetime';
import { resolveScheduledClassImageUri } from '@/lib/imagery';
import {
  buildMemberClassCountByDay,
  buildMemberFilteredClassCountByDay,
  filterMemberScheduleClasses,
  findNearestDayWithMatchingClasses,
  formatFilterAutoJumpAccessibilityMessage,
  formatMemberDayHeading,
  formatMemberWeekRangeLabel,
  memberWeekDayKeys,
  resolveDefaultMemberDayKey,
  weekHasMatchingFilteredClasses,
} from '@/lib/memberSchedule';
import { getColors, Space } from '@/constants/Theme';

function ScheduleSkeleton() {
  return (
    <View style={{ flex: 1, paddingHorizontal: Space.screenH, paddingTop: 32 }}>
      <Skeleton width="40%" height={40} radius={8} style={{ marginBottom: 28 }} />
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 20 }}>
        <Skeleton width={44} height={44} radius={22} />
        <Skeleton width="45%" height={16} radius={6} />
        <Skeleton width={44} height={44} radius={22} />
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 28 }}>
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} width={40} height={72} radius={12} />
        ))}
      </View>
      <Skeleton height={96} radius={22} style={{ marginBottom: 20 }} />
      <Skeleton height={32} radius={8} style={{ marginBottom: 12 }} />
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 24 }}>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} width={72} height={36} radius={18} />
        ))}
      </View>
      <Skeleton width="55%" height={24} radius={6} style={{ marginBottom: 20 }} />
      <Skeleton height={220} radius={20} style={{ marginBottom: Space.cardGap }} />
      <Skeleton height={106} radius={16} />
    </View>
  );
}

export default function ScheduleScreen() {
  const router = useRouter();
  const C = getColors();
  const { timezone, loading: studioLoading } = usePublicStudio();
  const { classes, loading: scheduleLoading, error, refresh } = usePublicSchedule();

  const [weekOffset, setWeekOffset] = useState(0);
  const [classFilterId, setClassFilterId] = useState(ARES_CLASS_FILTER_ALL);
  const [selectedDayKey, setSelectedDayKey] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const listAnchorY = useRef(0);

  const timeZone = timezone;
  const todayKey = useMemo(() => todayKeyInZone(timeZone), [timeZone]);
  const weekBounds = useMemo(
    () => weekBoundsInZone(timeZone, weekOffset),
    [timeZone, weekOffset],
  );
  const weekDayKeys = useMemo(
    () => memberWeekDayKeys(weekBounds.startKey),
    [weekBounds.startKey],
  );
  const weekLabel = useMemo(
    () => formatMemberWeekRangeLabel(weekBounds.startKey, weekBounds.endKey, timeZone),
    [weekBounds.startKey, weekBounds.endKey, timeZone],
  );

  const unfilteredClassCountByDay = useMemo(
    () =>
      buildMemberClassCountByDay(
        classes,
        timeZone,
        weekBounds.startKey,
        weekBounds.endKey,
      ),
    [classes, timeZone, weekBounds.startKey, weekBounds.endKey],
  );

  const defaultDayKey = useMemo(
    () => resolveDefaultMemberDayKey(weekDayKeys, todayKey, unfilteredClassCountByDay),
    [weekDayKeys, todayKey, unfilteredClassCountByDay],
  );

  useEffect(() => {
    setSelectedDayKey(defaultDayKey);
  }, [defaultDayKey, weekOffset]);

  const activeDayKey = selectedDayKey ?? defaultDayKey;

  const dayClasses = useMemo(
    () =>
      filterMemberScheduleClasses(
        classes,
        timeZone,
        activeDayKey,
        weekBounds.startKey,
        weekBounds.endKey,
        classFilterId,
        matchesAresClassFilter,
      ),
    [
      classes,
      timeZone,
      activeDayKey,
      weekBounds.startKey,
      weekBounds.endKey,
      classFilterId,
    ],
  );

  const filteredClassCountByDay = useMemo(
    () =>
      buildMemberFilteredClassCountByDay(
        classes,
        timeZone,
        weekBounds.startKey,
        weekBounds.endKey,
        classFilterId,
        matchesAresClassFilter,
      ),
    [classes, timeZone, weekBounds.startKey, weekBounds.endKey, classFilterId],
  );

  const weekHasFilterMatches = useMemo(
    () =>
      classFilterId === ARES_CLASS_FILTER_ALL ||
      weekHasMatchingFilteredClasses(filteredClassCountByDay),
    [classFilterId, filteredClassCountByDay],
  );

  const scrollToClassList = useCallback(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({
        y: Math.max(0, listAnchorY.current - 8),
        animated: true,
      });
    });
  }, []);

  const handleSelectDay = useCallback(
    (dayKey: string) => {
      setSelectedDayKey(dayKey);
      scrollToClassList();
    },
    [scrollToClassList],
  );

  const handleSelectFilter = useCallback(
    (filterId: string) => {
      setClassFilterId(filterId);

      if (filterId === ARES_CLASS_FILTER_ALL) return;

      const currentDay = selectedDayKey ?? defaultDayKey;
      const currentDayMatches = filterMemberScheduleClasses(
        classes,
        timeZone,
        currentDay,
        weekBounds.startKey,
        weekBounds.endKey,
        filterId,
        matchesAresClassFilter,
      );

      if (currentDayMatches.length > 0) return;

      const nearestDay = findNearestDayWithMatchingClasses({
        selectedDayKey: currentDay,
        weekDayKeys,
        classes,
        timeZone,
        weekStartKey: weekBounds.startKey,
        weekEndKey: weekBounds.endKey,
        classFilterId: filterId,
        matchesFilter: matchesAresClassFilter,
      });

      if (!nearestDay) return;

      setSelectedDayKey(nearestDay);

      const filterLabel =
        ARES_CLASS_FILTERS.find((f) => f.id === filterId)?.label ?? filterId;
      AccessibilityInfo.announceForAccessibility(
        formatFilterAutoJumpAccessibilityMessage(
          filterLabel,
          nearestDay,
          todayKey,
          timeZone,
        ),
      );
      scrollToClassList();
    },
    [
      selectedDayKey,
      defaultDayKey,
      classes,
      timeZone,
      weekDayKeys,
      weekBounds.startKey,
      weekBounds.endKey,
      todayKey,
      scrollToClassList,
    ],
  );

  const dayHeading = useMemo(
    () => formatMemberDayHeading(activeDayKey, todayKey, timeZone),
    [activeDayKey, todayKey, timeZone],
  );

  const handleWeekChange = useCallback((next: number) => {
    setWeekOffset(next);
  }, []);

  const openClass = useCallback(
    (classId: string) => {
      router.push(`/(app)/class/${classId}`);
    },
    [router],
  );

  if (studioLoading) return <ScreenLoader />;
  if (error && classes.length === 0) {
    return <LoadRetryPanel message={error} onRetry={refresh} />;
  }

  const showSkeleton = scheduleLoading && classes.length === 0;
  const canGoPrev = weekOffset > 0;

  const emptyTitle =
    classFilterId === ARES_CLASS_FILTER_ALL
      ? 'No hay clases programadas para este día.'
      : !weekHasFilterMatches
        ? 'No hay clases de este tipo esta semana.'
        : 'No hay clases de este tipo este día.';
  const emptyBody =
    classFilterId === ARES_CLASS_FILTER_ALL ? 'Prueba otro día o cambia de semana.' : undefined;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['left', 'right', 'top']}>
      {showSkeleton ? (
        <ScheduleSkeleton />
      ) : (
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={{
            paddingHorizontal: Space.screenH,
            paddingBottom: TAB_BAR_CLEARANCE,
          }}
          refreshControl={
            <RefreshControl
              refreshing={scheduleLoading}
              onRefresh={() => void refresh()}
              tintColor="rgba(255,255,255,0.35)"
            />
          }
        >
          {/* 1. Page header */}
          <Text
            style={{
              fontSize: 40,
              fontWeight: '800',
              letterSpacing: -1.6,
              color: C.text,
              lineHeight: 44,
              paddingTop: 32,
              paddingBottom: 24,
            }}
          >
            Clases
          </Text>

          {/* 2. Week navigation */}
          <MemberWeekNavigator
            label={weekLabel}
            canGoPrev={canGoPrev}
            onPrev={() => canGoPrev && handleWeekChange(weekOffset - 1)}
            onNext={() => handleWeekChange(weekOffset + 1)}
          />

          {/* 3. Seven-day selector */}
          <MemberDaySelector
            weekDayKeys={weekDayKeys}
            selectedDayKey={activeDayKey}
            todayKey={todayKey}
            timeZone={timeZone}
            classCountByDay={unfilteredClassCountByDay}
            onSelectDay={handleSelectDay}
          />

          {error ? (
            <View style={{ marginBottom: 16 }}>
              <ErrorBanner message={error} onRetry={refresh} />
            </View>
          ) : null}

          {/* 4. Open Gym benefit */}
          <OpenGymBenefitCard compact delay={0} />

          {/* 5. Class filters */}
          <ScheduleFilterBar selectedId={classFilterId} onSelect={handleSelectFilter} />

          {/* 6. Selected date heading */}
          <View
            onLayout={(e) => {
              listAnchorY.current = e.nativeEvent.layout.y;
            }}
            style={{ paddingTop: 8, paddingBottom: 20 }}
          >
            <Text
              style={{
                fontSize: 22,
                fontWeight: '700',
                letterSpacing: -0.5,
                color: C.text,
                lineHeight: 28,
              }}
            >
              {dayHeading}
            </Text>
          </View>

          {/* 7. Class cards */}
          {dayClasses.length === 0 ? (
            <MemberScheduleEmptyState title={emptyTitle} body={emptyBody} />
          ) : (
            dayClasses.map((item, index) => {
              if (index === 0) {
                return (
                  <Animated.View
                    key={item.id}
                    entering={FadeInDown.duration(400)}
                    style={{ marginBottom: Space.cardGap }}
                  >
                    <FeaturedClassTile
                      item={item}
                      timeZone={timeZone}
                      accentColor="#FFFFFF"
                      imageUri={resolveScheduledClassImageUri(item.classTemplate, 'hero')}
                      height={228}
                      variant="member"
                      delay={0}
                      onPress={() => openClass(item.id)}
                    />
                  </Animated.View>
                );
              }

              return (
                <ClassCard
                  key={item.id}
                  item={item}
                  timeZone={timeZone}
                  accentColor="#FFFFFF"
                  imageUri={resolveScheduledClassImageUri(item.classTemplate, 'thumbnail')}
                  index={index}
                  showSpotsLabel
                  variant="member"
                  onPress={() => openClass(item.id)}
                />
              );
            })
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
