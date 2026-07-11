import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { BrandButton } from '@/components/BrandButton';
import { TAB_BAR_CLEARANCE } from '@/components/FloatingTabBar';
import { useAuth } from '@/contexts/AuthContext';
import { useBranding } from '@/contexts/BrandingContext';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import { staffModeTitle } from '@/lib/staffRole';
import { getColors, Radius, Space } from '@/constants/Theme';

function roleLabel(role: string | null | undefined): string {
  if (!role) return 'Staff';
  const labels: Record<string, string> = {
    OWNER: 'Propietario',
    ADMIN: 'Administrador',
    STAFF: 'Staff',
    INSTRUCTOR: 'Coach',
    FRONT_DESK: 'Recepción',
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
        <Animated.View entering={FadeInDown.duration(300)} style={{ paddingTop: 32, paddingBottom: Space.sp5 }}>
          <Text
            style={{
              fontSize: 40,
              fontWeight: '800',
              letterSpacing: -1.6,
              color: C.text,
              lineHeight: 44,
            }}
          >
            {staffModeTitle(matched?.role)}
          </Text>
          <Text style={{ fontSize: 16, color: C.textSub, lineHeight: 24, marginTop: 8, letterSpacing: -0.2 }}>
            {appDisplayName}
          </Text>
        </Animated.View>

        {/* Identity card */}
        <Animated.View entering={FadeInDown.delay(40).duration(300)}>
          <View
            style={{
              backgroundColor: C.surface1,
              borderRadius: Radius.card,
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

            <Text
              style={{
                fontSize: 13,
                color: C.textMute,
                marginTop: 10,
              }}
            >
              {roleLabel(matched?.role)}
            </Text>
          </View>
        </Animated.View>

        {/* Account */}
        <Animated.View entering={FadeInDown.delay(80).duration(300)} style={{ marginTop: Space.sp4 }}>
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
