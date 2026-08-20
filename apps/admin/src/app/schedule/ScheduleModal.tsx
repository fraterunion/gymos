"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { ApiError } from "@/lib/api/errors";
import { adminModalOverlay, adminModalPanel } from "@/lib/adminSurface";
import {
  cancelScheduledClass,
  createScheduledClass,
  updateScheduledClass,
  type ScheduledClassDto,
} from "@/lib/api/schedule";
import {
  cancelSeriesOccurrence,
  createRecurringSeries,
  editSeriesOccurrence,
  fetchOccurrenceSeriesContext,
  previewCancelOccurrence,
  previewEditOccurrence,
  previewRecurringSeries,
  type MutationImpact,
  type RecurringSeriesContext,
  type SeriesMutationScope,
  type SeriesPreviewResult,
} from "@/lib/api/scheduleSeries";
import type { ClassTemplateDto } from "@/lib/api/classTemplates";
import type { StaffInstructorDto } from "@/lib/api/staff";

const WEEKDAY_LABELS = [
  { dow: 0, short: "D" },
  { dow: 1, short: "L" },
  { dow: 2, short: "M" },
  { dow: 3, short: "X" },
  { dow: 4, short: "J" },
  { dow: 5, short: "V" },
  { dow: 6, short: "S" },
];

type RecurrenceMode = "once" | "weekly" | "custom";

type LocalParts = { date: string; time: string };

export type ScheduleModalState =
  | { type: "closed" }
  | { type: "create"; prefillDate?: string }
  | { type: "edit"; cls: ScheduledClassDto };

function isoToStudioLocalParts(iso: string, tz: string): LocalParts {
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

function defaultLocalStart(tz: string, prefillDate?: string): LocalParts {
  const now = new Date();
  const date =
    prefillDate ??
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  return { date, time: "09:00" };
}

function endFromStartAndDuration(start: LocalParts, durationMinutes: number): LocalParts {
  const [y, m, d] = start.date.split("-").map(Number);
  const [hh, mm] = start.time.split(":").map(Number);
  const ms = Date.UTC(y!, m! - 1, d!, hh!, mm!) + durationMinutes * 60_000;
  const dt = new Date(ms);
  return {
    date: dt.toISOString().slice(0, 10),
    time: `${String(dt.getUTCHours()).padStart(2, "0")}:${String(dt.getUTCMinutes()).padStart(2, "0")}`,
  };
}

/** End time in studio-local space (approximation via UTC parts — API is authoritative). */
function studioLocalEndFromDuration(
  start: LocalParts,
  durationMinutes: number,
  tz: string,
): LocalParts {
  const anchor = new Date(`${start.date}T${start.time}:00`);
  const endMs = anchor.getTime() + durationMinutes * 60_000;
  return isoToStudioLocalParts(new Date(endMs).toISOString(), tz);
}

type ScopePrompt = {
  kind: "edit" | "cancel";
  scope: SeriesMutationScope;
  impact?: MutationImpact;
};

export function ScheduleModal({
  modal,
  templates,
  members,
  studioId,
  timezone,
  onClose,
  onDone,
}: {
  modal: Exclude<ScheduleModalState, { type: "closed" }>;
  templates: ClassTemplateDto[];
  members: StaffInstructorDto[];
  studioId: string;
  timezone: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const safeTemplates = useMemo(() => (Array.isArray(templates) ? templates : []), [templates]);
  const safeMembers = useMemo(() => (Array.isArray(members) ? members : []), [members]);
  const hasTemplates = safeTemplates.length > 0;

  const [templateId, setTemplateId] = useState(safeTemplates[0]?.id ?? "");
  const [localStart, setLocalStart] = useState<LocalParts>(() =>
    defaultLocalStart(timezone, modal.type === "create" ? modal.prefillDate : undefined),
  );
  const [localEnd, setLocalEnd] = useState<LocalParts>(() => {
    const tpl = safeTemplates[0];
    const start = defaultLocalStart(timezone, modal.type === "create" ? modal.prefillDate : undefined);
    return tpl ? studioLocalEndFromDuration(start, tpl.durationMinutes, timezone) : start;
  });
  const [capacity, setCapacity] = useState(String(safeTemplates[0]?.defaultCapacity ?? 10));
  const [instructorId, setInstructorId] = useState(safeTemplates[0]?.defaultInstructorId ?? "");

  const [recurrenceMode, setRecurrenceMode] = useState<RecurrenceMode>("once");
  const [intervalWeeks, setIntervalWeeks] = useState("1");
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>(() => {
    const start = defaultLocalStart(timezone, modal.type === "create" ? modal.prefillDate : undefined);
    const [y, m, d] = start.date.split("-").map(Number);
    return [new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()];
  });
  const [seriesStartsOn, setSeriesStartsOn] = useState(
    modal.type === "create" && modal.prefillDate ? modal.prefillDate : defaultLocalStart(timezone).date,
  );
  const [seriesEndsMode, setSeriesEndsMode] = useState<"date" | "never">("never");
  const [seriesEndsOn, setSeriesEndsOn] = useState("");

  const [seriesContext, setSeriesContext] = useState<RecurringSeriesContext | null>(null);
  const [createPreview, setCreatePreview] = useState<SeriesPreviewResult | null>(null);
  const [scopePrompt, setScopePrompt] = useState<ScopePrompt | null>(null);
  const [pendingEditScope, setPendingEditScope] = useState<SeriesMutationScope>("SINGLE");

  const [saving, setSaving] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const didInit = useRef(false);

  useEffect(() => {
    if (modal.type !== "edit") return;
    const parts = isoToStudioLocalParts(modal.cls.startsAt, timezone);
    const endParts = isoToStudioLocalParts(modal.cls.endsAt, timezone);
    setLocalStart(parts);
    setLocalEnd(endParts);
    setCapacity(String(modal.cls.capacity));
    setInstructorId(modal.cls.instructorId ?? "");
    void fetchOccurrenceSeriesContext(studioId, modal.cls.id)
      .then(setSeriesContext)
      .catch(() => setSeriesContext({ isRecurring: false }));
  }, [modal, studioId, timezone]);

  useEffect(() => {
    if (modal.type !== "create" || didInit.current || safeTemplates.length === 0) return;
    didInit.current = true;
    const first = safeTemplates[0]!;
    setTemplateId(first.id);
    setCapacity(String(first.defaultCapacity));
    setInstructorId(first.defaultInstructorId ?? "");
    const start = defaultLocalStart(timezone, modal.type === "create" ? modal.prefillDate : undefined);
    setLocalStart(start);
    setLocalEnd(studioLocalEndFromDuration(start, first.durationMinutes, timezone));
    const [y, m, d] = start.date.split("-").map(Number);
    setDaysOfWeek([new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()]);
    if (modal.type === "create" && modal.prefillDate) {
      setSeriesStartsOn(modal.prefillDate);
    }
  }, [modal, safeTemplates, timezone]);

  const selectedTemplate = safeTemplates.find((t) => t.id === templateId) ?? null;
  const isRecurringEdit = modal.type === "edit" && (seriesContext?.isRecurring ?? !!modal.cls.scheduleTemplateId);
  const isCancelled = modal.type === "edit" && modal.cls.status === "CANCELLED";

  const handleTemplateChange = (nextId: string) => {
    setTemplateId(nextId);
    const tpl = safeTemplates.find((t) => t.id === nextId);
    if (tpl) {
      setCapacity(String(tpl.defaultCapacity));
      setInstructorId(tpl.defaultInstructorId ?? "");
      setLocalEnd(studioLocalEndFromDuration(localStart, tpl.durationMinutes, timezone));
    }
  };

  const handleStartChange = (next: LocalParts) => {
    setLocalStart(next);
    if (selectedTemplate) {
      setLocalEnd(studioLocalEndFromDuration(next, selectedTemplate.durationMinutes, timezone));
    }
    const [y, m, d] = next.date.split("-").map(Number);
    const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
    if (recurrenceMode !== "once" && daysOfWeek.length <= 1) {
      setDaysOfWeek([dow]);
    }
  };

  const toggleDay = (dow: number) => {
    setDaysOfWeek((prev) =>
      prev.includes(dow) ? prev.filter((d) => d !== dow) : [...prev, dow].sort(),
    );
  };

  const buildLocalPayload = () => ({
    localStart: { date: localStart.date, time: localStart.time },
    localEnd: { date: localEnd.date, time: localEnd.time },
    capacity: parseInt(capacity, 10),
    instructorId: instructorId || null,
  });

  const runCreatePreview = async () => {
    setError(null);
    const preview = await previewRecurringSeries(studioId, {
      classTemplateId: templateId,
      instructorId: instructorId || null,
      capacity: parseInt(capacity, 10),
      daysOfWeek,
      startTime: localStart.time,
      intervalWeeks: parseInt(intervalWeeks, 10) || 1,
      startsOn: seriesStartsOn,
      endsOn: seriesEndsMode === "date" ? seriesEndsOn : null,
    });
    setCreatePreview(preview);
    return preview;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      if (modal.type === "create") {
        if (recurrenceMode === "once") {
          await createScheduledClass(studioId, {
            templateId,
            ...buildLocalPayload(),
          });
          onDone();
          return;
        }

        const preview = createPreview ?? (await runCreatePreview());
        if (preview.blockingConflictCount > 0) {
          setError(`${preview.blockingConflictCount} conflictos bloqueantes. Revisa antes de continuar.`);
          return;
        }
        if (preview.warningConflictCount > 0) {
          const ok = window.confirm(
            `${preview.warningConflictCount} advertencias encontradas. ¿Programar de todos modos?`,
          );
          if (!ok) return;
        }

        await createRecurringSeries(studioId, {
          classTemplateId: templateId,
          instructorId: instructorId || null,
          capacity: parseInt(capacity, 10),
          daysOfWeek,
          startTime: localStart.time,
          intervalWeeks: parseInt(intervalWeeks, 10) || 1,
          startsOn: seriesStartsOn,
          endsOn: seriesEndsMode === "date" ? seriesEndsOn : null,
          confirmWarnings: true,
        });
        onDone();
        return;
      }

      // Edit standalone (non-recurring)
      if (!isRecurringEdit) {
        await updateScheduledClass(studioId, modal.cls.id, buildLocalPayload());
        onDone();
        return;
      }

      // Recurring — ask scope first if not yet chosen
      if (!scopePrompt || scopePrompt.kind !== "edit") {
        setPendingEditScope("SINGLE");
        setScopePrompt({ kind: "edit", scope: "SINGLE" });
        return;
      }

      const scope = pendingEditScope;
      const preview = await previewEditOccurrence(studioId, modal.cls.id, {
        scope,
        ...buildLocalPayload(),
      });
      if (preview.impact.totalReservations > 0) {
        const ok = window.confirm(
          `${preview.impact.affectedClassCount} clases · ${preview.impact.totalReservations} reservaciones afectadas. ¿Continuar?`,
        );
        if (!ok) return;
      }

      await editSeriesOccurrence(studioId, modal.cls.id, {
        scope,
        ...buildLocalPayload(),
        confirmReservations: true,
      });
      onDone();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("No se pudo guardar. Intenta de nuevo.");
      }
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = async (scope: SeriesMutationScope = "SINGLE") => {
    if (modal.type !== "edit") return;
    setCancelling(true);
    setError(null);
    try {
      if (isRecurringEdit) {
        const impact = await previewCancelOccurrence(studioId, modal.cls.id, scope);
        if (impact.totalReservations > 0) {
          const ok = window.confirm(
            `${impact.affectedClassCount} clases serán canceladas · ${impact.totalReservations} reservaciones afectadas. ¿Continuar?`,
          );
          if (!ok) return;
        }
        await cancelSeriesOccurrence(studioId, modal.cls.id, {
          scope,
          cancelReason: cancelReason.trim() || undefined,
          confirmReservations: true,
        });
      } else {
        await cancelScheduledClass(studioId, modal.cls.id, cancelReason.trim() || undefined);
      }
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo cancelar la clase");
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className={adminModalOverlay} onClick={onClose}>
      <div className={adminModalPanel} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-zinc-900">
            {modal.type === "edit" ? "Editar clase" : "Programar clase"}
          </h2>
          {isCancelled ? (
            <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-700">
              Cancelada
            </span>
          ) : null}
        </div>

        {modal.type === "edit" && isRecurringEdit && seriesContext?.label ? (
          <div className="mt-3 rounded-lg border border-indigo-100 bg-indigo-50 px-3 py-2 text-xs text-indigo-900">
            <p className="font-semibold uppercase tracking-wide">Pertenece a una serie</p>
            <p className="mt-0.5">{seriesContext.label}</p>
          </div>
        ) : null}

        {showCancelConfirm ? (
          <div className="mt-5 space-y-4">
            {isRecurringEdit ? (
              <div className="space-y-2">
                <p className="text-sm font-medium text-zinc-800">Cancelar:</p>
                {(["SINGLE", "FOLLOWING", "SERIES"] as SeriesMutationScope[]).map((scope) => (
                  <label key={scope} className="flex items-center gap-2 text-sm text-zinc-700">
                    <input
                      type="radio"
                      name="cancelScope"
                      checked={scopePrompt?.scope === scope}
                      onChange={() => setScopePrompt({ kind: "cancel", scope })}
                    />
                    {scope === "SINGLE"
                      ? "Solo esta clase"
                      : scope === "FOLLOWING"
                      ? "Esta y las siguientes"
                      : "Toda la serie"}
                  </label>
                ))}
              </div>
            ) : (
              <p className="text-sm text-zinc-600">
                ¿Cancelar esta clase? Las reservaciones se verán afectadas.
              </p>
            )}
            <div>
              <label className="block text-xs font-medium text-zinc-700">Motivo (opcional)</label>
              <input
                type="text"
                maxLength={2000}
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm"
              />
            </div>
            {error ? <p className="text-sm text-amber-800">{error}</p> : null}
            <div className="flex justify-end gap-3">
              <button type="button" onClick={() => setShowCancelConfirm(false)} className="rounded-lg border px-4 py-2 text-sm">
                Volver
              </button>
              <button
                type="button"
                disabled={cancelling}
                onClick={() => void handleCancel(scopePrompt?.scope ?? "SINGLE")}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm text-white disabled:opacity-50"
              >
                {cancelling ? "Cancelando…" : "Confirmar cancelación"}
              </button>
            </div>
          </div>
        ) : modal.type === "create" && !hasTemplates ? (
          <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm font-medium text-amber-900">Sin tipos de clase</p>
            <Link href="/classes" className="mt-2 inline-block text-sm font-semibold text-amber-700 underline">
              Crear tipo de clase
            </Link>
          </div>
        ) : scopePrompt?.kind === "edit" && modal.type === "edit" ? (
          <div className="mt-5 space-y-4">
            <p className="text-sm font-medium text-zinc-800">¿Qué quieres modificar?</p>
            {(["SINGLE", "FOLLOWING", "SERIES"] as SeriesMutationScope[]).map((scope) => (
              <label key={scope} className="flex items-center gap-2 text-sm text-zinc-700">
                <input
                  type="radio"
                  name="editScope"
                  checked={pendingEditScope === scope}
                  onChange={() => setPendingEditScope(scope)}
                />
                {scope === "SINGLE"
                  ? "Solo esta clase"
                  : scope === "FOLLOWING"
                  ? "Esta y las siguientes"
                  : "Toda la serie"}
              </label>
            ))}
            <div className="flex justify-end gap-3">
              <button type="button" onClick={() => setScopePrompt(null)} className="rounded-lg border px-4 py-2 text-sm">
                Volver
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={(e) => {
                  setScopePrompt({ kind: "edit", scope: pendingEditScope });
                  void handleSubmit(e as unknown as React.FormEvent);
                }}
                className="rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50"
              >
                {saving ? "Guardando…" : "Continuar"}
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={(e) => void handleSubmit(e)} className="mt-5 space-y-4">
            {modal.type === "create" ? (
              <div>
                <label className="block text-xs font-medium text-zinc-700">Tipo de clase</label>
                <select
                  required
                  value={templateId}
                  onChange={(e) => handleTemplateChange(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm"
                >
                  {safeTemplates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} · {t.durationMinutes} min
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div>
                <p className="text-xs font-medium text-zinc-500">Tipo de clase</p>
                <p className="text-sm font-medium text-zinc-900">{modal.cls.classTemplate.name}</p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-zinc-700">Fecha</label>
                <input
                  type="date"
                  required
                  value={localStart.date}
                  onChange={(e) => handleStartChange({ ...localStart, date: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-700">Hora inicio</label>
                <input
                  type="time"
                  required
                  value={localStart.time}
                  onChange={(e) => handleStartChange({ ...localStart, time: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-zinc-700">Hora fin</label>
                <input
                  type="time"
                  required
                  value={localEnd.time}
                  onChange={(e) => setLocalEnd({ ...localEnd, time: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-700">Capacidad</label>
                <input
                  type="number"
                  required
                  min={1}
                  value={capacity}
                  onChange={(e) => setCapacity(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-700">Instructor (opcional)</label>
              <select
                value={instructorId}
                onChange={(e) => setInstructorId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm"
              >
                <option value="">— Ninguno —</option>
                {safeMembers.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.firstName} {m.lastName}
                  </option>
                ))}
              </select>
            </div>

            {modal.type === "create" ? (
              <div className="space-y-3 rounded-xl border border-zinc-100 bg-zinc-50 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-zinc-600">Repetición</p>
                <div className="flex flex-wrap gap-3 text-sm">
                  {(
                    [
                      ["once", "Solo esta vez"],
                      ["weekly", "Semanal"],
                      ["custom", "Personalizada"],
                    ] as const
                  ).map(([mode, label]) => (
                    <label key={mode} className="flex items-center gap-1.5">
                      <input
                        type="radio"
                        name="recurrence"
                        checked={recurrenceMode === mode}
                        onChange={() => setRecurrenceMode(mode)}
                      />
                      {label}
                    </label>
                  ))}
                </div>

                {recurrenceMode !== "once" ? (
                  <>
                    <div className="flex items-center gap-2 text-sm">
                      <span>Repetir cada</span>
                      <input
                        type="number"
                        min={1}
                        max={52}
                        value={intervalWeeks}
                        onChange={(e) => setIntervalWeeks(e.target.value)}
                        className="w-14 rounded border px-2 py-1"
                        disabled={recurrenceMode === "weekly"}
                      />
                      <span>semana(s)</span>
                    </div>
                    <div className="flex gap-1">
                      {WEEKDAY_LABELS.map(({ dow, short }) => (
                        <button
                          key={dow}
                          type="button"
                          onClick={() => toggleDay(dow)}
                          className={`h-8 w-8 rounded-full text-xs font-semibold ${
                            daysOfWeek.includes(dow)
                              ? "bg-zinc-900 text-white"
                              : "bg-white text-zinc-500 ring-1 ring-zinc-200"
                          }`}
                        >
                          {short}
                        </button>
                      ))}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs text-zinc-600">Desde</label>
                        <input
                          type="date"
                          value={seriesStartsOn}
                          onChange={(e) => setSeriesStartsOn(e.target.value)}
                          className="mt-1 w-full rounded border px-2 py-1 text-sm"
                        />
                      </div>
                      <div>
                        <p className="text-xs text-zinc-600">Termina</p>
                        <label className="mt-1 flex items-center gap-2 text-sm">
                          <input
                            type="radio"
                            checked={seriesEndsMode === "date"}
                            onChange={() => setSeriesEndsMode("date")}
                          />
                          <input
                            type="date"
                            value={seriesEndsOn}
                            disabled={seriesEndsMode !== "date"}
                            onChange={(e) => setSeriesEndsOn(e.target.value)}
                            className="rounded border px-2 py-1 text-sm"
                          />
                        </label>
                        <label className="mt-1 flex items-center gap-2 text-sm">
                          <input
                            type="radio"
                            checked={seriesEndsMode === "never"}
                            onChange={() => setSeriesEndsMode("never")}
                          />
                          Sin fecha de finalización
                        </label>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void runCreatePreview().catch(() => setError("No se pudo generar vista previa"))}
                      className="text-xs font-semibold text-indigo-700 underline"
                    >
                      Vista previa
                    </button>
                    {createPreview ? (
                      <div className="rounded-lg border border-indigo-100 bg-white p-2 text-xs text-zinc-700">
                        <p className="font-semibold">{createPreview.classCount} clases serán programadas.</p>
                        {createPreview.blockingConflictCount > 0 ? (
                          <p className="mt-1 text-red-700">
                            {createPreview.blockingConflictCount} conflictos bloqueantes
                          </p>
                        ) : null}
                        {createPreview.warningConflictCount > 0 ? (
                          <p className="mt-1 text-amber-700">
                            {createPreview.warningConflictCount} advertencias
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}

            {error ? <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{error}</p> : null}

            <div className="flex items-center justify-between gap-3 pt-1">
              <div>
                {modal.type === "edit" && !isCancelled ? (
                  <button
                    type="button"
                    onClick={() => {
                      setShowCancelConfirm(true);
                      if (isRecurringEdit) {
                        setScopePrompt({ kind: "cancel", scope: "SINGLE" });
                      }
                    }}
                    className="rounded-lg px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
                  >
                    Cancelar clase
                  </button>
                ) : null}
              </div>
              <div className="flex gap-3">
                <button type="button" onClick={onClose} className="rounded-lg border px-4 py-2 text-sm">
                  Cerrar
                </button>
                {!isCancelled ? (
                  <button
                    type="submit"
                    disabled={saving || (modal.type === "create" && !templateId)}
                    className="rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50"
                  >
                    {saving ? "Guardando…" : modal.type === "create" ? "Programar" : "Guardar cambios"}
                  </button>
                ) : null}
              </div>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
