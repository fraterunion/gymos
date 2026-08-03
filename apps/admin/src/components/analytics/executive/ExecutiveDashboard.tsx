"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { SectionHeader } from "@/components/shell/SectionHeader";
import { SurfaceCard } from "@/components/shell/SurfaceCard";
import {
  CHART_AXIS,
  CHART_COLORS,
  CHART_TOOLTIP_STYLE,
} from "@/lib/analyticsChartColors";
import type { ExecutiveDashboardDto } from "@/lib/api/analytics";
import { formatMoneyAxis, formatMoneyFromCents } from "@/lib/formatMoney";

function fmtDate(iso: string): string {
  return new Intl.DateTimeFormat("es-MX", { month: "short", day: "numeric" }).format(new Date(iso));
}

function fmtCount(n: number): string {
  return new Intl.NumberFormat("es-MX").format(n);
}

function kpiDisplay(
  kpi: ExecutiveDashboardDto["kpis"][0],
  currency: string,
): string {
  if (kpi.valueKind === "money") return formatMoneyFromCents(kpi.value, currency);
  if (kpi.valueKind === "percent") return `${kpi.value}%`;
  return fmtCount(kpi.value);
}

function insightToneClass(tone: string): string {
  if (tone === "positive") return "border-emerald-200/80 bg-emerald-50/60";
  if (tone === "warning") return "border-amber-200/80 bg-amber-50/60";
  if (tone === "critical") return "border-rose-200/80 bg-rose-50/60";
  return "border-zinc-200/80 bg-zinc-50/60";
}

function MiniSparkline({ rows }: { rows: { amountCents: number }[] }) {
  const data = rows.map((r) => ({ v: r.amountCents / 100 }));
  if (data.length === 0 || data.every((d) => d.v === 0)) return null;
  return (
    <div className="mt-3 h-8 w-full" aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <Line type="monotone" dataKey="v" stroke="#10b981" strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

type Props = {
  data: ExecutiveDashboardDto | null;
  loading: boolean;
};

export function ExecutiveDashboard({ data, loading }: Props) {
  const [revenuePeriod, setRevenuePeriod] = useState<"daily" | "monthly" | "yearly">("monthly");
  const currency = data?.currency ?? "mxn";

  const revenueTrend = useMemo(() => {
    if (!data) return [];
    return data.revenue.trend.map((r) => ({
      date: fmtDate(r.date),
      Ingresos: r.amountCents / 100,
    }));
  }, [data]);

  if (loading && !data) {
    return (
      <div className="space-y-8">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[...Array(8)].map((_, i) => (
            <SurfaceCard key={i} className="h-36 animate-pulse bg-zinc-50">
              <span className="sr-only">Loading</span>
            </SurfaceCard>
          ))}
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-12">
      {data.dataQuality.warnings.length > 0 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          <p className="font-medium">Calidad de datos</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {data.dataQuality.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* §1 Executive KPIs */}
      <section>
        <SectionHeader title="Resumen ejecutivo" />
        <p className="mt-1 text-sm text-zinc-500">
          Salud del negocio — datos de GymOS sincronizados con Stripe vía webhooks.
        </p>
        <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {data.kpis.map((kpi) => (
            <SurfaceCard key={kpi.id} padding="lg" className="flex flex-col">
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{kpi.label}</p>
              <p className="mt-3 text-3xl font-semibold tabular-nums tracking-tight text-zinc-900">
                {kpiDisplay(kpi, currency)}
              </p>
              {kpi.comparisonPercent != null ? (
                <p className="mt-1 text-xs tabular-nums text-zinc-600">
                  {kpi.comparisonPercent >= 0 ? "↑" : "↓"} {Math.abs(kpi.comparisonPercent)}%{" "}
                  {kpi.comparisonLabel ?? ""}
                </p>
              ) : kpi.comparisonLabel ? (
                <p className="mt-1 text-xs text-zinc-500">{kpi.comparisonLabel}</p>
              ) : null}
              <MiniSparkline rows={kpi.sparkline} />
            </SurfaceCard>
          ))}
        </div>
      </section>

      {/* §11 Insights */}
      <section>
        <SectionHeader title="Insights ejecutivos" />
        <p className="mt-1 text-sm text-zinc-500">Lo que merece tu atención ahora.</p>
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          {data.insights.map((insight) => (
            <SurfaceCard
              key={insight.id}
              padding="lg"
              className={`border ${insightToneClass(insight.tone)}`}
            >
              <p className="text-sm font-semibold text-zinc-900">{insight.title}</p>
              <p className="mt-2 text-sm leading-relaxed text-zinc-700">{insight.body}</p>
            </SurfaceCard>
          ))}
          {data.insights.length === 0 ? (
            <SurfaceCard padding="lg">
              <p className="text-sm text-zinc-600">Sin insights por ahora. Vuelve mañana.</p>
            </SurfaceCard>
          ) : null}
        </div>
      </section>

      {/* §2 Revenue */}
      <section>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <SectionHeader title="Ingresos" />
          <p className="text-sm text-zinc-500">Pagos cobrados — suscripciones, únicos y otros.</p>
          <div className="inline-flex rounded-xl bg-zinc-100 p-1">
            {(["daily", "monthly", "yearly"] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setRevenuePeriod(p)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium capitalize ${
                  revenuePeriod === p ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-600"
                }`}
              >
                {p === "daily" ? "Diario" : p === "monthly" ? "Mensual" : "Anual"}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-6 grid gap-4 lg:grid-cols-3">
          <SurfaceCard className="lg:col-span-2">
            {revenueTrend.length === 0 ? (
              <p className="py-16 text-center text-sm text-zinc-500">Sin cobros en este periodo.</p>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={revenueTrend}>
                  <defs>
                    <linearGradient id="execRev" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={CHART_COLORS.revenue} stopOpacity={0.25} />
                      <stop offset="100%" stopColor={CHART_COLORS.revenue} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="date" tick={{ fill: CHART_AXIS, fontSize: 10 }} tickLine={false} axisLine={false} />
                  <YAxis
                    tick={{ fill: CHART_AXIS, fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => formatMoneyAxis(Math.round(Number(v) * 100), currency)}
                  />
                  <Tooltip
                    contentStyle={CHART_TOOLTIP_STYLE}
                    formatter={(v) => [formatMoneyFromCents(Math.round(Number(v) * 100), currency), "Collected"]}
                  />
                  <Area type="monotone" dataKey="Ingresos" stroke={CHART_COLORS.revenue} fill="url(#execRev)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </SurfaceCard>
          <SurfaceCard>
            <p className="text-sm font-medium text-zinc-800">Desglose</p>
            <ul className="mt-4 space-y-3 text-sm">
              {[
                { label: "Suscripciones", cents: data.revenue.breakdown.subscriptionsCents },
                { label: "Ventas únicas", cents: data.revenue.breakdown.oneTimeCents },
                { label: "Retail", cents: data.revenue.breakdown.retailCents },
                { label: "Otros", cents: data.revenue.breakdown.otherCents },
              ].map((row) => (
                <li key={row.label} className="flex justify-between gap-3">
                  <span className="text-zinc-600">{row.label}</span>
                  <span className="font-medium tabular-nums text-zinc-900">
                    {formatMoneyFromCents(row.cents, currency)}
                  </span>
                </li>
              ))}
              <li className="flex justify-between gap-3 border-t border-zinc-100 pt-3 font-semibold">
                <span>Total</span>
                <span className="tabular-nums">
                  {formatMoneyFromCents(data.revenue.breakdown.totalCents, currency)}
                </span>
              </li>
            </ul>
          </SurfaceCard>
        </div>
      </section>

      {/* §3 Stripe */}
      <section>
        <SurfaceCard padding="lg">
          <p className="text-lg font-semibold text-zinc-900">Stripe</p>
          <p className="mt-1 text-sm text-zinc-500">{data.stripe.connectionLabel}</p>
          {data.stripe.lastSyncAt ? (
            <p className="mt-1 text-xs text-zinc-500">
            Último cobro registrado{" "}
            {new Date(data.stripe.lastSyncAt).toLocaleString("es-MX")}
          </p>
          ) : null}
          <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
            {[
              { label: "Activas", value: data.stripe.activeSubscriptions },
              { label: "En prueba", value: data.stripe.trialingSubscriptions },
              { label: "Vencidas", value: data.stripe.pastDueSubscriptions },
              { label: "Pausadas", value: data.stripe.pausedSubscriptions },
              { label: "Canceladas", value: data.stripe.cancelledSubscriptions },
              { label: "Histórico cobrado", value: formatMoneyFromCents(data.stripe.lifetimeRevenueCents, currency) },
            ].map((item) => (
              <div key={item.label}>
                <p className="text-xs text-zinc-500">{item.label}</p>
                <p className="mt-1 text-lg font-semibold tabular-nums text-zinc-900">
                  {typeof item.value === "number" ? fmtCount(item.value) : item.value}
                </p>
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs text-zinc-500">
            {data.definitions.averageRevenuePerMember.label}
          </p>
        </SurfaceCard>
      </section>

      {/* §5 Upcoming + §6 Failed */}
      <section className="grid gap-6 xl:grid-cols-2">
        <SurfaceCard padding="lg">
          <p className="text-lg font-semibold text-zinc-900">Próximas renovaciones</p>
          <p className="mt-1 text-xs text-zinc-500">{data.upcomingRevenue.estimationNote}</p>
          <div className="mt-3 flex flex-wrap gap-4 text-sm">
            <span>
              7 días:{" "}
              <strong>{formatMoneyFromCents(data.upcomingRevenue.expected7DaysCents, currency)}</strong>
              <span className="text-zinc-500"> (estimado)</span>
            </span>
            <span>
              30 días:{" "}
              <strong>{formatMoneyFromCents(data.upcomingRevenue.expected30DaysCents, currency)}</strong>
              <span className="text-zinc-500"> (estimado)</span>
            </span>
          </div>
          <ul className="mt-4 space-y-2">
            {data.upcomingRevenue.items.slice(0, 8).map((item) => (
              <li key={`${item.memberUserId}-${item.renewalDate}`} className="flex justify-between gap-2 text-sm">
                <Link href={`/members/${item.memberUserId}`} className="font-medium text-zinc-900 hover:underline">
                  {item.memberName}
                </Link>
                <span className="tabular-nums text-zinc-600">
                  {formatMoneyFromCents(item.amountCents, currency)} · {fmtDate(item.renewalDate)}
                </span>
              </li>
            ))}
          </ul>
        </SurfaceCard>

        <SurfaceCard padding="lg">
          <p className="text-lg font-semibold text-zinc-900">Pagos fallidos</p>
          <ul className="mt-4 space-y-3">
            {data.failedPayments.map((fp) => (
              <li key={fp.paymentId} className="rounded-xl border border-rose-100 bg-rose-50/40 p-3 text-sm">
                <div className="flex justify-between gap-2">
                  <Link href={fp.memberHref} className="font-medium text-rose-900 hover:underline">
                    {fp.memberName}
                  </Link>
                  <span className="tabular-nums font-medium">
                    {formatMoneyFromCents(fp.amountCents, fp.currency)}
                  </span>
                </div>
                <p className="mt-1 text-xs text-rose-800">
                  {fp.failureReasonAvailable
                    ? fp.failureReason
                    : "Motivo no disponible — requiere persistencia desde webhook de Stripe."}
                </p>
                <div className="mt-2 flex gap-2">
                  <Link href={fp.memberHref} className="text-xs font-medium text-zinc-700 underline">
                    Ver miembro
                  </Link>
                </div>
              </li>
            ))}
            {data.failedPayments.length === 0 ? (
              <li className="text-sm text-zinc-500">Sin pagos fallidos en los últimos 30 días.</li>
            ) : null}
          </ul>
        </SurfaceCard>
      </section>

      {/* §7–§10 */}
      <section className="grid gap-6 lg:grid-cols-2 xl:grid-cols-4">
        <SurfaceCard padding="lg">
          <p className="font-semibold text-zinc-900">Salud de membresías</p>
          <ul className="mt-3 space-y-1 text-sm">
            {data.membershipHealth.byPlanCategory.map((c) => (
              <li key={c.label} className="flex justify-between">
                <span className="text-zinc-600">{c.label}</span>
                <span className="font-medium tabular-nums">{c.count}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-zinc-500">
            +{data.membershipHealth.newMembersThisMonth} nuevos · −{data.membershipHealth.cancelledThisMonth}{" "}
            cancelados · neto {data.membershipHealth.netGrowth}
          </p>
        </SurfaceCard>

        <SurfaceCard padding="lg">
          <p className="font-semibold text-zinc-900">Riesgo de miembros</p>
          <ul className="mt-3 space-y-2 text-sm">
            {data.memberRisk.slice(0, 6).map((r) => (
              <li key={`${r.memberUserId}-${r.reason}`}>
                <Link href={r.memberHref} className="font-medium text-zinc-900 hover:underline">
                  {r.memberName}
                </Link>
                <p className="text-xs text-zinc-600">{r.reason}</p>
              </li>
            ))}
          </ul>
        </SurfaceCard>

        <SurfaceCard padding="lg">
          <p className="font-semibold text-zinc-900">Miembros destacados</p>
          <ul className="mt-3 space-y-2 text-sm">
            {data.topMembers.map((m) => (
              <li key={m.category}>
                <p className="text-xs text-zinc-500">{m.category}</p>
                <Link href={m.memberHref} className="font-medium text-zinc-900 hover:underline">
                  {m.memberName}
                </Link>
                <p className="text-xs tabular-nums text-zinc-600">{m.valueLabel}</p>
              </li>
            ))}
          </ul>
        </SurfaceCard>

        <SurfaceCard padding="lg">
          <p className="font-semibold text-zinc-900">Operación hoy</p>
          <ul className="mt-3 space-y-2 text-sm">
            <li className="flex justify-between">
              <span className="text-zinc-600">Classes</span>
              <span className="font-medium">{data.operations.classesToday}</span>
            </li>
            <li className="flex justify-between">
              <span className="text-zinc-600">Check-ins</span>
              <span className="font-medium">{data.operations.checkInsToday}</span>
            </li>
            <li className="flex justify-between">
              <span className="text-zinc-600">Occupancy</span>
              <span className="font-medium">{Math.round(data.operations.occupancyRateToday)}%</span>
            </li>
            {data.operations.mostPopularClass ? (
              <li className="pt-2 text-xs text-zinc-600">
                Top class: {data.operations.mostPopularClass.name} (
                {data.operations.mostPopularClass.bookingCount} bookings)
              </li>
            ) : null}
            {data.operations.topCoach ? (
              <li className="text-xs text-zinc-600">
                Top coach: {data.operations.topCoach.name} ({data.operations.topCoach.classCount} classes)
              </li>
            ) : null}
          </ul>
        </SurfaceCard>
      </section>
    </div>
  );
}
