import { Pressable, Text, View } from 'react-native';
import * as Linking from 'expo-linking';

import { BrandButton } from '@/components/BrandButton';
import { useAuth } from '@/contexts/AuthContext';
import { useBranding } from '@/contexts/BrandingContext';
import { useSelectedStudio } from '@/contexts/SelectedStudioContext';

type Props = {
  onRetry: () => void;
};

export function MembershipRequiredScreen({ onRetry }: Props) {
  const { primaryColor, branding } = useBranding();
  const { displayName } = useSelectedStudio();
  const { logout, busy } = useAuth();
  const supportEmail = branding?.supportEmail?.trim();

  return (
    <View className="flex-1 justify-center bg-neutral-50 px-8 dark:bg-neutral-950">
      <Text className="text-center text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
        Membership required
      </Text>
      <Text className="mt-4 text-center text-base leading-6 text-neutral-600 dark:text-neutral-400">
        Your account is not linked to <Text className="font-semibold text-neutral-800 dark:text-neutral-200">{displayName}</Text> yet.
        Ask the front desk to add you to this studio, then try again.
      </Text>
      {supportEmail ? (
        <Pressable
          accessibilityRole="button"
          className="mt-6 self-center"
          onPress={() => void Linking.openURL(`mailto:${supportEmail}`)}>
          <Text className="text-center text-base font-semibold" style={{ color: primaryColor }}>
            {supportEmail}
          </Text>
        </Pressable>
      ) : null}
      <View className="mt-12 gap-4">
        <BrandButton label="Try again" accentColor={primaryColor} onPress={() => void onRetry()} />
        <BrandButton label="Sign out" variant="ghost" accentColor={primaryColor} onPress={() => void logout()} loading={busy} />
      </View>
    </View>
  );
}
