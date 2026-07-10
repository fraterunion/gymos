"use client";

import { useCallback, useEffect, useState } from "react";
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

import { useDeskStudio } from "@/contexts/DeskStudioContext";
import {
  AlertsSection,
  BusinessOverviewSection,
  DataQualityBanners,
  MemberHealthSection,
  MembershipBusinessSection,
  OperationsSection,
  SalesSection,
  fmt,
  fmtMoney,
} from "@/components/analytics/BiDashboard";
import { ApiError } from "@/lib/api/errors";
import {
  fetchAnalyticsBusiness,
  fetchAnalyticsClassBreakdown,
  fetchAnalyticsOverview,
  fetchAnalyticsTrends,
  type BusinessAnalyticsDto,
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

// fmt / fmtMoney imported from BiDashboard for charts below

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
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-5 shadow-sm">
      <p className="mb-4 text-xs font-semibold uppercase tracking-wider text-zinc-500">
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

const SUBSCRIPTION_CHART_COLORS: Record<string, string> = {
  ACTIVE: "#34d399",
  TRIALING: "#22d3ee",
  PAST_DUE: "#fbbf24",
  PAUSED: "#a78bfa",
  CANCELED: "#fb7185",
};

function formatSubscriptionStatus(status: string): string {
  return status.replaceAll("_", " ");
}

function RevenueTrend30Chart({
  rows,
  dark,
}: {
  rows: BusinessAnalyticsDto["revenueTrend"];
  dark: boolean;
}) {
  const data = rows.map((r) => ({
    date: fmtDate(r.date),
    Revenue: Math.round(r.amountCents) / 100,
  }));
  const gridColor = dark ? "#3f3f46" : "#e4e4e7";
  const textColor = dark ? "#71717a" : "#a1a1aa";
  if (data.every((d) => d.Revenue === 0)) {
    return (
      <p className="py-10 text-center text-sm text-zinc-400 dark:text-zinc-600">
        No succeeded payments in the last 30 days.
      </p>
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
          contentStyle={{
            background: dark ? "#18181b" : "#ffffff",
            border: `1px solid ${dark ? "#3f3f46" : "#e4e4e7"}`,
            borderRadius: 8,
            fontSize: 12,
          }}
          formatter={(value) => [
            fmtMoney(Math.round(Number(value ?? 0) * 100)),
            "Revenue",
          ]}
        />
        <Line
          type="monotone"
          dataKey="Revenue"
          stroke="#fbbf24"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4, fill: "#fbbf24" }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function SubscriptionStatusChart({
  breakdown,
  dark,
}: {
  breakdown: BusinessAnalyticsDto["subscriptionStatusBreakdown"];
  dark: boolean;
}) {
  const data = breakdown
    .filter((b) => b.count > 0)
    .map((b) => ({
      name: formatSubscriptionStatus(b.status),
      count: b.count,
      fill: SUBSCRIPTION_CHART_COLORS[b.status] ?? "#71717a",
    }));
  if (data.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-zinc-400 dark:text-zinc-600">No subscriptions yet</p>
    );
  }
  const gridColor = dark ? "#3f3f46" : "#e4e4e7";
  const textColor = dark ? "#71717a" : "#a1a1aa";
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
          contentStyle={{
            background: dark ? "#18181b" : "#ffffff",
            border: `1px solid ${dark ? "#3f3f46" : "#e4e4e7"}`,
            borderRadius: 8,
            fontSize: 12,
          }}
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
  dark,
}: {
  buckets: BusinessAnalyticsDto["bookingFrequencyBuckets"];
  ratePercent: number;
  dark: boolean;
}) {
  const data = buckets.map((b) => ({ name: b.label, Members: b.memberCount }));
  const total = buckets.reduce((s, b) => s + b.memberCount, 0);
  if (total === 0) {
    return (
      <p className="py-10 text-center text-sm text-zinc-400 dark:text-zinc-600">
        No member bookings in the last 30 days.
      </p>
    );
  }
  const gridColor = dark ? "#3f3f46" : "#e4e4e7";
  const textColor = dark ? "#71717a" : "#a1a1aa";
  return (
    <div>
      <p className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">
        Members with bookings · repeat rate {fmt(ratePercent, 1)}% (2+ ÷ with 1+)
      </p>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
          <XAxis
            dataKey="name"
            tick={{ fill: textColor, fontSize: 11 }}
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
          />
          <Bar dataKey="Members" fill="#818cf8" radius={[6, 6, 0, 0]} maxBarSize={56} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function RevenueByPlanChart({
  rows,
  dark,
}: {
  rows: BusinessAnalyticsDto["revenueByPlan"];
  dark: boolean;
}) {
  if (rows.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-zinc-400 dark:text-zinc-600">
        No payment totals attributed to a plan in the last 30 days.
      </p>
    );
  }
  const data = rows.map((r) => ({
    name: r.planName.length > 16 ? r.planName.slice(0, 15) + "…" : r.planName,
    Revenue: Math.round(r.revenueCents) / 100,
  }));
  const gridColor = dark ? "#3f3f46" : "#e4e4e7";
  const textColor = dark ? "#71717a" : "#a1a1aa";
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: -24, bottom: 0 }}>
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
          tickFormatter={(v) => `$${v}`}
        />
        <Tooltip
          contentStyle={{
            background: dark ? "#18181b" : "#ffffff",
            border: `1px solid ${dark ? "#3f3f46" : "#e4e4e7"}`,
            borderRadius: 8,
            fontSize: 12,
          }}
          formatter={(value) => [fmtMoney(Math.round(Number(value ?? 0) * 100)), "Attributed"]}
        />
        <Bar dataKey="Revenue" fill="#34d399" radius={[4, 4, 0, 0]} maxBarSize={44} />
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
  const [business, setBusiness] = useState<BusinessAnalyticsDto | null>(null);

  const [loadingOverview, setLoadingOverview] = useState(true);
  const [loadingCharts, setLoadingCharts] = useState(true);
  const [loadingBusiness, setLoadingBusiness] = useState(true);
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
    <div className="space-y-10 rounded-3xl border border-zinc-800/60 bg-zinc-950 p-6 sm:p-8">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-500">
            Business intelligence
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-50">
            Analytics
          </h1>
          {lastRefreshed ? (
            <p className="mt-1 text-xs text-zinc-500">
              Updated at {lastRefreshed} · UTC day boundaries
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-zinc-700 p-0.5">
            {PERIOD_OPTIONS.map(({ label, days }) => (
              <button
                key={days}
                type="button"
                onClick={() => setPeriod(days)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
                  period === days
                    ? "bg-zinc-100 text-zinc-900"
                    : "text-zinc-400 hover:text-zinc-100"
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
              void loadBusiness();
            }}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-900"
          >
            Refresh
          </button>
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-amber-800/40 bg-amber-950/30 px-4 py-3 text-sm text-amber-100">
          {error}
          <button
            type="button"
            className="ml-3 font-semibold underline"
            onClick={() => {
              setError(null);
              void loadOverview();
              void loadCharts();
              void loadBusiness();
            }}
          >
            Retry
          </button>
        </div>
      ) : null}

      <DataQualityBanners business={business} />

      <BusinessOverviewSection business={business} loading={loadingBusiness} />
      <MembershipBusinessSection business={business} loading={loadingBusiness} />
      <SalesSection business={business} loading={loadingBusiness} />
      <OperationsSection
        overview={overview}
        trends={trends}
        breakdown={breakdown}
        business={business}
        period={period}
        loadingOverview={loadingOverview}
        loadingCharts={loadingCharts}
      />
      <MemberHealthSection business={business} loading={loadingBusiness} />
      <AlertsSection overview={overview} business={business} loading={loadingBusiness || loadingOverview} />

      {/* Charts — unchanged */}
      <section className="space-y-6 border-t border-zinc-800/80 pt-8">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            Trends & breakdown
          </p>
          <h2 className="mt-1 text-lg font-semibold text-zinc-100">
            Revenue, retention, and class engagement
          </h2>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <ChartShell title="Revenue trend · 30d (succeeded)" loading={loadingBusiness}>
            {business ? <RevenueTrend30Chart rows={business.revenueTrend} dark={dark} /> : null}
          </ChartShell>
          <ChartShell title="Subscription status" loading={loadingBusiness}>
            {business ? (
              <SubscriptionStatusChart breakdown={business.subscriptionStatusBreakdown} dark={dark} />
            ) : null}
          </ChartShell>
          <ChartShell title="Retention · booking frequency (members)" loading={loadingBusiness}>
            {business ? (
              <BookingFrequencyChart
                buckets={business.bookingFrequencyBuckets}
                ratePercent={business.repeatBookingRatePercent}
                dark={dark}
              />
            ) : null}
          </ChartShell>
          <ChartShell title="Revenue by plan · 30d (attributed)" loading={loadingBusiness}>
            {business ? <RevenueByPlanChart rows={business.revenueByPlan} dark={dark} /> : null}
          </ChartShell>
        </div>

        {business && business.unattributedRevenueCents > 0 ? (
          <p className="text-xs text-zinc-500">
            Unattributed to a plan:{" "}
            <span className="font-semibold text-zinc-300">
              {fmtMoney(business.unattributedRevenueCents)}
            </span>{" "}
            (payers without a resolvable subscription row).
          </p>
        ) : null}

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

        <div className="grid gap-6 lg:grid-cols-2">
          <ChartShell title={`Top class types · ${period}d`} loading={loadingCharts}>
            {breakdown ? <TopClassesChart breakdown={breakdown} dark={dark} /> : null}
          </ChartShell>
          <ChartShell title={`Peak class hours · ${period}d (UTC)`} loading={loadingCharts}>
            {breakdown ? <PeakHoursChart breakdown={breakdown} dark={dark} /> : null}
          </ChartShell>
        </div>

        {!loadingOverview && (overview?.mostPopularTemplate ?? overview?.mostActiveCoach) ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {overview?.mostPopularTemplate ? (
              <div className="flex items-center gap-4 rounded-2xl border border-zinc-800 bg-zinc-950/80 p-5">
                {overview.mostPopularTemplate.color ? (
                  <span
                    className="h-10 w-10 shrink-0 rounded-xl"
                    style={{ backgroundColor: overview.mostPopularTemplate.color }}
                  />
                ) : (
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-900/30 text-lg">
                    🏆
                  </span>
                )}
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                    Most popular class · 30d
                  </p>
                  <p className="mt-0.5 truncate text-base font-bold text-zinc-50">
                    {overview.mostPopularTemplate.name}
                  </p>
                  <p className="text-xs text-zinc-500">
                    {fmt(overview.mostPopularTemplate.bookingCount)} bookings
                  </p>
                </div>
              </div>
            ) : null}
            {overview?.mostActiveCoach ? (
              <div className="flex items-center gap-4 rounded-2xl border border-zinc-800 bg-zinc-950/80 p-5">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-900/30 text-lg">
                  🎤
                </span>
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                    Most active coach · 30d
                  </p>
                  <p className="mt-0.5 truncate text-base font-bold text-zinc-50">
                    {overview.mostActiveCoach.firstName} {overview.mostActiveCoach.lastName}
                  </p>
                  <p className="text-xs text-zinc-500">
                    {fmt(overview.mostActiveCoach.classCount)} classes
                  </p>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* Footer note */}
      <p className="text-center text-[11px] leading-relaxed text-zinc-600">
        All metrics scoped to the selected studio. UTC boundaries. Gross revenue = succeeded{" "}
        <code className="rounded bg-zinc-900 px-1 text-zinc-400">payments</code>. MRR/ARR = plan-price
        estimate. Omitted: net revenue, Stripe fees, taxes, enrollment/founders dollar splits (not in
        ledger), studio-scoped webhook errors.
      </p>
    </div>
  );
}
