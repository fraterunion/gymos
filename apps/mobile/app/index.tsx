import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useRouter } from 'expo-router';

import { useAuth } from '@/contexts/AuthContext';
import { useBranding } from '@/contexts/BrandingContext';

export default function BootScreen() {
  const router = useRouter();
  const { status } = useBranding();
  const { user, hydrated } = useAuth();

  useEffect(() => {
    if (status !== 'ready' || !hydrated) return;
    if (user) {
      router.replace('/(app)/(tabs)');
    } else {
      router.replace('/(auth)/login');
    }
  }, [status, hydrated, user, router]);

  return (
    <View className="flex-1 items-center justify-center bg-neutral-50 dark:bg-neutral-950">
      <ActivityIndicator />
    </View>
  );
}
