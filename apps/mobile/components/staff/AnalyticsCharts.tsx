import { View, Text, useWindowDimensions } from 'react-native';
import Svg, { Path, Line, Text as SvgText, Defs, LinearGradient, Stop, G } from 'react-native-svg';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { getColors, Radius, Space } from '@/constants/Theme';
import { formatMoneyFromCents } from '@/lib/formatMoney';
import { SectionOverline } from '@/components/staff/StaffPrimitives';
import type { FinancialSummaryDto, ClassBreakdownDto } from '@/lib/api/analyticsApi';

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatMXNAxis(cents: number): string {
  const amount = cents / 100;
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `$${Math.round(amount / 1_000)}k`;
  if (amount > 0) return `$${Math.round(amount)}`;
  return '$0';
}

function formatHour(hour: number): string {
  if (hour === 0) return '12 AM';
  if (hour === 12) return '12 PM';
  if (hour < 12) return `${hour} AM`;
  return `${hour - 12} PM`;
}

function formatDateShort(dateStr: string): string {
  const [, mm, dd] = dateStr.split('-');
  const MONTHS = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  return `${parseInt(dd, 10)} ${MONTHS[parseInt(mm, 10) - 1] ?? ''}`;
}

const METHOD_LABEL: Record<string, string> = {
  stripe: 'Stripe',
  card: 'Stripe',
  cash: 'Efectivo',
  other: 'Otro',
};

const METHOD_COLOR: Record<string, string> = {
  stripe: 'rgba(255,255,255,0.70)',
  card: 'rgba(255,255,255,0.70)',
  cash: '#FBBF24',
  other: 'rgba(255,255,255,0.38)',
};

// ── Primitives ────────────────────────────────────────────────────────────────

function ChartCard({
  title,
  children,
  index = 0,
}: {
  title: string;
  children: React.ReactNode;
  index?: number;
}) {
  const C = getColors();
  return (
    <Animated.View
      entering={FadeInDown.delay(index * 60).duration(320)}
      style={{
        backgroundColor: C.surface1,
        borderRadius: Radius.card,
        borderWidth: 1,
        borderColor: C.separator,
        padding: Space.cardH,
        marginBottom: Space.cardGap,
      }}
    >
      <Text
        style={{
          fontSize: 10,
          fontWeight: '700',
          letterSpacing: 1.0,
          textTransform: 'uppercase',
          color: C.textMute,
          marginBottom: 14,
        }}
      >
        {title}
      </Text>
      {children}
    </Animated.View>
  );
}

function ChartErrorText({ children }: { children: string }) {
  const C = getColors();
  return (
    <Text style={{ fontSize: 13, color: C.textMute, paddingTop: 4, lineHeight: 20 }}>
      {children}
    </Text>
  );
}

// ── Revenue Trend (SVG area line chart — current month from financial endpoint) ──

const TREND_SVG_H = 172;
const TREND_PAD = { l: 40, r: 8, t: 8, b: 24 } as const;
const TREND_CHART_H = TREND_SVG_H - TREND_PAD.t - TREND_PAD.b;

function RevenueTrendChart({
  data,
  width,
}: {
  data: { date: string; amountCents: number }[];
  width: number;
}) {
  if (data.length < 2) {
    return (
      <ChartErrorText>
        {data.length === 0
          ? 'Sin ingresos cobrados en el mes actual.'
          : 'No hay suficientes datos para mostrar la tendencia.'}
      </ChartErrorText>
    );
  }

  const maxVal = Math.max(...data.map((d) => d.amountCents), 1);
  const innerW = width - TREND_PAD.l - TREND_PAD.r;
  const n = data.length;

  const toX = (i: number) => TREND_PAD.l + (i / (n - 1)) * innerW;
  const toY = (val: number) => TREND_PAD.t + TREND_CHART_H - (val / maxVal) * TREND_CHART_H;

  const lineD = data
    .map((d, i) => `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(1)},${toY(d.amountCents).toFixed(1)}`)
    .join(' ');

  const bottomY = (TREND_PAD.t + TREND_CHART_H).toFixed(1);
  const areaD = `${lineD} L${toX(n - 1).toFixed(1)},${bottomY} L${TREND_PAD.l.toFixed(1)},${bottomY} Z`;

  const yRatios = [0, 0.5, 1.0];
  const xStep = Math.max(1, Math.floor(n / 3));
  const xIndices = Array.from(new Set([0, xStep, xStep * 2, n - 1])).filter((i) => i < n);

  const GRID = 'rgba(255,255,255,0.06)';
  const LINE = '#34D399';
  const LABEL = 'rgba(255,255,255,0.28)';

  return (
    <Svg width={width} height={TREND_SVG_H}>
      <Defs>
        <LinearGradient
          id="revGrad"
          x1="0"
          y1={TREND_PAD.t}
          x2="0"
          y2={TREND_PAD.t + TREND_CHART_H}
          gradientUnits="userSpaceOnUse"
        >
          <Stop offset="0%" stopColor={LINE} stopOpacity="0.20" />
          <Stop offset="100%" stopColor={LINE} stopOpacity="0" />
        </LinearGradient>
      </Defs>

      {yRatios.map((ratio) => {
        const y = toY(maxVal * ratio);
        return (
          <G key={String(ratio)}>
            <Line
              x1={TREND_PAD.l}
              y1={y}
              x2={width - TREND_PAD.r}
              y2={y}
              stroke={GRID}
              strokeWidth={1}
            />
            {ratio > 0 ? (
              <SvgText
                x={TREND_PAD.l - 4}
                y={y + 3}
                fontSize={9}
                fill={LABEL}
                textAnchor="end"
              >
                {formatMXNAxis(maxVal * ratio)}
              </SvgText>
            ) : null}
          </G>
        );
      })}

      <Path d={areaD} fill="url(#revGrad)" />

      <Path
        d={lineD}
        stroke={LINE}
        strokeWidth={1.5}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {xIndices.map((i) => (
        <SvgText
          key={i}
          x={toX(i)}
          y={TREND_SVG_H - 5}
          fontSize={9}
          fill={LABEL}
          textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
        >
          {formatDateShort(data[i].date)}
        </SvgText>
      ))}
    </Svg>
  );
}

// ── Stripe vs Cash (horizontal bars — from financial.charts.stripeVsCash) ────

function StripeVsCashSection({
  total,
  methods,
}: {
  total: number;
  methods: { method: string; amountCents: number }[];
}) {
  const C = getColors();
  const effectiveTotal = total > 0 ? total : methods.reduce((s, m) => s + m.amountCents, 0);

  if (effectiveTotal === 0) {
    return <ChartErrorText>Sin pagos cobrados en el mes actual.</ChartErrorText>;
  }

  const rows = methods.filter((m) => m.amountCents > 0);

  return (
    <View>
      {rows.map(({ method, amountCents }, idx) => {
        const pct = Math.round((amountCents / effectiveTotal) * 100);
        const label = METHOD_LABEL[method] ?? method.charAt(0).toUpperCase() + method.slice(1);
        const color = METHOD_COLOR[method] ?? 'rgba(255,255,255,0.38)';
        return (
          <View key={method} style={{ marginBottom: idx < rows.length - 1 ? 16 : 0 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 7 }}>
              <Text style={{ fontSize: 13, color: C.textSub }}>{label}</Text>
              <Text style={{ fontSize: 13, color: C.text, fontVariant: ['tabular-nums'] }}>
                {formatMoneyFromCents(amountCents, 'mxn')}
              </Text>
            </View>
            <View
              style={{
                height: 5,
                backgroundColor: 'rgba(255,255,255,0.07)',
                borderRadius: 3,
                overflow: 'hidden',
              }}
            >
              <View
                style={{
                  width: `${pct}%`,
                  height: '100%',
                  backgroundColor: color,
                  borderRadius: 3,
                }}
              />
            </View>
          </View>
        );
      })}
    </View>
  );
}

// ── Peak Hours (vertical bars — 30-day window) ────────────────────────────────

const PEAK_BAR_MAX_H = 88;

function PeakHoursSection({ data }: { data: { hour: number; count: number }[] }) {
  const C = getColors();

  if (data.length === 0) {
    return <ChartErrorText>Sin clases registradas en este periodo.</ChartErrorText>;
  }

  const sorted = [...data].sort((a, b) => a.hour - b.hour);
  const maxCount = Math.max(...sorted.map((d) => d.count), 1);
  const labelEvery = sorted.length > 10 ? 3 : sorted.length > 6 ? 2 : 1;

  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: PEAK_BAR_MAX_H + 20 }}>
      {sorted.map(({ hour, count }, idx) => {
        const barH = Math.max(3, Math.round((count / maxCount) * PEAK_BAR_MAX_H));
        const isPeak = count === maxCount;
        const showLabel = idx % labelEvery === 0;
        return (
          <View
            key={hour}
            style={{
              flex: 1,
              alignItems: 'center',
              justifyContent: 'flex-end',
              height: PEAK_BAR_MAX_H + 20,
            }}
          >
            <View
              style={{
                width: '68%',
                maxWidth: 28,
                height: barH,
                backgroundColor: isPeak ? '#2DD4BF' : 'rgba(45,212,191,0.40)',
                borderRadius: 2,
              }}
            />
            {showLabel ? (
              <Text
                style={{
                  fontSize: 8,
                  color: C.textMute,
                  marginTop: 4,
                  textAlign: 'center',
                  lineHeight: 11,
                }}
              >
                {formatHour(hour)}
              </Text>
            ) : (
              <View style={{ height: 15 }} />
            )}
          </View>
        );
      })}
    </View>
  );
}

// ── Popular Classes (horizontal bars — 30-day window) ─────────────────────────

function PopularClassesSection({
  templates,
}: {
  templates: { templateId: string; name: string; bookingCount: number }[];
}) {
  const C = getColors();
  const top5 = templates.slice(0, 5);

  if (top5.length === 0) {
    return <ChartErrorText>Sin reservas suficientes para mostrar tendencias.</ChartErrorText>;
  }

  const maxCount = Math.max(...top5.map((t) => t.bookingCount), 1);

  return (
    <View>
      {top5.map(({ templateId, name, bookingCount }, idx) => (
        <View key={templateId} style={{ marginBottom: idx < top5.length - 1 ? 12 : 0 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 5 }}>
            <Text
              style={{ fontSize: 13, color: C.textSub, flex: 1, marginRight: 8 }}
              numberOfLines={1}
            >
              {name}
            </Text>
            <Text style={{ fontSize: 12, color: C.textMute, fontVariant: ['tabular-nums'] }}>
              {bookingCount}
            </Text>
          </View>
          <View
            style={{
              height: 4,
              backgroundColor: 'rgba(255,255,255,0.07)',
              borderRadius: 2,
              overflow: 'hidden',
            }}
          >
            <View
              style={{
                width: `${Math.round((bookingCount / maxCount) * 100)}%`,
                height: '100%',
                backgroundColor: 'rgba(255,255,255,0.38)',
                borderRadius: 2,
              }}
            />
          </View>
        </View>
      ))}
    </View>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export function PanelAnalytics({
  financial,
  financialError,
  classBreakdown,
  breakdownError,
}: {
  financial: FinancialSummaryDto | null;
  financialError: string | null;
  classBreakdown: ClassBreakdownDto | null;
  breakdownError: string | null;
}) {
  const { width: windowWidth } = useWindowDimensions();
  const chartWidth = windowWidth - Space.screenH * 2 - Space.cardH * 2;

  const trendData = financial?.charts.collectedTrend ?? [];
  const stripeVsCash = financial?.charts.stripeVsCash ?? [];
  const totalCents = financial?.kpis.totalCollected.cents ?? 0;

  return (
    <View>
      <SectionOverline>Analítica</SectionOverline>

      {/* Revenue trend — current month, from financial endpoint */}
      <ChartCard title="Ingresos cobrados · Mes actual" index={0}>
        {financial ? (
          <RevenueTrendChart data={trendData} width={chartWidth} />
        ) : (
          <ChartErrorText>
            {financialError ?? 'No se pudieron cargar los datos financieros.'}
          </ChartErrorText>
        )}
      </ChartCard>

      {/* Stripe vs Cash — current month, from financial endpoint */}
      <ChartCard title="Stripe vs efectivo · Mes actual" index={1}>
        {financial ? (
          <StripeVsCashSection total={totalCents} methods={stripeVsCash} />
        ) : (
          <ChartErrorText>
            {financialError ?? 'No se pudieron cargar los métodos de pago.'}
          </ChartErrorText>
        )}
      </ChartCard>

      {/* Peak hours — explicitly 30-day window */}
      <ChartCard title="Horarios pico · 30 días" index={2}>
        {classBreakdown ? (
          <PeakHoursSection data={classBreakdown.peakHours} />
        ) : (
          <ChartErrorText>
            {breakdownError ?? 'No se pudieron cargar los horarios.'}
          </ChartErrorText>
        )}
      </ChartCard>

      {/* Popular classes — explicitly 30-day window */}
      <ChartCard title="Clases más populares · 30 días" index={3}>
        {classBreakdown ? (
          <PopularClassesSection templates={classBreakdown.topTemplates} />
        ) : (
          <ChartErrorText>
            {breakdownError ?? 'No se pudieron cargar las clases.'}
          </ChartErrorText>
        )}
      </ChartCard>
    </View>
  );
}
