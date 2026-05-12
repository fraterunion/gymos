"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useDeskStudio } from "@/contexts/DeskStudioContext";
import { buildScheduleQueryRange, calendarDayKeyInZone, formatClassRange, todayKeyInZone } from "@/lib/datetime";
import { fetchStudioSchedule, type ScheduledClassDto } from "@/lib/api/schedule";
import { ApiError } from "@/lib/api/errors";

export default function CheckInTodayPage() {
  const { selected, selectedStudioId, loading: studioLoading, error: studioError } = useDeskStudio();
  const [classes, setClasses] = useState<ScheduledClassDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const tz = selected?.studio.timezone ?? "UTC";
  const todayKey = useMemo(() => todayKeyInZone(tz), [tz]);

  const load = useCallback(async () => {
    if (!selectedStudioId) {
      setClasses([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const range = buildScheduleQueryRange();
      const rows = await fetchStudioSchedule(selectedStudioId, range.from, range.to);
      setClasses(rows);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not load schedule");
      setClasses([]);
    } finally {
      setLoading(false);
    }
  }, [selectedStudioId]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  const todaysClasses = useMemo(() => {
    return classes
      .filter((c) => c.status === "SCHEDULED" && calendarDayKeyInZone(c.startsAt, tz) === todayKey)
      .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  }, [classes, todayKey, tz]);

  if (studioLoading) {
    return <p className="text-sm text-zinc-500">Loading studios…</p>;
  }

  if (studioError) {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200">
        {studioError}
      </div>
    );
  }

  if (!selectedStudioId) {
    return (
      <div className="rounded-2xl border border-zinc-200 bg-white p-8 text-center dark:border-zinc-800 dark:bg-zinc-900">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">No studio memberships found for this account.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">Today&apos;s classes</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Select a class to scan QR codes, run manual check-ins, and view attendance.
        </p>
      </div>
      {error ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-100">
          {error}
          <button type="button" className="ml-3 font-semibold underline" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : null}
      {loading ? (
        <p className="text-sm text-zinc-500">Loading schedule…</p>
      ) : todaysClasses.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 bg-white/60 px-6 py-14 text-center dark:border-zinc-700 dark:bg-zinc-900/40">
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">No scheduled classes today</p>
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">When classes are on the schedule, they will appear here.</p>
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {todaysClasses.map((c) => (
            <li key={c.id}>
              <Link
                href={`/check-in/${c.id}`}
                className="block rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm transition hover:border-zinc-300 hover:shadow dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-600"
              >
                <div className="flex items-start justify-between gap-2">
                  <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">{c.classTemplate.name}</h2>
                  <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200">
                    Scheduled
                  </span>
                </div>
                <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">{formatClassRange(c.startsAt, c.endsAt, tz)}</p>
                {c.instructor ? (
                  <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
                    {c.instructor.firstName} {c.instructor.lastName}
                  </p>
                ) : null}
                <p className="mt-3 text-xs font-medium text-zinc-400 dark:text-zinc-500">Capacity {c.capacity}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
