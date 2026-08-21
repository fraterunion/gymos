"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { RegisterAttendanceModal } from "@/components/RegisterAttendanceModal";
import { ApiError } from "@/lib/api/errors";
import { adminPrimaryBtn, adminSecondaryBtn } from "@/lib/adminSurface";
import { staffCreateBooking, staffForceCheckIn, fetchMembers, type MemberListItem } from "@/lib/api/members";
import {
  fetchSessionOperational,
  type SessionOperationalDto,
  type SessionRosterEntry,
} from "@/lib/api/scheduleSession";
import {
  formatClassStatusLabel,
  formatOccupancyLabel,
  formatRosterStatus,
  occupancyToneClass,
} from "@/lib/scheduleOccupancy";
import { formatSeriesDayLabel } from "@/lib/scheduleConflictCopy";
import {
  canAddMemberToSession,
  canCancelSessionFromDrawer,
  canCheckInFromSession,
  canDuplicateSessionFromDrawer,
  canEditSessionFromDrawer,
  canRegisterWalkInAttendance,
} from "@/lib/scheduleSessionAccess";

function formatTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("es-MX", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

function formatDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("es-MX", {
    timeZone: tz,
    weekday: "long",
    day: "numeric",
    month: "short",
  }).format(new Date(iso));
}

function sessionClassIdOnly(session: SessionOperationalDto): string {
  return session.class.id;
}

function friendlyBookingError(e: unknown): string {
  if (e instanceof ApiError) {
    const m = e.message.toLowerCase();
    if (m.includes("not open for booking") || m.includes("already started")) {
      return "Esta clase ya no acepta reservaciones.";
    }
    if (m.includes("full") || m.includes("capacity")) return "La clase está llena.";
    if (m.includes("already") && m.includes("book")) return "Este miembro ya tiene reservación.";
    if (m.includes("entitlement") || m.includes("access") || m.includes("credits")) {
      return "La membresía no incluye acceso a esta clase.";
    }
    if (m.includes("overlap")) return "El miembro ya tiene otra reservación en ese horario.";
    if (e.status === 403) return "No tienes permiso para reservar.";
    return e.message;
  }
  return "No se pudo completar la reservación.";
}

function AddMemberPanel({
  studioId,
  classId,
  reservedUserIds,
  onClose,
  onAdded,
}: {
  studioId: string;
  classId: string;
  reservedUserIds: Set<string>;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [members, setMembers] = useState<MemberListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (debounced.length < 2) {
      setMembers([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void fetchMembers(studioId, { search: debounced, limit: 8 })
      .then((res) => {
        if (!cancelled) setMembers(res.data);
      })
      .catch(() => {
        if (!cancelled) setMembers([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [studioId, debounced]);

  const handleSelect = async (member: MemberListItem) => {
    if (reservedUserIds.has(member.userId)) {
      setError("Este miembro ya está en la lista.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await staffCreateBooking(studioId, member.userId, classId);
      onAdded();
      onClose();
    } catch (e) {
      setError(friendlyBookingError(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Agregar miembro</p>
        <button type="button" onClick={onClose} className="text-xs text-zinc-500 underline">
          Cancelar
        </button>
      </div>
      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Buscar por nombre o correo…"
        className="mt-2 w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm"
        autoFocus
      />
      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
      <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">
        {loading ? (
          <li className="py-2 text-xs text-zinc-400">Buscando…</li>
        ) : members.length === 0 && debounced.length >= 2 ? (
          <li className="py-2 text-xs text-zinc-400">Sin resultados</li>
        ) : (
          members.map((m) => (
            <li key={m.userId}>
              <button
                type="button"
                disabled={submitting}
                onClick={() => void handleSelect(m)}
                className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-sm hover:bg-white disabled:opacity-50"
              >
                <span>
                  {m.user.firstName} {m.user.lastName}
                  <span className="block text-xs text-zinc-400">{m.user.email}</span>
                </span>
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

function RosterRow({
  row,
  tz,
  canCheckIn,
  busy,
  onCheckIn,
}: {
  row: SessionRosterEntry;
  tz: string;
  canCheckIn: boolean;
  busy: boolean;
  onCheckIn: () => void;
}) {
  const attended = row.operationalStatus === "ATTENDED" || row.operationalStatus === "WALK_IN";
  return (
    <div className="flex items-start justify-between gap-3 border-b border-zinc-100 py-3 last:border-0">
      <div className="min-w-0">
        <Link
          href={`/members/${row.user.id}`}
          className="text-sm font-medium text-zinc-900 hover:underline"
        >
          {row.user.firstName} {row.user.lastName}
        </Link>
        <p className="text-xs text-zinc-500">
          {formatRosterStatus(row.operationalStatus, row.checkedInAt, tz)}
          {row.isWalkIn ? " · Sin reserva" : ""}
        </p>
      </div>
      {!attended && canCheckIn && row.bookingId ? (
        <button
          type="button"
          disabled={busy}
          onClick={onCheckIn}
          className="shrink-0 rounded-lg border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
        >
          {busy ? "…" : "Marcar asistencia"}
        </button>
      ) : null}
    </div>
  );
}

export function SessionDrawer({
  studioId,
  classId,
  timezone,
  role,
  onClose,
  onEdit,
  onManageSeries,
  onDuplicate,
  onCancel,
  onCalendarRefresh,
}: {
  studioId: string;
  classId: string;
  timezone: string;
  role: string | null | undefined;
  onClose: () => void;
  onEdit: (classId: string) => void;
  onManageSeries?: (scheduleTemplateId: string) => void;
  onDuplicate: (classId: string) => void;
  onCancel: (classId: string) => void;
  onCalendarRefresh: () => void;
}) {
  const [session, setSession] = useState<SessionOperationalDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [walkInOpen, setWalkInOpen] = useState(false);
  const [busyBookingId, setBusyBookingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchSessionOperational(studioId, classId);
      setSession(data);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo cargar la sesión.");
      setSession(null);
    } finally {
      setLoading(false);
    }
  }, [studioId, classId]);

  useEffect(() => {
    void load();
  }, [load]);

  const reservedUserIds = useMemo(
    () => new Set(session?.roster.map((r) => r.userId) ?? []),
    [session],
  );

  const occupancy = session
    ? formatOccupancyLabel(
        session.occupancy.booked,
        session.occupancy.capacity,
        session.occupancy.waitlist,
      )
    : null;

  const handleCheckIn = async (row: SessionRosterEntry) => {
    if (!row.bookingId) return;
    setBusyBookingId(row.bookingId);
    try {
      await staffForceCheckIn(studioId, row.userId, row.bookingId);
      await load();
      onCalendarRefresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo registrar asistencia.");
    } finally {
      setBusyBookingId(null);
    }
  };

  const handleMutationDone = async () => {
    await load();
    onCalendarRefresh();
  };

  return (
    <>
      <button
        type="button"
        aria-label="Cerrar panel"
        className="fixed inset-0 z-40 bg-zinc-900/20 backdrop-blur-[1px]"
        onClick={onClose}
      />
      <aside
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-zinc-200 bg-white shadow-xl"
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
          <p className="text-sm font-semibold text-zinc-900">Sesión</p>
          <button type="button" onClick={onClose} className="text-sm text-zinc-500 hover:text-zinc-800">
            Cerrar
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="space-y-3 animate-pulse">
              <div className="h-6 w-2/3 rounded bg-zinc-100" />
              <div className="h-4 w-1/2 rounded bg-zinc-100" />
              <div className="h-24 rounded-xl bg-zinc-100" />
            </div>
          ) : error && !session ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
              {error}
              <button type="button" className="ml-2 font-semibold underline" onClick={() => void load()}>
                Reintentar
              </button>
            </div>
          ) : session ? (
            <>
              {session.class.classTemplate.color ? (
                <div
                  className="mb-3 h-1 w-12 rounded-full"
                  style={{ backgroundColor: session.class.classTemplate.color }}
                />
              ) : null}
              <h2 className="text-xl font-semibold text-zinc-900">{session.class.classTemplate.name}</h2>
              <p className="mt-1 capitalize text-sm text-zinc-600">
                {formatDate(session.class.startsAt, timezone)}
              </p>
              <p className="text-sm text-zinc-600">
                {formatTime(session.class.startsAt, timezone)} – {formatTime(session.class.endsAt, timezone)}
              </p>
              <p className="mt-2 text-sm text-zinc-600">
                {session.class.instructor
                  ? `${session.class.instructor.firstName} ${session.class.instructor.lastName}`
                  : "Sin instructor asignado"}
              </p>
              <span className="mt-3 inline-block rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-700">
                {formatClassStatusLabel(session.class.status)}
              </span>

              {occupancy ? (
                <div className="mt-4 space-y-1 text-sm">
                  <p className={`font-medium ${occupancyToneClass(occupancy.tone)}`}>{occupancy.label}</p>
                  {session.occupancy.waitlist > 0 ? (
                    <p className="text-zinc-500">{session.occupancy.waitlist} en espera</p>
                  ) : null}
                  {session.occupancy.attended > 0 ? (
                    <p className="text-zinc-500">{session.occupancy.attended} asistieron</p>
                  ) : null}
                </div>
              ) : null}

              <section className="mt-6">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Reservas</h3>
                {session.roster.length === 0 ? (
                  <p className="mt-2 text-sm text-zinc-500">Aún no hay reservaciones para esta clase.</p>
                ) : (
                  <div className="mt-2">
                    {session.roster.map((row) => (
                      <RosterRow
                        key={row.userId}
                        row={row}
                        tz={timezone}
                        canCheckIn={canCheckInFromSession(role)}
                        busy={busyBookingId === row.bookingId}
                        onCheckIn={() => void handleCheckIn(row)}
                      />
                    ))}
                  </div>
                )}
                {canAddMemberToSession(role) && session.class.status === "SCHEDULED" ? (
                  addMemberOpen ? (
                    <AddMemberPanel
                      studioId={studioId}
                      classId={classId}
                      reservedUserIds={reservedUserIds}
                      onClose={() => setAddMemberOpen(false)}
                      onAdded={() => void handleMutationDone()}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => setAddMemberOpen(true)}
                      className="mt-3 text-sm font-medium text-zinc-800 underline"
                    >
                      + Agregar miembro
                    </button>
                  )
                ) : null}
                {canRegisterWalkInAttendance(role) && session.class.status === "SCHEDULED" ? (
                  <button
                    type="button"
                    onClick={() => setWalkInOpen(true)}
                    className="mt-2 block text-xs text-zinc-500 underline"
                  >
                    Registrar asistencia sin reserva
                  </button>
                ) : null}
              </section>

              {session.waitlist.length > 0 ? (
                <section className="mt-6">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Lista de espera</h3>
                  <ul className="mt-2 space-y-2">
                    {session.waitlist.map((w) => (
                      <li key={w.id} className="text-sm">
                        <Link href={`/members/${w.user.id}`} className="font-medium text-zinc-900 hover:underline">
                          {w.position}. {w.user.firstName} {w.user.lastName}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {session.seriesContext.isRecurring ? (
                <section className="mt-6 rounded-xl border border-zinc-100 bg-zinc-50/80 p-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Serie</h3>
                  <p className="mt-1 text-sm text-zinc-700">Semanal</p>
                  <p className="text-sm text-zinc-600">
                    {session.seriesContext.label ||
                      formatSeriesDayLabel(session.seriesContext.dayOfWeek, session.seriesContext.startTime)}
                  </p>
                  {canEditSessionFromDrawer(role) ? (
                    <button
                      type="button"
                      className="mt-2 text-sm font-medium text-indigo-700 underline"
                      onClick={() => {
                        if (
                          session.seriesContext.isRecurring &&
                          onManageSeries
                        ) {
                          onManageSeries(session.seriesContext.scheduleTemplateId);
                          return;
                        }
                        onEdit(sessionClassIdOnly(session));
                      }}
                    >
                      Administrar serie →
                    </button>
                  ) : null}
                </section>
              ) : null}

              {error ? <p className="mt-4 text-xs text-red-600">{error}</p> : null}
            </>
          ) : null}
        </div>

        {session ? (
          <div className="space-y-2 border-t border-zinc-100 px-5 py-4">
            {canEditSessionFromDrawer(role) ? (
              <button
                type="button"
                className={`${adminSecondaryBtn} w-full`}
                onClick={() => onEdit(sessionClassIdOnly(session))}
              >
                Editar clase
              </button>
            ) : null}
            {canDuplicateSessionFromDrawer(role) ? (
              <button
                type="button"
                className={`${adminSecondaryBtn} w-full`}
                onClick={() => onDuplicate(sessionClassIdOnly(session))}
              >
                Duplicar
              </button>
            ) : null}
            {canCancelSessionFromDrawer(role) && session.class.status === "SCHEDULED" ? (
              <button
                type="button"
                className="w-full rounded-xl border border-red-200 px-4 py-2.5 text-sm font-medium text-red-700 hover:bg-red-50"
                onClick={() => onCancel(sessionClassIdOnly(session))}
              >
                Cancelar clase
              </button>
            ) : null}
          </div>
        ) : null}
      </aside>

      {walkInOpen && session ? (
        <RegisterAttendanceModal
          studioId={studioId}
          classId={classId}
          classStartsAt={session.class.startsAt}
          timeZone={timezone}
          reservedUserIds={reservedUserIds}
          onClose={() => setWalkInOpen(false)}
          onRegistered={() => {
            setWalkInOpen(false);
            void handleMutationDone();
          }}
        />
      ) : null}
    </>
  );
}
