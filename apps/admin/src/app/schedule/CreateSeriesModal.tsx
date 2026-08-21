"use client";

import { useEffect, useMemo, useState } from "react";

import { ApiError } from "@/lib/api/errors";
import { adminModalOverlay, adminModalPanel, adminPrimaryBtn, adminSecondaryBtn } from "@/lib/adminSurface";
import {
  createRecurringSeries,
  previewRecurringSeries,
  type SeriesPreviewResult,
} from "@/lib/api/scheduleSeries";
import type { ClassTemplateDto } from "@/lib/api/classTemplates";
import type { StaffInstructorDto } from "@/lib/api/staff";
import {
  formatFrequency,
  formatLocalDateShort,
} from "@/lib/scheduleSeriesPresentation";
import {
  intervalWeeksFromMode,
  SeriesRecurrenceFields,
  type RecurrenceFrequencyMode,
  type SeriesVigenciaMode,
} from "@/app/schedule/SeriesRecurrenceFields";

const WEEKDAY_PILLS = [
  { dow: 0, short: "D" },
  { dow: 1, short: "L" },
  { dow: 2, short: "M" },
  { dow: 3, short: "X" },
  { dow: 4, short: "J" },
  { dow: 5, short: "V" },
  { dow: 6, short: "S" },
];

export function CreateSeriesModal({
  studioId,
  timezone,
  templates,
  members,
  onClose,
  onDone,
}: {
  studioId: string;
  timezone: string;
  templates: ClassTemplateDto[];
  members: StaffInstructorDto[];
  onClose: () => void;
  onDone: () => void;
}) {
  const safeTemplates = useMemo(() => (Array.isArray(templates) ? templates : []), [templates]);
  const [templateId, setTemplateId] = useState(safeTemplates[0]?.id ?? "");
  const [instructorId, setInstructorId] = useState(safeTemplates[0]?.defaultInstructorId ?? "");
  const [capacity, setCapacity] = useState(String(safeTemplates[0]?.defaultCapacity ?? 10));
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [startTime, setStartTime] = useState("07:00");
  const [frequencyMode, setFrequencyMode] = useState<RecurrenceFrequencyMode>("weekly");
  const [customInterval, setCustomInterval] = useState("3");
  const [startsOn, setStartsOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [vigenciaMode, setVigenciaMode] = useState<SeriesVigenciaMode>("never");
  const [endsOn, setEndsOn] = useState("");
  const [preview, setPreview] = useState<SeriesPreviewResult | null>(null);
  const [step, setStep] = useState<"form" | "preview">("form");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedTemplate = safeTemplates.find((t) => t.id === templateId) ?? null;
  const intervalWeeks = intervalWeeksFromMode(frequencyMode, customInterval);

  useEffect(() => {
    if (!selectedTemplate) return;
    setCapacity(String(selectedTemplate.defaultCapacity));
    setInstructorId(selectedTemplate.defaultInstructorId ?? "");
  }, [selectedTemplate]);

  const previewPayload = useMemo(
    () => ({
      classTemplateId: templateId,
      instructorId: instructorId || null,
      capacity: parseInt(capacity, 10),
      daysOfWeek: [dayOfWeek],
      startTime,
      intervalWeeks,
      startsOn,
      endsOn: vigenciaMode === "date" ? endsOn : null,
    }),
    [capacity, dayOfWeek, endsOn, instructorId, intervalWeeks, startTime, startsOn, templateId, vigenciaMode],
  );

  const handlePreview = async () => {
    setError(null);
    setSaving(true);
    try {
      const result = await previewRecurringSeries(studioId, previewPayload);
      setPreview(result);
      setStep("preview");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo generar la vista previa");
    } finally {
      setSaving(false);
    }
  };

  const handleCreate = async () => {
    setError(null);
    setSaving(true);
    try {
      const result = preview ?? (await previewRecurringSeries(studioId, previewPayload));
      if (result.blockingConflictCount > 0) {
        setError(`${result.blockingConflictCount} conflictos bloqueantes.`);
        return;
      }
      await createRecurringSeries(studioId, { ...previewPayload, confirmWarnings: true });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo crear la serie");
    } finally {
      setSaving(false);
    }
  };

  const weekdayLabel = WEEKDAY_PILLS.find((p) => p.dow === dayOfWeek)?.short ?? "—";

  return (
    <div className={adminModalOverlay} onClick={onClose}>
      <div className={`${adminModalPanel} max-w-lg`} onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-zinc-900">Nueva serie</h2>

        {step === "form" ? (
          <form
            className="mt-4 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void handlePreview();
            }}
          >
            <label className="block text-sm">
              <span className="text-zinc-600">Clase</span>
              <select
                className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2"
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
              >
                {safeTemplates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
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

            <div className="grid grid-cols-2 gap-3">
              <label className="block text-sm">
                <span className="text-zinc-600">Día</span>
                <select
                  className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2"
                  value={dayOfWeek}
                  onChange={(e) => setDayOfWeek(parseInt(e.target.value, 10))}
                >
                  {WEEKDAY_PILLS.map((p) => (
                    <option key={p.dow} value={p.dow}>
                      {p.short}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <span className="text-zinc-600">Hora de inicio</span>
                <input
                  type="time"
                  className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                />
              </label>
            </div>

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

            <label className="block text-sm">
              <span className="text-zinc-600">Inicio</span>
              <input
                type="date"
                className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2"
                value={startsOn}
                onChange={(e) => setStartsOn(e.target.value)}
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

            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className={adminSecondaryBtn} onClick={onClose}>
                Cancelar
              </button>
              <button type="submit" className={adminPrimaryBtn} disabled={saving || !templateId}>
                {saving ? "Generando…" : "Vista previa"}
              </button>
            </div>
          </form>
        ) : (
          <div className="mt-4 space-y-4">
            <p className="text-sm font-medium text-zinc-800">Esta serie creará:</p>
            <div className="rounded-xl border border-zinc-100 bg-zinc-50 px-4 py-3 text-sm">
              <p className="font-semibold text-zinc-900">{selectedTemplate?.name}</p>
              <p className="mt-1 text-zinc-600">
                {weekdayLabel} · {startTime}
              </p>
              <p className="text-zinc-600">{formatFrequency(intervalWeeks)}</p>
              <p className="text-zinc-600">
                Desde {formatLocalDateShort(startsOn, timezone)}
                {vigenciaMode === "date" && endsOn
                  ? ` · Hasta ${formatLocalDateShort(endsOn, timezone)}`
                  : " · Sin fecha de fin"}
              </p>
              {preview ? (
                <p className="mt-2 text-zinc-700">{preview.classCount} clases iniciales</p>
              ) : null}
            </div>
            {error ? <p className="text-sm text-red-700">{error}</p> : null}
            <div className="flex justify-end gap-2">
              <button type="button" className={adminSecondaryBtn} onClick={() => setStep("form")}>
                Atrás
              </button>
              <button type="button" className={adminPrimaryBtn} disabled={saving} onClick={() => void handleCreate()}>
                {saving ? "Creando…" : "Crear serie"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
