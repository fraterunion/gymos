import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useRouter } from 'expo-router';
import { Text, View } from 'react-native';

import { BrandButton } from '@/components/BrandButton';
import { getColors } from '@/constants/Theme';

type Props = {
  accentColor: string;
  appDisplayName: string;
};

export function SubscriptionRequiredPanel({ accentColor }: Props) {
  const router = useRouter();
  const C = getColors();

  return (
    <View
      style={{
        overflow: 'hidden',
        borderRadius: 28,
        borderWidth: 1,
        borderColor: C.separator,
        backgroundColor: '#141416',
      }}
    >
      <View style={{ alignItems: 'center', paddingHorizontal: 24, paddingTop: 28, paddingBottom: 24 }}>
        <View
          style={{
            marginBottom: 18,
            width: 56,
            height: 56,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 28,
            backgroundColor: 'rgba(255,255,255,0.08)',
            borderWidth: 1,
            borderColor: C.separator,
          }}
        >
          <FontAwesome name="lock" size={24} color={C.text} />
        </View>
        <Text
          style={{
            textAlign: 'center',
            fontSize: 20,
            fontWeight: '800',
            letterSpacing: -0.4,
            color: C.text,
          }}
        >
          Elige una membresía para reservar
        </Text>
        <Text
          style={{
            marginTop: 12,
            textAlign: 'center',
            fontSize: 15,
            lineHeight: 23,
            color: C.textSub,
            letterSpacing: -0.1,
          }}
        >
          Con tu membresía reservas clases y tienes acceso al gimnasio. Elige un plan, completa el
          pago en tu navegador y regresa aquí: tu acceso se activa en cuanto el estudio confirme
          tu membresía.
        </Text>
        <View style={{ marginTop: 24, width: '100%' }}>
          <BrandButton
            label="Ver membresía"
            accentColor={accentColor}
            onPress={() => router.push('/(app)/(tabs)/membership')}
          />
        </View>
      </View>
    </View>
  );
}
