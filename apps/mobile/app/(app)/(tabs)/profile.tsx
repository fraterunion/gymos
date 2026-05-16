import { ScrollView, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { BrandButton } from '@/components/BrandButton';
import { FLOATING_TAB_CLEARANCE } from '@/components/FloatingTabBar';
import { useAuth } from '@/contexts/AuthContext';
import { useBranding } from '@/contexts/BrandingContext';
import { getColors, Space } from '@/constants/Theme';

export default function ProfileScreen() {
  const { user, logout, busy } = useAuth();
  const { primaryColor, appDisplayName } = useBranding();
  const C = getColors();

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['left', 'right', 'top']}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: Space.screenH,
          paddingBottom: FLOATING_TAB_CLEARANCE,
        }}
      >
        {/* Page header */}
        <Animated.View entering={FadeInDown.duration(450)} style={{ paddingTop: 28, paddingBottom: 28 }}>
          <Text
            style={{
              fontSize: 38,
              fontWeight: '800',
              letterSpacing: -1.3,
              color: C.text,
              lineHeight: 44,
            }}
          >
            Profile
          </Text>
          {appDisplayName ? (
            <Text style={{ fontSize: 14, color: C.textMute, marginTop: 6 }}>
              {appDisplayName}
            </Text>
          ) : null}
        </Animated.View>

        {/* Account card */}
        <Animated.View
          entering={FadeInDown.delay(80).duration(420)}
          style={{
            backgroundColor: C.surface2,
            borderRadius: 20,
            padding: 24,
            marginBottom: 16,
          }}
        >
          <Text
            style={{
              fontSize: 10,
              fontWeight: '700',
              letterSpacing: 1.0,
              textTransform: 'uppercase',
              color: C.textMute,
              marginBottom: 14,
            }}
          >
            Account
          </Text>
          <Text
            style={{
              fontSize: 22,
              fontWeight: '700',
              letterSpacing: -0.4,
              color: C.text,
              marginBottom: 4,
            }}
          >
            {user?.firstName} {user?.lastName}
          </Text>
          <Text style={{ fontSize: 14, color: C.textSub }}>{user?.email}</Text>
        </Animated.View>

        {/* Sign out */}
        <Animated.View entering={FadeInDown.delay(160).duration(420)} style={{ marginTop: 8 }}>
          <BrandButton
            label="Sign out"
            variant="ghost"
            accentColor={primaryColor}
            loading={busy}
            onPress={() => void logout()}
          />
        </Animated.View>
      </ScrollView>
    </SafeAreaView>
  );
}
