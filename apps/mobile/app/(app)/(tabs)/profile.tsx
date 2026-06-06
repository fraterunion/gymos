import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { BrandButton } from '@/components/BrandButton';
import { FLOATING_TAB_CLEARANCE } from '@/components/FloatingTabBar';
import { MembershipStatusPill } from '@/components/MembershipStatusPill';
import { useAuth } from '@/contexts/AuthContext';
import { useBranding } from '@/contexts/BrandingContext';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import { fetchMyMemberProfile, type MyMemberProfileDto } from '@/lib/api/membershipApi';
import { getColors, Space } from '@/constants/Theme';

function SectionDivider() {
  const C = getColors();
  return <View style={{ height: 1, backgroundColor: C.separator, marginVertical: 24 }} />;
}

export default function ProfileScreen() {
  const router = useRouter();
  const { user, logout, busy } = useAuth();
  const { primaryColor, appDisplayName } = useBranding();
  const { matched } = useMemberStudio();
  const C = getColors();
  const studioId = matched?.studio.id;

  const [profile, setProfile] = useState<MyMemberProfileDto | null>(null);

  const loadProfile = useCallback(async () => {
    if (!studioId) return;
    try {
      const p = await fetchMyMemberProfile(studioId);
      setProfile(p);
    } catch {
      // Keep profile usable if membership status cannot be loaded
    }
  }, [studioId]);

  useFocusEffect(
    useCallback(() => {
      void loadProfile();
    }, [loadProfile]),
  );

  const sub = profile?.activeSubscription;

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

        {/* Account */}
        <Animated.View entering={FadeInDown.delay(80).duration(420)}>
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

        <SectionDivider />

        {/* Membership */}
        <Animated.View entering={FadeInDown.delay(120).duration(420)}>
          <Text
            style={{
              fontSize: 10,
              fontWeight: '700',
              letterSpacing: 1.0,
              textTransform: 'uppercase',
              color: C.textMute,
              marginBottom: 12,
            }}
          >
            Membership
          </Text>

          {sub ? (
            <View style={{ gap: 10 }}>
              <Text
                style={{
                  fontSize: 17,
                  fontWeight: '600',
                  letterSpacing: -0.3,
                  color: C.text,
                }}
              >
                {sub.plan.name}
              </Text>
              <MembershipStatusPill status={sub.status} cancelAtPeriodEnd={sub.cancelAtPeriodEnd} />
            </View>
          ) : (
            <View style={{ gap: 16 }}>
              <Text style={{ fontSize: 15, color: C.textSub, lineHeight: 22 }}>
                No active membership
              </Text>
              <BrandButton
                label="View Memberships"
                accentColor={primaryColor}
                onPress={() => router.push('/(app)/(tabs)/membership')}
              />
            </View>
          )}
        </Animated.View>

        <SectionDivider />

        {/* Sign out */}
        <Animated.View entering={FadeInDown.delay(160).duration(420)}>
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
