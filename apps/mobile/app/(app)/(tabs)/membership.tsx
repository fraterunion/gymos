import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  Linking,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BrandButton } from '@/components/BrandButton';
import { LoadRetryPanel, ScreenLoader } from '@/components/StudioScreenChrome';
import { useBranding } from '@/contexts/BrandingContext';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import { useStudioActivity } from '@/contexts/StudioActivityContext';
import { ApiError } from '@/lib/api/errors';
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

function billingIntervalLabel(interval: BillingInterval): string {
  switch (interval) {
    case 'MONTHLY':
      return 'per month';
    case 'YEARLY':
      return 'per year';
    case 'WEEKLY':
      return 'per week';
    default:
      return '';
  }
}

function creditsLabel(credits: number | null): string | null {
  if (credits === null) return 'Unlimited class visits';
  if (credits <= 0) return null;
  return `${credits} class credits / billing period`;
}

export default function MembershipScreen() {
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

  useEffect(() => {
    hasLoadedOnce.current = false;
  }, [studioId]);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      if (!studioId) return;
      setError(null);
      if (mode === 'initial') {
        setLoading(true);
      } else {
        setRefreshing(true);
      }
      try {
        const [p, prof] = await Promise.all([
          fetchMembershipPlans(studioId),
          fetchMyMemberProfile(studioId),
        ]);
        setPlans(p);
        setProfile(prof);
      } catch (e) {
        const msg = e instanceof ApiError ? e.message : 'Something went wrong.';
        setError(msg);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [studioId],
  );

  useFocusEffect(
    useCallback(() => {
      if (!studioId) {
        setLoading(false);
        return;
      }
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
      const msg = e instanceof ApiError ? e.message : 'Could not start checkout.';
      setError(msg);
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
      const msg = e instanceof ApiError ? e.message : 'Could not open billing portal.';
      setPortalError(msg);
    } finally {
      setPortalBusy(false);
    }
  }

  function onPullRefresh() {
    void load('refresh');
    void refreshStudioActivity();
  }

  if (!studioId || !matched) {
    return <ScreenLoader />;
  }

  if (error && !profile && !plans.length && !loading) {
    return <LoadRetryPanel message={error} onRetry={() => void load('initial')} />;
  }

  if (loading && !profile && !plans.length) {
    return <ScreenLoader />;
  }

  const sub = profile?.activeSubscription;

  return (
    <SafeAreaView className="flex-1 bg-neutral-50 dark:bg-neutral-950" edges={['bottom', 'left', 'right']}>
      <ScrollView
        className="flex-1 px-5 pt-2"
        contentContainerClassName="pb-12"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onPullRefresh} tintColor={primaryColor} />
        }>
        <Text className="text-2xl font-semibold text-neutral-900 dark:text-neutral-50">Membership</Text>
        <Text className="mt-2 text-base text-neutral-600 dark:text-neutral-400">
          Plans and billing for {appDisplayName}. Subscription status is confirmed by the studio after checkout —
          refresh this screen when you return from the browser.
        </Text>

        {error ? (
          <Text className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</Text>
        ) : null}

        <View className="mt-8 rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
          <Text className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
            Your subscription
          </Text>
          {sub ? (
            <View className="mt-3">
              <Text className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">{sub.plan.name}</Text>
              <Text className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                Status · {sub.status}
                {sub.cancelAtPeriodEnd ? ' · Cancels at period end' : ''}
              </Text>
              <Text className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
                Current period ·{' '}
                {new Intl.DateTimeFormat(undefined, {
                  timeZone,
                  dateStyle: 'medium',
                }).format(new Date(sub.currentPeriodEnd))}
              </Text>
              {sub.plan.classCredits !== null ? (
                <Text className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                  {creditsLabel(sub.plan.classCredits)}
                </Text>
              ) : (
                <Text className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                  {creditsLabel(null)}
                </Text>
              )}
            </View>
          ) : (
            <Text className="mt-3 text-base text-neutral-600 dark:text-neutral-400">
              No active subscription on file for this studio. Subscribe to a plan below to book classes.
            </Text>
          )}
          <View className="mt-5">
            <BrandButton
              label="Manage billing"
              variant="ghost"
              accentColor={primaryColor}
              loading={portalBusy}
              onPress={() => void openPortal()}
            />
            {portalError ? (
              <Text className="mt-2 text-center text-sm text-neutral-600 dark:text-neutral-400">{portalError}</Text>
            ) : null}
          </View>
        </View>

        <View className="mt-10">
          <Text className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">Available plans</Text>
          {plans.length === 0 ? (
            <Text className="mt-3 text-base text-neutral-600 dark:text-neutral-400">
              There are no published plans yet. Check back later or contact the studio.
            </Text>
          ) : (
            <View className="mt-4 gap-4">
              {plans.map((plan) => (
                <View
                  key={plan.id}
                  className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
                  <View className="flex-row items-start justify-between gap-3">
                    <View className="min-w-0 flex-1">
                      <Text className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">{plan.name}</Text>
                      {plan.description ? (
                        <Text className="mt-2 text-sm leading-5 text-neutral-600 dark:text-neutral-400">
                          {plan.description}
                        </Text>
                      ) : null}
                    </View>
                    <FontAwesome name="star" size={20} color={primaryColor} style={{ marginTop: 2 }} />
                  </View>
                  <Text className="mt-4 text-2xl font-semibold text-neutral-900 dark:text-neutral-50">
                    {formatMoneyFromCents(plan.priceCents, plan.currency)}
                    <Text className="text-base font-normal text-neutral-500 dark:text-neutral-400">
                      {' '}
                      · {billingIntervalLabel(plan.billingInterval)}
                    </Text>
                  </Text>
                  {creditsLabel(plan.classCredits) ? (
                    <Text className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
                      {creditsLabel(plan.classCredits)}
                    </Text>
                  ) : null}
                  <View className="mt-5">
                    <BrandButton
                      label="Subscribe"
                      accentColor={primaryColor}
                      loading={checkoutPlanId === plan.id}
                      disabled={checkoutPlanId !== null && checkoutPlanId !== plan.id}
                      onPress={() => void openCheckout(plan.id)}
                    />
                  </View>
                </View>
              ))}
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
