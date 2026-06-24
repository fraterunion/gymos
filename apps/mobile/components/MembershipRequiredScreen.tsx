import { Pressable, Text, View } from 'react-native';
import * as Linking from 'expo-linking';

import { BrandButton } from '@/components/BrandButton';
import { useAuth } from '@/contexts/AuthContext';
import { useBranding } from '@/contexts/BrandingContext';
import { useSelectedStudio } from '@/contexts/SelectedStudioContext';
import { getColors, Space } from '@/constants/Theme';

type Props = {
  onRetry: () => void;
};

export function MembershipRequiredScreen({ onRetry }: Props) {
  const C = getColors();
  const { primaryColor, branding } = useBranding();
  const { displayName } = useSelectedStudio();
  const { logout, busy } = useAuth();
  const supportEmail = branding?.supportEmail?.trim();

  return (
    <View
      style={{
        flex: 1,
        justifyContent: 'center',
        backgroundColor: C.bg,
        paddingHorizontal: Space.screenH,
      }}
    >
      <Text
        style={{
          textAlign: 'center',
          fontSize: 26,
          fontWeight: '800',
          letterSpacing: -0.6,
          color: C.text,
          lineHeight: 32,
        }}
      >
        Aún no vemos una membresía aquí
      </Text>
      <Text
        style={{
          marginTop: 14,
          textAlign: 'center',
          fontSize: 15,
          lineHeight: 23,
          color: C.textSub,
          letterSpacing: -0.1,
        }}
      >
        Tu inicio de sesión es válido, pero esta app está vinculada a{' '}
        <Text style={{ fontWeight: '600', color: C.text }}>{displayName}</Text>. Pide en recepción
        que agreguen tu cuenta a este estudio y luego toca intentar de nuevo.
      </Text>
      {supportEmail ? (
        <Pressable
          accessibilityRole="button"
          style={{ marginTop: 24, alignSelf: 'center' }}
          onPress={() => void Linking.openURL(`mailto:${supportEmail}`)}
        >
          <Text
            style={{
              textAlign: 'center',
              fontSize: 15,
              fontWeight: '600',
              color: C.text,
              letterSpacing: -0.1,
            }}
          >
            {supportEmail}
          </Text>
        </Pressable>
      ) : null}
      <View style={{ marginTop: 40, gap: 12 }}>
        <BrandButton label="Reintentar" accentColor={primaryColor} onPress={() => void onRetry()} />
        <BrandButton
          label="Cerrar sesión"
          variant="ghost"
          accentColor={primaryColor}
          onPress={() => void logout()}
          loading={busy}
        />
      </View>
    </View>
  );
}
