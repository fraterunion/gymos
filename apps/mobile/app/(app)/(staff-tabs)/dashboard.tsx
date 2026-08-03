import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
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
  fetchAnalyticsExecutive,
  fetchAnalyticsClassBreakdown,
  fetchAnalyticsFinancial,
  fetchFinancialActivity,
  type BusinessAnalyticsDto,
  type ClassBreakdownDto,
  type ExecutiveDashboardDto,
  type FinancialActivityDto,
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
  executive: ExecutiveDashboardDto | null;
  financialActivity: FinancialActivityDto | null;
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
  const [showDetailCharts, setShowDetailCharts] = useState(false);

  const allowed = canAccessExecutiveDashboard(role);

  const load = useCallback(
    async (isRefresh = false) => {
      if (!studioId || !allowed) return;
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setFatalError(null);

      const now = new Date();
      const activityFrom = new Date(now.getTime() - 30 * 86_400_000).toISOString();

      const [executiveResult, classesResult, activityResult] = await Promise.all([
        fetchAnalyticsExecutive(studioId).then(
          (executive) => ({ executive, error: null as string | null }),
          (e) => ({ executive: null, error: userFacingApiMessage(e, 'No se pudo cargar el panel') }),
        ),
        loadStaffTodayClasses(studioId, timeZone).then(
          (classes) => ({ classes, error: null as string | null }),
          (e) => ({
            classes: [] as TodayClassSummaryDto[],
            error: userFacingApiMessage(e, 'No se pudo cargar el horario de hoy'),
          }),
        ),
        fetchFinancialActivity(studioId, {
          from: activityFrom,
          to: now.toISOString(),
          limit: 3,
        }).then(
          (financialActivity) => ({ financialActivity, error: null as string | null }),
          () => ({ financialActivity: null, error: null as string | null }),
        ),
      ]);

      const executive = executiveResult.executive;

      let financial: FinancialSummaryDto | null = null;
      let classBreakdown: ClassBreakdownDto | null = null;
      let financialError: string | null = executiveResult.error;
      let breakdownError: string | null = null;

      if (showDetailCharts && executive) {
        const [fin, br] = await Promise.all([
          fetchAnalyticsFinancial(studioId, 'month').catch((e) => {
            financialError = userFacingApiMessage(e, 'No se pudo cargar finanzas');
            return null;
          }),
          fetchAnalyticsClassBreakdown(studioId, 30).catch((e) => {
            breakdownError = userFacingApiMessage(e, 'No se pudo cargar desglose');
            return null;
          }),
        ]);
        financial = fin;
        classBreakdown = br;
      }

      const allFailed = !executive && classesResult.classes.length === 0;
      if (allFailed && executiveResult.error) {
        setFatalError(executiveResult.error);
      }

      setData({
        executive,
        financialActivity: activityResult.financialActivity,
        financial,
        business: null,
        classes: classesResult.classes,
        classBreakdown,
        financialError,
        businessError: null,
        classesError: classesResult.error,
        breakdownError,
        loadedAt: new Date().toISOString(),
      });

      setLoading(false);
      setRefreshing(false);
    },
    [studioId, allowed, timeZone, showDetailCharts],
  );

  useFocusEffect(
    useCallback(() => {
      if (studioId && allowed) void load();
    }, [studioId, allowed, load]),
  );

  const metrics = useMemo(() => {
    const monthKpi = data?.executive?.kpis.find((k) => k.id === 'revenue-month');
    const todayKpi = data?.executive?.kpis.find((k) => k.id === 'revenue-today');
    if (!monthKpi) return null;
    return {
      revenueMonthCents: monthKpi.value,
      revenueTodayCents: todayKpi?.value ?? 0,
      pct: monthKpi.comparisonPercent ?? null,
      currency: data?.executive?.currency ?? 'mxn',
    };
  }, [data]);

  const alerts = useMemo<Alert[]>(() => {
    if (!data) return [];
    const result: Alert[] = [];
    const pastDue = data.executive?.stripe.pastDueSubscriptions ?? 0;
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
        {data?.executive && metrics ? (
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
              {formatMoneyFromCents(metrics.revenueMonthCents, metrics.currency)}
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
            <Text style={{ fontSize: 14, color: C.textSub, marginBottom: 4, fontVariant: ['tabular-nums'] }}>
              Hoy {formatMoneyFromCents(metrics.revenueTodayCents, metrics.currency)}
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

        {data?.executive?.upcomingRevenue ? (
          <View style={{ marginBottom: Space.sp4 }}>
            <SectionOverline>Próximas renovaciones (estimado)</SectionOverline>
            <Text style={{ fontSize: 13, color: C.textSub, marginBottom: 8, lineHeight: 18 }}>
              {data.executive.upcomingRevenue.estimationNote}
            </Text>
            <Text style={{ fontSize: 14, color: C.textSub, marginBottom: 8, fontVariant: ['tabular-nums'] }}>
              7 días: {formatMoneyFromCents(data.executive.upcomingRevenue.expected7DaysCents, data.executive.currency)}
            </Text>
            {data.executive.upcomingRevenue.items.slice(0, 3).map((item) => (
              <View
                key={`${item.memberName}-${item.renewalDate}`}
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  paddingVertical: 10,
                  borderBottomWidth: 1,
                  borderBottomColor: C.separator,
                }}
              >
                <Text style={{ fontSize: 14, color: C.text, flex: 1 }} numberOfLines={1}>
                  {item.memberName}
                </Text>
                <Text style={{ fontSize: 13, color: C.textSub, fontVariant: ['tabular-nums'] }}>
                  {formatMoneyFromCents(item.amountCents, data.executive!.currency)}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        {data?.executive?.failedPayments.length ? (
          <View style={{ marginBottom: Space.sp4 }}>
            <SectionOverline>Pagos fallidos</SectionOverline>
            {data.executive.failedPayments.slice(0, 3).map((fp) => (
              <View
                key={fp.paymentId}
                style={{
                  paddingVertical: 12,
                  borderBottomWidth: 1,
                  borderBottomColor: C.separator,
                }}
              >
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
                  <Text style={{ fontSize: 15, fontWeight: '600', color: C.text, flex: 1 }}>{fp.memberName}</Text>
                  <Text style={{ fontSize: 14, color: C.negative, fontVariant: ['tabular-nums'] }}>
                    {formatMoneyFromCents(fp.amountCents, fp.currency)}
                  </Text>
                </View>
                <Text style={{ fontSize: 13, color: C.textSub, marginTop: 4 }}>
                  {fp.failureReasonAvailable ? fp.failureReason : 'Motivo no disponible'}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        {data?.executive?.insights.length ? (
          <View style={{ marginBottom: Space.sp4 }}>
            <SectionOverline>Insights</SectionOverline>
            {data.executive.insights.slice(0, 3).map((insight, index) => (
              <Animated.View
                key={insight.id}
                entering={FadeInDown.delay(index * 40).duration(300)}
                style={{
                  paddingVertical: 14,
                  borderBottomWidth: 1,
                  borderBottomColor: C.separator,
                }}
              >
                <Text style={{ fontSize: 15, fontWeight: '600', color: C.text }}>{insight.title}</Text>
                <Text style={{ fontSize: 14, color: C.textSub, marginTop: 4, lineHeight: 20 }}>{insight.body}</Text>
              </Animated.View>
            ))}
          </View>
        ) : null}

        {data?.financialActivity?.items.length ? (
          <View style={{ marginBottom: Space.sp4 }}>
            <SectionOverline>Actividad financiera</SectionOverline>
            {data.financialActivity.items.slice(0, 3).map((ev, index) => (
              <Animated.View
                key={ev.id}
                entering={FadeInDown.delay(index * 30).duration(280)}
                style={{
                  paddingVertical: 12,
                  borderBottomWidth: 1,
                  borderBottomColor: C.separator,
                  gap: 4,
                }}
              >
                <Text style={{ fontSize: 15, fontWeight: '600', color: C.text }}>{ev.member.name}</Text>
                <Text style={{ fontSize: 13, color: C.textSub }}>{ev.eventLabel}</Text>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
                  <Text style={{ fontSize: 13, color: C.textSub, flex: 1 }} numberOfLines={1}>
                    {ev.methodLabel}
                    {ev.amountCents != null
                      ? ` · ${formatMoneyFromCents(ev.amountCents, ev.currency || (data.financialActivity?.currency ?? 'mxn'))}`
                      : ''}
                  </Text>
                </View>
              </Animated.View>
            ))}
            <Pressable
              onPress={() => router.push('/financial-activity' as Href)}
              style={{ paddingVertical: 14 }}
            >
              <Text style={{ fontSize: 15, fontWeight: '600', color: primaryColor }}>
                Ver toda la actividad
              </Text>
            </Pressable>
          </View>
        ) : null}

        {/* ── Operational KPIs ── */}
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

        <Pressable
          onPress={() => {
            setShowDetailCharts(true);
            void load(true);
          }}
          style={{ marginBottom: Space.sp4, paddingVertical: 12 }}
        >
          <Text style={{ fontSize: 15, fontWeight: '600', color: primaryColor }}>Ver detalle analítico</Text>
        </Pressable>

        {showDetailCharts && data?.financial ? (
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
