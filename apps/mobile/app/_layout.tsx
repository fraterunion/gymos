import '../global.css';

import FontAwesome from '@expo/vector-icons/FontAwesome';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useMemo } from 'react';
import { useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import 'react-native-reanimated';

import SpaceMono from '../assets/fonts/SpaceMono-Regular.ttf';

import { BrandingBootGate } from '@/components/BrandingBootGate';
import { AuthProvider } from '@/contexts/AuthContext';
import { BrandingProvider, useBranding } from '@/contexts/BrandingContext';
import { SelectedStudioProvider } from '@/contexts/SelectedStudioContext';

export { ErrorBoundary } from 'expo-router';

// Build marker — proves which source snapshot the EAS build used.
// Remove after confirming Phase 19A renders in installed APK.
console.log('[BUILD] MARKER: PHASE19A-0e2ec91');
console.log('[BUILD] EXPO_PUBLIC_BUILD_MARKER:', process.env.EXPO_PUBLIC_BUILD_MARKER ?? '(not set)');

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [loaded, error] = useFonts({
    SpaceMono,
    ...FontAwesome.font,
  });

  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    if (loaded) {
      SplashScreen.hideAsync();
    }
  }, [loaded]);

  if (!loaded) {
    return null;
  }

  return (
    <SafeAreaProvider>
      <BrandingProvider>
        <AuthProvider>
          <SelectedStudioProvider>
            <RootLayoutNav />
          </SelectedStudioProvider>
        </AuthProvider>
      </BrandingProvider>
    </SafeAreaProvider>
  );
}

function RootLayoutNav() {
  const colorScheme = useColorScheme();
  const { primaryColor } = useBranding();

  const theme = useMemo(() => {
    const base = colorScheme === 'dark' ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        primary: primaryColor,
      },
    };
  }, [colorScheme, primaryColor]);

  return (
    <ThemeProvider value={theme}>
      <BrandingBootGate>
        <Stack screenOptions={{ headerShown: false, animation: 'fade' }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="(auth)" />
          <Stack.Screen name="(app)" />
        </Stack>
      </BrandingBootGate>
    </ThemeProvider>
  );
}
