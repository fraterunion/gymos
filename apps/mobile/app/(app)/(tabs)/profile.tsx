import { Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BrandButton } from '@/components/BrandButton';
import { useAuth } from '@/contexts/AuthContext';
import { useBranding } from '@/contexts/BrandingContext';

export default function ProfileScreen() {
  const { user, logout, busy } = useAuth();
  const { primaryColor } = useBranding();

  return (
    <SafeAreaView className="flex-1 bg-neutral-50 dark:bg-neutral-950" edges={['bottom']}>
      <View className="flex-1 px-6 pt-4">
        {/* BUILD MARKER — remove after confirming new build renders */}
        <View style={{ backgroundColor: '#7C3AED', borderRadius: 8, paddingVertical: 6, paddingHorizontal: 12, marginBottom: 12 }}>
          <Text style={{ color: '#FFFFFF', fontSize: 11, fontWeight: '700', textAlign: 'center' }}>
            BUILD MARKER: PHASE19A-0e2ec91
          </Text>
        </View>
        <Text className="text-2xl font-semibold text-neutral-900 dark:text-neutral-50">Profile</Text>
        <View className="mt-8 rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
          <Text className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
            Account
          </Text>
          <Text className="mt-2 text-lg font-semibold text-neutral-900 dark:text-neutral-50">
            {user?.firstName} {user?.lastName}
          </Text>
          <Text className="mt-1 text-base text-neutral-600 dark:text-neutral-400">{user?.email}</Text>
        </View>

        <View className="mt-10">
          <BrandButton label="Log out" accentColor={primaryColor} loading={busy} onPress={() => void logout()} />
        </View>
      </View>
    </SafeAreaView>
  );
}
