import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  useColorScheme,
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
// Active membership card (physical card aesthetic)
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
  const scheme = useColorScheme();
  const C = getColors(scheme);
  const isActive = status === 'ACTIVE' || status === 'TRIALING';

  return (
    <Animated.View entering={FadeInDown.duration(450)}>
      <View
        style={{
          backgroundColor: C.surface2,
          borderRadius: 20,
          padding: 24,
          marginBottom: 8,
        }}
      >
        {/* Top row: status dot */}
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 20 }}>
          <View
            style={{
              width: 7,
              height: 7,
              borderRadius: 4,
              backgroundColor: isActive ? C.positive : C.textMute,
              marginRight: 7,
            }}
          />
          <Text
            style={{
              fontSize: 11,
              fontWeight: '600',
              letterSpacing: 0.7,
              textTransform: 'uppercase',
              color: isActive ? C.positive : C.textMute,
            }}
          >
            {isActive ? 'Active' : status.toLowerCase()}
          </Text>
        </View>

        {/* Plan name — the headline */}
        <Text
          style={{
            fontSize: 24,
            fontWeight: '700',
            letterSpacing: -0.4,
            color: C.text,
            marginBottom: 8,
          }}
        >
          {planName}
        </Text>

        {/* Renewal */}
        <Text style={{ fontSize: 13, color: C.textMute }}>
          {renewsAt}
        </Text>

        {/* Separator */}
        <View style={{ height: 1, backgroundColor: C.separator, marginVertical: 20 }} />

        {/* Manage billing */}
        <Pressable
          accessibilityRole="button"
          onPress={onManage}
          disabled={portalBusy}
          hitSlop={8}
        >
          <Text
            style={{
              fontSize: 14,
              fontWeight: '600',
              color: portalBusy ? C.textMute : primaryColor,
            }}
          >
            {portalBusy ? 'Opening…' : 'Manage billing →'}
          </Text>
        </Pressable>
      </View>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Plan card
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
  const scheme = useColorScheme();
  const C = getColors(scheme);

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
          padding: 24,
        }}
      >
        {/* Plan name */}
        <Text
          style={{
            fontSize: 17,
            fontWeight: '600',
            letterSpacing: -0.2,
            color: C.text,
            marginBottom: 4,
          }}
        >
          {plan.name}
        </Text>

        {/* Price — the hero element */}
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', marginBottom: 16, marginTop: 8 }}>
          <Text
            style={{
              fontSize: 36,
              fontWeight: '700',
              letterSpacing: -1,
              color: C.text,
              lineHeight: 42,
            }}
          >
            {priceStr}
          </Text>
          <Text
            style={{
              fontSize: 14,
              color: C.textMute,
              marginBottom: 6,
              marginLeft: 4,
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
              lineHeight: 21,
              color: C.textSub,
              marginBottom: 12,
            }}
          >
            {plan.description}
          </Text>
        ) : null}

        {/* Credits */}
        {credits ? (
          <Text style={{ fontSize: 13, color: C.textMute, marginBottom: 20 }}>
            {credits}
          </Text>
        ) : (
          <View style={{ marginBottom: 20 }} />
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
// Screen
// ---------------------------------------------------------------------------

export default function MembershipScreen() {
  const scheme = useColorScheme();
  const C = getColors(scheme);
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
        contentContainerStyle={{ paddingHorizontal: Space.screenH, paddingBottom: 48 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { void load('refresh'); void refreshStudioActivity(); }}
            tintColor={primaryColor}
          />
        }
      >
        {/* ── Page title ── */}
        <View style={{ paddingTop: 28, marginBottom: 24 }}>
          <Text
            style={{
              fontSize: 30,
              fontWeight: '700',
              letterSpacing: -0.7,
              color: C.text,
            }}
          >
            Membership
          </Text>
          <Text style={{ fontSize: 14, color: C.textMute, marginTop: 6 }}>
            {appDisplayName}
          </Text>
        </View>

        {error ? (
          <Text style={{ fontSize: 13, color: C.negative, marginBottom: 16 }}>{error}</Text>
        ) : null}

        {/* ── Active subscription card ── */}
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
          // No subscription — show skeleton row or "choose a plan" prompt
          <View style={{ marginBottom: Space.sectionGap }}>
            <View
              style={{
                backgroundColor: C.surface1,
                borderRadius: 16,
                paddingHorizontal: Space.cardH,
                paddingVertical: 20,
              }}
            >
              <Text style={{ fontSize: 15, color: C.textSub, lineHeight: 22 }}>
                No active membership. Choose a plan below to unlock booking.
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => void openPortal()}
                disabled={portalBusy}
                hitSlop={8}
                style={{ marginTop: 14 }}
              >
                <Text style={{ fontSize: 14, fontWeight: '600', color: portalBusy ? C.textMute : primaryColor }}>
                  {portalBusy ? 'Opening…' : 'Manage billing →'}
                </Text>
              </Pressable>
            </View>
          </View>
        )}

        {portalError ? (
          <Text style={{ fontSize: 13, color: C.negative, marginBottom: 16, textAlign: 'center' }}>
            {portalError}
          </Text>
        ) : null}

        {/* ── Plans ── */}
        {plans.length > 0 ? (
          <View style={{ marginTop: sub ? Space.sectionGap : 0 }}>
            <Text
              style={{
                fontSize: 11,
                fontWeight: '600',
                letterSpacing: 0.8,
                textTransform: 'uppercase',
                color: C.textMute,
                marginBottom: 16,
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
            <Skeleton height={180} radius={20} />
            <Skeleton height={180} radius={20} />
          </View>
        ) : (
          <Text style={{ fontSize: 14, color: C.textMute, lineHeight: 21, marginTop: Space.sectionGap }}>
            No published plans yet. Check back later or contact the studio.
          </Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
