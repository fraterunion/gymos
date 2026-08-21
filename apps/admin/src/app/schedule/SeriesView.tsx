"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { SurfaceCard } from "@/components/shell/SurfaceCard";
import { ApiError } from "@/lib/api/errors";
import { adminPrimaryBtn, adminSecondaryBtn } from "@/lib/adminSurface";
import {
  fetchScheduleSeriesList,
  type SeriesListItem,
  type SeriesUiStatus,
} from "@/lib/api/scheduleSeries";
import type { StaffInstructorDto } from "@/lib/api/staff";
import {
  formatFrequency,
  formatLocalDateRange,
  formatOccurrenceInstant,
  formatScheduleLine,
  seriesStatusLabel,
  seriesStatusTone,
} from "@/lib/scheduleSeriesPresentation";

type StatusFilter = "all" | "active" | "ended";

export function SeriesView({
  studioId,
  timezone,
  canManage,
  instructors,
  onSelectSeries,
  onCreateSeries,
  refreshKey,
}: {
  studioId: string;
  timezone: string;
  canManage: boolean;
  instructors: StaffInstructorDto[];
  onSelectSeries: (seriesId: string) => void;
  onCreateSeries: () => void;
  refreshKey?: number;
}) {
  const [items, setItems] = useState<SeriesListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [instructorFilter, setInstructorFilter] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await fetchScheduleSeriesList(studioId, {
        status: statusFilter,
        search: search.trim() || undefined,
        instructorId: instructorFilter || undefined,
      });
      setItems(rows);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudieron cargar las series");
    } finally {
      setLoading(false);
    }
  }, [instructorFilter, search, statusFilter, studioId]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load, refreshKey]);

  const instructorOptions = useMemo(
    () =>
      instructors.map((m) => ({
        id: m.userId,
        name: `${m.firstName} ${m.lastName}`.trim(),
      })),
    [instructors],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-zinc-900">Series de clases</h2>
          <p className="mt-0.5 text-sm text-zinc-500">
            Administra los horarios recurrentes que generan el calendario.
          </p>
        </div>
        {canManage ? (
          <button type="button" className={adminPrimaryBtn} onClick={onCreateSeries}>
            + Nueva serie
          </button>
        ) : null}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar clase o instructor…"
          className="w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm sm:max-w-xs"
        />
        <div className="flex flex-wrap gap-2">
          {(
            [
              ["all", "Todas"],
              ["active", "Activas"],
              ["ended", "Finalizadas"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setStatusFilter(value)}
              className={`rounded-full border px-3 py-1 text-xs font-medium ${
                statusFilter === value
                  ? "border-zinc-900 bg-zinc-900 text-white"
                  : "border-zinc-200 text-zinc-600 hover:bg-zinc-50"
              }`}
            >
              {label}
            </button>
          ))}
          <select
            value={instructorFilter}
            onChange={(e) => setInstructorFilter(e.target.value)}
            className="rounded-full border border-zinc-200 px-3 py-1 text-xs text-zinc-700"
          >
            <option value="">Todos los instructores</option>
            {instructorOptions.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {error}
          <button type="button" className="ml-3 font-semibold underline" onClick={() => void load()}>
            Reintentar
          </button>
        </div>
      ) : null}

      <SurfaceCard padding="sm" className="overflow-x-auto p-0">
        {loading ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded-lg bg-zinc-100" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="text-sm font-medium text-zinc-800">No hay series configuradas</p>
            <p className="mt-1 text-sm text-zinc-500">
              Las series crean automáticamente las clases recurrentes de tu calendario.
            </p>
            {canManage ? (
              <button type="button" className={`${adminPrimaryBtn} mt-4`} onClick={onCreateSeries}>
                Crear primera serie
              </button>
            ) : null}
          </div>
        ) : (
          <table className="min-w-[880px] w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-100 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                <th className="px-4 py-3">Clase</th>
                <th className="px-4 py-3">Horario</th>
                <th className="px-4 py-3">Instructor</th>
                <th className="px-4 py-3">Frecuencia</th>
                <th className="px-4 py-3">Vigencia</th>
                <th className="px-4 py-3">Próxima clase</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <SeriesRow
                  key={item.id}
                  item={item}
                  timezone={timezone}
                  onOpen={() => onSelectSeries(item.id)}
                />
              ))}
            </tbody>
          </table>
        )}
      </SurfaceCard>
    </div>
  );
}

function SeriesRow({
  item,
  timezone,
  onOpen,
}: {
  item: SeriesListItem;
  timezone: string;
  onOpen: () => void;
}) {
  const status = item.status as SeriesUiStatus;
  return (
    <tr
      className="cursor-pointer border-b border-zinc-50 hover:bg-zinc-50/80"
      onClick={onOpen}
    >
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          {item.classTemplate.color ? (
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: item.classTemplate.color }}
            />
          ) : null}
          <span className="font-medium text-zinc-900">{item.classTemplate.name}</span>
        </div>
      </td>
      <td className="px-4 py-3 text-zinc-600">{formatScheduleLine(item, timezone)}</td>
      <td className="px-4 py-3 text-zinc-600">{item.instructor?.name ?? "—"}</td>
      <td className="px-4 py-3 text-zinc-600">{formatFrequency(item.recurrence.intervalWeeks)}</td>
      <td className="px-4 py-3 text-zinc-600">
        {formatLocalDateRange(
          item.recurrence.startsOn,
          item.recurrence.endsOn,
          item.recurrence.isLegacy,
          timezone,
        )}
      </td>
      <td className="px-4 py-3 text-zinc-600">
        {item.nextOccurrence
          ? formatOccurrenceInstant(item.nextOccurrence.startsAt, timezone)
          : "—"}
      </td>
      <td className="px-4 py-3">
        <span
          className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${seriesStatusTone(status)}`}
        >
          {seriesStatusLabel(status)}
        </span>
      </td>
      <td className="px-4 py-3 text-right text-zinc-400">•••</td>
    </tr>
  );
}
