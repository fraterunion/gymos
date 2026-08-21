"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { PageHeader } from "@/components/shell/PageHeader";
import { SurfaceCard } from "@/components/shell/SurfaceCard";
import { useDeskStudio } from "@/contexts/DeskStudioContext";
import { ApiError } from "@/lib/api/errors";
import { adminPrimaryBtn, adminSecondaryBtn } from "@/lib/adminSurface";
import { fetchStudioSchedule, type ScheduledClassDto } from "@/lib/api/schedule";
import { fetchClassTemplates, type ClassTemplateDto } from "@/lib/api/classTemplates";
import { fetchStaffInstructors, type StaffInstructorDto } from "@/lib/api/staff";
import { calendarDayKeyInZone, todayKeyInZone } from "@/lib/datetime";
import {
  BulkActionModal,
  DuplicateClassModal,
  DuplicateWeekModal,
} from "@/app/schedule/ScheduleOperationsModals";
import { CreateSeriesModal } from "@/app/schedule/CreateSeriesModal";
import { EditSeriesModal } from "@/app/schedule/EditSeriesModal";
import { FinishSeriesModal } from "@/app/schedule/FinishSeriesModal";
import { SeriesDrawer } from "@/app/schedule/SeriesDrawer";
import { SeriesView } from "@/app/schedule/SeriesView";
import { SessionDrawer } from "@/app/schedule/SessionDrawer";
import {
  ScheduleModal,
  type ScheduleModalState,
} from "@/app/schedule/ScheduleModal";
import {
  filterOperationalScheduleInWeek,
  studioWeekQueryRangeIso,
  weekDayKeysFromStart,
} from "@/lib/operationalSchedule";
import {
  currentWeekStartKey,
  mondayStartKeyForInstant,
  resolveDisplayWeekStartKey,
  shiftDisplayWeekStartKey,
  weekBoundsFromStartKey,
} from "@/lib/scheduleWeekNavigation";
import {
  formatOccupancyLabel,
  occupancyToneClass,
} from "@/lib/scheduleOccupancy";
import {
  canManageCalendarOperations,
  canManageSeries,
} from "@/lib/scheduleCalendarAccess";
import type { SeriesDetail } from "@/lib/api/scheduleSeries";
import type { BulkOperation } from "@/lib/api/scheduleOperations";

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

function CalendarOverflowMenu({
  canManage,
  onDuplicateWeek,
  onToggleSelect,
  selectMode,
}: {
  canManage: boolean;
  onDuplicateWeek: () => void;
  onToggleSelect: () => void;
  selectMode: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!canManage) return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={adminSecondaryBtn}
        aria-label="Más acciones"
      >
        •••
      </button>
      {open ? (
        <>
          <button type="button" className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1 min-w-[200px] rounded-xl border border-zinc-200 bg-white py-1 shadow-lg">
            <button
              type="button"
              className="block w-full px-3 py-2 text-left text-sm text-zinc-700 hover:bg-zinc-50"
              onClick={() => {
                setOpen(false);
                onDuplicateWeek();
              }}
            >
              Duplicar esta semana
            </button>
            <button
              type="button"
              className="block w-full px-3 py-2 text-left text-sm text-zinc-700 hover:bg-zinc-50"
              onClick={() => {
                setOpen(false);
                onToggleSelect();
              }}
            >
              {selectMode ? "Salir de selección" : "Seleccionar clases"}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function CalendarViewSwitch({
  view,
  onChange,
}: {
  view: "week" | "series";
  onChange: (view: "week" | "series") => void;
}) {
  return (
    <div className="flex rounded-xl border border-zinc-200">
      <button
        type="button"
        onClick={() => onChange("week")}
        className={`rounded-l-xl px-3 py-2 text-xs font-medium ${
          view === "week" ? "bg-zinc-900 text-white" : "text-zinc-700 hover:bg-zinc-50"
        }`}
      >
        Semana
      </button>
      <button
        type="button"
        onClick={() => onChange("series")}
        className={`rounded-r-xl border-l border-zinc-200 px-3 py-2 text-xs font-medium ${
          view === "series" ? "bg-zinc-900 text-white" : "text-zinc-700 hover:bg-zinc-50"
        }`}
      >
        Series
      </button>
    </div>
  );
}

function ClassCard({
  cls,
  tz,
  selectMode,
  selected,
  onToggleSelect,
  onOpenSession,
}: {
  cls: ScheduledClassDto;
  tz: string;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onOpenSession: () => void;
}) {
  const accentColor = cls.classTemplate.color;
  const booked = cls.bookedCount ?? 0;
  const waitlist = cls.waitlistCount ?? 0;
  const { label, tone } = formatOccupancyLabel(booked, cls.capacity, waitlist);

  return (
    <div
      className={`w-full rounded-xl border bg-white p-2.5 text-left shadow-sm transition ${
        selected ? "border-zinc-900 ring-1 ring-zinc-900" : "border-zinc-200 hover:border-zinc-300 hover:shadow"
      }`}
    >
      {selectMode ? (
        <label className="mb-1.5 flex items-center gap-2">
          <input type="checkbox" checked={selected} onChange={onToggleSelect} />
          <span className="text-[10px] text-zinc-500">Seleccionar</span>
        </label>
      ) : null}
      {accentColor ? (
        <div className="mb-1.5 h-0.5 w-8 rounded-full" style={{ backgroundColor: accentColor }} />
      ) : null}
      {cls.scheduleTemplateId ? (
        <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-indigo-500">Serie</p>
      ) : null}
      <button
        type="button"
        onClick={selectMode ? onToggleSelect : onOpenSession}
        className="w-full text-left"
      >
        <p className="text-xs font-semibold leading-snug text-zinc-900">{cls.classTemplate.name}</p>
        <p className="mt-0.5 text-[11px] text-zinc-500">
          {formatTime(cls.startsAt, tz)} – {formatTime(cls.endsAt, tz)}
        </p>
        {cls.instructor ? (
          <p className="mt-0.5 truncate text-[11px] text-zinc-500">
            {cls.instructor.firstName} {cls.instructor.lastName}
          </p>
        ) : null}
        <p className={`mt-1 text-[10px] ${occupancyToneClass(tone)}`}>{label}</p>
      </button>
    </div>
  );
}

export default function SchedulePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { selectedStudioId, selected, loading: studioLoading, error: studioError } = useDeskStudio();
  const tz = selected?.studio.timezone ?? "UTC";
  const canManage = canManageCalendarOperations(selected?.role);
  const canManageSeriesOps = canManageSeries(selected?.role);

  const urlView = searchParams.get("view");
  const urlSeries = searchParams.get("series");
  const calendarView: "week" | "series" = urlView === "series" ? "series" : "week";

  const [displayWeekStartKey, setDisplayWeekStartKey] = useState<string | null>(null);
  const [classes, setClasses] = useState<ScheduledClassDto[]>([]);
  const [templates, setTemplates] = useState<ClassTemplateDto[]>([]);
  const [members, setMembers] = useState<StaffInstructorDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<ScheduleModalState>({ type: "closed" });
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [duplicateWeekOpen, setDuplicateWeekOpen] = useState(false);
  const [duplicateClass, setDuplicateClass] = useState<ScheduledClassDto | null>(null);
  const [bulkOperation, setBulkOperation] = useState<BulkOperation | null>(null);
  const [sessionClassId, setSessionClassId] = useState<string | null>(null);
  const [opsFeedback, setOpsFeedback] = useState<string | null>(null);
  const [selectedSeriesId, setSelectedSeriesId] = useState<string | null>(null);
  const [createSeriesOpen, setCreateSeriesOpen] = useState(false);
  const [editSeriesDetail, setEditSeriesDetail] = useState<SeriesDetail | null>(null);
  const [finishSeriesDetail, setFinishSeriesDetail] = useState<SeriesDetail | null>(null);
  const [seriesRefreshKey, setSeriesRefreshKey] = useState(0);

  const urlWeekStart = searchParams.get("weekStart");

  useEffect(() => {
    if (calendarView === "series" && urlSeries) {
      setSelectedSeriesId(urlSeries);
    }
  }, [calendarView, urlSeries]);

  useEffect(() => {
    if (!tz) return;
    setDisplayWeekStartKey((prev) => {
      if (prev !== null) return prev;
      return resolveDisplayWeekStartKey(null, urlWeekStart, tz);
    });
  }, [tz, urlWeekStart]);

  const effectiveWeekStartKey = useMemo(
    () => resolveDisplayWeekStartKey(displayWeekStartKey, urlWeekStart, tz),
    [displayWeekStartKey, urlWeekStart, tz],
  );

  const weekBounds = useMemo(
    () => weekBoundsFromStartKey(effectiveWeekStartKey, tz),
    [effectiveWeekStartKey, tz],
  );

  const clearWeekUrlParam = useCallback(() => {
    if (urlWeekStart) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("weekStart");
      const qs = params.toString();
      router.replace(qs ? `/schedule?${qs}` : "/schedule", { scroll: false });
    }
  }, [router, searchParams, urlWeekStart]);

  const setCalendarView = useCallback(
    (view: "week" | "series", seriesId?: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (view === "series") params.set("view", "series");
      else {
        params.delete("view");
        params.delete("series");
      }
      if (seriesId) params.set("series", seriesId);
      const qs = params.toString();
      router.replace(qs ? `/schedule?${qs}` : "/schedule", { scroll: false });
    },
    [router, searchParams],
  );

  const openSeriesById = useCallback(
    (seriesId: string) => {
      setSessionClassId(null);
      setSelectedSeriesId(seriesId);
      setCalendarView("series", seriesId);
    },
    [setCalendarView],
  );

  const closeSeriesDrawer = useCallback(() => {
    setSelectedSeriesId(null);
    const params = new URLSearchParams(searchParams.toString());
    params.delete("series");
    const qs = params.toString();
    router.replace(qs ? `/schedule?${qs}` : "/schedule", { scroll: false });
  }, [router, searchParams]);

  const openOccurrenceFromSeries = useCallback(
    (occurrenceId: string, startsAt: string) => {
      setSelectedSeriesId(null);
      setCalendarView("week");
      setDisplayWeekStartKey(mondayStartKeyForInstant(startsAt, tz));
      setSessionClassId(occurrenceId);
    },
    [setCalendarView, tz],
  );

  const shiftWeek = useCallback(
    (delta: number) => {
      setDisplayWeekStartKey((current) =>
        shiftDisplayWeekStartKey(
          current ?? resolveDisplayWeekStartKey(null, urlWeekStart, tz),
          delta,
        ),
      );
      clearWeekUrlParam();
    },
    [clearWeekUrlParam, tz, urlWeekStart],
  );

  const goToToday = useCallback(() => {
    setDisplayWeekStartKey(currentWeekStartKey(tz));
    clearWeekUrlParam();
  }, [clearWeekUrlParam, tz]);
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

  const refreshSeries = useCallback(() => {
    setSeriesRefreshKey((k) => k + 1);
    void load();
  }, [load]);

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

  const openSession = useCallback((cls: ScheduledClassDto) => {
    setSessionClassId(cls.id);
  }, []);

  const resolveClass = useCallback(
    (classId: string): ScheduledClassDto | undefined => classes.find((c) => c.id === classId),
    [classes],
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

  const handleOpsDone = (message?: string) => {
    setDuplicateWeekOpen(false);
    setDuplicateClass(null);
    setBulkOperation(null);
    setSelectMode(false);
    setSelectedIds(new Set());
    if (message) setOpsFeedback(message);
    void load();
  };

  const toggleClassSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

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
          subtitle={calendarView === "week" ? weekBounds.label : "Series recurrentes"}
          actions={
            <>
              <CalendarViewSwitch view={calendarView} onChange={setCalendarView} />
              {calendarView === "week" ? (
                <>
                  <button
                    type="button"
                    onClick={goToToday}
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
                  <CalendarOverflowMenu
                    canManage={canManage}
                    selectMode={selectMode}
                    onDuplicateWeek={() => setDuplicateWeekOpen(true)}
                    onToggleSelect={() => {
                      setSelectMode((v) => !v);
                      setSelectedIds(new Set());
                    }}
                  />
                </>
              ) : canManageSeriesOps ? (
                <button
                  type="button"
                  className={adminPrimaryBtn}
                  onClick={() => setCreateSeriesOpen(true)}
                >
                  + Nueva serie
                </button>
              ) : null}
            </>
          }
        />

        {opsFeedback ? (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
            {opsFeedback}
            <button
              type="button"
              className="ml-3 font-semibold underline"
              onClick={() => setOpsFeedback(null)}
            >
              Cerrar
            </button>
          </div>
        ) : null}

        {error ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {error}
            <button type="button" className="ml-3 font-semibold underline" onClick={() => void load()}>
              Reintentar
            </button>
          </div>
        ) : null}

        {calendarView === "series" ? (
          <SeriesView
            studioId={selectedStudioId}
            timezone={tz}
            canManage={canManageSeriesOps}
            instructors={members}
            refreshKey={seriesRefreshKey}
            onSelectSeries={setSelectedSeriesId}
            onCreateSeries={() => setCreateSeriesOpen(true)}
          />
        ) : (
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

            <div className="grid grid-cols-7 divide-x divide-zinc-100">
              {weekDays.map((dayKey) => {
                const dayCls = classesByDay.get(dayKey) ?? [];
                return (
                  <div key={dayKey} className="min-h-[120px] p-2">
                    {loading ? (
                      <div className="h-14 animate-pulse rounded-lg bg-zinc-100" />
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
                            selectMode={selectMode}
                            selected={selectedIds.has(cls.id)}
                            onToggleSelect={() => toggleClassSelected(cls.id)}
                            onOpenSession={() => openSession(cls)}
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
        )}

        {calendarView === "week" && selectMode && selectedIds.size > 0 ? (
          <div className="fixed bottom-0 left-0 right-0 z-30 border-t border-zinc-200 bg-white/95 px-4 py-3 backdrop-blur">
            <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-medium text-zinc-800">
                {selectedIds.size} clases seleccionadas
              </p>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ["CHANGE_INSTRUCTOR", "Cambiar instructor"],
                    ["CHANGE_CAPACITY", "Cambiar capacidad"],
                    ["MOVE_TIME", "Mover horario"],
                    ["DUPLICATE", "Duplicar"],
                    ["CANCEL", "Cancelar"],
                  ] as const
                ).map(([op, label]) => (
                  <button
                    key={op}
                    type="button"
                    className={adminSecondaryBtn}
                    onClick={() => setBulkOperation(op)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {duplicateWeekOpen ? (
        <DuplicateWeekModal
          studioId={selectedStudioId}
          sourceWeekStart={weekBounds.startKey}
          timezone={tz}
          onClose={() => setDuplicateWeekOpen(false)}
          onDone={handleOpsDone}
        />
      ) : null}

      {duplicateClass ? (
        <DuplicateClassModal
          studioId={selectedStudioId}
          cls={duplicateClass}
          timezone={tz}
          instructors={members}
          onClose={() => setDuplicateClass(null)}
          onDone={handleOpsDone}
        />
      ) : null}

      {bulkOperation ? (
        <BulkActionModal
          studioId={selectedStudioId}
          selectedIds={[...selectedIds]}
          operation={bulkOperation}
          instructors={members}
          onClose={() => setBulkOperation(null)}
          onDone={handleOpsDone}
        />
      ) : null}

      {modal.type !== "closed" ? (
        <ScheduleModal
          modal={modal}
          templates={templates}
          members={members}
          studioId={selectedStudioId}
          timezone={tz}
          onClose={() => setModal({ type: "closed" })}
          onDone={handleModalDone}
        />
      ) : null}

      {createSeriesOpen ? (
        <CreateSeriesModal
          studioId={selectedStudioId}
          timezone={tz}
          templates={templates}
          members={members}
          onClose={() => setCreateSeriesOpen(false)}
          onDone={() => {
            setCreateSeriesOpen(false);
            refreshSeries();
          }}
        />
      ) : null}

      {selectedSeriesId ? (
        <SeriesDrawer
          studioId={selectedStudioId}
          seriesId={selectedSeriesId}
          timezone={tz}
          canManage={canManageSeriesOps}
          refreshKey={seriesRefreshKey}
          onClose={closeSeriesDrawer}
          onEdit={(detail) => setEditSeriesDetail(detail)}
          onFinish={(detail) => setFinishSeriesDetail(detail)}
          onOpenOccurrence={openOccurrenceFromSeries}
        />
      ) : null}

      {editSeriesDetail ? (
        <EditSeriesModal
          studioId={selectedStudioId}
          timezone={tz}
          detail={editSeriesDetail}
          members={members}
          onClose={() => setEditSeriesDetail(null)}
          onDone={() => {
            setEditSeriesDetail(null);
            setSelectedSeriesId(null);
            refreshSeries();
          }}
        />
      ) : null}

      {finishSeriesDetail ? (
        <FinishSeriesModal
          studioId={selectedStudioId}
          timezone={tz}
          detail={finishSeriesDetail}
          onClose={() => setFinishSeriesDetail(null)}
          onDone={() => {
            setFinishSeriesDetail(null);
            setSelectedSeriesId(null);
            refreshSeries();
          }}
        />
      ) : null}

      {sessionClassId ? (
        <SessionDrawer
          studioId={selectedStudioId}
          classId={sessionClassId}
          timezone={tz}
          role={selected?.role}
          onClose={() => setSessionClassId(null)}
          onManageSeries={openSeriesById}
          onEdit={(classId) => {
            const cls = resolveClass(classId);
            setSessionClassId(null);
            if (cls) setModal({ type: "edit", cls });
          }}
          onDuplicate={(classId) => {
            const cls = resolveClass(classId);
            setSessionClassId(null);
            if (cls) setDuplicateClass(cls);
          }}
          onCancel={(classId) => {
            const cls = resolveClass(classId);
            setSessionClassId(null);
            if (cls) setModal({ type: "edit", cls });
          }}
          onCalendarRefresh={() => void load()}
        />
      ) : null}
    </>
  );
}
