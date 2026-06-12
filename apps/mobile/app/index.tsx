import { useEffect } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { BrandWordmark } from '@/components/BrandWordmark';
import { useAuth } from '@/contexts/AuthContext';
import { useBranding } from '@/contexts/BrandingContext';

export default function BootScreen() {
  const router = useRouter();
  const { status, logoUrl } = useBranding();
  const { hydrated } = useAuth();

  useEffect(() => {
    if (status !== 'ready' || !hydrated) return;
    router.replace('/(app)/(tabs)');
  }, [status, hydrated, router]);

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: '#0A0A0A',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 40,
      }}
    >
      <BrandWordmark logoUrl={logoUrl} />
      <ActivityIndicator color="rgba(255,255,255,0.4)" style={{ marginTop: 40 }} />
      <Text
        style={{
          marginTop: 18,
          fontSize: 12,
          letterSpacing: 0.6,
          color: 'rgba(255,255,255,0.30)',
          textAlign: 'center',
        }}
      >
        Loading your training experience...
      </Text>
    </View>
  );
}
