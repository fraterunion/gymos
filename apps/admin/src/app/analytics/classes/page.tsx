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
  heatmapIntensity,
  PERIOD_OPTIONS,
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
    <SurfaceCard className={`p-4 ${secondary ? "opacity-90" : ""}`}>
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-zinc-900">{value}</p>
      {hint ? <p className="mt-1 text-xs text-zinc-500">{hint}</p> : null}
    </SurfaceCard>
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
    <div className="fixed inset-0 z-50 flex justify-end bg-black/20">
      <div className="h-full w-full max-w-md overflow-y-auto bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-zinc-200 p-5">
          <div>
            <p className="text-lg font-semibold text-zinc-900">{detail.className}</p>
            {detail.sampleInsufficient ? (
              <p className="mt-1 text-xs text-amber-700">Muestra insuficiente para ranking</p>
            ) : null}
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
                <dd className="font-medium">{detail.attendances}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">Miembros únicos</dt>
                <dd className="font-medium">{detail.uniqueMembers}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">Asist. / sesión activa</dt>
                <dd className="font-medium">{formatNum(detail.avgAttendancePerActiveSession)}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">Show rate</dt>
                <dd className="font-medium">{formatPct(detail.showRatePct)}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">Vacías</dt>
                <dd className="font-medium">
                  {detail.emptySessions}
                  {detail.emptyRatePct != null ? ` · ${detail.emptyRatePct}%` : ""}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">Ocupación (asist.)</dt>
                <dd className="font-medium">{formatPct(detail.attendanceOccupancyPct)}</dd>
              </div>
            </dl>
            {detail.capacityTypical != null ? (
              <p className="mt-2 text-xs text-zinc-500">
                Capacidad típica configurada: {detail.capacityTypical} — contexto secundario.
              </p>
            ) : null}
          </section>

          {detail.insight ? (
            <section>
              <h3 className="mb-2 font-medium text-zinc-900">Insight</h3>
              <p className="text-zinc-800">{detail.insight}</p>
              {detail.insightEvidence ? (
                <p className="mt-1 text-xs text-zinc-500">{detail.insightEvidence}</p>
              ) : null}
            </section>
          ) : null}

          <section>
            <h3 className="mb-2 font-medium text-zinc-900">Rendimiento por horario</h3>
            {detail.bySlot.length === 0 ? (
              <p className="text-zinc-500">Sin sesiones activas en el periodo.</p>
            ) : (
              <ul className="space-y-2">
                {detail.bySlot.map((s) => (
                  <li
                    key={`${s.weekday}-${s.scheduleTime}`}
                    className="flex items-center justify-between border-b border-zinc-100 py-1.5"
                  >
                    <span>
                      {formatSlot(s.weekday, s.scheduleTime)}
                      {s.sampleInsufficient ? (
                        <span className="ml-2 text-xs text-zinc-400">n={s.activeSessions}</span>
                      ) : (
                        <span className="ml-2 text-xs text-zinc-400">n={s.activeSessions}</span>
                      )}
                    </span>
                    <span className="tabular-nums font-medium">
                      {formatNum(s.avgAttendance)}
                    </span>
                  </li>
                ))}
              </ul>
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
                      {s.isEmpty ? (
                        <span className="ml-2 text-zinc-400">vacía</span>
                      ) : null}
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

  const maxVal = useMemo(() => {
    let m = 0;
    for (const c of cells) {
      const v =
        metric === "avg_attendance"
          ? c.avgAttendance
          : metric === "attendance_occupancy"
            ? c.attendanceOccupancyPct
            : c.bookingOccupancyPct;
      if (v != null && v > m) m = v;
    }
    return m || 1;
  }, [cells, metric]);

  const byKey = useMemo(() => {
    const map = new Map<string, ClassScheduleHeatmapCellDto>();
    for (const c of cells) map.set(`${c.weekday}|${c.scheduleTime}`, c);
    return map;
  }, [cells]);

  if (cells.length === 0) {
    return <p className="text-sm text-zinc-500">Sin sesiones elegibles en el periodo.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-left text-xs">
        <thead>
          <tr className="text-zinc-500">
            <th className="px-2 py-2 font-medium">Día</th>
            {hours.map((h) => (
              <th key={h} className="px-2 py-2 font-medium tabular-nums">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[1, 2, 3, 4, 5, 6, 0].map((dow) => (
            <tr key={dow}>
              <td className="px-2 py-1.5 font-medium text-zinc-700">{WEEKDAY_SHORT[dow]}</td>
              {hours.map((h) => {
                const cell = byKey.get(`${dow}|${h}`);
                const raw =
                  metric === "avg_attendance"
                    ? cell?.avgAttendance
                    : metric === "attendance_occupancy"
                      ? cell?.attendanceOccupancyPct
                      : cell?.bookingOccupancyPct;
                const intensity = heatmapIntensity(raw ?? null, maxVal);
                const title = cell
                  ? `${WEEKDAY_FULL[dow]} ${h}\nSesiones: ${cell.sessions} · Activas: ${cell.activeSessions}\nAsist. prom: ${formatNum(cell.avgAttendance)}\nOcup. asist: ${formatPct(cell.attendanceOccupancyPct)}\nOcup. res: ${formatPct(cell.bookingOccupancyPct)}`
                  : undefined;
                return (
                  <td key={h} className="px-1 py-1">
                    <div
                      title={title}
                      className="flex h-9 min-w-[2.5rem] items-center justify-center rounded tabular-nums text-zinc-800"
                      style={{
                        backgroundColor:
                          cell == null
                            ? "transparent"
                            : `rgba(24, 24, 27, ${0.04 + intensity * 0.28})`,
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

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <AnalyticsSubNav />
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <PageHeader
          title="Clases y horarios"
          subtitle="Qué clases y bloques horarios concentran demanda — y dónde el calendario está vacío."
        />
        <select
          className={adminInput}
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
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
                  ? `${summary.kpis.emptySessionRatePct}% de las programadas · sin reservas ni asistencia`
                  : "Sin reservas ni asistencia"
              }
            />
            <KpiCard
              label="Utilización de capacidad"
              value={formatPct(summary.kpis.capacityUtilizationPct)}
              hint={`Secundario · activas: ${formatPct(summary.kpis.capacityUtilizationActivePct)} · capacidad suele estar sobredimensionada`}
              secondary
            />
          </div>
        </>
      ) : null}

      <section className="mb-10">
        <h2 className="mb-1 text-base font-semibold text-zinc-900">Oportunidades</h2>
        <p className="mb-3 text-xs text-zinc-500">
          Hallazgos con evidencia y tamaño de muestra. Sin recomendaciones de ampliar capacidad.
        </p>
        {(activity?.opportunities.length ?? 0) === 0 ? (
          <p className="text-sm text-zinc-500">
            No hay oportunidades con muestra suficiente en este periodo.
          </p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {activity!.opportunities.map((o, idx) => (
              <SurfaceCard key={`${o.type}-${idx}`} className="p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                  {o.title}
                </p>
                <p className="mt-2 text-sm font-medium text-zinc-900">{o.reason}</p>
                <p className="mt-2 text-xs text-zinc-600">{o.evidence}</p>
                <p className="mt-2 text-xs text-zinc-500">
                  n={o.sampleSize} · {o.suggestedAction}
                </p>
              </SurfaceCard>
            ))}
          </div>
        )}
      </section>

      <section className="mb-10">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-zinc-900">Demanda por horario</h2>
            <p className="mt-1 text-xs text-zinc-500">
              Basado en la hora de inicio programada (zona del estudio).
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
          >
            <option value="avg_attendance">Asistencia promedio</option>
            <option value="attendance_occupancy">Ocupación por asistencia</option>
            <option value="booking_occupancy">Ocupación por reservas</option>
          </select>
        </div>
        <SurfaceCard className="p-4">
          <Heatmap cells={activity?.heatmap ?? []} metric={heatmapMetric} />
        </SurfaceCard>
      </section>

      <section className="mb-10">
        <h2 className="mb-1 text-base font-semibold text-zinc-900">Desempeño por clase</h2>
        <p className="mb-3 text-xs text-zinc-500">
          Ordenado por asistencia promedio por sesión activa · muestra mínima recomendada: 5
          sesiones activas.
        </p>
        <div className={adminTableWrap}>
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-zinc-200 text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-3 py-2">Clase</th>
                <th className="px-3 py-2">Sesiones</th>
                <th className="px-3 py-2">Activas</th>
                <th className="px-3 py-2">Asistencias</th>
                <th className="px-3 py-2">Únicos</th>
                <th className="px-3 py-2">Asist./sesión</th>
                <th className="px-3 py-2">Show rate</th>
                <th className="px-3 py-2">Vacías</th>
                <th className="px-3 py-2">Ocupación</th>
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
                    {t.className}
                    {t.sampleInsufficient ? (
                      <span className="ml-2 text-xs text-amber-700">n baja</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 tabular-nums">{t.scheduledSessions}</td>
                  <td className="px-3 py-2 tabular-nums">{t.activeSessions}</td>
                  <td className="px-3 py-2 tabular-nums">{t.attendances}</td>
                  <td className="px-3 py-2 tabular-nums">{t.uniqueMembers}</td>
                  <td className="px-3 py-2 tabular-nums font-medium">
                    {formatNum(t.avgAttendancePerActiveSession)}
                  </td>
                  <td className="px-3 py-2 tabular-nums">{formatPct(t.showRatePct)}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {t.emptySessions}
                    {t.emptyRatePct != null ? ` · ${t.emptyRatePct}%` : ""}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-zinc-500">
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
          Incluye sesiones vacías en el denominador de promedio y tasa de vacías.
        </p>
        <div className={adminTableWrap}>
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-zinc-200 text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-3 py-2">Horario</th>
                <th className="px-3 py-2">Sesiones</th>
                <th className="px-3 py-2">Activas</th>
                <th className="px-3 py-2">Asist. prom</th>
                <th className="px-3 py-2">Res. prom</th>
                <th className="px-3 py-2">Vacías</th>
                <th className="px-3 py-2">Show rate</th>
                <th className="px-3 py-2">Estado</th>
              </tr>
            </thead>
            <tbody>
              {slots.map((s) => (
                <tr
                  key={`${s.weekday}-${s.scheduleTime}`}
                  className="border-b border-zinc-100"
                >
                  <td className="px-3 py-2 font-medium">
                    {formatSlot(s.weekday, s.scheduleTime)}
                  </td>
                  <td className="px-3 py-2 tabular-nums">{s.scheduledSessions}</td>
                  <td className="px-3 py-2 tabular-nums">{s.activeSessions}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {formatNum(s.avgAttendance)}
                  </td>
                  <td className="px-3 py-2 tabular-nums">{formatNum(s.avgBookings)}</td>
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
              ))}
            </tbody>
          </table>
        </div>
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
