import { useEffect } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { useAuth } from '@/contexts/AuthContext';
import { useBranding } from '@/contexts/BrandingContext';

export default function BootScreen() {
  const router = useRouter();
  const { status } = useBranding();
  const { hydrated } = useAuth();

  useEffect(() => {
    if (status !== 'ready' || !hydrated) return;
    router.replace('/(app)/(tabs)');
  }, [status, hydrated, router]);

  return (
    <View style={{ flex: 1, backgroundColor: '#0A0A0A', alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator color="rgba(255,255,255,0.35)" />
      <Text
        style={{
          marginTop: 20,
          fontSize: 12,
          letterSpacing: 0.6,
          color: 'rgba(255,255,255,0.22)',
          textTransform: 'uppercase',
        }}
      >
        Preparing your club experience…
      </Text>
    </View>
  );
}
