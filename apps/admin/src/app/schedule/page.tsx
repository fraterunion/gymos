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
import {
  ScheduleModal,
  type ScheduleModalState,
} from "@/app/schedule/ScheduleModal";

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
      {cls.scheduleTemplateId ? (
        <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-indigo-500">Serie</p>
      ) : null}
      <button type="button" onClick={onViewRoster} className="w-full text-left">
        <p className="text-xs font-semibold leading-snug text-zinc-900">{cls.classTemplate.name}</p>
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
          {typeof cls.bookedCount === "number" ? ` · ${cls.bookedCount} reservadas` : ""}
        </p>
      </button>
      <button
        type="button"
        onClick={onEdit}
        className="mt-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500 underline hover:text-zinc-800"
      >
        Editar
      </button>
    </div>
  );
}

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
      </div>

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
    </>
  );
}
