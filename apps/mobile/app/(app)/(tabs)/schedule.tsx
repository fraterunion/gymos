import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { RefreshControl, SectionList, Text, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ClassCard } from '@/components/ClassCard';
import { EmptyHint, ErrorBanner, LoadRetryPanel, Skeleton, ScreenLoader } from '@/components/StudioScreenChrome';
import { useBranding } from '@/contexts/BrandingContext';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import { useStudioActivity } from '@/contexts/StudioActivityContext';
import { calendarDayKeyInZone, formatClassDateLabel, todayKeyInZone } from '@/lib/datetime';
import type { ScheduledClassDto } from '@/lib/types/studio';
import { getColors, Space } from '@/constants/Theme';

type Section = { title: string; isToday: boolean; data: ScheduledClassDto[] };

export default function ScheduleScreen() {
  const router = useRouter();
  const scheme = useColorScheme();
  const C = getColors(scheme);
  const { primaryColor } = useBranding();
  const matched = useMemberStudio().matched;
  const { classes, loading, error, refresh } = useStudioActivity();

  const timeZone = matched?.studio.timezone ?? 'UTC';
  const todayKey = useMemo(() => todayKeyInZone(timeZone), [timeZone]);

  const sections: Section[] = useMemo(() => {
    const now = Date.now();
    const fut = classes.filter(
      (c) => c.status === 'SCHEDULED' && new Date(c.startsAt).getTime() > now,
    );
    const map = new Map<string, ScheduledClassDto[]>();
    for (const c of fut) {
      const k = calendarDayKeyInZone(c.startsAt, timeZone);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(c);
    }
    const keys = [...map.keys()].sort();
    return keys.map((k) => {
      const first = map.get(k)![0]!;
      const title = k === todayKey ? 'Today' : formatClassDateLabel(first.startsAt, timeZone);
      return { title, isToday: k === todayKey, data: map.get(k)! };
    });
  }, [classes, timeZone, todayKey]);

  if (!matched) return <ScreenLoader />;
  if (error && classes.length === 0) return <LoadRetryPanel message={error} onRetry={refresh} />;

  const showSkeleton = loading && classes.length === 0;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['left', 'right']}>
      {showSkeleton ? (
        <View style={{ flex: 1, paddingHorizontal: Space.screenH, paddingTop: 28 }}>
          <Skeleton width="40%" height={11} radius={4} style={{ marginBottom: 20 }} />
          <Skeleton height={82} radius={16} style={{ marginBottom: Space.cardGap }} />
          <Skeleton height={82} radius={16} style={{ marginBottom: Space.cardGap }} />
          <Skeleton height={82} radius={16} style={{ marginBottom: Space.cardGap }} />
          <Skeleton width="30%" height={11} radius={4} style={{ marginBottom: 20, marginTop: 28 }} />
          <Skeleton height={82} radius={16} style={{ marginBottom: Space.cardGap }} />
          <Skeleton height={82} radius={16} />
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingHorizontal: Space.screenH, paddingBottom: 48 }}
          stickySectionHeadersEnabled={false}
          refreshControl={
            <RefreshControl
              refreshing={loading}
              onRefresh={() => void refresh()}
              tintColor={primaryColor}
            />
          }
          ListHeaderComponent={
            error ? (
              <View style={{ paddingTop: 8 }}>
                <ErrorBanner message={error} onRetry={refresh} />
              </View>
            ) : null
          }
          ListEmptyComponent={
            <View style={{ marginTop: 60 }}>
              <EmptyHint
                title="Your schedule is clear"
                body="When the studio publishes classes, they'll appear here."
              />
            </View>
          }
          renderSectionHeader={({ section }) => (
            <View style={{ paddingTop: 32, paddingBottom: 12 }}>
              <Text
                style={{
                  fontSize: 11,
                  fontWeight: '600',
                  letterSpacing: 0.8,
                  textTransform: 'uppercase',
                  color: section.isToday ? primaryColor : C.textMute,
                }}
              >
                {section.title}
              </Text>
            </View>
          )}
          renderItem={({ item, index }) => (
            <ClassCard
              item={item}
              timeZone={timeZone}
              accentColor={item.classTemplate.color ?? primaryColor}
              index={index}
              onPress={() => router.push(`/(app)/class/${item.id}`)}
            />
          )}
        />
      )}
    </SafeAreaView>
  );
}
