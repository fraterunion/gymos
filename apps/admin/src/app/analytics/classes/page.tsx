"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { AnalyticsSubNav } from "@/components/analytics/AnalyticsSubNav";
import { PageHeader } from "@/components/shell/PageHeader";
import { SurfaceCard } from "@/components/shell/SurfaceCard";
import { useDeskStudio } from "@/contexts/DeskStudioContext";
import { adminInput, adminSecondaryBtn, adminStatusPill, adminTableWrap } from "@/lib/adminSurface";
import { ApiError } from "@/lib/api/errors";
import {
  fetchClassScheduleActivity,
  fetchClassScheduleSlots,
  fetchClassScheduleSummary,
  fetchClassScheduleTemplateDetail,
  fetchClassScheduleTemplates,
  type ClassScheduleActivityDto,
  type ClassScheduleHeatmapCellDto,
  type ClassScheduleOpportunityDto,
  type ClassScheduleSlotRowDto,
  type ClassScheduleSummaryDto,
  type ClassTemplateDetailDto,
  type ClassTemplateRowDto,
} from "@/lib/api/class-schedule-analytics";
import {
  BAND_CLASS,
  BAND_LABELS,
  formatNum,
  formatPct,
  formatSlot,
  groupLimitedHistoryByWeekday,
  heatmapIntensity,
  LIMITED_HISTORY_FOOTNOTE,
  opportunityAccent,
  partitionDrawerSlotsByMaturity,
  PERIOD_OPTIONS,
  SAMPLE_INSUFFICIENT_LABEL,
  WEEKDAY_FULL,
  WEEKDAY_SHORT,
} from "@/lib/classScheduleAnalyticsPresentation";
import { canAccessExecutiveDashboard } from "@/lib/executivePermissions";

function KpiCard({
  label,
  value,
  hint,
  secondary,
}: {
  label: string;
  value: string;
  hint?: string;
  secondary?: boolean;
}) {
  return (
    <SurfaceCard className={`p-4 ${secondary ? "border-zinc-100 bg-zinc-50/60" : ""}`}>
      <p
        className={`text-xs font-medium uppercase tracking-wide ${
          secondary ? "text-zinc-400" : "text-zinc-500"
        }`}
      >
        {label}
      </p>
      <p
        className={`mt-2 tabular-nums text-zinc-900 ${
          secondary ? "text-xl font-medium" : "text-2xl font-semibold"
        }`}
      >
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-zinc-500">{hint}</p> : null}
    </SurfaceCard>
  );
}

function OpportunityCard({ o }: { o: ClassScheduleOpportunityDto }) {
  return (
    <div role="article" aria-label={`${o.title}: ${o.subject}`}>
      <SurfaceCard className={`border-l-2 p-4 ${opportunityAccent(o.signalKind)}`}>
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">
          {o.title}
        </p>
        <p className="mt-1 text-sm font-medium text-zinc-800">{o.subject}</p>
        <p className="mt-3 text-xl font-semibold tabular-nums tracking-tight text-zinc-900">
          {o.headlineMetric}
        </p>
        <p className="mt-1 text-xs text-zinc-500">{o.supportingMetric}</p>
        <p className="mt-3 text-sm text-zinc-700">{o.suggestedAction}</p>
      </SurfaceCard>
    </div>
  );
}

function DrawerSlotRow({
  s,
}: {
  s: ClassTemplateDetailDto["bySlot"][number];
}) {
  return (
    <li className="flex items-start justify-between gap-3 border-b border-zinc-100 py-1.5">
      <span>
        <span className="font-medium text-zinc-800">
          {formatSlot(s.weekday, s.scheduleTime)}
        </span>
        <span className="mt-0.5 block text-xs text-zinc-400">
          {s.activeSessions} sesión{s.activeSessions === 1 ? "" : "es"}
          {s.slotMaturity === "LIMITED_HISTORY_SLOT" || s.sampleInsufficient
            ? ` · ${SAMPLE_INSUFFICIENT_LABEL}`
            : ""}
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span className="block tabular-nums font-semibold text-zinc-900">
          {formatNum(s.avgAttendance)}
        </span>
        <span className="text-[11px] text-zinc-400">asist. / sesión</span>
      </span>
    </li>
  );
}

function DrawerSlotPerformance({
  slots,
}: {
  slots: ClassTemplateDetailDto["bySlot"];
}) {
  const { established, limited } = partitionDrawerSlotsByMaturity(slots);
  return (
    <div className="space-y-5">
      {established.length > 0 ? (
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">
            Horarios con evidencia suficiente
          </p>
          <ul className="space-y-1">
            {established.map((s) => (
              <DrawerSlotRow key={`est-${s.weekday}-${s.scheduleTime}`} s={s} />
            ))}
          </ul>
        </div>
      ) : null}
      {limited.length > 0 ? (
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">
            Historial limitado
          </p>
          <ul className="space-y-1">
            {limited.map((s) => (
              <DrawerSlotRow key={`lim-${s.weekday}-${s.scheduleTime}`} s={s} />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function SlotTableRow({ s }: { s: ClassScheduleSlotRowDto }) {
  return (
    <tr
      className={`border-b border-zinc-100 ${
        s.slotMaturity === "LIMITED_HISTORY_SLOT" ? "opacity-70" : ""
      }`}
    >
      <td className="px-3 py-2 font-medium">
        {formatSlot(s.weekday, s.scheduleTime)}
        {s.slotMaturity === "LIMITED_HISTORY_SLOT" ? (
          <span className="ml-2 text-xs font-normal text-zinc-400">
            historial limitado
          </span>
        ) : null}
      </td>
      <td className="px-3 py-2 tabular-nums">{s.scheduledSessions}</td>
      <td className="px-3 py-2 tabular-nums">{s.activeSessions}</td>
      <td className="px-3 py-2 tabular-nums font-semibold">
        {formatNum(s.avgAttendance)}
      </td>
      <td className="px-3 py-2 tabular-nums text-zinc-400">{formatNum(s.avgBookings)}</td>
      <td className="px-3 py-2 tabular-nums">
        {s.emptySessions}
        {s.emptyRatePct != null ? ` · ${s.emptyRatePct}%` : ""}
      </td>
      <td className="px-3 py-2 tabular-nums">{formatPct(s.showRatePct)}</td>
      <td className="px-3 py-2">
        <span className={`${adminStatusPill} ${BAND_CLASS[s.band]}`}>
          {BAND_LABELS[s.band]}
        </span>
      </td>
    </tr>
  );
}

function ClassDrawer({
  detail,
  onClose,
}: {
  detail: ClassTemplateDetailDto;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/20" role="dialog" aria-modal="true">
      <div className="h-full w-full max-w-md overflow-y-auto bg-white shadow-xl sm:max-w-md">
        <div className="flex items-start justify-between border-b border-zinc-200 p-5">
          <div>
            <p className="text-lg font-semibold text-zinc-900">{detail.className}</p>
            {detail.sampleInsufficient ? (
              <p className="mt-1 text-xs text-amber-800">
                {SAMPLE_INSUFFICIENT_LABEL} · {detail.activeSessions} sesión
                {detail.activeSessions === 1 ? "" : "es"} activa
                {detail.activeSessions === 1 ? "" : "s"}
              </p>
            ) : (
              <p className="mt-1 text-xs text-zinc-500">
                {detail.activeSessions} sesiones activas · evidencia suficiente para comparar
              </p>
            )}
          </div>
          <button type="button" className={adminSecondaryBtn} onClick={onClose}>
            Cerrar
          </button>
        </div>
        <div className="space-y-6 p-5 text-sm">
          <section>
            <h3 className="mb-2 font-medium text-zinc-900">Resumen</h3>
            <dl className="grid grid-cols-2 gap-3">
              <div>
                <dt className="text-zinc-500">Sesiones</dt>
                <dd className="font-medium">{detail.scheduledSessions}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">Activas</dt>
                <dd className="font-medium">{detail.activeSessions}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">Asistencias</dt>
                <dd className="text-base font-semibold tabular-nums">{detail.attendances}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">Miembros únicos</dt>
                <dd className="font-medium">{detail.uniqueMembers}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">Asist. / sesión activa</dt>
                <dd className="text-base font-semibold tabular-nums">
                  {formatNum(detail.avgAttendancePerActiveSession)}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">Show rate</dt>
                <dd className="text-base font-semibold tabular-nums">
                  {formatPct(detail.showRatePct)}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">Vacías</dt>
                <dd className="font-medium">
                  {detail.emptySessions}
                  {detail.emptyRatePct != null ? ` · ${detail.emptyRatePct}%` : ""}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-400">Ocupación (asist.)</dt>
                <dd className="font-medium text-zinc-500">
                  {formatPct(detail.attendanceOccupancyPct)}
                </dd>
              </div>
            </dl>
            {detail.capacityTypical != null ? (
              <p className="mt-2 text-xs text-zinc-400">
                Capacidad típica: {detail.capacityTypical} — contexto secundario.
              </p>
            ) : null}
          </section>

          {detail.insight ? (
            <section>
              <h3 className="mb-2 font-medium text-zinc-900">Qué observar</h3>
              <p className="text-zinc-800">{detail.insight}</p>
              {detail.insightEvidence ? (
                <p className="mt-1 text-xs text-zinc-500">{detail.insightEvidence}</p>
              ) : null}
            </section>
          ) : detail.sampleInsufficient ? (
            <section>
              <h3 className="mb-2 font-medium text-zinc-900">Qué observar</h3>
              <p className="text-zinc-600">
                Observación prometedora, pero con historial insuficiente para conclusiones
                estratégicas.
              </p>
            </section>
          ) : null}

          <section>
            <h3 className="mb-2 font-medium text-zinc-900">Rendimiento por horario</h3>
            {detail.bySlot.length === 0 ? (
              <p className="text-zinc-500">Sin sesiones activas en el periodo.</p>
            ) : (
              <DrawerSlotPerformance slots={detail.bySlot} />
            )}
          </section>

          <section>
            <h3 className="mb-2 font-medium text-zinc-900">Sesiones recientes</h3>
            <ul className="space-y-2">
              {detail.recentSessions.map((s) => (
                <li key={s.scheduledClassId} className="border-b border-zinc-100 py-2 text-xs">
                  <div className="flex justify-between text-sm text-zinc-800">
                    <span>
                      {formatSlot(s.weekday, s.scheduleTime)}
                      {s.isEmpty ? <span className="ml-2 text-zinc-400">vacía</span> : null}
                    </span>
                    <span className="tabular-nums">
                      {s.attendances} asist · {s.bookings} res
                    </span>
                  </div>
                  <p className="mt-0.5 text-zinc-500">
                    Cap {s.capacity}
                    {s.missedReservations > 0
                      ? ` · ${s.missedReservations} reserva(s) sin check-in`
                      : ""}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

function Heatmap({
  cells,
  metric,
}: {
  cells: ClassScheduleHeatmapCellDto[];
  metric: "avg_attendance" | "attendance_occupancy" | "booking_occupancy";
}) {
  const hours = useMemo(() => {
    const set = new Set(cells.map((c) => c.scheduleTime));
    return [...set].sort();
  }, [cells]);

  const byKey = useMemo(() => {
    const map = new Map<string, ClassScheduleHeatmapCellDto>();
    for (const c of cells) map.set(`${c.weekday}|${c.scheduleTime}`, c);
    return map;
  }, [cells]);

  if (cells.length === 0) {
    return (
      <p className="text-sm text-zinc-500">
        Sin horarios con historial establecido en el periodo.
      </p>
    );
  }

  return (
    <div className="relative max-w-full">
      <div
        className="max-w-full overflow-x-auto overscroll-x-contain [-webkit-overflow-scrolling:touch]"
        title="Desliza horizontalmente para ver todos los horarios"
      >
        <table
          className="border-separate border-spacing-0 text-left text-xs"
          style={{ minWidth: `${2.5 + hours.length * 3.5}rem` }}
          aria-label="Demanda por horario"
        >
          <thead>
            <tr className="text-zinc-500">
              <th
                className="sticky left-0 z-10 bg-white px-2 py-2 font-medium"
                scope="col"
              >
                Día
              </th>
              {hours.map((h) => (
                <th
                  key={h}
                  className="whitespace-nowrap px-2.5 py-2 font-medium tabular-nums"
                  scope="col"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[1, 2, 3, 4, 5, 6, 0].map((dow) => (
              <tr key={dow}>
                <th
                  className="sticky left-0 z-10 bg-white px-2 py-1.5 font-medium text-zinc-700"
                  scope="row"
                >
                  {WEEKDAY_SHORT[dow]}
                </th>
                {hours.map((h) => {
                  const cell = byKey.get(`${dow}|${h}`);
                  const raw =
                    metric === "avg_attendance"
                      ? cell?.avgAttendance
                      : metric === "attendance_occupancy"
                        ? cell?.attendanceOccupancyPct
                        : cell?.bookingOccupancyPct;
                  const intensity =
                    metric === "avg_attendance"
                      ? heatmapIntensity(raw ?? null)
                      : heatmapIntensity(
                          raw == null ? null : Math.min(4, (raw / 25) * 3),
                        );
                  const title = cell
                    ? [
                        `${WEEKDAY_FULL[dow]} ${h}`,
                        `Sesiones elegibles: ${cell.sessions}`,
                        `Activas: ${cell.activeSessions}`,
                        `Asist. prom: ${formatNum(cell.avgAttendance)}`,
                        `Ocup. asist: ${formatPct(cell.attendanceOccupancyPct)}`,
                        `Ocup. res: ${formatPct(cell.bookingOccupancyPct)}`,
                        `Semanas: ${cell.distinctWeeks}`,
                        `Historial: establecido`,
                      ].join("\n")
                    : undefined;
                  const label = cell
                    ? `${WEEKDAY_FULL[dow]} ${h}: ${formatNum(raw)}`
                    : `${WEEKDAY_FULL[dow]} ${h}: sin datos`;
                  return (
                    <td key={h} className="px-1 py-1">
                      <div
                        title={title}
                        aria-label={label}
                        tabIndex={0}
                        className="flex h-9 w-[3.25rem] min-w-[3.25rem] items-center justify-center rounded tabular-nums text-zinc-800 outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
                        style={{
                          backgroundColor:
                            cell == null
                              ? "transparent"
                              : `rgba(24, 24, 27, ${0.04 + intensity * 0.34})`,
                        }}
                      >
                        {cell == null ? "" : formatNum(raw)}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div
        className="pointer-events-none absolute inset-y-0 right-0 w-7 bg-gradient-to-l from-white to-transparent md:hidden"
        aria-hidden
      />
    </div>
  );
}

export default function ClassScheduleAnalyticsPage() {
  const router = useRouter();
  const { selectedStudioId, studioRole, ready } = useDeskStudio();
  const [period, setPeriod] = useState("last_30d");
  const [summary, setSummary] = useState<ClassScheduleSummaryDto | null>(null);
  const [activity, setActivity] = useState<ClassScheduleActivityDto | null>(null);
  const [templates, setTemplates] = useState<ClassTemplateRowDto[]>([]);
  const [slots, setSlots] = useState<ClassScheduleSlotRowDto[]>([]);
  const [drawer, setDrawer] = useState<ClassTemplateDetailDto | null>(null);
  const [heatmapMetric, setHeatmapMetric] = useState<
    "avg_attendance" | "attendance_occupancy" | "booking_occupancy"
  >("avg_attendance");
  const [limitedOpen, setLimitedOpen] = useState(false);
  const [slotsLimitedOpen, setSlotsLimitedOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    if (!canAccessExecutiveDashboard(studioRole)) {
      router.replace("/check-in");
    }
  }, [ready, studioRole, router]);

  const load = useCallback(async () => {
    if (!selectedStudioId || !canAccessExecutiveDashboard(studioRole)) return;
    setLoading(true);
    setError(null);
    try {
      const [s, a, t, sl] = await Promise.all([
        fetchClassScheduleSummary(selectedStudioId, period),
        fetchClassScheduleActivity(selectedStudioId, period),
        fetchClassScheduleTemplates(selectedStudioId, period),
        fetchClassScheduleSlots(selectedStudioId, period),
      ]);
      setSummary(s);
      setActivity(a);
      setTemplates(t.data);
      setSlots(sl.data);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo cargar clases y horarios");
    } finally {
      setLoading(false);
    }
  }, [selectedStudioId, studioRole, period]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDrawer = async (classTemplateId: string) => {
    if (!selectedStudioId) return;
    try {
      const detail = await fetchClassScheduleTemplateDetail(
        selectedStudioId,
        classTemplateId,
        period,
      );
      setDrawer(detail);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo abrir la clase");
    }
  };

  const establishedSlots = useMemo(
    () => slots.filter((s) => s.slotMaturity === "ESTABLISHED_SLOT"),
    [slots],
  );
  const limitedSlots = useMemo(
    () => slots.filter((s) => s.slotMaturity === "LIMITED_HISTORY_SLOT"),
    [slots],
  );
  const limitedHistoryGroups = useMemo(
    () => groupLimitedHistoryByWeekday(activity?.limitedHistorySlots ?? []),
    [activity?.limitedHistorySlots],
  );

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <AnalyticsSubNav />
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <PageHeader
          title="Clases y horarios"
          subtitle="Qué funciona, qué revisar, y dónde aún no hay historial suficiente."
        />
        <select
          className={adminInput}
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          aria-label="Periodo"
        >
          {PERIOD_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {error ? <p className="mb-4 text-sm text-red-600">{error}</p> : null}
      {loading && !summary ? <p className="text-sm text-zinc-500">Cargando…</p> : null}

      {summary ? (
        <>
          {summary.isPartialPeriod || summary.trustedFloorApplied ? (
            <p className="mb-4 text-xs text-zinc-500">
              {summary.isPartialPeriod ? "Periodo parcial (mes en curso). " : ""}
              {summary.trustedFloorApplied
                ? "Se aplica el piso de historial confiable de asistencia."
                : null}
            </p>
          ) : null}

          <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <KpiCard
              label="Sesiones con actividad"
              value={String(summary.kpis.activeSessions)}
              hint={`De ${summary.kpis.scheduledSessions} programadas elegibles`}
            />
            <KpiCard label="Asistencias" value={String(summary.kpis.attendances)} />
            <KpiCard
              label="Asist. / sesión activa"
              value={formatNum(summary.kpis.avgAttendancePerActiveSession)}
              hint="Señal principal de demanda"
            />
            <KpiCard
              label="Show rate"
              value={formatPct(summary.kpis.showRatePct)}
              hint={`${summary.kpis.confirmedAttended}/${summary.kpis.confirmedBookings} reservas confirmadas con check-in`}
            />
            <KpiCard
              label="Sesiones vacías"
              value={String(summary.kpis.emptySessions)}
              hint={
                summary.kpis.emptySessionRatePct != null
                  ? `${summary.kpis.emptySessionRatePct}% · eficiencia del calendario, no “clases malas”`
                  : "Sin reservas ni asistencia"
              }
            />
            <KpiCard
              label="Utilización de capacidad"
              value={formatPct(summary.kpis.capacityUtilizationPct)}
              hint={`Contexto secundario · activas ${formatPct(summary.kpis.capacityUtilizationActivePct)}`}
              secondary
            />
          </div>
        </>
      ) : null}

      <section className="mb-10">
        <h2 className="mb-1 text-base font-semibold text-zinc-900">Oportunidades</h2>
        <p className="mb-3 text-xs text-zinc-500">
          Acciones con evidencia y historial establecido. Sin ampliar capacidad.
        </p>
        {(activity?.opportunities.length ?? 0) === 0 ? (
          <p className="text-sm text-zinc-500">
            No hay oportunidades con muestra suficiente en este periodo.
          </p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {activity!.opportunities.map((o, idx) => (
              <OpportunityCard key={`${o.type}-${idx}`} o={o} />
            ))}
          </div>
        )}
      </section>

      {(activity?.operationalReadings.length ?? 0) > 0 ? (
        <section className="mb-10">
          <h2 className="mb-1 text-base font-semibold text-zinc-900">Lectura operativa</h2>
          <p className="mb-3 text-xs text-zinc-500">
            Qué dice el dato sobre el negocio — no es una lista de tareas.
          </p>
          <div className="space-y-3">
            {activity!.operationalReadings.map((r, i) => (
              <SurfaceCard key={i} className="border-l-2 border-l-zinc-300 p-4">
                <p className="text-sm text-zinc-900">{r.text}</p>
                <p className="mt-1 text-xs text-zinc-500">{r.evidence}</p>
              </SurfaceCard>
            ))}
          </div>
        </section>
      ) : null}

      <section className="mb-10">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-zinc-900">Demanda por horario</h2>
            <p className="mt-1 text-xs text-zinc-500">
              Solo horarios con historial establecido. Hora de inicio programada (zona del
              estudio).
            </p>
          </div>
          <select
            className={adminInput}
            value={heatmapMetric}
            onChange={(e) =>
              setHeatmapMetric(
                e.target.value as
                  | "avg_attendance"
                  | "attendance_occupancy"
                  | "booking_occupancy",
              )
            }
            aria-label="Métrica del mapa"
          >
            <option value="avg_attendance">Asistencia promedio</option>
            <option value="attendance_occupancy">Ocupación por asistencia</option>
            <option value="booking_occupancy">Ocupación por reservas</option>
          </select>
        </div>
        <SurfaceCard className="p-4">
          <Heatmap cells={activity?.heatmap ?? []} metric={heatmapMetric} />
          {activity?.limitedHistorySummary ? (
            <div className="mt-4 border-t border-zinc-100 pt-3">
              <button
                type="button"
                className="text-left text-xs text-zinc-600 underline-offset-2 hover:underline"
                onClick={() => setLimitedOpen((v) => !v)}
                aria-expanded={limitedOpen}
              >
                Horarios con historial limitado
                <span className="mt-0.5 block font-normal text-zinc-500 no-underline">
                  {activity.limitedHistorySummary}
                </span>
              </button>
              {limitedOpen ? (
                <div className="mt-3 space-y-3">
                  {limitedHistoryGroups.map((group) => (
                    <div key={group.weekday}>
                      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-zinc-500">
                        {group.label}
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {group.items.map((s) => (
                          <span
                            key={`${s.weekday}-${s.scheduleTime}`}
                            className="inline-flex items-center rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs tabular-nums text-zinc-700"
                            title={
                              s.classNames.length
                                ? s.classNames.join(", ")
                                : undefined
                            }
                          >
                            <span className="font-medium">{s.scheduleTime}</span>
                            <span className="mx-1 text-zinc-300">·</span>
                            <span className="text-zinc-500">n={s.scheduledSessions}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                  <p className="text-[11px] leading-relaxed text-zinc-500">
                    {LIMITED_HISTORY_FOOTNOTE}
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}
        </SurfaceCard>
      </section>

      <section className="mb-10">
        <h2 className="mb-1 text-base font-semibold text-zinc-900">Desempeño por clase</h2>
        <p className="mb-3 text-xs text-zinc-500">
          Ordenado por asistencia promedio / sesión activa. Clases con{" "}
          {SAMPLE_INSUFFICIENT_LABEL.toLowerCase()} no lideran el ranking.
        </p>
        <div className={adminTableWrap}>
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-zinc-200 text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-3 py-2">Clase</th>
                <th className="px-3 py-2">Sesiones</th>
                <th className="px-3 py-2">Activas</th>
                <th className="px-3 py-2">Asistencias</th>
                <th className="px-3 py-2 text-zinc-400">Únicos</th>
                <th className="px-3 py-2">Asist./sesión</th>
                <th className="px-3 py-2">Show rate</th>
                <th className="px-3 py-2">Vacías</th>
                <th className="px-3 py-2 text-zinc-400">Ocupación</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr
                  key={t.classTemplateId}
                  className="cursor-pointer border-b border-zinc-100 hover:bg-zinc-50"
                  onClick={() => void openDrawer(t.classTemplateId)}
                >
                  <td className="px-3 py-2">
                    <span className="font-medium">{t.className}</span>
                    {t.sampleInsufficient ? (
                      <span
                        className={`${adminStatusPill} ml-2 bg-amber-50 text-amber-900`}
                      >
                        {SAMPLE_INSUFFICIENT_LABEL}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-zinc-600">
                    {t.scheduledSessions}
                  </td>
                  <td className="px-3 py-2 tabular-nums font-medium">{t.activeSessions}</td>
                  <td className="px-3 py-2 tabular-nums">{t.attendances}</td>
                  <td className="px-3 py-2 tabular-nums text-zinc-400">{t.uniqueMembers}</td>
                  <td className="px-3 py-2 tabular-nums text-base font-semibold">
                    {formatNum(t.avgAttendancePerActiveSession)}
                  </td>
                  <td className="px-3 py-2 tabular-nums font-medium">
                    {formatPct(t.showRatePct)}
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {t.emptySessions}
                    {t.emptyRatePct != null ? ` · ${t.emptyRatePct}%` : ""}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-zinc-400">
                    {formatPct(t.attendanceOccupancyPct)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mb-10">
        <h2 className="mb-1 text-base font-semibold text-zinc-900">Desempeño por horario</h2>
        <p className="mb-3 text-xs text-zinc-500">
          Incluye sesiones vacías. Revisa frecuencia u horario — no etiquetamos “clase mala”.
        </p>
        <div className={adminTableWrap}>
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-zinc-200 text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-3 py-2">Horario</th>
                <th className="px-3 py-2">Sesiones</th>
                <th className="px-3 py-2">Activas</th>
                <th className="px-3 py-2">Asist. prom</th>
                <th className="px-3 py-2 text-zinc-400">Res. prom</th>
                <th className="px-3 py-2">Vacías</th>
                <th className="px-3 py-2">Show rate</th>
                <th className="px-3 py-2">Estado</th>
              </tr>
            </thead>
            <tbody>
              {establishedSlots.map((s) => (
                <SlotTableRow key={`${s.weekday}-${s.scheduleTime}`} s={s} />
              ))}
              {slotsLimitedOpen
                ? limitedSlots.map((s) => (
                    <SlotTableRow key={`${s.weekday}-${s.scheduleTime}`} s={s} />
                  ))
                : null}
            </tbody>
          </table>
        </div>
        {limitedSlots.length > 0 ? (
          <button
            type="button"
            className="mt-3 text-xs text-zinc-600 underline-offset-2 hover:underline"
            onClick={() => setSlotsLimitedOpen((v) => !v)}
            aria-expanded={slotsLimitedOpen}
          >
            {slotsLimitedOpen
              ? "Ocultar horarios con historial limitado"
              : `Ver ${limitedSlots.length} horario${limitedSlots.length === 1 ? "" : "s"} con historial limitado`}
          </button>
        ) : null}
      </section>

      {(activity?.instructorNote || activity?.waitlistNote) && (
        <p className="mb-6 text-xs text-zinc-500">
          {[activity.instructorNote, activity.waitlistNote].filter(Boolean).join(" · ")}
        </p>
      )}

      {drawer ? <ClassDrawer detail={drawer} onClose={() => setDrawer(null)} /> : null}
    </div>
  );
}
