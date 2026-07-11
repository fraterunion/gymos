import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { OPEN_GYM_HOURS_LABEL } from '@/lib/aresMembershipPlans';
import { getColors, Radius, Space } from '@/constants/Theme';

type Props = {
  compact?: boolean;
  delay?: number;
};

export function OpenGymBenefitCard({ compact = false, delay = 0 }: Props) {
  const C = getColors();

  return (
    <Animated.View entering={FadeInDown.delay(delay).duration(420)} style={{ marginBottom: compact ? 20 : Space.cardGap }}>
      <View
        style={{
          backgroundColor: C.surface1,
          borderRadius: Radius.card,
          borderWidth: 1,
          borderColor: C.separator,
          padding: compact ? 18 : 20,
          flexDirection: 'row',
          alignItems: 'flex-start',
          gap: 14,
        }}
      >
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: C.separator,
            backgroundColor: C.surface2,
            alignItems: 'center',
            justifyContent: 'center',
            marginTop: 2,
          }}
        >
          <FontAwesome name="unlock-alt" size={14} color={C.textMute} />
        </View>
        <View style={{ flex: 1 }}>
          <Text
            style={{
              fontSize: 10,
              fontWeight: '700',
              letterSpacing: 1.2,
              textTransform: 'uppercase',
              color: C.textMute,
              marginBottom: 8,
            }}
          >
            Beneficio de membresía
          </Text>
          <Text
            style={{
              fontSize: compact ? 16 : 17,
              fontWeight: '700',
              letterSpacing: -0.4,
              color: C.text,
              marginBottom: 6,
            }}
          >
            {OPEN_GYM_HOURS_LABEL}
          </Text>
          <Text style={{ fontSize: 13, color: C.textSub, lineHeight: 19 }}>
            Acceso al gimnasio sin reserva. No es una clase reservable.
          </Text>
        </View>
      </View>
    </Animated.View>
  );
}
