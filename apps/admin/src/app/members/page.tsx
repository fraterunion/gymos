"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { PageHeader } from "@/components/shell/PageHeader";
import { SurfaceCard } from "@/components/shell/SurfaceCard";
import { useDeskStudio } from "@/contexts/DeskStudioContext";
import { ApiError } from "@/lib/api/errors";
import {
  fetchMembers,
  type ActivityFilter,
  type LifecycleFilter,
  type MemberListItem,
  type MemberListQuery,
  type PaymentSource,
} from "@/lib/api/members";
import { fetchMembershipPlans, type MembershipPlanDto } from "@/lib/api/memberships";
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

function fmtNextEvent(iso: string | null | undefined) {
  if (!iso) return "Sin reserva";
  const date = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const day = sameDay(date, today) ? "Hoy" : sameDay(date, tomorrow) ? "Mañana" : date.toLocaleDateString("es-MX", { weekday: "short", day: "numeric" });
  return `${day} · ${date.toLocaleTimeString("es-MX", { hour: "numeric", minute: "2-digit" })}`;
}

function attentionLabel(member: MemberListItem) {
  if (member.subscription?.lifecycleStatus === "EXPIRED") return "Renovar";
  if (member.subscription?.lifecycleStatus === "PAST_DUE") return "Pago pendiente";
  if (member.usage?.remaining === 0) return "Sin créditos";
  if (member.noShowCount > 0) return `${member.noShowCount} no-show${member.noShowCount === 1 ? "" : "s"}`;
  if (!member.lastAttendanceAt || daysBetween(member.lastAttendanceAt) >= 30) return "Sin actividad 30d";
  return "—";
}

function daysBetween(iso: string) { return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000); }

const SUB_STATUS_LABELS = {
  ACTIVE: "Activa",
  TRIALING: "Prueba",
  PAST_DUE: "Pago pendiente",
  PAUSED: "Pausada",
  CANCELED: "Cancelada",
};

const LIFECYCLE_LABELS = {
  ...SUB_STATUS_LABELS,
  ENDING: "Termina pronto",
  SCHEDULED: "Programada",
  EXPIRED: "Vencida",
} as const;

const SUB_STATUS_COLORS = {
  ACTIVE: "bg-emerald-100 text-emerald-800",
  TRIALING: "bg-sky-100 text-sky-800",
  PAST_DUE: "bg-amber-100 text-amber-800",
  PAUSED: "bg-zinc-100 text-zinc-600",
  CANCELED: "bg-red-100 text-red-700",
};

const LIFECYCLE_COLORS = {
  ...SUB_STATUS_COLORS,
  ENDING: "bg-amber-100 text-amber-800",
  SCHEDULED: "bg-sky-100 text-sky-800",
  EXPIRED: "bg-red-100 text-red-700",
} as const;

function RowSkeleton() {
  return (
    <tr className="border-b border-zinc-100">
      {[...Array(8)].map((_, i) => (
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

function MemberStatusPill({ status }: { status: keyof typeof LIFECYCLE_LABELS }) {
  return (
    <span className={`${adminStatusPill} ${LIFECYCLE_COLORS[status]}`}>
      {LIFECYCLE_LABELS[status]}
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
          <MemberStatusPill status={member.subscription.lifecycleStatus} />
        ) : (
          <span className="text-xs text-zinc-400">Sin plan</span>
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
        <span>{member.subscription?.planName ?? "—"}</span>
        <span>{member.usage?.limit === null ? "Ilimitada" : member.usage ? `${member.usage.used} / ${member.usage.limit} usadas` : "—"}</span>
        <span>Última visita: {fmtRelative(member.lastAttendanceAt)}</span>
      </div>
    </Link>
  );
}

export default function MembersPage() {
  const { selectedStudioId } = useDeskStudio();

  const [members, setMembers] = useState<MemberListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState({ active: 0, ending: 0, expired: 0, pastDue: 0, noMembership: 0, inactive30d: 0, noShows: 0 });
  const [plans, setPlans] = useState<MembershipPlanDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [lifecycleStatus, setLifecycleStatus] = useState<LifecycleFilter | "">("");
  const [planId, setPlanId] = useState("");
  const [paymentSource, setPaymentSource] = useState<PaymentSource | "">("");
  const [activity, setActivity] = useState<ActivityFilter | "">("");
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

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setSearch(params.get("q") ?? "");
    setLifecycleStatus((params.get("status") as LifecycleFilter | null) ?? "");
    setPlanId(params.get("plan") ?? "");
    setPaymentSource((params.get("source") as PaymentSource | null) ?? "");
    setActivity((params.get("activity") as ActivityFilter | null) ?? "");
  }, []);

  useEffect(() => {
    const params = new URLSearchParams();
    if (search) params.set("q", search);
    if (lifecycleStatus) params.set("status", lifecycleStatus);
    if (planId) params.set("plan", planId);
    if (paymentSource) params.set("source", paymentSource);
    if (activity) params.set("activity", activity);
    window.history.replaceState(null, "", `${window.location.pathname}${params.size ? `?${params}` : ""}`);
  }, [search, lifecycleStatus, planId, paymentSource, activity]);

  useEffect(() => {
    if (!selectedStudioId) return;
    void fetchMembershipPlans(selectedStudioId, true).then(setPlans).catch(() => setPlans([]));
  }, [selectedStudioId]);

  const load = useCallback(async () => {
    if (!selectedStudioId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchMembers(selectedStudioId, {
        role: "MEMBER",
        search: debouncedSearch || undefined,
        lifecycleStatus: lifecycleStatus || undefined,
        planId: planId || undefined,
        paymentSource: paymentSource || undefined,
        activity: activity || undefined,
        sortBy,
        sortDir,
        page,
        limit,
      });
      setMembers(res.data);
      setTotal(res.total);
      setSummary(res.summary);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudieron cargar los miembros");
    } finally {
      setLoading(false);
    }
  }, [selectedStudioId, debouncedSearch, lifecycleStatus, planId, paymentSource, activity, sortBy, sortDir, page, limit]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    const t = setTimeout(() => setPage(1), 0);
    return () => clearTimeout(t);
  }, [debouncedSearch, lifecycleStatus, planId, paymentSource, activity, sortBy, sortDir]);

  function handleSort(field: SortKey) {
    if (field === sortBy) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(field);
      setSortDir("desc");
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / limit));
  const hasFilters = Boolean(search || lifecycleStatus || planId || paymentSource || activity);

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

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {[
          { label: "Activos", value: summary.active, status: "ACTIVE" as LifecycleFilter },
          { label: "Terminan pronto", value: summary.ending, status: "ENDING" as LifecycleFilter },
          { label: "Vencidos", value: summary.expired, status: "EXPIRED" as LifecycleFilter },
          { label: "Pago pendiente", value: summary.pastDue, status: "PAST_DUE" as LifecycleFilter },
          { label: "Sin membresía", value: summary.noMembership, status: "NONE" as LifecycleFilter },
        ].map((item) => (
          <button key={item.status} type="button" onClick={() => setLifecycleStatus(item.status)} className={`rounded-xl border px-4 py-3 text-left transition ${lifecycleStatus === item.status ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-200 bg-white hover:border-zinc-300"}`}>
            <span className="block text-2xl font-semibold tabular-nums">{item.value}</span>
            <span className={`text-xs ${lifecycleStatus === item.status ? "text-zinc-300" : "text-zinc-500"}`}>{item.label}</span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          placeholder="Buscar nombre, correo o teléfono…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={`${adminInput} w-full max-w-xs`}
        />
        <select
          value={lifecycleStatus}
          onChange={(e) => setLifecycleStatus(e.target.value as LifecycleFilter | "")}
          className={adminSelect}
        >
          <option value="">Todos los estados</option>
          <option value="ACTIVE">Activa</option><option value="ENDING">Termina pronto</option><option value="EXPIRED">Vencida</option>
          <option value="TRIALING">Prueba</option><option value="PAST_DUE">Pago pendiente</option><option value="PAUSED">Pausada</option>
          <option value="CANCELED">Cancelada</option><option value="SCHEDULED">Programada</option><option value="NONE">Sin membresía</option>
        </select>
        <select value={planId} onChange={(e) => setPlanId(e.target.value)} className={adminSelect}>
          <option value="">Todos los planes</option>
          {plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}
        </select>
        <select value={paymentSource} onChange={(e) => setPaymentSource(e.target.value as PaymentSource | "")} className={adminSelect}>
          <option value="">Todos los cobros</option><option value="STRIPE">Stripe</option><option value="CASH">Efectivo</option><option value="MANUAL">Manual</option><option value="NONE">Sin membresía</option>
        </select>
        <select value={activity} onChange={(e) => setActivity(e.target.value as ActivityFilter | "")} className={adminSelect}>
          <option value="">Toda la actividad</option><option value="VISITED_7D">Visitó últimos 7 días</option><option value="VISITED_30D">Visitó últimos 30 días</option>
          <option value="NO_VISIT_14D">Sin visita 14+ días</option><option value="NO_VISIT_30D">Sin visita 30+ días</option><option value="NEVER_ATTENDED">Nunca ha asistido</option>
          <option value="HAS_NO_SHOWS">Con no-shows</option><option value="HAS_FUTURE_BOOKING">Con reserva futura</option><option value="NO_FUTURE_BOOKING">Sin reserva futura</option><option value="ENDING_7D">Termina en 7 días</option>
        </select>
        {hasFilters ? (
          <button
            type="button"
            onClick={() => {
              setSearch("");
              setLifecycleStatus("");
              setPlanId("");
              setPaymentSource("");
              setActivity("");
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
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-600">Membresía</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-600">Estado</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-600">Uso</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-600">Próximo evento</th>
                <SortTh label="Última visita" field="lastAttendance" current={sortBy} dir={sortDir} onSort={handleSort} />
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-600">Pago</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-600">Atención</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {loading
                ? [...Array(8)].map((_, i) => <RowSkeleton key={i} />)
                : members.length === 0
                  ? (
                    <tr>
                      <td colSpan={8} className="px-4 py-12 text-center text-sm text-zinc-600">
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
                      <td className="px-4 py-3.5 text-sm text-zinc-700">
                        {m.subscription?.planName ?? <span className="text-zinc-400">Sin plan</span>}
                      </td>
                      <td className="px-4 py-3.5">
                        {m.subscription ? (
                          <MemberStatusPill status={m.subscription.lifecycleStatus} />
                        ) : (
                          <span className="text-xs text-zinc-400">Sin plan</span>
                        )}
                      </td>
                      <td className="px-4 py-3.5 text-sm text-zinc-700">{m.usage?.limit === null ? "Ilimitada" : m.usage ? <><span className="font-medium">{m.usage.used} / {m.usage.limit}</span><span className="block text-xs text-zinc-400">{m.usage.remaining} restantes</span></> : "—"}</td>
                      <td className="px-4 py-3.5 text-sm text-zinc-600"><span className="block">{fmtNextEvent(m.nextBooking?.startsAt)}</span>{m.nextBooking ? <span className="block max-w-36 truncate text-xs text-zinc-400">{m.nextBooking.className}</span> : null}</td>
                      <td className="px-4 py-3.5 text-sm text-zinc-600">{fmtRelative(m.lastAttendanceAt)}</td>
                      <td className="px-4 py-3.5 text-sm text-zinc-600">{m.subscription ? <><span className="block">{m.subscription.source === "CASH" ? "Efectivo" : m.subscription.source === "STRIPE" ? "Stripe" : "Manual"}</span><span className="text-xs text-zinc-400">{m.subscription.lifecycleStatus === "PAST_DUE" ? "Pago pendiente" : m.subscription.lifecycleStatus === "EXPIRED" ? `Venció ${fmtDate(m.subscription.effectiveEnd)}` : m.lastPayment?.status === "SUCCEEDED" ? "Al corriente" : "Sin pago reciente"}</span></> : "No aplica"}</td>
                      <td className="px-4 py-3.5 text-sm font-medium text-zinc-700">{attentionLabel(m)}</td>
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
