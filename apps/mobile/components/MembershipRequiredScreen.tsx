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
        We do not see a membership here yet
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
        Your login is valid, but this app is tied to{' '}
        <Text style={{ fontWeight: '600', color: C.text }}>{displayName}</Text>. Ask the front desk
        to add your account to this studio, then tap try again.
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
        <BrandButton label="Try again" accentColor={primaryColor} onPress={() => void onRetry()} />
        <BrandButton
          label="Sign out"
          variant="ghost"
          accentColor={primaryColor}
          onPress={() => void logout()}
          loading={busy}
        />
      </View>
    </View>
  );
}
