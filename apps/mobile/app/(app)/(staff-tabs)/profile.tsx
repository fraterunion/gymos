import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { BrandButton } from '@/components/BrandButton';
import { TAB_BAR_CLEARANCE } from '@/components/FloatingTabBar';
import { useAuth } from '@/contexts/AuthContext';
import { useBranding } from '@/contexts/BrandingContext';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import { staffModeTitle } from '@/lib/staffRole';
import { getColors, Space } from '@/constants/Theme';

function roleLabel(role: string | null | undefined): string {
  if (!role) return 'Staff';
  const labels: Record<string, string> = {
    OWNER: 'Propietario',
    ADMIN: 'Administrador',
    STAFF: 'Staff',
    INSTRUCTOR: 'Coach',
  };
  return labels[role.toUpperCase()] ?? role;
}

export default function StaffProfileScreen() {
  const C = getColors();
  const { user, logout, busy } = useAuth();
  const { primaryColor, appDisplayName } = useBranding();
  const { matched } = useMemberStudio();

  if (!user) {
    // Staff shell is only reachable for authenticated staff; nothing to render here.
    return <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} />;
  }

  const initials =
    `${user.firstName?.[0] ?? ''}${user.lastName?.[0] ?? ''}`.toUpperCase() || '?';

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['left', 'right', 'top']}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: Space.screenH,
          paddingBottom: TAB_BAR_CLEARANCE,
        }}
      >
        {/* Header */}
        <Animated.View entering={FadeInDown.duration(450)} style={{ paddingTop: 28, paddingBottom: 24 }}>
          <Text
            style={{
              fontSize: 38,
              fontWeight: '800',
              letterSpacing: -1.3,
              color: C.text,
              lineHeight: 44,
            }}
          >
            {staffModeTitle(matched?.role)}
          </Text>
          <Text style={{ fontSize: 14, color: C.textMute, marginTop: 6 }}>
            {appDisplayName}
          </Text>
        </Animated.View>

        {/* Identity card */}
        <Animated.View entering={FadeInDown.delay(60).duration(420)}>
          <View
            style={{
              backgroundColor: '#141416',
              borderRadius: 28,
              borderWidth: 1,
              borderColor: C.separator,
              padding: 24,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 32,
                  backgroundColor: '#1E1E22',
                  borderWidth: 1,
                  borderColor: C.separator,
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginRight: 16,
                }}
              >
                <Text
                  style={{
                    fontSize: 22,
                    fontWeight: '800',
                    letterSpacing: 0.5,
                    color: C.text,
                  }}
                >
                  {initials}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text
                  style={{
                    fontSize: 20,
                    fontWeight: '700',
                    letterSpacing: -0.4,
                    color: C.text,
                  }}
                  numberOfLines={1}
                >
                  {user.firstName} {user.lastName}
                </Text>
                <Text
                  style={{ fontSize: 13, color: C.textMute, marginTop: 3 }}
                  numberOfLines={1}
                >
                  {user.email}
                </Text>
              </View>
            </View>

            {/* Role pill */}
            <View
              style={{
                alignSelf: 'flex-start',
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: 'rgba(255,255,255,0.10)',
                borderRadius: 100,
                paddingVertical: 5,
                paddingHorizontal: 10,
                marginTop: 18,
              }}
            >
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: '#FFFFFF',
                  marginRight: 6,
                }}
              />
              <Text
                style={{
                  fontSize: 11,
                  fontWeight: '700',
                  letterSpacing: 0.6,
                  textTransform: 'uppercase',
                  color: '#FFFFFF',
                }}
              >
                {roleLabel(matched?.role)}
              </Text>
            </View>
          </View>
        </Animated.View>

        {/* Account */}
        <Animated.View entering={FadeInDown.delay(120).duration(420)}>
          <Text
            style={{
              fontSize: 11,
              fontWeight: '700',
              letterSpacing: 1.2,
              textTransform: 'uppercase',
              color: C.textMute,
              marginBottom: 14,
              marginTop: 32,
            }}
          >
            Cuenta
          </Text>
          <BrandButton
            label="Cerrar sesión"
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
