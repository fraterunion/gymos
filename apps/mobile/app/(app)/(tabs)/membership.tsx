import { useFocusEffect } from 'expo-router';
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
import { useBranding } from '@/contexts/BrandingContext';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import { useStudioActivity } from '@/contexts/StudioActivityContext';
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
import { formatMoneyFromCents } from '@/lib/formatMoney';
import { getColors, Space } from '@/constants/Theme';

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
  renewsAt,
  primaryColor,
  onManage,
  portalBusy,
}: {
  planName: string;
  status: string;
  renewsAt: string;
  primaryColor: string;
  onManage: () => void;
  portalBusy: boolean;
}) {
  const C = getColors();
  const isActive = status === 'ACTIVE' || status === 'TRIALING';
  const isCancelling = status === 'ACTIVE' && renewsAt.includes('Cancelling');

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
        <View style={{ height: 4, backgroundColor: isActive ? primaryColor : C.surface3 }} />

        <View style={{ padding: 28 }}>
          {/* Status pill */}
          <View
            style={{
              alignSelf: 'flex-start',
              flexDirection: 'row',
              alignItems: 'center',
              backgroundColor: isActive
                ? 'rgba(52,211,153,0.12)'
                : 'rgba(255,255,255,0.06)',
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
                backgroundColor: isCancelling
                  ? C.caution
                  : isActive
                  ? C.positive
                  : C.textMute,
                marginRight: 6,
              }}
            />
            <Text
              style={{
                fontSize: 11,
                fontWeight: '700',
                letterSpacing: 0.6,
                textTransform: 'uppercase',
                color: isCancelling ? C.caution : isActive ? C.positive : C.textMute,
              }}
            >
              {isCancelling ? 'Cancelling' : isActive ? 'Active' : status.toLowerCase()}
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
}: {
  plan: MembershipPlanDto;
  onSubscribe: () => void;
  isLoading: boolean;
  isDisabled: boolean;
  primaryColor: string;
  index: number;
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
          label="Subscribe"
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
// Screen
// ---------------------------------------------------------------------------

export default function MembershipScreen() {
  const C = getColors();
  const { primaryColor, appDisplayName } = useBranding();
  const { matched } = useMemberStudio();
  const { refresh: refreshStudioActivity } = useStudioActivity();

  const studioId = matched?.studio.id;
  const timeZone = matched?.studio.timezone ?? 'UTC';

  const [plans, setPlans] = useState<MembershipPlanDto[]>([]);
  const [profile, setProfile] = useState<MyMemberProfileDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkoutPlanId, setCheckoutPlanId] = useState<string | null>(null);
  const [portalBusy, setPortalBusy] = useState(false);
  const [portalError, setPortalError] = useState<string | null>(null);
  const expectReturnFromBrowser = useRef(false);
  const hasLoadedOnce = useRef(false);

  useEffect(() => { hasLoadedOnce.current = false; }, [studioId]);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      if (!studioId) return;
      setError(null);
      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);
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
    [studioId],
  );

  useFocusEffect(
    useCallback(() => {
      if (!studioId) { setLoading(false); return; }
      const mode = hasLoadedOnce.current ? 'refresh' : 'initial';
      hasLoadedOnce.current = true;
      void load(mode);
      void refreshStudioActivity();
    }, [studioId, load, refreshStudioActivity]),
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || !studioId) return;
      if (!expectReturnFromBrowser.current) return;
      expectReturnFromBrowser.current = false;
      void load('refresh');
      void refreshStudioActivity();
    });
    return () => sub.remove();
  }, [studioId, load, refreshStudioActivity]);

  async function openCheckout(planId: string) {
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

  if (!studioId || !matched) return <ScreenLoader />;
  if (error && !profile && !plans.length && !loading) {
    return <LoadRetryPanel message={error} onRetry={() => void load('initial')} />;
  }
  if (loading && !profile && !plans.length) return <ScreenLoader />;

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
        contentContainerStyle={{ paddingHorizontal: Space.screenH, paddingBottom: 56 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { void load('refresh'); void refreshStudioActivity(); }}
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

        {/* ── Active card or no-membership prompt ── */}
        {sub ? (
          <MembershipCard
            planName={sub.plan.name}
            status={sub.status}
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

        {portalError ? (
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
                isLoading={checkoutPlanId === plan.id}
                isDisabled={checkoutPlanId !== null && checkoutPlanId !== plan.id}
                onSubscribe={() => void openCheckout(plan.id)}
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
      </ScrollView>
    </SafeAreaView>
  );
}
