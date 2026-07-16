"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PageHeader } from "@/components/shell/PageHeader";
import { SurfaceCard } from "@/components/shell/SurfaceCard";
import { useDeskStudio } from "@/contexts/DeskStudioContext";
import { ApiError } from "@/lib/api/errors";
import {
  adminInput,
  adminModalOverlay,
  adminModalPanel,
  adminPrimaryBtn,
  adminSecondaryBtn,
  adminSelect,
} from "@/lib/adminSurface";
import {
  cancelScheduledClass,
  createScheduledClass,
  fetchStudioSchedule,
  updateScheduledClass,
  type ScheduledClassDto,
} from "@/lib/api/schedule";
import { fetchClassTemplates, type ClassTemplateDto } from "@/lib/api/classTemplates";
import { fetchStaffInstructors, type StaffInstructorDto } from "@/lib/api/staff";
import { calendarDayKeyInZone, todayKeyInZone } from "@/lib/datetime";
import { classRosterHref } from "@/lib/classRosterNav";
import {
  filterOperationalScheduleInWeek,
  mondayStartKeyForInstant,
  studioLocalDateKeyToUtcAnchor,
  studioWeekQueryRangeIso,
  weekBoundsInZone,
  weekDayKeysFromStart,
  weekOffsetFromMondayStartKey,
} from "@/lib/operationalSchedule";

// ── date helpers ──────────────────────────────────────────────────────────────

function toLocalDatetimeString(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

function formatDayHeader(dayKey: string, tz: string): { weekday: string; day: string } {
  const anchor = new Date(`${dayKey}T12:00:00Z`);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(anchor);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, day: "numeric" }).format(anchor);
  return { weekday, day };
}

// ── schedule form ─────────────────────────────────────────────────────────────

type ScheduleFormState = {
  templateId: string;
  startTime: string;
  endTime: string;
  capacity: string;
  instructorId: string;
};

function makeDefaultStart(): string {
  const d = new Date();
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
  return toLocalDatetimeString(d);
}

function makeDefaultEnd(startStr: string, durationMinutes: number): string {
  const d = new Date(startStr);
  d.setMinutes(d.getMinutes() + durationMinutes);
  return toLocalDatetimeString(d);
}

type ScheduleModalState =
  | { type: "closed" }
  | { type: "create"; prefillDate?: string }
  | { type: "edit"; cls: ScheduledClassDto };

function ScheduleModal({
  modal,
  templates,
  members,
  studioId,
  onClose,
  onDone,
}: {
  modal: Exclude<ScheduleModalState, { type: "closed" }>;
  templates: ClassTemplateDto[];
  members: StaffInstructorDto[];
  studioId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  // Defensive: API response shape may differ from expected type at runtime
  const safeTemplates = useMemo(() => Array.isArray(templates) ? templates : [], [templates]);
  const safeMembers = useMemo(() => Array.isArray(members) ? members : [], [members]);
  const hasTemplates = safeTemplates.length > 0;

  const buildCreateDefaults = (): ScheduleFormState => {
    const firstTemplate = safeTemplates[0];
    const startTime = modal.type === "create" && modal.prefillDate
      ? `${modal.prefillDate}T09:00`
      : makeDefaultStart();
    return {
      templateId: firstTemplate?.id ?? "",
      startTime,
      endTime: firstTemplate ? makeDefaultEnd(startTime, firstTemplate.durationMinutes) : startTime,
      capacity: String(firstTemplate?.defaultCapacity ?? 10),
      instructorId: firstTemplate?.defaultInstructorId ?? "",
    };
  };

  const buildEditDefaults = (cls: ScheduledClassDto): ScheduleFormState => ({
    templateId: cls.classTemplateId,
    startTime: toLocalDatetimeString(new Date(cls.startsAt)),
    endTime: toLocalDatetimeString(new Date(cls.endsAt)),
    capacity: String(cls.capacity),
    instructorId: cls.instructorId ?? "",
  });

  const [form, setForm] = useState<ScheduleFormState>(
    modal.type === "edit" ? buildEditDefaults(modal.cls) : buildCreateDefaults(),
  );
  const [saving, setSaving] = useState(false);

  // If the modal opened before templates loaded, templateId will be "".
  // Sync it to the first template once templates arrive.
  const didInitTemplate = useRef(form.templateId !== "");
  useEffect(() => {
    if (modal.type !== "create" || didInitTemplate.current) return;
    if (safeTemplates.length === 0) return;
    didInitTemplate.current = true;
    const first = safeTemplates[0];
    const t = setTimeout(() => {
      setForm((prev) => ({
        ...prev,
        templateId: first.id,
        endTime: makeDefaultEnd(prev.startTime, first.durationMinutes),
        capacity: String(first.defaultCapacity),
        instructorId: first.defaultInstructorId ?? prev.instructorId,
      }));
    }, 0);
    return () => clearTimeout(t);
  }, [safeTemplates, modal.type]);
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedTemplate = safeTemplates.find((t) => t.id === form.templateId) ?? null;

  const handleTemplateChange = (templateId: string) => {
    const tpl = safeTemplates.find((t) => t.id === templateId);
    setForm((prev) => ({
      ...prev,
      templateId,
      endTime: tpl ? makeDefaultEnd(prev.startTime, tpl.durationMinutes) : prev.endTime,
      capacity: tpl ? String(tpl.defaultCapacity) : prev.capacity,
      instructorId: tpl?.defaultInstructorId ?? prev.instructorId,
    }));
  };

  const handleStartChange = (startTime: string) => {
    const tpl = safeTemplates.find((t) => t.id === form.templateId);
    setForm((prev) => ({
      ...prev,
      startTime,
      endTime: tpl ? makeDefaultEnd(startTime, tpl.durationMinutes) : prev.endTime,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const startIso = new Date(form.startTime).toISOString();
      const endIso = new Date(form.endTime).toISOString();
      if (modal.type === "edit") {
        await updateScheduledClass(studioId, modal.cls.id, {
          startTime: startIso,
          endTime: endIso,
          capacity: parseInt(form.capacity, 10),
          instructorId: form.instructorId || null,
        });
      } else {
        await createScheduledClass(studioId, {
          templateId: form.templateId,
          startTime: startIso,
          endTime: endIso,
          capacity: parseInt(form.capacity, 10),
          instructorId: form.instructorId || null,
        });
      }
      onDone();
    } catch (err) {
      if (err instanceof ApiError) {
        // class-validator returns arrays of field messages; collapse to user-friendly text
        const raw = err.message;
        const friendly = raw.includes("templateId")
          ? "Please select a class type before scheduling."
          : raw;
        setError(friendly);
      } else {
        setError("Could not save class. Please try again.");
      }
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = async () => {
    if (modal.type !== "edit") return;
    setCancelling(true);
    setError(null);
    try {
      await cancelScheduledClass(studioId, modal.cls.id, cancelReason.trim() || undefined);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not cancel class");
    } finally {
      setCancelling(false);
    }
  };

  const isCancelled = modal.type === "edit" && modal.cls.status === "CANCELLED";

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

        {showCancelConfirm ? (
          <div className="mt-5 space-y-4">
            <p className="text-sm text-zinc-600">
              Cancel this scheduled class? This cannot be undone. Bookings will be affected.
            </p>
            <div>
              <label className="block text-xs font-medium text-zinc-700">
                Reason (optional)
              </label>
              <input
                type="text"
                maxLength={2000}
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder="e.g. Instructor unavailable"
                className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
              />
            </div>
            {error ? (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setShowCancelConfirm(false)}
                className="rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
              >
                Back
              </button>
              <button
                type="button"
                disabled={cancelling}
                onClick={() => void handleCancel()}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
              >
                {cancelling ? "Cancelling…" : "Confirm cancel"}
              </button>
            </div>
          </div>
        ) : modal.type === "create" && !hasTemplates ? (
          <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm font-medium text-amber-900">
              No class types yet
            </p>
            <p className="mt-1 text-sm text-amber-700">
              You need at least one class type before you can schedule a class.
            </p>
            <div className="mt-3 flex gap-3">
              <Link
                href="/classes"
                className="rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-500"
                onClick={onClose}
              >
                Create a class type
              </Link>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-amber-300 px-3 py-1.5 text-sm font-medium text-amber-800 hover:bg-amber-100"
              >
                Close
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={(e) => void handleSubmit(e)} className="mt-5 space-y-4">
            {modal.type === "create" ? (
              <div className="space-y-2">
                <div>
                  <label className="block text-xs font-medium text-zinc-700">
                    Class type
                  </label>
                  <select
                    required
                    value={form.templateId}
                    onChange={(e) => handleTemplateChange(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
                  >
                    {!form.templateId && (
                      <option value="" disabled>
                        Loading class types…
                      </option>
                    )}
                    {safeTemplates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} · {t.durationMinutes} min
                      </option>
                    ))}
                  </select>
                </div>
                {selectedTemplate && (selectedTemplate.description || selectedTemplate.category || selectedTemplate.intensityLevel || selectedTemplate.thumbnailImageUrl) ? (
                  <div className="flex gap-3 rounded-xl border border-zinc-100 bg-zinc-50 p-3">
                    {selectedTemplate.thumbnailImageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={selectedTemplate.thumbnailImageUrl}
                        alt=""
                        className="h-14 w-14 shrink-0 rounded-lg object-cover"
                      />
                    ) : null}
                    <div className="min-w-0">
                      <div className="flex flex-wrap gap-1">
                        {selectedTemplate.category ? (
                          <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-[10px] font-medium text-zinc-600">
                            {selectedTemplate.category}
                          </span>
                        ) : null}
                        {selectedTemplate.intensityLevel ? (
                          <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-[10px] font-medium text-zinc-600">
                            {selectedTemplate.intensityLevel}
                          </span>
                        ) : null}
                        {selectedTemplate.difficultyLabel ? (
                          <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-[10px] font-medium text-zinc-600">
                            {selectedTemplate.difficultyLabel}
                          </span>
                        ) : null}
                      </div>
                      {selectedTemplate.description ? (
                        <p className="mt-1 line-clamp-2 text-xs text-zinc-500">
                          {selectedTemplate.description}
                        </p>
                      ) : null}
                      {(selectedTemplate.caloriesEstimateMin !== null || selectedTemplate.caloriesEstimateMax !== null) ? (
                        <p className="mt-1 text-[11px] text-zinc-400">
                          {selectedTemplate.caloriesEstimateMin ?? "?"}–{selectedTemplate.caloriesEstimateMax ?? "?"} kcal
                        </p>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <div>
                <p className="text-xs font-medium text-zinc-500">Class type</p>
                <p className="mt-0.5 text-sm font-medium text-zinc-900">
                  {modal.cls.classTemplate.name}
                </p>
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-zinc-700">
                  Start
                </label>
                <input
                  type="datetime-local"
                  required
                  value={form.startTime}
                  onChange={(e) => handleStartChange(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-700">
                  End
                </label>
                <input
                  type="datetime-local"
                  required
                  value={form.endTime}
                  onChange={(e) => setForm((prev) => ({ ...prev, endTime: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-zinc-700">
                  Capacity
                </label>
                <input
                  type="number"
                  required
                  min={1}
                  max={10000}
                  value={form.capacity}
                  onChange={(e) => setForm((prev) => ({ ...prev, capacity: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-700">
                  Instructor <span className="font-normal text-zinc-400">(optional)</span>
                </label>
                <select
                  value={form.instructorId}
                  onChange={(e) => setForm((prev) => ({ ...prev, instructorId: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
                >
                  <option value="">— None —</option>
                  {safeMembers.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.firstName} {m.lastName}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {error ? (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                {error}
              </p>
            ) : null}
            <div className="flex items-center justify-between gap-3 pt-1">
              <div>
                {modal.type === "edit" && !isCancelled ? (
                  <button
                    type="button"
                    onClick={() => setShowCancelConfirm(true)}
                    className="rounded-lg px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
                  >
                    Cancel class
                  </button>
                ) : null}
              </div>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
                >
                  Close
                </button>
                {!isCancelled ? (
                  <button
                    type="submit"
                    disabled={saving || (modal.type === "create" && !form.templateId)}
                    className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
                  >
                    {saving
                      ? "Saving…"
                      : modal.type === "create" && !form.templateId
                      ? "Select a class type"
                      : modal.type === "edit"
                      ? "Save changes"
                      : "Schedule"}
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

// ── class card ─────────────────────────────────────────────────────────────────

function ClassCard({
  cls,
  tz,
  onViewRoster,
  onEdit,
}: {
  cls: ScheduledClassDto;
  tz: string;
  onViewRoster: () => void;
  onEdit: () => void;
}) {
  const accentColor = cls.classTemplate.color;

  return (
    <div className="w-full rounded-xl border border-zinc-200 bg-white p-2.5 text-left shadow-sm transition hover:border-zinc-300 hover:shadow">
      {accentColor ? (
        <div className="mb-1.5 h-0.5 w-8 rounded-full" style={{ backgroundColor: accentColor }} />
      ) : null}
      <button type="button" onClick={onViewRoster} className="w-full text-left">
        <p className="text-xs font-semibold leading-snug text-zinc-900">
          {cls.classTemplate.name}
        </p>
        <p className="mt-0.5 text-[11px] text-zinc-500">
          {formatTime(cls.startsAt, tz)} – {formatTime(cls.endsAt, tz)}
        </p>
        {cls.instructor ? (
          <p className="mt-0.5 text-[11px] text-zinc-500">
            {cls.instructor.firstName} {cls.instructor.lastName}
          </p>
        ) : null}
        <p className="mt-1 text-[10px] text-zinc-400">
          Cap. {cls.capacity}
          {typeof cls.bookedCount === "number" ? ` · ${cls.bookedCount} booked` : ""}
        </p>
      </button>
      <button
        type="button"
        onClick={onEdit}
        className="mt-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500 underline hover:text-zinc-800"
      >
        Edit
      </button>
    </div>
  );
}

// ── page ───────────────────────────────────────────────────────────────────────

export default function SchedulePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { selectedStudioId, selected, loading: studioLoading, error: studioError } = useDeskStudio();
  const tz = selected?.studio.timezone ?? "UTC";

  const [weekOffset, setWeekOffset] = useState(0);
  const [classes, setClasses] = useState<ScheduledClassDto[]>([]);
  const [templates, setTemplates] = useState<ClassTemplateDto[]>([]);
  const [members, setMembers] = useState<StaffInstructorDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<ScheduleModalState>({ type: "closed" });

  const urlWeekStart = searchParams.get("weekStart");
  const weekOffsetFromUrl = useMemo(() => {
    if (!urlWeekStart) return null;
    const mondayKey = mondayStartKeyForInstant(urlWeekStart, tz);
    return weekOffsetFromMondayStartKey(mondayKey, tz);
  }, [urlWeekStart, tz]);
  const effectiveWeekOffset = weekOffsetFromUrl ?? weekOffset;

  const shiftWeek = useCallback(
    (delta: number) => {
      const base = weekOffsetFromUrl ?? weekOffset;
      setWeekOffset(base + delta);
      if (urlWeekStart) router.replace("/schedule");
    },
    [router, urlWeekStart, weekOffset, weekOffsetFromUrl],
  );

  const weekBounds = useMemo(
    () => weekBoundsInZone(tz, effectiveWeekOffset),
    [tz, effectiveWeekOffset],
  );
  const weekDays = useMemo(() => weekDayKeysFromStart(weekBounds.startKey), [weekBounds.startKey]);
  const queryRange = useMemo(
    () => studioWeekQueryRangeIso(weekBounds.startKey, weekBounds.endKey, tz),
    [weekBounds.endKey, weekBounds.startKey, tz],
  );

  const load = useCallback(async () => {
    if (!selectedStudioId) {
      setClasses([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [cls, tpl, mem] = await Promise.all([
        fetchStudioSchedule(selectedStudioId, queryRange.from, queryRange.to),
        fetchClassTemplates(selectedStudioId),
        fetchStaffInstructors(selectedStudioId),
      ]);
      setClasses(cls);
      setTemplates(tpl);
      setMembers(mem);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not load schedule");
    } finally {
      setLoading(false);
    }
  }, [selectedStudioId, queryRange.from, queryRange.to]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  const activeClasses = useMemo(
    () =>
      filterOperationalScheduleInWeek(
        classes,
        weekBounds.startKey,
        weekBounds.endKey,
        tz,
        selectedStudioId ?? undefined,
      ),
    [classes, weekBounds.endKey, weekBounds.startKey, selectedStudioId, tz],
  );

  const openClassRoster = useCallback(
    (cls: ScheduledClassDto) => {
      router.push(
        classRosterHref(cls.id, {
          returnTo: "schedule",
          weekStart: studioLocalDateKeyToUtcAnchor(weekBounds.startKey, tz).toISOString(),
        }),
      );
    },
    [router, weekBounds.startKey, tz],
  );

  const classesByDay = useMemo(() => {
    const map = new Map<string, ScheduledClassDto[]>();
    for (const cls of activeClasses) {
      const key = calendarDayKeyInZone(cls.startsAt, tz);
      const arr = map.get(key) ?? [];
      arr.push(cls);
      map.set(key, arr);
    }
    return map;
  }, [activeClasses, tz]);

  const todayKey = useMemo(() => todayKeyInZone(tz), [tz]);

  const handleModalDone = () => {
    setModal({ type: "closed" });
    void load();
  };

  if (studioLoading) {
    return <p className="text-sm text-zinc-500">Cargando estudios…</p>;
  }

  if (studioError) {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-800">
        {studioError}
      </div>
    );
  }

  if (!selectedStudioId) {
    return (
      <div className="rounded-2xl border border-zinc-200 bg-white p-8 text-center">
        <p className="text-sm text-zinc-600">No se encontraron membresías de estudio para esta cuenta.</p>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-6">
        <PageHeader
          title="Calendario"
          subtitle={weekBounds.label}
          actions={
            <>
              <button
                type="button"
                onClick={() => {
                  setWeekOffset(0);
                  if (urlWeekStart) router.replace("/schedule");
                }}
                className={adminSecondaryBtn}
              >
                Hoy
              </button>
              <div className="flex rounded-xl border border-zinc-200">
                <button
                  type="button"
                  onClick={() => shiftWeek(-1)}
                  className="rounded-l-xl px-2.5 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                >
                  ‹
                </button>
                <button
                  type="button"
                  onClick={() => shiftWeek(1)}
                  className="rounded-r-xl border-l border-zinc-200 px-2.5 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                >
                  ›
                </button>
              </div>
              <button
                type="button"
                onClick={() => setModal({ type: "create" })}
                className={adminPrimaryBtn}
              >
                Programar clase
              </button>
            </>
          }
        />

        {error ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {error}
            <button type="button" className="ml-3 font-semibold underline" onClick={() => void load()}>
              Reintentar
            </button>
          </div>
        ) : null}

        {/* Week grid */}
        <SurfaceCard padding="sm" className="overflow-x-auto p-0">
          <div className="min-w-[700px]">
            <div className="grid grid-cols-7 border-b border-zinc-100">
              {weekDays.map((dayKey) => {
                const { weekday, day: dayNum } = formatDayHeader(dayKey, tz);
                const isToday = dayKey === todayKey;
                return (
                  <div
                    key={dayKey}
                    className="border-r border-zinc-100 px-3 py-3 text-center last:border-r-0"
                  >
                    <p className={`text-[11px] font-medium uppercase tracking-wider ${isToday ? "text-zinc-900" : "text-zinc-400"}`}>
                      {weekday}
                    </p>
                    <p
                      className={`mt-0.5 text-lg font-semibold leading-none ${
                        isToday
                          ? "flex h-7 w-7 items-center justify-center rounded-full bg-zinc-900 text-white"
                          : "text-zinc-700"
                      }`}
                      style={isToday ? { margin: "2px auto 0" } : {}}
                    >
                      {dayNum}
                    </p>
                  </div>
                );
              })}
            </div>

            {/* Day columns */}
            <div className="grid grid-cols-7 divide-x divide-zinc-100">
              {weekDays.map((dayKey) => {
                const dayCls = classesByDay.get(dayKey) ?? [];
                return (
                  <div key={dayKey} className="min-h-[120px] p-2">
                    {loading ? (
                      <div className="space-y-1.5">
                        <div className="h-14 animate-pulse rounded-lg bg-zinc-100" />
                      </div>
                    ) : dayCls.length === 0 ? (
                      <button
                        type="button"
                        onClick={() => setModal({ type: "create", prefillDate: dayKey })}
                        className="flex h-full w-full min-h-[80px] items-center justify-center rounded-lg text-zinc-300 hover:bg-zinc-50 hover:text-zinc-400"
                      >
                        <span className="text-lg leading-none">+</span>
                      </button>
                    ) : (
                      <div className="space-y-1.5">
                        {dayCls.map((cls) => (
                          <ClassCard
                            key={cls.id}
                            cls={cls}
                            tz={tz}
                            onViewRoster={() => openClassRoster(cls)}
                            onEdit={() => setModal({ type: "edit", cls })}
                          />
                        ))}
                        <button
                          type="button"
                          onClick={() => setModal({ type: "create", prefillDate: dayKey })}
                          className="w-full rounded-lg py-1 text-center text-xs text-zinc-300 hover:bg-zinc-50 hover:text-zinc-500"
                        >
                          + Agregar
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </SurfaceCard>

        {!loading && activeClasses.length > 0 ? (
          <div>
            <h2 className="mb-3 text-sm font-semibold text-zinc-800">
              Esta semana · {activeClasses.length} programadas
            </h2>
            <ul className="space-y-2">
              {activeClasses.map((c) => (
                  <li key={c.id}>
                    <div className="flex w-full items-center justify-between gap-4 rounded-xl border border-zinc-200 bg-white px-4 py-3 shadow-sm transition hover:border-zinc-300 hover:shadow">
                      <button
                        type="button"
                        onClick={() => openClassRoster(c)}
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                      >
                        {c.classTemplate.color ? (
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ backgroundColor: c.classTemplate.color }}
                          />
                        ) : null}
                        <span className="truncate text-sm font-semibold text-zinc-900">
                          {c.classTemplate.name}
                        </span>
                      </button>
                      <div className="shrink-0 text-right text-xs text-zinc-500">
                        <p>{calendarDayKeyInZone(c.startsAt, tz)}</p>
                        <p>{formatTime(c.startsAt, tz)} – {formatTime(c.endsAt, tz)}</p>
                      </div>
                      {c.instructor ? (
                        <span className="hidden shrink-0 text-xs text-zinc-400 sm:block">
                          {c.instructor.firstName} {c.instructor.lastName}
                        </span>
                      ) : null}
                      <span className="shrink-0 text-xs text-zinc-400">
                        Cap {c.capacity}
                      </span>
                      <button
                        type="button"
                        onClick={() => setModal({ type: "edit", cls: c })}
                        className="shrink-0 text-xs font-semibold text-zinc-600 underline"
                      >
                        Edit
                      </button>
                    </div>
                  </li>
                ))}
            </ul>
          </div>
        ) : null}
      </div>

      {modal.type !== "closed" && selectedStudioId ? (
        <ScheduleModal
          modal={modal as Exclude<ScheduleModalState, { type: "closed" }>}
          templates={templates}
          members={members}
          studioId={selectedStudioId}
          onClose={() => setModal({ type: "closed" })}
          onDone={handleModalDone}
        />
      ) : null}
    </>
  );
}
