import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BrandButton } from '@/components/BrandButton';
import { useBranding } from '@/contexts/BrandingContext';
import { useBillingReturnRefresh } from '@/lib/billing/useBillingReturnRefresh';

export default function BillingPortalReturnScreen() {
  const router = useRouter();
  const { primaryColor, appDisplayName } = useBranding();
  const { refreshAll, studioId } = useBillingReturnRefresh();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    if (!studioId) {
      setBusy(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await refreshAll();
    } catch {
      setError('Could not refresh. Open Membership and pull to refresh.');
    } finally {
      setBusy(false);
    }
  }, [studioId, refreshAll]);

  useFocusEffect(
    useCallback(() => {
      void run();
    }, [run]),
  );

  return (
    <SafeAreaView className="flex-1 bg-neutral-50 px-5 dark:bg-neutral-950" edges={['bottom', 'left', 'right']}>
      <View className="flex-1 justify-center pb-8">
        {busy ? (
          <View className="items-center py-12">
            <ActivityIndicator size="large" color={primaryColor} />
            <Text className="mt-6 text-center text-base text-neutral-600 dark:text-neutral-400">
              Syncing your account…
            </Text>
          </View>
        ) : (
          <>
            <View
              className="mb-6 self-center rounded-full p-5"
              style={{ backgroundColor: `${primaryColor}22` }}>
              <FontAwesome name="check-circle" size={36} color={primaryColor} />
            </View>
            <Text className="text-center text-2xl font-semibold text-neutral-900 dark:text-neutral-50">
              Welcome back
            </Text>
            <Text className="mt-4 text-center text-base leading-6 text-neutral-600 dark:text-neutral-400">
              Your billing session in {appDisplayName} is closed. Schedule and bookings below reflect the latest data we
              have from the server.
            </Text>
            {error ? (
              <Text className="mt-4 text-center text-sm text-red-600 dark:text-red-400">{error}</Text>
            ) : null}
          </>
        )}
        <View className="mt-10">
          <BrandButton
            label="Back to membership"
            accentColor={primaryColor}
            onPress={() => router.replace('/(app)/(tabs)/membership')}
          />
        </View>
      </View>
    </SafeAreaView>
  );
}
