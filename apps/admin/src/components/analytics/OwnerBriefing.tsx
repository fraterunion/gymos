"use client";

import Link from "next/link";
import { Line, LineChart, ResponsiveContainer } from "recharts";

import { SurfaceCard } from "@/components/shell/SurfaceCard";
import {
  translateAttentionAction,
  translateAttentionLabel,
  translateChangeLabel,
  translateDelight,
} from "@/lib/analyticsCopy";
import type { OwnerBriefingDto } from "@/lib/api/analytics";
import { formatMoneyFromCents } from "@/lib/formatMoney";

function fmtCount(n: number): string {
  return new Intl.NumberFormat("es-MX", { maximumFractionDigits: 0 }).format(n);
}

function IconBadge({ tone }: { tone: "green" | "red" | "blue" | "purple" }) {
  const tones = {
    green: "bg-emerald-50 text-emerald-700",
    red: "bg-rose-50 text-rose-600",
    blue: "bg-sky-50 text-sky-700",
    purple: "bg-violet-50 text-violet-700",
  };
  const icons = { green: "$", red: "!", blue: "↗", purple: "◎" };
  return (
    <span
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm font-semibold ${tones[tone]}`}
      aria-hidden
    >
      {icons[tone]}
    </span>
  );
}

function RevenueSparkline({ rows }: { rows: { amountCents: number }[] }) {
  const data = rows.map((r) => ({ v: r.amountCents / 100 }));
  if (data.every((d) => d.v === 0)) return null;
  return (
    <div className="mt-3 h-9 w-full shrink-0" aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <Line
            type="monotone"
            dataKey="v"
            stroke="#10b981"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

type OwnerBriefingProps = {
  briefing: OwnerBriefingDto | null;
  loading: boolean;
  currency: string;
  revenueTrend?: { date: string; amountCents: number }[];
};

export function OwnerBriefing({ briefing, loading, currency, revenueTrend }: OwnerBriefingProps) {
  const hero = briefing?.hero;
  const attention = briefing?.attention ?? [];
  const whatChanged = briefing?.whatChanged ?? [];
  const paying = briefing?.payingMembers;

  const comparison =
    hero?.monthComparisonPercent != null
      ? `${hero.monthComparisonPercent >= 0 ? "↑" : "↓"} ${Math.abs(hero.monthComparisonPercent)}% vs mismo punto del mes pasado`
      : null;

  if (loading && !briefing) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[...Array(4)].map((_, i) => (
          <SurfaceCard key={i} padding="sm" className="animate-pulse">
            <div className="h-[148px]" />
          </SurfaceCard>
        ))}
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4 xl:items-start">
      <SurfaceCard padding="sm" className="flex flex-col">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-semibold text-zinc-800">Cobrado este mes</p>
          <IconBadge tone="green" />
        </div>
        <p className="mt-2 text-3xl font-semibold tabular-nums tracking-tight text-zinc-900">
          {formatMoneyFromCents(hero?.monthCollectedCents ?? 0, currency)}
        </p>
        {hero ? (
          <p className="mt-1.5 text-sm tabular-nums text-zinc-600">
            {fmtCount(hero.monthPaymentCount)} pago{hero.monthPaymentCount === 1 ? "" : "s"} cobrado
            {hero.monthPaymentCount === 1 ? "" : "s"}
          </p>
        ) : null}
        {comparison ? (
          <p className="mt-1 text-xs tabular-nums text-zinc-600">{comparison}</p>
        ) : null}
        {translateDelight(hero?.delight) ? (
          <p className="mt-1 text-xs text-zinc-600">{translateDelight(hero?.delight)}</p>
        ) : null}
        {revenueTrend && revenueTrend.length > 0 ? (
          <div className="mt-auto pt-2">
            <RevenueSparkline rows={revenueTrend} />
          </div>
        ) : null}
      </SurfaceCard>

      <SurfaceCard padding="sm" className="flex flex-col">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-semibold text-zinc-800">Requiere tu atención</p>
          <IconBadge tone="red" />
        </div>
        <div className="mt-2 space-y-0.5">
          {attention.length === 0 ? (
            <p className="py-1 text-sm text-zinc-600">Sin pendientes por ahora.</p>
          ) : (
            attention.map((item) => {
              const isExpiring = item.id === "expiring";
              const textClass = isExpiring ? "text-amber-800" : "text-rose-800";
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  className={`group flex items-center justify-between gap-2 rounded-lg py-1.5 text-sm transition hover:bg-zinc-50 ${textClass}`}
                >
                  <span className="min-w-0 flex-1 leading-snug">
                    {translateAttentionLabel(item.label)}
                  </span>
                  <span className="shrink-0 text-xs font-medium text-zinc-600 group-hover:text-zinc-900">
                    {translateAttentionAction(item.id, item.action)} →
                  </span>
                </Link>
              );
            })
          )}
        </div>
      </SurfaceCard>

      <SurfaceCard padding="sm" className="flex flex-col">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-semibold text-zinc-800">Qué cambió</p>
          <IconBadge tone="blue" />
        </div>
        <div className="mt-2 space-y-1">
          {whatChanged.length === 0 ? (
            <p className="text-sm text-zinc-600">Sin cambios relevantes desde ayer.</p>
          ) : (
            whatChanged.map((row) => (
              <p key={row.id} className="text-sm leading-snug text-zinc-700">
                {translateChangeLabel(row.label)}
              </p>
            ))
          )}
        </div>
      </SurfaceCard>

      <SurfaceCard padding="sm" className="flex flex-col">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-semibold text-zinc-800">Miembros de pago</p>
          <IconBadge tone="purple" />
        </div>
        <p className="mt-2 text-3xl font-semibold tabular-nums tracking-tight text-zinc-900">
          {fmtCount(paying?.count ?? 0)}
        </p>
        {paying?.newThisWeek != null && paying.newThisWeek > 0 ? (
          <p className="mt-1.5 text-sm tabular-nums text-zinc-600">
            +{fmtCount(paying.newThisWeek)} esta semana
          </p>
        ) : null}
        {paying?.renewalsDueThisWeek != null && paying.renewalsDueThisWeek > 0 ? (
          <p className="mt-1 text-sm tabular-nums text-zinc-600">
            {fmtCount(paying.renewalsDueThisWeek)} renovación
            {paying.renewalsDueThisWeek === 1 ? "" : "es"} esta semana
          </p>
        ) : null}
      </SurfaceCard>
    </div>
  );
}
