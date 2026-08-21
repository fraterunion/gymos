"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiError } from "@/lib/api/errors";
import { adminModalOverlay, adminModalPanel, adminPrimaryBtn, adminSecondaryBtn } from "@/lib/adminSurface";
import type { ScheduledClassDto } from "@/lib/api/schedule";
import type { StaffInstructorDto } from "@/lib/api/staff";
import {
  executeBulkOperation,
  executeDuplicateClass,
  executeDuplicateWeek,
  newIdempotencyKey,
  previewBulkOperation,
  previewDuplicateClass,
  previewDuplicateWeek,
  type BulkOperation,
  type ScheduleOperationResult,
} from "@/lib/api/scheduleOperations";
import { shiftDateKey } from "@/lib/operationalSchedule";

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

function weekLabel(startKey: string, tz: string): string {
  const endKey = shiftDateKey(startKey, 6);
  const fmt = (key: string) =>
    new Intl.DateTimeFormat("es-MX", { timeZone: tz, day: "numeric", month: "short" }).format(
      new Date(`${key}T12:00:00Z`),
    );
  return `${fmt(startKey)} – ${fmt(endKey)}`;
}

function PreviewSummary({ preview }: { preview: ScheduleOperationResult | null }) {
  if (!preview) return null;

  const instructorWarnings = preview.conflicts.filter(
    (c) => c.kind === "INSTRUCTOR_OVERLAP" && c.severity === "WARNING",
  ).length;
  const hardBlocks = preview.conflicts.filter(
    (c) => c.severity === "BLOCKING" && c.kind !== "DUPLICATE_OCCURRENCE",
  ).length;

  return (
    <div className="mt-4 space-y-2 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700">
      <p>
        <span className="font-semibold">{preview.proposedCount}</span> sesiones propuestas
      </p>
      <ul className="space-y-1 text-sm">
        <li>
          <span className="font-semibold text-emerald-700">{preview.createdCount}</span> se crearán
        </li>
        {preview.skippedAlreadyExistsCount > 0 ? (
          <li>
            <span className="font-semibold text-zinc-600">{preview.skippedAlreadyExistsCount}</span>{" "}
            ya existen — se omitirán
          </li>
        ) : null}
        {instructorWarnings > 0 ? (
          <li>
            <span className="font-semibold text-amber-700">{instructorWarnings}</span> conflictos de
            instructor — revisar
          </li>
        ) : null}
        {hardBlocks > 0 ? (
          <li>
            <span className="font-semibold text-red-700">{hardBlocks}</span> bloqueadas
          </li>
        ) : null}
      </ul>
      {preview.affectedReservationCount > 0 ? (
        <p className="text-amber-800">
          {preview.affectedReservationCount} reservas afectadas
        </p>
      ) : null}
      {hardBlocks > 0 || instructorWarnings > 0 ? (
        <ul className="max-h-32 overflow-y-auto text-xs text-zinc-600">
          {preview.conflicts
            .filter((c) => c.kind !== "DUPLICATE_OCCURRENCE")
            .slice(0, 8)
            .map((c, i) => (
              <li key={i}>
                [{c.severity === "WARNING" ? "Aviso" : "Bloqueo"}] {c.message}
              </li>
            ))}
        </ul>
      ) : null}
    </div>
  );
}

export function DuplicateWeekModal({
  studioId,
  sourceWeekStart,
  timezone,
  onClose,
  onDone,
}: {
  studioId: string;
  sourceWeekStart: string;
  timezone: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [repeatWeeks, setRepeatWeeks] = useState(4);
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(() => new Set());
  const [preview, setPreview] = useState<ScheduleOperationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmWarnings, setConfirmWarnings] = useState(false);

  const futureWeeks = useMemo(() => {
    const out: string[] = [];
    let cursor = shiftDateKey(sourceWeekStart, 7);
    for (let i = 0; i < 12; i++) {
      out.push(cursor);
      cursor = shiftDateKey(cursor, 7);
    }
    return out;
  }, [sourceWeekStart]);

  useEffect(() => {
    setSelectedTargets(new Set(futureWeeks.slice(0, repeatWeeks)));
  }, [futureWeeks, repeatWeeks]);

  const targetWeekStarts = useMemo(() => [...selectedTargets].sort(), [selectedTargets]);

  const runPreview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const p = await previewDuplicateWeek(studioId, {
        sourceWeekStart,
        targetWeekStarts,
      });
      setPreview(p);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo obtener la vista previa");
    } finally {
      setLoading(false);
    }
  }, [sourceWeekStart, studioId, targetWeekStarts]);

  useEffect(() => {
    if (targetWeekStarts.length === 0) return;
    const t = setTimeout(() => void runPreview(), 200);
    return () => clearTimeout(t);
  }, [runPreview, targetWeekStarts]);

  async function handleExecute() {
    setLoading(true);
    setError(null);
    try {
      await executeDuplicateWeek(studioId, {
        sourceWeekStart,
        targetWeekStarts,
        confirmWarnings,
        idempotencyKey: newIdempotencyKey(),
      });
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.body && typeof e.body === "object") {
        const body = e.body as { requiresConfirmation?: boolean };
        if (body.requiresConfirmation) {
          setConfirmWarnings(true);
          setError("Hay advertencias. Confirma para continuar.");
          setLoading(false);
          return;
        }
      }
      setError(e instanceof ApiError ? e.message : "No se pudo duplicar la semana");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={adminModalOverlay}>
      <div className={`${adminModalPanel} max-w-lg`}>
        <h2 className="text-lg font-semibold text-zinc-900">Duplicar esta semana</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Origen: <span className="font-medium text-zinc-800">{weekLabel(sourceWeekStart, timezone)}</span>
        </p>

        <div className="mt-4">
          <label className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Repetir durante
          </label>
          <div className="mt-1 flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={12}
              value={repeatWeeks}
              onChange={(e) => setRepeatWeeks(Number(e.target.value))}
              className="w-16 rounded-lg border border-zinc-200 px-2 py-1.5 text-sm"
            />
            <span className="text-sm text-zinc-600">semanas</span>
          </div>
        </div>

        <div className="mt-4 max-h-48 space-y-1 overflow-y-auto">
          {futureWeeks.map((wk) => (
            <label key={wk} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-zinc-50">
              <input
                type="checkbox"
                checked={selectedTargets.has(wk)}
                onChange={(e) => {
                  setSelectedTargets((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(wk);
                    else next.delete(wk);
                    return next;
                  });
                }}
              />
              <span className="text-sm text-zinc-700">{weekLabel(wk, timezone)}</span>
            </label>
          ))}
        </div>

        <PreviewSummary preview={preview} />
        {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}

        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={adminSecondaryBtn} disabled={loading}>
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => void handleExecute()}
            className={adminPrimaryBtn}
            disabled={loading || targetWeekStarts.length === 0}
          >
            {loading ? "Procesando…" : confirmWarnings ? "Confirmar y duplicar" : "Duplicar"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function DuplicateClassModal({
  studioId,
  cls,
  timezone,
  instructors,
  onClose,
  onDone,
}: {
  studioId: string;
  cls: ScheduledClassDto;
  timezone: string;
  instructors: StaffInstructorDto[];
  onClose: () => void;
  onDone: () => void;
}) {
  const start = isoToLocalParts(cls.startsAt, timezone);
  const end = isoToLocalParts(cls.endsAt, timezone);
  const [localStart, setLocalStart] = useState(start);
  const [localEnd, setLocalEnd] = useState(end);
  const [capacity, setCapacity] = useState(cls.capacity);
  const [instructorId, setInstructorId] = useState(cls.instructorId ?? "");
  const [preview, setPreview] = useState<ScheduleOperationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmWarnings, setConfirmWarnings] = useState(false);

  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const p = await previewDuplicateClass(studioId, cls.id, {
          localStart,
          localEnd,
          capacity,
          instructorId: instructorId || null,
        });
        setPreview(p);
      } catch {
        setPreview(null);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [capacity, cls.id, instructorId, localEnd, localStart, studioId]);

  async function handleExecute() {
    setLoading(true);
    setError(null);
    try {
      await executeDuplicateClass(studioId, cls.id, {
        localStart,
        localEnd,
        capacity,
        instructorId: instructorId || null,
        confirmWarnings,
        idempotencyKey: newIdempotencyKey(),
      });
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.body && typeof e.body === "object") {
        const body = e.body as { requiresConfirmation?: boolean };
        if (body.requiresConfirmation) {
          setConfirmWarnings(true);
          setError("Hay advertencias. Confirma para continuar.");
          setLoading(false);
          return;
        }
      }
      setError(e instanceof ApiError ? e.message : "No se pudo duplicar la clase");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={adminModalOverlay}>
      <div className={`${adminModalPanel} max-w-md`}>
        <h2 className="text-lg font-semibold text-zinc-900">Duplicar clase</h2>
        <p className="mt-1 text-sm text-zinc-500">{cls.classTemplate.name}</p>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <label className="text-xs text-zinc-500">
            Fecha
            <input
              type="date"
              value={localStart.date}
              onChange={(e) => setLocalStart((s) => ({ ...s, date: e.target.value }))}
              className="mt-1 w-full rounded-lg border border-zinc-200 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="text-xs text-zinc-500">
            Inicio
            <input
              type="time"
              value={localStart.time}
              onChange={(e) => setLocalStart((s) => ({ ...s, time: e.target.value }))}
              className="mt-1 w-full rounded-lg border border-zinc-200 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="text-xs text-zinc-500">
            Fin
            <input
              type="time"
              value={localEnd.time}
              onChange={(e) => setLocalEnd((s) => ({ ...s, time: e.target.value }))}
              className="mt-1 w-full rounded-lg border border-zinc-200 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="text-xs text-zinc-500">
            Capacidad
            <input
              type="number"
              min={1}
              value={capacity}
              onChange={(e) => setCapacity(Number(e.target.value))}
              className="mt-1 w-full rounded-lg border border-zinc-200 px-2 py-1.5 text-sm"
            />
          </label>
        </div>

        <label className="mt-3 block text-xs text-zinc-500">
          Instructor
          <select
            value={instructorId}
            onChange={(e) => setInstructorId(e.target.value)}
            className="mt-1 w-full rounded-lg border border-zinc-200 px-2 py-1.5 text-sm"
          >
            <option value="">Sin instructor</option>
            {instructors.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.firstName} {m.lastName}
              </option>
            ))}
          </select>
        </label>

        <PreviewSummary preview={preview} />
        {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}

        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={adminSecondaryBtn} disabled={loading}>
            Cancelar
          </button>
          <button type="button" onClick={() => void handleExecute()} className={adminPrimaryBtn} disabled={loading}>
            {loading ? "Creando…" : "Duplicar clase"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function BulkActionModal({
  studioId,
  selectedIds,
  operation,
  instructors,
  onClose,
  onDone,
}: {
  studioId: string;
  selectedIds: string[];
  operation: BulkOperation;
  instructors: StaffInstructorDto[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [instructorId, setInstructorId] = useState("");
  const [capacity, setCapacity] = useState(12);
  const [timeDeltaMinutes, setTimeDeltaMinutes] = useState(30);
  const [cancelReason, setCancelReason] = useState("");
  const [weekOffsetWeeks, setWeekOffsetWeeks] = useState(1);
  const [preview, setPreview] = useState<ScheduleOperationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmWarnings, setConfirmWarnings] = useState(false);
  const [confirmReservations, setConfirmReservations] = useState(false);

  const title = useMemo(() => {
    switch (operation) {
      case "CHANGE_INSTRUCTOR":
        return "Cambiar instructor";
      case "CHANGE_CAPACITY":
        return "Cambiar capacidad";
      case "MOVE_TIME":
        return "Mover horario";
      case "CANCEL":
        return "Cancelar clases";
      case "DUPLICATE":
        return "Duplicar clases";
      default:
        return "Acción masiva";
    }
  }, [operation]);

  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const p = await previewBulkOperation(studioId, {
          scheduledClassIds: selectedIds,
          operation,
          instructorId: instructorId || undefined,
          capacity: operation === "CHANGE_CAPACITY" ? capacity : undefined,
          timeDeltaMinutes: operation === "MOVE_TIME" ? timeDeltaMinutes : undefined,
          weekOffsetWeeks: operation === "DUPLICATE" ? weekOffsetWeeks : undefined,
        });
        setPreview(p);
      } catch {
        setPreview(null);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [capacity, instructorId, operation, selectedIds, studioId, timeDeltaMinutes, weekOffsetWeeks]);

  async function handleExecute() {
    setLoading(true);
    setError(null);
    try {
      await executeBulkOperation(studioId, {
        scheduledClassIds: selectedIds,
        operation,
        instructorId: instructorId || undefined,
        capacity: operation === "CHANGE_CAPACITY" ? capacity : undefined,
        timeDeltaMinutes: operation === "MOVE_TIME" ? timeDeltaMinutes : undefined,
        weekOffsetWeeks: operation === "DUPLICATE" ? weekOffsetWeeks : undefined,
        cancelReason: operation === "CANCEL" ? cancelReason : undefined,
        confirmWarnings,
        confirmReservations,
        idempotencyKey: newIdempotencyKey(),
      });
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.body && typeof e.body === "object") {
        const body = e.body as { requiresConfirmation?: boolean; totalReservations?: number };
        if (body.requiresConfirmation) {
          if (preview && preview.affectedReservationCount > 0) setConfirmReservations(true);
          else setConfirmWarnings(true);
          setError("Confirma el impacto en reservas o advertencias antes de continuar.");
          setLoading(false);
          return;
        }
      }
      setError(e instanceof ApiError ? e.message : "No se pudo completar la operación");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={adminModalOverlay}>
      <div className={`${adminModalPanel} max-w-md`}>
        <h2 className="text-lg font-semibold text-zinc-900">{title}</h2>
        <p className="mt-1 text-sm text-zinc-500">{selectedIds.length} clases seleccionadas</p>

        {operation === "CHANGE_INSTRUCTOR" ? (
          <select
            value={instructorId}
            onChange={(e) => setInstructorId(e.target.value)}
            className="mt-4 w-full rounded-lg border border-zinc-200 px-2 py-2 text-sm"
          >
            <option value="">Seleccionar instructor</option>
            {instructors.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.firstName} {m.lastName}
              </option>
            ))}
          </select>
        ) : null}

        {operation === "CHANGE_CAPACITY" ? (
          <input
            type="number"
            min={1}
            value={capacity}
            onChange={(e) => setCapacity(Number(e.target.value))}
            className="mt-4 w-full rounded-lg border border-zinc-200 px-2 py-2 text-sm"
          />
        ) : null}

        {operation === "MOVE_TIME" ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {[15, 30, 60, -15, -30].map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setTimeDeltaMinutes(m)}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
                  timeDeltaMinutes === m
                    ? "border-zinc-900 bg-zinc-900 text-white"
                    : "border-zinc-200 text-zinc-700 hover:bg-zinc-50"
                }`}
              >
                {m > 0 ? "+" : ""}
                {m === 60 ? "1 h" : `${m} min`}
              </button>
            ))}
          </div>
        ) : null}

        {operation === "CANCEL" ? (
          <textarea
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            placeholder="Motivo (opcional)"
            className="mt-4 w-full rounded-lg border border-zinc-200 px-2 py-2 text-sm"
            rows={2}
          />
        ) : null}

        {operation === "DUPLICATE" ? (
          <div className="mt-4 flex items-center gap-2">
            <span className="text-sm text-zinc-600">Desplazar</span>
            <input
              type="number"
              min={1}
              max={12}
              value={weekOffsetWeeks}
              onChange={(e) => setWeekOffsetWeeks(Number(e.target.value))}
              className="w-16 rounded-lg border border-zinc-200 px-2 py-1.5 text-sm"
            />
            <span className="text-sm text-zinc-600">semanas</span>
          </div>
        ) : null}

        <PreviewSummary preview={preview} />
        {confirmReservations ? (
          <p className="mt-2 text-xs font-medium text-amber-800">
            Se afectarán reservas existentes. Esta acción está confirmada.
          </p>
        ) : null}
        {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}

        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={adminSecondaryBtn} disabled={loading}>
            Cancelar
          </button>
          <button type="button" onClick={() => void handleExecute()} className={adminPrimaryBtn} disabled={loading}>
            {loading ? "Aplicando…" : "Confirmar"}
          </button>
        </div>
      </div>
    </div>
  );
}
