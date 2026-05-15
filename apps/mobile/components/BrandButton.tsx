import { ActivityIndicator, Pressable, Text, useColorScheme } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import { getColors } from '@/constants/Theme';

type Props = {
  label: string;
  loading?: boolean;
  variant?: 'primary' | 'ghost';
  accentColor: string;
  disabled?: boolean;
  onPress?: () => void;
};

export function BrandButton({ label, loading, variant = 'primary', accentColor, disabled, onPress }: Props) {
  const scheme = useColorScheme();
  const C = getColors(scheme);
  const isPrimary = variant === 'primary';
  const isDisabled = disabled || loading;

  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Animated.View style={animStyle}>
      <Pressable
        accessibilityRole="button"
        disabled={isDisabled}
        onPress={onPress}
        onPressIn={() => { scale.value = withSpring(0.968, { damping: 22, stiffness: 400 }); }}
        onPressOut={() => { scale.value = withSpring(1.0, { damping: 14, stiffness: 220 }); }}
        style={[
          {
            minHeight: 56,
            width: '100%',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 14,
            paddingHorizontal: 20,
            opacity: isDisabled ? 0.5 : 1,
          },
          isPrimary
            ? { backgroundColor: accentColor }
            : { backgroundColor: 'transparent', borderWidth: 1, borderColor: C.separator },
        ]}
      >
        {loading ? (
          <ActivityIndicator color={isPrimary ? '#fff' : accentColor} />
        ) : (
          <Text
            style={{
              fontSize: 16,
              fontWeight: '600',
              letterSpacing: -0.1,
              color: isPrimary ? '#FFFFFF' : C.textSub,
            }}
          >
            {label}
          </Text>
        )}
      </Pressable>
    </Animated.View>
  );
}
