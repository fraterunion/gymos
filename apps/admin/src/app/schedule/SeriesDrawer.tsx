"use client";

import { useEffect, useState } from "react";

import { ApiError } from "@/lib/api/errors";
import { adminPrimaryBtn, adminSecondaryBtn } from "@/lib/adminSurface";
import {
  fetchScheduleSeriesDetail,
  type SeriesDetail,
} from "@/lib/api/scheduleSeries";
import {
  capitalizeEs,
  formatEndTimeLocal,
  formatFrequency,
  formatLocalDateShort,
  formatOccurrenceInstant,
  formatScheduleLine,
  occurrenceExceptionCopy,
  seriesStatusLabel,
  seriesStatusTone,
} from "@/lib/scheduleSeriesPresentation";

export function SeriesDrawer({
  studioId,
  seriesId,
  timezone,
  canManage,
  onClose,
  onEdit,
  onFinish,
  onOpenOccurrence,
  refreshKey,
}: {
  studioId: string;
  seriesId: string;
  timezone: string;
  canManage: boolean;
  onClose: () => void;
  onEdit: (detail: SeriesDetail) => void;
  onFinish: (detail: SeriesDetail) => void;
  onOpenOccurrence: (occurrenceId: string, startsAt: string) => void;
  refreshKey?: number;
}) {
  const [detail, setDetail] = useState<SeriesDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetchScheduleSeriesDetail(studioId, seriesId)
      .then((row) => {
        if (!cancelled) setDetail(row);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof ApiError ? e.message : "No se pudo cargar la serie");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [seriesId, studioId, refreshKey]);

  return (
    <>
      <button type="button" className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-zinc-200 bg-white shadow-xl">
        {loading ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <div className="h-8 w-48 animate-pulse rounded bg-zinc-100" />
          </div>
        ) : error ? (
          <div className="p-6 text-sm text-red-700">{error}</div>
        ) : detail ? (
          <>
            <div className="border-b border-zinc-100 px-5 py-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-zinc-900">{detail.classTemplate.name}</h2>
                  <p className="mt-0.5 text-sm text-zinc-500">
                    {formatFrequency(detail.recurrence.intervalWeeks)} ·{" "}
                    {capitalizeEs(detail.localSchedule.weekdayLabel)}{" "}
                    {detail.localSchedule.startsAtLocal}
                  </p>
                </div>
                <button type="button" className={adminSecondaryBtn} onClick={onClose}>
                  Cerrar
                </button>
              </div>
              <span
                className={`mt-3 inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium ${seriesStatusTone(detail.status)}`}
              >
                {seriesStatusLabel(detail.status)}
              </span>
            </div>

            <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
              <section>
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                  Horario
                </h3>
                <dl className="mt-2 space-y-2 text-sm">
                  <div className="flex justify-between gap-4">
                    <dt className="text-zinc-500">Día</dt>
                    <dd className="font-medium text-zinc-900 capitalize">
                      {detail.localSchedule.weekdayLabel}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-zinc-500">Hora</dt>
                    <dd className="font-medium text-zinc-900">
                      {detail.localSchedule.startsAtLocal} –{" "}
                      {formatEndTimeLocal(
                        detail.localSchedule.startsAtLocal,
                        detail.localSchedule.durationMinutes,
                      )}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-zinc-500">Frecuencia</dt>
                    <dd className="font-medium text-zinc-900">
                      {detail.recurrence.intervalWeeks === 1
                        ? "Cada semana"
                        : formatFrequency(detail.recurrence.intervalWeeks)}
                    </dd>
                  </div>
                </dl>
              </section>

              <section>
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                  Configuración
                </h3>
                <dl className="mt-2 space-y-2 text-sm">
                  <div className="flex justify-between gap-4">
                    <dt className="text-zinc-500">Instructor</dt>
                    <dd className="font-medium text-zinc-900">{detail.instructor?.name ?? "—"}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-zinc-500">Capacidad</dt>
                    <dd className="font-medium text-zinc-900">{detail.capacity} personas</dd>
                  </div>
                </dl>
              </section>

              <section>
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                  Vigencia
                </h3>
                <dl className="mt-2 space-y-2 text-sm">
                  <div className="flex justify-between gap-4">
                    <dt className="text-zinc-500">Inicio</dt>
                    <dd className="font-medium text-zinc-900">
                      {detail.recurrence.isLegacy && !detail.recurrence.startsOn
                        ? "Horario histórico"
                        : formatLocalDateShort(detail.recurrence.startsOn, timezone)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-zinc-500">Fin</dt>
                    <dd className="font-medium text-zinc-900">
                      {detail.recurrence.endsOn
                        ? formatLocalDateShort(detail.recurrence.endsOn, timezone)
                        : "Sin fecha de fin"}
                    </dd>
                  </div>
                </dl>
              </section>

              <section>
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                  Próximas clases
                </h3>
                <ul className="mt-2 space-y-2">
                  {detail.upcomingOccurrences.length === 0 ? (
                    <li className="text-sm text-zinc-500">No hay clases futuras programadas.</li>
                  ) : (
                    detail.upcomingOccurrences.map((occ) => {
                      const exceptionCopy = occurrenceExceptionCopy(occ.exception);
                      return (
                        <li key={occ.id}>
                          <button
                            type="button"
                            className="w-full rounded-lg border border-zinc-100 px-3 py-2 text-left text-sm hover:border-zinc-200 hover:bg-zinc-50"
                            onClick={() => onOpenOccurrence(occ.id, occ.startsAt)}
                          >
                            <span className="font-medium text-zinc-900">
                              {formatOccurrenceInstant(occ.startsAt, timezone)}
                            </span>
                            {exceptionCopy ? (
                              <span className="mt-0.5 block text-xs text-zinc-500">
                                {exceptionCopy}
                              </span>
                            ) : null}
                          </button>
                        </li>
                      );
                    })
                  )}
                </ul>
              </section>

              <section className="rounded-xl border border-zinc-100 bg-zinc-50 px-4 py-3 text-sm text-zinc-700">
                <p>{detail.futureOccurrenceCount} clases futuras</p>
                <p className="mt-1">{detail.futureBookingCount} reservaciones en clases futuras</p>
              </section>
            </div>

            {canManage ? (
              <div className="flex gap-2 border-t border-zinc-100 px-5 py-4">
                <button
                  type="button"
                  className={`${adminPrimaryBtn} flex-1`}
                  disabled={!detail.anchorOccurrenceId}
                  onClick={() => onEdit(detail)}
                >
                  Editar serie
                </button>
                <button
                  type="button"
                  className={adminSecondaryBtn}
                  disabled={!detail.anchorOccurrenceId || detail.status === "ENDED"}
                  onClick={() => onFinish(detail)}
                >
                  Finalizar serie
                </button>
              </div>
            ) : null}
          </>
        ) : null}
      </aside>
    </>
  );
}
