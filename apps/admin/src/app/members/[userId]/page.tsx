"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { useDeskStudio } from "@/contexts/DeskStudioContext";
import {
  fetchMemberAttendance,
  fetchMemberBookings,
  fetchMemberPayments,
  fetchMemberProfile,
  fetchMemberSubscriptions,
  staffCancelBooking,
  staffForceCheckIn,
  updateSubscriptionStatus,
  type MemberAttendance,
  type MemberBooking,
  type MemberPayment,
  type MemberProfile,
  type MemberSubscription,
  type SubStatus,
} from "@/lib/api/members";
import { ApiError } from "@/lib/api/errors";

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

const SUB_STATUS_LABELS: Record<SubStatus, string> = {
  ACTIVE: "Active",
  TRIALING: "Trial",
  PAST_DUE: "Past due",
  PAUSED: "Paused",
  CANCELED: "Canceled",
};

const SUB_STATUS_COLORS: Record<SubStatus, string> = {
  ACTIVE: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  TRIALING: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  PAST_DUE: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  PAUSED: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  CANCELED: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400",
};

const BOOKING_STATUS_COLORS: Record<string, string> = {
  CONFIRMED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  CANCELLED: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400",
  NO_SHOW: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  COMPLETED: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  PENDING: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

const PAYMENT_STATUS_COLORS: Record<string, string> = {
  SUCCEEDED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  FAILED: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400",
  PENDING: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  REFUNDED: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  PARTIALLY_REFUNDED: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
};

// ── Skeleton ─────────────────────────────────────────────────────────────────

function CardSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 space-y-3">
      {[...Array(lines)].map((_, i) => (
        <div key={i} className="h-4 rounded bg-zinc-200 dark:bg-zinc-800 animate-pulse" style={{ width: `${50 + (i * 23) % 50}%` }} />
      ))}
    </div>
  );
}

function TableSkeleton({ cols = 4 }: { cols?: number }) {
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <table className="min-w-full divide-y divide-zinc-100 dark:divide-zinc-800">
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {[...Array(5)].map((_, i) => (
            <tr key={i}>
              {[...Array(cols)].map((_, j) => (
                <td key={j} className="px-4 py-3">
                  <div className="h-4 rounded bg-zinc-200 dark:bg-zinc-800 animate-pulse" style={{ width: `${40 + (j * 19) % 50}%` }} />
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

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <p className="text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-zinc-900 dark:text-zinc-50">{value}</p>
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
    <div className="flex items-center justify-between border-t border-zinc-100 px-4 py-3 dark:border-zinc-800">
      <p className="text-xs text-zinc-500">
        Page {page} of {totalPages}
      </p>
      <div className="flex gap-2">
        <button
          onClick={() => onPage(Math.max(1, page - 1))}
          disabled={page === 1}
          className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 disabled:opacity-40 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Previous
        </button>
        <button
          onClick={() => onPage(Math.min(totalPages, page + 1))}
          disabled={page === totalPages}
          className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 disabled:opacity-40 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Next
        </button>
      </div>
    </div>
  );
}

// ── Tabs ───────────────────────────────────────────────────────────────────────

type Tab = "overview" | "membership" | "bookings" | "attendance" | "billing";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "membership", label: "Membership" },
  { id: "bookings", label: "Bookings" },
  { id: "attendance", label: "Attendance" },
  { id: "billing", label: "Billing" },
];

// ── Bookings tab ──────────────────────────────────────────────────────────────

function BookingsTab({
  studioId,
  userId,
}: {
  studioId: string;
  userId: string;
}) {
  const [bookings, setBookings] = useState<MemberBooking[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const limit = 20;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchMemberBookings(studioId, userId, page, limit);
      setBookings(res.data);
      setTotal(res.total);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load bookings");
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
      setActionError(e instanceof ApiError ? e.message : "Failed to cancel booking");
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
      setActionError(e instanceof ApiError ? e.message : "Failed to check in");
    } finally {
      setActionLoading(null);
    }
  }

  if (loading) return <TableSkeleton cols={5} />;

  return (
    <div className="space-y-3">
      {actionError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400">
          {actionError}
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400">
          {error}
        </div>
      )}
      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <table className="min-w-full divide-y divide-zinc-100 dark:divide-zinc-800">
          <thead className="bg-zinc-50 dark:bg-zinc-950/60">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Class</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Date</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Status</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Booked</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {bookings.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-sm text-zinc-500">
                  No bookings yet.
                </td>
              </tr>
            ) : (
              bookings.map((b) => {
                const dot = b.scheduledClass.classTemplate.color;
                return (
                  <tr key={b.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {dot && (
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ background: dot }}
                          />
                        )}
                        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                          {b.scheduledClass.classTemplate.name}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-zinc-600 dark:text-zinc-400">
                      {fmtDateTime(b.scheduledClass.startsAt)}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${BOOKING_STATUS_COLORS[b.status] ?? ""}`}>
                        {b.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-zinc-500 dark:text-zinc-400">
                      {fmtDate(b.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {b.status === "CONFIRMED" && (
                          <>
                            <button
                              onClick={() => void handleCheckIn(b.id)}
                              disabled={actionLoading === `ci-${b.id}`}
                              className="rounded-lg border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                            >
                              {actionLoading === `ci-${b.id}` ? "…" : "Check in"}
                            </button>
                            <button
                              onClick={() => void handleCancel(b.id)}
                              disabled={actionLoading === b.id}
                              className="rounded-lg border border-red-200 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/30"
                            >
                              {actionLoading === b.id ? "…" : "Cancel"}
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
        <Pagination page={page} total={total} limit={limit} onPage={setPage} />
      </div>
    </div>
  );
}

// ── Attendance tab ────────────────────────────────────────────────────────────

function AttendanceTab({
  studioId,
  userId,
}: {
  studioId: string;
  userId: string;
}) {
  const [records, setRecords] = useState<MemberAttendance[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const limit = 20;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchMemberAttendance(studioId, userId, page, limit);
      setRecords(res.data);
      setTotal(res.total);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load attendance");
    } finally {
      setLoading(false);
    }
  }, [studioId, userId, page, limit]);

  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);

  if (loading) return <TableSkeleton cols={3} />;

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400">
          {error}
        </div>
      )}
      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <table className="min-w-full divide-y divide-zinc-100 dark:divide-zinc-800">
          <thead className="bg-zinc-50 dark:bg-zinc-950/60">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Class</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Checked in</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Method</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {records.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-4 py-10 text-center text-sm text-zinc-500">
                  No check-ins yet.
                </td>
              </tr>
            ) : (
              records.map((r) => {
                const dot = r.scheduledClass.classTemplate.color;
                return (
                  <tr key={r.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {dot && (
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ background: dot }}
                          />
                        )}
                        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                          {r.scheduledClass.classTemplate.name}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-zinc-600 dark:text-zinc-400">
                      {fmtDateTime(r.checkedInAt)}
                    </td>
                    <td className="px-4 py-3 text-sm text-zinc-500 dark:text-zinc-400 capitalize lowercase">
                      {r.method}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
        <Pagination page={page} total={total} limit={limit} onPage={setPage} />
      </div>
    </div>
  );
}

// ── Billing tab ───────────────────────────────────────────────────────────────

function BillingTab({ studioId, userId }: { studioId: string; userId: string }) {
  const [payments, setPayments] = useState<MemberPayment[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const limit = 20;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchMemberPayments(studioId, userId, page, limit);
      setPayments(res.data);
      setTotal(res.total);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load payments");
    } finally {
      setLoading(false);
    }
  }, [studioId, userId, page, limit]);

  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);

  if (loading) return <TableSkeleton cols={4} />;

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400">
          {error}
        </div>
      )}
      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <table className="min-w-full divide-y divide-zinc-100 dark:divide-zinc-800">
          <thead className="bg-zinc-50 dark:bg-zinc-950/60">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Date</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Amount</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Status</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Reference</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {payments.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-sm text-zinc-500">
                  No payment records.
                </td>
              </tr>
            ) : (
              payments.map((p) => (
                <tr key={p.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors">
                  <td className="px-4 py-3 text-sm text-zinc-600 dark:text-zinc-400">
                    {fmtDate(p.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-sm font-medium tabular-nums text-zinc-900 dark:text-zinc-100">
                    {fmtMoney(p.amountCents, p.currency)}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${PAYMENT_STATUS_COLORS[p.status] ?? ""}`}>
                      {p.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs font-mono text-zinc-400 dark:text-zinc-600 truncate max-w-[160px]">
                    {p.stripeInvoiceId ?? p.stripePaymentIntentId ?? "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <Pagination page={page} total={total} limit={limit} onPage={setPage} />
      </div>
    </div>
  );
}

// ── Membership tab ────────────────────────────────────────────────────────────

function MembershipTab({ studioId, userId }: { studioId: string; userId: string }) {
  const [subs, setSubs] = useState<MemberSubscription[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchMemberSubscriptions(studioId, userId);
      setSubs(res);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load subscriptions");
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
      setActionError(e instanceof ApiError ? e.message : "Failed to update subscription");
    } finally {
      setActionLoading(null);
    }
  }

  if (loading) return <CardSkeleton lines={5} />;

  const INTERVAL_LABELS: Record<string, string> = {
    MONTHLY: "Monthly",
    YEARLY: "Yearly",
    WEEKLY: "Weekly",
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400">
          {error}
        </div>
      )}
      {actionError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400">
          {actionError}
        </div>
      )}
      {subs.length === 0 && !loading && (
        <div className="rounded-xl border border-zinc-200 bg-white px-6 py-10 text-center shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <p className="text-sm text-zinc-500">No subscriptions found.</p>
        </div>
      )}
      {subs.map((s) => (
        <div
          key={s.id}
          className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <p className="font-semibold text-zinc-900 dark:text-zinc-100">
                  {s.membershipPlan.name}
                </p>
                <SubStatusBadge status={s.status} />
              </div>
              <p className="mt-0.5 text-sm text-zinc-500">
                {new Intl.NumberFormat(undefined, {
                  style: "currency",
                  currency: s.membershipPlan.currency.toUpperCase(),
                }).format(s.membershipPlan.priceCents / 100)}
                {" / "}
                {INTERVAL_LABELS[s.membershipPlan.billingInterval] ?? s.membershipPlan.billingInterval}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {s.status === "ACTIVE" && (
                <>
                  <button
                    onClick={() => void handleStatusChange(s.id, "PAUSED")}
                    disabled={actionLoading === s.id}
                    className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  >
                    {actionLoading === s.id ? "…" : "Pause"}
                  </button>
                  <button
                    onClick={() => void handleStatusChange(s.id, "CANCELED")}
                    disabled={actionLoading === s.id}
                    className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/30"
                  >
                    Cancel
                  </button>
                </>
              )}
              {s.status === "PAUSED" && (
                <button
                  onClick={() => void handleStatusChange(s.id, "ACTIVE")}
                  disabled={actionLoading === s.id}
                  className="rounded-lg border border-emerald-200 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-800 dark:text-emerald-400 dark:hover:bg-emerald-950/30"
                >
                  {actionLoading === s.id ? "…" : "Reactivate"}
                </button>
              )}
              {(s.status === "CANCELED" || s.status === "PAST_DUE") && (
                <button
                  onClick={() => void handleStatusChange(s.id, "ACTIVE")}
                  disabled={actionLoading === s.id}
                  className="rounded-lg border border-emerald-200 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-800 dark:text-emerald-400 dark:hover:bg-emerald-950/30"
                >
                  {actionLoading === s.id ? "…" : "Reactivate"}
                </button>
              )}
            </div>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <p className="text-xs text-zinc-400 dark:text-zinc-500">Period start</p>
              <p className="text-sm text-zinc-700 dark:text-zinc-300">{fmtDate(s.currentPeriodStart)}</p>
            </div>
            <div>
              <p className="text-xs text-zinc-400 dark:text-zinc-500">Period end</p>
              <p className="text-sm text-zinc-700 dark:text-zinc-300">{fmtDate(s.currentPeriodEnd)}</p>
            </div>
            <div>
              <p className="text-xs text-zinc-400 dark:text-zinc-500">Credits</p>
              <p className="text-sm text-zinc-700 dark:text-zinc-300">
                {s.membershipPlan.classCredits ?? "Unlimited"}
              </p>
            </div>
            <div>
              <p className="text-xs text-zinc-400 dark:text-zinc-500">Cancel at period end</p>
              <p className="text-sm text-zinc-700 dark:text-zinc-300">
                {s.cancelAtPeriodEnd ? "Yes" : "No"}
              </p>
            </div>
          </div>
        </div>
      ))}
      <p className="text-xs text-zinc-400 dark:text-zinc-500">
        Status changes are local only — they may be overridden by the next Stripe webhook.
      </p>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function MemberProfilePage() {
  const { userId } = useParams<{ userId: string }>();
  const { selectedStudioId } = useDeskStudio();

  const [profile, setProfile] = useState<MemberProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("overview");

  const load = useCallback(async () => {
    if (!selectedStudioId || !userId) return;
    setLoading(true);
    setError(null);
    try {
      const p = await fetchMemberProfile(selectedStudioId, userId);
      setProfile(p);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load member profile");
    } finally {
      setLoading(false);
    }
  }, [selectedStudioId, userId]);

  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);

  if (!selectedStudioId) return null;

  return (
    <div className="space-y-6">
      {/* Back + header */}
      <div>
        <Link
          href="/members"
          className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
        >
          ← Members
        </Link>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400">
          {error}
        </div>
      )}

      {loading && !profile ? (
        <div className="space-y-4">
          <CardSkeleton lines={3} />
          <div className="grid grid-cols-3 gap-4">
            <CardSkeleton lines={1} />
            <CardSkeleton lines={1} />
            <CardSkeleton lines={1} />
          </div>
        </div>
      ) : profile ? (
        <>
          {/* Profile header */}
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-zinc-200 text-lg font-bold text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200">
              {initials(profile.user.firstName, profile.user.lastName)}
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
                {profile.user.firstName} {profile.user.lastName}
              </h1>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">{profile.user.email}</p>
              {profile.user.phone && (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">{profile.user.phone}</p>
              )}
            </div>
            <div className="ml-auto flex items-center gap-2">
              <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                {profile.role}
              </span>
              {profile.activeSubscription && (
                <SubStatusBadge status={profile.activeSubscription.status} />
              )}
            </div>
          </div>

          {/* Overview KPIs */}
          {activeTab === "overview" && (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <StatCard label="Total check-ins" value={profile.attendances.totalInStudio} />
              <StatCard
                label="Plan"
                value={profile.activeSubscription?.plan.name ?? "None"}
              />
              <StatCard
                label="Member since"
                value={fmtDate(profile.membership.createdAt)}
              />
              <StatCard
                label="Period ends"
                value={fmtDate(profile.activeSubscription?.currentPeriodEnd)}
              />
            </div>
          )}

          {/* Tabs */}
          <div className="border-b border-zinc-200 dark:border-zinc-800">
            <nav className="-mb-px flex gap-1 overflow-x-auto">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setActiveTab(t.id)}
                  className={`shrink-0 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                    activeTab === t.id
                      ? "border-zinc-900 text-zinc-900 dark:border-zinc-100 dark:text-zinc-100"
                      : "border-transparent text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </nav>
          </div>

          {/* Tab content */}
          <div>
            {activeTab === "overview" && (
              <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
                <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <dt className="text-xs font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">Email</dt>
                    <dd className="mt-1 text-sm text-zinc-900 dark:text-zinc-100">{profile.user.email}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">Phone</dt>
                    <dd className="mt-1 text-sm text-zinc-900 dark:text-zinc-100">{profile.user.phone ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">Role</dt>
                    <dd className="mt-1 text-sm text-zinc-900 dark:text-zinc-100">{profile.role}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">Member since</dt>
                    <dd className="mt-1 text-sm text-zinc-900 dark:text-zinc-100">{fmtDateTime(profile.membership.createdAt)}</dd>
                  </div>
                  {profile.activeSubscription && (
                    <>
                      <div>
                        <dt className="text-xs font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">Current plan</dt>
                        <dd className="mt-1 flex items-center gap-2 text-sm text-zinc-900 dark:text-zinc-100">
                          {profile.activeSubscription.plan.name}
                          <SubStatusBadge status={profile.activeSubscription.status} />
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">Renews</dt>
                        <dd className="mt-1 text-sm text-zinc-900 dark:text-zinc-100">
                          {fmtDate(profile.activeSubscription.currentPeriodEnd)}
                          {profile.activeSubscription.cancelAtPeriodEnd && (
                            <span className="ml-2 text-xs text-red-500">Cancels at period end</span>
                          )}
                        </dd>
                      </div>
                    </>
                  )}
                </dl>
              </div>
            )}
            {activeTab === "membership" && (
              <MembershipTab studioId={selectedStudioId} userId={userId} />
            )}
            {activeTab === "bookings" && (
              <BookingsTab studioId={selectedStudioId} userId={userId} />
            )}
            {activeTab === "attendance" && (
              <AttendanceTab studioId={selectedStudioId} userId={userId} />
            )}
            {activeTab === "billing" && (
              <BillingTab studioId={selectedStudioId} userId={userId} />
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
