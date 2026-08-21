"use client";

import { useEffect, useMemo, useState } from "react";

import { ApiError } from "@/lib/api/errors";
import { adminModalOverlay, adminModalPanel, adminPrimaryBtn, adminSecondaryBtn } from "@/lib/adminSurface";
import {
  editSeriesOccurrence,
  previewEditOccurrence,
  type MutationImpact,
  type SeriesDetail,
  type SeriesRecurrenceImpact,
} from "@/lib/api/scheduleSeries";
import type { StaffInstructorDto } from "@/lib/api/staff";
import {
  capitalizeEs,
  formatFrequency,
  formatLocalDateShort,
} from "@/lib/scheduleSeriesPresentation";
import {
  frequencyLabelFromInterval,
  frequencyModeFromInterval,
  intervalWeeksFromMode,
  SeriesRecurrenceFields,
  type RecurrenceFrequencyMode,
  type SeriesVigenciaMode,
} from "@/app/schedule/SeriesRecurrenceFields";

function isoToLocalParts(iso: string, tz: string): { date: string; time: string } {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const h = parts.find((p) => p.type === "hour")?.value ?? "00";
  const m = parts.find((p) => p.type === "minute")?.value ?? "00";
  return { date, time: `${h}:${m}` };
}

export function EditSeriesModal({
  studioId,
  timezone,
  detail,
  members,
  onClose,
  onDone,
}: {
  studioId: string;
  timezone: string;
  detail: SeriesDetail;
  members: StaffInstructorDto[];
  onClose: () => void;
  onDone: () => void;
}) {
  const anchorId = detail.anchorOccurrenceId;
  const anchorOcc =
    detail.upcomingOccurrences.find((o) => o.id === anchorId) ?? detail.upcomingOccurrences[0];

  const [startTime, setStartTime] = useState(detail.localSchedule.startsAtLocal);
  const [capacity, setCapacity] = useState(String(detail.capacity));
  const [instructorId, setInstructorId] = useState(detail.instructor?.id ?? "");
  const [frequencyMode, setFrequencyMode] = useState<RecurrenceFrequencyMode>(() =>
    frequencyModeFromInterval(detail.recurrence.intervalWeeks),
  );
  const [customInterval, setCustomInterval] = useState(String(detail.recurrence.intervalWeeks));
  const [vigenciaMode, setVigenciaMode] = useState<SeriesVigenciaMode>(
    detail.recurrence.endsOn ? "date" : "never",
  );
  const [endsOn, setEndsOn] = useState(detail.recurrence.endsOn ?? "");
  const [impact, setImpact] = useState<MutationImpact | null>(null);
  const [recurrenceImpact, setRecurrenceImpact] = useState<SeriesRecurrenceImpact | null>(null);
  const [step, setStep] = useState<"form" | "preview">("form");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const intervalWeeks = intervalWeeksFromMode(frequencyMode, customInterval);

  const editPayload = useMemo(() => {
    if (!anchorId || !anchorOcc) return null;
    const local = isoToLocalParts(anchorOcc.startsAt, timezone);
    const intervalChanged = intervalWeeks !== detail.recurrence.intervalWeeks;
    const endsChanged =
      (vigenciaMode === "never" && detail.recurrence.endsOn !== null) ||
      (vigenciaMode === "date" && endsOn !== (detail.recurrence.endsOn ?? ""));

    return {
      scope: "SERIES" as const,
      localStart: { date: local.date, time: startTime },
      capacity: parseInt(capacity, 10),
      instructorId: instructorId || null,
      ...(intervalChanged ? { intervalWeeks } : {}),
      ...(endsChanged ? { endsOn: vigenciaMode === "date" ? endsOn : null } : {}),
    };
  }, [
    anchorId,
    anchorOcc,
    capacity,
    detail.recurrence.endsOn,
    detail.recurrence.intervalWeeks,
    endsOn,
    instructorId,
    intervalWeeks,
    startTime,
    timezone,
    vigenciaMode,
  ]);

  useEffect(() => {
    if (!anchorId || !editPayload) return;
    void previewEditOccurrence(studioId, anchorId, editPayload)
      .then((r) => {
        setImpact(r.impact);
        setRecurrenceImpact(r.recurrenceImpact ?? null);
      })
      .catch(() => {
        setImpact(null);
        setRecurrenceImpact(null);
      });
  }, [anchorId, editPayload, studioId]);

  if (!anchorId || !anchorOcc || !editPayload) {
    return (
      <div className={adminModalOverlay} onClick={onClose}>
        <div className={adminModalPanel} onClick={(e) => e.stopPropagation()}>
          <p className="text-sm text-zinc-600">No hay clases futuras para editar esta serie.</p>
          <button type="button" className={`${adminSecondaryBtn} mt-4`} onClick={onClose}>
            Cerrar
          </button>
        </div>
      </div>
    );
  }

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const preview = await previewEditOccurrence(studioId, anchorId, editPayload);
      if (preview.impact.totalReservations > 0) {
        const ok = window.confirm(
          `${preview.recurrenceImpact?.bookedOccurrencesAffected ?? preview.impact.classesWithReservations} clases con reservaciones · ${preview.impact.totalReservations} reservaciones afectadas. ¿Continuar?`,
        );
        if (!ok) return;
      }
      await editSeriesOccurrence(studioId, anchorId, {
        ...editPayload,
        confirmReservations: true,
      });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo editar la serie");
    } finally {
      setSaving(false);
    }
  };

  const prevFrequency = formatFrequency(detail.recurrence.intervalWeeks);
  const nextFrequency = frequencyLabelFromInterval(intervalWeeks);
  const prevEnd =
    detail.recurrence.endsOn === null
      ? "Sin fecha de fin"
      : formatLocalDateShort(detail.recurrence.endsOn, timezone);
  const nextEnd =
    vigenciaMode === "never" ? "Sin fecha de fin" : formatLocalDateShort(endsOn, timezone);

  return (
    <div className={adminModalOverlay} onClick={onClose}>
      <div className={`${adminModalPanel} max-w-lg`} onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-zinc-900">Editar serie</h2>
        <p className="mt-1 text-sm text-zinc-500">
          {detail.classTemplate.name} · {capitalizeEs(detail.localSchedule.weekdayLabel)}
        </p>

        {step === "form" ? (
          <form
            className="mt-4 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              setStep("preview");
            }}
          >
            <label className="block text-sm">
              <span className="text-zinc-600">Hora de inicio</span>
              <input
                type="time"
                className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
              />
            </label>
            <label className="block text-sm">
              <span className="text-zinc-600">Instructor</span>
              <select
                className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2"
                value={instructorId}
                onChange={(e) => setInstructorId(e.target.value)}
              >
                <option value="">Sin instructor</option>
                {members.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.firstName} {m.lastName}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-zinc-600">Capacidad</span>
              <input
                type="number"
                min={1}
                className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2"
                value={capacity}
                onChange={(e) => setCapacity(e.target.value)}
              />
            </label>

            <SeriesRecurrenceFields
              frequencyMode={frequencyMode}
              customInterval={customInterval}
              onFrequencyModeChange={setFrequencyMode}
              onCustomIntervalChange={setCustomInterval}
              vigenciaMode={vigenciaMode}
              endsOn={endsOn}
              onVigenciaModeChange={setVigenciaMode}
              onEndsOnChange={setEndsOn}
            />

            {error ? <p className="text-sm text-red-700">{error}</p> : null}
            <div className="flex justify-end gap-2">
              <button type="button" className={adminSecondaryBtn} onClick={onClose}>
                Cancelar
              </button>
              <button type="submit" className={adminPrimaryBtn}>
                Vista previa
              </button>
            </div>
          </form>
        ) : (
          <div className="mt-4 space-y-4 text-sm">
            <p className="font-medium text-zinc-800">Este cambio afectará:</p>
            <ul className="list-disc pl-5 text-zinc-700">
              <li>{recurrenceImpact?.keptCount ?? impact?.affectedClassCount ?? 0} clases se conservarán</li>
              <li>{recurrenceImpact?.cancelledCount ?? 0} dejarán de formar parte de la serie</li>
              <li>{recurrenceImpact?.materializeCount ?? 0} clases nuevas se programarán</li>
              <li>{recurrenceImpact?.bookedOccurrencesAffected ?? 0} tienen reservaciones</li>
            </ul>
            <div className="rounded-xl border border-zinc-100 bg-zinc-50 px-4 py-3 space-y-1">
              {prevFrequency !== nextFrequency ? (
                <p>
                  Repetición: {prevFrequency} → {nextFrequency}
                </p>
              ) : null}
              {prevEnd !== nextEnd ? (
                <p>
                  Vigencia: {prevEnd} → {nextEnd}
                </p>
              ) : null}
              {detail.localSchedule.startsAtLocal !== startTime ? (
                <p>
                  Horario: {detail.localSchedule.startsAtLocal} → {startTime}
                </p>
              ) : null}
            </div>
            {error ? <p className="text-sm text-red-700">{error}</p> : null}
            <div className="flex justify-end gap-2">
              <button type="button" className={adminSecondaryBtn} onClick={() => setStep("form")}>
                Atrás
              </button>
              <button type="button" className={adminPrimaryBtn} disabled={saving} onClick={() => void handleSave()}>
                {saving ? "Guardando…" : "Confirmar cambios"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
