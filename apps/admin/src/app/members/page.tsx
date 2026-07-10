"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { useDeskStudio } from "@/contexts/DeskStudioContext";
import {
  fetchMembers,
  type MemberListItem,
  type MemberListQuery,
  type SubStatus,
} from "@/lib/api/members";
import { ApiError } from "@/lib/api/errors";

// ── Helpers ──────────────────────────────────────────────────────────────────

function initials(firstName: string, lastName: string) {
  return `${firstName[0] ?? ""}${lastName[0] ?? ""}`.toUpperCase();
}

function fmtDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function fmtRelative(iso: string | null | undefined) {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
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

// ── Skeleton ─────────────────────────────────────────────────────────────────

function RowSkeleton() {
  return (
    <tr className="border-b border-zinc-100 dark:border-zinc-800">
      {[...Array(7)].map((_, i) => (
        <td key={i} className="px-4 py-3">
          <div className="h-4 rounded bg-zinc-200 dark:bg-zinc-800 animate-pulse" style={{ width: `${60 + (i * 17) % 40}%` }} />
        </td>
      ))}
    </tr>
  );
}

// ── Sort header ───────────────────────────────────────────────────────────────

type SortKey = MemberListQuery["sortBy"];

function SortTh({
  label,
  field,
  current,
  dir,
  onSort,
  className = "",
}: {
  label: string;
  field: SortKey;
  current: SortKey;
  dir: "asc" | "desc";
  onSort: (f: SortKey) => void;
  className?: string;
}) {
  const active = current === field;
  return (
    <th
      className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 cursor-pointer select-none hover:text-zinc-800 dark:hover:text-zinc-200 ${className}`}
      onClick={() => onSort(field)}
    >
      <span className="flex items-center gap-1">
        {label}
        {active ? (
          <span className="text-zinc-800 dark:text-zinc-200">{dir === "asc" ? "↑" : "↓"}</span>
        ) : (
          <span className="text-zinc-300 dark:text-zinc-700">↕</span>
        )}
      </span>
    </th>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function MembersPage() {
  const { selectedStudioId } = useDeskStudio();

  const [members, setMembers] = useState<MemberListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [subStatus, setSubStatus] = useState<SubStatus | "">("");
  const [hasNoShows, setHasNoShows] = useState(false);
  const [sortBy, setSortBy] = useState<SortKey>("joinDate");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const limit = 25;

  const searchRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    if (searchRef.current) clearTimeout(searchRef.current);
    searchRef.current = setTimeout(() => setDebouncedSearch(search), 350);
    return () => {
      if (searchRef.current) clearTimeout(searchRef.current);
    };
  }, [search]);

  const load = useCallback(async () => {
    if (!selectedStudioId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchMembers(selectedStudioId, {
        role: "MEMBER",
        search: debouncedSearch || undefined,
        subStatus: (subStatus as SubStatus) || undefined,
        hasNoShows: hasNoShows || undefined,
        sortBy,
        sortDir,
        page,
        limit,
      });
      setMembers(res.data);
      setTotal(res.total);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load members");
    } finally {
      setLoading(false);
    }
  }, [selectedStudioId, debouncedSearch, subStatus, hasNoShows, sortBy, sortDir, page, limit]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    const t = setTimeout(() => setPage(1), 0);
    return () => clearTimeout(t);
  }, [debouncedSearch, subStatus, hasNoShows, sortBy, sortDir]);

  function handleSort(field: SortKey) {
    if (field === sortBy) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(field);
      setSortDir("desc");
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
            Members
          </h1>
          {!loading && (
            <p className="mt-0.5 text-sm text-zinc-500">
              {total.toLocaleString()} {total === 1 ? "member" : "members"}
            </p>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <input
          type="search"
          placeholder="Search name or email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-64 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 shadow-sm focus:border-zinc-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder-zinc-600"
        />
        <select
          value={subStatus}
          onChange={(e) => { setSubStatus(e.target.value as SubStatus | ""); setHasNoShows(false); }}
          className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:border-zinc-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
        >
          <option value="">All plans</option>
          {(Object.keys(SUB_STATUS_LABELS) as SubStatus[]).map((s) => (
            <option key={s} value={s}>{SUB_STATUS_LABELS[s]}</option>
          ))}
        </select>
        {/* Quick filter chips */}
        <button
          onClick={() => { setHasNoShows((v) => !v); setSubStatus(""); }}
          className={`rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
            hasNoShows
              ? "border-amber-400 bg-amber-50 text-amber-800 dark:border-amber-600 dark:bg-amber-900/30 dark:text-amber-300"
              : "border-zinc-200 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
          }`}
        >
          No Shows
        </button>
        {(search || subStatus || hasNoShows) && (
          <button
            onClick={() => { setSearch(""); setSubStatus(""); setHasNoShows(false); }}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-zinc-100 dark:divide-zinc-800">
            <thead className="bg-zinc-50 dark:bg-zinc-950/60">
              <tr>
                <SortTh label="Member" field="name" current={sortBy} dir={sortDir} onSort={handleSort} className="pl-4 min-w-[200px]" />
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Plan</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Status</th>
                <SortTh label="Bookings" field="totalBookings" current={sortBy} dir={sortDir} onSort={handleSort} />
                <SortTh label="Last visit" field="lastAttendance" current={sortBy} dir={sortDir} onSort={handleSort} />
                <SortTh label="Joined" field="joinDate" current={sortBy} dir={sortDir} onSort={handleSort} />
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {loading
                ? [...Array(8)].map((_, i) => <RowSkeleton key={i} />)
                : members.length === 0
                ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-sm text-zinc-500">
                      {debouncedSearch || subStatus
                        ? "No members match your filters."
                        : "No members yet."}
                    </td>
                  </tr>
                )
                : members.map((m) => (
                  <tr
                    key={m.membershipId}
                    className="group hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
                  >
                    {/* Avatar + name */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-xs font-semibold text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200">
                          {initials(m.user.firstName, m.user.lastName)}
                        </div>
                        <div className="min-w-0">
                          <div className="truncate font-medium text-zinc-900 dark:text-zinc-100">
                            {m.user.firstName} {m.user.lastName}
                          </div>
                          <div className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                            {m.user.email}
                          </div>
                        </div>
                      </div>
                    </td>
                    {/* Plan */}
                    <td className="px-4 py-3 text-sm text-zinc-700 dark:text-zinc-300">
                      {m.subscription?.planName ?? <span className="text-zinc-400">—</span>}
                    </td>
                    {/* Status */}
                    <td className="px-4 py-3">
                      {m.subscription ? (
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${SUB_STATUS_COLORS[m.subscription.status]}`}>
                          {SUB_STATUS_LABELS[m.subscription.status]}
                        </span>
                      ) : (
                        <span className="text-xs text-zinc-400">No plan</span>
                      )}
                    </td>
                    {/* Bookings + no-show badge */}
                    <td className="px-4 py-3 text-sm tabular-nums text-zinc-700 dark:text-zinc-300">
                      <span>{m.totalBookings.toLocaleString()}</span>
                      {m.noShowCount > 0 && (
                        <span className="ml-2 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                          {m.noShowCount} NS
                        </span>
                      )}
                    </td>
                    {/* Last visit */}
                    <td className="px-4 py-3 text-sm text-zinc-500 dark:text-zinc-400">
                      {fmtRelative(m.lastAttendanceAt)}
                    </td>
                    {/* Joined */}
                    <td className="px-4 py-3 text-sm text-zinc-500 dark:text-zinc-400">
                      {fmtDate(m.joinedAt)}
                    </td>
                    {/* Action */}
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/members/${m.user.id}`}
                        className="rounded-lg border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-600 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                      >
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-zinc-100 px-4 py-3 dark:border-zinc-800">
            <p className="text-xs text-zinc-500">
              Page {page} of {totalPages} · {total.toLocaleString()} members
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 disabled:opacity-40 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Previous
              </button>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 disabled:opacity-40 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
