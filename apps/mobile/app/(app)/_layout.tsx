import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';

import { useAuth } from '@/contexts/AuthContext';

export default function AppGroupLayout() {
  const router = useRouter();
  const { user, hydrated } = useAuth();

  useEffect(() => {
    if (!hydrated) return;
    if (!user) {
      router.replace('/(auth)/login');
    }
  }, [hydrated, user, router]);

  if (!hydrated || !user) {
    return (
      <View className="flex-1 items-center justify-center bg-neutral-50 dark:bg-neutral-950">
        <ActivityIndicator />
      </View>
    );
  }

  return <Stack screenOptions={{ headerShown: false }} />;
}
