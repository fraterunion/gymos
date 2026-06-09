import { initStripe, useStripe } from '@/lib/stripe';
import { createURL } from 'expo-linking';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { AuthRequiredModal } from '@/components/AuthRequiredModal';
import { BrandButton } from '@/components/BrandButton';
import { LoadRetryPanel, ScreenLoader, Skeleton } from '@/components/StudioScreenChrome';
import { useAuth } from '@/contexts/AuthContext';
import { useBranding } from '@/contexts/BrandingContext';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import { usePublicStudio } from '@/contexts/PublicStudioContext';
import { useStudioActivity } from '@/contexts/StudioActivityContext';
import {
  fetchPublicMembershipPlans,
  type PublicMembershipPlanDto,
} from '@/lib/api/publicDiscoveryApi';
import { userFacingApiMessage } from '@/lib/userFacingApiMessage';
import {
  createBillingPortalSession,
  createMembershipCheckoutSession,
  fetchMembershipPlans,
  fetchMyMemberProfile,
  type BillingInterval,
  type MembershipPlanDto,
  type MyMemberProfileDto,
} from '@/lib/api/membershipApi';
import {
  createDayPassPaymentSheet,
  fetchMyDayPasses,
  type DayPassDto,
  type DayPassStatus,
} from '@/lib/api/dayPassesApi';
import { formatMoneyFromCents } from '@/lib/formatMoney';
import { statusConfig } from '@/lib/membershipStatus';
import { todayKeyInZone } from '@/lib/datetime';
import { getStudioSlug } from '@/lib/env';
import { TAB_BAR_CLEARANCE } from '@/components/FloatingTabBar';
import { getColors, Space, type ThemeColors } from '@/constants/Theme';

type AuthModalKind = 'membership' | 'day-pass';

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
        marginBottom: 16,
      }}
    >
      {children}
    </Text>
  );
}

function InlineAuthLink({
  prompt,
  action,
  onPress,
}: {
  prompt: string;
  action: string;
  onPress: () => void;
}) {
  const C = getColors();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      hitSlop={8}
      style={{ marginTop: 16, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6 }}
    >
      <Text style={{ fontSize: 14, color: C.textMute }}>{prompt}</Text>
      <Text style={{ fontSize: 14, fontWeight: '600', color: C.text }}>{action}</Text>
    </Pressable>
  );
}

const MEMBERSHIP_RETURN_TO = '/(app)/(tabs)/membership' as const;

const AUTH_MODAL_COPY: Record<AuthModalKind, { title: string; description: string }> = {
  membership: {
    title: 'Create your account to join',
    description:
      'Create an account to choose a membership, manage your billing, and book classes.',
  },
  'day-pass': {
    title: 'Create your account to get a Day Pass',
    description: 'Create an account to purchase a Day Pass and reserve classes from your phone.',
  },
};

function toMembershipPlanDto(plan: PublicMembershipPlanDto): MembershipPlanDto {
  return { ...plan, studioId: '' };
}

function billingIntervalLabel(interval: BillingInterval): string {
  switch (interval) {
    case 'MONTHLY': return '/mo';
    case 'YEARLY':  return '/yr';
    case 'WEEKLY':  return '/wk';
    default:        return '';
  }
}

function creditsLabel(credits: number | null): string | null {
  if (credits === null) return 'Unlimited class visits';
  if (credits <= 0) return null;
  return `${credits} visits per billing period`;
}

function membershipCreditDisplay(
  classCredits: number | null,
  creditsUsed: number | null,
  creditsRemaining: number | null,
): { primary: string; secondary?: string } {
  if (classCredits === null) {
    return { primary: 'Unlimited classes' };
  }
  if (typeof creditsUsed === 'number' && typeof creditsRemaining === 'number') {
    return {
      primary: `${creditsUsed} / ${classCredits} classes used`,
      secondary: `${creditsRemaining} remaining this period`,
    };
  }
  return { primary: `${classCredits} classes per period` };
}

// ---------------------------------------------------------------------------
// Active membership — physical luxury card
// ---------------------------------------------------------------------------

function MembershipCard({
  planName,
  status,
  cancelAtPeriodEnd,
  renewsAt,
  classCredits,
  creditsUsed,
  creditsRemaining,
  primaryColor,
  onManage,
  portalBusy,
}: {
  planName: string;
  status: string;
  cancelAtPeriodEnd: boolean;
  renewsAt: string;
  classCredits: number | null;
  creditsUsed: number | null;
  creditsRemaining: number | null;
  primaryColor: string;
  onManage: () => void;
  portalBusy: boolean;
}) {
  const C = getColors();
  const cfg = statusConfig(status, cancelAtPeriodEnd);
  const accentBarColor = (status === 'ACTIVE' || status === 'TRIALING') ? primaryColor : C.surface3;
  const creditDisplay = membershipCreditDisplay(classCredits, creditsUsed, creditsRemaining);

  const showCreditProgress =
    classCredits !== null &&
    typeof creditsUsed === 'number' &&
    classCredits > 0;
  const creditProgress = showCreditProgress
    ? Math.min(creditsUsed! / classCredits!, 1)
    : 0;

  return (
    <Animated.View entering={FadeInDown.duration(450)}>
      <View
        style={{
          ...premiumCardStyle(C),
          overflow: 'hidden',
          marginBottom: 8,
        }}
      >
        <View style={{ height: 3, backgroundColor: accentBarColor }} />

        <View style={{ padding: 28 }}>
          {/* Status pill */}
          <View
            style={{
              alignSelf: 'flex-start',
              flexDirection: 'row',
              alignItems: 'center',
              backgroundColor: cfg.bg,
              borderRadius: 100,
              paddingVertical: 5,
              paddingHorizontal: 10,
              marginBottom: 24,
            }}
          >
            <View
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: cfg.dotColor,
                marginRight: 6,
              }}
            />
            <Text
              style={{
                fontSize: 11,
                fontWeight: '700',
                letterSpacing: 0.6,
                textTransform: 'uppercase',
                color: cfg.textColor,
              }}
            >
              {cfg.label}
            </Text>
          </View>

          {/* Plan name — the hero */}
          <Text
            style={{
              fontSize: 34,
              fontWeight: '800',
              letterSpacing: -1.0,
              color: C.text,
              lineHeight: 38,
              marginBottom: 12,
            }}
          >
            {planName}
          </Text>

          {/* Renewal info */}
          <Text style={{ fontSize: 14, color: C.textMute, lineHeight: 20 }}>
            {renewsAt}
          </Text>

          <View
            style={{
              marginTop: 18,
              paddingVertical: 14,
              paddingHorizontal: 16,
              backgroundColor: 'rgba(255,255,255,0.04)',
              borderRadius: 14,
              borderWidth: 1,
              borderColor: C.separator,
            }}
          >
            <Text
              style={{
                fontSize: 11,
                fontWeight: '700',
                letterSpacing: 0.8,
                textTransform: 'uppercase',
                color: C.textMute,
                marginBottom: 8,
              }}
            >
              Class credits
            </Text>
            <Text
              style={{
                fontSize: 15,
                fontWeight: '600',
                color: C.text,
                letterSpacing: -0.2,
              }}
            >
              {creditDisplay.primary}
            </Text>
            {creditDisplay.secondary ? (
              <Text
                style={{
                  fontSize: 13,
                  color: C.textSub,
                  marginTop: 4,
                  letterSpacing: -0.05,
                }}
              >
                {creditDisplay.secondary}
              </Text>
            ) : null}
            {showCreditProgress ? (
              <View
                style={{
                  marginTop: 12,
                  height: 4,
                  borderRadius: 2,
                  backgroundColor: 'rgba(255,255,255,0.08)',
                  overflow: 'hidden',
                }}
              >
                <View
                  style={{
                    height: '100%',
                    width: `${creditProgress * 100}%`,
                    backgroundColor: primaryColor,
                    borderRadius: 2,
                  }}
                />
              </View>
            ) : null}
          </View>

          {/* Divider */}
          <View style={{ height: 1, backgroundColor: C.separator, marginVertical: 24 }} />

          {/* Manage billing */}
          <Pressable
            accessibilityRole="button"
            onPress={onManage}
            disabled={portalBusy}
            hitSlop={8}
          >
            <Text
              style={{
                fontSize: 15,
                fontWeight: '600',
                color: portalBusy ? C.textMute : C.text,
                letterSpacing: -0.2,
              }}
            >
              {portalBusy ? 'Opening…' : 'Manage billing →'}
            </Text>
          </Pressable>
        </View>
      </View>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Plan card — price as the dominant element
// ---------------------------------------------------------------------------

function PlanCard({
  plan,
  onSubscribe,
  isLoading,
  isDisabled,
  primaryColor,
  index,
  subscribeLabel = 'Subscribe',
}: {
  plan: MembershipPlanDto;
  onSubscribe: () => void;
  isLoading: boolean;
  isDisabled: boolean;
  primaryColor: string;
  index: number;
  subscribeLabel?: string;
}) {
  const C = getColors();
  const priceStr = formatMoneyFromCents(plan.priceCents, plan.currency);
  const intervalStr = billingIntervalLabel(plan.billingInterval);
  const credits = creditsLabel(plan.classCredits);

  return (
    <Animated.View
      entering={FadeInDown.delay(index * 80).duration(420)}
      style={{ marginBottom: Space.cardGap }}
    >
      <View style={{ ...premiumCardStyle(C), padding: 26 }}>
        <Text
          style={{
            fontSize: 11,
            fontWeight: '700',
            letterSpacing: 1.2,
            textTransform: 'uppercase',
            color: C.textMute,
            marginBottom: 10,
          }}
        >
          {plan.name}
        </Text>

        <View style={{ flexDirection: 'row', alignItems: 'flex-end', marginBottom: 16 }}>
          <Text
            style={{
              fontSize: 48,
              fontWeight: '800',
              letterSpacing: -2,
              color: C.text,
              lineHeight: 52,
            }}
          >
            {priceStr}
          </Text>
          <Text
            style={{
              fontSize: 16,
              color: C.textMute,
              marginBottom: 8,
              marginLeft: 4,
              letterSpacing: -0.2,
            }}
          >
            {intervalStr}
          </Text>
        </View>

        {/* Description */}
        {plan.description ? (
          <Text
            style={{
              fontSize: 14,
              lineHeight: 22,
              color: C.textSub,
              marginBottom: 12,
              letterSpacing: -0.1,
            }}
          >
            {plan.description}
          </Text>
        ) : null}

        {credits ? (
          <View
            style={{
              alignSelf: 'flex-start',
              backgroundColor: 'rgba(255,255,255,0.05)',
              borderRadius: 8,
              paddingVertical: 6,
              paddingHorizontal: 10,
              marginBottom: 22,
              borderWidth: 1,
              borderColor: C.separator,
            }}
          >
            <Text style={{ fontSize: 12, color: C.textSub, letterSpacing: -0.05 }}>{credits}</Text>
          </View>
        ) : (
          <View style={{ marginBottom: 22 }} />
        )}

        <View style={{ height: 1, backgroundColor: C.separator, marginBottom: 20 }} />

        <BrandButton
          label={subscribeLabel}
          accentColor={primaryColor}
          loading={isLoading}
          disabled={isDisabled}
          onPress={onSubscribe}
        />
      </View>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Guest value proposition
// ---------------------------------------------------------------------------

function GuestMembershipPrompt({
  studioName,
  primaryColor,
  onRegister,
  onLogin,
}: {
  studioName: string;
  primaryColor: string;
  onRegister: () => void;
  onLogin: () => void;
}) {
  const C = getColors();
  return (
    <Animated.View entering={FadeInDown.duration(400)}>
      <View style={{ ...premiumCardStyle(C), padding: 28, marginBottom: 8 }}>
        <Text
          style={{
            fontSize: 26,
            fontWeight: '800',
            letterSpacing: -0.6,
            color: C.text,
            marginBottom: 10,
            lineHeight: 32,
          }}
        >
          Train with us.
        </Text>
        <Text
          style={{
            fontSize: 15,
            color: C.textSub,
            lineHeight: 22,
            marginBottom: 20,
          }}
        >
          {studioName
            ? `Browse plans at ${studioName}, pick up a Day Pass, or join with a membership.`
            : 'Browse plans, pick up a Day Pass, or join with a membership.'}
        </Text>
        <Text
          style={{
            fontSize: 14,
            color: C.textMute,
            lineHeight: 21,
            marginBottom: 24,
          }}
        >
          Create an account to subscribe, purchase a Day Pass, and book classes.
        </Text>
        <BrandButton label="Join Now" accentColor={primaryColor} onPress={onRegister} />
        <InlineAuthLink
          prompt="Already have an account?"
          action="Log in"
          onPress={onLogin}
        />
      </View>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// No-membership prompt
// ---------------------------------------------------------------------------

function NoMembershipPrompt({
  onManage,
  portalBusy,
}: {
  primaryColor: string;
  onManage: () => void;
  portalBusy: boolean;
}) {
  const C = getColors();
  return (
    <Animated.View entering={FadeInDown.duration(400)}>
      <View
        style={{
          ...premiumCardStyle(C),
          padding: 32,
          marginBottom: 8,
          alignItems: 'center',
        }}
      >
        <View
          style={{
            width: 48,
            height: 48,
            borderRadius: 24,
            backgroundColor: 'rgba(255,255,255,0.06)',
            borderWidth: 1,
            borderColor: C.separator,
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 18,
          }}
        >
          <Text style={{ fontSize: 20, color: C.textMute }}>◇</Text>
        </View>
        <Text
          style={{
            fontSize: 24,
            fontWeight: '800',
            letterSpacing: -0.5,
            color: C.text,
            textAlign: 'center',
            marginBottom: 10,
          }}
        >
          No active membership
        </Text>
        <Text
          style={{
            fontSize: 15,
            color: C.textSub,
            lineHeight: 22,
            textAlign: 'center',
            maxWidth: 240,
            marginBottom: 24,
          }}
        >
          Choose a plan below to unlock class booking.
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={onManage}
          disabled={portalBusy}
          hitSlop={8}
        >
          <Text style={{ fontSize: 15, fontWeight: '600', color: portalBusy ? C.textMute : C.text }}>
            {portalBusy ? 'Opening…' : 'Manage billing →'}
          </Text>
        </Pressable>
      </View>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Day Pass status config
// ---------------------------------------------------------------------------

function dayPassStatusConfig(status: DayPassStatus): {
  label: string;
  dotColor: string;
  bg: string;
  textColor: string;
} {
  const C = getColors();
  switch (status) {
    case 'ACTIVE':
      return { label: 'Active', dotColor: C.positive, bg: 'rgba(52,211,153,0.12)', textColor: C.positive };
    case 'PENDING':
      return { label: 'Pending', dotColor: C.caution, bg: 'rgba(251,191,36,0.12)', textColor: C.caution };
    case 'EXPIRED':
      return { label: 'Expired', dotColor: C.textMute, bg: 'rgba(255,255,255,0.06)', textColor: C.textMute };
    case 'REFUNDED':
      return { label: 'Refunded', dotColor: C.textMute, bg: 'rgba(255,255,255,0.06)', textColor: C.textMute };
  }
}

// ---------------------------------------------------------------------------
// Day Pass row — date on left, status pill on right
// ---------------------------------------------------------------------------

function DayPassRow({
  dayPass,
  timeZone,
  isLast = false,
}: {
  dayPass: DayPassDto;
  timeZone: string;
  isLast?: boolean;
}) {
  const C = getColors();
  const cfg = dayPassStatusConfig(dayPass.status);
  const dateLabel = new Intl.DateTimeFormat(undefined, {
    timeZone,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(dayPass.validForDate));

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 16,
        paddingHorizontal: 4,
        borderBottomWidth: isLast ? 0 : 1,
        borderBottomColor: C.separator,
      }}
    >
      <Text style={{ fontSize: 15, color: C.text, fontWeight: '500', letterSpacing: -0.2 }}>
        {dateLabel}
      </Text>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: cfg.bg,
          borderRadius: 100,
          paddingVertical: 4,
          paddingHorizontal: 10,
        }}
      >
        <View
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: cfg.dotColor,
            marginRight: 6,
          }}
        />
        <Text
          style={{
            fontSize: 10,
            fontWeight: '700',
            letterSpacing: 0.6,
            textTransform: 'uppercase',
            color: cfg.textColor,
          }}
        >
          {cfg.label}
        </Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function MembershipScreen() {
  const router = useRouter();
  const C = getColors();
  const { primaryColor, appDisplayName } = useBranding();
  const { user } = useAuth();
  const isGuest = user === null;
  const { matched } = useMemberStudio();
  const { studio: publicStudio, timezone: publicTimezone } = usePublicStudio();
  const { refresh: refreshStudioActivity } = useStudioActivity();
  const { initPaymentSheet, presentPaymentSheet } = useStripe();

  const studioId = matched?.studio.id;
  const timeZone = isGuest ? publicTimezone : (matched?.studio.timezone ?? 'UTC');
  const goToAuthLogin = (intent: AuthModalKind) =>
    router.push({
      pathname: '/(auth)/login',
      params: {
        returnTo: MEMBERSHIP_RETURN_TO,
        intent,
      },
    });
  const goToAuthRegister = (intent: AuthModalKind) =>
    router.push({
      pathname: '/(auth)/register',
      params: {
        returnTo: MEMBERSHIP_RETURN_TO,
        intent,
      },
    });
  const openAuthModal = (kind: AuthModalKind) => {
    setAuthModalKind(kind);
    setAuthModalVisible(true);
  };

  const [plans, setPlans] = useState<MembershipPlanDto[]>([]);
  const [profile, setProfile] = useState<MyMemberProfileDto | null>(null);
  const [dayPasses, setDayPasses] = useState<DayPassDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkoutPlanId, setCheckoutPlanId] = useState<string | null>(null);
  const [portalBusy, setPortalBusy] = useState(false);
  const [portalError, setPortalError] = useState<string | null>(null);
  const [dayPassBusy, setDayPassBusy] = useState(false);
  const [dayPassError, setDayPassError] = useState<string | null>(null);
  const [dayPassLoadError, setDayPassLoadError] = useState<string | null>(null);
  const [dayPassSuccess, setDayPassSuccess] = useState(false);
  const [authModalVisible, setAuthModalVisible] = useState(false);
  const [authModalKind, setAuthModalKind] = useState<AuthModalKind>('membership');
  const expectReturnFromBrowser = useRef(false);
  const hasLoadedOnce = useRef(false);
  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { hasLoadedOnce.current = false; }, [studioId, isGuest]);

  // Clear the success timer on unmount to avoid setState on an unmounted component.
  useEffect(() => {
    return () => {
      if (successTimer.current) clearTimeout(successTimer.current);
    };
  }, []);

  const loadDayPasses = useCallback(async () => {
    if (!studioId) return;
    try {
      const dp = await fetchMyDayPasses(studioId);
      setDayPasses(dp);
      setDayPassLoadError(null);
    } catch (e) {
      setDayPasses([]);
      setDayPassLoadError('Day passes are temporarily unavailable.');
      if (__DEV__) {
        console.warn('[Membership] fetchMyDayPasses failed:', e);
      }
    }
  }, [studioId]);

  const loadGuest = useCallback(async (mode: 'initial' | 'refresh') => {
    const slug = getStudioSlug();
    if (!slug) {
      setError('App is missing studio configuration.');
      setLoading(false);
      return;
    }
    setError(null);
    if (mode === 'initial') setLoading(true);
    else setRefreshing(true);
    try {
      const p = await fetchPublicMembershipPlans(slug);
      setPlans(p.map(toMembershipPlanDto));
      setProfile(null);
      setDayPasses([]);
      setDayPassLoadError(null);
    } catch (e) {
      setError(userFacingApiMessage(e, 'Could not load membership plans. Pull to refresh.'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      if (!studioId) return;
      setError(null);
      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);

      void loadDayPasses();

      try {
        const [p, prof] = await Promise.all([
          fetchMembershipPlans(studioId),
          fetchMyMemberProfile(studioId),
        ]);
        setPlans(p);
        setProfile(prof);
      } catch (e) {
        setError(userFacingApiMessage(e, 'Could not load membership info. Pull to refresh.'));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [studioId, loadDayPasses],
  );

  useFocusEffect(
    useCallback(() => {
      const mode = hasLoadedOnce.current ? 'refresh' : 'initial';
      hasLoadedOnce.current = true;
      if (isGuest) {
        void loadGuest(mode);
        return;
      }
      if (!studioId) { setLoading(false); return; }
      void load(mode);
      void refreshStudioActivity();
    }, [isGuest, studioId, loadGuest, load, refreshStudioActivity]),
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || isGuest || !studioId) return;
      if (!expectReturnFromBrowser.current) return;
      expectReturnFromBrowser.current = false;
      void load('refresh');
      void refreshStudioActivity();
    });
    return () => sub.remove();
  }, [isGuest, studioId, load, refreshStudioActivity]);

  async function openCheckout(planId: string) {
    if (isGuest) { openAuthModal('membership'); return; }
    if (!studioId) return;
    setCheckoutPlanId(planId);
    try {
      const { url } = await createMembershipCheckoutSession(studioId, planId);
      expectReturnFromBrowser.current = true;
      await Linking.openURL(url);
    } catch (e) {
      expectReturnFromBrowser.current = false;
      setError(userFacingApiMessage(e, 'Checkout could not be started. Please try again.'));
    } finally {
      setCheckoutPlanId(null);
    }
  }

  async function openPortal() {
    if (!studioId) return;
    setPortalError(null);
    setPortalBusy(true);
    try {
      const { url } = await createBillingPortalSession(studioId);
      expectReturnFromBrowser.current = true;
      await Linking.openURL(url);
    } catch (e) {
      expectReturnFromBrowser.current = false;
      setPortalError(userFacingApiMessage(e, 'Billing could not be opened. Please try again.'));
    } finally {
      setPortalBusy(false);
    }
  }

  async function buyDayPass() {
    if (isGuest) { openAuthModal('day-pass'); return; }
    if (!studioId) return;
    setDayPassBusy(true);
    setDayPassError(null);
    setDayPassSuccess(false);
    try {
      const validForDate = todayKeyInZone(timeZone);
      const data = await createDayPassPaymentSheet(studioId, validForDate);

      // Set the Stripe key returned from the server before initializing the sheet.
      await initStripe({ publishableKey: data.publishableKey });

      const { error: initError } = await initPaymentSheet({
        merchantDisplayName: appDisplayName,
        paymentIntentClientSecret: data.paymentIntentClientSecret,
        customerId: data.customerId,
        customerEphemeralKeySecret: data.ephemeralKeySecret,
        allowsDelayedPaymentMethods: false,
        returnURL: createURL('billing/return'),
      });
      if (initError) {
        setDayPassError(initError.message);
        return;
      }

      const { error: presentError } = await presentPaymentSheet();
      if (presentError) {
        // Canceled is silent — the user dismissed the sheet intentionally.
        if ((presentError.code as string) === 'Canceled') return;
        setDayPassError(presentError.message);
        return;
      }

      // Payment completed. Show brief success feedback and reload day passes.
      setDayPassSuccess(true);
      if (successTimer.current) clearTimeout(successTimer.current);
      successTimer.current = setTimeout(() => setDayPassSuccess(false), 4000);
      void load('refresh');
    } catch (e) {
      setDayPassError(userFacingApiMessage(e, 'Could not start day pass purchase. Please try again.'));
    } finally {
      setDayPassBusy(false);
    }
  }

  const refresh = isGuest ? () => loadGuest('refresh') : () => { void load('refresh'); void refreshStudioActivity(); };

  if (!isGuest && (!studioId || !matched)) return <ScreenLoader />;
  if (error && !plans.length && !loading && (isGuest || !profile)) {
    return (
      <LoadRetryPanel
        message={error}
        onRetry={() => void (isGuest ? loadGuest('initial') : load('initial'))}
      />
    );
  }
  if (loading && !plans.length && (isGuest || !profile)) return <ScreenLoader />;

  const sub = profile?.activeSubscription;

  const renewsLabel = sub
    ? `Renews ${new Intl.DateTimeFormat(undefined, { timeZone, dateStyle: 'medium' }).format(
        new Date(sub.currentPeriodEnd),
      )}${sub.cancelAtPeriodEnd ? ' · Cancelling' : ''}`
    : '';

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['bottom', 'left', 'right']}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: Space.screenH, paddingBottom: TAB_BAR_CLEARANCE }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            tintColor={primaryColor}
          />
        }
      >
        {/* ── Page header ── */}
        <Animated.View entering={FadeInDown.duration(400)} style={{ paddingTop: 28, marginBottom: 32 }}>
          <Text
            style={{
              fontSize: 38,
              fontWeight: '800',
              letterSpacing: -1.3,
              color: C.text,
              lineHeight: 44,
            }}
          >
            Membership
          </Text>
          <Text
            style={{
              fontSize: 15,
              color: C.textSub,
              marginTop: 8,
              letterSpacing: -0.1,
              lineHeight: 22,
            }}
          >
            {appDisplayName}
          </Text>
        </Animated.View>

        {error ? (
          <Text style={{ fontSize: 13, color: C.negative, marginBottom: 16 }}>{error}</Text>
        ) : null}

        {/* ── Active card, member prompt, or guest value prop ── */}
        {isGuest ? (
          <GuestMembershipPrompt
            studioName={publicStudio?.name ?? ''}
            primaryColor={primaryColor}
            onRegister={() => openAuthModal('membership')}
            onLogin={() => goToAuthLogin('membership')}
          />
        ) : sub ? (
          <MembershipCard
            planName={sub.plan.name}
            status={sub.status}
            cancelAtPeriodEnd={sub.cancelAtPeriodEnd}
            renewsAt={renewsLabel}
            classCredits={sub.plan.classCredits}
            creditsUsed={sub.creditsUsed}
            creditsRemaining={sub.creditsRemaining}
            primaryColor={primaryColor}
            onManage={() => void openPortal()}
            portalBusy={portalBusy}
          />
        ) : (
          <NoMembershipPrompt
            primaryColor={primaryColor}
            onManage={() => void openPortal()}
            portalBusy={portalBusy}
          />
        )}

        {!isGuest && portalError ? (
          <Text style={{ fontSize: 13, color: C.negative, marginBottom: 16, textAlign: 'center', marginTop: 8 }}>
            {portalError}
          </Text>
        ) : null}

        {/* ── Available plans ── */}
        {plans.length > 0 ? (
          <View style={{ marginTop: Space.sectionGap }}>
            <SectionLabel>Available plans</SectionLabel>
            {plans.map((plan, i) => (
              <PlanCard
                key={plan.id}
                plan={plan}
                primaryColor={primaryColor}
                index={i}
                isLoading={!isGuest && checkoutPlanId === plan.id}
                isDisabled={!isGuest && checkoutPlanId !== null && checkoutPlanId !== plan.id}
                subscribeLabel={isGuest ? 'Join Now' : 'Subscribe'}
                onSubscribe={() => void (isGuest ? openAuthModal('membership') : openCheckout(plan.id))}
              />
            ))}
          </View>
        ) : loading ? (
          <View style={{ gap: 10, marginTop: Space.sectionGap }}>
            <Skeleton height={200} radius={20} />
            <Skeleton height={200} radius={20} />
          </View>
        ) : (
          <Text style={{ fontSize: 14, color: C.textMute, lineHeight: 22, marginTop: Space.sectionGap }}>
            No published plans yet. Check back later or contact the studio.
          </Text>
        )}

        {/* ── Day Pass ── */}
        <View style={{ marginTop: Space.sectionGap }}>
          <SectionLabel>Day Pass</SectionLabel>

          <Animated.View entering={FadeInDown.duration(420)}>
            <View
              style={{
                ...premiumCardStyle(C),
                overflow: 'hidden',
                marginBottom: Space.cardGap,
              }}
            >
              <View style={{ height: 3, backgroundColor: primaryColor }} />
              <View style={{ padding: 26 }}>
                <Text
                  style={{
                    fontSize: 11,
                    fontWeight: '700',
                    letterSpacing: 1.2,
                    textTransform: 'uppercase',
                    color: C.textMute,
                    marginBottom: 10,
                  }}
                >
                  One-day access
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'flex-end', marginBottom: 12 }}>
                  <Text
                    style={{
                      fontSize: 40,
                      fontWeight: '800',
                      letterSpacing: -1.6,
                      color: C.text,
                      lineHeight: 44,
                    }}
                  >
                    {formatMoneyFromCents(20000, 'mxn')}
                  </Text>
                </View>
                <Text
                  style={{
                    fontSize: 15,
                    lineHeight: 23,
                    color: C.textSub,
                    marginBottom: 22,
                    letterSpacing: -0.1,
                  }}
                >
                  Train for one day without a membership. Book any class on the day of your pass.
                </Text>

              {!isGuest && dayPassSuccess ? (
                <Text
                  style={{
                    fontSize: 14,
                    color: C.positive,
                    fontWeight: '600',
                    marginBottom: 12,
                    letterSpacing: -0.1,
                  }}
                >
                  Day Pass purchased!
                </Text>
              ) : null}

              {!isGuest && dayPassError ? (
                <Text style={{ fontSize: 13, color: C.negative, marginBottom: 12, lineHeight: 19 }}>
                  {dayPassError}
                </Text>
              ) : null}

                <BrandButton
                  label="Get Day Pass"
                  accentColor={primaryColor}
                  loading={!isGuest && dayPassBusy}
                  disabled={!isGuest && dayPassBusy}
                  onPress={() => void (isGuest ? openAuthModal('day-pass') : buyDayPass())}
                />
                {isGuest ? (
                  <InlineAuthLink
                    prompt="Already have an account?"
                    action="Log in"
                    onPress={() => goToAuthLogin('day-pass')}
                  />
                ) : null}
              </View>
            </View>
          </Animated.View>

          {!isGuest && dayPassLoadError ? (
            <Text style={{ fontSize: 12, color: C.textMute, lineHeight: 18, marginBottom: 12 }}>
              {dayPassLoadError}
            </Text>
          ) : null}

          {/* Active / pending day passes */}
          {!isGuest && dayPasses.length > 0 ? (
            <Animated.View entering={FadeInDown.duration(380)}>
              <SectionLabel>Your passes</SectionLabel>
              <View
                style={{
                  ...premiumCardStyle(C),
                  paddingHorizontal: 20,
                  overflow: 'hidden',
                }}
              >
                {dayPasses.map((dp, i) => (
                  <DayPassRow
                    key={dp.id}
                    dayPass={dp}
                    timeZone={timeZone}
                    isLast={i === dayPasses.length - 1}
                  />
                ))}
              </View>
            </Animated.View>
          ) : null}
        </View>
      </ScrollView>

      <AuthRequiredModal
        visible={authModalVisible}
        title={AUTH_MODAL_COPY[authModalKind].title}
        description={AUTH_MODAL_COPY[authModalKind].description}
        onPrimary={() => {
          setAuthModalVisible(false);
          goToAuthRegister(authModalKind);
        }}
        onSecondary={() => {
          setAuthModalVisible(false);
          goToAuthLogin(authModalKind);
        }}
        onClose={() => setAuthModalVisible(false)}
      />
    </SafeAreaView>
  );
}
