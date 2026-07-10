"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Line, LineChart, ResponsiveContainer } from "recharts";

import { SurfaceCard } from "@/components/shell/SurfaceCard";
import type { OwnerBriefingDto } from "@/lib/api/analytics";

function fmtMoney(cents: number): string {
  return new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function fmtCount(n: number): string {
  return new Intl.NumberFormat("es-MX", { maximumFractionDigits: 0 }).format(n);
}

function translateAttentionLabel(label: string): string {
  return label
    .replace(/overdue payment/gi, "pago vencido")
    .replace(/overdue payments/gi, "pagos vencidos")
    .replace(/failed payment/gi, "pago fallido")
    .replace(/failed payments/gi, "pagos fallidos")
    .replace(/membership expiring/gi, "membresía por vencer")
    .replace(/memberships expiring/gi, "membresías por vencer")
    .replace(/waiver pending/gi, "waiver pendiente")
    .replace(/waivers pending/gi, "waivers pendientes")
    .replace(/Revenue (\d+)% behind vs last month/gi, "Ingresos $1% por debajo vs mes pasado");
}

function translateAction(action: string): string {
  if (action === "Review") return "Revisar";
  if (action === "Renew") return "Renovar";
  if (action === "Collect") return "Recolectar";
  return action;
}

function translateChangeLabel(label: string): string {
  return label
    .replace(/new membership/gi, "nueva membresía")
    .replace(/new memberships/gi, "nuevas membresías")
    .replace(/check-in/gi, "check-in")
    .replace(/check-ins/gi, "check-ins")
    .replace(/payment collected/gi, "pago cobrado")
    .replace(/payments collected/gi, "pagos cobrados")
    .replace(/Revenue /gi, "Ingresos ")
    .replace(/vs yesterday \(same time\)/gi, "vs ayer (misma hora)")
    .replace(/vs yesterday/gi, "vs ayer");
}

function translateDelight(text: string | null | undefined): string | null {
  if (!text) return null;
  const map: Record<string, string> = {
    "Strong month.": "Mes fuerte.",
    "Revenue is ahead of last month.": "Los ingresos van adelante del mes pasado.",
    "Everything looks healthy.": "Todo se ve saludable.",
    "Membership activity is strong.": "La actividad de membresías es fuerte.",
  };
  return map[text] ?? null;
}

function IconBadge({ tone }: { tone: "green" | "red" | "blue" | "purple" }) {
  const tones = {
    green: "bg-emerald-50 text-emerald-700",
    red: "bg-rose-50 text-rose-600",
    blue: "bg-sky-50 text-sky-700",
    purple: "bg-violet-50 text-violet-700",
  };
  const icons = {
    green: "$",
    red: "!",
    blue: "↗",
    purple: "◎",
  };
  return (
    <span
      className={`inline-flex h-9 w-9 items-center justify-center rounded-xl text-sm font-semibold ${tones[tone]}`}
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
    <div className="mt-3 h-10 w-full" aria-hidden>
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
  revenueTrend?: { date: string; amountCents: number }[];
};

export function OwnerBriefing({ briefing, loading, revenueTrend }: OwnerBriefingProps) {
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
          <SurfaceCard key={i} className="min-h-[220px] animate-pulse bg-zinc-50">
            <div className="h-full" />
          </SurfaceCard>
        ))}
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <SurfaceCard className="flex min-h-[240px] flex-col">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-zinc-500">Cobrado este mes</p>
          </div>
          <IconBadge tone="green" />
        </div>
        <p className="mt-4 text-3xl font-semibold tabular-nums tracking-tight text-zinc-900 sm:text-4xl">
          {fmtMoney(hero?.monthCollectedCents ?? 0)}
        </p>
        {hero ? (
          <p className="mt-2 text-sm tabular-nums text-zinc-600">
            {fmtCount(hero.monthPaymentCount)} pago{hero.monthPaymentCount === 1 ? "" : "s"} cobrado
            {hero.monthPaymentCount === 1 ? "" : "s"}
          </p>
        ) : null}
        {comparison ? (
          <p className="mt-1 text-xs tabular-nums text-zinc-500">{comparison}</p>
        ) : null}
        {translateDelight(hero?.delight) ? (
          <p className="mt-2 text-xs text-zinc-600">{translateDelight(hero?.delight)}</p>
        ) : null}
        {revenueTrend && revenueTrend.length > 0 ? (
          <RevenueSparkline rows={revenueTrend} />
        ) : null}
      </SurfaceCard>

      <SurfaceCard className="flex min-h-[240px] flex-col">
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm font-medium text-zinc-500">Requiere tu atención</p>
          <IconBadge tone="red" />
        </div>
        <div className="mt-4 flex-1 space-y-1">
          {attention.length === 0 ? (
            <p className="text-sm text-zinc-600">✓ Todo se ve saludable hoy.</p>
          ) : (
            attention.map((item) => {
              const isExpiring = item.id === "expiring";
              const textClass = isExpiring ? "text-amber-800" : "text-rose-800";
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  className={`group flex items-center justify-between gap-2 rounded-lg py-2 text-sm transition hover:bg-zinc-50 ${textClass}`}
                >
                  <span className="min-w-0 flex-1 leading-snug">
                    {translateAttentionLabel(item.label)}
                  </span>
                  <span className="shrink-0 text-xs font-medium text-zinc-500 group-hover:text-zinc-800">
                    {translateAction(item.action)} →
                  </span>
                </Link>
              );
            })
          )}
        </div>
      </SurfaceCard>

      <SurfaceCard className="flex min-h-[240px] flex-col">
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm font-medium text-zinc-500">Qué cambió</p>
          <IconBadge tone="blue" />
        </div>
        <div className="mt-4 flex-1 space-y-2">
          {whatChanged.length === 0 ? (
            <p className="text-sm text-zinc-500">Sin actividad registrada.</p>
          ) : (
            whatChanged.map((row) => (
              <p key={row.id} className="text-sm text-zinc-700">
                {translateChangeLabel(row.label)}
              </p>
            ))
          )}
        </div>
      </SurfaceCard>

      <SurfaceCard className="flex min-h-[240px] flex-col">
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm font-medium text-zinc-500">Miembros de pago</p>
          <IconBadge tone="purple" />
        </div>
        <p className="mt-4 text-3xl font-semibold tabular-nums tracking-tight text-zinc-900">
          {fmtCount(paying?.count ?? 0)}
        </p>
        {paying?.newThisWeek != null ? (
          <p className="mt-2 text-sm tabular-nums text-zinc-600">
            +{fmtCount(paying.newThisWeek)} esta semana
          </p>
        ) : null}
        {paying?.renewalsDueThisWeek != null ? (
          <p className="mt-1 text-sm tabular-nums text-zinc-500">
            {fmtCount(paying.renewalsDueThisWeek)} renovación
            {paying.renewalsDueThisWeek === 1 ? "" : "es"} esta semana
          </p>
        ) : null}
      </SurfaceCard>
    </div>
  );
}
