"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { AnalyticsSubNav } from "@/components/analytics/AnalyticsSubNav";
import { PageHeader } from "@/components/shell/PageHeader";
import { SurfaceCard } from "@/components/shell/SurfaceCard";
import { useDeskStudio } from "@/contexts/DeskStudioContext";
import { adminInput, adminSecondaryBtn, adminStatusPill, adminTableWrap } from "@/lib/adminSurface";
import {
  fetchMemberAnalyticsActivity,
  fetchMemberAnalyticsDetail,
  fetchMemberAnalyticsList,
  fetchMemberAnalyticsSummary,
  type MemberAnalyticsDetailDto,
  type MemberAnalyticsPeriodKey,
  type MemberAnalyticsRowDto,
  type MemberAnalyticsSummaryDto,
  type MemberAnalyticsActivityDto,
} from "@/lib/api/member-analytics";
import { ApiError } from "@/lib/api/errors";
import { canAccessExecutiveDashboard } from "@/lib/executivePermissions";
import {
  ENGAGEMENT_STATUS_CLASS,
  ENGAGEMENT_STATUS_LABELS,
  formatDecimal,
  formatFavoriteScheduleTime,
  formatFavoriteWeekday,
  formatLastVisit,
  formatTrendPct,
  memberInitials,
} from "@/lib/memberAnalyticsPresentation";

const PERIODS: { key: MemberAnalyticsPeriodKey; label: string }[] = [
  { key: "this_month", label: "Este mes" },
  { key: "prev_month", label: "Mes anterior" },
  { key: "last_30d", label: "Últimos 30 días" },
  { key: "last_90d", label: "Últimos 90 días" },
  { key: "this_year", label: "Este año" },
];

type TabKey = "resumen" | "actividad";

function KpiCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <SurfaceCard className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-zinc-900">{value}</p>
      {hint ? <p className="mt-1 text-xs text-zinc-500">{hint}</p> : null}
    </SurfaceCard>
  );
}

function MemberAnalyticsDrawer({
  member,
  onClose,
}: {
  member: MemberAnalyticsDetailDto;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/20">
      <div className="h-full w-full max-w-md overflow-y-auto bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-zinc-200 p-5">
          <div>
            <p className="text-lg font-semibold text-zinc-900">
              {member.firstName} {member.lastName}
            </p>
            <p className="text-sm text-zinc-500">{member.planName ?? "Sin plan"}</p>
            <span className={`${adminStatusPill} mt-2 inline-flex ${ENGAGEMENT_STATUS_CLASS[member.engagementStatus]}`}>
              {ENGAGEMENT_STATUS_LABELS[member.engagementStatus]}
            </span>
          </div>
          <button type="button" className={adminSecondaryBtn} onClick={onClose}>
            Cerrar
          </button>
        </div>
        <div className="space-y-6 p-5 text-sm">
          <section>
            <h3 className="mb-2 font-medium text-zinc-900">Actividad</h3>
            <dl className="grid grid-cols-2 gap-3">
              <div><dt className="text-zinc-500">Visitas periodo</dt><dd className="font-medium">{member.visitsPeriod}</dd></div>
              <div><dt className="text-zinc-500">30 días</dt><dd className="font-medium">{member.visits30d}</dd></div>
              <div><dt className="text-zinc-500">90 días</dt><dd className="font-medium">{member.visits90d}</dd></div>
              <div><dt className="text-zinc-500">Prom / semana</dt><dd className="font-medium">{formatDecimal(member.visitsPerWeek)}</dd></div>
              <div><dt className="text-zinc-500">Última visita</dt><dd className="font-medium">{formatLastVisit(member.lastVisitAt)}</dd></div>
              <div><dt className="text-zinc-500">Primera visita</dt><dd className="font-medium">{formatLastVisit(member.firstVisitAt)}</dd></div>
            </dl>
          </section>
          <section>
            <h3 className="mb-2 font-medium text-zinc-900">Preferencias</h3>
            <dl className="grid grid-cols-2 gap-3">
              <div><dt className="text-zinc-500">Clase favorita</dt><dd>{member.favoriteClass ?? "—"}</dd></div>
              <div><dt className="text-zinc-500">Horario</dt><dd>{formatFavoriteScheduleTime(member.favoriteTime)}</dd></div>
              <div><dt className="text-zinc-500">Instructor</dt><dd>{member.favoriteInstructor ?? "—"}</dd></div>
              <div><dt className="text-zinc-500">Día</dt><dd>{formatFavoriteWeekday(member.favoriteWeekday)}</dd></div>
            </dl>
          </section>
          <section>
            <h3 className="mb-2 font-medium text-zinc-900">Comportamiento</h3>
            <dl className="grid grid-cols-2 gap-3">
              <div><dt className="text-zinc-500">Reservas</dt><dd>{member.bookingsPeriod}</dd></div>
              <div><dt className="text-zinc-500">Asistió c/reserva</dt><dd>{member.attendedBookingsPeriod}</dd></div>
              <div><dt className="text-zinc-500">Walk-ins</dt><dd>{member.walkInsPeriod}</dd></div>
              <div><dt className="text-zinc-500">No-shows</dt><dd>{member.noShowsPeriod}</dd></div>
              <div><dt className="text-zinc-500">Tasa asistencia</dt><dd>{member.attendanceRatePct != null ? `${member.attendanceRatePct}%` : "—"}</dd></div>
            </dl>
          </section>
          {member.engagementReasons.length > 0 ? (
            <section>
              <h3 className="mb-2 font-medium text-zinc-900">Señales</h3>
              <ul className="list-disc space-y-1 pl-4 text-zinc-600">
                {member.engagementReasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </section>
          ) : null}
          <Link href={`/members/${member.userId}`} className="inline-flex text-sm font-medium text-zinc-900 underline">
            Ver perfil completo →
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function MemberAnalyticsPage() {
  const router = useRouter();
  const { selectedStudioId, studioRole, ready } = useDeskStudio();
  const [period, setPeriod] = useState<MemberAnalyticsPeriodKey>("this_month");
  const [tab, setTab] = useState<TabKey>("resumen");
  const [search, setSearch] = useState("");
  const [summary, setSummary] = useState<MemberAnalyticsSummaryDto | null>(null);
  const [activity, setActivity] = useState<MemberAnalyticsActivityDto | null>(null);
  const [members, setMembers] = useState<MemberAnalyticsRowDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [frequencyPopulation, setFrequencyPopulation] = useState<"active" | "all">("active");
  const [drawerMember, setDrawerMember] = useState<MemberAnalyticsDetailDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    if (!canAccessExecutiveDashboard(studioRole)) {
      router.replace("/check-in");
    }
  }, [ready, studioRole, router]);

  const load = useCallback(async () => {
    if (!selectedStudioId) return;
    setLoading(true);
    setError(null);
    try {
      const [summaryRes, activityRes, listRes] = await Promise.all([
        fetchMemberAnalyticsSummary(selectedStudioId, period),
        fetchMemberAnalyticsActivity(selectedStudioId, period, frequencyPopulation),
        fetchMemberAnalyticsList(selectedStudioId, {
          period,
          search: search || undefined,
          page,
          limit: 25,
          sort: "visitsPeriod",
          order: "desc",
        }),
      ]);
      setSummary(summaryRes);
      setActivity(activityRes);
      setMembers(listRes.data);
      setTotal(listRes.total);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo cargar analytics de miembros");
    } finally {
      setLoading(false);
    }
  }, [selectedStudioId, period, search, page, frequencyPopulation]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  async function openDrawer(userId: string) {
    if (!selectedStudioId) return;
    const detail = await fetchMemberAnalyticsDetail(selectedStudioId, userId, period);
    setDrawerMember(detail);
  }

  if (!selectedStudioId) {
    return <p className="p-6 text-sm text-zinc-500">Selecciona un estudio.</p>;
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <AnalyticsSubNav />
      <PageHeader
        title="Analytics · Miembros"
        subtitle="Inteligencia operacional sobre asistencia, frecuencia y retención de miembros."
      />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        {PERIODS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => { setPeriod(p.key); setPage(1); }}
            className={[
              "rounded-lg px-3 py-1.5 text-sm font-medium",
              period === p.key ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200",
            ].join(" ")}
          >
            {p.label}
          </button>
        ))}
      </div>

      {error ? <p className="mb-4 text-sm text-red-600">{error}</p> : null}

      {summary ? (
        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
          <KpiCard label="Miembros activos" value={String(summary.kpis.activeMembers)} hint="Con membresía vigente hoy" />
          <KpiCard label="Miembros que asistieron" value={String(summary.kpis.membersAttended)} hint="Únicos con asistencia en el periodo" />
          <KpiCard label="Asistencias" value={String(summary.kpis.attendances)} />
          <KpiCard label="Visitas por miembro" value={formatDecimal(summary.kpis.visitsPerAttendingMember)} hint="Asistencias ÷ miembros que asistieron" />
          <KpiCard label="Frecuencia semanal" value={formatDecimal(summary.kpis.weeklyFrequencyPerAttendingMember)} hint="Promedio por miembro que asistió" />
          <KpiCard label="Sin actividad 14+ días" value={String(summary.kpis.inactive14PlusDays)} hint="Miembros activos sin visita reciente" />
          <KpiCard label="Nuevos miembros" value={String(summary.kpis.newMembers)} />
          <KpiCard label="Tendencia" value={formatTrendPct(summary.kpis.engagementTrendPct)} hint={summary.isPartialPeriod ? "Periodo parcial" : undefined} />
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(["resumen", "actividad"] as TabKey[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={[
              "rounded-lg px-3 py-1.5 text-sm capitalize",
              tab === key ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-700",
            ].join(" ")}
          >
            {key === "resumen" ? "Resumen" : "Actividad"}
          </button>
        ))}
        <Link
          href="/analytics/retention"
          className="rounded-lg bg-zinc-100 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-200"
        >
          Retención →
        </Link>
      </div>

      {tab === "resumen" ? (
        <SurfaceCard className="p-4">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <input
              className={adminInput}
              placeholder="Buscar miembro…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            />
            <p className="text-sm text-zinc-500">{total} miembros</p>
          </div>
          <div className={adminTableWrap}>
            <table className="min-w-full text-left text-sm">
              <thead className="sticky top-0 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="px-3 py-2">Miembro</th>
                  <th className="px-3 py-2">Plan</th>
                  <th className="px-3 py-2">Visitas</th>
                  <th className="px-3 py-2">30 días</th>
                  <th className="px-3 py-2">Prom./sem.</th>
                  <th className="px-3 py-2">Última visita</th>
                  <th className="px-3 py-2">Clase favorita</th>
                  <th className="px-3 py-2">Horario favorito</th>
                  <th className="px-3 py-2">Racha</th>
                  <th className="px-3 py-2">Tendencia</th>
                  <th className="px-3 py-2">Estado</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={11} className="px-3 py-8 text-center text-zinc-500">Cargando…</td></tr>
                ) : members.length === 0 ? (
                  <tr><td colSpan={11} className="px-3 py-8 text-center text-zinc-500">Sin miembros para este periodo.</td></tr>
                ) : (
                  members.map((m) => (
                    <tr key={m.userId} className="border-t border-zinc-100 hover:bg-zinc-50">
                      <td className="px-3 py-2">
                        <button type="button" className="flex items-center gap-2 text-left" onClick={() => void openDrawer(m.userId)}>
                          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold">
                            {memberInitials(m.firstName, m.lastName)}
                          </span>
                          <span>
                            <span className="font-medium text-zinc-900">{m.firstName} {m.lastName}</span>
                            {m.email ? <span className="block text-xs text-zinc-500">{m.email}</span> : null}
                          </span>
                        </button>
                      </td>
                      <td className="px-3 py-2 text-zinc-600">{m.planName ?? "—"}</td>
                      <td className="px-3 py-2 tabular-nums">{m.visitsPeriod}</td>
                      <td className="px-3 py-2 tabular-nums">{m.visits30d}</td>
                      <td className="px-3 py-2 tabular-nums">{formatDecimal(m.visitsPerWeek)}</td>
                      <td className="px-3 py-2">{formatLastVisit(m.lastVisitAt)}</td>
                      <td className="px-3 py-2 text-zinc-600">{m.favoriteClass ?? "—"}</td>
                      <td className="px-3 py-2 text-zinc-600">{formatFavoriteScheduleTime(m.favoriteTime)}</td>
                      <td className="px-3 py-2 tabular-nums">{m.consecutiveWeekStreak > 0 ? `${m.consecutiveWeekStreak} sem` : "—"}</td>
                      <td className="px-3 py-2">{formatTrendPct(m.trendPct)}</td>
                      <td className="px-3 py-2">
                        <span className={`${adminStatusPill} ${ENGAGEMENT_STATUS_CLASS[m.engagementStatus]}`}>
                          {ENGAGEMENT_STATUS_LABELS[m.engagementStatus]}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {total > 25 ? (
            <div className="mt-4 flex items-center justify-end gap-2">
              <button type="button" className={adminSecondaryBtn} disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Anterior</button>
              <span className="text-sm text-zinc-500">Página {page}</span>
              <button type="button" className={adminSecondaryBtn} disabled={page * 25 >= total} onClick={() => setPage((p) => p + 1)}>Siguiente</button>
            </div>
          ) : null}
        </SurfaceCard>
      ) : null}

      {tab === "actividad" && activity ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <SurfaceCard className="p-4">
            <h3 className="mb-3 text-sm font-medium text-zinc-900">Más activos</h3>
            <ul className="space-y-2 text-sm">
              {activity.topActive.map((m, i) => (
                <li key={m.userId} className="flex items-center justify-between">
                  <span>{i + 1}. {m.firstName} {m.lastName}</span>
                  <span className="tabular-nums text-zinc-600">{m.visitsPeriod} visitas</span>
                </li>
              ))}
            </ul>
          </SurfaceCard>
          <SurfaceCard className="p-4">
            <h3 className="mb-3 text-sm font-medium text-zinc-900">Clases preferidas</h3>
            <ul className="space-y-2 text-sm">
              {activity.classPreferences.slice(0, 8).map((c) => (
                <li key={c.classTemplateId} className="flex items-center justify-between gap-4">
                  <span>{c.className}</span>
                  <span className="text-zinc-500">{c.attendances} · {c.attendanceSharePct}%</span>
                </li>
              ))}
            </ul>
          </SurfaceCard>
          <SurfaceCard className="p-4 lg:col-span-2">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium text-zinc-900">Distribución de frecuencia</h3>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => setFrequencyPopulation("active")}
                  className={frequencyPopulation === "active" ? "rounded-lg bg-zinc-900 px-2 py-1 text-xs text-white" : "rounded-lg bg-zinc-100 px-2 py-1 text-xs text-zinc-600"}
                >
                  Miembros activos
                </button>
                <button
                  type="button"
                  onClick={() => setFrequencyPopulation("all")}
                  className={frequencyPopulation === "all" ? "rounded-lg bg-zinc-900 px-2 py-1 text-xs text-white" : "rounded-lg bg-zinc-100 px-2 py-1 text-xs text-zinc-600"}
                >
                  Todos los miembros
                </button>
              </div>
            </div>
            <p className="mb-3 text-xs text-zinc-500">
              {frequencyPopulation === "active"
                ? "Visitas en el periodo por miembro con membresía vigente."
                : "Visitas en el periodo por cualquier fila MEMBER histórica."}
            </p>
            <div className="flex items-end gap-2 h-32">
              {activity.frequencyDistribution.map((b) => (
                <div key={b.bucket} className="flex flex-1 flex-col items-center gap-1">
                  <div className="w-full rounded bg-zinc-900" style={{ height: `${Math.max(4, b.memberCount * 4)}px` }} />
                  <span className="text-xs text-zinc-500">{b.bucket}</span>
                  <span className="text-xs font-medium tabular-nums">{b.memberCount}</span>
                </div>
              ))}
            </div>
          </SurfaceCard>
        </div>
      ) : null}

      {drawerMember ? (
        <MemberAnalyticsDrawer member={drawerMember} onClose={() => setDrawerMember(null)} />
      ) : null}
    </div>
  );
}
