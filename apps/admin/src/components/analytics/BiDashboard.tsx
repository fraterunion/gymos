"use client";

import type { BusinessAnalyticsDto, ClassBreakdownDto, OverviewDto, TrendsDto } from "@/lib/api/analytics";

// ── Formatters ────────────────────────────────────────────────────────────────

export function fmt(n: number, decimals = 0): string {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function fmtMoney(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

function fmtTrendPct(pct: number | null | undefined, label: string): string | undefined {
  if (pct == null) return undefined;
  if (pct === 0) return `Same ${label}`;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${fmt(pct, 1)}% ${label}`;
}

function revenueTodaySub(business: BusinessAnalyticsDto): string | undefined {
  const diff = business.grossRevenueTodayCents - business.grossRevenueYesterdayCents;
  if (business.grossRevenueYesterdayCents === 0) {
    if (diff === 0) return undefined;
    const sign = diff > 0 ? "+" : "−";
    return `${sign}${fmtMoney(Math.abs(diff))} vs yesterday`;
  }
  return fmtTrendPct(business.revenueTodayVsYesterdayPercent, "vs yesterday");
}

function sumRevenueTrendDays(rows: BusinessAnalyticsDto["revenueTrend"], start: number, end: number) {
  return rows.slice(start, end).reduce((s, r) => s + r.amountCents, 0);
}

function revenueDropped(business: BusinessAnalyticsDto): boolean {
  const rows = business.revenueTrend;
  if (rows.length < 14) return false;
  const last7 = sumRevenueTrendDays(rows, rows.length - 7, rows.length);
  const prior7 = sumRevenueTrendDays(rows, rows.length - 14, rows.length - 7);
  return prior7 > 0 && last7 < prior7 * 0.85;
}

function sumTrendCounts(rows: { count: number }[]) {
  return rows.reduce((s, r) => s + r.count, 0);
}

// ── Card primitives ─────────────────────────────────────────────────────────────

type CardTone = "hero" | "primary" | "standard" | "compact" | "alert";

function toneClasses(tone: CardTone, alert?: boolean) {
  const base =
    "rounded-2xl border bg-zinc-950/80 shadow-sm backdrop-blur-sm transition-colors";
  const border = alert
    ? "border-amber-800/50"
    : "border-zinc-800/80";
  const size: Record<CardTone, string> = {
    hero: "p-6 sm:p-8",
    primary: "p-5",
    standard: "p-4",
    compact: "p-3.5",
    alert: "p-4",
  };
  return `${base} ${border} ${size[tone]}`;
}

function valueClasses(tone: CardTone) {
  if (tone === "hero") return "text-4xl sm:text-5xl font-bold tabular-nums tracking-tight text-zinc-50";
  if (tone === "primary") return "text-2xl sm:text-3xl font-bold tabular-nums text-zinc-50";
  if (tone === "compact") return "text-lg font-semibold tabular-nums text-zinc-100";
  if (tone === "alert") return "text-base font-semibold text-zinc-100";
  return "text-xl font-bold tabular-nums text-zinc-50";
}

export function MetricCard({
  label,
  value,
  sub,
  tone = "standard",
  accent,
  loading,
  alert,
  deduction,
}: {
  label: string;
  value: string | number;
  sub?: string;
  tone?: CardTone;
  accent?: "emerald" | "amber" | "rose" | "sky" | "violet" | "zinc";
  loading?: boolean;
  alert?: boolean;
  /** Style value as a deduction / risk (rose), not positive revenue */
  deduction?: boolean;
}) {
  const accentBorder: Record<string, string> = {
    emerald: "border-l-emerald-500/80",
    amber: "border-l-amber-500/80",
    rose: "border-l-rose-500/80",
    sky: "border-l-sky-500/80",
    violet: "border-l-violet-500/80",
    zinc: "border-l-zinc-600",
  };

  return (
    <div
      className={`${toneClasses(tone, alert)} ${accent ? `border-l-4 ${accentBorder[accent]}` : ""}`}
    >
      {loading ? (
        <div className="space-y-2">
          <div className="h-3 w-20 animate-pulse rounded bg-zinc-800" />
          <div className="h-8 w-24 animate-pulse rounded bg-zinc-800" />
        </div>
      ) : (
        <>
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
            {label}
          </p>
          <p
            className={`mt-2 ${valueClasses(tone)}${deduction ? " text-rose-400" : ""}`}
          >
            {typeof value === "number" ? fmt(value) : value}
          </p>
          {sub ? <p className="mt-1.5 text-xs text-zinc-500">{sub}</p> : null}
        </>
      )}
    </div>
  );
}

function SectionHeader({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="mb-4">
      <h2 className="text-sm font-semibold tracking-wide text-zinc-300">{title}</h2>
      {description ? (
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-zinc-500">{description}</p>
      ) : null}
    </div>
  );
}

// ── Sections ──────────────────────────────────────────────────────────────────

export function BusinessOverviewSection({
  business,
  loading,
}: {
  business: BusinessAnalyticsDto | null;
  loading: boolean;
}) {
  return (
    <section>
      <SectionHeader
        title="Resumen financiero"
        description="Ingresos brutos confirmados (pagos SUCCEEDED). Los montos pendientes no se suman al bruto."
      />
      <div className="grid gap-3 lg:grid-cols-12">
        <div className="lg:col-span-5">
          <MetricCard
            tone="hero"
            accent="emerald"
            label="Ingresos brutos · hoy"
            value={fmtMoney(business?.grossRevenueTodayCents ?? 0)}
            sub={business ? revenueTodaySub(business) : undefined}
            loading={loading}
          />
        </div>
        <div className="lg:col-span-4">
          <MetricCard
            tone="primary"
            accent="emerald"
            label="Ingresos brutos · 30 días"
            value={fmtMoney(business?.revenueLast30DaysCents ?? 0)}
            sub="Pagos SUCCEEDED"
            loading={loading}
          />
        </div>
        <div className="lg:col-span-3 grid gap-3">
          <MetricCard
            tone="compact"
            label="Ingresos Stripe · 30d"
            value={fmtMoney(business?.stripeRevenueLast30DaysCents ?? 0)}
            loading={loading}
          />
          <MetricCard
            tone="compact"
            label="Ingresos efectivo · 30d"
            value={fmtMoney(business?.cashRevenueLast30DaysCents ?? 0)}
            loading={loading}
          />
        </div>
        <div className="lg:col-span-3">
          <MetricCard
            tone="standard"
            accent="amber"
            label="Pagos pendientes"
            value={fmtMoney(business?.pendingRevenueCents ?? 0)}
            sub="No incluido en ingresos brutos confirmados"
            loading={loading}
          />
        </div>
        <div className="lg:col-span-3">
          <MetricCard
            tone="standard"
            accent="rose"
            deduction
            label="Reembolsos · 30d"
            value={
              (business?.refundedRevenueCents ?? 0) > 0
                ? `−${fmtMoney(business!.refundedRevenueCents)}`
                : fmtMoney(0)
            }
            sub="Riesgo / deducción · sincronización de reembolsos incompleta"
            loading={loading}
          />
        </div>
      </div>
      <p className="mt-3 max-w-3xl text-xs leading-relaxed text-zinc-600">
        Neto, comisiones de Stripe e impuestos estarán disponibles cuando cada transacción registre
        su desglose financiero.
      </p>
    </section>
  );
}

export function MembershipBusinessSection({
  business,
  loading,
}: {
  business: BusinessAnalyticsDto | null;
  loading: boolean;
}) {
  const growthSub = business
    ? fmtTrendPct(business.membershipGrowthPercent, "vs prior 30d")
    : undefined;

  return (
    <section>
      <SectionHeader
        title="Membresías"
        description="Miembros registrados (cuentas MEMBER) vs suscripciones de pago. MRR estimado y ARR estimado se basan en precios de catálogo de suscripciones activas; no representan depósitos bancarios."
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
        <MetricCard
          tone="primary"
          accent="sky"
          label="Miembros registrados"
          value={business?.memberCountForArpu ?? 0}
          sub="StudioMembership · rol MEMBER · usuario activo"
          loading={loading}
        />
        <MetricCard
          label="New members · 30d"
          value={business?.newMembersLast30Days ?? 0}
          sub={growthSub ?? `Prior 30d: ${fmt(business?.newMembersPrevious30Days ?? 0)}`}
          loading={loading}
        />
        <MetricCard
          label="Cancelled · 30d"
          value={business?.cancellationsLast30Days ?? 0}
          sub="Subscription status CANCELED"
          loading={loading}
        />
        <MetricCard
          accent="rose"
          label="Past due"
          value={business?.pastDueSubscriptions ?? 0}
          loading={loading}
        />
        <MetricCard
          accent="zinc"
          label="MRR estimado"
          value={fmtMoney(business?.estimatedMrrCents ?? 0)}
          sub="ACTIVE + TRIALING · precio de catálogo"
          loading={loading}
        />
        <MetricCard
          accent="zinc"
          label="ARR estimado"
          value={fmtMoney(business?.estimatedArrCents ?? 0)}
          sub="MRR estimado × 12"
          loading={loading}
        />
        <MetricCard
          label="Avg revenue / member"
          value={fmtMoney(business?.averageRevenuePerMemberCents ?? 0)}
          sub="30d succeeded payments"
          loading={loading}
        />
        <MetricCard
          label="Avg membership price"
          value={fmtMoney(business?.averageMembershipPriceCents ?? 0)}
          sub="Mean plan price (ACTIVE + TRIALING)"
          loading={loading}
        />
        <MetricCard
          label="Membership growth"
          value={
            business?.membershipGrowthPercent != null
              ? `${business.membershipGrowthPercent >= 0 ? "+" : ""}${fmt(business.membershipGrowthPercent, 1)}%`
              : business && business.newMembersLast30Days > 0
                ? "New"
                : "—"
          }
          sub="New MEMBER seats vs prior 30d"
          loading={loading}
        />
        <MetricCard
          label="Suscripciones activas"
          value={business?.activeSubscriptions ?? 0}
          sub={
            business && business.trialingSubscriptions > 0
              ? `${fmt(business.trialingSubscriptions)} en prueba`
              : "Estado ACTIVE"
          }
          loading={loading}
        />
      </div>
    </section>
  );
}

export function SalesSection({
  business,
  loading,
}: {
  business: BusinessAnalyticsDto | null;
  loading: boolean;
}) {
  return (
    <section>
      <SectionHeader
        title="Ventas"
        description="Ingresos confirmados y altas operativas. Las suscripciones creadas son filas nuevas en subscriptions, no ventas confirmadas hasta un pago SUCCEEDED."
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          tone="primary"
          accent="violet"
          label="Suscripciones creadas hoy"
          value={business?.newSubscriptionsToday ?? 0}
          sub="Filas nuevas · sin confirmar pago"
          loading={loading}
        />
        <MetricCard
          label="Suscripciones creadas — 30 días"
          value={business?.newSubscriptionsLast30Days ?? 0}
          sub="Filas nuevas · sin confirmar pago"
          loading={loading}
        />
        <MetricCard
          label="Cash sales · 30d"
          value={fmtMoney(business?.cashRevenueLast30DaysCents ?? 0)}
          loading={loading}
        />
        <MetricCard
          label="Stripe sales · 30d"
          value={fmtMoney(business?.stripeRevenueLast30DaysCents ?? 0)}
          loading={loading}
        />
        <MetricCard
          label="Enrollment fees paid · 30d"
          value={business?.enrollmentFeesPaidCount30d ?? 0}
          sub="Count only — revenue bundled in invoices"
          loading={loading}
        />
        <MetricCard
          label="Day pass revenue · 30d"
          value={fmtMoney(business?.dayPassRevenueLast30DaysCents ?? 0)}
          sub="Matched via day_passes.payment_intent"
          loading={loading}
        />
        <MetricCard
          label="Founders enrolled"
          value={business?.foundersEnrolledCount ?? 0}
          sub="Members with founder_number"
          loading={loading}
        />
        <MetricCard
          label="Top selling membership"
          value={business?.topSellingPlan?.planName ?? "—"}
          sub={
            business?.topSellingPlan
              ? fmtMoney(business.topSellingPlan.revenueCents) + " · 30d attributed"
              : "No attributed plan revenue"
          }
          loading={loading}
        />
      </div>
    </section>
  );
}

export function OperationsSection({
  overview,
  trends,
  breakdown,
  business,
  period,
  loadingOverview,
  loadingCharts,
}: {
  overview: OverviewDto | null;
  trends: TrendsDto | null;
  breakdown: ClassBreakdownDto | null;
  business: BusinessAnalyticsDto | null;
  period: 7 | 30;
  loadingOverview: boolean;
  loadingCharts: boolean;
}) {
  const bookingsInPeriod = trends ? sumTrendCounts(trends.bookings) : 0;
  const coachName = overview?.mostActiveCoach
    ? `${overview.mostActiveCoach.firstName} ${overview.mostActiveCoach.lastName}`
    : "—";

  return (
    <section>
      <SectionHeader
        title="Operations"
        description="Class utilization and front-desk activity. Bookings use the selected period; no-show and fill rates use a fixed 30-day window from the API."
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
        <MetricCard
          label="Check-ins today"
          value={overview?.checkInsToday ?? 0}
          accent="emerald"
          loading={loadingOverview}
        />
        <MetricCard
          label={`Bookings · ${period}d`}
          value={bookingsInPeriod}
          sub="Non-cancelled"
          loading={loadingCharts}
        />
        <MetricCard
          label="Occupancy today"
          value={`${fmt(overview?.occupancyRateToday ?? 0, 1)}%`}
          loading={loadingOverview}
        />
        <MetricCard
          label="Upcoming classes"
          value={overview?.upcomingClassesToday ?? 0}
          sub="Remaining today"
          loading={loadingOverview}
        />
        <MetricCard
          label="Waitlist"
          value={overview?.waitlistCount ?? 0}
          sub="Currently waiting"
          loading={loadingOverview}
        />
        <MetricCard
          label="No-show rate"
          value={`${fmt(overview?.noShowRate ?? 0, 1)}%`}
          sub="Past 30 days"
          loading={loadingOverview}
        />
        <MetricCard
          label="Peak hour"
          value={
            breakdown && breakdown.peakHours.length > 0
              ? (() => {
                  const top = [...breakdown.peakHours].sort((a, b) => b.count - a.count)[0];
                  if (!top) return "—";
                  const d = new Date();
                  d.setHours(top.hour, 0, 0, 0);
                  return new Intl.DateTimeFormat(undefined, {
                    hour: "numeric",
                    hour12: true,
                  }).format(d);
                })()
              : "—"
          }
          sub={`${period}d booking-weighted`}
          loading={loadingCharts}
        />
        <MetricCard
          label="Coach utilization"
          value={`${fmt(business?.coachUtilizationPercent ?? 0, 1)}%`}
          sub={`Classes with instructor · ${coachName}`}
          loading={loadingOverview || loadingCharts}
        />
        <MetricCard
          label="Avg class fill"
          value={`${fmt(overview?.avgClassFill ?? 0, 1)}%`}
          sub="Past 30 days"
          loading={loadingOverview}
        />
      </div>
    </section>
  );
}

export function MemberHealthSection({
  business,
  loading,
}: {
  business: BusinessAnalyticsDto | null;
  loading: boolean;
}) {
  return (
    <section>
      <SectionHeader
        title="Member health"
        description="Engagement and compliance signals for your member base."
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Repeat bookers · 30d"
          value={business?.membersWithTwoPlusBookingsLast30Days ?? 0}
          sub={`${fmt(business?.repeatBookingRatePercent ?? 0, 1)}% repeat rate`}
          loading={loading}
        />
        <MetricCard
          label="Avg visits / member"
          value={fmt(business?.averageVisitsPerMember30d ?? 0, 1)}
          sub="Check-ins ÷ MEMBER seats · 30d"
          loading={loading}
        />
        <MetricCard
          accent="amber"
          label="Inactive 30+ days"
          value={business?.membersInactive30PlusDays ?? 0}
          sub="No check-in in 30 days"
          loading={loading}
        />
        <MetricCard
          accent="rose"
          label="Waivers pending"
          value={business?.waiversPendingCount ?? 0}
          sub="Active waiver doc unsigned"
          loading={loading}
        />
        <MetricCard
          label="Expiring memberships"
          value={business?.expiringMembershipsNext30Days ?? 0}
          sub="ACTIVE/TRIALING ending in 30d"
          loading={loading}
        />
      </div>
    </section>
  );
}

type AlertItem = {
  id: string;
  label: string;
  detail: string;
  active: boolean;
};

export function AlertsSection({
  overview,
  business,
  loading,
}: {
  overview: OverviewDto | null;
  business: BusinessAnalyticsDto | null;
  loading: boolean;
}) {
  const alerts: AlertItem[] = [
    {
      id: "past-due",
      label: "Past due subscriptions",
      detail: `${fmt(business?.pastDueSubscriptions ?? 0)} need attention`,
      active: (business?.pastDueSubscriptions ?? 0) > 0,
    },
    {
      id: "waivers",
      label: "Waivers pending",
      detail: `${fmt(business?.waiversPendingCount ?? 0)} members unsigned`,
      active: (business?.waiversPendingCount ?? 0) > 0,
    },
    {
      id: "revenue-drop",
      label: "Revenue trend",
      detail: "Last 7d below prior 7d by >15%",
      active: business ? revenueDropped(business) : false,
    },
    {
      id: "no-classes",
      label: "No upcoming classes",
      detail: "Nothing left on today's schedule",
      active: (overview?.upcomingClassesToday ?? 0) === 0,
    },
    {
      id: "low-occupancy",
      label: "Low occupancy today",
      detail: `${fmt(overview?.occupancyRateToday ?? 0, 1)}% avg fill`,
      active: (overview?.occupancyRateToday ?? 0) > 0 && (overview?.occupancyRateToday ?? 0) < 30,
    },
    {
      id: "payments-failing",
      label: "Failed payments",
      detail: `${fmt(business?.failedPaymentsLast30Days ?? 0)} in last 30d`,
      active: (business?.failedPaymentsLast30Days ?? 0) > 0,
    },
  ];

  const activeAlerts = alerts.filter((a) => a.active);

  return (
    <section>
      <SectionHeader
        title="Alerts"
        description="Action items derived from live studio data. Stripe webhook health is platform-scoped and omitted here."
      />
      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-2xl bg-zinc-900" />
          ))}
        </div>
      ) : activeAlerts.length === 0 ? (
        <div className="rounded-2xl border border-emerald-900/40 bg-emerald-950/20 px-5 py-4 text-sm text-emerald-200/90">
          No active alerts — metrics look healthy for this studio.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {activeAlerts.map((alert) => (
            <MetricCard
              key={alert.id}
              tone="alert"
              alert
              accent="amber"
              label={alert.label}
              value={alert.detail}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function DataQualityBanners({ business }: { business: BusinessAnalyticsDto | null }) {
  if (!business) return null;

  if (business.dataQuality === "demo" || business.dataQuality === "mixed") {
    return (
      <div className="rounded-xl border border-amber-800/40 bg-amber-950/40 px-4 py-3 text-sm text-amber-100">
        <strong className="font-semibold">Demo / estimated revenue.</strong>{" "}
        {business.dataQuality === "mixed"
          ? "Some payments look like live Stripe; others look like seed/demo rows."
          : "Succeeded payments in this window match demo-style Stripe IDs. Treat dollars as illustrative."}
      </div>
    );
  }

  if (business.dataQuality === "empty") {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-4 py-3 text-sm text-zinc-400">
        <strong className="font-semibold text-zinc-300">No payment activity (30d).</strong> Revenue
        KPIs are zero until there are succeeded payment rows for this studio.
      </div>
    );
  }

  return null;
}
