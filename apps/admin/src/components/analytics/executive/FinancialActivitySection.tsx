"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { SectionHeader } from "@/components/shell/SectionHeader";
import { SurfaceCard } from "@/components/shell/SurfaceCard";
import {
  fetchFinancialActivity,
  type FinancialActivityCategory,
  type FinancialActivityDto,
  type FinancialActivityItemDto,
  type FinancialActivityPeriodPreset,
} from "@/lib/api/analytics";
import { formatMoneyFromCents } from "@/lib/formatMoney";

const PAGE_SIZE = 25;

const CATEGORY_FILTERS: { id: FinancialActivityCategory; label: string }[] = [
  { id: "all", label: "Todos" },
  { id: "stripe", label: "Stripe" },
  { id: "cash", label: "Efectivo" },
  { id: "renewals", label: "Renovaciones" },
  { id: "failed", label: "Fallidos" },
  { id: "refunds", label: "Reembolsos" },
];

const PERIOD_PRESETS: { id: FinancialActivityPeriodPreset; label: string }[] = [
  { id: "today", label: "Hoy" },
  { id: "7d", label: "7 días" },
  { id: "30d", label: "30 días" },
  { id: "month", label: "Este mes" },
  { id: "custom", label: "Personalizado" },
];

function periodBounds(
  preset: FinancialActivityPeriodPreset,
  customFrom: string,
  customTo: string,
): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString();
  if (preset === "custom" && customFrom && customTo) {
    return { from: new Date(customFrom).toISOString(), to: new Date(customTo).toISOString() };
  }
  if (preset === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { from: start.toISOString(), to };
  }
  if (preset === "7d") {
    return { from: new Date(now.getTime() - 7 * 86_400_000).toISOString(), to };
  }
  if (preset === "month") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from: start.toISOString(), to };
  }
  return { from: new Date(now.getTime() - 30 * 86_400_000).toISOString(), to };
}

function fmtDateTime(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("es-MX", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(new Date(iso));
}

function fmtDate(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("es-MX", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone,
  }).format(new Date(iso));
}

function statusTone(status: string): string {
  if (status === "failed") return "text-rose-700 bg-rose-50";
  if (status === "refunded") return "text-violet-700 bg-violet-50";
  if (status === "cancelled") return "text-zinc-600 bg-zinc-100";
  if (status === "pending") return "text-amber-700 bg-amber-50";
  return "text-emerald-700 bg-emerald-50";
}

type Props = {
  studioId: string;
};

export function FinancialActivitySection({ studioId }: Props) {
  const [data, setData] = useState<FinancialActivityDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<FinancialActivityCategory>("all");
  const [period, setPeriod] = useState<FinancialActivityPeriodPreset>("30d");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [memberSearch, setMemberSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([]);

  const bounds = useMemo(
    () => periodBounds(period, customFrom, customTo),
    [period, customFrom, customTo],
  );

  const load = useCallback(async () => {
    if (!studioId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchFinancialActivity(studioId, {
        from: bounds.from,
        to: bounds.to,
        category,
        memberSearch: memberSearch || undefined,
        cursor: cursor ?? undefined,
        limit: PAGE_SIZE,
      });
      setData(result);
    } catch {
      setError("No se pudo cargar la actividad financiera.");
    } finally {
      setLoading(false);
    }
  }, [studioId, bounds.from, bounds.to, category, memberSearch, cursor]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    setCursor(null);
    setCursorStack([]);
  }, [category, period, customFrom, customTo, memberSearch, studioId]);

  const currency = data?.currency ?? "mxn";
  const timeZone = data?.timezone;

  return (
    <section className="space-y-6">
      <div>
        <SectionHeader title="Actividad financiera" />
        <p className="mt-1 text-sm text-zinc-500">
          Pagos, renovaciones y movimientos recientes del estudio.
        </p>
      </div>

      {data ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {[
            { label: "Movimientos", value: String(data.summary.movementCount) },
            {
              label: "Cobrado por Stripe",
              value: formatMoneyFromCents(data.summary.stripeCollectedCents, currency),
            },
            {
              label: "Cobrado en efectivo",
              value: formatMoneyFromCents(data.summary.cashCollectedCents, currency),
            },
            { label: "Pagos fallidos", value: String(data.summary.failedCount) },
            {
              label: "Reembolsos",
              value: formatMoneyFromCents(data.summary.refundedCents, currency),
            },
          ].map((m) => (
            <SurfaceCard key={m.label} padding="lg" className="text-center sm:text-left">
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{m.label}</p>
              <p className="mt-2 text-xl font-semibold tabular-nums text-zinc-900">{m.value}</p>
            </SurfaceCard>
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2">
          {CATEGORY_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setCategory(f.id)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                category === f.id
                  ? "bg-zinc-900 text-white"
                  : "bg-zinc-100 text-zinc-600 hover:text-zinc-900"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex flex-wrap rounded-xl bg-zinc-100 p-1">
            {PERIOD_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setPeriod(p.id)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
                  period === p.id ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-600"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          {period === "custom" ? (
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="rounded-lg border border-zinc-200 px-2 py-1.5 text-sm"
              />
              <span className="text-zinc-400">—</span>
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="rounded-lg border border-zinc-200 px-2 py-1.5 text-sm"
              />
            </div>
          ) : null}
          <form
            className="ml-auto flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setMemberSearch(searchInput.trim());
            }}
          >
            <input
              type="search"
              placeholder="Buscar miembro…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="w-48 rounded-lg border border-zinc-200 px-3 py-1.5 text-sm sm:w-56"
            />
            <button
              type="submit"
              className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700"
            >
              Buscar
            </button>
          </form>
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {error}
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-2xl border border-zinc-200 bg-white">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-zinc-100 bg-zinc-50/80 text-xs font-medium uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-4 py-3">Fecha y hora</th>
              <th className="px-4 py-3">Miembro</th>
              <th className="px-4 py-3">Evento</th>
              <th className="px-4 py-3">Plan</th>
              <th className="px-4 py-3">Monto</th>
              <th className="px-4 py-3">Método</th>
              <th className="px-4 py-3">Estado</th>
              <th className="px-4 py-3">Próxima renovación</th>
              <th className="px-4 py-3">Acción</th>
            </tr>
          </thead>
          <tbody>
            {loading && !data ? (
              <tr>
                <td colSpan={9} className="px-4 py-16 text-center text-zinc-500">
                  Cargando actividad…
                </td>
              </tr>
            ) : null}
            {data?.items.map((row) => (
              <ActivityRow key={row.id} row={row} currency={currency} timeZone={timeZone} />
            ))}
            {!loading && data?.items.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-16 text-center text-zinc-500">
                  Sin movimientos en este periodo.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {data ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-zinc-600">
          <span>
            {data.pagination.totalCount} movimiento{data.pagination.totalCount === 1 ? "" : "s"}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={cursorStack.length === 0 || loading}
              onClick={() => {
                setCursorStack((stack) => {
                  const next = [...stack];
                  const prev = next.pop() ?? null;
                  setCursor(prev);
                  return next;
                });
              }}
              className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 font-medium disabled:opacity-40"
            >
              Anterior
            </button>
            <button
              type="button"
              disabled={!data.pagination.hasMore || loading}
              onClick={() => {
                setCursorStack((stack) => [...stack, cursor]);
                setCursor(data.pagination.nextCursor);
              }}
              className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 font-medium disabled:opacity-40"
            >
              Siguiente
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ActivityRow({
  row,
  currency,
  timeZone,
}: {
  row: FinancialActivityItemDto;
  currency: string;
  timeZone?: string;
}) {
  return (
    <tr className="border-b border-zinc-50 hover:bg-zinc-50/50">
      <td className="whitespace-nowrap px-4 py-3 tabular-nums text-zinc-700">
        {fmtDateTime(row.occurredAt, timeZone)}
      </td>
      <td className="px-4 py-3 font-medium text-zinc-900">{row.member.name}</td>
      <td className="px-4 py-3 text-zinc-700">{row.eventLabel}</td>
      <td className="px-4 py-3 text-zinc-600">{row.planName ?? "—"}</td>
      <td className="whitespace-nowrap px-4 py-3 tabular-nums font-medium text-zinc-900">
        {row.amountCents != null ? formatMoneyFromCents(row.amountCents, row.currency || currency) : "—"}
      </td>
      <td className="px-4 py-3 text-zinc-600">{row.methodLabel}</td>
      <td className="px-4 py-3">
        <span
          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusTone(row.status)}`}
        >
          {row.statusLabel}
        </span>
        {row.failureReason ? (
          <p className="mt-1 max-w-xs text-xs text-zinc-500">{row.failureReason}</p>
        ) : null}
      </td>
      <td className="whitespace-nowrap px-4 py-3 tabular-nums text-zinc-600">
        {row.nextRenewalAt ? fmtDate(row.nextRenewalAt, timeZone) : "—"}
      </td>
      <td className="px-4 py-3">
        <Link
          href={row.memberHref}
          className="font-medium text-zinc-900 underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-600"
        >
          {row.actionTarget === "review" ? "Revisar" : "Ver miembro"}
        </Link>
      </td>
    </tr>
  );
}
