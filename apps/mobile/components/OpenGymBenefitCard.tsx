import { Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { OPEN_GYM_HOURS_LABEL } from '@/lib/aresMembershipPlans';
import { getColors, Space } from '@/constants/Theme';

type Props = {
  compact?: boolean;
  delay?: number;
};

export function OpenGymBenefitCard({ compact = false, delay = 0 }: Props) {
  const C = getColors();

  return (
    <Animated.View entering={FadeInDown.delay(delay).duration(420)}>
      <View
        style={{
          backgroundColor: C.surface1,
          borderRadius: compact ? 16 : 20,
          borderWidth: 1,
          borderColor: C.separator,
          padding: compact ? 16 : 20,
          marginBottom: compact ? 0 : Space.cardGap,
        }}
      >
        <Text
          style={{
            fontSize: 11,
            fontWeight: '700',
            letterSpacing: 1.0,
            textTransform: 'uppercase',
            color: C.textMute,
            marginBottom: 6,
          }}
        >
          Beneficio de membresía
        </Text>
        <Text
          style={{
            fontSize: compact ? 16 : 18,
            fontWeight: '800',
            letterSpacing: -0.4,
            color: C.text,
            marginBottom: 4,
          }}
        >
          {OPEN_GYM_HOURS_LABEL}
        </Text>
        <Text style={{ fontSize: 13, color: C.textSub, lineHeight: 19 }}>
          Acceso al gimnasio sin reserva. No es una clase bookable.
        </Text>
      </View>
    </Animated.View>
  );
}
