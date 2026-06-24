import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, RefreshControl, SectionList, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ClassCard } from '@/components/ClassCard';
import { FeaturedClassTile } from '@/components/FeaturedClassTile';
import { TAB_BAR_CLEARANCE } from '@/components/FloatingTabBar';
import { resolveScheduledClassImageUri } from '@/lib/imagery';
import {
  EmptyHint,
  ErrorBanner,
  LoadRetryPanel,
  Skeleton,
  ScreenLoader,
} from '@/components/StudioScreenChrome';
import { useBranding } from '@/contexts/BrandingContext';
import { usePublicSchedule } from '@/contexts/PublicScheduleContext';
import { usePublicStudio } from '@/contexts/PublicStudioContext';
import {
  calendarDayKeyInZone,
  formatClassDateLabel,
  todayKeyInZone,
  weekBoundsInZone,
} from '@/lib/datetime';
import type { ScheduledClassDto } from '@/lib/types/studio';
import { getColors, Space } from '@/constants/Theme';

type Section = {
  key: string;
  title: string;
  isToday: boolean;
  data: ScheduledClassDto[];
};

// ---------------------------------------------------------------------------
// Editorial day header — large weekday anchors each section
// ---------------------------------------------------------------------------

function DayHeader({
  title,
  isToday,
  accentColor,
}: {
  title: string;
  isToday: boolean;
  accentColor: string;
}) {
  const C = getColors();

  if (isToday) {
    return (
      <View style={{ paddingTop: 36, paddingBottom: 18 }}>
        <Text
          style={{
            fontSize: 30,
            fontWeight: '800',
            letterSpacing: -0.8,
            color: C.text,
            lineHeight: 34,
          }}
        >
          Hoy
        </Text>
      </View>
    );
  }

  // Split "Mon, May 12" → "MON" headline + "May 12" subtitle
  let headline = title;
  let subtitle: string | null = null;
  if (title.includes(',')) {
    const comma = title.indexOf(',');
    headline = title.slice(0, comma).toUpperCase();
    subtitle = title.slice(comma + 1).trim();
  }

  return (
    <View style={{ paddingTop: 40, paddingBottom: 16 }}>
      <Text
        style={{
          fontSize: 26,
          fontWeight: '800',
          letterSpacing: -0.6,
          color: C.text,
          lineHeight: 30,
        }}
      >
        {headline}
      </Text>
      {subtitle ? (
        <Text
          style={{
            fontSize: 13,
            color: C.textMute,
            marginTop: 3,
            letterSpacing: 0.1,
          }}
        >
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Week navigation
// ---------------------------------------------------------------------------

function WeekNavigator({
  label,
  weekOffset,
  onChange,
  accentColor,
}: {
  label: string;
  weekOffset: number;
  onChange: (next: number) => void;
  accentColor: string;
}) {
  const C = getColors();
  const canGoPrev = weekOffset > 0;

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
        accessibilityLabel="Semana anterior"
        onPress={() => canGoPrev && onChange(weekOffset - 1)}
        disabled={!canGoPrev}
        hitSlop={10}
        style={{ opacity: canGoPrev ? 1 : 0.35, minWidth: 72 }}
      >
        <Text style={{ fontSize: 14, fontWeight: '600', color: C.text }}>← Anterior</Text>
      </Pressable>

      <View style={{ flex: 1, alignItems: 'center' }}>
        <Text
          style={{
            fontSize: 12,
            fontWeight: '700',
            letterSpacing: 0.6,
            textTransform: 'uppercase',
            color: weekOffset === 0 ? accentColor : C.textMute,
          }}
        >
          {weekOffset === 0 ? 'Esta semana' : 'Semana'}
        </Text>
        <Text
          style={{
            fontSize: 13,
            color: C.textSub,
            marginTop: 4,
            letterSpacing: -0.1,
            textAlign: 'center',
          }}
        >
          {label}
        </Text>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Siguiente semana"
        onPress={() => onChange(weekOffset + 1)}
        hitSlop={10}
        style={{ minWidth: 72, alignItems: 'flex-end' }}
      >
        <Text style={{ fontSize: 14, fontWeight: '600', color: C.text }}>Siguiente →</Text>
      </Pressable>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function ScheduleScreen() {
  const router = useRouter();
  const C = getColors();
  const { primaryColor } = useBranding();
  const { timezone, loading: studioLoading } = usePublicStudio();
  const { classes, loading: scheduleLoading, error, refresh } = usePublicSchedule();
  const [weekOffset, setWeekOffset] = useState(0);

  const timeZone = timezone;
  const todayKey = useMemo(() => todayKeyInZone(timeZone), [timeZone]);
  const weekBounds = useMemo(
    () => weekBoundsInZone(timeZone, weekOffset),
    [timeZone, weekOffset],
  );

  const sections: Section[] = useMemo(() => {
    const now = Date.now();
    const fut = classes.filter(
      (c) =>
        c.status === 'SCHEDULED' &&
        new Date(c.startsAt).getTime() > now,
    );
    const map = new Map<string, ScheduledClassDto[]>();
    for (const c of fut) {
      const k = calendarDayKeyInZone(c.startsAt, timeZone);
      if (k < weekBounds.startKey || k > weekBounds.endKey) continue;
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(c);
    }
    const keys = [...map.keys()].sort();
    return keys.map((k) => {
      const first = map.get(k)![0]!;
      return {
        key: k,
        title: k === todayKey ? 'Hoy' : formatClassDateLabel(first.startsAt, timeZone),
        isToday: k === todayKey,
        data: map.get(k)!,
      };
    });
  }, [classes, timeZone, todayKey, weekBounds.startKey, weekBounds.endKey]);

  if (studioLoading) return <ScreenLoader />;
  if (error && classes.length === 0) return <LoadRetryPanel message={error} onRetry={refresh} />;

  const showSkeleton = scheduleLoading && classes.length === 0;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['left', 'right', 'top']}>
      {showSkeleton ? (
        <View style={{ flex: 1, paddingHorizontal: Space.screenH, paddingTop: 36 }}>
          <Skeleton width="30%" height={28} radius={6} style={{ marginBottom: 20 }} />
          <Skeleton height={240} radius={20} style={{ marginBottom: Space.cardGap }} />
          <Skeleton height={106} radius={16} style={{ marginBottom: Space.cardGap }} />
          <Skeleton height={106} radius={16} style={{ marginBottom: Space.cardGap }} />
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={{
            paddingHorizontal: Space.screenH,
            paddingBottom: TAB_BAR_CLEARANCE,
          }}
          refreshControl={
            <RefreshControl
              refreshing={scheduleLoading}
              onRefresh={() => void refresh()}
              tintColor={primaryColor}
            />
          }
          ListHeaderComponent={
            <>
              <WeekNavigator
                label={weekBounds.label}
                weekOffset={weekOffset}
                onChange={setWeekOffset}
                accentColor={primaryColor}
              />
              {error ? (
                <View style={{ paddingTop: 8 }}>
                  <ErrorBanner message={error} onRetry={refresh} />
                </View>
              ) : null}
            </>
          }
          ListEmptyComponent={
            <View style={{ marginTop: 80 }}>
              <EmptyHint
                title="Próximamente habrá clases."
                body="Estamos preparando el horario. Vuelve pronto."
              />
            </View>
          }
          renderSectionHeader={({ section }) => (
            <DayHeader
              title={section.title}
              isToday={section.isToday}
              accentColor={primaryColor}
            />
          )}
          renderItem={({ item, index, section }) => {
            // First class of each day gets the editorial FeaturedClassTile treatment.
            // Subsequent classes in the same day use the compact ClassCard.
            if (index === 0) {
              return (
                <FeaturedClassTile
                  item={item}
                  timeZone={timeZone}
                  accentColor={item.classTemplate.color ?? primaryColor}
                  imageUri={resolveScheduledClassImageUri(item.classTemplate, 'hero')}
                  height={section.isToday ? 240 : 210}
                  label={section.isToday ? 'Hoy' : undefined}
                  delay={0}
                  onPress={() => router.push(`/(app)/class/${item.id}`)}
                />
              );
            }
            return (
              <View style={{ marginTop: Space.cardGap }}>
                <ClassCard
                  item={item}
                  timeZone={timeZone}
                  accentColor={item.classTemplate.color ?? primaryColor}
                  imageUri={resolveScheduledClassImageUri(item.classTemplate, 'thumbnail')}
                  index={index}
                  onPress={() => router.push(`/(app)/class/${item.id}`)}
                />
              </View>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}
