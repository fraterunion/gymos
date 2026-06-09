import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { BrandButton } from '@/components/BrandButton';
import { TAB_BAR_CLEARANCE } from '@/components/FloatingTabBar';
import { MembershipStatusPill } from '@/components/MembershipStatusPill';
import { ProgressSummaryCard } from '@/components/ProgressSummaryCard';
import { useAuth } from '@/contexts/AuthContext';
import { useBranding } from '@/contexts/BrandingContext';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import { fetchMyMemberProfile, type MyMemberProfileDto } from '@/lib/api/membershipApi';
import { fetchMyProgress, type MemberProgressDto } from '@/lib/api/progressApi';
import { getColors, Space } from '@/constants/Theme';

function SectionDivider() {
  const C = getColors();
  return <View style={{ height: 1, backgroundColor: C.separator, marginVertical: 24 }} />;
}

const GUEST_FEATURES = [
  'Membership status',
  'Booking history',
  'QR check-ins',
  'Account settings',
] as const;

// ---------------------------------------------------------------------------
// Guest wall — no authenticated API calls
// ---------------------------------------------------------------------------

function GuestProfileWall({ primaryColor }: { primaryColor: string }) {
  const router = useRouter();
  const C = getColors();

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['left', 'right', 'top']}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: Space.screenH,
          paddingBottom: TAB_BAR_CLEARANCE,
        }}
      >
        <Animated.View entering={FadeInDown.duration(500)} style={{ paddingTop: 28, paddingBottom: 24 }}>
          <Text
            style={{
              fontSize: 38,
              fontWeight: '800',
              letterSpacing: -1.3,
              color: C.text,
              lineHeight: 44,
            }}
          >
            Your Account
          </Text>
          <Text
            style={{
              fontSize: 15,
              color: C.textSub,
              lineHeight: 23,
              marginTop: 14,
              letterSpacing: -0.1,
            }}
          >
            Create an account to manage your membership, bookings, check-ins, and training
            history.
          </Text>
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(80).duration(460)}>
          <View
            style={{
              backgroundColor: C.surface1,
              borderRadius: 20,
              padding: 26,
            }}
          >
            <Text
              style={{
                fontSize: 11,
                fontWeight: '700',
                letterSpacing: 1.0,
                textTransform: 'uppercase',
                color: C.textMute,
                marginBottom: 18,
              }}
            >
              What you unlock
            </Text>
            {GUEST_FEATURES.map((feature, index) => (
              <View
                key={feature}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  marginBottom: index < GUEST_FEATURES.length - 1 ? 14 : 0,
                }}
              >
                <View
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 3,
                    backgroundColor: primaryColor,
                    marginRight: 12,
                  }}
                />
                <Text
                  style={{
                    fontSize: 15,
                    color: C.text,
                    fontWeight: '500',
                    letterSpacing: -0.2,
                  }}
                >
                  {feature}
                </Text>
              </View>
            ))}
          </View>
        </Animated.View>

        <Animated.View
          entering={FadeInDown.delay(140).duration(440)}
          style={{ marginTop: 28, gap: 12 }}
        >
          <BrandButton
            label="Create Account"
            accentColor={primaryColor}
            onPress={() => router.push('/(auth)/register')}
          />
          <BrandButton
            label="Log In"
            variant="ghost"
            accentColor={primaryColor}
            onPress={() => router.push('/(auth)/login')}
          />
        </Animated.View>
      </ScrollView>
    </SafeAreaView>
  );
}

export default function ProfileScreen() {
  const router = useRouter();
  const { user, logout, busy } = useAuth();
  const { primaryColor, appDisplayName } = useBranding();
  const { matched } = useMemberStudio();
  const C = getColors();
  const studioId = matched?.studio.id;

  const [profile, setProfile] = useState<MyMemberProfileDto | null>(null);
  const [progress, setProgress] = useState<MemberProgressDto | null>(null);

  const loadProfile = useCallback(async () => {
    if (!studioId || !user) return;
    try {
      const p = await fetchMyMemberProfile(studioId);
      setProfile(p);
    } catch {
      // Keep profile usable if membership status cannot be loaded
    }
    try {
      const prog = await fetchMyProgress(studioId);
      setProgress(prog);
    } catch (e) {
      // Progress card is optional — hide it if the fetch fails
      setProgress(null);
      if (__DEV__) {
        console.warn('[Profile] fetchMyProgress failed:', e);
      }
    }
  }, [studioId, user]);

  useFocusEffect(
    useCallback(() => {
      if (!user) return;
      void loadProfile();
    }, [user, loadProfile]),
  );

  if (!user) {
    return <GuestProfileWall primaryColor={primaryColor} />;
  }

  const sub = profile?.activeSubscription;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['left', 'right', 'top']}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: Space.screenH,
          paddingBottom: TAB_BAR_CLEARANCE,
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

        {/* Progress summary */}
        {progress ? (
          <>
            <SectionDivider />
            <Animated.View entering={FadeInDown.delay(140).duration(420)}>
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
                Progress
              </Text>
              <ProgressSummaryCard
                progress={progress}
                onViewProgress={() => router.push('/(app)/progress' as Href)}
              />
            </Animated.View>
          </>
        ) : null}

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
