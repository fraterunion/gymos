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
  nextClassPresentation,
  PAYMENT_SOURCE_PRESENTATION,
  PRIMARY_STATUS_COLORS,
  PRIMARY_STATUS_LABELS,
  renewalPresentation,
  visitPresentation,
} from "@/lib/memberPresentation";
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

function MemberStatusPill({ status }: { status: keyof typeof PRIMARY_STATUS_LABELS }) {
  return (
    <span className={`${adminStatusPill} ring-1 ring-inset ${PRIMARY_STATUS_COLORS[status]}`}>
      {PRIMARY_STATUS_LABELS[status]}
    </span>
  );
}

function PaymentSourceBadge({ source }: { source: keyof typeof PAYMENT_SOURCE_PRESENTATION }) {
  const presentation = PAYMENT_SOURCE_PRESENTATION[source];
  return (
    <span className={`${adminStatusPill} ring-1 ring-inset ${presentation.className}`}>
      {presentation.label}
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
          <MemberStatusPill status={member.subscription.primaryStatus} />
        ) : (
          <span className="text-xs text-zinc-400">Sin plan</span>
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
        <span>{member.subscription?.planName ?? "—"}</span>
        <span>{member.subscription ? renewalPresentation(member.subscription).title : "Sin membresía"}</span>
        <span>{member.usage?.limit === null ? "Ilimitado" : member.usage ? `${member.usage.used} / ${member.usage.limit} usadas` : "—"}</span>
        <span>Última visita: {visitPresentation(member.lastAttendanceAt).title}</span>
      </div>
    </Link>
  );
}

export default function MembersPage() {
  const { selectedStudioId } = useDeskStudio();

  const [members, setMembers] = useState<MemberListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState({ total: 0, active: 0, ending: 0, expired: 0, pastDue: 0, noMembership: 0, inactive30d: 0, noShows: 0 });
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
            ? `${summary.total.toLocaleString("es-MX")} ${summary.total === 1 ? "miembro" : "miembros"} · ${summary.active} activos · ${summary.ending} por vencer · ${summary.expired} vencidos`
            : "Directorio de miembros del estudio"
        }
      />

      <div className="flex flex-wrap items-center gap-1.5">
        {[
          { label: "Todos", value: summary.total, status: "" as LifecycleFilter | "", activity: "" as ActivityFilter | "" },
          { label: "Activos", value: summary.active, status: "ACTIVE" as LifecycleFilter, activity: "" as ActivityFilter | "" },
          { label: "Por vencer", value: summary.ending, status: "" as LifecycleFilter | "", activity: "ENDING_7D" as ActivityFilter },
          { label: "Vencidos", value: summary.expired, status: "EXPIRED" as LifecycleFilter, activity: "" as ActivityFilter | "" },
          { label: "Pago pendiente", value: summary.pastDue, status: "PAST_DUE" as LifecycleFilter, activity: "" as ActivityFilter | "" },
        ].map((item) => (
          <button key={item.label} type="button" onClick={() => { setLifecycleStatus(item.status); setActivity(item.activity); }} className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${lifecycleStatus === item.status && activity === item.activity ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"}`}>
            {item.label} <span className="ml-1 tabular-nums opacity-70">{item.value}</span>
          </button>
        ))}
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white p-2 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          placeholder="Buscar nombre, correo o teléfono…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={`${adminInput} min-w-[240px] flex-1 border-0 bg-zinc-50 shadow-none`}
        />
        <select
          value={lifecycleStatus}
          onChange={(e) => setLifecycleStatus(e.target.value as LifecycleFilter | "")}
          className={adminSelect}
        >
          <option value="">Todos los estados</option>
          <option value="ACTIVE">Activa</option><option value="EXPIRED">Vencida</option>
          <option value="TRIALING">Prueba</option><option value="PAST_DUE">Pago pendiente</option><option value="PAUSED">Pausada</option>
          <option value="CANCELED">Cancelada</option><option value="SCHEDULED">Programada</option><option value="NONE">Sin membresía</option>
        </select>
        <select value={planId} onChange={(e) => setPlanId(e.target.value)} className={adminSelect}>
          <option value="">Plan</option>
          {plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}
        </select>
        <select value={paymentSource} onChange={(e) => setPaymentSource(e.target.value as PaymentSource | "")} className={adminSelect}>
          <option value="">Pago</option><option value="STRIPE">Stripe</option><option value="CASH">Efectivo</option><option value="MANUAL">Manual</option><option value="NONE">Sin membresía</option>
        </select>
        <select value={activity} onChange={(e) => setActivity(e.target.value as ActivityFilter | "")} className={adminSelect}>
          <option value="">Actividad</option><option value="VISITED_7D">Visitó últimos 7 días</option><option value="VISITED_30D">Visitó últimos 30 días</option>
          <option value="NO_VISIT_14D">Sin visita 14+ días</option><option value="NO_VISIT_30D">Sin visita 30+ días</option><option value="NEVER_ATTENDED">Nunca ha asistido</option>
          <option value="HAS_NO_SHOWS">Con no-shows</option><option value="HAS_FUTURE_BOOKING">Con reserva futura</option><option value="NO_FUTURE_BOOKING">Sin reserva futura</option><option value="ENDING_7D">Por vencer</option>
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
            Limpiar filtros
          </button>
        ) : null}
      </div>
      {hasFilters ? <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-zinc-100 pt-2">
        {lifecycleStatus ? <button type="button" onClick={() => setLifecycleStatus("")} className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs text-zinc-700">{lifecycleStatus === "NONE" ? "Sin membresía" : lifecycleStatus === "ENDING" ? "Por vencer" : PRIMARY_STATUS_LABELS[lifecycleStatus]} ×</button> : null}
        {planId ? <button type="button" onClick={() => setPlanId("")} className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs text-zinc-700">{plans.find((plan) => plan.id === planId)?.name ?? "Plan"} ×</button> : null}
        {paymentSource ? <button type="button" onClick={() => setPaymentSource("")} className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs text-zinc-700">{paymentSource === "CASH" ? "Efectivo" : paymentSource === "NONE" ? "Sin membresía" : paymentSource} ×</button> : null}
        {activity ? <button type="button" onClick={() => setActivity("")} className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs text-zinc-700">{activity === "ENDING_7D" ? "Por vencer" : "Actividad"} ×</button> : null}
      </div> : null}
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
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-600">Plan</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-600">Estado</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-600">Pago</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-600 min-w-[150px]">Renovación / vencimiento</th>
                <th className="hidden px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-600 lg:table-cell">Uso</th>
                <SortTh label="Última visita" field="lastAttendance" current={sortBy} dir={sortDir} onSort={handleSort} className="hidden xl:table-cell" />
                <th className="hidden px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-600 xl:table-cell">Próxima clase</th>
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
                          <MemberStatusPill status={m.subscription.primaryStatus} />
                        ) : (
                          <span className={`${adminStatusPill} bg-zinc-100 text-zinc-500 ring-1 ring-inset ring-zinc-500/15`}>Sin membresía</span>
                        )}
                      </td>
                      <td className="px-4 py-3.5">{m.subscription ? <PaymentSourceBadge source={m.subscription.source} /> : "—"}</td>
                      <td className="px-4 py-3.5 text-sm text-zinc-700">{m.subscription ? (() => { const renewal = renewalPresentation(m.subscription); return <><span className="block font-medium">{renewal.title}</span>{renewal.detail ? <span className="block text-xs text-zinc-400">{renewal.detail}</span> : null}</>; })() : "—"}</td>
                      <td className="hidden px-4 py-3.5 text-sm text-zinc-700 lg:table-cell">{m.usage?.limit === null ? "Ilimitado" : m.usage ? <><span className="font-medium tabular-nums">{m.usage.used} / {m.usage.limit}</span><span className={`block text-xs ${m.usage.remaining === 0 ? "font-medium text-rose-600" : "text-zinc-400"}`}>{m.usage.remaining === 0 ? "Sin créditos" : `${m.usage.remaining} ${m.usage.remaining === 1 ? "restante" : "restantes"}`}</span></> : "—"}</td>
                      <td className="hidden px-4 py-3.5 text-sm text-zinc-600 xl:table-cell">{(() => { const visit = visitPresentation(m.lastAttendanceAt); return <><span className="block">{visit.title}</span>{visit.detail ? <span className="block text-xs text-zinc-400">{visit.detail}</span> : null}</>; })()}</td>
                      <td className="hidden px-4 py-3.5 text-sm text-zinc-600 xl:table-cell"><span className="block">{nextClassPresentation(m.nextBooking?.startsAt)}</span>{m.nextBooking ? <span className="block max-w-36 truncate text-xs text-zinc-400">{m.nextBooking.className}</span> : null}</td>
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
