"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DeskQrScanner } from "@/components/DeskQrScanner";
import { useDeskStudio } from "@/contexts/DeskStudioContext";
import { ApiError } from "@/lib/api/errors";
import { buildScheduleQueryRange, formatClassRange } from "@/lib/datetime";
import {
  checkInManual,
  checkInWithQr,
  fetchClassAttendance,
  type AttendanceSummary,
} from "@/lib/api/checkIns";
import { fetchClassRoster, type RosterBooking } from "@/lib/api/roster";
import { fetchStudioSchedule, type ScheduledClassDto } from "@/lib/api/schedule";

function friendlyCheckInError(e: unknown): string {
  if (e instanceof TypeError) {
    return "Network error. Check your connection and try again.";
  }
  if (e instanceof ApiError) {
    const m = e.message.toLowerCase();
    if (m.includes("already checked in")) return "This member is already checked in.";
    if (m.includes("qr token already used") || m.includes("expired")) return "That code was already used or has expired. Ask the member to refresh their code.";
    if (m.includes("invalid") && m.includes("token")) return "That code could not be read. Check for typos or ask for a fresh code.";
    if (m.includes("outside") || m.includes("window")) return "Check-in is outside the allowed time window for this class.";
    if (e.status === 403) return "You are not allowed to perform this check-in.";
    if (e.status === 0) return "Network error. Check your connection and try again.";
    return e.message;
  }
  return "Something went wrong.";
}

export default function ClassCheckInPage() {
  const params = useParams();
  const classId = typeof params.classId === "string" ? params.classId : "";
  const { selected, selectedStudioId } = useDeskStudio();
  const studioId = selectedStudioId ?? "";
  const tz = selected?.studio.timezone ?? "UTC";

  const [cls, setCls] = useState<ScheduledClassDto | null>(null);
  const [roster, setRoster] = useState<RosterBooking[]>([]);
  const [rosterNote, setRosterNote] = useState<string | null>(null);
  const [attendance, setAttendance] = useState<AttendanceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyBookingId, setBusyBookingId] = useState<string | null>(null);
  const [qrText, setQrText] = useState("");
  const [qrBusy, setQrBusy] = useState(false);
  const submitQrLockRef = useRef(false);
  const [flash, setFlash] = useState<{ type: "ok" | "warn" | "err"; text: string } | null>(null);

  const attendedUserIds = useMemo(() => new Set(attendance.map((a) => a.userId)), [attendance]);

  const loadAll = useCallback(async () => {
    if (!studioId || !classId) return;
    setLoading(true);
    setFlash(null);
    setRosterNote(null);
    try {
      const range = buildScheduleQueryRange();
      const [scheduleRows, att] = await Promise.all([
        fetchStudioSchedule(studioId, range.from, range.to),
        fetchClassAttendance(studioId, classId),
      ]);
      const found = scheduleRows.find((c) => c.id === classId) ?? null;
      setCls(found);
      setAttendance(att);

      try {
        const r = await fetchClassRoster(studioId, classId);
        setRoster(r);
      } catch (e) {
        setRoster([]);
        if (e instanceof ApiError && (e.status === 403 || e.status === 401)) {
          setRosterNote("You do not have access to the class roster for this account.");
        } else if (e instanceof ApiError && e.status === 404) {
          setRosterNote("Class roster could not be loaded.");
        } else {
          setRosterNote(e instanceof ApiError ? e.message : "Could not load roster.");
        }
      }
    } catch (e) {
      setCls(null);
      setAttendance([]);
      setRoster([]);
      setFlash({ type: "err", text: e instanceof ApiError ? e.message : "Could not load class." });
    } finally {
      setLoading(false);
    }
  }, [studioId, classId]);

  useEffect(() => {
    const t = setTimeout(() => void loadAll(), 0);
    return () => clearTimeout(t);
  }, [loadAll]);

  const onManual = async (bookingId: string) => {
    if (!studioId) return;
    setBusyBookingId(bookingId);
    setFlash(null);
    try {
      const row = await checkInManual(studioId, bookingId);
      setAttendance((prev) => [...prev.filter((a) => a.userId !== row.userId), row]);
      setFlash({
        type: "ok",
        text: `Checked in ${row.user.firstName} ${row.user.lastName}.`,
      });
    } catch (e) {
      const msg = friendlyCheckInError(e);
      if (e instanceof ApiError && e.status === 409 && msg.includes("already")) {
        setFlash({ type: "warn", text: msg });
      } else {
        setFlash({ type: "err", text: msg });
      }
    } finally {
      setBusyBookingId(null);
    }
  };

  const submitQrToken = useCallback(
    async (raw: string, options?: { clearPasteField?: boolean; keepExistingFlash?: boolean }) => {
      const trimmed = raw.trim();
      if (!studioId || !trimmed) return { success: false as const };
      if (submitQrLockRef.current) return { success: false as const };
      submitQrLockRef.current = true;
      setQrBusy(true);
      if (!options?.keepExistingFlash) setFlash(null);
      try {
        const row = await checkInWithQr(studioId, trimmed);
        if (options?.clearPasteField !== false) setQrText("");
        setAttendance((prev) => [...prev.filter((a) => a.userId !== row.userId), row]);
        setFlash({
          type: "ok",
          text: `Checked in ${row.user.firstName} ${row.user.lastName} via QR.`,
        });
        return { success: true as const };
      } catch (e) {
        const msg = friendlyCheckInError(e);
        if (e instanceof ApiError && e.status === 409) {
          setFlash({ type: "warn", text: msg });
        } else {
          setFlash({ type: "err", text: msg });
        }
        return { success: false as const };
      } finally {
        submitQrLockRef.current = false;
        setQrBusy(false);
      }
    },
    [studioId],
  );

  const onQrSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void submitQrToken(qrText, { clearPasteField: true });
  };

  if (!studioId) {
    return null;
  }

  if (loading && !cls) {
    return <p className="text-sm text-zinc-500">Loading class…</p>;
  }

  if (!cls) {
    return (
      <div className="rounded-2xl border border-zinc-200 bg-white p-8 dark:border-zinc-800 dark:bg-zinc-900">
        <p className="text-sm text-zinc-600 dark:text-zinc-300">This class is not on the current schedule window.</p>
        <Link href="/check-in" className="mt-4 inline-block text-sm font-semibold text-zinc-900 underline dark:text-zinc-100">
          Back to today
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <Link href="/check-in" className="text-xs font-medium uppercase tracking-wide text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
          ← Today
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{cls.classTemplate.name}</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{formatClassRange(cls.startsAt, cls.endsAt, tz)}</p>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <span className="rounded-full bg-zinc-100 px-2.5 py-1 font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
            {cls.status}
          </span>
          <span className="rounded-full bg-zinc-100 px-2.5 py-1 font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
            Capacity {cls.capacity}
          </span>
        </div>
      </div>

      {flash ? (
        <div
          className={`rounded-xl border px-4 py-3 text-sm ${
            flash.type === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/40 dark:text-emerald-100"
              : flash.type === "warn"
                ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/40 dark:text-amber-100"
                : "border-red-200 bg-red-50 text-red-900 dark:border-red-900/40 dark:bg-red-950/40 dark:text-red-100"
          }`}
        >
          {flash.text}
        </div>
      ) : null}

      <div className="grid gap-8 lg:grid-cols-2">
        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">QR check-in</h2>
          <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
            Scan with the desk camera, or paste the member&apos;s token if the camera is unavailable.
          </p>

          <div className="mt-5 rounded-2xl border border-zinc-800 bg-zinc-950 p-4 shadow-inner dark:border-zinc-700 dark:bg-zinc-950">
            <DeskQrScanner
              key={classId}
              enabled={Boolean(studioId && cls)}
              onScan={(token) => submitQrToken(token, { clearPasteField: false })}
            />
          </div>

          <div className="relative mt-6">
            <div className="absolute inset-x-0 top-0 flex items-center" aria-hidden>
              <div className="w-full border-t border-zinc-200 dark:border-zinc-700" />
            </div>
            <div className="relative flex justify-center">
              <span className="bg-white px-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:bg-zinc-900 dark:text-zinc-500">
                Or paste token
              </span>
            </div>
          </div>

          <form onSubmit={onQrSubmit} className="mt-4 space-y-3">
            <textarea
              value={qrText}
              onChange={(e) => setQrText(e.target.value)}
              placeholder="Paste token here…"
              rows={5}
              autoComplete="off"
              spellCheck={false}
              className="w-full resize-y rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 font-mono text-xs leading-relaxed text-zinc-900 outline-none ring-zinc-400 focus:ring-2 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
            />
            <button
              type="submit"
              disabled={qrBusy || !qrText.trim()}
              className="w-full rounded-xl bg-zinc-900 py-3 text-sm font-semibold text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
            >
              {qrBusy ? "Submitting…" : "Submit token"}
            </button>
          </form>
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Attendance</h2>
            <button
              type="button"
              onClick={() => void loadAll()}
              className="text-xs font-semibold text-zinc-600 underline dark:text-zinc-300"
            >
              Refresh
            </button>
          </div>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">{attendance.length} checked in</p>
          {attendance.length === 0 ? (
            <p className="mt-6 text-center text-sm text-zinc-400 dark:text-zinc-500">No check-ins yet for this class.</p>
          ) : (
            <ul className="mt-4 space-y-2">
              {attendance.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-zinc-100 bg-zinc-50/80 px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-950/50"
                >
                  <div>
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
                      {a.user.firstName} {a.user.lastName}
                    </p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      {new Intl.DateTimeFormat(undefined, { timeStyle: "short", dateStyle: "short" }).format(
                        new Date(a.checkedInAt),
                      )}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                      a.checkInMethod === "QR"
                        ? "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200"
                        : "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200"
                    }`}
                  >
                    {a.checkInMethod}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Confirmed roster</h2>
        {rosterNote ? <p className="mt-3 text-sm text-amber-800 dark:text-amber-200/90">{rosterNote}</p> : null}
        {roster.length === 0 && !rosterNote ? (
          <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">No confirmed bookings for this class.</p>
        ) : roster.length === 0 ? null : (
          <ul className="mt-4 divide-y divide-zinc-100 dark:divide-zinc-800">
            {roster.map((b) => {
              const checked = attendedUserIds.has(b.userId);
              return (
                <li key={b.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0">
                  <div>
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
                      {b.user.firstName} {b.user.lastName}
                    </p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">{b.user.email}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {checked ? (
                      <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">
                        ✓ In
                      </span>
                    ) : (
                      <>
                        <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                          Booked
                        </span>
                        <button
                          type="button"
                          disabled={busyBookingId === b.id}
                          onClick={() => void onManual(b.id)}
                          className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
                        >
                          {busyBookingId === b.id ? "…" : "Check in"}
                        </button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
