import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
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
import { getColors, Space, type ThemeColors } from '@/constants/Theme';

const CARD_BG = '#141416';

function premiumCardStyle(C: ThemeColors) {
  return {
    backgroundColor: CARD_BG,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: C.separator,
  } as const;
}

function SectionLabel({ children }: { children: string }) {
  const C = getColors();
  return (
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
      {children}
    </Text>
  );
}

function membershipCreditsLine(
  classCredits: number | null,
  creditsUsed: number | null,
  creditsRemaining: number | null,
): string {
  if (classCredits === null) return 'Unlimited classes';
  if (typeof creditsUsed === 'number' && typeof creditsRemaining === 'number') {
    return `${creditsUsed} / ${classCredits} used · ${creditsRemaining} remaining`;
  }
  return `${classCredits} classes per period`;
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
  const timeZone = matched?.studio.timezone ?? 'UTC';

  const [profile, setProfile] = useState<MyMemberProfileDto | null>(null);
  const [profileError, setProfileError] = useState(false);
  const [progress, setProgress] = useState<MemberProgressDto | null>(null);

  const loadProfile = useCallback(async () => {
    if (!studioId || !user) return;
    try {
      const p = await fetchMyMemberProfile(studioId);
      setProfile(p);
      setProfileError(false);
    } catch {
      // Keep profile usable if membership status cannot be loaded
      setProfileError(true);
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
  const initials = `${user.firstName?.[0] ?? ''}${user.lastName?.[0] ?? ''}`.toUpperCase() || '?';
  const isMembershipActive = sub?.status === 'ACTIVE' || sub?.status === 'TRIALING';

  const renewsLabel = sub
    ? `Renews ${new Intl.DateTimeFormat(undefined, { timeZone, dateStyle: 'medium' }).format(
        new Date(sub.currentPeriodEnd),
      )}${sub.cancelAtPeriodEnd ? ' · Cancelling' : ''}`
    : null;

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
            Profile
          </Text>
          <Text style={{ fontSize: 14, color: C.textMute, marginTop: 6 }}>
            {appDisplayName || 'Athlete Profile'}
          </Text>
        </Animated.View>

        {/* Hero / athlete card */}
        <Animated.View entering={FadeInDown.delay(60).duration(420)}>
          <View style={[premiumCardStyle(C), { padding: 24 }]}>
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

            {sub && isMembershipActive ? (
              <View style={{ marginTop: 18 }}>
                <MembershipStatusPill
                  status={sub.status}
                  cancelAtPeriodEnd={sub.cancelAtPeriodEnd}
                />
              </View>
            ) : null}
          </View>
        </Animated.View>

        {/* Progress */}
        {progress ? (
          <Animated.View entering={FadeInDown.delay(100).duration(420)}>
            <SectionLabel>Progress</SectionLabel>
            <ProgressSummaryCard
              progress={progress}
              onViewProgress={() => router.push('/(app)/progress' as Href)}
            />
          </Animated.View>
        ) : null}

        {/* Membership */}
        <Animated.View entering={FadeInDown.delay(140).duration(420)}>
          <SectionLabel>Membership</SectionLabel>

          {sub ? (
            <View style={[premiumCardStyle(C), { padding: 24 }]}>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 14,
                }}
              >
                <Text
                  style={{
                    fontSize: 18,
                    fontWeight: '700',
                    letterSpacing: -0.3,
                    color: C.text,
                    flex: 1,
                    marginRight: 12,
                  }}
                  numberOfLines={1}
                >
                  {sub.plan.name}
                </Text>
                <MembershipStatusPill
                  status={sub.status}
                  cancelAtPeriodEnd={sub.cancelAtPeriodEnd}
                />
              </View>

              {renewsLabel ? (
                <Text style={{ fontSize: 13, color: C.textSub, marginBottom: 6 }}>
                  {renewsLabel}
                </Text>
              ) : null}

              <Text style={{ fontSize: 13, color: C.textSub }}>
                {membershipCreditsLine(
                  sub.plan.classCredits,
                  sub.creditsUsed,
                  sub.creditsRemaining,
                )}
              </Text>

              <Pressable
                accessibilityRole="button"
                onPress={() => router.push('/(app)/(tabs)/membership')}
                hitSlop={8}
                style={{ marginTop: 18 }}
              >
                <Text
                  style={{
                    fontSize: 15,
                    fontWeight: '600',
                    color: C.text,
                    letterSpacing: -0.2,
                  }}
                >
                  Manage Membership →
                </Text>
              </Pressable>
            </View>
          ) : (
            <View style={[premiumCardStyle(C), { padding: 24 }]}>
              <Text
                style={{
                  fontSize: 15,
                  color: C.textSub,
                  lineHeight: 22,
                  marginBottom: profileError ? 8 : 18,
                }}
              >
                {profileError
                  ? 'We couldn’t load your membership right now.'
                  : 'No active membership'}
              </Text>
              {profileError ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void loadProfile()}
                  hitSlop={8}
                  style={{ marginBottom: 18 }}
                >
                  <Text
                    style={{
                      fontSize: 14,
                      fontWeight: '600',
                      color: C.text,
                      letterSpacing: -0.2,
                    }}
                  >
                    Try again
                  </Text>
                </Pressable>
              ) : null}
              <BrandButton
                label="View Memberships"
                accentColor={primaryColor}
                onPress={() => router.push('/(app)/(tabs)/membership')}
              />
            </View>
          )}
        </Animated.View>

        {/* Account */}
        <Animated.View entering={FadeInDown.delay(180).duration(420)}>
          <SectionLabel>Account</SectionLabel>
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
