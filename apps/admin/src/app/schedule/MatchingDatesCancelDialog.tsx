"use client";

import { useEffect, useState } from "react";

import { adminSecondaryBtn } from "@/lib/adminSurface";
import { ApiError } from "@/lib/api/errors";
import {
  executeMatchingDatesCancel,
  previewMatchingDatesCancel,
  type MatchingDatesPreview,
} from "@/lib/api/scheduleOperations";

const PROTECTED_LABEL = { STARTED: "ya comenzó o terminó", ATTENDED: "tiene asistencias" } as const;
const EXCLUDED_LABEL = {
  OTHER_INSTRUCTOR: "otro instructor",
  SERIES: "pertenece a una serie recurrente",
} as const;

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * Cancels every future unlinked date that shares this class type, weekday and start time.
 * Does not install a block: staff can still create a later date by hand.
 */
export function MatchingDatesCancelDialog({
  studioId,
  scheduledClassId,
  onClose,
  onDone,
}: {
  studioId: string;
  scheduledClassId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [includeOthers, setIncludeOthers] = useState(false);
  const [preview, setPreview] = useState<MatchingDatesPreview | null>(null);
  const [reason, setReason] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    let cancelled = false;
    void previewMatchingDatesCancel(studioId, scheduledClassId, includeOthers)
      .then((row) => { if (!cancelled) setPreview(row); })
      .catch((e) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : "No se pudo calcular las fechas.");
      });
    return () => { cancelled = true; };
  }, [studioId, scheduledClassId, includeOthers]);

  async function onConfirm() {
    if (!preview || !acknowledged) return;
    setBusy(true);
    setError(null);
    try {
      await executeMatchingDatesCancel(studioId, {
        scheduledClassId,
        includeOtherInstructors: includeOthers,
        previewFingerprint: preview.previewFingerprint,
        cancelReason: reason.trim() || undefined,
        idempotencyKey,
      });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudieron cancelar las fechas.");
    } finally {
      setBusy(false);
    }
  }

  const who = preview?.instructorName ? `con ${preview.instructorName}` : "sin instructor";

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[min(90vh,760px)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="border-b border-zinc-200 px-6 py-4">
          <h2 className="text-base font-semibold text-zinc-900">Cancelar todas las fechas</h2>
          <p className="mt-1 text-sm text-zinc-600">
            {preview
              ? `${preview.className} ${who}, ${preview.localTime} hora del estudio. Solo fechas futuras que no pertenecen a una serie.`
              : "Buscando fechas futuras que coinciden con esta clase…"}
          </p>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
          <label className="flex items-start gap-2 text-sm text-zinc-800">
            <input
              type="checkbox"
              className="mt-1"
              checked={includeOthers}
              onChange={(e) => {
                setIncludeOthers(e.target.checked);
                setPreview(null);
                setAcknowledged(false);
                setError(null);
              }}
            />
            <span>
              Incluir el mismo día y hora con otro instructor. Si no lo marcas, esas fechas se quedan.
            </span>
          </label>
          <p className="text-sm text-zinc-600">
            Esto no impide crear después una clase nueva en otra fecha. Las fechas canceladas se conservan y ni la generación ni copiar una semana las vuelve a abrir. Si quieres una de estas fechas otra vez, créala manualmente.
          </p>
          {preview ? (
            <>
              <p className="text-sm text-zinc-800">
                {countLabel(preview.totals.classes, "fecha", "fechas")}, {countLabel(preview.totals.bookings, "reserva", "reservas")} y {countLabel(preview.totals.waitlist, "en espera", "en espera")}.
                {preview.alreadyCancelledCount > 0 ? ` ${preview.alreadyCancelledCount} ya estaban canceladas.` : ""}
              </p>
              <ul className="max-h-48 divide-y divide-zinc-100 overflow-y-auto rounded-xl border border-zinc-200 text-sm">
                {preview.classes.map((row) => (
                  <li key={row.id} className="flex justify-between gap-3 px-3 py-2">
                    <span>{row.localDate} {row.localTime} · {row.className}{row.instructorName ? ` · ${row.instructorName}` : ""}</span>
                    <span className="shrink-0 text-zinc-500">{row.bookings} reservas · {row.waitlist} espera</span>
                  </li>
                ))}
                {preview.classes.length === 0 ? <li className="px-3 py-4 text-zinc-500">No hay fechas futuras que cancelar.</li> : null}
              </ul>
              {preview.protectedClasses.length > 0 ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
                  <p className="font-medium">Se conservan {preview.protectedClasses.length} protegidas:</p>
                  <ul className="mt-1">
                    {preview.protectedClasses.map((row) => (
                      <li key={row.id}>{row.localDate} {row.localTime} — {PROTECTED_LABEL[row.reason]}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {preview.excludedClasses.length > 0 ? (
                <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700">
                  <p className="font-medium">No se cancelan {preview.excludedClasses.length}:</p>
                  <ul className="mt-1">
                    {preview.excludedClasses.map((row) => (
                      <li key={row.id}>{row.localDate} {row.localTime}{row.instructorName ? ` · ${row.instructorName}` : ""} — {EXCLUDED_LABEL[row.reason]}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {preview.totals.classes > 0 ? (
                <>
                  <label className="block text-sm">
                    <span className="mb-1 block text-zinc-600">Motivo</span>
                    <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} className="w-full rounded-lg border border-zinc-300 px-3 py-2" />
                  </label>
                  <label className="flex items-start gap-2 text-sm text-zinc-800">
                    <input type="checkbox" className="mt-1" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
                    Confirmo cancelar estas {countLabel(preview.totals.classes, "fecha", "fechas")}, sus {countLabel(preview.totals.bookings, "reserva", "reservas")} y {countLabel(preview.totals.waitlist, "lugar en espera", "lugares en espera")}. Las demás horas de esta clase no cambian.
                  </label>
                </>
              ) : null}
            </>
          ) : null}
          {error ? <p className="text-sm text-red-700">{error}</p> : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-zinc-200 px-6 py-4">
          <button type="button" className={adminSecondaryBtn} disabled={busy} onClick={onClose}>Volver</button>
          <button
            type="button"
            className="rounded-xl bg-red-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-50"
            disabled={busy || !preview || !acknowledged || preview.totals.classes === 0}
            onClick={() => void onConfirm()}
          >
            {busy ? "Cancelando…" : preview ? `Cancelar ${preview.totals.classes} fechas` : "Cancelar fechas"}
          </button>
        </div>
      </div>
    </div>
  );
}
