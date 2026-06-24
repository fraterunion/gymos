import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BrandButton } from '@/components/BrandButton';
import { useBranding } from '@/contexts/BrandingContext';
import { useBillingReturnRefresh } from '@/lib/billing/useBillingReturnRefresh';
import type { MyMemberProfileDto } from '@/lib/api/membershipApi';

export default function BillingCheckoutSuccessScreen() {
  const router = useRouter();
  const { primaryColor, appDisplayName } = useBranding();
  const { refreshAll, studioId } = useBillingReturnRefresh();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<MyMemberProfileDto | null>(null);

  const run = useCallback(async () => {
    if (!studioId) {
      setBusy(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { profile: p } = await refreshAll();
      setProfile(p);
    } catch {
      setError('No pudimos actualizar tu cuenta. Puedes abrir Membresía y deslizar hacia abajo para actualizar.');
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
        <View
          className="mb-6 self-center rounded-full p-5"
          style={{ backgroundColor: `${primaryColor}22` }}>
          {busy ? (
            <ActivityIndicator size="large" color={primaryColor} />
          ) : (
            <FontAwesome name="clock-o" size={36} color={primaryColor} />
          )}
        </View>
        <Text className="text-center text-2xl font-semibold text-neutral-900 dark:text-neutral-50">
          Confirmando tu membresía
        </Text>
        {busy ? (
          <Text className="mt-4 text-center text-base leading-6 text-neutral-600 dark:text-neutral-400">
            Estamos confirmando tu pago. En un momento podrás reservar clases.
          </Text>
        ) : (
          <>
            <Text className="mt-4 text-center text-base leading-6 text-neutral-600 dark:text-neutral-400">
              Recibimos tu pago. Tu membresía se activa cuando tu proveedor de pagos confirma la transacción — normalmente en unos momentos.
            </Text>
            {!error && profile?.activeSubscription ? (
              <Text className="mt-4 text-center text-base font-medium text-emerald-700 dark:text-emerald-400">
                Tu membresía está activa. Ya puedes reservar clases y acceder al gimnasio.
              </Text>
            ) : !error ? (
              <Text className="mt-4 text-center text-base text-neutral-600 dark:text-neutral-400">
                Si tu membresía aún no aparece, espera un momento y desliza hacia abajo para actualizar en la pestaña Membresía.
              </Text>
            ) : null}
            {error ? (
              <Text className="mt-4 text-center text-sm text-red-600 dark:text-red-400">{error}</Text>
            ) : null}
          </>
        )}
        <View className="mt-10 gap-3">
          <BrandButton
            label="Volver a membresía"
            accentColor={primaryColor}
            onPress={() => router.replace('/(app)/(tabs)/membership')}
          />
        </View>
      </View>
    </SafeAreaView>
  );
}
