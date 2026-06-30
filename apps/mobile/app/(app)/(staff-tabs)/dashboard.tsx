import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { BrandButton } from '@/components/BrandButton';
import { TAB_BAR_CLEARANCE } from '@/components/FloatingTabBar';
import { LoadRetryPanel, Skeleton } from '@/components/StudioScreenChrome';
import { useAuth } from '@/contexts/AuthContext';
import { useBranding } from '@/contexts/BrandingContext';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import {
  fetchAnalyticsBusiness,
  fetchAnalyticsOverview,
  revenueCentsForDay,
  revenueCentsMonthToDate,
  type AnalyticsOverviewDto,
  type BusinessAnalyticsDto,
} from '@/lib/api/analyticsApi';
import { type TodayClassSummaryDto } from '@/lib/api/scheduleApi';
import { canAccessExecutiveDashboard } from '@/lib/executivePermissions';
import { formatMoneyFromCents } from '@/lib/formatMoney';
import { formatClassTime } from '@/lib/datetime';
import { loadStaffTodayClasses } from '@/lib/staffTodaySchedule';
import { canAccessStaffScan, canManageTeam } from '@/lib/staffRole';
import { userFacingApiMessage } from '@/lib/userFacingApiMessage';
import { getColors, Space, type ThemeColors } from '@/constants/Theme';

const CARD_BG = '#141416';

function cardStyle(C: ThemeColors) {
  return {
    backgroundColor: CARD_BG,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: C.separator,
    padding: 24,
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
        marginTop: 28,
      }}
    >
      {children}
    </Text>
  );
}

function KpiTile({
  value,
  label,
  accent,
  index,
}: {
  value: string;
  label: string;
  accent?: string;
  index: number;
}) {
  const C = getColors();
  return (
    <Animated.View
      entering={FadeInDown.delay(index * 40).duration(380)}
      style={{
        width: '48%',
        backgroundColor: CARD_BG,
        borderRadius: 22,
        borderWidth: 1,
        borderColor: C.separator,
        padding: 18,
        marginBottom: 12,
      }}
    >
      <Text
        style={{
          fontSize: 28,
          fontWeight: '800',
          letterSpacing: -1,
          color: accent ?? C.text,
          lineHeight: 32,
        }}
      >
        {value}
      </Text>
      <Text
        style={{
          fontSize: 11,
          fontWeight: '700',
          letterSpacing: 0.6,
          textTransform: 'uppercase',
          color: C.textMute,
          marginTop: 6,
          lineHeight: 15,
        }}
      >
        {label}
      </Text>
    </Animated.View>
  );
}

function QuickActionChip({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) {
  const C = getColors();
  const { primaryColor } = useBranding();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={{
        borderRadius: 999,
        borderWidth: 1,
        borderColor: `${primaryColor}55`,
        backgroundColor: `${primaryColor}12`,
        paddingHorizontal: 18,
        paddingVertical: 12,
        marginRight: 10,
      }}
    >
      <Text style={{ fontSize: 14, fontWeight: '700', color: C.text }}>{label}</Text>
    </Pressable>
  );
}

function AlertRow({
  tone,
  title,
  detail,
}: {
  tone: 'warn' | 'danger' | 'info';
  title: string;
  detail?: string;
}) {
  const colors =
    tone === 'danger'
      ? { bg: 'rgba(239,68,68,0.1)', border: 'rgba(239,68,68,0.35)', text: '#FCA5A5' }
      : tone === 'warn'
        ? { bg: 'rgba(245,158,11,0.1)', border: 'rgba(245,158,11,0.35)', text: '#FBBF24' }
        : { bg: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.12)', text: 'rgba(255,255,255,0.75)' };

  return (
    <View
      style={{
        borderRadius: 16,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.bg,
        padding: 14,
        marginBottom: 10,
      }}
    >
      <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text }}>{title}</Text>
      {detail ? (
        <Text style={{ fontSize: 13, lineHeight: 19, color: 'rgba(255,255,255,0.55)', marginTop: 4 }}>
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

function ClassOccupancyRow({
  item,
  timeZone,
  index,
  onPress,
}: {
  item: TodayClassSummaryDto;
  timeZone: string;
  index: number;
  onPress: () => void;
}) {
  const C = getColors();
  const { primaryColor } = useBranding();
  const fillPct =
    item.capacity > 0 ? Math.min(100, Math.round((item.bookedCount / item.capacity) * 100)) : 0;
  const isFull = item.capacity > 0 && item.bookedCount >= item.capacity;
  const isAlmostFull = !isFull && item.capacity > 0 && item.bookedCount >= item.capacity * 0.85;
  const accent = item.color?.trim() || primaryColor;

  return (
    <Animated.View entering={FadeInDown.delay(index * 50).duration(400)}>
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        style={{
          marginBottom: 12,
          borderRadius: 20,
          borderWidth: 1,
          borderColor: isFull ? 'rgba(239,68,68,0.35)' : C.separator,
          backgroundColor: CARD_BG,
          padding: 16,
        }}
      >
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 }}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={{ fontSize: 15, fontWeight: '800', color: C.text, letterSpacing: -0.2 }}>
              {item.className}
            </Text>
            <Text style={{ fontSize: 13, color: C.textMute, marginTop: 4 }}>
              {formatClassTime(item.startsAt, timeZone)}
            </Text>
          </View>
          <Text style={{ fontSize: 13, fontWeight: '700', color: isFull ? '#FCA5A5' : C.textSub }}>
            {item.bookedCount}/{item.capacity}
          </Text>
        </View>
        <View
          style={{
            height: 6,
            borderRadius: 999,
            backgroundColor: 'rgba(255,255,255,0.08)',
            overflow: 'hidden',
          }}
        >
          <View
            style={{
              width: `${fillPct}%`,
              height: '100%',
              borderRadius: 999,
              backgroundColor: isFull ? '#EF4444' : isAlmostFull ? '#F59E0B' : accent,
            }}
          />
        </View>
        {isFull ? (
          <Text style={{ fontSize: 11, fontWeight: '700', color: '#FCA5A5', marginTop: 8 }}>
            CLASE LLENA
          </Text>
        ) : isAlmostFull ? (
          <Text style={{ fontSize: 11, fontWeight: '700', color: '#FBBF24', marginTop: 8 }}>
            Casi llena
          </Text>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

function formatExecutiveDate(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('es-MX', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      timeZone,
    }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat('es-MX', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(new Date());
  }
}

function formatUpdatedAt(iso: string | null, timeZone: string): string | null {
  if (!iso) return null;
  try {
    return new Intl.DateTimeFormat('es-MX', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
    }).format(new Date(iso));
  } catch {
    return null;
  }
}

function deriveStatusLine(params: {
  checkInsToday: number;
  classesToday: number;
  pastDue: number;
  revenueTodayCents: number;
}): string {
  if (params.pastDue > 0) {
    return `${params.pastDue} membresía${params.pastDue === 1 ? '' : 's'} requiere atención de cobro.`;
  }
  if (params.checkInsToday >= 8) {
    return 'Buen ritmo de check-ins en el estudio.';
  }
  if (params.classesToday === 0) {
    return 'Sin clases programadas hoy — revisa el horario.';
  }
  if (params.revenueTodayCents > 0) {
    return 'Hay ingresos registrados hoy.';
  }
  return 'Operaciones en curso — aquí está el pulso del día.';
}

type DashboardData = {
  overview: AnalyticsOverviewDto | null;
  business: BusinessAnalyticsDto | null;
  classes: TodayClassSummaryDto[];
  overviewError: string | null;
  businessError: string | null;
  classesError: string | null;
  loadedAt: string;
};

export default function ExecutiveDashboardScreen() {
  const router = useRouter();
  const C = getColors();
  const { primaryColor } = useBranding();
  const { user } = useAuth();
  const { matched } = useMemberStudio();
  const role = matched?.role ?? null;
  const studioId = matched?.studio.id ?? '';
  const studioName = matched?.studio.name ?? 'ARES';
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

      const overviewResult = await fetchAnalyticsOverview(studioId).then(
        (overview) => ({ overview, error: null as string | null }),
        (e) => ({ overview: null, error: userFacingApiMessage(e, 'No se pudo cargar el resumen') }),
      );

      const businessResult = await fetchAnalyticsBusiness(studioId).then(
        (business) => ({ business, error: null as string | null }),
        (e) => ({ business: null, error: userFacingApiMessage(e, 'No se pudieron cargar ingresos') }),
      );

      const classesResult = await loadStaffTodayClasses(studioId, timeZone).then(
        (classes) => ({ classes, error: null as string | null }),
        (e) => ({
          classes: [] as TodayClassSummaryDto[],
          error: userFacingApiMessage(e, 'No se pudo cargar el horario de hoy'),
        }),
      );

      const allFailed =
        !overviewResult.overview && !businessResult.business && classesResult.classes.length === 0;

      if (allFailed && overviewResult.error && businessResult.error && classesResult.error) {
        setFatalError(overviewResult.error);
      }

      setData({
        overview: overviewResult.overview,
        business: businessResult.business,
        classes: classesResult.classes,
        overviewError: overviewResult.error,
        businessError: businessResult.error,
        classesError: classesResult.error,
        loadedAt: new Date().toISOString(),
      });

      setLoading(false);
      setRefreshing(false);
    },
    [studioId, allowed, timeZone],
  );

  useFocusEffect(
    useCallback(() => {
      if (studioId && allowed) {
        void load();
      }
    }, [studioId, allowed, load]),
  );

  const metrics = useMemo(() => {
    if (!data) return null;

    const utcDayKey = new Date().toISOString().slice(0, 10);
    const yearMonth = utcDayKey.slice(0, 7);

    const revenueTrend = data.business?.revenueTrend ?? [];
    const revenueTodayCents = revenueCentsForDay(revenueTrend, utcDayKey);
    const revenueMonthCents = revenueCentsMonthToDate(revenueTrend, yearMonth);

    const bookingsToday = data.classes.reduce((sum, c) => sum + c.bookedCount, 0);
    const classesToday = data.classes.length;
    const checkInsToday = data.overview?.checkInsToday ?? 0;
    const activeMembers = data.business?.memberCountForArpu ?? data.overview?.activeMembers ?? 0;
    const pastDue = data.business?.pastDueSubscriptions ?? 0;
    const waitlist = data.overview?.waitlistCount ?? 0;
    const fullClasses = data.classes.filter(
      (c) => c.capacity > 0 && c.bookedCount >= c.capacity,
    ).length;

    return {
      checkInsToday,
      revenueTodayCents,
      revenueMonthCents,
      activeMembers,
      classesToday,
      bookingsToday,
      pastDue,
      waitlist,
      fullClasses,
      occupancyToday: data.overview?.occupancyRateToday ?? 0,
      dataQuality: data.business?.dataQuality ?? null,
      revenueLast30Cents: data.business?.revenueLast30DaysCents ?? null,
      utcDayKey,
    };
  }, [data, timeZone]);

  const alerts = useMemo(() => {
    if (!data || !metrics) return [];
    const rows: { tone: 'warn' | 'danger' | 'info'; title: string; detail?: string }[] = [];

    if (data.overviewError) {
      rows.push({
        tone: 'info',
        title: 'Métricas parciales',
        detail: data.overviewError,
      });
    }
    if (data.businessError) {
      rows.push({
        tone: 'info',
        title: 'Ingresos no disponibles',
        detail: data.businessError,
      });
    }
    if (data.classesError) {
      rows.push({ tone: 'info', title: 'Horario de hoy', detail: data.classesError });
    }
    if (metrics.pastDue > 0) {
      rows.push({
        tone: 'danger',
        title: `${metrics.pastDue} membresía${metrics.pastDue === 1 ? '' : 's'} vencida${metrics.pastDue === 1 ? '' : 's'}`,
        detail: 'Revisa cobros pendientes en Stripe o recepción.',
      });
    }
    if (metrics.fullClasses > 0) {
      rows.push({
        tone: 'warn',
        title: `${metrics.fullClasses} clase${metrics.fullClasses === 1 ? '' : 's'} llena${metrics.fullClasses === 1 ? '' : 's'} hoy`,
      });
    }
    if (metrics.waitlist > 0) {
      rows.push({
        tone: 'warn',
        title: `${metrics.waitlist} en lista de espera`,
      });
    }
    if (metrics.classesToday === 0 && !data.classesError) {
      rows.push({
        tone: 'warn',
        title: 'No hay clases hoy',
        detail: 'Verifica que el horario esté publicado.',
      });
    }
    if (metrics.dataQuality === 'demo') {
      rows.push({
        tone: 'info',
        title: 'Datos de demostración',
        detail: 'Los ingresos pueden ser filas de prueba, no cobros reales.',
      });
    }

    return rows;
  }, [data, metrics]);

  const openRoster = useCallback(
    (classId: string, className: string) => {
      const params = new URLSearchParams({ classId, className });
      router.push(`/(app)/staff-class-roster?${params.toString()}` as Href);
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
        <ScrollView contentContainerStyle={{ padding: Space.screenH, paddingTop: 28 }}>
          <Skeleton height={36} width="70%" />
          <Skeleton height={18} width="50%" style={{ marginTop: 12 }} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginTop: 28 }}>
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} height={88} width="48%" style={{ marginBottom: 12 }} />
            ))}
          </View>
          <Skeleton height={140} radius={28} style={{ marginTop: 12 }} />
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

  const firstName = user?.firstName?.trim() || 'Equipo';
  const updatedLabel = formatUpdatedAt(data?.loadedAt ?? null, timeZone);
  const statusLine =
    metrics &&
    deriveStatusLine({
      checkInsToday: metrics.checkInsToday,
      classesToday: metrics.classesToday,
      pastDue: metrics.pastDue,
      revenueTodayCents: metrics.revenueTodayCents,
    });

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['left', 'right', 'top']}>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: Space.screenH,
          paddingBottom: TAB_BAR_CLEARANCE,
        }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} tintColor="rgba(255,255,255,0.4)" />
        }
      >
        <Animated.View entering={FadeInDown.duration(450)} style={{ paddingTop: 28, paddingBottom: 8 }}>
          <Text
            style={{
              fontSize: 11,
              fontWeight: '700',
              letterSpacing: 1.4,
              textTransform: 'uppercase',
              color: primaryColor,
              marginBottom: 10,
            }}
          >
            ARES hoy
          </Text>
          <Text
            style={{
              fontSize: 38,
              fontWeight: '800',
              letterSpacing: -1.3,
              color: C.text,
              lineHeight: 44,
            }}
          >
            Hola, {firstName}
          </Text>
          <Text style={{ fontSize: 15, color: C.textSub, lineHeight: 22, marginTop: 10 }}>
            {studioName} · {formatExecutiveDate(timeZone)}
          </Text>
          {statusLine ? (
            <Text style={{ fontSize: 14, color: C.textMute, lineHeight: 20, marginTop: 8 }}>{statusLine}</Text>
          ) : null}
          {updatedLabel ? (
            <Text style={{ fontSize: 11, color: C.textMute, marginTop: 8 }}>
              Actualizado {updatedLabel}
            </Text>
          ) : null}
        </Animated.View>

        <SectionLabel>Indicadores de hoy</SectionLabel>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' }}>
          <KpiTile index={0} value={String(metrics?.checkInsToday ?? '—')} label="Check-ins hoy" accent={primaryColor} />
          <KpiTile
            index={1}
            value={
              metrics && data?.business
                ? formatMoneyFromCents(metrics.revenueTodayCents, 'mxn')
                : '—'
            }
            label="Ingresos hoy"
          />
          <KpiTile index={2} value={String(metrics?.activeMembers ?? '—')} label="Miembros activos" />
          <KpiTile index={3} value={String(metrics?.classesToday ?? '—')} label="Clases hoy" />
          <KpiTile index={4} value={String(metrics?.bookingsToday ?? '—')} label="Reservas hoy" />
          <KpiTile
            index={5}
            value={
              metrics?.occupancyToday != null ? `${Math.round(metrics.occupancyToday)}%` : '—'
            }
            label="Ocupación hoy"
          />
        </View>

        {data?.business && metrics ? (
          <>
            <SectionLabel>Ingresos</SectionLabel>
            <View style={cardStyle(C)}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 20 }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: C.textMute, marginBottom: 6 }}>
                    ESTE MES
                  </Text>
                  <Text style={{ fontSize: 26, fontWeight: '800', color: C.text, letterSpacing: -0.8 }}>
                    {formatMoneyFromCents(metrics.revenueMonthCents, 'mxn')}
                  </Text>
                  <Text style={{ fontSize: 12, color: C.textMute, marginTop: 4 }}>
                    Pagos confirmados (UTC)
                  </Text>
                </View>
                <View style={{ flex: 1, alignItems: 'flex-end' }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: C.textMute, marginBottom: 6 }}>
                    30 DÍAS
                  </Text>
                  <Text style={{ fontSize: 22, fontWeight: '800', color: C.textSub, letterSpacing: -0.5 }}>
                    {metrics.revenueLast30Cents != null
                      ? formatMoneyFromCents(metrics.revenueLast30Cents, 'mxn')
                      : '—'}
                  </Text>
                </View>
              </View>
              {metrics.dataQuality ? (
                <View
                  style={{
                    alignSelf: 'flex-start',
                    borderRadius: 999,
                    paddingHorizontal: 10,
                    paddingVertical: 5,
                    backgroundColor: 'rgba(255,255,255,0.06)',
                  }}
                >
                  <Text style={{ fontSize: 11, fontWeight: '700', color: C.textMute }}>
                    Fuente: {metrics.dataQuality === 'live' ? 'pagos reales' : metrics.dataQuality}
                  </Text>
                </View>
              ) : null}
            </View>
          </>
        ) : data?.businessError ? (
          <View style={[cardStyle(C), { marginTop: 28 }]}>
            <Text style={{ fontSize: 15, color: C.textSub, lineHeight: 22 }}>
              Ingresos no disponibles en este momento.
            </Text>
          </View>
        ) : null}

        {alerts.length > 0 ? (
          <>
            <SectionLabel>Atención</SectionLabel>
            {alerts.map((alert) => (
              <AlertRow key={alert.title} tone={alert.tone} title={alert.title} detail={alert.detail} />
            ))}
          </>
        ) : null}

        <SectionLabel>Clases de hoy</SectionLabel>
        {data?.classes.length === 0 ? (
          <View style={[cardStyle(C), { alignItems: 'center', paddingVertical: 32 }]}>
            <Text style={{ fontSize: 16, fontWeight: '700', color: C.text, marginBottom: 6 }}>
              Sin clases programadas
            </Text>
            <Text style={{ fontSize: 14, color: C.textSub, textAlign: 'center', lineHeight: 21 }}>
              Cuando haya clases hoy, verás ocupación y acceso rápido a la lista.
            </Text>
          </View>
        ) : (
          data?.classes.map((item, index) => (
            <ClassOccupancyRow
              key={item.scheduledClassId}
              item={item}
              timeZone={timeZone}
              index={index}
              onPress={() => openRoster(item.scheduledClassId, item.className)}
            />
          ))
        )}

        <SectionLabel>Acciones rápidas</SectionLabel>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
          <QuickActionChip label="Ventas" onPress={() => router.push('/(app)/staff-sales' as Href)} />
          <QuickActionChip
            label="Operaciones"
            onPress={() => router.push('/(app)/(staff-tabs)/today' as Href)}
          />
          {canAccessStaffScan(role) ? (
            <QuickActionChip label="Escanear QR" onPress={() => router.push('/(app)/(staff-tabs)/scan' as Href)} />
          ) : null}
          {canManageTeam(role) ? (
            <QuickActionChip label="Equipo" onPress={() => router.push('/(app)/(staff-tabs)/team' as Href)} />
          ) : null}
        </ScrollView>
      </ScrollView>
    </SafeAreaView>
  );
}
