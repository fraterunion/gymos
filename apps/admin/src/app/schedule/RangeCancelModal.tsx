"use client";

import { useMemo, useState } from "react";

import { adminModalOverlay, adminModalPanel, adminPrimaryBtn, adminSecondaryBtn } from "@/lib/adminSurface";
import type { ClassTemplateDto } from "@/lib/api/classTemplates";
import { ApiError } from "@/lib/api/errors";
import {
  executeRangeCancel,
  newIdempotencyKey,
  previewRangeCancel,
  type RangeCancelFilters,
  type RangeCancelPreview,
} from "@/lib/api/scheduleOperations";
import type { StaffInstructorDto } from "@/lib/api/staff";
import { PROTECTED_REASON_LABEL, groupByWeek, rangeCancelConfirmText, validateRangeDates } from "@/lib/rangeCancel";

type Props = {
  studioId: string;
  timezone: string;
  defaultFromDate: string;
  templates: ClassTemplateDto[];
  instructors: StaffInstructorDto[];
  onClose: () => void;
  onDone: (message?: string) => void;
};

function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/**
 * "Cancelar clases por rango de fechas": exact preview across weeks, explicit confirmation,
 * optional reason. The API refuses a confirmation whose preview went stale (409), so any change
 * of dates or filters here clears the preview.
 */
export function RangeCancelModal({ studioId, timezone, defaultFromDate, templates, instructors, onClose, onDone }: Props) {
  const [fromDate, setFromDate] = useState(defaultFromDate);
  const [toDate, setToDate] = useState(defaultFromDate);
  const [templateIds, setTemplateIds] = useState<string[]>([]);
  const [instructorIds, setInstructorIds] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<RangeCancelPreview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey] = useState(() => newIdempotencyKey());

  const filters: RangeCancelFilters = useMemo(() => ({
    fromDate,
    toDate,
    ...(templateIds.length ? { classTemplateIds: templateIds } : {}),
    ...(instructorIds.length ? { instructorIds } : {}),
  }), [fromDate, toDate, templateIds, instructorIds]);

  const resetPreview = () => {
    setPreview(null);
    setAcknowledged(false);
  };

  async function onPreview() {
    const invalid = validateRangeDates(fromDate, toDate);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setPreview(await previewRangeCancel(studioId, filters));
      setAcknowledged(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo generar la vista previa.");
    } finally {
      setBusy(false);
    }
  }

  async function onConfirm() {
    if (!preview || !acknowledged || preview.totals.classes === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await executeRangeCancel(studioId, {
        ...filters,
        previewFingerprint: preview.previewFingerprint,
        cancelReason: reason.trim() || undefined,
        idempotencyKey,
      });
      const kept = result.protectedClasses.length;
      onDone(
        `Se cancelaron ${result.cancelledCount} clases (${result.cancelledBookingCount} reservas canceladas, ` +
          `${result.expiredWaitlistCount} en lista de espera).` +
          (kept ? ` ${kept} clases protegidas se mantuvieron.` : ""),
      );
    } catch (e) {
      const message = e instanceof ApiError ? e.message : "No se pudo cancelar el rango.";
      setError(message);
      if (e instanceof ApiError && e.status === 409) resetPreview();
    } finally {
      setBusy(false);
    }
  }

  const weeks = preview ? groupByWeek(preview.classes) : [];
  const instructorName = (i: StaffInstructorDto) => `${i.firstName} ${i.lastName}`.trim();

  return (
    <div className={adminModalOverlay}>
      <div className={`${adminModalPanel} max-w-2xl`}>
        <h2 className="text-lg font-semibold text-zinc-900">Cancelar clases por rango de fechas</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Fechas en la zona horaria del estudio ({timezone}), incluidas ambas. Se conservan las clases que ya
          comenzaron y las que tienen check-in anticipado.
        </p>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-zinc-600">Desde</span>
            <input type="date" value={fromDate} onChange={(e) => { setFromDate(e.target.value); resetPreview(); }} className="w-full rounded-lg border border-zinc-300 px-3 py-2" />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-zinc-600">Hasta</span>
            <input type="date" value={toDate} onChange={(e) => { setToDate(e.target.value); resetPreview(); }} className="w-full rounded-lg border border-zinc-300 px-3 py-2" />
          </label>
        </div>

        <fieldset className="mt-4">
          <legend className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Tipo de clase (opcional)</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {templates.map((t) => (
              <label key={t.id} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={templateIds.includes(t.id)} onChange={() => { setTemplateIds(toggle(templateIds, t.id)); resetPreview(); }} />
                {t.name}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="mt-3">
          <legend className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Instructor (opcional)</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {instructors.map((i) => (
              <label key={i.userId} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={instructorIds.includes(i.userId)} onChange={() => { setInstructorIds(toggle(instructorIds, i.userId)); resetPreview(); }} />
                {instructorName(i)}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="mt-4">
          <button type="button" className={adminSecondaryBtn} disabled={busy} onClick={() => void onPreview()}>
            Vista previa
          </button>
        </div>

        {preview ? (
          <div className="mt-4 space-y-3">
            <p className="text-sm font-medium text-zinc-900">
              {preview.totals.classes} clases en {preview.weekCount} semanas · {preview.totals.bookings} reservas ·{" "}
              {preview.totals.waitlist} en lista de espera
              {preview.alreadyCancelledCount ? ` · ${preview.alreadyCancelledCount} ya canceladas` : ""}
            </p>
            <div className="max-h-64 overflow-y-auto rounded-lg border border-zinc-200 text-sm">
              {weeks.length === 0 ? <p className="p-3 text-zinc-500">No hay clases para cancelar en este rango.</p> : null}
              {weeks.map((week) => (
                <div key={week.weekStart}>
                  <p className="sticky top-0 bg-zinc-50 px-3 py-1 text-xs font-semibold text-zinc-600">Semana del {week.weekStart}</p>
                  <ul>
                    {week.rows.map((c) => (
                      <li key={c.id} className="flex justify-between gap-2 border-t border-zinc-100 px-3 py-1.5">
                        <span>{c.localDate} {c.localTime} · {c.className}{c.instructorName ? ` · ${c.instructorName}` : ""}{c.seriesId ? " · serie" : ""}</span>
                        <span className="shrink-0 text-zinc-500">{c.bookings} reservas · {c.waitlist} espera</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            {preview.protectedClasses.length ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                <p className="font-medium">Se mantendrán {preview.protectedClasses.length} clases protegidas:</p>
                <ul className="mt-1 max-h-32 overflow-y-auto">
                  {preview.protectedClasses.map((c) => (
                    <li key={c.id}>{c.localDate} {c.localTime} · {c.className} — {PROTECTED_REASON_LABEL[c.reason]}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {preview.totals.classes > 0 ? (
              <>
                <label className="block text-sm">
                  <span className="mb-1 block text-zinc-600">Motivo de la cancelación</span>
                  <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} className="w-full rounded-lg border border-zinc-300 px-3 py-2" placeholder="Ej. Remodelación del estudio" />
                </label>
                <label className="flex items-start gap-2 text-sm text-zinc-800">
                  <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} className="mt-1" />
                  {rangeCancelConfirmText(preview.totals)}
                </label>
              </>
            ) : null}
          </div>
        ) : null}

        {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={adminSecondaryBtn} disabled={busy} onClick={onClose}>Cerrar</button>
          <button
            type="button"
            className={`${adminPrimaryBtn} bg-red-700 hover:bg-red-800`}
            disabled={busy || !preview || !acknowledged || preview.totals.classes === 0}
            onClick={() => void onConfirm()}
          >
            {preview ? `Cancelar ${preview.totals.classes} clases` : "Cancelar clases"}
          </button>
        </div>
      </div>
    </div>
  );
}
