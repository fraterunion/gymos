"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DeskQrScanner } from "@/components/DeskQrScanner";
import { useDeskStudio } from "@/contexts/DeskStudioContext";
import { ApiError } from "@/lib/api/errors";
import {
  canOperateClassCheckIn,
  calendarDayKeyInZone,
  formatClassRange,
  todayKeyInZone,
} from "@/lib/datetime";
import {
  checkInManual,
  checkInWithQr,
  fetchClassAttendance,
  type AttendanceSummary,
} from "@/lib/api/checkIns";
import { fetchClassRoster, type RosterBooking } from "@/lib/api/roster";
import { fetchScheduledClassById, type ScheduledClassDto } from "@/lib/api/schedule";
import { fetchClassWaitlist, type ClassWaitlistEntry } from "@/lib/api/waitlist";
import { checkInDeskHref, scheduleHref } from "@/lib/classRosterNav";

function friendlyCheckInError(e: unknown): string {
  if (e instanceof TypeError) {
    return "Network error. Check your connection and try again.";
  }
  if (e instanceof ApiError) {
    const m = e.message.toLowerCase();
    if (m.includes("already checked in")) return "This member is already checked in.";
    if (m.includes("qr token already used") || m.includes("expired"))
      return "That code was already used or has expired. Ask the member to refresh their code.";
    if (m.includes("invalid") && m.includes("token"))
      return "That code could not be read. Check for typos or ask for a fresh code.";
    if (m.includes("outside") || m.includes("window") || m.includes("not yet available")) {
      return "Check-in is outside the allowed time window for this class.";
    }
    if (e.status === 403) return "You are not allowed to perform this check-in.";
    if (e.status === 0) return "Network error. Check your connection and try again.";
    return e.message;
  }
  return "Something went wrong.";
}

function attendanceByUserId(attendance: AttendanceSummary[]): Map<string, AttendanceSummary> {
  const map = new Map<string, AttendanceSummary>();
  for (const row of attendance) {
    if (!map.has(row.userId)) map.set(row.userId, row);
  }
  return map;
}

function RosterRowCard({
  booking,
  attendance,
  showCheckIn,
  busyBookingId,
  onManual,
}: {
  booking: RosterBooking;
  attendance: AttendanceSummary | undefined;
  showCheckIn: boolean;
  busyBookingId: string | null;
  onManual: (bookingId: string) => void;
}) {
  const checked = Boolean(attendance);
  return (
    <div className="rounded-xl border border-zinc-100 bg-zinc-50/80 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-900">
            {booking.user.firstName} {booking.user.lastName}
          </p>
          <p className="text-xs text-zinc-500">{booking.user.email}</p>
          {booking.user.phone ? (
            <p className="text-xs text-zinc-500">{booking.user.phone}</p>
          ) : null}
          {booking.createdAt ? (
            <p className="mt-1 text-[11px] text-zinc-400">
              Booked{" "}
              {new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(
                new Date(booking.createdAt),
              )}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {checked ? (
            <>
              <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800">
                ✓ Checked in
              </span>
              {attendance ? (
                <span className="text-[11px] text-zinc-500">
                  {new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(
                    new Date(attendance.checkedInAt),
                  )}
                </span>
              ) : null}
            </>
          ) : (
            <>
              <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-600">
                {booking.status}
              </span>
              {showCheckIn ? (
                <button
                  type="button"
                  disabled={busyBookingId === booking.id}
                  onClick={() => void onManual(booking.id)}
                  className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                >
                  {busyBookingId === booking.id ? "…" : "Check in"}
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ClassCheckInPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const classId = typeof params.classId === "string" ? params.classId : "";
  const { selected, selectedStudioId } = useDeskStudio();
  const studioId = selectedStudioId ?? "";
  const tz = selected?.studio.timezone ?? "UTC";

  const returnTo = searchParams.get("returnTo");
  const weekStart = searchParams.get("weekStart");
  const deskDate = searchParams.get("date");

  const [cls, setCls] = useState<ScheduledClassDto | null>(null);
  const [roster, setRoster] = useState<RosterBooking[]>([]);
  const [waitlist, setWaitlist] = useState<ClassWaitlistEntry[]>([]);
  const [rosterNote, setRosterNote] = useState<string | null>(null);
  const [waitlistNote, setWaitlistNote] = useState<string | null>(null);
  const [attendance, setAttendance] = useState<AttendanceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyBookingId, setBusyBookingId] = useState<string | null>(null);
  const [qrText, setQrText] = useState("");
  const [qrBusy, setQrBusy] = useState(false);
  const submitQrLockRef = useRef(false);
  const [flash, setFlash] = useState<{ type: "ok" | "warn" | "err"; text: string } | null>(null);

  const clsDayKey = cls ? calendarDayKeyInZone(cls.startsAt, tz) : null;
  const todayKey = useMemo(() => todayKeyInZone(tz), [tz]);
  const checkInWindowMinutes = cls?.checkInWindowMinutes ?? 15;
  const showCheckInOps = cls
    ? canOperateClassCheckIn(cls.startsAt, checkInWindowMinutes)
    : false;
  const attendanceMap = useMemo(() => attendanceByUserId(attendance), [attendance]);

  const backHref = useMemo(() => {
    if (returnTo === "schedule") return scheduleHref(weekStart ?? undefined);
    return checkInDeskHref(deskDate ?? clsDayKey ?? undefined);
  }, [returnTo, weekStart, deskDate, clsDayKey]);

  const bookedCount = cls?.bookedCount ?? roster.length;
  const waitlistCount = cls?.waitlistCount ?? waitlist.filter((w) => w.status === "WAITING").length;
  const checkedInCount = cls?.checkedInCount ?? attendance.length;
  const availableSpots = cls ? Math.max(0, cls.capacity - bookedCount) : 0;

  const loadAll = useCallback(async () => {
    if (!studioId || !classId) return;
    setLoading(true);
    setFlash(null);
    setRosterNote(null);
    setWaitlistNote(null);
    try {
      const [classRow, att] = await Promise.all([
        fetchScheduledClassById(studioId, classId),
        fetchClassAttendance(studioId, classId),
      ]);
      setCls(classRow);
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

      try {
        const w = await fetchClassWaitlist(studioId, classId);
        setWaitlist(w);
      } catch (e) {
        setWaitlist([]);
        if (e instanceof ApiError && (e.status === 403 || e.status === 401)) {
          setWaitlistNote("Waitlist is not available for this account.");
        }
      }
    } catch (e) {
      setCls(null);
      setAttendance([]);
      setRoster([]);
      setWaitlist([]);
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
    if (!studioId || !showCheckInOps) return;
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
      if (e instanceof ApiError && e.status === 400 && msg.toLowerCase().includes("window")) {
        void loadAll();
      }
    } finally {
      setBusyBookingId(null);
    }
  };

  const submitQrToken = useCallback(
    async (raw: string, options?: { clearPasteField?: boolean; keepExistingFlash?: boolean }) => {
      const trimmed = raw.trim();
      if (!studioId || !trimmed || !showCheckInOps) return { success: false as const };
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
    [studioId, showCheckInOps],
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
      <div className="rounded-2xl border border-zinc-200 bg-white p-8">
        <p className="text-sm text-zinc-600">This class could not be found for your studio.</p>
        <Link href={backHref} className="mt-4 inline-block text-sm font-semibold text-zinc-900 underline">
          Back
        </Link>
      </div>
    );
  }

  const backLabel =
    returnTo === "schedule" ? "← Calendar" : clsDayKey === todayKey ? "← Today" : "← Schedule";

  return (
    <div className="space-y-8">
      <div>
        <Link href={backHref} className="text-xs font-medium uppercase tracking-wide text-zinc-500 hover:text-zinc-800">
          {backLabel}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-900">{cls.classTemplate.name}</h1>
        <p className="mt-1 text-sm text-zinc-500">{formatClassRange(cls.startsAt, cls.endsAt, tz)}</p>
        {cls.instructor ? (
          <p className="mt-1 text-sm text-zinc-500">
            {cls.instructor.firstName} {cls.instructor.lastName}
          </p>
        ) : (
          <p className="mt-1 text-sm text-zinc-400">No instructor assigned</p>
        )}
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <span className="rounded-full bg-zinc-100 px-2.5 py-1 font-medium text-zinc-700">{cls.status}</span>
          <span className="rounded-full bg-zinc-100 px-2.5 py-1 font-medium text-zinc-700">
            Capacity {cls.capacity}
          </span>
          <span className="rounded-full bg-zinc-100 px-2.5 py-1 font-medium text-zinc-700">
            Booked {bookedCount}
          </span>
          <span className="rounded-full bg-zinc-100 px-2.5 py-1 font-medium text-zinc-700">
            Waitlist {waitlistCount}
          </span>
          <span className="rounded-full bg-zinc-100 px-2.5 py-1 font-medium text-zinc-700">
            Available {availableSpots}
          </span>
          <span className="rounded-full bg-emerald-100 px-2.5 py-1 font-medium text-emerald-800">
            Checked in {checkedInCount}
          </span>
        </div>
        {!showCheckInOps ? (
          <p className="mt-3 text-sm text-zinc-500">
            Check-in opens 15 minutes before class start and closes 30 minutes after start.
          </p>
        ) : null}
      </div>

      {flash ? (
        <div
          className={`rounded-xl border px-4 py-3 text-sm ${
            flash.type === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-900"
              : flash.type === "warn"
                ? "border-amber-200 bg-amber-50 text-amber-900"
                : "border-red-200 bg-red-50 text-red-900"
          }`}
        >
          {flash.text}
        </div>
      ) : null}

      {showCheckInOps ? (
        <div className="grid gap-8 lg:grid-cols-2">
          <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">QR check-in</h2>
            <p className="mt-2 text-sm leading-relaxed text-zinc-600">
              Scan with the desk camera, or paste the member&apos;s token if the camera is unavailable.
            </p>

            <div className="mt-5 rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
              <DeskQrScanner
                key={classId}
                enabled={Boolean(studioId && cls)}
                onScan={(token) => submitQrToken(token, { clearPasteField: false })}
              />
            </div>

            <div className="relative mt-6">
              <div className="absolute inset-x-0 top-0 flex items-center" aria-hidden>
                <div className="w-full border-t border-zinc-200" />
              </div>
              <div className="relative flex justify-center">
                <span className="bg-white px-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
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
                className="w-full resize-y rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 font-mono text-xs leading-relaxed text-zinc-900 outline-none ring-zinc-400 focus:ring-2"
              />
              <button
                type="submit"
                disabled={qrBusy || !qrText.trim()}
                className="w-full rounded-xl bg-zinc-900 py-3 text-sm font-semibold text-white disabled:opacity-50"
              >
                {qrBusy ? "Submitting…" : "Submit token"}
              </button>
            </form>
          </section>

          <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Attendance</h2>
              <button
                type="button"
                onClick={() => void loadAll()}
                className="text-xs font-semibold text-zinc-600 underline"
              >
                Refresh
              </button>
            </div>
            <p className="mt-2 text-sm text-zinc-600">{checkedInCount} checked in</p>
            {attendance.length === 0 ? (
              <p className="mt-6 text-center text-sm text-zinc-400">No check-ins yet for this class.</p>
            ) : (
              <ul className="mt-4 space-y-2">
                {attendance.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-center justify-between gap-3 rounded-xl border border-zinc-100 bg-zinc-50/80 px-3 py-2.5"
                  >
                    <div>
                      <p className="text-sm font-medium text-zinc-900">
                        {a.user.firstName} {a.user.lastName}
                      </p>
                      <p className="text-xs text-zinc-500">
                        {new Intl.DateTimeFormat(undefined, { timeStyle: "short", dateStyle: "short" }).format(
                          new Date(a.checkedInAt),
                        )}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                        a.checkInMethod === "QR"
                          ? "bg-violet-100 text-violet-800"
                          : "bg-sky-100 text-sky-800"
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
      ) : (
        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Attendance</h2>
            <button
              type="button"
              onClick={() => void loadAll()}
              className="text-xs font-semibold text-zinc-600 underline"
            >
              Refresh
            </button>
          </div>
          <p className="mt-2 text-sm text-zinc-600">{checkedInCount} checked in</p>
          {attendance.length === 0 ? (
            <p className="mt-6 text-center text-sm text-zinc-400">No check-ins recorded for this class.</p>
          ) : (
            <ul className="mt-4 space-y-2">
              {attendance.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-zinc-100 bg-zinc-50/80 px-3 py-2.5"
                >
                  <div>
                    <p className="text-sm font-medium text-zinc-900">
                      {a.user.firstName} {a.user.lastName}
                    </p>
                    <p className="text-xs text-zinc-500">
                      {new Intl.DateTimeFormat(undefined, { timeStyle: "short", dateStyle: "short" }).format(
                        new Date(a.checkedInAt),
                      )}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-800">
                    {a.checkInMethod}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Confirmed roster</h2>
          <button
            type="button"
            onClick={() => void loadAll()}
            className="text-xs font-semibold text-zinc-600 underline"
          >
            Refresh
          </button>
        </div>
        {rosterNote ? <p className="mt-3 text-sm text-amber-800">{rosterNote}</p> : null}
        {roster.length === 0 && !rosterNote ? (
          <p className="mt-4 text-sm text-zinc-500">No confirmed bookings for this class.</p>
        ) : roster.length === 0 ? null : (
          <>
            <div className="mt-4 hidden overflow-x-auto md:block">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead>
                  <tr className="border-b border-zinc-100 text-xs uppercase tracking-wide text-zinc-500">
                    <th className="py-2 pr-4 font-semibold">Member</th>
                    <th className="py-2 pr-4 font-semibold">Contact</th>
                    <th className="py-2 pr-4 font-semibold">Status</th>
                    <th className="py-2 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {roster.map((b) => {
                    const att = attendanceMap.get(b.userId);
                    const checked = Boolean(att);
                    return (
                      <tr key={b.id}>
                        <td className="py-3 pr-4">
                          <p className="font-medium text-zinc-900">
                            {b.user.firstName} {b.user.lastName}
                          </p>
                          {b.createdAt ? (
                            <p className="text-xs text-zinc-400">
                              Booked{" "}
                              {new Intl.DateTimeFormat(undefined, {
                                dateStyle: "short",
                                timeStyle: "short",
                              }).format(new Date(b.createdAt))}
                            </p>
                          ) : null}
                        </td>
                        <td className="py-3 pr-4 text-xs text-zinc-500">
                          <p>{b.user.email}</p>
                          {b.user.phone ? <p>{b.user.phone}</p> : null}
                        </td>
                        <td className="py-3 pr-4">
                          {checked ? (
                            <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800">
                              Checked in
                              {att
                                ? ` · ${new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(
                                    new Date(att.checkedInAt),
                                  )}`
                                : ""}
                            </span>
                          ) : (
                            <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-600">
                              {b.status}
                            </span>
                          )}
                        </td>
                        <td className="py-3 text-right">
                          {!checked && showCheckInOps ? (
                            <button
                              type="button"
                              disabled={busyBookingId === b.id}
                              onClick={() => void onManual(b.id)}
                              className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                            >
                              {busyBookingId === b.id ? "…" : "Check in"}
                            </button>
                          ) : (
                            <span className="text-xs text-zinc-400">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-4 space-y-2 md:hidden">
              {roster.map((b) => (
                <RosterRowCard
                  key={b.id}
                  booking={b}
                  attendance={attendanceMap.get(b.userId)}
                  showCheckIn={showCheckInOps}
                  busyBookingId={busyBookingId}
                  onManual={onManual}
                />
              ))}
            </div>
          </>
        )}
      </section>

      {waitlist.length > 0 || waitlistNote ? (
        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Waitlist</h2>
          {waitlistNote ? <p className="mt-3 text-sm text-amber-800">{waitlistNote}</p> : null}
          {waitlist.length === 0 ? (
            <p className="mt-4 text-sm text-zinc-500">No one on the waitlist.</p>
          ) : (
            <ul className="mt-4 divide-y divide-zinc-100">
              {waitlist.map((w) => (
                <li key={w.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0">
                  <div>
                    <p className="text-sm font-medium text-zinc-900">
                      {w.user.firstName} {w.user.lastName}
                    </p>
                    <p className="text-xs text-zinc-500">{w.user.email}</p>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="rounded-full bg-amber-100 px-2.5 py-1 font-semibold text-amber-900">
                      {w.status}
                    </span>
                    {w.queueRank != null ? (
                      <span className="text-zinc-500">#{w.queueRank}</span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
