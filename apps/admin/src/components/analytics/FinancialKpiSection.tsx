"use client";

import { SurfaceCard } from "@/components/shell/SurfaceCard";
import type { FinancialSummaryDto, FinancialKpiValue } from "@/lib/api/analytics";
import { formatMoneyFromCents } from "@/lib/formatMoney";

export type FinancialPeriodKey = "today" | "week" | "month" | "year";

const PERIOD_OPTIONS: { key: FinancialPeriodKey; label: string }[] = [
  { key: "today", label: "Hoy" },
  { key: "week", label: "Esta semana" },
  { key: "month", label: "Este mes" },
  { key: "year", label: "Este año" },
];

const PHASE2_NOTE =
  "Neto, comisiones, impuestos y reembolsos estarán disponibles cuando Stripe envíe y almacenemos el desglose de cada transacción.";

function formatComparison(percent: number | null | undefined): string | null {
  if (percent == null) return null;
  const sign = percent >= 0 ? "+" : "";
  return `${sign}${percent}% comparado con el periodo anterior`;
}

type KpiCardProps = {
  label: string;
  value: string;
  comparison?: string | null;
  subtext?: string | null;
  emphasis?: boolean;
};

function KpiCard({ label, value, comparison, subtext, emphasis }: KpiCardProps) {
  return (
    <SurfaceCard
      padding="sm"
      className={emphasis ? "lg:flex-[1.2]" : "flex-1"}
    >
      <p className="text-xs font-semibold text-zinc-700">{label}</p>
      <p
        className={`mt-1 tabular-nums tracking-tight text-zinc-900 ${
          emphasis ? "text-2xl font-semibold sm:text-3xl" : "text-xl font-semibold"
        }`}
      >
        {value}
      </p>
      {comparison ? (
        <p className="mt-1 text-xs tabular-nums text-zinc-600">{comparison}</p>
      ) : null}
      {subtext ? <p className="mt-1 text-[11px] leading-snug text-zinc-500">{subtext}</p> : null}
    </SurfaceCard>
  );
}

function moneyKpi(
  kpi: FinancialKpiValue,
  currency: string,
): { value: string; comparison: string | null; subtext: string | null } {
  return {
    value: formatMoneyFromCents(kpi.cents ?? 0, currency),
    comparison: formatComparison(kpi.comparisonPercent),
    subtext: kpi.note ?? null,
  };
}

function countKpi(
  kpi: FinancialKpiValue & { count?: number },
): { value: string; comparison: string | null; subtext: string | null } {
  return {
    value: new Intl.NumberFormat("es-MX").format(kpi.count ?? 0),
    comparison: formatComparison(kpi.comparisonPercent),
    subtext: kpi.note ?? null,
  };
}

type FinancialKpiSectionProps = {
  data: FinancialSummaryDto | null;
  loading: boolean;
  period: FinancialPeriodKey;
  onPeriodChange: (p: FinancialPeriodKey) => void;
};

export function FinancialKpiSection({
  data,
  loading,
  period,
  onPeriodChange,
}: FinancialKpiSectionProps) {
  const currency = data?.currency ?? "mxn";

  if (loading && !data) {
    return (
      <section className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {PERIOD_OPTIONS.map((o) => (
            <div key={o.key} className="h-9 w-24 animate-pulse rounded-xl bg-zinc-100" />
          ))}
        </div>
        <div className="h-28 animate-pulse rounded-2xl bg-zinc-100" />
        <div className="grid gap-3 sm:grid-cols-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-2xl bg-zinc-100" />
          ))}
        </div>
      </section>
    );
  }

  const kpis = data?.kpis;
  const total = moneyKpi(kpis?.totalCollected ?? { available: true, cents: 0 }, currency);
  const stripe = moneyKpi(kpis?.stripeCollected ?? { available: true, cents: 0 }, currency);
  const cash = moneyKpi(kpis?.cashCollected ?? { available: true, cents: 0 }, currency);
  const payments = countKpi(kpis?.paymentsCollected ?? { available: true, count: 0 });
  const pendingCents = kpis?.pending?.cents ?? 0;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {PERIOD_OPTIONS.map((o) => (
          <button
            key={o.key}
            type="button"
            onClick={() => onPeriodChange(o.key)}
            className={`rounded-xl px-3.5 py-2 text-sm font-medium transition ${
              period === o.key
                ? "bg-zinc-900 text-white shadow-sm"
                : "border border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>

      <KpiCard label="Total cobrado" emphasis {...total} />

      <div className="grid gap-3 sm:grid-cols-3">
        <KpiCard label="Cobrado por Stripe" {...stripe} />
        <KpiCard label="Cobrado en efectivo" {...cash} />
        <KpiCard
          label="Pagos cobrados"
          value={payments.value}
          comparison={payments.comparison}
          subtext={payments.subtext}
        />
      </div>

      <div className="border-t border-zinc-200 pt-4">
        <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
          Estado actual
        </p>
        <SurfaceCard
          padding="sm"
          className="max-w-md border-dashed border-zinc-300 bg-zinc-50/80"
        >
          <p className="text-xs font-semibold text-zinc-700">Pendiente por cobrar</p>
          <p className="mt-1 text-xl font-semibold tabular-nums tracking-tight text-zinc-900">
            {formatMoneyFromCents(pendingCents, currency)}
          </p>
          <p className="mt-1 text-[11px] leading-snug text-zinc-500">Saldo pendiente actual</p>
        </SurfaceCard>
      </div>

      <p className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-xs leading-relaxed text-zinc-600">
        {PHASE2_NOTE}
      </p>
    </section>
  );
}

export { PERIOD_OPTIONS };
