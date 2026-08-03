import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BrandButton } from '@/components/BrandButton';
import { TAB_BAR_CLEARANCE } from '@/components/FloatingTabBar';
import { LoadRetryPanel, Skeleton } from '@/components/StudioScreenChrome';
import { SectionOverline } from '@/components/staff/StaffPrimitives';
import { useBranding } from '@/contexts/BrandingContext';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import { getColors, Space } from '@/constants/Theme';
import {
  fetchFinancialActivity,
  type FinancialActivityDto,
  type FinancialActivityItemDto,
} from '@/lib/api/analyticsApi';
import { canAccessExecutiveDashboard } from '@/lib/executivePermissions';
import { formatMoneyFromCents } from '@/lib/formatMoney';
import { userFacingApiMessage } from '@/lib/userFacingApiMessage';

function fmtDateTime(iso: string): string {
  return new Intl.DateTimeFormat('es-MX', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

function ActivityRow({ item, currency }: { item: FinancialActivityItemDto; currency: string }) {
  const C = getColors();
  return (
    <View
      style={{
        paddingVertical: 14,
        borderBottomWidth: 1,
        borderBottomColor: C.separator,
        gap: 4,
      }}
    >
      <Text style={{ fontSize: 12, color: C.textMute }}>{fmtDateTime(item.occurredAt)}</Text>
      <Text style={{ fontSize: 15, fontWeight: '600', color: C.text }}>{item.member.name}</Text>
      <Text style={{ fontSize: 14, color: C.textSub }}>{item.eventLabel}</Text>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12, marginTop: 2 }}>
        <Text style={{ fontSize: 13, color: C.textSub }} numberOfLines={1}>
          {item.planName ?? '—'} · {item.methodLabel}
        </Text>
        <Text style={{ fontSize: 14, fontWeight: '600', color: C.text, fontVariant: ['tabular-nums'] }}>
          {item.amountCents != null
            ? formatMoneyFromCents(item.amountCents, item.currency || currency)
            : item.statusLabel}
        </Text>
      </View>
    </View>
  );
}

export default function FinancialActivityScreen() {
  const router = useRouter();
  const C = getColors();
  const { primaryColor } = useBranding();
  const { matched } = useMemberStudio();
  const studioId = matched?.studio.id ?? '';
  const role = matched?.role ?? null;
  const allowed = canAccessExecutiveDashboard(role);

  useEffect(() => {
    if (role != null && !allowed) {
      router.replace('/(app)/(staff-tabs)/profile' as import('expo-router').Href);
    }
  }, [role, allowed, router]);

  const [data, setData] = useState<FinancialActivityDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);

  const load = useCallback(
    async (isRefresh = false, nextCursor?: string | null) => {
      if (!studioId || !allowed) return;
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);

      const now = new Date();
      const from = new Date(now.getTime() - 30 * 86_400_000).toISOString();

      try {
        const result = await fetchFinancialActivity(studioId, {
          from,
          to: now.toISOString(),
          limit: 25,
          cursor: nextCursor ?? undefined,
        });
        if (nextCursor) {
          setData((prev) =>
            prev
              ? {
                  ...result,
                  items: [...prev.items, ...result.items],
                }
              : result,
          );
        } else {
          setData(result);
        }
        setCursor(result.pagination.nextCursor);
      } catch (e) {
        setError(userFacingApiMessage(e, 'No se pudo cargar la actividad'));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [studioId, allowed],
  );

  useFocusEffect(
    useCallback(() => {
      void load(false, null);
    }, [load]),
  );

  if (!allowed) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg, padding: Space.sp4 }}>
        <Text style={{ color: C.textSub, fontSize: 15 }}>
          Disponible solo para propietarios y administradores.
        </Text>
      </SafeAreaView>
    );
  }

  const currency = data?.currency ?? 'mxn';

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['top']}>
      <ScrollView
        contentContainerStyle={{ padding: Space.sp4, paddingBottom: TAB_BAR_CLEARANCE + Space.sp4 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void load(true, null)} />
        }
      >
        <Pressable onPress={() => router.back()} style={{ marginBottom: Space.sp3 }}>
          <Text style={{ fontSize: 15, color: C.textSub }}>← Panel</Text>
        </Pressable>

        <Text style={{ fontSize: 28, fontWeight: '700', color: C.text, letterSpacing: -0.5 }}>
          Actividad financiera
        </Text>
        <Text style={{ fontSize: 15, color: C.textSub, marginTop: 6, lineHeight: 22 }}>
          Pagos, renovaciones y movimientos recientes del estudio.
        </Text>

        {loading && !data ? <Skeleton style={{ marginTop: Space.sp4 }} /> : null}
        {error ? (
          <LoadRetryPanel message={error} onRetry={() => void load(false, null)} />
        ) : null}

        {data ? (
          <>
            <View
              style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                gap: 8,
                marginTop: Space.sp4,
                marginBottom: Space.sp3,
              }}
            >
              {[
                { label: 'Movimientos', value: String(data.summary.movementCount) },
                {
                  label: 'Stripe',
                  value: formatMoneyFromCents(data.summary.stripeCollectedCents, currency),
                },
                {
                  label: 'Efectivo',
                  value: formatMoneyFromCents(data.summary.cashCollectedCents, currency),
                },
              ].map((chip) => (
                <View
                  key={chip.label}
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    borderRadius: 12,
                    backgroundColor: C.surface1,
                    borderWidth: 1,
                    borderColor: C.separator,
                  }}
                >
                  <Text style={{ fontSize: 11, color: C.textMute }}>{chip.label}</Text>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: C.text, marginTop: 2 }}>
                    {chip.value}
                  </Text>
                </View>
              ))}
            </View>

            <SectionOverline>Últimos movimientos</SectionOverline>
            {data.items.map((item) => (
              <ActivityRow key={item.id} item={item} currency={currency} />
            ))}

            {data.pagination.hasMore ? (
              <View style={{ marginTop: Space.sp4 }}>
                <BrandButton
                  label="Cargar más"
                  variant="ghost"
                  accentColor={primaryColor}
                  onPress={() => void load(false, cursor)}
                />
              </View>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
