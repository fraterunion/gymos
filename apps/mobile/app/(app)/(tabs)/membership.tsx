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
import { getColors, Space } from '@/constants/Theme';

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

// ---------------------------------------------------------------------------
// Active membership — physical luxury card
// ---------------------------------------------------------------------------

function MembershipCard({
  planName,
  status,
  cancelAtPeriodEnd,
  renewsAt,
  primaryColor,
  onManage,
  portalBusy,
}: {
  planName: string;
  status: string;
  cancelAtPeriodEnd: boolean;
  renewsAt: string;
  primaryColor: string;
  onManage: () => void;
  portalBusy: boolean;
}) {
  const C = getColors();
  const cfg = statusConfig(status, cancelAtPeriodEnd);
  const accentBarColor = (status === 'ACTIVE' || status === 'TRIALING') ? primaryColor : C.surface3;

  return (
    <Animated.View entering={FadeInDown.duration(450)}>
      {/* Card outer — layered for depth */}
      <View
        style={{
          backgroundColor: '#1C1C1C',
          borderRadius: 24,
          overflow: 'hidden',
          marginBottom: 8,
        }}
      >
        {/* Top accent bar */}
        <View style={{ height: 4, backgroundColor: accentBarColor }} />

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
                fontWeight: '700',
                color: portalBusy ? C.textMute : primaryColor,
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
      <View
        style={{
          backgroundColor: C.surface2,
          borderRadius: 20,
          padding: 26,
        }}
      >
        {/* Plan name — editorial uppercase label */}
        <Text
          style={{
            fontSize: 11,
            fontWeight: '700',
            letterSpacing: 1.0,
            textTransform: 'uppercase',
            color: C.textMute,
            marginBottom: 8,
          }}
        >
          {plan.name}
        </Text>

        {/* Price — the unmistakable hero */}
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', marginBottom: 18 }}>
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

        {/* Credits */}
        {credits ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 22 }}>
            <View style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: C.textMute, marginRight: 8 }} />
            <Text style={{ fontSize: 13, color: C.textMute }}>{credits}</Text>
          </View>
        ) : (
          <View style={{ marginBottom: 22 }} />
        )}

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
  onLogin,
}: {
  studioName: string;
  primaryColor: string;
  onLogin: () => void;
}) {
  const C = getColors();
  return (
    <Animated.View entering={FadeInDown.duration(400)}>
      <View
        style={{
          backgroundColor: C.surface1,
          borderRadius: 20,
          padding: 28,
          marginBottom: 8,
        }}
      >
        <Text
          style={{
            fontSize: 22,
            fontWeight: '800',
            letterSpacing: -0.5,
            color: C.text,
            marginBottom: 10,
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
          Log in to subscribe, purchase a Day Pass, and book classes.
        </Text>
        <BrandButton label="Log in to Join" accentColor={primaryColor} onPress={onLogin} />
      </View>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// No-membership prompt
// ---------------------------------------------------------------------------

function NoMembershipPrompt({
  primaryColor,
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
          backgroundColor: C.surface1,
          borderRadius: 20,
          padding: 28,
          marginBottom: 8,
          alignItems: 'center',
        }}
      >
        <Text
          style={{
            fontSize: 22,
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
          <Text style={{ fontSize: 15, fontWeight: '700', color: portalBusy ? C.textMute : primaryColor }}>
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

function DayPassRow({ dayPass, timeZone }: { dayPass: DayPassDto; timeZone: string }) {
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
        paddingVertical: 14,
        borderBottomWidth: 1,
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
  const goToLogin = () => router.push('/(auth)/login');

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
    if (isGuest) { goToLogin(); return; }
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
    if (isGuest) { goToLogin(); return; }
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
        <Animated.View entering={FadeInDown.duration(400)} style={{ paddingTop: 28, marginBottom: 28 }}>
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
          <Text style={{ fontSize: 14, color: C.textMute, marginTop: 6 }}>
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
            onLogin={goToLogin}
          />
        ) : sub ? (
          <MembershipCard
            planName={sub.plan.name}
            status={sub.status}
            cancelAtPeriodEnd={sub.cancelAtPeriodEnd}
            renewsAt={renewsLabel}
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
              Available plans
            </Text>
            {plans.map((plan, i) => (
              <PlanCard
                key={plan.id}
                plan={plan}
                primaryColor={primaryColor}
                index={i}
                isLoading={!isGuest && checkoutPlanId === plan.id}
                isDisabled={!isGuest && checkoutPlanId !== null && checkoutPlanId !== plan.id}
                subscribeLabel={isGuest ? 'Log in to Join' : 'Subscribe'}
                onSubscribe={() => void (isGuest ? goToLogin() : openCheckout(plan.id))}
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
            Day Pass
          </Text>

          <Animated.View entering={FadeInDown.duration(420)}>
            <View
              style={{
                backgroundColor: C.surface2,
                borderRadius: 20,
                padding: 26,
                marginBottom: Space.cardGap,
              }}
            >
              <Text
                style={{
                  fontSize: 11,
                  fontWeight: '700',
                  letterSpacing: 1.0,
                  textTransform: 'uppercase',
                  color: C.textMute,
                  marginBottom: 8,
                }}
              >
                One-Day Access
              </Text>
              <Text
                style={{
                  fontSize: 15,
                  lineHeight: 22,
                  color: C.textSub,
                  marginBottom: 22,
                  letterSpacing: -0.1,
                }}
              >
                Train for one day without a membership.
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
                label={
                  isGuest
                    ? `Log in to Get Day Pass — ${formatMoneyFromCents(20000, 'mxn')}`
                    : `Get Day Pass — ${formatMoneyFromCents(20000, 'mxn')}`
                }
                accentColor={primaryColor}
                loading={!isGuest && dayPassBusy}
                disabled={!isGuest && dayPassBusy}
                onPress={() => void (isGuest ? goToLogin() : buyDayPass())}
              />
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
              {dayPasses.map((dp) => (
                <DayPassRow key={dp.id} dayPass={dp} timeZone={timeZone} />
              ))}
            </Animated.View>
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
