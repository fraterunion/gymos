"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { AnalyticsSubNav } from "@/components/analytics/AnalyticsSubNav";
import { PageHeader } from "@/components/shell/PageHeader";
import { SurfaceCard } from "@/components/shell/SurfaceCard";
import { useDeskStudio } from "@/contexts/DeskStudioContext";
import { adminInput, adminSecondaryBtn, adminStatusPill, adminTableWrap } from "@/lib/adminSurface";
import { ApiError } from "@/lib/api/errors";
import {
  fetchRetentionActivity,
  fetchRetentionMemberDetail,
  fetchRetentionMembers,
  fetchRetentionSummary,
  type RetentionActivityDto,
  type RetentionMemberDetailDto,
  type RetentionMemberRowDto,
  type RetentionSummaryDto,
} from "@/lib/api/retention-analytics";
import { canAccessExecutiveDashboard } from "@/lib/executivePermissions";
import { formatDecimal, formatFavoriteScheduleTime, formatFavoriteWeekday, formatLastVisit, memberInitials } from "@/lib/memberAnalyticsPresentation";
import {
  CLASS_STICKINESS_SECTION_HELP,
  CLASS_STICKINESS_SECTION_TITLE,
  COHORT_SECTION_HELP,
  COHORT_SECTION_TITLE,
  FREQUENCY_KPI_HELP,
  FREQUENCY_KPI_LABEL,
  formatCohortCell,
  formatDeltaPct,
  formatJoinedAt,
  RETENTION_ACTION_LABELS,
  RETENTION_HEALTH_CLASS,
  RETENTION_HEALTH_LABELS,
  RETENTION_MOVEMENT_LABELS,
} from "@/lib/retentionAnalyticsPresentation";

function KpiCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <SurfaceCard className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-zinc-900">{value}</p>
      {hint ? <p className="mt-1 text-xs text-zinc-500">{hint}</p> : null}
    </SurfaceCard>
  );
}

function HealthPill({ health }: { health: RetentionMemberRowDto["health"] }) {
  return (
    <span className={`${adminStatusPill} inline-flex ${RETENTION_HEALTH_CLASS[health]}`}>
      {RETENTION_HEALTH_LABELS[health]}
    </span>
  );
}

function RetentionDrawer({
  member,
  onClose,
}: {
  member: RetentionMemberDetailDto;
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
            <div className="mt-2 flex flex-wrap gap-2">
              <HealthPill health={member.health} />
              <span className={`${adminStatusPill} bg-zinc-100 text-zinc-700`}>
                {RETENTION_MOVEMENT_LABELS[member.movement]}
              </span>
            </div>
          </div>
          <button type="button" className={adminSecondaryBtn} onClick={onClose}>
            Cerrar
          </button>
        </div>
        <div className="space-y-6 p-5 text-sm">
          <section>
            <h3 className="mb-2 font-medium text-zinc-900">Estado actual</h3>
            <dl className="grid grid-cols-2 gap-3">
              <div><dt className="text-zinc-500">Entitlement</dt><dd>{member.isEntitled ? "Vigente" : "Finalizada"}</dd></div>
              <div><dt className="text-zinc-500">Plan</dt><dd>{member.planName ?? "—"}</dd></div>
              <div><dt className="text-zinc-500">Última visita</dt><dd>{formatLastVisit(member.lastVisitAt)}</dd></div>
              <div><dt className="text-zinc-500">Días sin visitar</dt><dd>{member.daysSinceLastVisit ?? "—"}</dd></div>
            </dl>
          </section>
          <section>
            <h3 className="mb-2 font-medium text-zinc-900">Actividad</h3>
            <dl className="grid grid-cols-2 gap-3">
              <div><dt className="text-zinc-500">30 días</dt><dd className="font-medium">{member.visits30d}</dd></div>
              <div><dt className="text-zinc-500">30 previos</dt><dd className="font-medium">{member.visitsPrior30d}</dd></div>
              <div><dt className="text-zinc-500">90 días</dt><dd className="font-medium">{member.visits90d}</dd></div>
              <div><dt className="text-zinc-500">Prom / semana</dt><dd className="font-medium">{formatDecimal(member.visitsPerWeek)}</dd></div>
              <div><dt className="text-zinc-500">Racha</dt><dd className="font-medium">{member.streak}</dd></div>
            </dl>
          </section>
          <section>
            <h3 className="mb-2 font-medium text-zinc-900">Cambio</h3>
            <p className="text-zinc-700">{member.reason}</p>
            <p className="mt-1 text-zinc-500">Δ {formatDeltaPct(member.deltaPct)}</p>
          </section>
          <section>
            <h3 className="mb-2 font-medium text-zinc-900">Preferencias</h3>
            <dl className="grid grid-cols-2 gap-3">
              <div><dt className="text-zinc-500">Clase</dt><dd>{member.favoriteClass ?? "—"}</dd></div>
              <div><dt className="text-zinc-500">Horario</dt><dd>{formatFavoriteScheduleTime(member.favoriteTime)}</dd></div>
              <div><dt className="text-zinc-500">Día</dt><dd>{formatFavoriteWeekday(member.favoriteWeekday)}</dd></div>
              <div><dt className="text-zinc-500">Instructor</dt><dd>{member.favoriteInstructor ?? "—"}</dd></div>
            </dl>
          </section>
          <section>
            <h3 className="mb-2 font-medium text-zinc-900">Patrón</h3>
            <p className="text-zinc-700">{member.patternSentence}</p>
          </section>
          {member.monthlyTrend.length > 0 ? (
            <section>
              <h3 className="mb-2 font-medium text-zinc-900">Tendencia</h3>
              <ul className="space-y-1 text-zinc-600">
                {member.monthlyTrend.map((m) => (
                  <li key={m.month} className="flex justify-between">
                    <span>{m.month}{m.isPartial ? " (en curso)" : ""}</span>
                    <span className="tabular-nums">{m.attendances}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section>
            <h3 className="mb-2 font-medium text-zinc-900">Acción sugerida</h3>
            <p className="font-medium text-zinc-900">{RETENTION_ACTION_LABELS[member.suggestedAction]}</p>
          </section>
          <Link href={`/members/${member.userId}`} className="inline-flex text-sm font-medium text-zinc-900 underline">
            Ver perfil completo →
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function RetentionAnalyticsPage() {
  const router = useRouter();
  const { selectedStudioId, studioRole, ready } = useDeskStudio();
  const [summary, setSummary] = useState<RetentionSummaryDto | null>(null);
  const [activity, setActivity] = useState<RetentionActivityDto | null>(null);
  const [members, setMembers] = useState<RetentionMemberRowDto[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [health, setHealth] = useState("");
  const [movement, setMovement] = useState("");
  const [entitlement, setEntitlement] = useState<"all" | "entitled" | "lapsed">("entitled");
  const [sort, setSort] = useState("risk");
  const [drawer, setDrawer] = useState<RetentionMemberDetailDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    if (!canAccessExecutiveDashboard(studioRole)) {
      router.replace("/check-in");
    }
  }, [ready, studioRole, router]);

  const load = useCallback(async () => {
    if (!selectedStudioId || !canAccessExecutiveDashboard(studioRole)) return;
    setLoading(true);
    setError(null);
    try {
      const [s, a, m] = await Promise.all([
        fetchRetentionSummary(selectedStudioId),
        fetchRetentionActivity(selectedStudioId),
        fetchRetentionMembers(selectedStudioId, {
          search,
          health: health || undefined,
          movement: movement || undefined,
          entitlement,
          sort,
          order: "desc",
          page: 1,
          limit: 100,
        }),
      ]);
      setSummary(s);
      setActivity(a);
      setMembers(m.data);
      setTotal(m.total);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo cargar retención");
    } finally {
      setLoading(false);
    }
  }, [selectedStudioId, studioRole, search, health, movement, entitlement, sort]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDrawer = async (userId: string) => {
    if (!selectedStudioId) return;
    try {
      const detail = await fetchRetentionMemberDetail(selectedStudioId, userId);
      setDrawer(detail);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo abrir el miembro");
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <AnalyticsSubNav />
      <PageHeader
        title="Retención"
        subtitle="Quién necesita atención, quién regresó y patrones de regreso por clase — por asistencia."
      />
      {error ? <p className="mb-4 text-sm text-red-600">{error}</p> : null}
      {loading && !summary ? <p className="text-sm text-zinc-500">Cargando…</p> : null}

      {summary ? (
        <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <KpiCard label="Miembros activos" value={String(summary.kpis.activeMembers)} hint="Con membresía vigente" />
          <KpiCard label="En riesgo" value={String(summary.kpis.atRisk)} hint="Recencia o caída de frecuencia" />
          <KpiCard label="Sin actividad" value={String(summary.kpis.inactive)} hint="Vigentes sin asistencia reciente" />
          <KpiCard label="Recuperados" value={String(summary.kpis.recovered)} hint="Últimos 30 días" />
          <KpiCard
            label={FREQUENCY_KPI_LABEL}
            value={summary.kpis.frequencyVisitsPerAttending != null ? String(summary.kpis.frequencyVisitsPerAttending) : "—"}
            hint={`${FREQUENCY_KPI_HELP} (${summary.kpis.frequencyVisitsNumerator}/${summary.kpis.frequencyAttendingDenominator})${
              summary.kpis.frequencyVisitsPerEntitled != null
                ? ` · vs todos vigentes: ${summary.kpis.frequencyVisitsPerEntitled}`
                : ""
            }`}
          />
        </div>
      ) : null}

      {activity?.limitedHistoryMessage ? (
        <p className="mb-6 text-sm text-zinc-500">{activity.limitedHistoryMessage}</p>
      ) : null}

      <section className="mb-10">
        <h2 className="mb-3 text-base font-semibold text-zinc-900">Miembros que requieren acción</h2>
        <div className={adminTableWrap}>
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-zinc-200 text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-3 py-2">Miembro</th>
                <th className="px-3 py-2">Plan</th>
                <th className="px-3 py-2">Estado</th>
                <th className="px-3 py-2">Movimiento</th>
                <th className="px-3 py-2">Última visita</th>
                <th className="px-3 py-2">30d</th>
                <th className="px-3 py-2">Prev</th>
                <th className="px-3 py-2">Δ</th>
                <th className="px-3 py-2">Motivo</th>
                <th className="px-3 py-2">Acción</th>
              </tr>
            </thead>
            <tbody>
              {(activity?.requiresAction ?? []).map((m) => (
                <tr
                  key={m.userId}
                  className={`cursor-pointer border-b border-zinc-100 hover:bg-zinc-50 ${
                    m.isRecovered ? "bg-emerald-50/40" : ""
                  }`}
                  onClick={() => void openDrawer(m.userId)}
                >
                  <td className="px-3 py-2">
                    <span className="mr-2 inline-flex h-7 w-7 items-center justify-center rounded-full bg-zinc-100 text-xs font-medium">
                      {memberInitials(m.firstName, m.lastName)}
                    </span>
                    {m.firstName} {m.lastName}
                    {m.isRecovered ? (
                      <span className="ml-2 text-xs font-medium uppercase tracking-wide text-emerald-700">
                        Recuperado
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-zinc-600">{m.planName ?? "—"}</td>
                  <td className="px-3 py-2">
                    {m.isRecovered ? (
                      <span className={`${adminStatusPill} bg-emerald-50 text-emerald-800`}>Recuperado</span>
                    ) : (
                      <HealthPill health={m.health} />
                    )}
                  </td>
                  <td className="px-3 py-2">{RETENTION_MOVEMENT_LABELS[m.movement]}</td>
                  <td className="px-3 py-2">{formatLastVisit(m.lastVisitAt)}</td>
                  <td className="px-3 py-2 tabular-nums">{m.visits30d}</td>
                  <td className="px-3 py-2 tabular-nums">{m.visitsPrior30d}</td>
                  <td className="px-3 py-2 tabular-nums">{formatDeltaPct(m.deltaPct)}</td>
                  <td className="max-w-[14rem] truncate px-3 py-2 text-zinc-600">{m.reason}</td>
                  <td className={`px-3 py-2 font-medium ${m.isRecovered ? "text-emerald-800" : ""}`}>
                    {RETENTION_ACTION_LABELS[m.suggestedAction]}
                  </td>
                </tr>
              ))}
              {(activity?.requiresAction.length ?? 0) === 0 ? (
                <tr><td colSpan={10} className="px-3 py-6 text-center text-zinc-500">Nadie requiere acción ahora</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mb-10">
        <h2 className="mb-3 text-base font-semibold text-zinc-900">Movimiento de miembros</h2>
        <p className="mb-3 text-xs text-zinc-500">Comparación últimos 30 días vs. 30 días previos · solo miembros vigentes</p>
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {(activity?.movement ?? []).map((b) => (
            <SurfaceCard key={b.movement} className="p-4">
              <p className="text-xs text-zinc-500">{RETENTION_MOVEMENT_LABELS[b.movement]}</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{b.count}</p>
            </SurfaceCard>
          ))}
        </div>
      </section>

      <section className="mb-10">
        <h2 className="mb-1 text-base font-semibold text-zinc-900">{COHORT_SECTION_TITLE}</h2>
        <p className="mb-3 text-xs text-zinc-500">
          {COHORT_SECTION_HELP} Cada celda es independiente (participación por mes); M1 puede superar M0.
        </p>
        <div className={adminTableWrap}>
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-zinc-200 text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-3 py-2">Cohorte</th>
                <th className="px-3 py-2">Tam.</th>
                <th className="px-3 py-2">M0</th>
                <th className="px-3 py-2">M1</th>
                <th className="px-3 py-2">M2</th>
                <th className="px-3 py-2">M3</th>
              </tr>
            </thead>
            <tbody>
              {(activity?.cohorts ?? []).map((c) => (
                <tr key={c.cohortMonth} className="border-b border-zinc-100">
                  <td className="px-3 py-2">
                    {c.cohortMonth}
                    {c.suppressed ? (
                      <span className="ml-2 text-xs text-amber-700">{c.suppressReason}</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 tabular-nums">{c.cohortSize}</td>
                  {c.cells.map((cell) => (
                    <td
                      key={cell.monthOffset}
                      className="px-3 py-2 tabular-nums text-zinc-700"
                      title={cell.limitedHistoryReason ?? cell.suppressReason ?? undefined}
                    >
                      {formatCohortCell(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-zinc-500">* Cobertura parcial del historial confiable de asistencia</p>
      </section>

      <section className="mb-10">
        <h2 className="mb-1 text-base font-semibold text-zinc-900">{CLASS_STICKINESS_SECTION_TITLE}</h2>
        <p className="mb-3 text-xs text-zinc-500">{CLASS_STICKINESS_SECTION_HELP}</p>
        <div className={adminTableWrap}>
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-zinc-200 text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-3 py-2">Clase</th>
                <th className="px-3 py-2">n</th>
                <th className="px-3 py-2">Asistencias</th>
                <th className="px-3 py-2">Prom</th>
                <th className="px-3 py-2">Regreso en 14 días</th>
                <th className="px-3 py-2">Regreso en 30 días</th>
              </tr>
            </thead>
            <tbody>
              {(activity?.classStickiness ?? []).map((c) => (
                <tr key={c.classTemplateId} className="border-b border-zinc-100">
                  <td className="px-3 py-2">
                    {c.className}
                    {c.seedMembers === 5 ? (
                      <span className="ml-2 text-xs text-zinc-500">n=5</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 tabular-nums">n={c.seedMembers}</td>
                  <td className="px-3 py-2 tabular-nums">{c.attendances}</td>
                  <td className="px-3 py-2 tabular-nums">{c.avgVisitsPerMember}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {c.sampleInsufficient
                      ? "Muestra insuficiente"
                      : c.return14dRatePct != null
                        ? `${c.return14dRatePct}%`
                        : "—"}
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {c.sampleInsufficient
                      ? "—"
                      : c.return30dRatePct != null
                        ? `${c.return30dRatePct}%`
                        : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {(activity?.frequencyTrend.length ?? 0) > 0 ? (
        <section className="mb-10">
          <h2 className="mb-3 text-base font-semibold text-zinc-900">Frecuencia mensual</h2>
          <p className="mb-3 text-xs text-zinc-500">
            El mes en curso es parcial; no se compara contra meses cerrados sin normalizar.
          </p>
          <div className={adminTableWrap}>
            <table className="min-w-full text-left text-sm">
              <thead className="border-b border-zinc-200 text-xs uppercase text-zinc-500">
                <tr>
                  <th className="px-3 py-2">Mes</th>
                  <th className="px-3 py-2">Asistencias</th>
                  <th className="px-3 py-2">Miembros</th>
                  <th className="px-3 py-2">Visitas / asistente</th>
                </tr>
              </thead>
              <tbody>
                {activity!.frequencyTrend.map((m) => (
                  <tr key={m.month} className="border-b border-zinc-100">
                    <td className="px-3 py-2">
                      {m.month}
                      {m.isCurrentMonth ? <span className="ml-2 text-xs text-zinc-500">Mes en curso</span> : null}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{m.attendances}</td>
                    <td className="px-3 py-2 tabular-nums">{m.uniqueAttending}</td>
                    <td className="px-3 py-2 tabular-nums">{m.visitsPerAttending ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section>
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <h2 className="text-base font-semibold text-zinc-900">Ciclo de vida</h2>
          <input
            className={adminInput}
            placeholder="Buscar"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select className={adminInput} value={health} onChange={(e) => setHealth(e.target.value)}>
            <option value="">Estado</option>
            {Object.entries(RETENTION_HEALTH_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
          <select className={adminInput} value={movement} onChange={(e) => setMovement(e.target.value)}>
            <option value="">Movimiento</option>
            {Object.entries(RETENTION_MOVEMENT_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
          <select
            className={adminInput}
            value={entitlement}
            onChange={(e) => setEntitlement(e.target.value as "all" | "entitled" | "lapsed")}
          >
            <option value="entitled">Vigentes</option>
            <option value="lapsed">Membresía finalizada</option>
            <option value="all">Todos</option>
          </select>
          <select className={adminInput} value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="risk">Mayor riesgo</option>
            <option value="decline">Mayor caída</option>
            <option value="absence">Más días sin asistir</option>
            <option value="active">Más activos</option>
            <option value="recovered">Recuperados recientes</option>
          </select>
        </div>
        <p className="mb-2 text-xs text-zinc-500">{total} miembros</p>
        <div className={adminTableWrap}>
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-zinc-200 text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-3 py-2">Miembro</th>
                <th className="px-3 py-2">Plan</th>
                <th className="px-3 py-2">Estado</th>
                <th className="px-3 py-2">Movimiento</th>
                <th className="px-3 py-2">Última visita</th>
                <th className="px-3 py-2">30d</th>
                <th className="px-3 py-2">Prev</th>
                <th className="px-3 py-2">Δ</th>
                <th className="px-3 py-2">Racha</th>
                <th className="px-3 py-2">Desde</th>
                <th className="px-3 py-2">Acción</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr
                  key={m.userId}
                  className="cursor-pointer border-b border-zinc-100 hover:bg-zinc-50"
                  onClick={() => void openDrawer(m.userId)}
                >
                  <td className="px-3 py-2">{m.firstName} {m.lastName}</td>
                  <td className="px-3 py-2">{m.planName ?? "—"}</td>
                  <td className="px-3 py-2"><HealthPill health={m.health} /></td>
                  <td className="px-3 py-2">{RETENTION_MOVEMENT_LABELS[m.movement]}</td>
                  <td className="px-3 py-2">{formatLastVisit(m.lastVisitAt)}</td>
                  <td className="px-3 py-2 tabular-nums">{m.visits30d}</td>
                  <td className="px-3 py-2 tabular-nums">{m.visitsPrior30d}</td>
                  <td className="px-3 py-2 tabular-nums">{formatDeltaPct(m.deltaPct)}</td>
                  <td className="px-3 py-2 tabular-nums">{m.streak}</td>
                  <td className="px-3 py-2">{formatJoinedAt(m.joinedAt)}</td>
                  <td className="px-3 py-2">{RETENTION_ACTION_LABELS[m.suggestedAction]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {drawer ? <RetentionDrawer member={drawer} onClose={() => setDrawer(null)} /> : null}
    </div>
  );
}
