import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Pressable, Text } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { getColors, Radius } from '@/constants/Theme';

type Props = {
  label: string;
  canGoPrev: boolean;
  onPrev: () => void;
  onNext: () => void;
};

function NavButton({
  icon,
  onPress,
  disabled,
  accessibilityLabel,
}: {
  icon: 'chevron-left' | 'chevron-right';
  onPress: () => void;
  disabled?: boolean;
  accessibilityLabel: string;
}) {
  const C = getColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      style={{
        width: 44,
        height: 44,
        borderRadius: Radius.pill,
        borderWidth: 1,
        borderColor: C.separator,
        backgroundColor: C.surface1,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.35 : 1,
      }}
    >
      <FontAwesome name={icon} size={14} color={C.textSub} />
    </Pressable>
  );
}

export function MemberWeekNavigator({ label, canGoPrev, onPrev, onNext }: Props) {
  const C = getColors();

  return (
    <Animated.View
      entering={FadeIn.duration(280)}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 16,
        gap: 12,
      }}
    >
      <NavButton
        icon="chevron-left"
        onPress={onPrev}
        disabled={!canGoPrev}
        accessibilityLabel="Semana anterior"
      />
      <Text
        style={{
          flex: 1,
          textAlign: 'center',
          fontSize: 13,
          fontWeight: '700',
          letterSpacing: 0.8,
          color: C.textSub,
        }}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.85}
      >
        {label}
      </Text>
      <NavButton icon="chevron-right" onPress={onNext} accessibilityLabel="Semana siguiente" />
    </Animated.View>
  );
}
