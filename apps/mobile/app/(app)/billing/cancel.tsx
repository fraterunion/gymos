import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useRouter } from 'expo-router';
import { Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BrandButton } from '@/components/BrandButton';
import { useBranding } from '@/contexts/BrandingContext';

export default function BillingCheckoutCancelScreen() {
  const router = useRouter();
  const { primaryColor, appDisplayName } = useBranding();

  return (
    <SafeAreaView className="flex-1 bg-neutral-50 px-5 dark:bg-neutral-950" edges={['bottom', 'left', 'right']}>
      <View className="flex-1 justify-center pb-8">
        <View
          className="mb-6 self-center rounded-full p-5"
          style={{ backgroundColor: `${primaryColor}18` }}>
          <FontAwesome name="times-circle" size={36} color={primaryColor} />
        </View>
        <Text className="text-center text-2xl font-semibold text-neutral-900 dark:text-neutral-50">
          Pago cancelado
        </Text>
        <Text className="mt-4 text-center text-base leading-6 text-neutral-600 dark:text-neutral-400">
          No se hicieron cambios en tu membresía. Puedes elegir un plan de nuevo en cualquier momento desde Membresía en {appDisplayName}.
        </Text>
        <View className="mt-10">
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
