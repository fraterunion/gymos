"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
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

import { OwnerBriefing } from "@/components/analytics/OwnerBriefing";
import { PageHeader } from "@/components/shell/PageHeader";
import { SectionHeader } from "@/components/shell/SectionHeader";
import { SurfaceCard } from "@/components/shell/SurfaceCard";
import { useDeskStudio } from "@/contexts/DeskStudioContext";
import { ApiError } from "@/lib/api/errors";
import {
  fetchAnalyticsBriefing,
  fetchAnalyticsBusiness,
  fetchAnalyticsClassBreakdown,
  fetchAnalyticsOverview,
  fetchAnalyticsTrends,
  type BusinessAnalyticsDto,
  type ClassBreakdownDto,
  type OwnerBriefingDto,
  type OverviewDto,
  type TrendsDto,
} from "@/lib/api/analytics";

const CHART_GRID = "#e4e4e7";
const CHART_TEXT = "#a1a1aa";
const TOOLTIP_STYLE = {
  background: "#ffffff",
  border: "1px solid #e4e4e7",
  borderRadius: 8,
  fontSize: 12,
  color: "#18181b",
};

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

function fmtMoney(cents: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
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

function RevenueTrend30Chart({
  rows,
}: {
  rows: BusinessAnalyticsDto["revenueTrend"];
}) {
  const data = rows.map((r) => ({
    date: fmtDate(r.date),
    Revenue: Math.round(r.amountCents) / 100,
  }));
  const gridColor = CHART_GRID;
  const textColor = CHART_TEXT;
  if (data.every((d) => d.Revenue === 0)) {
    return (
      <p className="py-10 text-center text-sm text-zinc-500">No collected payments in the last 30 days.</p>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
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
          tickFormatter={(v) => `$${v}`}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          formatter={(value) => [
            fmtMoney(Math.round(Number(value ?? 0) * 100)),
            "Collected",
          ]}
        />
        <Line
          type="monotone"
          dataKey="Revenue"
          stroke="#18181b"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4, fill: "#18181b" }}
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
    Members: r.count,
  }));
  const gridColor = CHART_GRID;
  const textColor = CHART_TEXT;
  if (data.every((d) => d.Members === 0)) {
    return (
      <p className="py-10 text-center text-sm text-zinc-500">No new memberships in the last 30 days.</p>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
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
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
        />
        <Line
          type="monotone"
          dataKey="Members"
          stroke="#52525b"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4, fill: "#52525b" }}
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
    Attendance: a.count,
  }));
  const gridColor = CHART_GRID;
  const textColor = CHART_TEXT;
  if (data.every((d) => d.Attendance === 0)) {
    return <p className="py-10 text-center text-sm text-zinc-500">No check-ins in this period.</p>;
  }
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
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
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
        />
        <Line
          type="monotone"
          dataKey="Attendance"
          stroke="#71717a"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4, fill: "#71717a" }}
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
    Bookings: b.count,
    Attendance: trends.attendances[i]?.count ?? 0,
  }));
  const gridColor = CHART_GRID;
  const textColor = CHART_TEXT;

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
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
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
        />
        <Line type="monotone" dataKey="Bookings" stroke="#a1a1aa" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="Attendance" stroke="#52525b" strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

const SUBSCRIPTION_CHART_COLORS: Record<string, string> = {
  ACTIVE: "#52525b",
  TRIALING: "#a1a1aa",
  PAST_DUE: "#d4d4d8",
  PAUSED: "#e4e4e7",
  CANCELED: "#f4f4f5",
};

function formatSubscriptionStatus(status: string): string {
  return status.replaceAll("_", " ");
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
      fill: SUBSCRIPTION_CHART_COLORS[b.status] ?? "#71717a",
    }));
  if (data.length === 0) {
    return <p className="py-10 text-center text-sm text-zinc-500">No subscriptions yet</p>;
  }
  const gridColor = CHART_GRID;
  const textColor = CHART_TEXT;
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
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
        />
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
  const data = buckets.map((b) => ({ name: b.label, Members: b.memberCount }));
  const total = buckets.reduce((s, b) => s + b.memberCount, 0);
  if (total === 0) {
    return (
      <p className="py-10 text-center text-sm text-zinc-500">No member bookings in the last 30 days.</p>
    );
  }
  const gridColor = CHART_GRID;
  const textColor = CHART_TEXT;
  return (
    <div>
      <p className="mb-2 text-xs text-zinc-500">
        Members with bookings · repeat rate {fmt(ratePercent, 1)}%
      </p>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
          <XAxis dataKey="name" tick={{ fill: textColor, fontSize: 11 }} tickLine={false} axisLine={false} />
          <YAxis tick={{ fill: textColor, fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
          />
          <Bar dataKey="Members" fill="#a1a1aa" radius={[6, 6, 0, 0]} maxBarSize={56} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function RevenueByPlanChart({
  rows,
}: {
  rows: BusinessAnalyticsDto["revenueByPlan"];
}) {
  if (rows.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-zinc-500">No plan-attributed revenue in the last 30 days.</p>
    );
  }
  const data = rows.map((r) => ({
    name: r.planName.length > 16 ? r.planName.slice(0, 15) + "…" : r.planName,
    Revenue: Math.round(r.revenueCents) / 100,
  }));
  const gridColor = CHART_GRID;
  const textColor = CHART_TEXT;
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: -24, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
        <XAxis dataKey="name" tick={{ fill: textColor, fontSize: 10 }} tickLine={false} axisLine={false} />
        <YAxis tick={{ fill: textColor, fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(v) => `$${v}`} />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          formatter={(value) => [fmtMoney(Math.round(Number(value ?? 0) * 100)), "Collected"]}
        />
        <Bar dataKey="Revenue" fill="#71717a" radius={[4, 4, 0, 0]} maxBarSize={44} />
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
    Bookings: t.bookingCount,
  }));
  if (data.length === 0) {
    return <p className="py-10 text-center text-sm text-zinc-500">No data yet</p>;
  }
  const gridColor = CHART_GRID;
  const textColor = CHART_TEXT;
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
        <XAxis dataKey="name" tick={{ fill: textColor, fontSize: 10 }} tickLine={false} axisLine={false} />
        <YAxis tick={{ fill: textColor, fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
        />
        <Bar dataKey="Bookings" fill="#a1a1aa" radius={[4, 4, 0, 0]} maxBarSize={48} />
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
    return <p className="py-10 text-center text-sm text-zinc-500">No data yet</p>;
  }
  const hourMap = new Map(breakdown.peakHours.map((h) => [h.hour, h.count]));
  const data = Array.from({ length: 24 }, (_, h) => ({
    hour: fmtHour(h),
    Classes: hourMap.get(h) ?? 0,
  }));
  const gridColor = CHART_GRID;
  const textColor = CHART_TEXT;
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
        <XAxis dataKey="hour" tick={{ fill: textColor, fontSize: 9 }} tickLine={false} axisLine={false} interval={2} />
        <YAxis tick={{ fill: textColor, fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
        />
        <Bar dataKey="Classes" fill="#d4d4d8" radius={[3, 3, 0, 0]} maxBarSize={24} />
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

  const [period, setPeriod] = useState<PeriodKey>(30);
  const [briefing, setBriefing] = useState<OwnerBriefingDto | null>(null);
  const [overview, setOverview] = useState<OverviewDto | null>(null);
  const [trends, setTrends] = useState<TrendsDto | null>(null);
  const [breakdown, setBreakdown] = useState<ClassBreakdownDto | null>(null);
  const [business, setBusiness] = useState<BusinessAnalyticsDto | null>(null);

  const [loadingBriefing, setLoadingBriefing] = useState(true);
  const [loadingOverview, setLoadingOverview] = useState(true);
  const [loadingCharts, setLoadingCharts] = useState(true);
  const [loadingBusiness, setLoadingBusiness] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadBriefing = useCallback(async () => {
    if (!selectedStudioId) {
      setBriefing(null);
      setLoadingBriefing(false);
      return;
    }
    setLoadingBriefing(true);
    try {
      setBriefing(await fetchAnalyticsBriefing(selectedStudioId));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not load briefing");
    } finally {
      setLoadingBriefing(false);
    }
  }, [selectedStudioId]);

  const loadOverview = useCallback(async () => {
    if (!selectedStudioId) {
      setOverview(null);
      setLoadingOverview(false);
      return;
    }
    setLoadingOverview(true);
    try {
      setOverview(await fetchAnalyticsOverview(selectedStudioId));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not load overview");
    } finally {
      setLoadingOverview(false);
    }
  }, [selectedStudioId]);

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
      setBusiness(await fetchAnalyticsBusiness(selectedStudioId));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not load business analytics");
    } finally {
      setLoadingBusiness(false);
    }
  }, [selectedStudioId]);

  const refreshAll = useCallback(() => {
    void loadBriefing();
    void loadOverview();
    void loadCharts();
    void loadBusiness();
  }, [loadBriefing, loadOverview, loadCharts, loadBusiness]);

  useEffect(() => {
    const t = setTimeout(() => void loadBriefing(), 0);
    return () => clearTimeout(t);
  }, [loadBriefing]);

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

  const lastUpdated = briefing?.generatedAt
    ? new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(
        new Date(briefing.generatedAt),
      )
    : null;

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.location.hash !== "#analytics-charts") return;
    chartsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [briefing]);

  if (studioLoading) {
    return <p className="text-sm text-zinc-500">Loading studios…</p>;
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
          No studio memberships found for this account.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Analytics"
        subtitle="Resumen del negocio y rendimiento de ARES."
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

      <OwnerBriefing
        briefing={briefing}
        loading={loadingBriefing}
        revenueTrend={business?.revenueTrend}
      />

      <section
        id="analytics-charts"
        ref={chartsRef}
        className="scroll-mt-8 space-y-6 border-t border-zinc-200 pt-10"
      >
        <SectionHeader
          title="Rendimiento"
          actions={<PeriodSegment value={period} onChange={setPeriod} />}
        />

        <ChartShell title="Tendencia de ingresos" loading={loadingBusiness}>
          {business ? <RevenueTrend30Chart rows={business.revenueTrend} /> : null}
        </ChartShell>

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
          <ChartShell title="Ingresos por membresía" loading={loadingBusiness}>
            {business ? <RevenueByPlanChart rows={business.revenueByPlan} /> : null}
          </ChartShell>
          <ChartShell title="Distribución de membresías" loading={loadingBusiness}>
            {business ? (
              <SubscriptionStatusChart breakdown={business.subscriptionStatusBreakdown} />
            ) : null}
          </ChartShell>
        </div>

        <ChartShell title="Retención" loading={loadingBusiness}>
          {business ? (
            <BookingFrequencyChart
              buckets={business.bookingFrequencyBuckets}
              ratePercent={business.repeatBookingRatePercent}
            />
          ) : null}
        </ChartShell>

        <div className="grid gap-4 lg:grid-cols-2">
          <ChartShell title="Horarios pico" loading={loadingCharts}>
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
                  {fmt(overview.mostActiveCoach.classCount)} clases
                </p>
              </SurfaceCard>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
