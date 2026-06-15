import { Image } from 'expo-image';
import { useEffect } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getBootWordmarkSource, getBootWordmarkSize } from '@/components/BrandWordmark';

const BG = '#000000';
const LOADING_COPY = 'Preparing your training experience';

type Props = {
  logoUrl?: string | null;
};

/**
 * Premium boot / loading surface — black canvas, crisp wordmark, minimal chrome.
 * Used while branding hydrates and on the post-splash auth gate.
 */
export function PremiumBootScreen({ logoUrl }: Props) {
  const insets = useSafeAreaInsets();
  const opacity = useSharedValue(0);
  const translateY = useSharedValue(10);

  useEffect(() => {
    opacity.value = withDelay(
      80,
      withTiming(1, { duration: 520, easing: Easing.out(Easing.cubic) }),
    );
    translateY.value = withDelay(
      80,
      withTiming(0, { duration: 520, easing: Easing.out(Easing.cubic) }),
    );
  }, [opacity, translateY]);

  const animStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  const bundled = getBootWordmarkSource();
  const { width, height } = getBootWordmarkSize();
  const remoteUri = logoUrl?.trim() || null;
  const source = bundled ?? (remoteUri ? { uri: remoteUri } : null);

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: BG,
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
      }}
    >
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: 48,
          // Optical center: nudge lockup slightly above geometric center.
          marginBottom: 56,
        }}
      >
        <Animated.View style={[{ alignItems: 'center' }, animStyle]}>
          {source ? (
            <Image
              accessibilityIgnoresInvertColors
              source={source}
              contentFit="contain"
              transition={0}
              style={{ width, height }}
            />
          ) : null}

          <ActivityIndicator
            color="#FFFFFF"
            size="small"
            style={{ marginTop: 44, transform: [{ scale: 0.85 }] }}
          />

          <Text
            style={{
              marginTop: 16,
              fontSize: 13,
              fontWeight: '400',
              letterSpacing: 0.2,
              lineHeight: 18,
              color: 'rgba(255,255,255,0.55)',
              textAlign: 'center',
            }}
          >
            {LOADING_COPY}
          </Text>
        </Animated.View>
      </View>
    </View>
  );
}
