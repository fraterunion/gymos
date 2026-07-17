"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiError } from "@/lib/api/errors";
import { registerManualClassAttendance, type AttendanceSummary } from "@/lib/api/checkIns";
import { fetchMembers, type MemberListItem } from "@/lib/api/members";
import {
  adminInput,
  adminModalOverlay,
  adminModalPanel,
  adminPrimaryBtn,
  adminSecondaryBtn,
} from "@/lib/adminSurface";

type Step = "search" | "confirm";

function memberInitials(firstName: string, lastName: string): string {
  return `${firstName[0] ?? ""}${lastName[0] ?? ""}`.toUpperCase();
}

function isActiveMember(member: MemberListItem): boolean {
  const status = member.subscription?.status;
  return status === "ACTIVE" || status === "TRIALING";
}

function formatManualClassDate(iso: string | undefined, timeZone: string): string | null {
  if (!iso) return null;
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(iso));
}

function friendlyRegisterError(e: unknown): string {
  if (e instanceof ApiError) {
    const m = e.message.toLowerCase();
    if (m.includes("already registered")) return "Attendance already registered.";
    if (m.includes("inactive")) return "Cannot register attendance because this membership is inactive.";
    if (m.includes("cancelled")) return "Cannot register attendance for a cancelled class.";
    if (e.status === 403) return "You are not allowed to register attendance.";
    return e.message;
  }
  return "Something went wrong.";
}

export function RegisterAttendanceModal({
  studioId,
  classId,
  classStartsAt,
  timeZone,
  reservedUserIds,
  onClose,
  onRegistered,
}: {
  studioId: string;
  classId: string;
  classStartsAt?: string;
  timeZone: string;
  reservedUserIds: Set<string>;
  onClose: () => void;
  onRegistered: (row: AttendanceSummary) => void;
}) {
  const [step, setStep] = useState<Step>("search");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [members, setMembers] = useState<MemberListItem[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selected, setSelected] = useState<MemberListItem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 200);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (!studioId) return;
    let cancelled = false;
    const run = async () => {
      setSearchLoading(true);
      setError(null);
      try {
        const res = await fetchMembers(studioId, {
          search: debouncedSearch || undefined,
          role: "MEMBER",
          sortBy: "name",
          sortDir: "asc",
          limit: 50,
        });
        if (cancelled) return;
        setMembers(res.data.filter(isActiveMember));
      } catch (e) {
        if (!cancelled) {
          setMembers([]);
          setError(e instanceof ApiError ? e.message : "Could not search members.");
        }
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [studioId, debouncedSearch]);

  const classDateLabel = useMemo(
    () => formatManualClassDate(classStartsAt, timeZone),
    [classStartsAt, timeZone],
  );

  const hasReservation = useMemo(
    () => (selected ? reservedUserIds.has(selected.user.id) : false),
    [selected, reservedUserIds],
  );

  const selectMember = useCallback((member: MemberListItem) => {
    setSelected(member);
    setStep("confirm");
    setError(null);
  }, []);

  const backToSearch = useCallback(() => {
    setStep("search");
    setSelected(null);
    setError(null);
  }, []);

  const submit = useCallback(async () => {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    try {
      const row = await registerManualClassAttendance(studioId, classId, selected.user.id);
      onRegistered(row);
      onClose();
    } catch (e) {
      setError(friendlyRegisterError(e));
    } finally {
      setSubmitting(false);
    }
  }, [selected, studioId, classId, onRegistered, onClose]);

  return (
    <div className={adminModalOverlay} onClick={onClose}>
      <div className={`${adminModalPanel} max-h-[85vh] overflow-y-auto`} onClick={(e) => e.stopPropagation()}>
        {step === "search" ? (
          <>
            <h2 className="text-lg font-semibold text-zinc-900">Register Attendance</h2>
            <p className="mt-1 text-sm text-zinc-500">Select a member who attended this class.</p>

            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search members…"
              autoFocus
              className={`${adminInput} mt-5`}
            />

            {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}

            <ul className="mt-4 divide-y divide-zinc-100">
              {searchLoading && members.length === 0 ? (
                <li className="py-6 text-center text-sm text-zinc-400">Searching…</li>
              ) : null}
              {!searchLoading && members.length === 0 ? (
                <li className="py-6 text-center text-sm text-zinc-400">No active members found.</li>
              ) : null}
              {members.map((member) => (
                <li key={member.membershipId}>
                  <button
                    type="button"
                    onClick={() => selectMember(member)}
                    className="flex w-full items-start gap-3 py-3 text-left transition hover:bg-zinc-50"
                  >
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-sm font-semibold text-zinc-700">
                      {memberInitials(member.user.firstName, member.user.lastName)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-zinc-900">
                        {member.user.firstName} {member.user.lastName}
                      </p>
                      <p className="truncate text-sm text-zinc-600">{member.user.email}</p>
                      {member.subscription ? (
                        <p className="mt-0.5 text-xs text-zinc-500">{member.subscription.planName}</p>
                      ) : null}
                    </div>
                  </button>
                </li>
              ))}
            </ul>

            <div className="mt-6 flex justify-end">
              <button type="button" onClick={onClose} className={adminSecondaryBtn}>
                Cancel
              </button>
            </div>
          </>
        ) : selected ? (
          <>
            <h2 className="text-lg font-semibold text-zinc-900">
              {selected.user.firstName} {selected.user.lastName}
            </h2>
            <p className="mt-1 text-sm text-zinc-500">
              {selected.subscription?.planName ?? "Active membership"}
            </p>
            {classDateLabel ? (
              <p className="mt-2 text-sm text-zinc-500">This class was on {classDateLabel}.</p>
            ) : null}
            <p className="mt-4 text-sm leading-relaxed text-zinc-700">Register manual attendance?</p>
            {hasReservation ? (
              <p className="mt-2 text-sm text-zinc-500">
                This member already has a reservation for this class.
              </p>
            ) : null}

            {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}

            <div className="mt-6 flex flex-wrap justify-end gap-2">
              <button type="button" onClick={backToSearch} className={adminSecondaryBtn} disabled={submitting}>
                Cancel
              </button>
              <button type="button" onClick={() => void submit()} className={adminPrimaryBtn} disabled={submitting}>
                {submitting ? "Registering…" : "Register Attendance"}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function AttendanceMethodBadge({ method }: { method: string }) {
  if (method === "MANUAL") {
    return (
      <span className="shrink-0 rounded-full border border-zinc-200 bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-600">
        Manual
      </span>
    );
  }
  if (method === "QR") {
    return (
      <span className="shrink-0 rounded-full border border-zinc-200 bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-600">
        QR
      </span>
    );
  }
  return (
    <span className="shrink-0 rounded-full border border-zinc-200 bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-600">
      {method}
    </span>
  );
}

export { AttendanceMethodBadge };
