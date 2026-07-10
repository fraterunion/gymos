"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { FinancialKpiSection } from "@/components/analytics/FinancialKpiSection";
import { PageHeader } from "@/components/shell/PageHeader";
import { SectionHeader } from "@/components/shell/SectionHeader";
import { SurfaceCard } from "@/components/shell/SurfaceCard";
import { useDeskStudio } from "@/contexts/DeskStudioContext";
import { translateSubscriptionStatus } from "@/lib/analyticsCopy";
import {
  CHART_AXIS,
  CHART_COLORS,
  CHART_GRID,
  CHART_TOOLTIP_STYLE,
  planBarColor,
  stripeVsCashColor,
  stripeVsCashLabel,
} from "@/lib/analyticsChartColors";
import { ApiError } from "@/lib/api/errors";
import {
  fetchAnalyticsBusiness,
  fetchAnalyticsClassBreakdown,
  fetchAnalyticsFinancial,
  fetchAnalyticsOverview,
  fetchAnalyticsTrends,
  type BusinessAnalyticsDto,
  type ClassBreakdownDto,
  type FinancialPeriodKey,
  type FinancialSummaryDto,
  type OverviewDto,
  type TrendsDto,
} from "@/lib/api/analytics";
import { formatMoneyAxis, formatMoneyFromCents } from "@/lib/formatMoney";

function periodLabel(days: number): string {
  if (days >= 365) return "este año";
  return `últimos ${days} días`;
}

function periodToDays(period: PeriodKey): number {
  if (period !== "year") return period;
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  return Math.min(365, Math.max(1, Math.ceil((now.getTime() - start.getTime()) / 86_400_000)));
}

type PeriodKey = 7 | 30 | 90 | "year";

function fmt(n: number, digits = 0): string {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(n);
}

function fmtDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    new Date(iso),
  );
}

function fmtHour(h: number): string {
  const d = new Date();
  d.setHours(h, 0, 0, 0);
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", hour12: true }).format(d);
}

function ChartShell({
  title,
  loading,
  children,
}: {
  title: string;
  loading: boolean;
  children: React.ReactNode;
}) {
  return (
    <SurfaceCard>
      <p className="mb-4 text-sm font-medium text-zinc-700">{title}</p>
      {loading ? (
        <div className="flex h-48 items-center justify-center">
          <p className="text-sm text-zinc-400">Cargando…</p>
        </div>
      ) : (
        children
      )}
    </SurfaceCard>
  );
}

function StripeVsCashChart({
  rows,
  currency,
}: {
  rows: { method: string; amountCents: number }[];
  currency: string;
}) {
  const data = rows.map((r) => ({
    name: stripeVsCashLabel(r.method),
    Monto: r.amountCents / 100,
    fill: stripeVsCashColor(r.method),
  }));
  if (data.every((d) => d.Monto === 0)) {
    return (
      <p className="py-10 text-center text-sm text-zinc-500">Sin pagos en este periodo.</p>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
        <XAxis dataKey="name" tick={{ fill: CHART_AXIS, fontSize: 11 }} tickLine={false} axisLine={false} />
        <YAxis
          tick={{ fill: CHART_AXIS, fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => formatMoneyAxis(Math.round(Number(v) * 100), currency)}
        />
        <Tooltip
          contentStyle={CHART_TOOLTIP_STYLE}
          formatter={(value) => [
            formatMoneyFromCents(Math.round(Number(value ?? 0) * 100), currency),
            "Cobrado",
          ]}
        />
        <Bar dataKey="Monto" radius={[8, 8, 0, 0]} maxBarSize={72}>
          {data.map((entry, i) => (
            <Cell key={i} fill={entry.fill} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function PaymentCountTrendChart({
  rows,
}: {
  rows: { date: string; paymentCount: number }[];
}) {
  const data = rows.map((r) => ({
    date: fmtDate(r.date),
    Pagos: r.paymentCount,
  }));
  if (data.every((d) => d.Pagos === 0)) {
    return <p className="py-10 text-center text-sm text-zinc-500">Sin pagos en este periodo.</p>;
  }
  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
        <XAxis dataKey="date" tick={{ fill: CHART_AXIS, fontSize: 10 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
        <YAxis tick={{ fill: CHART_AXIS, fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} />
        <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
        <Line type="monotone" dataKey="Pagos" stroke={CHART_COLORS.membership} strokeWidth={2.5} dot={false} activeDot={{ r: 4, fill: CHART_COLORS.membership }} />
      </LineChart>
    </ResponsiveContainer>
  );
}

function RevenueTrend30Chart({
  rows,
  currency,
}: {
  rows: BusinessAnalyticsDto["revenueTrend"];
  currency: string;
}) {
  const data = rows.map((r) => ({
    date: fmtDate(r.date),
    Ingresos: Math.round(r.amountCents) / 100,
  }));
  const gridColor = CHART_GRID;
  const textColor = CHART_AXIS;
  if (data.every((d) => d.Ingresos === 0)) {
    return (
      <p className="py-10 text-center text-sm text-zinc-500">Sin pagos cobrados en este periodo.</p>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="revenueGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={CHART_COLORS.revenue} stopOpacity={0.2} />
            <stop offset="100%" stopColor={CHART_COLORS.revenue} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
        <XAxis
          dataKey="date"
          tick={{ fill: textColor, fontSize: 10 }}
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          tick={{ fill: textColor, fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => formatMoneyAxis(Math.round(Number(v) * 100), currency)}
        />
        <Tooltip
          contentStyle={CHART_TOOLTIP_STYLE}
          formatter={(value) => [
            formatMoneyFromCents(Math.round(Number(value ?? 0) * 100), currency),
            "Cobrado",
          ]}
        />
        <Area type="monotone" dataKey="Ingresos" fill="url(#revenueGradient)" stroke="none" />
        <Line
          type="monotone"
          dataKey="Ingresos"
          stroke={CHART_COLORS.revenue}
          strokeWidth={2.5}
          dot={false}
          activeDot={{ r: 4, fill: CHART_COLORS.revenue }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function MembershipActivityChart({
  rows,
}: {
  rows: BusinessAnalyticsDto["memberSignupsTrend"];
}) {
  const data = rows.map((r) => ({
    date: fmtDate(r.date),
    Miembros: r.count,
  }));
  const gridColor = CHART_GRID;
  const textColor = CHART_AXIS;
  if (data.every((d) => d.Miembros === 0)) {
    return (
      <p className="py-10 text-center text-sm text-zinc-500">Sin membresías nuevas en este periodo.</p>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
        <XAxis
          dataKey="date"
          tick={{ fill: textColor, fontSize: 10 }}
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          tick={{ fill: textColor, fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          allowDecimals={false}
        />
        <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
        <Line
          type="monotone"
          dataKey="Miembros"
          stroke={CHART_COLORS.membership}
          strokeWidth={2.5}
          dot={false}
          activeDot={{ r: 4, fill: CHART_COLORS.membership }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function AttendanceTrendChart({
  trends,
}: {
  trends: TrendsDto;
}) {
  const data = trends.attendances.map((a) => ({
    date: fmtDate(a.date),
    Asistencia: a.count,
  }));
  const gridColor = CHART_GRID;
  const textColor = CHART_AXIS;
  if (data.every((d) => d.Asistencia === 0)) {
    return <p className="py-10 text-center text-sm text-zinc-500">Sin check-ins en este periodo.</p>;
  }
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
        <XAxis
          dataKey="date"
          tick={{ fill: textColor, fontSize: 10 }}
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          tick={{ fill: textColor, fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          allowDecimals={false}
        />
        <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
        <Line
          type="monotone"
          dataKey="Asistencia"
          stroke={CHART_COLORS.attendance}
          strokeWidth={2.5}
          dot={false}
          activeDot={{ r: 4, fill: CHART_COLORS.attendance }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function BookingsAttendanceChart({
  trends,
}: {
  trends: TrendsDto;
}) {
  const data = trends.bookings.map((b, i) => ({
    date: fmtDate(b.date),
    Reservas: b.count,
    Asistencia: trends.attendances[i]?.count ?? 0,
  }));
  const gridColor = CHART_GRID;
  const textColor = CHART_AXIS;

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
        <XAxis
          dataKey="date"
          tick={{ fill: textColor, fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          tick={{ fill: textColor, fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          allowDecimals={false}
        />
        <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
        <Line type="monotone" dataKey="Reservas" stroke={CHART_COLORS.bookings} strokeWidth={2.5} dot={false} />
        <Line type="monotone" dataKey="Asistencia" stroke={CHART_COLORS.attendance} strokeWidth={2.5} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

const SUBSCRIPTION_CHART_COLORS: Record<string, string> = {
  ACTIVE: CHART_COLORS.revenue,
  TRIALING: CHART_COLORS.membership,
  PAST_DUE: CHART_COLORS.warning,
  PAUSED: CHART_COLORS.neutral,
  CANCELED: CHART_COLORS.negative,
};

function formatSubscriptionStatus(status: string): string {
  return translateSubscriptionStatus(status);
}

function SubscriptionStatusChart({
  breakdown,
}: {
  breakdown: BusinessAnalyticsDto["subscriptionStatusBreakdown"];
}) {
  const data = breakdown
    .filter((b) => b.count > 0)
    .map((b) => ({
      name: formatSubscriptionStatus(b.status),
      count: b.count,
      fill: SUBSCRIPTION_CHART_COLORS[b.status] ?? CHART_COLORS.neutral,
    }));
  if (data.length === 0) {
    return <p className="py-10 text-center text-sm text-zinc-500">Sin suscripciones aún.</p>;
  }
  const gridColor = CHART_GRID;
  const textColor = CHART_AXIS;
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart
        layout="vertical"
        data={data}
        margin={{ top: 4, right: 16, left: 8, bottom: 0 }}
        barCategoryGap={12}
      >
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} horizontal={false} />
        <XAxis type="number" tick={{ fill: textColor, fontSize: 11 }} tickLine={false} axisLine={false} />
        <YAxis
          type="category"
          dataKey="name"
          width={92}
          tick={{ fill: textColor, fontSize: 11 }}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
        <Bar dataKey="count" radius={[0, 4, 4, 0]} maxBarSize={28}>
          {data.map((entry, i) => (
            <Cell key={i} fill={entry.fill} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function BookingFrequencyChart({
  buckets,
  ratePercent,
}: {
  buckets: BusinessAnalyticsDto["bookingFrequencyBuckets"];
  ratePercent: number;
}) {
  const data = buckets.map((b) => ({ name: b.label, Miembros: b.memberCount }));
  const total = buckets.reduce((s, b) => s + b.memberCount, 0);
  if (total === 0) {
    return (
      <p className="py-10 text-center text-sm text-zinc-500">Sin reservas de miembros en este periodo.</p>
    );
  }
  const gridColor = CHART_GRID;
  const textColor = CHART_AXIS;
  return (
    <div>
      <p className="mb-2 text-xs text-zinc-600">
        Miembros con reservas · tasa de repetición {fmt(ratePercent, 1)}%
      </p>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
          <XAxis dataKey="name" tick={{ fill: textColor, fontSize: 11 }} tickLine={false} axisLine={false} />
          <YAxis tick={{ fill: textColor, fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} />
          <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
          <Bar dataKey="Miembros" fill={CHART_COLORS.retention} radius={[8, 8, 0, 0]} maxBarSize={56} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function RevenueByPlanChart({
  rows,
  currency,
}: {
  rows: { planId: string | null; planName: string; revenueCents: number }[];
  currency: string;
}) {
  if (rows.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-zinc-500">Sin ingresos por plan en este periodo.</p>
    );
  }
  const data = rows.map((r, i) => ({
    name: r.planName.length > 16 ? r.planName.slice(0, 15) + "…" : r.planName,
    Ingresos: Math.round(r.revenueCents) / 100,
    fill: planBarColor(i, r.planName === "Sin atribuir"),
  }));
  const gridColor = CHART_GRID;
  const textColor = CHART_AXIS;
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: -24, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
        <XAxis dataKey="name" tick={{ fill: textColor, fontSize: 10 }} tickLine={false} axisLine={false} />
        <YAxis
          tick={{ fill: textColor, fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => formatMoneyAxis(Math.round(Number(v) * 100), currency)}
        />
        <Tooltip
          contentStyle={CHART_TOOLTIP_STYLE}
          formatter={(value) => [
            formatMoneyFromCents(Math.round(Number(value ?? 0) * 100), currency),
            "Cobrado",
          ]}
        />
        <Bar dataKey="Ingresos" radius={[6, 6, 0, 0]} maxBarSize={44}>
          {data.map((entry, i) => (
            <Cell key={i} fill={entry.fill} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function TopClassesChart({
  breakdown,
}: {
  breakdown: ClassBreakdownDto;
}) {
  const data = breakdown.topTemplates.map((t) => ({
    name: t.name.length > 14 ? t.name.slice(0, 13) + "…" : t.name,
    Reservas: t.bookingCount,
  }));
  if (data.length === 0) {
    return <p className="py-10 text-center text-sm text-zinc-500">Sin datos aún.</p>;
  }
  const gridColor = CHART_GRID;
  const textColor = CHART_AXIS;
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
        <XAxis dataKey="name" tick={{ fill: textColor, fontSize: 10 }} tickLine={false} axisLine={false} />
        <YAxis tick={{ fill: textColor, fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} />
        <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
        <Bar dataKey="Reservas" fill={CHART_COLORS.bookings} radius={[6, 6, 0, 0]} maxBarSize={48} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function PeakHoursChart({
  breakdown,
}: {
  breakdown: ClassBreakdownDto;
}) {
  if (breakdown.peakHours.length === 0) {
    return <p className="py-10 text-center text-sm text-zinc-500">Sin datos aún.</p>;
  }
  const hourMap = new Map(breakdown.peakHours.map((h) => [h.hour, h.count]));
  const maxCount = Math.max(...breakdown.peakHours.map((h) => h.count), 1);
  const data = Array.from({ length: 24 }, (_, h) => ({
    hour: fmtHour(h),
    Clases: hourMap.get(h) ?? 0,
    fill: `rgba(20, 184, 166, ${0.25 + (0.75 * (hourMap.get(h) ?? 0)) / maxCount})`,
  }));
  const gridColor = CHART_GRID;
  const textColor = CHART_AXIS;
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
        <XAxis dataKey="hour" tick={{ fill: textColor, fontSize: 9 }} tickLine={false} axisLine={false} interval={2} />
        <YAxis tick={{ fill: textColor, fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} />
        <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
        <Bar dataKey="Clases" radius={[4, 4, 0, 0]} maxBarSize={24}>
          {data.map((entry, i) => (
            <Cell key={i} fill={entry.fill} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

const PERIOD_OPTIONS: { label: string; value: PeriodKey }[] = [
  { label: "7 días", value: 7 },
  { label: "30 días", value: 30 },
  { label: "90 días", value: 90 },
  { label: "Este año", value: "year" },
];

function PeriodSegment({
  value,
  onChange,
}: {
  value: PeriodKey;
  onChange: (v: PeriodKey) => void;
}) {
  return (
    <div className="inline-flex overflow-x-auto rounded-xl bg-zinc-100 p-1">
      {PERIOD_OPTIONS.map(({ label, value: v }) => (
        <button
          key={String(v)}
          type="button"
          onClick={() => onChange(v)}
          className={`whitespace-nowrap rounded-lg px-3 py-2 text-xs font-medium transition sm:px-4 sm:text-sm ${
            value === v
              ? "bg-zinc-900 text-white shadow-sm"
              : "text-zinc-600 hover:text-zinc-900"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export default function AnalyticsPage() {
  const { selectedStudioId, loading: studioLoading, error: studioError } =
    useDeskStudio();
  const chartsRef = useRef<HTMLElement>(null);

  const [financialPeriod, setFinancialPeriod] = useState<FinancialPeriodKey>("month");
  const [financial, setFinancial] = useState<FinancialSummaryDto | null>(null);
  const [period, setPeriod] = useState<PeriodKey>(30);
  const [overview, setOverview] = useState<OverviewDto | null>(null);
  const [trends, setTrends] = useState<TrendsDto | null>(null);
  const [breakdown, setBreakdown] = useState<ClassBreakdownDto | null>(null);
  const [business, setBusiness] = useState<BusinessAnalyticsDto | null>(null);

  const [loadingFinancial, setLoadingFinancial] = useState(true);
  const [loadingOverview, setLoadingOverview] = useState(true);
  const [loadingCharts, setLoadingCharts] = useState(true);
  const [loadingBusiness, setLoadingBusiness] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const studioCurrency = financial?.currency ?? "mxn";

  const loadFinancial = useCallback(async () => {
    if (!selectedStudioId) {
      setFinancial(null);
      setLoadingFinancial(false);
      return;
    }
    setLoadingFinancial(true);
    try {
      setFinancial(await fetchAnalyticsFinancial(selectedStudioId, financialPeriod));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo cargar el resumen financiero");
    } finally {
      setLoadingFinancial(false);
    }
  }, [selectedStudioId, financialPeriod]);

  const loadOverview = useCallback(async () => {
    if (!selectedStudioId) {
      setOverview(null);
      setLoadingOverview(false);
      return;
    }
    setLoadingOverview(true);
    try {
      const days = periodToDays(period);
      setOverview(await fetchAnalyticsOverview(selectedStudioId, days));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not load overview");
    } finally {
      setLoadingOverview(false);
    }
  }, [selectedStudioId, period]);

  const loadCharts = useCallback(async () => {
    if (!selectedStudioId) {
      setTrends(null);
      setBreakdown(null);
      setLoadingCharts(false);
      return;
    }
    setLoadingCharts(true);
    try {
      const days = periodToDays(period);
      const [t, b] = await Promise.all([
        fetchAnalyticsTrends(selectedStudioId, days),
        fetchAnalyticsClassBreakdown(selectedStudioId, days),
      ]);
      setTrends(t);
      setBreakdown(b);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not load chart data");
    } finally {
      setLoadingCharts(false);
    }
  }, [selectedStudioId, period]);

  const loadBusiness = useCallback(async () => {
    if (!selectedStudioId) {
      setBusiness(null);
      setLoadingBusiness(false);
      return;
    }
    setLoadingBusiness(true);
    try {
      const days = periodToDays(period);
      setBusiness(await fetchAnalyticsBusiness(selectedStudioId, days));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not load business analytics");
    } finally {
      setLoadingBusiness(false);
    }
  }, [selectedStudioId, period]);

  const refreshAll = useCallback(() => {
    void loadFinancial();
    void loadOverview();
    void loadCharts();
    void loadBusiness();
  }, [loadFinancial, loadOverview, loadCharts, loadBusiness]);

  useEffect(() => {
    const t = setTimeout(() => void loadFinancial(), 0);
    return () => clearTimeout(t);
  }, [loadFinancial]);

  useEffect(() => {
    const t = setTimeout(() => void loadOverview(), 0);
    return () => clearTimeout(t);
  }, [loadOverview]);

  useEffect(() => {
    const t = setTimeout(() => void loadCharts(), 0);
    return () => clearTimeout(t);
  }, [loadCharts]);

  useEffect(() => {
    const t = setTimeout(() => void loadBusiness(), 0);
    return () => clearTimeout(t);
  }, [loadBusiness]);

  const lastUpdated = financial?.generatedAt
    ? new Intl.DateTimeFormat("es-MX", { timeStyle: "short" }).format(
        new Date(financial.generatedAt),
      )
    : null;

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.location.hash !== "#analytics-charts") return;
    chartsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [financial]);

  if (studioLoading) {
    return <p className="text-sm text-zinc-500">Cargando estudios…</p>;
  }

  if (studioError) {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-800">
        {studioError}
      </div>
    );
  }

  if (!selectedStudioId) {
    return (
      <div className="rounded-2xl border border-zinc-200 bg-white p-8 text-center">
        <p className="text-sm text-zinc-600">
          No se encontraron membresías de estudio para esta cuenta.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Analytics"
        subtitle="Resumen financiero y operación del estudio."
        actions={
          <>
            {lastUpdated ? (
              <span className="text-xs text-zinc-500">Actualizado {lastUpdated}</span>
            ) : null}
            <button
              type="button"
              onClick={refreshAll}
              className="rounded-xl border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-700 shadow-sm transition hover:bg-zinc-50"
            >
              Actualizar
            </button>
          </>
        }
      />

      {error ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {error}
          <button
            type="button"
            className="ml-3 font-medium underline"
            onClick={() => {
              setError(null);
              refreshAll();
            }}
          >
            Reintentar
          </button>
        </div>
      ) : null}

      <FinancialKpiSection
        data={financial}
        loading={loadingFinancial}
        period={financialPeriod}
        onPeriodChange={setFinancialPeriod}
      />

      <section className="space-y-6">
        <SectionHeader title="Ingresos" />

        <div className="grid gap-4 lg:grid-cols-2">
          <ChartShell title="Ingresos cobrados en el periodo" loading={loadingFinancial}>
            {financial ? (
              <RevenueTrend30Chart
                rows={financial.charts.collectedTrend.map((r) => ({
                  date: r.date,
                  amountCents: r.amountCents,
                }))}
                currency={studioCurrency}
              />
            ) : null}
          </ChartShell>
          <ChartShell title="Stripe vs efectivo" loading={loadingFinancial}>
            {financial ? (
              <StripeVsCashChart rows={financial.charts.stripeVsCash} currency={studioCurrency} />
            ) : null}
          </ChartShell>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <ChartShell title="Número de pagos" loading={loadingFinancial}>
            {financial ? (
              <PaymentCountTrendChart rows={financial.charts.collectedTrend} />
            ) : null}
          </ChartShell>
          <ChartShell title="Ingresos por membresía" loading={loadingFinancial}>
            {financial ? (
              <RevenueByPlanChart rows={financial.charts.revenueByPlan} currency={studioCurrency} />
            ) : null}
          </ChartShell>
        </div>
      </section>

      <section
        id="analytics-charts"
        ref={chartsRef}
        className="scroll-mt-8 space-y-6 border-t border-zinc-200 pt-10"
      >
        <SectionHeader
          title="Operación"
          actions={<PeriodSegment value={period} onChange={setPeriod} />}
        />

        <div className="grid gap-4 lg:grid-cols-2">
          <ChartShell title="Actividad de membresías" loading={loadingBusiness}>
            {business ? (
              <MembershipActivityChart rows={business.memberSignupsTrend} />
            ) : null}
          </ChartShell>
          <ChartShell title="Tendencia de asistencia" loading={loadingCharts}>
            {trends ? <AttendanceTrendChart trends={trends} /> : null}
          </ChartShell>
        </div>

        <ChartShell title="Reservas y asistencia" loading={loadingCharts}>
          {trends ? <BookingsAttendanceChart trends={trends} /> : null}
        </ChartShell>

        <div className="grid gap-4 lg:grid-cols-2">
          <ChartShell title="Distribución de membresías" loading={loadingBusiness}>
            {business ? (
              <SubscriptionStatusChart breakdown={business.subscriptionStatusBreakdown} />
            ) : null}
          </ChartShell>
          <ChartShell title="Retención" loading={loadingBusiness}>
            {business ? (
              <BookingFrequencyChart
                buckets={business.bookingFrequencyBuckets}
                ratePercent={business.repeatBookingRatePercent}
              />
            ) : null}
          </ChartShell>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <ChartShell title="Horarios pico (clases programadas)" loading={loadingCharts}>
            {breakdown ? <PeakHoursChart breakdown={breakdown} /> : null}
          </ChartShell>
          <ChartShell title="Clases más populares" loading={loadingCharts}>
            {breakdown ? <TopClassesChart breakdown={breakdown} /> : null}
          </ChartShell>
        </div>

        {!loadingOverview && (overview?.mostPopularTemplate ?? overview?.mostActiveCoach) ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {overview?.mostPopularTemplate ? (
              <SurfaceCard>
                <p className="text-xs font-medium text-zinc-500">Clase más popular</p>
                <p className="mt-1 truncate text-base font-semibold text-zinc-900">
                  {overview.mostPopularTemplate.name}
                </p>
                <p className="text-xs text-zinc-500">
                  {fmt(overview.mostPopularTemplate.bookingCount)} reservas
                </p>
              </SurfaceCard>
            ) : null}
            {overview?.mostActiveCoach ? (
              <SurfaceCard>
                <p className="text-xs font-medium text-zinc-500">Coach más activo</p>
                <p className="mt-1 truncate text-base font-semibold text-zinc-900">
                  {overview.mostActiveCoach.firstName} {overview.mostActiveCoach.lastName}
                </p>
                <p className="text-xs text-zinc-500">
                  {fmt(overview.mostActiveCoach.classCount)} clases ·{" "}
                  {periodLabel(overview.periodDays ?? periodToDays(period))}
                </p>
              </SurfaceCard>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
