"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { useDeskStudio } from "@/contexts/DeskStudioContext";
import {
  fetchMemberAttendanceLog,
  createMemberOperationalNote,
  fetchMemberBookings,
  fetchMemberCrmProfile,
  fetchMemberPayments,
  fetchMemberProfile,
  fetchMemberOperationalNotes,
  fetchMemberSubscriptions,
  fetchMemberTimeline,
  fetchPlanChangePreview,
  staffCancelBooking,
  staffForceCheckIn,
  staffMarkNoShow,
  updateMemberCrmProfile,
  updateSubscriptionStatus,
  type AttendanceLogEntry,
  type MemberBooking,
  type MemberCrmProfile,
  type MemberPayment,
  type MemberOperationalNote,
  type MemberPlan,
  type MemberProfile,
  type MemberSubscription,
  type PlanChangePreview,
  type SubStatus,
  type TimelineEvent,
  type UpsertCrmProfileInput,
} from "@/lib/api/members";
import { fetchMembershipPlans, type MembershipPlanDto } from "@/lib/api/memberships";
import { createStaffCheckoutSession, type StaffCheckoutResult } from "@/lib/api/sales";
import { ApiError } from "@/lib/api/errors";
import { nextClassPresentation, PRIMARY_STATUS_COLORS, PRIMARY_STATUS_LABELS, renewalPresentation, studioDate, visitPresentation } from "@/lib/memberPresentation";
import { subscriptionTransitionPresentation } from "@/lib/membershipPlanSummary";
import { allowedClassPresentation, billingOperationalState, cyclePayment, member360Actions, paymentSourceLabel, renewalBehavior, usagePresentation } from "@/lib/member360";
import {
  attestMemberWaiver,
  fetchMemberWaiverStatus,
  waiverStatusLabel,
  type MemberWaiverStatus,
} from "@/lib/api/waiver";

// ── Helpers ──────────────────────────────────────────────────────────────────

function initials(first: string, last: string) {
  return `${first[0] ?? ""}${last[0] ?? ""}`.toUpperCase();
}

function fmtDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function fmtDateTime(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtMoney(cents: number, currency = "usd") {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

function daysAgo(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

const SUB_STATUS_LABELS: Record<SubStatus, string> = {
  ACTIVE: "Activa",
  TRIALING: "Prueba",
  PAST_DUE: "Pago pendiente",
  PAUSED: "Pausada",
  CANCELED: "Cancelada",
};

const SUB_STATUS_COLORS: Record<SubStatus, string> = {
  ACTIVE: "bg-emerald-100 text-emerald-800",
  TRIALING: "bg-sky-100 text-sky-800",
  PAST_DUE: "bg-amber-100 text-amber-800",
  PAUSED: "bg-zinc-100 text-zinc-600",
  CANCELED: "bg-red-100 text-red-700",
};

const LIFECYCLE_LABELS = {
  ...SUB_STATUS_LABELS,
  ENDING: "Activa",
  SCHEDULED: "Programada",
  EXPIRED: "Vencida",
} as const;

const LIFECYCLE_COLORS = {
  ...SUB_STATUS_COLORS,
  ENDING: "bg-emerald-100 text-emerald-800",
  SCHEDULED: "bg-sky-100 text-sky-800",
  EXPIRED: "bg-red-100 text-red-700",
} as const;

const BOOKING_STATUS_COLORS: Record<string, string> = {
  CONFIRMED: "bg-emerald-100 text-emerald-800",
  CANCELLED: "bg-red-100 text-red-700",
  NO_SHOW: "bg-amber-100 text-amber-800",
  COMPLETED: "bg-blue-100 text-blue-800",
  PENDING: "bg-zinc-100 text-zinc-600",
};
const BOOKING_STATUS_LABELS: Record<string, string> = { PENDING: "Pendiente", CONFIRMED: "Confirmada", CANCELLED: "Cancelada", NO_SHOW: "No-show", COMPLETED: "Completada" };

const PAYMENT_STATUS_COLORS: Record<string, string> = {
  SUCCEEDED: "bg-emerald-100 text-emerald-800",
  FAILED: "bg-red-100 text-red-700",
  PENDING: "bg-zinc-100 text-zinc-600",
  REFUNDED: "bg-blue-100 text-blue-800",
  PARTIALLY_REFUNDED: "bg-amber-100 text-amber-800",
};
const PAYMENT_STATUS_LABELS: Record<string, string> = { PENDING: "Pendiente", SUCCEEDED: "Pagado", FAILED: "Fallido", REFUNDED: "Reembolsado", PARTIALLY_REFUNDED: "Reembolso parcial" };
const MEMBER_ROLE_LABELS: Record<string, string> = { MEMBER: "Miembro", OWNER: "Propietario", ADMIN: "Administrador", STAFF: "Staff", FRONT_DESK: "Recepción", INSTRUCTOR: "Instructor" };

const PRESET_TAGS = [
  "VIP", "New", "At Risk", "PT Client", "Trial",
  "Injured", "High Value", "Needs Follow-up",
];

// ── Smart badge computation ────────────────────────────────────────────────────

type SmartBadge = { label: string; color: string };

function computeBadges(
  profile: MemberProfile,
  crm: MemberCrmProfile | null,
): SmartBadge[] {
  const badges: SmartBadge[] = [];
  const memberDays = daysAgo(profile.membership.createdAt);

  if (memberDays <= 30) {
    badges.push({ label: "Miembro nuevo", color: "bg-sky-100 text-sky-800" });
  }
  if (profile.bookingStats.noShowCount > 0) {
    badges.push({ label: `${profile.bookingStats.noShowCount} No-show${profile.bookingStats.noShowCount > 1 ? "s" : ""}`, color: "bg-amber-100 text-amber-800" });
  }
  if (crm?.tags.includes("VIP")) {
    badges.push({ label: "VIP", color: "bg-purple-100 text-purple-800" });
  }
  if (crm?.tags.includes("At Risk")) {
    badges.push({ label: "En seguimiento", color: "bg-red-100 text-red-700" });
  }
  if (crm?.tags.includes("Injured")) {
    badges.push({ label: "Con lesión reportada", color: "bg-orange-100 text-orange-800" });
  }
  return badges;
}

// ── Skeletons ─────────────────────────────────────────────────────────────────

function CardSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm space-y-3">
      {[...Array(lines)].map((_, i) => (
        <div key={i} className="h-4 rounded bg-zinc-200 animate-pulse" style={{ width: `${50 + (i * 23) % 50}%` }} />
      ))}
    </div>
  );
}

function TableSkeleton({ cols = 4 }: { cols?: number }) {
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
      <table className="min-w-full divide-y divide-zinc-100">
        <tbody className="divide-y divide-zinc-100">
          {[...Array(5)].map((_, i) => (
            <tr key={i}>
              {[...Array(cols)].map((_, j) => (
                <td key={j} className="px-4 py-3">
                  <div className="h-4 rounded bg-zinc-200 animate-pulse" style={{ width: `${40 + (j * 19) % 50}%` }} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-zinc-900">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-zinc-400">{sub}</p>}
    </div>
  );
}

function SubStatusBadge({ status }: { status: SubStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${SUB_STATUS_COLORS[status]}`}>
      {SUB_STATUS_LABELS[status]}
    </span>
  );
}

function Pagination({
  page,
  total,
  limit,
  onPage,
}: {
  page: number;
  total: number;
  limit: number;
  onPage: (p: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between border-t border-zinc-100 px-4 py-3">
      <p className="text-xs text-zinc-500">Página {page} de {totalPages}</p>
      <div className="flex gap-2">
        <button
          onClick={() => onPage(Math.max(1, page - 1))}
          disabled={page === 1}
          className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 disabled:opacity-40 hover:bg-zinc-50"
        >
          Anterior
        </button>
        <button
          onClick={() => onPage(Math.min(totalPages, page + 1))}
          disabled={page === totalPages}
          className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 disabled:opacity-40 hover:bg-zinc-50"
        >
          Siguiente
        </button>
      </div>
    </div>
  );
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

type Tab = "overview" | "membership" | "bookings" | "attendance" | "billing" | "notes" | "timeline";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Resumen" },
  { id: "membership", label: "Membresía" },
  { id: "bookings", label: "Reservas" },
  { id: "attendance", label: "Asistencia" },
  { id: "billing", label: "Facturación" },
  { id: "notes", label: "Notas y CRM" },
  { id: "timeline", label: "Historial" },
];

// ── Bookings tab ──────────────────────────────────────────────────────────────

function BookingsTab({ studioId, userId, studioRole }: { studioId: string; userId: string; studioRole: string | null }) {
  const [bookings, setBookings] = useState<MemberBooking[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState({ upcoming: 0, completed: 0, cancelled: 0, noShows: 0 });
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const limit = 20;
  const canOperateBookings = studioRole === "OWNER" || studioRole === "ADMIN" || studioRole === "STAFF";

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchMemberBookings(studioId, userId, page, limit);
      setBookings(res.data);
      setTotal(res.total);
      setSummary(res.summary);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudieron cargar las reservas");
    } finally {
      setLoading(false);
    }
  }, [studioId, userId, page, limit]);

  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);

  async function handleCancel(bookingId: string) {
    setActionLoading(bookingId);
    setActionError(null);
    try {
      await staffCancelBooking(studioId, userId, bookingId);
      await load();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : "No se pudo cancelar la reserva");
    } finally {
      setActionLoading(null);
    }
  }

  async function handleCheckIn(bookingId: string) {
    setActionLoading(`ci-${bookingId}`);
    setActionError(null);
    try {
      await staffForceCheckIn(studioId, userId, bookingId);
      await load();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : "No se pudo registrar la asistencia");
    } finally {
      setActionLoading(null);
    }
  }

  if (loading) return <TableSkeleton cols={5} />;

  return (
    <div className="space-y-3">
      {actionError && <ErrorBanner message={actionError} />}
      {error && <ErrorBanner message={error} />}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-zinc-200 bg-zinc-200 sm:grid-cols-4">
        <StatCard label="Próximas" value={summary.upcoming} />
        <StatCard label="Completadas" value={summary.completed} />
        <StatCard label="Canceladas" value={summary.cancelled} />
        <StatCard label="No-shows" value={summary.noShows} />
      </div>
      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-zinc-100">
          <thead className="bg-zinc-50">
            <tr>
              {["Clase", "Fecha", "Estado", "Reservada", ""].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {bookings.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-10 text-center text-sm text-zinc-500">Aún no hay reservas.</td></tr>
            ) : bookings.map((b) => (
              <tr key={b.id} className="hover:bg-zinc-50 transition-colors">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    {b.scheduledClass.classTemplate.color && (
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: b.scheduledClass.classTemplate.color }} />
                    )}
                    <span className="text-sm font-medium text-zinc-900">{b.scheduledClass.classTemplate.name}</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-sm text-zinc-600">{fmtDateTime(b.scheduledClass.startsAt)}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${BOOKING_STATUS_COLORS[b.status] ?? ""}`}>{BOOKING_STATUS_LABELS[b.status] ?? b.status}</span>
                </td>
                <td className="px-4 py-3 text-sm text-zinc-500">{fmtDate(b.createdAt)}</td>
                <td className="px-4 py-3 text-right">
                  {canOperateBookings && b.status === "CONFIRMED" && (
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => void handleCheckIn(b.id)}
                        disabled={actionLoading === `ci-${b.id}`}
                        className="rounded-lg border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-50"
                      >
                        {actionLoading === `ci-${b.id}` ? "…" : "Registrar asistencia"}
                      </button>
                      <button
                        onClick={() => void handleCancel(b.id)}
                        disabled={actionLoading === b.id}
                        className="rounded-lg border border-red-200 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                      >
                        {actionLoading === b.id ? "…" : "Cancelar"}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pagination page={page} total={total} limit={limit} onPage={setPage} />
      </div>
    </div>
  );
}

// ── Attendance tab ────────────────────────────────────────────────────────────

// ── Attendance log tab ────────────────────────────────────────────────────────

const ATTENDANCE_STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  ATTENDED: { label: "Asistió", color: "bg-emerald-100 text-emerald-800" },
  CANCELLED: { label: "Cancelada", color: "bg-red-100 text-red-700" },
  NO_SHOW: { label: "No-show", color: "bg-amber-100 text-amber-800" },
  MISSED: { label: "Ausente", color: "bg-zinc-100 text-zinc-600" },
  UPCOMING: { label: "Próxima", color: "bg-sky-100 text-sky-800" },
};

function AttendanceTab({ studioId, userId, studioRole, profile }: { studioId: string; userId: string; studioRole: string | null; profile: MemberProfile }) {
  const [records, setRecords] = useState<AttendanceLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const limit = 25;
  const canMarkNoShow = studioRole === "OWNER" || studioRole === "ADMIN" || studioRole === "STAFF";

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchMemberAttendanceLog(studioId, userId, page, limit);
      setRecords(res.data);
      setTotal(res.total);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo cargar la asistencia");
    } finally {
      setLoading(false);
    }
  }, [studioId, userId, page, limit]);

  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);

  async function handleMarkNoShow(entry: AttendanceLogEntry) {
    setActionLoading(entry.id);
    try {
      await staffMarkNoShow(studioId, userId, entry.id);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo registrar el no-show");
    } finally {
      setActionLoading(null);
    }
  }

  if (loading) return <TableSkeleton cols={5} />;

  return (
    <div className="space-y-3">
      {error && <ErrorBanner message={error} />}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-zinc-200 bg-zinc-200 sm:grid-cols-4">
        <StatCard label="Visitas" value={profile.attendances.totalInStudio} sub="Histórico" />
        <StatCard label="Este periodo" value={profile.engagement.visitsCurrentPeriod} />
        <StatCard label="Últimos 30 días" value={profile.engagement.visitsLast30Days} />
        <StatCard label="Promedio semanal" value={profile.engagement.averageVisitsPerWeekLast30} sub="últimos 30 días" />
      </div>
      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-zinc-100">
          <thead className="bg-zinc-50">
            <tr>
              {["Fecha", "Clase", "Coach", "Estado", ""].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {records.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-10 text-center text-sm text-zinc-500">Aún no hay historial de asistencia.</td></tr>
            ) : records.map((r) => {
              const cfg = ATTENDANCE_STATUS_CONFIG[r.attendanceStatus] ?? { label: r.attendanceStatus, color: "" };
              return (
                <tr key={r.id} className="hover:bg-zinc-50 transition-colors">
                  <td className="px-4 py-3 text-sm text-zinc-600 whitespace-nowrap">
                    {fmtDateTime(r.scheduledClass.startsAt)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {r.scheduledClass.classTemplate.color && (
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: r.scheduledClass.classTemplate.color }} />
                      )}
                      <span className="text-sm font-medium text-zinc-900">{r.scheduledClass.classTemplate.name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-zinc-500">
                    {r.scheduledClass.instructor
                      ? `${r.scheduledClass.instructor.firstName} ${r.scheduledClass.instructor.lastName}`
                      : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cfg.color}`}>
                      {cfg.label}
                    </span>
                    {r.checkedInAt && (
                      <p className="mt-0.5 text-[11px] text-zinc-400">
                        {r.checkInMethod === "MANUAL" ? "Manual" : r.checkInMethod === "QR" ? "QR" : r.checkInMethod} · {fmtDateTime(r.checkedInAt)}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {canMarkNoShow && r.canMarkNoShow && (
                      <button
                        onClick={() => void handleMarkNoShow(r)}
                        disabled={actionLoading === r.id}
                        className="rounded-lg border border-amber-200 px-2.5 py-1 text-xs font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50"
                      >
                        {actionLoading === r.id ? "…" : "Mark No Show"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <Pagination page={page} total={total} limit={limit} onPage={setPage} />
      </div>
    </div>
  );
}

// ── Timeline tab ──────────────────────────────────────────────────────────────

const TIMELINE_CONFIG: Record<string, { dot: string; label?: string }> = {
  MEMBER_CREATED:     { dot: "bg-purple-500" },
  BOOKING_CREATED:    { dot: "bg-blue-400" },
  BOOKING_CANCELLED:  { dot: "bg-red-400" },
  BOOKING_NO_SHOW:    { dot: "bg-amber-400" },
  CHECKED_IN:         { dot: "bg-emerald-500" },
  MEMBERSHIP_ASSIGNED: { dot: "bg-indigo-500" },
  MEMBERSHIP_CYCLE_CREATED: { dot: "bg-indigo-400" },
  PAYMENT_SUCCEEDED:  { dot: "bg-emerald-500" },
  PAYMENT_FAILED:     { dot: "bg-red-500" },
  CRM_UPDATED:        { dot: "bg-zinc-400" },
  NOTE_CREATED:       { dot: "bg-violet-500" },
  WAIVER_ACCEPTED:    { dot: "bg-teal-500" },
};
const TIMELINE_TITLES: Record<string, string> = {
  MEMBER_CREATED: "Miembro creado",
  BOOKING_CREATED: "Reserva creada",
  BOOKING_CANCELLED: "Reserva cancelada",
  BOOKING_NO_SHOW: "No-show registrado",
  CHECKED_IN: "Asistencia registrada",
  MEMBERSHIP_ASSIGNED: "Membresía asignada",
  MEMBERSHIP_CYCLE_CREATED: "Ciclo de membresía creado",
  PAYMENT_SUCCEEDED: "Pago registrado",
  PAYMENT_FAILED: "Pago fallido",
  CRM_UPDATED: "Datos CRM actualizados",
  NOTE_CREATED: "Nota operativa agregada",
  WAIVER_ACCEPTED: "Carta responsiva aceptada",
};

function TimelineTab({ studioId, userId }: { studioId: string; userId: string }) {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchMemberTimeline(studioId, userId);
      setEvents(data);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo cargar el historial");
    } finally {
      setLoading(false);
    }
  }, [studioId, userId]);

  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);

  if (loading) {
    return (
      <div className="space-y-4 pl-6">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="flex gap-3">
            <div className="h-3 w-3 mt-1.5 rounded-full bg-zinc-200 animate-pulse shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-1/3 rounded bg-zinc-200 animate-pulse" />
              <div className="h-3 w-1/2 rounded bg-zinc-100 animate-pulse" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (error) return <ErrorBanner message={error} />;

  if (events.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white px-6 py-12 text-center">
        <p className="text-sm text-zinc-500">Aún no hay actividad.</p>
      </div>
    );
  }

  // Group events by calendar date
  const groups = new Map<string, TimelineEvent[]>();
  for (const ev of events) {
    const key = new Date(ev.occurredAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(ev);
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
      <div className="space-y-8">
        {[...groups.entries()].map(([dateKey, dayEvents]) => (
          <div key={dateKey}>
            <p className="mb-4 text-xs font-semibold uppercase tracking-wider text-zinc-400">
              {dateKey}
            </p>
            <div className="relative border-l border-zinc-200 pl-6 space-y-5">
              {dayEvents.map((ev, i) => {
                const cfg = TIMELINE_CONFIG[ev.type] ?? { dot: "bg-zinc-400" };
                const time = new Date(ev.occurredAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
                return (
                  <div key={i} className="relative">
                    <span className={`absolute -left-[1.6rem] top-[5px] h-3 w-3 rounded-full border-2 border-white ${cfg.dot}`} />
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium text-zinc-900">{TIMELINE_TITLES[ev.type] ?? ev.title}</p>
                        {ev.description && (
                          <p className="mt-0.5 text-sm text-zinc-500">{ev.description}</p>
                        )}
                        {ev.actor ? <p className="mt-0.5 text-xs text-zinc-400">Por {ev.actor}</p> : null}
                      </div>
                      <p className="shrink-0 text-xs text-zinc-400">{time}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Billing tab ───────────────────────────────────────────────────────────────

function BillingTab({ studioId, userId, profile }: { studioId: string; userId: string; profile: MemberProfile }) {
  const [payments, setPayments] = useState<MemberPayment[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const limit = 20;
  const membership = profile.currentMembership;
  const billingState = billingOperationalState(profile);
  const renewal = membership ? renewalBehavior(membership) : "No aplica";

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchMemberPayments(studioId, userId, page, limit);
      setPayments(res.data);
      setTotal(res.total);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudieron cargar los pagos");
    } finally {
      setLoading(false);
    }
  }, [studioId, userId, page, limit]);

  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);

  if (loading) return <TableSkeleton cols={4} />;

  return (
    <div className="space-y-3">
      {error && <ErrorBanner message={error} />}
      <div className="grid gap-3 sm:grid-cols-4">
        <StatCard label="Estado de pagos" value={billingState} />
        <StatCard label="Método de pago" value={paymentSourceLabel(membership?.source)} />
        <StatCard label="Último pago" value={profile.operations.lastPayment ? fmtMoney(profile.operations.lastPayment.amountCents, profile.operations.lastPayment.currency) : "—"} sub={fmtDate(profile.operations.lastPayment?.paidAt ?? profile.operations.lastPayment?.createdAt)} />
        <StatCard label="Renovación" value={renewal} sub={membership?.source === "STRIPE" ? `${membership.cancelAtPeriodEnd ? "Vence" : "Próximo cobro"} ${fmtDate(membership.effectiveEnd)}` : undefined} />
      </div>
      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-zinc-100">
          <thead className="bg-zinc-50">
            <tr>
              {["Fecha", "Importe", "Plan", "Método", "Estado"].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {payments.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-10 text-center text-sm text-zinc-500">Sin pagos registrados.</td></tr>
            ) : payments.map((p) => (
              <tr key={p.id} className="hover:bg-zinc-50 transition-colors">
                <td className="px-4 py-3 text-sm text-zinc-600">
                  {fmtDate(p.paidAt ?? p.createdAt)}
                </td>
                <td className="px-4 py-3 text-sm font-medium tabular-nums text-zinc-900">
                  {fmtMoney(p.amountCents, p.currency)}
                </td>
                <td className="px-4 py-3 text-sm text-zinc-600">{p.membershipPlan?.name ?? "—"}</td>
                <td className="px-4 py-3 text-sm text-zinc-600">{p.paymentMethod === "CASH" ? "Efectivo" : p.paymentMethod === "STRIPE" ? "Stripe" : p.paymentMethod}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${PAYMENT_STATUS_COLORS[p.status] ?? ""}`}>
                    {PAYMENT_STATUS_LABELS[p.status] ?? p.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pagination page={page} total={total} limit={limit} onPage={setPage} />
      </div>
    </div>
  );
}

// ── Change plan modal ─────────────────────────────────────────────────────────

const INTERVAL_LABELS: Record<string, string> = { MONTHLY: "mes", YEARLY: "año", WEEKLY: "semana" };

function fmtPlanPrice(priceCents: number, currency: string, billingInterval: string) {
  return `${new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(priceCents / 100)} / ${INTERVAL_LABELS[billingInterval] ?? billingInterval}`;
}

type ChangePlanModalProps = {
  open: boolean;
  onClose: () => void;
  studioId: string;
  memberId: string;
  currentSubscription: MemberSubscription | null;
  onSuccess: () => void;
};

function ChangePlanModal({ open, onClose, studioId, memberId, currentSubscription, onSuccess }: ChangePlanModalProps) {
  const [plans, setPlans] = useState<MembershipPlanDto[]>([]);
  const [plansLoading, setPlansLoading] = useState(false);
  const [plansError, setPlansError] = useState<string | null>(null);

  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PlanChangePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<StaffCheckoutResult | null>(null);

  const currentPlanId = currentSubscription?.membershipPlan.id ?? null;

  // Load plans when modal opens
  useEffect(() => {
    if (!open) return;
    setSelectedPlanId(null);
    setPreview(null);
    setPreviewError(null);
    setSubmitError(null);
    setResult(null);
    setPlansLoading(true);
    setPlansError(null);
    fetchMembershipPlans(studioId, true)
      .then((all) => setPlans(all.filter((p) => p.active && p.deletedAt === null)))
      .catch((e) => setPlansError(e instanceof ApiError ? e.message : "No se pudieron cargar los planes"))
      .finally(() => setPlansLoading(false));
  }, [open, studioId]);

  // Fetch preview whenever selection changes
  useEffect(() => {
    if (!selectedPlanId) { setPreview(null); setPreviewError(null); return; }
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(true);
    fetchPlanChangePreview(studioId, memberId, selectedPlanId)
      .then(setPreview)
      .catch((e) => setPreviewError(e instanceof ApiError ? e.message : "No se pudo cargar la vista previa"))
      .finally(() => setPreviewLoading(false));
  }, [selectedPlanId, studioId, memberId]);

  async function handleConfirm() {
    if (!selectedPlanId || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await createStaffCheckoutSession(studioId, memberId, selectedPlanId);
      setResult(res);
      onSuccess();
    } catch (e) {
      setSubmitError(e instanceof ApiError ? e.message : "No se pudo cambiar el plan. Intenta nuevamente.");
    } finally {
      setSubmitting(false);
    }
  }

  function handleClose() {
    if (submitting) return;
    onClose();
  }

  if (!open) return null;

  const canConfirm = !!selectedPlanId && !!preview && !previewLoading && !submitting;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="relative w-full max-w-lg rounded-2xl bg-white shadow-xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-200 px-6 py-4 shrink-0">
          <h2 className="text-base font-semibold text-zinc-900">Cambiar plan de membresía</h2>
          <button onClick={handleClose} disabled={submitting}
            className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-50">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-5">

          {/* Result view (post-submit) */}
          {result ? (
            <div className="space-y-4">
              {result.action === "plan_changed" && !result.requiresPayment && (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                  <p className="text-sm font-semibold text-emerald-800">
                    {result.effective === "immediate"
                      ? "Membresía actualizada correctamente."
                      : "Cambio programado para la próxima renovación."}
                  </p>
                  <p className="mt-1 text-xs text-emerald-700">{result.message}</p>
                  {result.effective === "next_period" && result.nextRenewalAt && (
                    <p className="mt-1 text-xs text-emerald-700">
                      Entra en vigor: {fmtDate(result.nextRenewalAt)}
                    </p>
                  )}
                </div>
              )}
              {result.action === "plan_changed" && result.requiresPayment && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-3">
                  <p className="text-sm font-semibold text-amber-800">Se requiere pago para completar el cambio.</p>
                  <p className="text-xs text-amber-700">El cambio está pendiente de pago. Comparte el enlace con el miembro.</p>
                  {result.paymentUrl && (
                    <a href={result.paymentUrl} target="_blank" rel="noopener noreferrer"
                      className="inline-block rounded-lg bg-amber-600 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-700">
                      Abrir enlace de pago ↗
                    </a>
                  )}
                </div>
              )}
              {result.action === "checkout" && (
                <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 space-y-3">
                  <p className="text-sm font-semibold text-zinc-800">Enlace de pago creado.</p>
                  <p className="text-xs text-zinc-600">El miembro no tiene una suscripción Stripe activa. Comparte el enlace para completar el alta.</p>
                  <a href={result.url} target="_blank" rel="noopener noreferrer"
                    className="inline-block rounded-lg bg-zinc-900 px-4 py-2 text-xs font-semibold text-white hover:bg-zinc-700">
                    Abrir enlace de pago ↗
                  </a>
                </div>
              )}
              <button onClick={handleClose}
                className="w-full rounded-xl border border-zinc-200 py-2.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100">
                Cerrar
              </button>
            </div>
          ) : (
            <>
              {/* Current plan */}
              {currentSubscription && (
                <div>
                  <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-400">Plan actual</p>
                  <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-zinc-900">{currentSubscription.membershipPlan.name}</p>
                      <span className={`rounded-full px-2 py-0.5 text-xs ${PRIMARY_STATUS_COLORS[currentSubscription.primaryStatus]}`}>{PRIMARY_STATUS_LABELS[currentSubscription.primaryStatus]}</span>
                    </div>
                    <p className="mt-0.5 text-xs text-zinc-500">
                      {fmtPlanPrice(currentSubscription.membershipPlan.priceCents, currentSubscription.membershipPlan.currency, currentSubscription.membershipPlan.billingInterval)}
                    </p>
                    {currentSubscription.source === "STRIPE" && currentSubscription.cancelAtPeriodEnd && (
                      <p className="mt-1 text-xs text-amber-600">No renovará · vence {fmtDate(currentSubscription.effectiveEnd)}</p>
                    )}
                  </div>
                </div>
              )}

              {/* Select new plan */}
              <div>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-400">Nuevo plan</p>
                {plansLoading && (
                  <div className="space-y-2">
                    {[...Array(3)].map((_, i) => (
                      <div key={i} className="h-14 rounded-xl bg-zinc-100 animate-pulse" />
                    ))}
                  </div>
                )}
                {plansError && <p className="text-sm text-red-600">{plansError}</p>}
                {!plansLoading && !plansError && (
                  <div className="space-y-2">
                    {plans.map((plan) => {
                      const isCurrent = plan.id === currentPlanId;
                      const isSelected = plan.id === selectedPlanId;
                      return (
                        <button
                          key={plan.id}
                          disabled={isCurrent}
                          onClick={() => setSelectedPlanId(plan.id)}
                          className={`w-full rounded-xl border px-4 py-3 text-left transition-colors ${
                            isCurrent
                              ? "cursor-not-allowed border-zinc-100 bg-zinc-50 opacity-50"
                              : isSelected
                              ? "border-zinc-900 bg-zinc-900 text-white"
                              : "border-zinc-200 bg-white hover:border-zinc-400"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className={`text-sm font-semibold ${isSelected ? "text-white" : "text-zinc-900"}`}>
                              {plan.name}
                              {isCurrent && <span className="ml-2 text-xs font-normal opacity-60">(actual)</span>}
                            </span>
                            <span className={`shrink-0 text-xs tabular-nums ${isSelected ? "text-zinc-300" : "text-zinc-500"}`}>
                              {fmtPlanPrice(plan.priceCents, plan.currency, plan.billingInterval)}
                            </span>
                          </div>
                          {plan.classCredits != null && (
                            <p className={`mt-0.5 text-xs ${isSelected ? "text-zinc-300" : "text-zinc-400"}`}>
                              {plan.classCredits} créditos de clase
                            </p>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Preview */}
              {selectedPlanId && (
                <div>
                  <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-400">Qué sucederá</p>
                  {previewLoading && (
                    <div className="h-16 rounded-xl bg-zinc-100 animate-pulse" />
                  )}
                  {previewError && (
                    <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3">
                      <p className="text-sm text-red-700">{previewError}</p>
                    </div>
                  )}
                  {preview && !previewLoading && (
                    <div className={`rounded-xl border px-4 py-3 space-y-1 ${
                      preview.effective === "immediate"
                        ? "border-blue-200 bg-blue-50"
                        : preview.effective === "next_period"
                        ? "border-amber-200 bg-amber-50"
                        : "border-zinc-200 bg-zinc-50"
                    }`}>
                      {preview.effective === "immediate" && (
                        <>
                          <p className="text-sm font-semibold text-blue-900">Cambio inmediato</p>
                          <p className="text-xs text-blue-800">
                            El plan cambia de inmediato. Stripe cobrará la diferencia prorrateada del periodo actual.
                          </p>
                          {currentSubscription?.cancelAtPeriodEnd && (
                            <p className="text-xs text-blue-800 font-medium mt-1">
                              Este cambio mantendrá activa la membresía y retirará la cancelación programada.
                            </p>
                          )}
                        </>
                      )}
                      {preview.effective === "next_period" && (
                        <>
                          <p className="text-sm font-semibold text-amber-900">Programado para la próxima renovación</p>
                          <p className="text-xs text-amber-800">
                            {`${currentSubscription?.membershipPlan.name ?? "El plan actual"} permanece activo hasta ${fmtDate(currentSubscription?.currentPeriodEnd)}. `}
                            {`${preview.newPlan.name} se activa en la próxima renovación.`}
                          </p>
                          {currentSubscription?.cancelAtPeriodEnd && (
                            <p className="text-xs text-amber-800 font-medium mt-1">
                              Este cambio mantendrá activa la membresía y retirará la cancelación programada.
                            </p>
                          )}
                        </>
                      )}
                      {preview.effective === "checkout" && (
                        <>
                          <p className="text-sm font-semibold text-zinc-900">Nueva suscripción Stripe</p>
                          <p className="text-xs text-zinc-600">
                            El miembro no tiene una suscripción Stripe activa. Se creará un enlace de pago para completar el alta.
                          </p>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Offline-to-cash note */}
              <p className="text-xs text-zinc-400">
                Para cambiar a pago en efectivo, usa el flujo de venta presencial después de cancelar la suscripción Stripe.
              </p>

              {/* Errors */}
              {submitError && (
                <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3">
                  <p className="text-sm text-red-700">{submitError}</p>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {!result && (
          <div className="border-t border-zinc-200 px-6 py-4 shrink-0">
            <button
              onClick={() => void handleConfirm()}
              disabled={!canConfirm}
              className="w-full rounded-xl bg-zinc-900 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting ? "Aplicando cambio…" : "Confirmar cambio de plan"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Membership tab ────────────────────────────────────────────────────────────

function MembershipTab({
  studioId,
  userId,
  studioRole,
  profile,
  onProfileRefresh,
}: {
  studioId: string;
  userId: string;
  studioRole: string | null;
  profile: MemberProfile;
  onProfileRefresh?: () => void;
}) {
  const [subs, setSubs] = useState<MemberSubscription[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [changePlanSub, setChangePlanSub] = useState<MemberSubscription | null>(null);

  const canChangePlan = studioRole === "OWNER" || studioRole === "ADMIN";

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchMemberSubscriptions(studioId, userId);
      setSubs(res);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudieron cargar las membresías");
    } finally {
      setLoading(false);
    }
  }, [studioId, userId]);

  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);

  async function handleStatusChange(subId: string, newStatus: SubStatus) {
    setActionLoading(subId);
    setActionError(null);
    try {
      const updated = await updateSubscriptionStatus(studioId, userId, subId, newStatus);
      setSubs((prev) => prev.map((s) => (s.id === subId ? { ...s, status: updated.status } : s)));
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : "No se pudo actualizar la membresía");
    } finally {
      setActionLoading(null);
    }
  }

  function handlePlanChangeSuccess() {
    void load();
    onProfileRefresh?.();
  }

  if (loading) return <CardSkeleton lines={5} />;

  return (
    <>
      <ChangePlanModal
        open={changePlanSub !== null}
        onClose={() => setChangePlanSub(null)}
        studioId={studioId}
        memberId={userId}
        currentSubscription={changePlanSub}
        onSuccess={handlePlanChangeSuccess}
      />

      <div className="space-y-4">
        {error && <ErrorBanner message={error} />}
        {actionError && <ErrorBanner message={actionError} />}
        {subs.length === 0 && !loading && (
          <div className="rounded-xl border border-zinc-200 bg-white px-6 py-10 text-center shadow-sm">
            <p className="text-sm text-zinc-500">No hay membresías registradas.</p>
          </div>
        )}
        {subs.map((s) => {
          const statusKey = s.lifecycleStatus === "REPLACED" ? "REPLACED" : s.primaryStatus;
          const transitionNote = subscriptionTransitionPresentation(s.transitionDetail);
          return (
          <div key={s.id} className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <p className="font-semibold text-zinc-900">{s.membershipPlan.name}</p>
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${PRIMARY_STATUS_COLORS[statusKey]}`}>
                    {PRIMARY_STATUS_LABELS[statusKey]}
                  </span>
                </div>
                {transitionNote ? (
                  <p className="mt-1 text-xs text-zinc-500">{transitionNote}</p>
                ) : null}
                <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">Precio actual</p>
                <p className="text-sm text-zinc-500">
                  {fmtPlanPrice(s.membershipPlan.priceCents, s.membershipPlan.currency, s.membershipPlan.billingInterval)}
                </p>
                {/* Scheduled downgrade indicator */}
                {s.pendingMembershipPlan && (
                  <p className="mt-1 text-xs text-amber-700">
                    Cambio programado: <span className="font-medium">{s.pendingMembershipPlan.name}</span>
                    {s.currentPeriodEnd ? ` · ${fmtDate(s.currentPeriodEnd)}` : ""}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {s.lifecycleStatus !== "REPLACED" && canChangePlan && (s.isEntitled || s.lifecycleStatus === "EXPIRED" || s.status === "PAST_DUE") && (
                  <button
                    onClick={() => setChangePlanSub(s)}
                    disabled={actionLoading === s.id}
                    className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-50"
                  >
                    Cambiar plan
                  </button>
                )}
                {s.lifecycleStatus !== "REPLACED" && s.isEntitled && s.status === "ACTIVE" && (
                  <>
                    <button onClick={() => void handleStatusChange(s.id, "PAUSED")} disabled={actionLoading === s.id}
                      className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50">
                      {actionLoading === s.id ? "…" : "Pausar"}
                    </button>
                    <button onClick={() => void handleStatusChange(s.id, "CANCELED")} disabled={actionLoading === s.id}
                      className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50">
                      Cancelar
                    </button>
                  </>
                )}
                {s.lifecycleStatus !== "REPLACED" && (s.status === "PAUSED" || s.status === "CANCELED" || s.status === "PAST_DUE") && (
                  <button onClick={() => void handleStatusChange(s.id, "ACTIVE")} disabled={actionLoading === s.id}
                    className="rounded-lg border border-emerald-200 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50">
                    {actionLoading === s.id ? "…" : "Reactivar"}
                  </button>
                )}
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
              <div>
                <p className="text-xs text-zinc-400">Inicio del periodo</p>
                <p className="text-sm text-zinc-700">{fmtDate(s.currentPeriodStart)}</p>
              </div>
              <div>
                <p className="text-xs text-zinc-400">Fin del periodo</p>
                <p className="text-sm text-zinc-700">{fmtDate(s.effectiveEnd)}</p>
              </div>
              <div>
                <p className="text-xs text-zinc-400">Créditos</p>
                <p className="text-sm text-zinc-700">{s.membershipPlan.classCredits == null ? "Ilimitado" : profile.currentMembership?.id === s.id ? `${profile.currentMembership.creditsUsed ?? 0} / ${s.membershipPlan.classCredits} usados · ${profile.currentMembership.creditsRemaining ?? 0} restantes` : `${s.membershipPlan.classCredits} por periodo`}</p>
              </div>
              <div>
                <p className="text-xs text-zinc-400">Método de pago</p>
                <p className="text-sm text-zinc-700">{paymentSourceLabel(s.source)}</p>
              </div>
              <div>
                <p className="text-xs text-zinc-400">Renovación</p>
                <p className="text-sm text-zinc-700">{renewalBehavior(s)}</p>
              </div>
            </div>
            {s.membershipPlan.entitlementDays ? <p className="mt-3 text-sm text-zinc-600"><span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Programa</span><br />{s.membershipPlan.entitlementDays} días</p> : null}
            <div className="mt-4 border-t border-zinc-100 pt-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Acceso de clases</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {s.membershipPlan.allClassesAccess ? <span className="text-sm text-zinc-700">Todas las clases</span> : s.membershipPlan.classTemplateAccess.length > 0 ? s.membershipPlan.classTemplateAccess.map((access) => <span key={access.classTemplateId} className="rounded-md bg-zinc-100 px-2 py-1 text-xs text-zinc-700">{access.classTemplate.name}{access.classTemplate.isOpenGymSlot && access.classTemplate.accessWindowStart && access.classTemplate.accessWindowEnd ? ` · ${access.classTemplate.accessWindowStart}–${access.classTemplate.accessWindowEnd}` : ""}</span>) : <span className="text-sm text-rose-600">Sin clases configuradas</span>}
              </div>
            </div>
            {s.source === "STRIPE" && s.isEntitled && !s.cancelAtPeriodEnd ? <div className="mt-4 rounded-lg bg-zinc-50 px-3 py-2"><p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Próxima renovación programada</p><p className="mt-1 text-sm font-medium text-zinc-900">{studioDate(s.currentPeriodEnd ?? s.effectiveEnd)} · {fmtMoney(s.membershipPlan.priceCents, s.membershipPlan.currency)}</p><p className="text-xs text-zinc-500">{s.membershipPlan.entitlementDays ? `Cada ${s.membershipPlan.entitlementDays} días` : "Renovación automática"} · el siguiente derecho se crea solo tras pago exitoso.</p></div> : null}
            {s.entitlementCycles.length > 0 ? (
              <div className="mt-4 border-t border-zinc-100 pt-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Historial de ciclos pagados</p>
                <div className="mt-2 divide-y divide-zinc-100 rounded-lg border border-zinc-100">
                  {s.entitlementCycles.map((cycle) => { const payment = cyclePayment(s, cycle.stripeInvoiceId); const current = new Date(cycle.startsAt) <= new Date() && new Date(cycle.endsAt) > new Date(); return <div key={cycle.id} className="grid gap-2 px-3 py-2 text-sm sm:grid-cols-[1fr_auto_auto]"><span><span className="font-medium text-zinc-900">{studioDate(cycle.startsAt)} → {studioDate(cycle.endsAt)}</span>{current ? <span className="ml-2 text-xs font-medium text-emerald-700">Actual</span> : null}<span className="block text-xs text-zinc-500">{cycle.creditLimit == null ? "Ilimitado" : `${cycle.creditLimit} créditos`} · {cycle.source === "CASH" ? "Efectivo" : cycle.source === "STRIPE" ? "Stripe" : "Manual"}</span></span><span className="text-zinc-600">{payment ? fmtMoney(payment.amountCents, payment.currency) : "Pago no vinculado"}</span><span className="text-xs text-zinc-400">{payment?.paymentMethod ?? "—"}</span></div>; })}
                </div>
                <p className="mt-2 text-xs text-zinc-400">Los ciclos futuros aparecen únicamente después de un pago válido.</p>
              </div>
            ) : null}
          </div>
        );})}
        {subs.length > 0 && (
          <p className="text-xs text-zinc-400">Los cambios administrativos no sustituyen el estado de pago; Stripe puede sincronizar nuevamente las membresías vinculadas.</p>
        )}
      </div>
    </>
  );
}

// ── Notes & CRM tab ───────────────────────────────────────────────────────────

function NotesTab({
  studioId,
  userId,
  readOnly = false,
  canAddOperationalNote = false,
}: {
  studioId: string;
  userId: string;
  readOnly?: boolean;
  canAddOperationalNote?: boolean;
}) {
  const [crm, setCrm] = useState<MemberCrmProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [form, setForm] = useState<UpsertCrmProfileInput>({
    birthdate: null,
    emergencyContactName: null,
    emergencyContactPhone: null,
    emergencyContactRelation: null,
    notes: null,
    tags: [],
    goals: null,
    injuries: null,
  });
  const [tagInput, setTagInput] = useState("");
  const [operationalNotes, setOperationalNotes] = useState<MemberOperationalNote[]>([]);
  const [newOperationalNote, setNewOperationalNote] = useState("");
  const [noteSaving, setNoteSaving] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setLoading(true);
      fetchMemberCrmProfile(studioId, userId)
        .then((data) => {
          if (data) {
            setCrm(data);
            setForm({
              birthdate: data.birthdate ? data.birthdate.slice(0, 10) : null,
              emergencyContactName: data.emergencyContactName,
              emergencyContactPhone: data.emergencyContactPhone,
              emergencyContactRelation: data.emergencyContactRelation,
              notes: data.notes,
              tags: data.tags,
              goals: data.goals,
              injuries: data.injuries,
            });
          }
        })
        .catch((e: unknown) => {
          setError(e instanceof ApiError ? e.message : "No se pudo cargar el perfil CRM");
        })
        .finally(() => setLoading(false));
    }, 0);
    return () => clearTimeout(t);
  }, [studioId, userId]);

  useEffect(() => {
    const t = setTimeout(() => void fetchMemberOperationalNotes(studioId, userId).then(setOperationalNotes).catch((e: unknown) => setError(e instanceof ApiError ? e.message : "No se pudieron cargar las notas operativas")), 0);
    return () => clearTimeout(t);
  }, [studioId, userId]);

  async function addOperationalNote() {
    const body = newOperationalNote.trim();
    if (!body) return;
    setNoteSaving(true);
    setError(null);
    try {
      const created = await createMemberOperationalNote(studioId, userId, body);
      setOperationalNotes((current) => [created, ...current]);
      setNewOperationalNote("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo agregar la nota operativa");
    } finally {
      setNoteSaving(false);
    }
  }

  function set<K extends keyof UpsertCrmProfileInput>(key: K, val: UpsertCrmProfileInput[K]) {
    setForm((prev) => ({ ...prev, [key]: val }));
  }

  function addTag(tag: string) {
    const trimmed = tag.trim();
    if (!trimmed || (form.tags ?? []).includes(trimmed)) return;
    set("tags", [...(form.tags ?? []), trimmed]);
    setTagInput("");
  }

  function removeTag(tag: string) {
    set("tags", (form.tags ?? []).filter((t) => t !== tag));
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await updateMemberCrmProfile(studioId, userId, form);
      setCrm(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudieron guardar los cambios.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <CardSkeleton lines={6} />;

  return (
    <form onSubmit={(e) => void handleSave(e)} className="space-y-6">
      {error && <ErrorBanner message={error} />}
      {readOnly ? <p className="rounded-lg bg-zinc-100 px-3 py-2 text-sm text-zinc-600">Los datos CRM son de solo lectura para recepción; las notas operativas sí pueden agregarse.</p> : null}

      <section className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between gap-3"><div><h3 className="text-sm font-semibold text-zinc-900">Notas operativas</h3><p className="text-xs text-zinc-500">Historial append-only para seguimiento interno.</p></div></div>
        {canAddOperationalNote ? <div className="mt-4 flex gap-2"><textarea value={newOperationalNote} onChange={(event) => setNewOperationalNote(event.target.value)} rows={2} maxLength={5000} placeholder="Agregar seguimiento operativo…" className="min-w-0 flex-1 rounded-lg border border-zinc-200 px-3 py-2 text-sm"/><button type="button" disabled={noteSaving || !newOperationalNote.trim()} onClick={() => void addOperationalNote()} className="self-end rounded-lg bg-zinc-900 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">{noteSaving ? "Guardando…" : "Agregar"}</button></div> : null}
        <div className="mt-4 divide-y divide-zinc-100">{operationalNotes.length > 0 ? operationalNotes.map((note) => <article key={note.id} className="py-3"><p className="whitespace-pre-line text-sm text-zinc-800">{note.body}</p><p className="mt-1 text-xs text-zinc-400">{note.author.firstName} {note.author.lastName} · {fmtDateTime(note.createdAt)}</p></article>) : <p className="py-3 text-sm text-zinc-500">Sin notas operativas.</p>}</div>
      </section>

      <fieldset disabled={readOnly} className="space-y-6 disabled:opacity-75">
      {/* Tags */}
      <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-zinc-900 mb-3">Etiquetas</h3>
        <div className="flex flex-wrap gap-2 mb-3">
          {(form.tags ?? []).map((tag) => (
            <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-700">
              {tag}
              <button type="button" onClick={() => removeTag(tag)} className="text-zinc-400 hover:text-red-500 leading-none ml-0.5">×</button>
            </span>
          ))}
          {(form.tags ?? []).length === 0 && <p className="text-xs text-zinc-400">Sin etiquetas.</p>}
        </div>
        <div className="flex flex-wrap gap-1.5 mb-3">
          {PRESET_TAGS.filter((pt) => !(form.tags ?? []).includes(pt)).map((pt) => (
            <button
              key={pt}
              type="button"
              onClick={() => addTag(pt)}
              className="rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-xs text-zinc-600 hover:border-zinc-400"
            >
              + {pt}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(tagInput); } }}
            placeholder="Etiqueta personalizada…"
            maxLength={50}
            className="flex-1 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-sm"
          />
          <button
            type="button"
            onClick={() => addTag(tagInput)}
            className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Agregar
          </button>
        </div>
      </div>

      {/* Notes */}
      <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm space-y-4">
        <h3 className="text-sm font-semibold text-zinc-900">Notas internas</h3>
        <div>
          <label className="block text-xs font-medium text-zinc-500 mb-1">Notas</label>
          <textarea
            rows={4}
            value={form.notes ?? ""}
            onChange={(e) => set("notes", e.target.value || null)}
            placeholder="Notas generales, seguimiento, preferencias…"
            maxLength={5000}
            className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm"
          />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-xs font-medium text-zinc-500 mb-1">Objetivos</label>
            <textarea
              rows={3}
              value={form.goals ?? ""}
              onChange={(e) => set("goals", e.target.value || null)}
              placeholder="Objetivos de entrenamiento…"
              maxLength={2000}
              className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-500 mb-1">Lesiones / observaciones de salud</label>
            <textarea
              rows={3}
              value={form.injuries ?? ""}
              onChange={(e) => set("injuries", e.target.value || null)}
              placeholder="Lesiones o limitaciones conocidas…"
              maxLength={2000}
              className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm"
            />
          </div>
        </div>
      </div>

      {/* Personal details */}
      <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm space-y-4">
        <h3 className="text-sm font-semibold text-zinc-900">Datos personales</h3>
        <div>
          <label className="block text-xs font-medium text-zinc-500 mb-1">Fecha de nacimiento</label>
          <input
            type="date"
            value={form.birthdate ?? ""}
            onChange={(e) => set("birthdate", e.target.value || null)}
            className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm"
          />
        </div>
      </div>

      {/* Emergency contact */}
      <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm space-y-4">
        <h3 className="text-sm font-semibold text-zinc-900">Contacto de emergencia</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label className="block text-xs font-medium text-zinc-500 mb-1">Nombre</label>
            <input
              type="text"
              maxLength={120}
              value={form.emergencyContactName ?? ""}
              onChange={(e) => set("emergencyContactName", e.target.value || null)}
              placeholder="Nombre completo"
              className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-500 mb-1">Teléfono</label>
            <input
              type="tel"
              maxLength={30}
              value={form.emergencyContactPhone ?? ""}
              onChange={(e) => set("emergencyContactPhone", e.target.value || null)}
              placeholder="+1 555 000 0000"
              className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-500 mb-1">Relación</label>
            <input
              type="text"
              maxLength={60}
              value={form.emergencyContactRelation ?? ""}
              onChange={(e) => set("emergencyContactRelation", e.target.value || null)}
              placeholder="Ej. pareja, madre, padre"
              className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm"
            />
          </div>
        </div>
      </div>
      </fieldset>

      <div className="flex items-center justify-between">
        {saved && <p className="text-sm text-emerald-600">Guardado.</p>}
        {!saved && <span />}
        {!readOnly ? <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-zinc-900 px-5 py-2 text-sm font-semibold text-white hover:bg-zinc-700 disabled:opacity-50"
        >
          {saving ? "Guardando…" : "Guardar cambios"}
        </button> : null}
      </div>

      {crm && (
        <p className="text-xs text-zinc-400">
          Última actualización: {fmtDateTime(crm.updatedAt)} · Uso interno, no visible para miembros.
        </p>
      )}
    </form>
  );
}

// ── Error banner ──────────────────────────────────────────────────────────────

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
      {message}
    </div>
  );
}

// ── Waiver status ───────────────────────────────────────────────────────────

function WaiverStatusCard({
  studioId,
  userId,
}: {
  studioId: string;
  userId: string;
}) {
  const [status, setStatus] = useState<MemberWaiverStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await fetchMemberWaiverStatus(studioId, userId));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo cargar el estado de la carta responsiva");
    } finally {
      setLoading(false);
    }
  }, [studioId, userId]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  async function handleAttest() {
    if (!status?.activeWaiverDocumentId) return;
    setSubmitting(true);
    setError(null);
    try {
      await attestMemberWaiver(studioId, userId, {
        waiverDocumentId: status.activeWaiverDocumentId,
        attestationNote: note.trim() || undefined,
      });
      setNote("");
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo registrar la constancia de la carta responsiva");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading && !status) {
    return <CardSkeleton lines={2} />;
  }

  if (!status?.required) return null;

  const pending = !status.accepted;

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900">Carta Responsiva</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Estado: <span className="font-medium text-zinc-800">{waiverStatusLabel(status)}</span>
          </p>
          {status.accepted && status.acceptedVersion ? (
            <p className="mt-1 text-xs text-zinc-400">
              Versión {status.acceptedVersion}
              {status.acceptedAt ? ` · ${fmtDateTime(status.acceptedAt)}` : ""}
            </p>
          ) : status.activeVersion ? (
            <p className="mt-1 text-xs text-zinc-400">Versión activa: {status.activeVersion}</p>
          ) : null}
        </div>
      </div>

      {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}

      {pending ? (
        <div className="mt-4 space-y-3 border-t border-zinc-100 pt-4">
          <p className="text-sm text-zinc-600">
            Marca como firmada presencialmente solo si el cliente firmó la carta en recepción.
          </p>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Nota opcional (referencia, folio, etc.)"
            rows={2}
            className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900"
          />
          <button
            type="button"
            onClick={() => void handleAttest()}
            disabled={submitting || !status.activeWaiverDocumentId}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {submitting ? "Guardando…" : "Marcar como firmado presencialmente"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function MemberProfilePage() {
  const { userId } = useParams<{ userId: string }>();
  const { selectedStudioId, studioRole } = useDeskStudio();

  const [profile, setProfile] = useState<MemberProfile | null>(null);
  const [crm, setCrm] = useState<MemberCrmProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("overview");

  const load = useCallback(async () => {
    if (!selectedStudioId || !userId) return;
    setLoading(true);
    setError(null);
    try {
      const [p, c] = await Promise.all([
        fetchMemberProfile(selectedStudioId, userId),
        fetchMemberCrmProfile(selectedStudioId, userId),
      ]);
      setProfile(p);
      setCrm(c);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo cargar el perfil del miembro");
    } finally {
      setLoading(false);
    }
  }, [selectedStudioId, userId]);

  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);

  if (!selectedStudioId) return null;

  const badges = profile ? computeBadges(profile, crm) : [];
  const profileRenewal = profile?.currentMembership ? renewalPresentation({ ...profile.currentMembership, entitlementDays: profile.currentMembership.plan.entitlementDays }) : null;
  const profileVisit = visitPresentation(profile?.operations.lastVisit?.checkedInAt);
  const profileActions = profile ? member360Actions(studioRole, profile.currentMembership) : [];
  const usageKpi = profile ? usagePresentation(profile) : null;
  const allowedClasses = profile?.currentMembership ? allowedClassPresentation(profile.currentMembership) : [];
  const billingState = profile ? billingOperationalState(profile) : "—";

  return (
    <div className="space-y-6">
      <div>
        <Link href="/members" className="text-sm text-zinc-500 hover:text-zinc-800">
          ← Members
        </Link>
      </div>

      {error && <ErrorBanner message={error} />}

      {loading && !profile ? (
        <div className="space-y-4">
          <CardSkeleton lines={3} />
          <div className="grid grid-cols-4 gap-4">{[...Array(4)].map((_, i) => <CardSkeleton key={i} lines={1} />)}</div>
        </div>
      ) : profile ? (
        <>
          {/* ── Profile header ── */}
          <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-start gap-5">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-xl font-bold text-white">
                {initials(profile.user.firstName, profile.user.lastName)}
              </div>
              <div className="flex-1 min-w-0">
                <h1 className="text-2xl font-bold tracking-tight text-zinc-900">
                  {profile.user.firstName} {profile.user.lastName}
                </h1>
                <p className="mt-0.5 text-sm text-zinc-500">{profile.user.email}</p>
                {profile.user.phone && (
                  <p className="text-sm text-zinc-500">{profile.user.phone}</p>
                )}
                <p className="mt-1 text-xs text-zinc-400">{MEMBER_ROLE_LABELS[profile.role] ?? profile.role} · Miembro desde {studioDate(profile.membership.createdAt, true)}</p>
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-600">
                    {MEMBER_ROLE_LABELS[profile.role] ?? profile.role}
                  </span>
                  {profile.currentMembership ? <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${PRIMARY_STATUS_COLORS[profile.currentMembership.primaryStatus]}`}>{PRIMARY_STATUS_LABELS[profile.currentMembership.primaryStatus]}</span> : <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs text-zinc-500">Sin membresía</span>}
                  {badges.map((b) => (
                    <span key={b.label} className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${b.color}`}>
                      {b.label}
                    </span>
                  ))}
                </div>
              </div>
            </div>
            <div className="mt-6 grid gap-x-6 gap-y-4 border-t border-zinc-100 pt-5 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
              <div><p className="text-xs uppercase tracking-wide text-zinc-400">Membresía actual</p><p className="mt-1 text-sm font-semibold text-zinc-900">{profile.currentMembership?.plan.name ?? "Sin membresía"}</p></div>
              <div><p className="text-xs uppercase tracking-wide text-zinc-400">Uso</p><p className="mt-1 text-sm font-semibold text-zinc-900">{profile.currentMembership?.plan.classCredits === null ? "Ilimitado" : profile.currentMembership ? `${profile.currentMembership.creditsUsed ?? 0} / ${profile.currentMembership.plan.classCredits} clases usadas` : "—"}</p><p className="text-xs text-zinc-500">{profile.currentMembership?.creditsRemaining != null ? profile.currentMembership.creditsRemaining === 0 ? "Sin créditos" : `${profile.currentMembership.creditsRemaining} restantes` : null}</p></div>
              <div><p className="text-xs uppercase tracking-wide text-zinc-400">Vigencia</p><p className="mt-1 text-sm font-semibold text-zinc-900">{profile.currentMembership ? `${studioDate(profile.currentMembership.currentPeriodStart)} → ${studioDate(profile.currentMembership.effectiveEnd)}` : "—"}</p><p className="text-xs text-zinc-500">{profileRenewal?.detail}</p></div>
              <div><p className="text-xs uppercase tracking-wide text-zinc-400">Método de pago</p><p className="mt-1 text-sm font-semibold text-zinc-900">{paymentSourceLabel(profile.currentMembership?.source)}</p><p className="text-xs text-zinc-500">{profile.currentMembership ? `Renovación: ${renewalBehavior(profile.currentMembership)}` : null}</p></div>
              <div><p className="text-xs uppercase tracking-wide text-zinc-400">Última visita</p><p className="mt-1 text-sm font-semibold text-zinc-900">{profileVisit.title}</p><p className="text-xs text-zinc-500">{profileVisit.detail}</p></div>
              <div><p className="text-xs uppercase tracking-wide text-zinc-400">Próxima clase</p><p className="mt-1 truncate text-sm font-semibold text-zinc-900">{profile.operations.nextBooking?.scheduledClass.classTemplate.name ?? "—"}</p><p className="text-xs text-zinc-500">{nextClassPresentation(profile.operations.nextBooking?.scheduledClass.startsAt)}</p></div>
              <div className="flex flex-wrap items-end gap-2 xl:justify-end">{profileActions.map((action) => <button key={action.id} type="button" onClick={() => setActiveTab(action.id)} className={action.emphasis === "primary" ? "rounded-lg bg-zinc-900 px-3 py-2 text-xs font-semibold text-white hover:bg-zinc-700" : "rounded-lg border border-zinc-200 px-3 py-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-50"}>{action.label}</button>)}</div>
            </div>
          </div>

          <WaiverStatusCard studioId={selectedStudioId} userId={userId!} />

          {/* ── KPI stats ── */}
          {profile.operations.attentionItems.length > 0 ? (
            <section className="rounded-xl border border-amber-200 bg-amber-50/60 p-5">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-amber-900">Atención requerida</h2>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {profile.operations.attentionItems.map((item) => <div key={item.code} className="flex items-start justify-between gap-4 rounded-lg border border-amber-100 bg-white px-3 py-3"><div><p className="text-sm font-medium text-zinc-900">{item.code === "EXPIRED" ? "Membresía vencida" : item.code === "ENDING" ? "Membresía termina pronto" : item.code === "PAST_DUE" ? "Cobro pendiente" : item.code === "CANCELLATION_SCHEDULED" ? "Renovación desactivada" : item.code === "INACTIVE" ? "Sin actividad reciente" : item.code === "ZERO_CREDITS" ? "Sin créditos" : "Seguimiento recomendado"}</p><p className="mt-0.5 text-xs text-zinc-500">{item.code === "EXPIRED" ? item.message.replace("Membresía vencida", "La membresía venció") : item.message}{item.code === "EXPIRED" && profile.currentMembership?.creditsRemaining ? `. ${profile.currentMembership.creditsRemaining} créditos quedaron sin utilizar y ya no otorgan acceso.` : "."}</p></div>{item.action ? <button type="button" onClick={() => setActiveTab(item.action === "REVIEW_BILLING" ? "billing" : "membership")} className="shrink-0 text-xs font-semibold text-zinc-900 underline">{item.action === "REVIEW_BILLING" ? "Revisar" : "Renovar"}</button> : null}</div>)}
              </div>
            </section>
          ) : null}

          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-zinc-200 bg-zinc-200 shadow-sm lg:grid-cols-4">
            <StatCard label={usageKpi?.label ?? "Uso"} value={usageKpi?.value ?? "—"} sub={usageKpi?.detail} />
            <StatCard label={profile.currentMembership?.plan.classCredits === null ? "Visitas totales" : "Visitas"} value={profile.currentMembership?.plan.classCredits === null ? profile.attendances.totalInStudio : profile.engagement.visitsCurrentPeriod} sub={profile.currentMembership?.plan.classCredits === null ? "histórico" : `${profile.attendances.totalInStudio} total`} />
            <StatCard label="Asistencia · 30 días" value={profile.operations.attendanceRate == null ? "—" : `${profile.operations.attendanceRate}%`} sub={`${profile.operations.recentNoShows} no-show${profile.operations.recentNoShows === 1 ? "" : "s"}`} />
            <StatCard label="Pagos" value={billingState} sub={profile.operations.lastPayment ? `Último pago ${fmtMoney(profile.operations.lastPayment.amountCents, profile.operations.lastPayment.currency)}` : "Sin pago registrado"} />
          </div>

          {/* ── Tabs ── */}
          <div className="border-b border-zinc-200">
            <nav className="-mb-px flex gap-1 overflow-x-auto">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setActiveTab(t.id)}
                  className={`shrink-0 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                    activeTab === t.id
                      ? "border-zinc-900 text-zinc-900"
                      : "border-transparent text-zinc-500 hover:text-zinc-800"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </nav>
          </div>

          {/* ── Tab content ── */}
          <div>
            {activeTab === "overview" && (
              <div className="grid gap-4 lg:grid-cols-2">
                <section className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
                  <h2 className="text-sm font-semibold text-zinc-900">Actividad próxima</h2>
                  <p className="mt-3 text-sm font-medium text-zinc-900">{profile.operations.nextBooking?.scheduledClass.classTemplate.name ?? "Sin reserva futura"}</p>
                  {profile.operations.nextBooking ? <p className="text-sm text-zinc-500">{fmtDateTime(profile.operations.nextBooking.scheduledClass.startsAt)}</p> : null}
                  <p className="mt-2 text-xs text-zinc-400">{profile.bookingStats.upcomingCount} {profile.bookingStats.upcomingCount === 1 ? "reserva próxima" : "reservas próximas"}</p>
                  <div className="mt-4 border-t border-zinc-100 pt-4"><p className="text-xs uppercase tracking-wide text-zinc-400">Última visita</p><p className="mt-1 text-sm text-zinc-800">{profile.operations.lastVisit ? `${fmtDateTime(profile.operations.lastVisit.checkedInAt)} · ${profile.operations.lastVisit.scheduledClass.classTemplate.name}` : "Nunca ha asistido"}</p></div>
                </section>
                <section className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
                  <h2 className="text-sm font-semibold text-zinc-900">Estado de membresía</h2>
                  <p className="mt-3 text-lg font-semibold text-zinc-900">{profile.currentMembership?.plan.name ?? "Sin plan"}</p>
                  {profile.currentMembership ? <><p className="text-sm text-zinc-500">{PRIMARY_STATUS_LABELS[profile.currentMembership.primaryStatus]} · {studioDate(profile.currentMembership.currentPeriodStart)} → {studioDate(profile.currentMembership.effectiveEnd)}</p><div className="mt-3 flex flex-wrap gap-1.5">{allowedClasses.map((label) => <span key={label} className="rounded-md bg-zinc-100 px-2 py-1 text-xs text-zinc-700">{label}</span>)}</div><p className="mt-3 text-sm font-medium text-zinc-700">{profileRenewal?.title}</p><p className="text-sm text-zinc-500">{profileRenewal?.detail}</p></> : null}
                </section>
                <section className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
                  <h2 className="text-sm font-semibold text-zinc-900">Actividad reciente</h2>
                  <div className="mt-3 divide-y divide-zinc-100">{profile.operations.recentActivity.length > 0 ? profile.operations.recentActivity.map((event, index) => <div key={`${event.type}-${index}`} className="py-2"><p className="text-sm font-medium text-zinc-800">{event.title} · {event.description}</p><p className="text-xs text-zinc-400">{fmtDateTime(event.occurredAt)} · clase {fmtDateTime(event.classStartsAt)}</p></div>) : <p className="text-sm text-zinc-500">Sin actividad reciente.</p>}</div>
                </section>
                <section className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
                  <h2 className="text-sm font-semibold text-zinc-900">Facturación</h2>
                  <p className="mt-3 text-lg font-semibold text-zinc-900">{billingState}</p>
                  <p className="text-sm text-zinc-500">{paymentSourceLabel(profile.currentMembership?.source)}</p>
                  {profile.operations.lastPayment ? <p className="mt-3 text-sm text-zinc-700">Último pago: {fmtMoney(profile.operations.lastPayment.amountCents, profile.operations.lastPayment.currency)} · {fmtDate(profile.operations.lastPayment.paidAt ?? profile.operations.lastPayment.createdAt)}</p> : <p className="mt-3 text-sm text-zinc-500">Sin pagos registrados.</p>}
                  <button type="button" onClick={() => setActiveTab("billing")} className="mt-3 text-xs font-semibold text-zinc-900 underline">Ver historial</button>
                </section>
                <section className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm lg:col-span-2">
                  <h2 className="mb-4 text-sm font-semibold text-zinc-900">Información del miembro</h2>
                <dl className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                  <div>
                    <dt className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Email</dt>
                    <dd className="mt-1 text-sm text-zinc-900">{profile.user.email}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Teléfono</dt>
                    <dd className="mt-1 text-sm text-zinc-900">{profile.user.phone ?? "—"}</dd>
                  </div>
                  <div>
                        <dt className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Rol</dt>
                        <dd className="mt-1 text-sm text-zinc-900">{MEMBER_ROLE_LABELS[profile.role] ?? profile.role}</dd>
                  </div>
                  <div>
                        <dt className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Miembro desde</dt>
                    <dd className="mt-1 text-sm text-zinc-900">{fmtDateTime(profile.membership.createdAt)}</dd>
                  </div>
                  {profile.currentMembership && (
                    <>
                      <div>
                            <dt className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Plan actual</dt>
                        <dd className="mt-1 flex items-center gap-2 text-sm text-zinc-900">
                          {profile.currentMembership.plan.name}
                          <span className={`rounded-full px-2 py-0.5 text-xs ${PRIMARY_STATUS_COLORS[profile.currentMembership.primaryStatus]}`}>{PRIMARY_STATUS_LABELS[profile.currentMembership.primaryStatus]}</span>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Renovación / vencimiento</dt>
                        <dd className="mt-1 text-sm text-zinc-900">
                          {profileRenewal?.title}
                          {profileRenewal?.detail ? <span className="ml-2 text-xs text-zinc-500">{profileRenewal.detail}</span> : null}
                        </dd>
                      </div>
                    </>
                  )}
                  {crm?.birthdate && (
                    <div>
                          <dt className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Fecha de nacimiento</dt>
                      <dd className="mt-1 text-sm text-zinc-900">{fmtDate(crm.birthdate)}</dd>
                    </div>
                  )}
                  {crm?.emergencyContactName && (
                    <div>
                      <dt className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Contacto de emergencia</dt>
                      <dd className="mt-1 text-sm text-zinc-900">
                        {crm.emergencyContactName}
                        {crm.emergencyContactRelation && <span className="ml-1 text-zinc-500">({crm.emergencyContactRelation})</span>}
                        {crm.emergencyContactPhone && <span className="block text-zinc-500">{crm.emergencyContactPhone}</span>}
                      </dd>
                    </div>
                  )}
                  {crm && crm.tags.length > 0 && (
                    <div className="sm:col-span-2">
                          <dt className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Etiquetas</dt>
                      <dd className="mt-2 flex flex-wrap gap-1.5">
                        {crm.tags.map((tag) => (
                          <span key={tag} className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-600">
                            {tag}
                          </span>
                        ))}
                      </dd>
                    </div>
                  )}
                  {crm?.injuries && (
                    <div className="sm:col-span-2">
                          <dt className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Lesiones / salud</dt>
                      <dd className="mt-1 text-sm text-zinc-700 whitespace-pre-line">{crm.injuries}</dd>
                    </div>
                  )}
                </dl></section>
              </div>
            )}
            {activeTab === "membership" && (
                  <MembershipTab
                    studioId={selectedStudioId}
                    userId={userId}
                    studioRole={studioRole}
                    profile={profile}
                    onProfileRefresh={() => void load()}
              />
            )}
            {activeTab === "bookings" && <BookingsTab studioId={selectedStudioId} userId={userId} studioRole={studioRole} />}
            {activeTab === "attendance" && <AttendanceTab studioId={selectedStudioId} userId={userId} studioRole={studioRole} profile={profile} />}
            {activeTab === "timeline" && <TimelineTab studioId={selectedStudioId} userId={userId} />}
            {activeTab === "billing" && <BillingTab studioId={selectedStudioId} userId={userId} profile={profile} />}
            {activeTab === "notes" && <NotesTab studioId={selectedStudioId} userId={userId} readOnly={studioRole === "FRONT_DESK"} canAddOperationalNote={studioRole === "OWNER" || studioRole === "ADMIN" || studioRole === "FRONT_DESK"} />}
          </div>
        </>
      ) : null}
    </div>
  );
}
