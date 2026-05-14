"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { useDeskStudio } from "@/contexts/DeskStudioContext";
import { ApiError } from "@/lib/api/errors";
import {
  fetchAnalyticsClassBreakdown,
  fetchAnalyticsOverview,
  fetchAnalyticsTrends,
  type ClassBreakdownDto,
  type OverviewDto,
  type TrendsDto,
} from "@/lib/api/analytics";

// ── colour scheme ─────────────────────────────────────────────────────────────

function useColorScheme() {
  const [dark, setDark] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return dark;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number, decimals = 0): string {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
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

// ── KPI card ──────────────────────────────────────────────────────────────────

type KpiCardProps = {
  label: string;
  value: string | number;
  sub?: string;
  accent?: "blue" | "green" | "amber" | "violet" | "rose" | "default";
  loading?: boolean;
};

function KpiCard({ label, value, sub, accent = "default", loading }: KpiCardProps) {
  const accentClass: Record<string, string> = {
    blue: "border-l-blue-500",
    green: "border-l-emerald-500",
    amber: "border-l-amber-500",
    violet: "border-l-violet-500",
    rose: "border-l-rose-500",
    default: "border-l-zinc-300 dark:border-l-zinc-700",
  };

  return (
    <div
      className={`rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 border-l-4 ${accentClass[accent]}`}
    >
      {loading ? (
        <div className="space-y-2">
          <div className="h-3 w-24 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
          <div className="h-7 w-16 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
        </div>
      ) : (
        <>
          <p className="text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            {label}
          </p>
          <p className="mt-1.5 text-3xl font-bold tabular-nums text-zinc-900 dark:text-zinc-50">
            {typeof value === "number" ? fmt(value) : value}
          </p>
          {sub ? (
            <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">{sub}</p>
          ) : null}
        </>
      )}
    </div>
  );
}

// ── chart wrappers ────────────────────────────────────────────────────────────

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
    <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <p className="mb-4 text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
        {title}
      </p>
      {loading ? (
        <div className="flex h-48 items-center justify-center">
          <p className="text-sm text-zinc-400 dark:text-zinc-600">Loading…</p>
        </div>
      ) : (
        children
      )}
    </div>
  );
}

function TrendChart({
  trends,
  dark,
}: {
  trends: TrendsDto;
  dark: boolean;
}) {
  const data = trends.bookings.map((b, i) => ({
    date: fmtDate(b.date),
    Bookings: b.count,
    Attendance: trends.attendances[i]?.count ?? 0,
  }));

  const gridColor = dark ? "#3f3f46" : "#e4e4e7";
  const textColor = dark ? "#71717a" : "#a1a1aa";

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
          contentStyle={{
            background: dark ? "#18181b" : "#ffffff",
            border: `1px solid ${dark ? "#3f3f46" : "#e4e4e7"}`,
            borderRadius: 8,
            fontSize: 12,
          }}
          labelStyle={{ color: dark ? "#a1a1aa" : "#71717a", marginBottom: 4 }}
        />
        <Line
          type="monotone"
          dataKey="Bookings"
          stroke="#818cf8"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4, fill: "#818cf8" }}
        />
        <Line
          type="monotone"
          dataKey="Attendance"
          stroke="#34d399"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4, fill: "#34d399" }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function TopClassesChart({
  breakdown,
  dark,
}: {
  breakdown: ClassBreakdownDto;
  dark: boolean;
}) {
  const data = breakdown.topTemplates.map((t) => ({
    name: t.name.length > 14 ? t.name.slice(0, 13) + "…" : t.name,
    Bookings: t.bookingCount,
    color: t.color ?? "#818cf8",
  }));

  if (data.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-zinc-400 dark:text-zinc-600">No data yet</p>
    );
  }

  const gridColor = dark ? "#3f3f46" : "#e4e4e7";
  const textColor = dark ? "#71717a" : "#a1a1aa";

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
        <XAxis
          dataKey="name"
          tick={{ fill: textColor, fontSize: 10 }}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          tick={{ fill: textColor, fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          allowDecimals={false}
        />
        <Tooltip
          contentStyle={{
            background: dark ? "#18181b" : "#ffffff",
            border: `1px solid ${dark ? "#3f3f46" : "#e4e4e7"}`,
            borderRadius: 8,
            fontSize: 12,
          }}
          labelStyle={{ color: dark ? "#a1a1aa" : "#71717a", marginBottom: 4 }}
        />
        <Bar dataKey="Bookings" fill="#818cf8" radius={[4, 4, 0, 0]} maxBarSize={48} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function PeakHoursChart({
  breakdown,
  dark,
}: {
  breakdown: ClassBreakdownDto;
  dark: boolean;
}) {
  if (breakdown.peakHours.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-zinc-400 dark:text-zinc-600">No data yet</p>
    );
  }

  // Fill all 24 hours with 0 for gaps
  const hourMap = new Map(breakdown.peakHours.map((h) => [h.hour, h.count]));
  const data = Array.from({ length: 24 }, (_, h) => ({
    hour: fmtHour(h),
    Classes: hourMap.get(h) ?? 0,
  }));

  const gridColor = dark ? "#3f3f46" : "#e4e4e7";
  const textColor = dark ? "#71717a" : "#a1a1aa";

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
        <XAxis
          dataKey="hour"
          tick={{ fill: textColor, fontSize: 9 }}
          tickLine={false}
          axisLine={false}
          interval={2}
        />
        <YAxis
          tick={{ fill: textColor, fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          allowDecimals={false}
        />
        <Tooltip
          contentStyle={{
            background: dark ? "#18181b" : "#ffffff",
            border: `1px solid ${dark ? "#3f3f46" : "#e4e4e7"}`,
            borderRadius: 8,
            fontSize: 12,
          }}
          labelStyle={{ color: dark ? "#a1a1aa" : "#71717a", marginBottom: 4 }}
        />
        <Bar dataKey="Classes" fill="#34d399" radius={[3, 3, 0, 0]} maxBarSize={24} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── legend dot ────────────────────────────────────────────────────────────────

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
      <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────

const PERIOD_OPTIONS = [
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
] as const;

export default function AnalyticsPage() {
  const { selectedStudioId, loading: studioLoading, error: studioError } = useDeskStudio();
  const dark = useColorScheme();

  const [period, setPeriod] = useState<7 | 30>(7);
  const [overview, setOverview] = useState<OverviewDto | null>(null);
  const [trends, setTrends] = useState<TrendsDto | null>(null);
  const [breakdown, setBreakdown] = useState<ClassBreakdownDto | null>(null);

  const [loadingOverview, setLoadingOverview] = useState(true);
  const [loadingCharts, setLoadingCharts] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
      const [t, b] = await Promise.all([
        fetchAnalyticsTrends(selectedStudioId, period),
        fetchAnalyticsClassBreakdown(selectedStudioId, period),
      ]);
      setTrends(t);
      setBreakdown(b);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not load chart data");
    } finally {
      setLoadingCharts(false);
    }
  }, [selectedStudioId, period]);

  useEffect(() => {
    const t = setTimeout(() => void loadOverview(), 0);
    return () => clearTimeout(t);
  }, [loadOverview]);

  useEffect(() => {
    const t = setTimeout(() => void loadCharts(), 0);
    return () => clearTimeout(t);
  }, [loadCharts]);

  const lastRefreshed = overview?.generatedAt
    ? new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(
        new Date(overview.generatedAt),
      )
    : null;

  if (studioLoading) {
    return <p className="text-sm text-zinc-500">Loading studios…</p>;
  }

  if (studioError) {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200">
        {studioError}
      </div>
    );
  }

  if (!selectedStudioId) {
    return (
      <div className="rounded-2xl border border-zinc-200 bg-white p-8 text-center dark:border-zinc-800 dark:bg-zinc-900">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          No studio memberships found for this account.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Analytics
          </h1>
          {lastRefreshed ? (
            <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
              Updated at {lastRefreshed} · UTC day boundaries
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-zinc-200 p-0.5 dark:border-zinc-700">
            {PERIOD_OPTIONS.map(({ label, days }) => (
              <button
                key={days}
                type="button"
                onClick={() => setPeriod(days)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
                  period === days
                    ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                    : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              void loadOverview();
              void loadCharts();
            }}
            className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            Refresh
          </button>
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-100">
          {error}
          <button
            type="button"
            className="ml-3 font-semibold underline"
            onClick={() => {
              setError(null);
              void loadOverview();
              void loadCharts();
            }}
          >
            Retry
          </button>
        </div>
      ) : null}

      {/* KPI grid — today */}
      <section>
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-600">
          Today
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiCard
            label="Active members"
            value={overview?.activeMembers ?? 0}
            accent="blue"
            loading={loadingOverview}
          />
          <KpiCard
            label="Check-ins today"
            value={overview?.checkInsToday ?? 0}
            accent="green"
            loading={loadingOverview}
          />
          <KpiCard
            label="Upcoming classes"
            value={overview?.upcomingClassesToday ?? 0}
            sub="remaining today"
            accent="violet"
            loading={loadingOverview}
          />
          <KpiCard
            label="Occupancy rate"
            value={`${fmt(overview?.occupancyRateToday ?? 0, 1)}%`}
            sub="today's classes"
            accent="amber"
            loading={loadingOverview}
          />
        </div>
      </section>

      {/* KPI grid — rolling period */}
      <section>
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-600">
          Last {period} days
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiCard
            label="Bookings"
            value={overview?.bookingsLast7d ?? 0}
            sub="non-cancelled"
            accent="blue"
            loading={loadingOverview}
          />
          <KpiCard
            label="Waitlist entries"
            value={overview?.waitlistCount ?? 0}
            sub="currently waiting"
            accent="amber"
            loading={loadingOverview}
          />
          <KpiCard
            label="No-show rate"
            value={`${fmt(overview?.noShowRate ?? 0, 1)}%`}
            sub="past 30 days"
            accent="rose"
            loading={loadingOverview}
          />
          <KpiCard
            label="Avg class fill"
            value={`${fmt(overview?.avgClassFill ?? 0, 1)}%`}
            sub="past 30 days"
            accent="green"
            loading={loadingOverview}
          />
        </div>
      </section>

      {/* Highlight cards */}
      {!loadingOverview &&
      (overview?.mostPopularTemplate ?? overview?.mostActiveCoach) ? (
        <section className="grid gap-3 sm:grid-cols-2">
          {overview?.mostPopularTemplate ? (
            <div className="flex items-center gap-4 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              {overview.mostPopularTemplate.color ? (
                <span
                  className="h-10 w-10 shrink-0 rounded-xl"
                  style={{ backgroundColor: overview.mostPopularTemplate.color }}
                />
              ) : (
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-100 text-lg dark:bg-violet-900/30">
                  🏆
                </span>
              )}
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                  Most popular class
                </p>
                <p className="mt-0.5 truncate text-base font-bold text-zinc-900 dark:text-zinc-50">
                  {overview.mostPopularTemplate.name}
                </p>
                <p className="text-xs text-zinc-400 dark:text-zinc-500">
                  {fmt(overview.mostPopularTemplate.bookingCount)} bookings · 30 days
                </p>
              </div>
            </div>
          ) : null}

          {overview?.mostActiveCoach ? (
            <div className="flex items-center gap-4 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-lg dark:bg-emerald-900/30">
                🎤
              </span>
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                  Most active coach
                </p>
                <p className="mt-0.5 truncate text-base font-bold text-zinc-900 dark:text-zinc-50">
                  {overview.mostActiveCoach.firstName} {overview.mostActiveCoach.lastName}
                </p>
                <p className="text-xs text-zinc-400 dark:text-zinc-500">
                  {fmt(overview.mostActiveCoach.classCount)} classes · 30 days
                </p>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* Trend chart */}
      <ChartShell title={`Bookings & attendance · ${period}d`} loading={loadingCharts}>
        {trends ? (
          <>
            <TrendChart trends={trends} dark={dark} />
            <div className="mt-3 flex gap-4 pl-2">
              <LegendItem color="#818cf8" label="Bookings" />
              <LegendItem color="#34d399" label="Attendance" />
            </div>
          </>
        ) : null}
      </ChartShell>

      {/* Bottom row charts */}
      <div className="grid gap-6 lg:grid-cols-2">
        <ChartShell title={`Top class types · ${period}d`} loading={loadingCharts}>
          {breakdown ? <TopClassesChart breakdown={breakdown} dark={dark} /> : null}
        </ChartShell>

        <ChartShell title={`Peak class hours · ${period}d (UTC)`} loading={loadingCharts}>
          {breakdown ? <PeakHoursChart breakdown={breakdown} dark={dark} /> : null}
        </ChartShell>
      </div>

      {/* Footer note */}
      <p className="text-center text-[11px] text-zinc-400 dark:text-zinc-600">
        All metrics scoped to the selected studio. Date boundaries use UTC.
        Revenue analytics available after Stripe integration.
      </p>
    </div>
  );
}
