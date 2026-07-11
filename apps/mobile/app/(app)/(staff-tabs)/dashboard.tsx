import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { BrandButton } from '@/components/BrandButton';
import { TAB_BAR_CLEARANCE } from '@/components/FloatingTabBar';
import { LoadRetryPanel, Skeleton } from '@/components/StudioScreenChrome';
import {
  QuickActionTile,
  SectionOverline,
  SummaryStrip,
  TodayClassRow,
} from '@/components/staff/StaffPrimitives';
import { useBranding } from '@/contexts/BrandingContext';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import { getColors, Space } from '@/constants/Theme';
import {
  fetchAnalyticsBusiness,
  fetchAnalyticsClassBreakdown,
  fetchAnalyticsFinancial,
  type BusinessAnalyticsDto,
  type ClassBreakdownDto,
  type FinancialSummaryDto,
} from '@/lib/api/analyticsApi';
import { PanelAnalytics } from '@/components/staff/AnalyticsCharts';
import { type TodayClassSummaryDto } from '@/lib/api/scheduleApi';
import { canAccessExecutiveDashboard } from '@/lib/executivePermissions';
import { membersDirectoryHref } from '@/lib/memberProfileRoutes';
import { formatMoneyFromCents } from '@/lib/formatMoney';
import { formatClassTime } from '@/lib/datetime';
import { loadStaffTodayClasses } from '@/lib/staffTodaySchedule';
import { staffClassRosterHref } from '@/lib/staffClassRosterRoutes';
import { userFacingApiMessage } from '@/lib/userFacingApiMessage';

function formatMonthLabel(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('es-MX', { month: 'long', year: 'numeric', timeZone }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat('es-MX', { month: 'long', year: 'numeric' }).format(new Date());
  }
}

function isClassNow(c: TodayClassSummaryDto): boolean {
  const now = Date.now();
  return new Date(c.startsAt).getTime() <= now && now < new Date(c.endsAt).getTime();
}

type DashboardData = {
  financial: FinancialSummaryDto | null;
  business: BusinessAnalyticsDto | null;
  classes: TodayClassSummaryDto[];
  classBreakdown: ClassBreakdownDto | null;
  financialError: string | null;
  businessError: string | null;
  classesError: string | null;
  breakdownError: string | null;
  loadedAt: string;
};

type Alert = { key: string; label: string; severity: 'caution' | 'negative' };

export default function ExecutiveDashboardScreen() {
  const router = useRouter();
  const C = getColors();
  const { primaryColor } = useBranding();
  const { matched } = useMemberStudio();
  const role = matched?.role ?? null;
  const studioId = matched?.studio.id ?? '';
  const timeZone = matched?.studio.timezone ?? 'UTC';

  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);

  const allowed = canAccessExecutiveDashboard(role);

  const load = useCallback(
    async (isRefresh = false) => {
      if (!studioId || !allowed) return;
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setFatalError(null);

      const [financialResult, businessResult, classesResult, breakdownResult] = await Promise.all([
        fetchAnalyticsFinancial(studioId, 'month').then(
          (financial) => ({ financial, error: null as string | null }),
          (e) => ({ financial: null, error: userFacingApiMessage(e, 'No se pudieron cargar datos financieros') }),
        ),
        fetchAnalyticsBusiness(studioId).then(
          (business) => ({ business, error: null as string | null }),
          (e) => ({ business: null, error: userFacingApiMessage(e, 'No se pudieron cargar ingresos') }),
        ),
        loadStaffTodayClasses(studioId, timeZone).then(
          (classes) => ({ classes, error: null as string | null }),
          (e) => ({
            classes: [] as TodayClassSummaryDto[],
            error: userFacingApiMessage(e, 'No se pudo cargar el horario de hoy'),
          }),
        ),
        fetchAnalyticsClassBreakdown(studioId).then(
          (classBreakdown) => ({ classBreakdown, error: null as string | null }),
          (e) => ({
            classBreakdown: null,
            error: userFacingApiMessage(e, 'No se pudieron cargar las analíticas'),
          }),
        ),
      ]);

      const allFailed = !financialResult.financial && classesResult.classes.length === 0;
      if (allFailed && financialResult.error) {
        setFatalError(financialResult.error);
      }

      setData({
        financial: financialResult.financial,
        business: businessResult.business,
        classes: classesResult.classes,
        classBreakdown: breakdownResult.classBreakdown,
        financialError: financialResult.error,
        businessError: businessResult.error,
        classesError: classesResult.error,
        breakdownError: breakdownResult.error,
        loadedAt: new Date().toISOString(),
      });

      setLoading(false);
      setRefreshing(false);
    },
    [studioId, allowed, timeZone],
  );

  useFocusEffect(
    useCallback(() => {
      if (studioId && allowed) void load();
    }, [studioId, allowed, load]),
  );

  const metrics = useMemo(() => {
    if (!data?.financial) return null;
    const kpi = data.financial.kpis.totalCollected;
    return {
      revenueMonthCents: kpi.cents ?? 0,
      pct: kpi.comparisonPercent ?? null,
    };
  }, [data]);

  const alerts = useMemo<Alert[]>(() => {
    if (!data) return [];
    const result: Alert[] = [];
    const pastDue = data.business?.pastDueSubscriptions ?? 0;
    if (pastDue > 0) {
      result.push({
        key: 'past-due',
        label: `${pastDue} suscripción${pastDue === 1 ? '' : 'es'} vencida${pastDue === 1 ? '' : 's'}`,
        severity: 'negative',
      });
    }
    for (const c of data.classes) {
      if (c.status === 'CANCELLED') {
        result.push({ key: `cancelled-${c.scheduledClassId}`, label: `${c.className} cancelada hoy`, severity: 'caution' });
      }
    }
    for (const c of data.classes) {
      if (c.capacity > 0 && c.bookedCount >= c.capacity && c.status !== 'CANCELLED') {
        result.push({ key: `full-${c.scheduledClassId}`, label: `${c.className} al tope`, severity: 'caution' });
      }
    }
    return result;
  }, [data]);

  const openRoster = useCallback(
    (classId: string, className: string) => {
      router.push(staffClassRosterHref(classId, className));
    },
    [router],
  );

  if (!allowed) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 32 }}>
          <Text style={{ textAlign: 'center', fontSize: 15, lineHeight: 22, color: C.textSub, marginBottom: 24 }}>
            El panel ejecutivo está disponible solo para propietarios y administradores.
          </Text>
          <BrandButton label="Volver" accentColor={primaryColor} variant="ghost" onPress={() => router.back()} />
        </View>
      </SafeAreaView>
    );
  }

  if (!studioId) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <LoadRetryPanel message="No pudimos cargar tu estudio." onRetry={() => void load()} />
      </SafeAreaView>
    );
  }

  if (loading && !data) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <ScrollView contentContainerStyle={{ paddingHorizontal: Space.screenH, paddingTop: 32 }}>
          <Skeleton height={60} width="68%" />
          <Skeleton height={14} width="30%" style={{ marginTop: 8 }} />
          <Skeleton height={13} width="28%" style={{ marginTop: 6 }} />
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (fatalError && !data) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <LoadRetryPanel message={fatalError} onRetry={() => void load()} />
      </SafeAreaView>
    );
  }

  const monthLabel = formatMonthLabel(timeZone);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['left', 'right', 'top']}>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: Space.screenH, paddingBottom: TAB_BAR_CLEARANCE }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} tintColor="rgba(255,255,255,0.35)" />
        }
      >
        {/* ── Revenue hero ── */}
        {data?.financial && metrics ? (
          <Animated.View entering={FadeInDown.duration(300)} style={{ paddingTop: 32, marginBottom: Space.sp3 }}>
            <Text
              style={{
                fontSize: 52,
                fontWeight: '800',
                letterSpacing: -2.2,
                color: C.text,
                lineHeight: 56,
                marginBottom: 6,
                fontVariant: ['tabular-nums'],
              }}
            >
              {formatMoneyFromCents(metrics.revenueMonthCents, 'mxn')}
            </Text>
            <Text
              style={{
                fontSize: 11,
                fontWeight: '600',
                letterSpacing: 1,
                textTransform: 'uppercase',
                color: C.textMute,
                marginBottom: Space.sp1,
              }}
            >
              INGRESOS · {monthLabel}
            </Text>
            {metrics.pct !== null ? (
              <Text
                style={{
                  fontSize: 13,
                  fontWeight: '500',
                  color: metrics.pct >= 0 ? C.positive : C.negative,
                  fontVariant: ['tabular-nums'],
                }}
              >
                {metrics.pct >= 0 ? '+' : ''}{metrics.pct}% vs mes anterior
              </Text>
            ) : null}
          </Animated.View>
        ) : (
          <View style={{ paddingTop: 32, marginBottom: Space.sp3 }} />
        )}

        {/* ── Operational KPIs — four instruments, no chrome ── */}
        {data ? (() => {
          const totalBooked = data.classes.reduce((s, c) => s + c.bookedCount, 0);
          const totalCheckedIn = data.classes.reduce((s, c) => s + c.checkedInCount, 0);
          const attendancePct = totalBooked > 0 ? Math.round((totalCheckedIn / totalBooked) * 100) : 0;
          return (
            <SummaryStrip
              items={[
                { value: String(data.classes.length), label: 'Clases' },
                { value: String(totalBooked), label: 'Reservas' },
                { value: String(totalCheckedIn), label: 'Check-ins' },
                { value: `${attendancePct}%`, label: 'Asistencia' },
              ]}
            />
          );
        })() : null}

        {/* ── Today's schedule ── */}
        <SectionOverline>Hoy</SectionOverline>
        {data?.classes.length === 0 ? (
          <Animated.View entering={FadeInDown.duration(300)} style={{ marginTop: 8, marginBottom: Space.sp4 }}>
            <Text style={{ fontSize: 17, fontWeight: '600', color: C.text }}>Sin clases hoy.</Text>
            <Text style={{ fontSize: 14, color: C.textSub, marginTop: 6, lineHeight: 21 }}>
              El horario de hoy está libre.
            </Text>
          </Animated.View>
        ) : (
          <View style={{ marginBottom: Space.sp4 }}>
            {data?.classes.map((item, index) => (
              <TodayClassRow
                key={item.scheduledClassId}
                time={formatClassTime(item.startsAt, timeZone)}
                className={item.className}
                booked={item.bookedCount}
                capacity={item.capacity}
                isNow={isClassNow(item)}
                index={index}
                isLast={index === (data.classes.length - 1)}
                onPress={() => openRoster(item.scheduledClassId, item.className)}
              />
            ))}
          </View>
        )}

        {/* ── Needs attention — only renders when alerts exist ── */}
        {alerts.length > 0 ? (
          <View style={{ marginBottom: Space.sp4 }}>
            <SectionOverline>Atención</SectionOverline>
            {alerts.map((alert, index) => (
              <Animated.View
                key={alert.key}
                entering={FadeInDown.delay(index * 32).duration(300)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingVertical: 14,
                  borderBottomWidth: 1,
                  borderBottomColor: C.separator,
                  gap: Space.sp2,
                }}
              >
                <View
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 3,
                    backgroundColor: alert.severity === 'negative' ? C.negative : C.caution,
                  }}
                />
                <Text style={{ fontSize: 15, color: C.text, flex: 1, letterSpacing: -0.2 }}>
                  {alert.label}
                </Text>
              </Animated.View>
            ))}
          </View>
        ) : null}

        {/* ── Quick actions ── */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' }}>
          <QuickActionTile label="Miembros" icon="users" index={0} onPress={() => router.push(membersDirectoryHref())} />
          <QuickActionTile label="Ventas" icon="credit-card" index={1} onPress={() => router.push('/(app)/staff-sales' as Href)} />
        </View>

        {/* ── Analytics charts ── */}
        {data ? (
          <PanelAnalytics
            financial={data.financial}
            financialError={data.financialError}
            classBreakdown={data.classBreakdown}
            breakdownError={data.breakdownError}
          />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
