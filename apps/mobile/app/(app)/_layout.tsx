import { ActivityIndicator, Text, View } from 'react-native';
import { Stack } from 'expo-router/stack';

import { BrandButton } from '@/components/BrandButton';
import { MembershipRequiredScreen } from '@/components/MembershipRequiredScreen';
import { ScreenLoader } from '@/components/StudioScreenChrome';
import { WaiverGate } from '@/components/WaiverGate';
import { useAuth } from '@/contexts/AuthContext';
import { useBranding } from '@/contexts/BrandingContext';
import { MemberStudioProvider, useMemberStudio } from '@/contexts/MemberStudioContext';
import { StudioActivityProvider } from '@/contexts/StudioActivityContext';
import { getStudioSlug } from '@/lib/env';
import { isStaffRole } from '@/lib/staffRole';

export default function AppGroupLayout() {
  const { hydrated } = useAuth();

  // Wait for auth hydration so MemberStudioContext starts with the correct user state.
  // Guests (user === null after hydration) enter the app shell in discovery mode.
  if (!hydrated) {
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
  const headerBg = '#0A0A0A';
  const { user } = useAuth();
  const { primaryColor } = useBranding();
  const ms = useMemberStudio();

  if (ms.status === 'loading') {
    return <ScreenLoader />;
  }

  if (ms.status === 'error') {
    return (
      <View style={{ flex: 1, justifyContent: 'center', backgroundColor: '#0A0A0A', paddingHorizontal: 32 }}>
        <Text style={{ textAlign: 'center', fontSize: 15, lineHeight: 22, color: 'rgba(255,255,255,0.50)', marginBottom: 32 }}>
          {ms.error ?? 'No pudimos verificar tu acceso al estudio.'}
        </Text>
        <BrandButton label="Reintentar" accentColor={primaryColor} onPress={() => void ms.refetch()} />
      </View>
    );
  }

  // Authenticated users who are not a member of this studio see the membership prompt.
  // Guests (user === null) skip this and enter discovery mode.
  if (user && !ms.matched) {
    return <MembershipRequiredScreen onRetry={() => void ms.refetch()} />;
  }

  // Staff, front desk, instructor, admin, and owner accounts get the staff shell instead of member tabs.
  // Computed only after ms.status === 'ready' (gated above), so there is no flicker.
  const staff = isStaffRole(ms.matched?.role);
  const studioSlug = getStudioSlug() ?? ms.matched?.studio.slug ?? '';
  const memberNeedsWaiver = Boolean(user && ms.matched?.role === 'MEMBER' && studioSlug);

  const appShell = (
    <StudioActivityProvider studioId={ms.matched?.studio.id ?? ''}>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: headerBg },
        }}>
        {/* Protected guards: navigation to a blocked group falls back to the
            first allowed route, so boot's replace('/(app)/(tabs)') lands staff
            users in the staff shell automatically. */}
        <Stack.Protected guard={staff}>
          <Stack.Screen name="(staff-tabs)" />
        </Stack.Protected>
        <Stack.Protected guard={!staff}>
          <Stack.Screen name="(tabs)" />
        </Stack.Protected>
        <Stack.Screen
          name="class/[classId]"
          options={{
            headerShown: true,
            title: 'Clase',
            headerShadowVisible: false,
            headerStyle: { backgroundColor: headerBg },
            headerTintColor: '#FAFAFA',
            headerBackTitle: 'Atrás',
          }}
        />
        <Stack.Screen
          name="progress"
          options={{
            headerShown: true,
            title: 'Progreso',
            headerShadowVisible: false,
            headerStyle: { backgroundColor: headerBg },
            headerTintColor: '#FAFAFA',
            headerBackTitle: 'Atrás',
          }}
        />
        <Stack.Screen
          name="check-in/[bookingId]"
          options={{
            headerShown: true,
            title: 'Check-in',
            headerShadowVisible: false,
            headerStyle: { backgroundColor: headerBg },
            headerTintColor: '#FAFAFA',
            headerBackTitle: 'Atrás',
          }}
        />
        <Stack.Screen
          name="staff-scan-result"
          options={{
            headerShown: true,
            title: 'Resultado del check-in',
            headerShadowVisible: false,
            headerStyle: { backgroundColor: headerBg },
            headerTintColor: '#FAFAFA',
            headerBackTitle: 'Atrás',
          }}
        />
        <Stack.Screen
          name="staff-class-roster"
          options={{
            headerShown: true,
            title: 'Lista de clase',
            headerShadowVisible: false,
            headerStyle: { backgroundColor: headerBg },
            headerTintColor: '#FAFAFA',
            headerBackTitle: 'Atrás',
          }}
        />
        <Stack.Screen
          name="staff-member/add"
          options={{
            headerShown: true,
            title: 'Agregar staff',
            headerShadowVisible: false,
            headerStyle: { backgroundColor: headerBg },
            headerTintColor: '#FAFAFA',
            headerBackTitle: 'Atrás',
          }}
        />
        <Stack.Screen
          name="staff-member/[userId]"
          options={{
            headerShown: true,
            title: 'Miembro del equipo',
            headerShadowVisible: false,
            headerStyle: { backgroundColor: headerBg },
            headerTintColor: '#FAFAFA',
            headerBackTitle: 'Atrás',
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

  if (memberNeedsWaiver && ms.matched) {
    return (
      <WaiverGate studioId={ms.matched.studio.id} studioSlug={studioSlug}>
        {appShell}
      </WaiverGate>
    );
  }

  return appShell;
}
