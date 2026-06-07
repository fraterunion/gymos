import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useRouter } from 'expo-router';

import { useAuth } from '@/contexts/AuthContext';
import { useBranding } from '@/contexts/BrandingContext';

export default function BootScreen() {
  const router = useRouter();
  const { status } = useBranding();
  const { hydrated } = useAuth();

  useEffect(() => {
    if (status !== 'ready' || !hydrated) return;
    router.replace('/(app)/(tabs)');
  }, [status, hydrated, router]);

  return (
    <View className="flex-1 items-center justify-center bg-neutral-50 dark:bg-neutral-950">
      <ActivityIndicator />
    </View>
  );
}
