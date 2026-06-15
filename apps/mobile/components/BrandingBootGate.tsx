import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PremiumBootScreen } from '@/components/PremiumBootScreen';
import { useBranding } from '@/contexts/BrandingContext';

export function BrandingBootGate({ children }: { children: ReactNode }) {
  const { status, error, retry, logoUrl } = useBranding();

  if (status === 'loading') {
    return <PremiumBootScreen logoUrl={logoUrl} />;
  }

  if (status === 'error') {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: '#000000' }}>
        <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 32 }}>
          <Text
            style={{
              marginBottom: 10,
              textAlign: 'center',
              fontSize: 24,
              fontWeight: '700',
              letterSpacing: -0.5,
              color: '#FFFFFF',
            }}
          >
            Unable to connect
          </Text>
          <Text
            style={{
              marginBottom: 36,
              textAlign: 'center',
              fontSize: 15,
              lineHeight: 23,
              color: 'rgba(255,255,255,0.55)',
            }}
          >
            {error?.message ??
              'Check your internet connection and try again. If the problem continues, contact the studio.'}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => void retry()}
            style={{
              minHeight: 60,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 22,
              backgroundColor: '#FFFFFF',
            }}
          >
            <Text style={{ fontSize: 16, fontWeight: '700', color: '#000000' }}>
              Try again
            </Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return <>{children}</>;
}
