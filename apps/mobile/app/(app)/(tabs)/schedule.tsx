import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { RefreshControl, SectionList, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ClassCardRow } from '@/components/ClassCardRow';
import {
  EmptyHint,
  ErrorBanner,
  LoadRetryPanel,
  SkeletonBlock,
  ScreenLoader,
} from '@/components/StudioScreenChrome';
import { useBranding } from '@/contexts/BrandingContext';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import { useStudioActivity } from '@/contexts/StudioActivityContext';
import { calendarDayKeyInZone, formatClassDateLabel, todayKeyInZone } from '@/lib/datetime';
import type { ScheduledClassDto } from '@/lib/types/studio';

type Section = { title: string; data: ScheduledClassDto[] };

export default function ScheduleScreen() {
  const router = useRouter();
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
      return { title, data: map.get(k)! };
    });
  }, [classes, timeZone, todayKey]);

  if (!matched) {
    return <ScreenLoader />;
  }

  if (error && classes.length === 0) {
    return <LoadRetryPanel message={error} onRetry={refresh} />;
  }

  const showSkeleton = loading && classes.length === 0;

  return (
    <SafeAreaView className="flex-1 bg-neutral-50 dark:bg-neutral-950" edges={['left', 'right']}>
      {showSkeleton ? (
        <View className="flex-1 px-5 pt-4">
          <SkeletonBlock className="h-10 w-1/2" />
          <SkeletonBlock className="mt-6" />
          <SkeletonBlock />
          <SkeletonBlock />
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          contentContainerClassName="px-5 pb-12"
          stickySectionHeadersEnabled={false}
          refreshControl={
            <RefreshControl refreshing={loading} onRefresh={() => void refresh()} tintColor={primaryColor} />
          }
          ListHeaderComponent={
            error ? (
              <View className="pt-2">
                <ErrorBanner message={error} onRetry={refresh} />
              </View>
            ) : null
          }
          ListEmptyComponent={
            <View className="mt-10">
              <EmptyHint
                title="Nothing scheduled yet"
                body="When your studio publishes classes, they will appear here."
              />
            </View>
          }
          renderSectionHeader={({ section }) => (
            <Text className="pb-2 pt-6 text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
              {section.title}
            </Text>
          )}
          renderItem={({ item }) => (
            <ClassCardRow
              item={item}
              timeZone={timeZone}
              accentColor={item.classTemplate.color ?? primaryColor}
              onPress={() => router.push(`/(app)/class/${item.id}`)}
            />
          )}
        />
      )}
    </SafeAreaView>
  );
}
