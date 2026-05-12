import type { ReactNode } from 'react';
import { ActivityIndicator, Image, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useBranding } from '@/contexts/BrandingContext';

export function BrandingBootGate({ children }: { children: ReactNode }) {
  const { status, error, retry, logoUrl, appDisplayName, primaryColor } = useBranding();

  if (status === 'loading') {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-neutral-50 dark:bg-neutral-950">
        <View className="items-center px-10">
          {logoUrl ? (
            <Image
              accessibilityIgnoresInvertColors
              source={{ uri: logoUrl }}
              className="mb-8 h-20 w-48"
              resizeMode="contain"
            />
          ) : (
            <View
              className="mb-8 h-14 w-14 items-center justify-center rounded-2xl"
              style={{ backgroundColor: `${primaryColor}22` }}>
              <View className="h-8 w-8 rounded-lg" style={{ backgroundColor: primaryColor }} />
            </View>
          )}
          <Text className="mb-6 text-center text-lg font-semibold text-neutral-800 dark:text-neutral-100">
            {appDisplayName}
          </Text>
          <ActivityIndicator size="large" color={primaryColor} />
          <Text className="mt-4 text-center text-sm text-neutral-500 dark:text-neutral-400">Loading studio…</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (status === 'error') {
    return (
      <SafeAreaView className="flex-1 bg-neutral-50 dark:bg-neutral-950">
        <View className="flex-1 justify-center px-8">
          <Text className="mb-2 text-center text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
            Could not load studio
          </Text>
          <Text className="mb-10 text-center text-base leading-6 text-neutral-600 dark:text-neutral-400">
            {error?.message ??
              'Check your network connection and that EXPO_PUBLIC_API_URL and EXPO_PUBLIC_STUDIO_SLUG are correct.'}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => void retry()}
            className="items-center rounded-2xl bg-neutral-900 py-4 dark:bg-neutral-100">
            <Text className="text-base font-semibold text-white dark:text-neutral-900">Try again</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return <>{children}</>;
}
