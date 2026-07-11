import { ActivityIndicator, Pressable, Text, useColorScheme } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { getColors, Radius } from '@/constants/Theme';

type Props = {
  label: string;
  loading?: boolean;
  /** 'white' renders a solid white button with dark text (premium dark surfaces). */
  variant?: 'primary' | 'ghost' | 'white';
  accentColor: string;
  disabled?: boolean;
  onPress?: () => void;
};

export function BrandButton({ label, loading, variant = 'primary', accentColor, disabled, onPress }: Props) {
  const scheme = useColorScheme();
  const C = getColors(scheme);
  const isPrimary = variant === 'primary';
  const isWhite = variant === 'white';
  const isDisabled = disabled || loading;

  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Animated.View style={animStyle}>
      <Pressable
        accessibilityRole="button"
        disabled={isDisabled}
        onPress={onPress}
        onPressIn={() => { scale.value = withTiming(0.968, { duration: 80 }); }}
        onPressOut={() => { scale.value = withTiming(1.0, { duration: 140 }); }}
        style={[
          {
            minHeight: 56,
            width: '100%',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: Radius.button,
            paddingHorizontal: 20,
            opacity: isDisabled ? 0.5 : 1,
          },
          isWhite
            ? { backgroundColor: '#FFFFFF' }
            : isPrimary
              ? { backgroundColor: accentColor }
              : {
                  backgroundColor: 'transparent',
                  borderWidth: 1,
                  borderColor: 'rgba(255,255,255,0.35)',
                },
        ]}
      >
        {loading ? (
          <ActivityIndicator color={isWhite ? '#000000' : isPrimary ? '#fff' : C.text} />
        ) : (
          <Text
            style={{
              fontSize: 16,
              fontWeight: isWhite ? '700' : '600',
              letterSpacing: -0.1,
              color: isWhite ? '#000000' : isPrimary ? '#FFFFFF' : C.text,
            }}
          >
            {label}
          </Text>
        )}
      </Pressable>
    </Animated.View>
  );
}
