"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { PageHeader } from "@/components/shell/PageHeader";
import { SurfaceCard } from "@/components/shell/SurfaceCard";
import { useDeskStudio } from "@/contexts/DeskStudioContext";
import { ApiError } from "@/lib/api/errors";
import {
  fetchMembers,
  type MemberListItem,
  type MemberListQuery,
  type SubStatus,
} from "@/lib/api/members";
import {
  adminInput,
  adminSecondaryBtn,
  adminSelect,
  adminStatusPill,
  adminTableWrap,
} from "@/lib/adminSurface";

function initials(firstName: string, lastName: string) {
  return `${firstName[0] ?? ""}${lastName[0] ?? ""}`.toUpperCase();
}

function fmtDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("es-MX", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function fmtRelative(iso: string | null | undefined) {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days === 0) return "Hoy";
  if (days === 1) return "Ayer";
  if (days < 30) return `Hace ${days}d`;
  if (days < 365) return `Hace ${Math.floor(days / 30)}m`;
  return `Hace ${Math.floor(days / 365)}a`;
}

const SUB_STATUS_LABELS: Record<SubStatus, string> = {
  ACTIVE: "Activa",
  TRIALING: "Prueba",
  PAST_DUE: "Vencida",
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

function RowSkeleton() {
  return (
    <tr className="border-b border-zinc-100">
      {[...Array(6)].map((_, i) => (
        <td key={i} className="px-4 py-3.5">
          <div className="h-4 rounded bg-zinc-200 animate-pulse" style={{ width: `${60 + (i * 17) % 40}%` }} />
        </td>
      ))}
    </tr>
  );
}

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
      className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-600 cursor-pointer select-none hover:text-zinc-900 ${className}`}
      onClick={() => onSort(field)}
    >
      <span className="flex items-center gap-1">
        {label}
        {active ? (
          <span className="text-zinc-900">{dir === "asc" ? "↑" : "↓"}</span>
        ) : (
          <span className="text-zinc-300">↕</span>
        )}
      </span>
    </th>
  );
}

function MemberStatusPill({ status }: { status: SubStatus }) {
  return (
    <span className={`${adminStatusPill} ${SUB_STATUS_COLORS[status]}`}>
      {SUB_STATUS_LABELS[status]}
    </span>
  );
}

function MemberCard({ member }: { member: MemberListItem }) {
  return (
    <Link
      href={`/members/${member.user.id}`}
      className="block rounded-xl border border-zinc-200 bg-white p-4 shadow-sm transition hover:border-zinc-300 hover:shadow"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-sm font-semibold text-zinc-700">
          {initials(member.user.firstName, member.user.lastName)}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-zinc-900">
            {member.user.firstName} {member.user.lastName}
          </p>
          <p className="truncate text-sm text-zinc-600">{member.user.email}</p>
          {member.user.phone ? (
            <p className="mt-0.5 text-sm text-zinc-500">{member.user.phone}</p>
          ) : null}
        </div>
        {member.subscription ? (
          <MemberStatusPill status={member.subscription.status} />
        ) : (
          <span className="text-xs text-zinc-400">Sin plan</span>
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
        <span>{member.subscription?.planName ?? "—"}</span>
        <span>Última visita: {fmtRelative(member.lastAttendanceAt)}</span>
      </div>
    </Link>
  );
}

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
      setError(e instanceof ApiError ? e.message : "No se pudieron cargar los miembros");
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
  const hasFilters = Boolean(search || subStatus || hasNoShows);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Miembros"
        subtitle={
          !loading
            ? `${total.toLocaleString("es-MX")} ${total === 1 ? "miembro" : "miembros"}`
            : "Directorio de miembros del estudio"
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          placeholder="Buscar nombre, correo o teléfono…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={`${adminInput} w-full max-w-xs`}
        />
        <select
          value={subStatus}
          onChange={(e) => {
            setSubStatus(e.target.value as SubStatus | "");
            setHasNoShows(false);
          }}
          className={adminSelect}
        >
          <option value="">Todos los estados</option>
          {(Object.keys(SUB_STATUS_LABELS) as SubStatus[]).map((s) => (
            <option key={s} value={s}>
              {SUB_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => {
            setHasNoShows((v) => !v);
            setSubStatus("");
          }}
          className={`rounded-xl border px-3 py-2 text-xs font-medium transition ${
            hasNoShows
              ? "border-amber-300 bg-amber-50 text-amber-800"
              : "border-zinc-200 text-zinc-600 hover:bg-zinc-50"
          }`}
        >
          No-shows
        </button>
        {hasFilters ? (
          <button
            type="button"
            onClick={() => {
              setSearch("");
              setSubStatus("");
              setHasNoShows(false);
            }}
            className={adminSecondaryBtn}
          >
            Limpiar
          </button>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      {/* Mobile cards */}
      <div className="space-y-3 md:hidden">
        {loading
          ? [...Array(5)].map((_, i) => (
              <div key={i} className="h-24 animate-pulse rounded-xl bg-zinc-100" />
            ))
          : members.length === 0
            ? (
              <SurfaceCard padding="sm">
                <p className="py-6 text-center text-sm text-zinc-600">
                  {hasFilters
                    ? "Ningún miembro coincide con tus filtros."
                    : "Aún no hay miembros registrados."}
                </p>
              </SurfaceCard>
            )
            : members.map((m) => <MemberCard key={m.membershipId} member={m} />)}
      </div>

      {/* Desktop table */}
      <div className={`hidden md:block ${adminTableWrap}`}>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-zinc-100">
            <thead className="bg-zinc-50/80">
              <tr>
                <SortTh label="Miembro" field="name" current={sortBy} dir={sortDir} onSort={handleSort} className="pl-4 min-w-[220px]" />
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-600">Teléfono</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-600">Plan</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-600">Estado</th>
                <SortTh label="Reservas" field="totalBookings" current={sortBy} dir={sortDir} onSort={handleSort} />
                <SortTh label="Última visita" field="lastAttendance" current={sortBy} dir={sortDir} onSort={handleSort} />
                <SortTh label="Alta" field="joinDate" current={sortBy} dir={sortDir} onSort={handleSort} />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {loading
                ? [...Array(8)].map((_, i) => <RowSkeleton key={i} />)
                : members.length === 0
                  ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-12 text-center text-sm text-zinc-600">
                        {hasFilters
                          ? "Ningún miembro coincide con tus filtros."
                          : "Aún no hay miembros registrados."}
                      </td>
                    </tr>
                  )
                  : members.map((m) => (
                    <tr key={m.membershipId} className="group transition-colors hover:bg-zinc-50">
                      <td className="px-4 py-3.5">
                        <Link href={`/members/${m.user.id}`} className="flex items-center gap-3">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold text-zinc-700">
                            {initials(m.user.firstName, m.user.lastName)}
                          </div>
                          <div className="min-w-0">
                            <div className="truncate font-medium text-zinc-900 group-hover:underline">
                              {m.user.firstName} {m.user.lastName}
                            </div>
                            <div className="truncate text-xs text-zinc-600">{m.user.email}</div>
                          </div>
                        </Link>
                      </td>
                      <td className="px-4 py-3.5 text-sm text-zinc-600">
                        {m.user.phone ?? <span className="text-zinc-400">—</span>}
                      </td>
                      <td className="px-4 py-3.5 text-sm text-zinc-700">
                        {m.subscription?.planName ?? <span className="text-zinc-400">—</span>}
                      </td>
                      <td className="px-4 py-3.5">
                        {m.subscription ? (
                          <MemberStatusPill status={m.subscription.status} />
                        ) : (
                          <span className="text-xs text-zinc-400">Sin plan</span>
                        )}
                      </td>
                      <td className="px-4 py-3.5 text-sm tabular-nums text-zinc-700">
                        <span>{m.totalBookings.toLocaleString("es-MX")}</span>
                        {m.noShowCount > 0 ? (
                          <span className="ml-2 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                            {m.noShowCount} NS
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3.5 text-sm text-zinc-600">{fmtRelative(m.lastAttendanceAt)}</td>
                      <td className="px-4 py-3.5 text-sm text-zinc-600">{fmtDate(m.joinedAt)}</td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>

        {totalPages > 1 ? (
          <div className="flex items-center justify-between border-t border-zinc-100 px-4 py-3">
            <p className="text-xs text-zinc-600">
              Página {page} de {totalPages} · {total.toLocaleString("es-MX")} miembros
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className={`${adminSecondaryBtn} px-3 py-1.5 text-xs disabled:opacity-40`}
              >
                Anterior
              </button>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className={`${adminSecondaryBtn} px-3 py-1.5 text-xs disabled:opacity-40`}
              >
                Siguiente
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {totalPages > 1 ? (
        <div className="flex items-center justify-between md:hidden">
          <p className="text-xs text-zinc-600">
            Página {page} de {totalPages}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className={`${adminSecondaryBtn} px-3 py-1.5 text-xs disabled:opacity-40`}
            >
              Anterior
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className={`${adminSecondaryBtn} px-3 py-1.5 text-xs disabled:opacity-40`}
            >
              Siguiente
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
