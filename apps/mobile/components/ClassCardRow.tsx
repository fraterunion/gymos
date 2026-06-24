import { Pressable, Text, View } from 'react-native';

import type { ScheduledClassDto } from '@/lib/types/studio';
import { formatClassRange } from '@/lib/datetime';

type Props = {
  item: ScheduledClassDto;
  timeZone: string;
  accentColor: string;
  onPress: () => void;
};

export function ClassCardRow({ item, timeZone, accentColor, onPress }: Props) {
  const ins = item.instructor
    ? `${item.instructor.firstName} ${item.instructor.lastName}`.trim()
    : null;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      className="mb-3 overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <View className="flex-row">
        <View className="w-1" style={{ backgroundColor: accentColor }} />
        <View className="flex-1 px-4 py-3.5">
          <Text className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
            {item.classTemplate.name}
          </Text>
          <Text className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            {formatClassRange(item.startsAt, item.endsAt, timeZone)}
          </Text>
          {ins ? (
            <Text className="mt-1 text-sm text-neutral-600 dark:text-neutral-300">{ins}</Text>
          ) : null}
          <Text className="mt-2 text-xs font-medium uppercase tracking-wide text-neutral-400">
            Capacidad {item.capacity}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}
