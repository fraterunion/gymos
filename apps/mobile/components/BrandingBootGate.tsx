import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BrandWordmark } from '@/components/BrandWordmark';
import { useBranding } from '@/contexts/BrandingContext';

export function BrandingBootGate({ children }: { children: ReactNode }) {
  const { status, error, retry, logoUrl } = useBranding();

  if (status === 'loading') {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: '#0A0A0A' }}>
        <View
          style={{
            flex: 1,
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
      </SafeAreaView>
    );
  }

  if (status === 'error') {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: '#0A0A0A' }}>
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
            <Text style={{ fontSize: 16, fontWeight: '700', color: '#0A0A0A' }}>
              Try again
            </Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return <>{children}</>;
}
