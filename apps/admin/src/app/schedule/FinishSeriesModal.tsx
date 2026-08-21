"use client";

import { useEffect, useState } from "react";

import { ApiError } from "@/lib/api/errors";
import { adminModalOverlay, adminModalPanel, adminPrimaryBtn, adminSecondaryBtn } from "@/lib/adminSurface";
import {
  finishSeries,
  previewFinishSeries,
  type FinishSeriesPreview,
  type SeriesDetail,
} from "@/lib/api/scheduleSeries";
import { formatLocalDateShort } from "@/lib/scheduleSeriesPresentation";

type FinishMode = "AFTER_LAST_SCHEDULED" | "ON_DATE";

export function FinishSeriesModal({
  studioId,
  timezone,
  detail,
  onClose,
  onDone,
}: {
  studioId: string;
  timezone: string;
  detail: SeriesDetail;
  onClose: () => void;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<FinishMode>("AFTER_LAST_SCHEDULED");
  const [boundaryDate, setBoundaryDate] = useState(detail.recurrence.endsOn ?? "");
  const [preview, setPreview] = useState<FinishSeriesPreview | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void previewFinishSeries(studioId, detail.id, {
      mode,
      boundaryDate: mode === "ON_DATE" ? boundaryDate : undefined,
    })
      .then(setPreview)
      .catch(() => setPreview(null));
  }, [boundaryDate, detail.id, mode, studioId]);

  const handleFinish = async () => {
    setSaving(true);
    setError(null);
    try {
      const nextPreview = await previewFinishSeries(studioId, detail.id, {
        mode,
        boundaryDate: mode === "ON_DATE" ? boundaryDate : undefined,
      });
      if (nextPreview.bookedOccurrencesAffected > 0) {
        const ok = window.confirm(
          `${nextPreview.cancelledCount} clases · ${nextPreview.impact.totalReservations} reservaciones afectadas. ¿Finalizar la serie?`,
        );
        if (!ok) return;
      }
      await finishSeries(studioId, detail.id, {
        mode,
        boundaryDate: mode === "ON_DATE" ? boundaryDate : undefined,
        cancelReason: "Serie finalizada desde administración de series",
        confirmReservations: true,
      });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo finalizar la serie");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={adminModalOverlay} onClick={onClose}>
      <div className={`${adminModalPanel} max-w-lg`} onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-zinc-900">Finalizar serie</h2>
        <p className="mt-2 text-sm text-zinc-600">
          La serie seguirá válida hasta la fecha elegida. No se generarán clases después.
        </p>

        <div className="mt-4 space-y-3 text-sm">
          <label className="flex items-start gap-2">
            <input
              type="radio"
              checked={mode === "AFTER_LAST_SCHEDULED"}
              onChange={() => setMode("AFTER_LAST_SCHEDULED")}
            />
            <span>
              Después de la última clase actualmente programada
              {preview && mode === "AFTER_LAST_SCHEDULED" ? (
                <span className="mt-0.5 block text-zinc-500">
                  Última clase: {formatLocalDateShort(preview.boundaryDateKey, timezone)}
                </span>
              ) : null}
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="radio"
              checked={mode === "ON_DATE"}
              onChange={() => setMode("ON_DATE")}
            />
            <span className="flex-1">
              Seleccionar fecha
              {mode === "ON_DATE" ? (
                <input
                  type="date"
                  className="mt-2 w-full rounded-xl border border-zinc-200 px-3 py-2"
                  value={boundaryDate}
                  onChange={(e) => setBoundaryDate(e.target.value)}
                />
              ) : null}
            </span>
          </label>
        </div>

        <div className="mt-4 rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p>
            {preview?.cancelledCount ?? 0} clases posteriores al límite serán canceladas
          </p>
          <p className="mt-1">{preview?.bookedOccurrencesAffected ?? 0} tienen reservaciones</p>
          {preview && preview.skippedDetachedCount > 0 ? (
            <p className="mt-1">{preview.skippedDetachedCount} clases modificadas individualmente incluidas</p>
          ) : null}
        </div>

        {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={adminSecondaryBtn} onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className={adminPrimaryBtn} disabled={saving} onClick={() => void handleFinish()}>
            {saving ? "Finalizando…" : "Finalizar serie"}
          </button>
        </div>
      </div>
    </div>
  );
}
