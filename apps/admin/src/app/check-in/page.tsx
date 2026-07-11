"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useDeskStudio } from "@/contexts/DeskStudioContext";
import {
  buildScheduleQueryRange,
  calendarDayKeyInZone,
  formatClassRange,
  formatDateKeyLabel,
  shiftDateKey,
  todayKeyInZone,
} from "@/lib/datetime";
import { fetchStudioSchedule, type ScheduledClassDto } from "@/lib/api/schedule";
import { ApiError } from "@/lib/api/errors";
import { classRosterHref } from "@/lib/classRosterNav";
import { adminSecondaryBtn } from "@/lib/adminSurface";

function scheduleRangeForDateKey(dayKey: string): { from: string; to: string } {
  const from = new Date(`${dayKey}T00:00:00.000Z`);
  from.setUTCDate(from.getUTCDate() - 1);
  const to = new Date(`${dayKey}T00:00:00.000Z`);
  to.setUTCDate(to.getUTCDate() + 2);
  to.setUTCHours(23, 59, 59, 999);
  return { from: from.toISOString(), to: to.toISOString() };
}

export default function CheckInTodayPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { selected, selectedStudioId, loading: studioLoading, error: studioError } = useDeskStudio();
  const [classes, setClasses] = useState<ScheduledClassDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const tz = selected?.studio.timezone ?? "UTC";
  const todayKey = useMemo(() => todayKeyInZone(tz), [tz]);
  const selectedDateKey = searchParams.get("date") ?? todayKey;
  const isToday = selectedDateKey === todayKey;

  const setSelectedDateKey = useCallback(
    (dayKey: string) => {
      const params = new URLSearchParams();
      if (dayKey !== todayKey) params.set("date", dayKey);
      const q = params.toString();
      router.push(q ? `/check-in?${q}` : "/check-in");
    },
    [router, todayKey],
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
      const range = isToday ? buildScheduleQueryRange() : scheduleRangeForDateKey(selectedDateKey);
      const rows = await fetchStudioSchedule(selectedStudioId, range.from, range.to);
      setClasses(rows);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not load schedule");
      setClasses([]);
    } finally {
      setLoading(false);
    }
  }, [selectedStudioId, selectedDateKey, isToday]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  const dayClasses = useMemo(() => {
    return classes
      .filter((c) => c.status === "SCHEDULED" && calendarDayKeyInZone(c.startsAt, tz) === selectedDateKey)
      .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  }, [classes, selectedDateKey, tz]);

  if (studioLoading) {
    return <p className="text-sm text-zinc-500">Loading studios…</p>;
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
        <p className="text-sm text-zinc-600">No studio memberships found for this account.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
            {isToday ? "Today's classes" : "Classes"}
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            {formatDateKeyLabel(selectedDateKey, tz)} · Select a class to view reservations and check-ins.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={adminSecondaryBtn}
            onClick={() => setSelectedDateKey(todayKey)}
          >
            Today
          </button>
          <button
            type="button"
            className={adminSecondaryBtn}
            onClick={() => setSelectedDateKey(shiftDateKey(selectedDateKey, -1))}
          >
            ‹ Prev
          </button>
          <button
            type="button"
            className={adminSecondaryBtn}
            onClick={() => setSelectedDateKey(shiftDateKey(selectedDateKey, 1))}
          >
            Next ›
          </button>
        </div>
      </div>
      {error ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {error}
          <button type="button" className="ml-3 font-semibold underline" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : null}
      {loading ? (
        <p className="text-sm text-zinc-500">Loading schedule…</p>
      ) : dayClasses.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 bg-white/60 px-6 py-14 text-center">
          <p className="text-sm font-medium text-zinc-700">
            {isToday ? "No scheduled classes today" : "No scheduled classes on this date"}
          </p>
          <p className="mt-2 text-sm text-zinc-500">Use the arrows to browse other dates.</p>
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {dayClasses.map((c) => (
            <li key={c.id}>
              <Link
                href={classRosterHref(c.id, { returnTo: "check-in", date: selectedDateKey })}
                className="block rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm transition hover:border-zinc-300 hover:shadow"
              >
                <div className="flex items-start justify-between gap-2">
                  <h2 className="text-base font-semibold text-zinc-900">{c.classTemplate.name}</h2>
                  <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-800">
                    Scheduled
                  </span>
                </div>
                <p className="mt-2 text-sm text-zinc-500">{formatClassRange(c.startsAt, c.endsAt, tz)}</p>
                {c.instructor ? (
                  <p className="mt-2 text-xs text-zinc-400">
                    {c.instructor.firstName} {c.instructor.lastName}
                  </p>
                ) : null}
                <p className="mt-3 text-xs font-medium text-zinc-400">
                  Capacity {c.capacity}
                  {typeof c.bookedCount === "number" ? ` · ${c.bookedCount} booked` : ""}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
