import '../global.css';

import FontAwesome from '@expo/vector-icons/FontAwesome';
import { DarkTheme, ThemeProvider } from '@react-navigation/native';
import { StripeProvider } from '@/lib/stripe';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router/stack';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useMemo } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import SpaceMono from '../assets/fonts/SpaceMono-Regular.ttf';

import { BrandingBootGate } from '@/components/BrandingBootGate';
import { AuthProvider } from '@/contexts/AuthContext';
import { BrandingProvider, useBranding } from '@/contexts/BrandingContext';
import { PublicStudioProvider } from '@/contexts/PublicStudioContext';
import { SelectedStudioProvider } from '@/contexts/SelectedStudioContext';

export { ErrorBoundary } from 'expo-router';

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
      <StripeProvider publishableKey={process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? ''}>
        <BrandingProvider>
          <PublicStudioProvider>
            <AuthProvider>
              <SelectedStudioProvider>
                <RootLayoutNav />
              </SelectedStudioProvider>
            </AuthProvider>
          </PublicStudioProvider>
        </BrandingProvider>
      </StripeProvider>
    </SafeAreaProvider>
  );
}

function RootLayoutNav() {
  const { primaryColor } = useBranding();

  const theme = useMemo(
    () => ({
      ...DarkTheme,
      colors: {
        ...DarkTheme.colors,
        primary: '#FFFFFF',
        background: '#0A0A0A',
        card: '#0A0A0A',
        text: '#FFFFFF',
        border: 'rgba(255,255,255,0.07)',
        notification: primaryColor,
      },
    }),
    [primaryColor],
  );

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
