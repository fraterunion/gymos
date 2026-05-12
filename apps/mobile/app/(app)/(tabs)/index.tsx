import { Text, View } from 'react-native';

import { useSelectedStudio } from '@/contexts/SelectedStudioContext';

export default function HomePlaceholder() {
  const studio = useSelectedStudio();

  return (
    <View className="flex-1 justify-center bg-neutral-50 px-8 dark:bg-neutral-950">
      <Text className="text-2xl font-semibold text-neutral-900 dark:text-neutral-50">Home</Text>
      <Text className="mt-3 text-base leading-6 text-neutral-600 dark:text-neutral-400">
        Signed in to <Text className="font-medium text-neutral-800 dark:text-neutral-200">{studio.displayName}</Text>.
        Class schedule and bookings will appear here in a later phase.
      </Text>
    </View>
  );
}
