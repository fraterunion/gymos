import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useRouter } from 'expo-router';
import { Text, View } from 'react-native';

import { BrandButton } from '@/components/BrandButton';

type Props = {
  accentColor: string;
  appDisplayName: string;
};

export function SubscriptionRequiredPanel({ accentColor, appDisplayName }: Props) {
  const router = useRouter();

  return (
    <View className="mt-8 overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-900">
      <View className="items-center px-5 pb-6 pt-8">
        <View
          className="mb-4 h-14 w-14 items-center justify-center rounded-full"
          style={{ backgroundColor: `${accentColor}22` }}>
          <FontAwesome name="lock" size={26} color={accentColor} />
        </View>
        <Text className="text-center text-xl font-semibold text-neutral-900 dark:text-neutral-50">
          Choose a membership to book
        </Text>
        <Text className="mt-3 text-center text-base leading-6 text-neutral-600 dark:text-neutral-400">
          {appDisplayName} uses memberships to keep class sizes fair and your benefits clear. Pick a plan below, finish
          checkout in your browser, then come back here—your schedule unlocks as soon as the studio confirms your
          membership.
        </Text>
        <View className="mt-8 w-full gap-3">
          <BrandButton
            label="View membership"
            accentColor={accentColor}
            onPress={() => router.push('/(app)/(tabs)/membership')}
          />
        </View>
      </View>
    </View>
  );
}
