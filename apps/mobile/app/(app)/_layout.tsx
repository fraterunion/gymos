import { useEffect } from 'react';
import { ActivityIndicator, Text, useColorScheme, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';

import { BrandButton } from '@/components/BrandButton';
import { MembershipRequiredScreen } from '@/components/MembershipRequiredScreen';
import { ScreenLoader } from '@/components/StudioScreenChrome';
import { useAuth } from '@/contexts/AuthContext';
import { useBranding } from '@/contexts/BrandingContext';
import { MemberStudioProvider, useMemberStudio } from '@/contexts/MemberStudioContext';
import { StudioActivityProvider } from '@/contexts/StudioActivityContext';

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

  return (
    <MemberStudioProvider>
      <MemberShell />
    </MemberStudioProvider>
  );
}

function MemberShell() {
  const colorScheme = useColorScheme();
  const headerBg = colorScheme === 'dark' ? '#0a0a0a' : '#fafafa';
  const { primaryColor } = useBranding();
  const ms = useMemberStudio();

  if (ms.status === 'loading') {
    return <ScreenLoader />;
  }

  if (ms.status === 'error') {
    return (
      <View className="flex-1 justify-center bg-neutral-50 px-8 dark:bg-neutral-950">
        <Text className="text-center text-base leading-6 text-neutral-600 dark:text-neutral-400">
          {ms.error ?? 'Could not verify studio access.'}
        </Text>
        <View className="mt-8">
          <BrandButton label="Try again" accentColor={primaryColor} onPress={() => void ms.refetch()} />
        </View>
      </View>
    );
  }

  if (!ms.matched) {
    return <MembershipRequiredScreen onRetry={() => void ms.refetch()} />;
  }

  return (
    <StudioActivityProvider studioId={ms.matched.studio.id}>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: headerBg },
        }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen
          name="class/[classId]"
          options={{
            headerShown: true,
            title: 'Class',
            headerShadowVisible: false,
            headerStyle: { backgroundColor: headerBg },
            headerTintColor: colorScheme === 'dark' ? '#fafafa' : '#171717',
            headerBackTitle: 'Back',
          }}
        />
        <Stack.Screen
          name="check-in/[bookingId]"
          options={{
            headerShown: true,
            title: 'Check-in',
            headerShadowVisible: false,
            headerStyle: { backgroundColor: headerBg },
            headerTintColor: colorScheme === 'dark' ? '#fafafa' : '#171717',
            headerBackTitle: 'Back',
          }}
        />
        <Stack.Screen
          name="billing"
          options={{
            headerShown: false,
          }}
        />
      </Stack>
    </StudioActivityProvider>
  );
}
