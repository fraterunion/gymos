"use client";

import { useCallback, useEffect, useState } from "react";
import { useDeskStudio } from "@/contexts/DeskStudioContext";
import { ApiError } from "@/lib/api/errors";
import {
  fetchEnrollmentSettings,
  fetchEnrollments,
  upsertEnrollmentSettings,
  waiveEnrollment,
  type EnrollmentListItem,
  type EnrollmentSettingsDto,
  type EnrollmentSettingsInput,
} from "@/lib/api/enrollment";

const INPUT =
  "w-full rounded-xl border border-zinc-700/90 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-violet-500/70 focus:outline-none focus:ring-1 focus:ring-violet-500/40";

function SectionCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-zinc-800/90 bg-zinc-900/40 p-6 shadow-sm backdrop-blur-sm">
      <div className="mb-6">
        <h2 className="text-lg font-semibold tracking-tight text-zinc-50">{title}</h2>
        {subtitle ? <p className="mt-1 text-sm text-zinc-500">{subtitle}</p> : null}
      </div>
      {children}
    </section>
  );
}

function StatusBadge({ status, waivedReason }: { status: string; waivedReason: string | null }) {
  if (status === "WAIVED") {
    const isOverflow = waivedReason === "FIRST_N_PROMO_OVERFLOW";
    const isAdmin    = waivedReason === "ADMIN_WAIVER";
    return (
      <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
        isOverflow
          ? "bg-amber-950/40 text-amber-300"
          : isAdmin
          ? "bg-blue-950/40 text-blue-300"
          : "bg-emerald-950/40 text-emerald-300"
      }`}>
        {isOverflow ? "Inscripción bonificada (overflow)" : isAdmin ? "Inscripción bonificada (admin)" : "Inscripción bonificada"}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs font-medium text-zinc-300">
      Inscripción pagada
    </span>
  );
}

function formatMXN(cents: number): string {
  return new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(cents / 100);
}

export default function EnrollmentPage() {
  const { selectedStudioId, selected, loading: studiosLoading } = useDeskStudio();
  const canManage = selected?.role === "OWNER" || selected?.role === "ADMIN";

  const [settings, setSettings] = useState<EnrollmentSettingsDto | null>(null);
  const [enrollments, setEnrollments] = useState<EnrollmentListItem[]>([]);
  const [enrollmentTotal, setEnrollmentTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waivedBusy, setWaivedBusy] = useState<string | null>(null);

  // Form state
  const [feeCents, setFeeCents] = useState(49900);
  const [active, setActive] = useState(true);
  const [campaignEnabled, setCampaignEnabled] = useState(false);
  const [campaignName, setCampaignName] = useState("");
  const [campaignLimit, setCampaignLimit] = useState(50);
  const [campaignDiscountPct, setCampaignDiscountPct] = useState(100);

  const applySettings = useCallback((s: EnrollmentSettingsDto | null) => {
    setSettings(s);
    if (s) {
      setFeeCents(s.enrollmentFeeCents);
      setActive(s.active);
      setCampaignEnabled(s.campaignEnabled);
      setCampaignName(s.campaignName ?? "");
      setCampaignLimit(s.campaignLimit ?? 50);
      setCampaignDiscountPct(s.campaignDiscountPct ?? 100);
    }
  }, []);

  const reload = useCallback(async () => {
    if (!selectedStudioId || !canManage) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const [s, e] = await Promise.all([
        fetchEnrollmentSettings(selectedStudioId),
        fetchEnrollments(selectedStudioId, { limit: 100 }),
      ]);
      applySettings(s);
      setEnrollments(e.data);
      setEnrollmentTotal(e.total);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo cargar la configuración.");
    } finally {
      setLoading(false);
    }
  }, [selectedStudioId, canManage, applySettings]);

  useEffect(() => { void reload(); }, [reload]);

  async function handleSave() {
    if (!selectedStudioId) return;
    setSaving(true);
    setError(null);
    try {
      const input: EnrollmentSettingsInput = {
        enrollmentFeeCents: feeCents,
        currency: "mxn",
        active,
        campaignEnabled,
        campaignType: campaignEnabled ? "FIRST_N_MEMBERS" : undefined,
        campaignName: campaignEnabled ? campaignName.trim() || undefined : undefined,
        campaignLimit: campaignEnabled ? campaignLimit : undefined,
        campaignDiscountPct: campaignEnabled ? campaignDiscountPct : undefined,
        campaignAppliesTo: campaignEnabled ? "ENROLLMENT_FEE" : undefined,
      };
      const updated = await upsertEnrollmentSettings(selectedStudioId, input);
      applySettings(updated);
      setFlash("Guardado");
      window.setTimeout(() => setFlash(null), 2200);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo guardar.");
    } finally {
      setSaving(false);
    }
  }

  async function handleAdminWaive(enrollmentId: string) {
    if (!selectedStudioId) return;
    setWaivedBusy(enrollmentId);
    try {
      const updated = await waiveEnrollment(selectedStudioId, enrollmentId);
      setEnrollments((prev) => prev.map((e) => (e.id === enrollmentId ? { ...e, ...updated } : e)));
      setFlash("Inscripción bonificada");
      window.setTimeout(() => setFlash(null), 2200);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo bonificar la inscripción.");
    } finally {
      setWaivedBusy(null);
    }
  }

  if (studiosLoading) {
    return <div className="flex min-h-[40vh] items-center justify-center"><p className="text-sm text-zinc-500">Cargando…</p></div>;
  }

  if (!canManage) {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-zinc-800 bg-zinc-900/50 p-8 text-center">
        <h1 className="text-lg font-semibold text-zinc-100">Campaña de inscripción</h1>
        <p className="mt-2 text-sm text-zinc-500">Solo propietarios y administradores pueden gestionar la campaña de inscripción.</p>
      </div>
    );
  }

  if (!selectedStudioId) {
    return <p className="text-sm text-zinc-500">Selecciona un estudio para gestionar la campaña de inscripción.</p>;
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-64 animate-pulse rounded-lg bg-zinc-800" />
        <div className="h-64 animate-pulse rounded-2xl bg-zinc-900/50" />
      </div>
    );
  }

  const founders = enrollments.filter((e) => e.waivedReason === "FIRST_N_PROMO");
  const waivedCount = settings?.waivedCount ?? 0;
  const paidCount   = settings?.paidCount ?? 0;
  const campaignLimitValue = settings?.campaignLimit ?? campaignLimit;

  return (
    <div className="space-y-10 pb-16">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">Campaña de inscripción</h1>
          <p className="mt-1 max-w-2xl text-sm text-zinc-500">
            Configura el cobro de inscripción y la campaña de miembros fundadores.
          </p>
        </div>
        {flash ? (
          <span className="text-xs font-medium text-emerald-400" role="status">{flash}</span>
        ) : settings ? (
          <span className="text-xs text-zinc-600">Actualizado {new Date(settings.updatedAt).toLocaleString()}</span>
        ) : null}
      </header>

      {error ? (
        <div className="rounded-xl border border-red-900/40 bg-red-950/15 px-4 py-3 text-sm text-red-200">{error}</div>
      ) : null}

      {/* Campaign stats */}
      {settings && (
        <div className="grid gap-4 sm:grid-cols-3">
          {[
            { label: "Miembros fundadores", value: `${waivedCount} / ${settings.campaignEnabled ? campaignLimitValue : "—"}`, sub: "FIRST_N_PROMO confirmados" },
            { label: "Inscripciones pagadas", value: paidCount, sub: "Cobro de inscripción recibido" },
            { label: "Costo de inscripción", value: formatMXN(settings.enrollmentFeeCents), sub: settings.active ? "Activo" : "Inactivo" },
          ].map((stat) => (
            <div key={stat.label} className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{stat.label}</p>
              <p className="mt-2 text-2xl font-bold text-zinc-50">{stat.value}</p>
              <p className="mt-1 text-xs text-zinc-600">{stat.sub}</p>
            </div>
          ))}
        </div>
      )}

      {/* Settings form */}
      <SectionCard title="Configuración" subtitle="Define el monto de inscripción y los parámetros de la campaña.">
        <div className="grid gap-6 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">Costo de inscripción (centavos MXN)</span>
            <input
              className={INPUT}
              type="number"
              min={0}
              value={feeCents}
              onChange={(e) => setFeeCents(Number(e.target.value))}
            />
            <span className="mt-1 block text-xs text-zinc-600">{formatMXN(feeCents)}</span>
          </label>

          <div className="flex flex-col gap-4">
            <label className="flex cursor-pointer items-center justify-between gap-4 rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3">
              <span>
                <span className="block text-sm font-medium text-zinc-100">Inscripción activa</span>
                <span className="block text-xs text-zinc-500">Cobrar inscripción a nuevos miembros</span>
              </span>
              <input type="checkbox" className="h-4 w-4 rounded border-zinc-600 bg-zinc-950 text-violet-600" checked={active} onChange={(e) => setActive(e.target.checked)} />
            </label>
            <label className="flex cursor-pointer items-center justify-between gap-4 rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3">
              <span>
                <span className="block text-sm font-medium text-zinc-100">Campaña activa</span>
                <span className="block text-xs text-zinc-500">Habilitar programa de miembros fundadores</span>
              </span>
              <input type="checkbox" className="h-4 w-4 rounded border-zinc-600 bg-zinc-950 text-violet-600" checked={campaignEnabled} onChange={(e) => setCampaignEnabled(e.target.checked)} />
            </label>
          </div>

          {campaignEnabled && (
            <>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-zinc-400">Nombre de la campaña</span>
                <input className={INPUT} value={campaignName} placeholder="Fundadores ARES" onChange={(e) => setCampaignName(e.target.value)} />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-zinc-400">Lugares disponibles</span>
                <input className={INPUT} type="number" min={1} value={campaignLimit} onChange={(e) => setCampaignLimit(Number(e.target.value))} />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-zinc-400">Descuento (%)</span>
                <input className={INPUT} type="number" min={0} max={100} value={campaignDiscountPct} onChange={(e) => setCampaignDiscountPct(Number(e.target.value))} />
              </label>
            </>
          )}
        </div>

        <div className="mt-6 flex justify-end">
          <button
            type="button"
            disabled={saving}
            onClick={() => void handleSave()}
            className="rounded-xl bg-zinc-100 px-4 py-2.5 text-sm font-semibold text-zinc-900 hover:bg-white disabled:cursor-wait disabled:opacity-60 dark:bg-violet-600 dark:text-white dark:hover:bg-violet-500"
          >
            {saving ? "Guardando…" : "Guardar cambios"}
          </button>
        </div>
      </SectionCard>

      {/* Founders */}
      {founders.length > 0 && (
        <SectionCard
          title="Miembros fundadores"
          subtitle={`${founders.length} de ${campaignLimitValue} lugares de Fundadores confirmados.`}
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left">
                  {["#", "Fundador #", "Miembro", "Fecha"].map((h) => (
                    <th key={h} className="pb-3 pr-4 text-xs font-medium uppercase tracking-wide text-zinc-500">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {founders.map((e) => (
                  <tr key={e.id} className="border-b border-zinc-800/50 last:border-0">
                    <td className="py-3 pr-4 font-mono text-xs text-zinc-400">#{e.memberNumber ?? "—"}</td>
                    <td className="py-3 pr-4 font-mono text-xs text-amber-400">#{e.founderNumber ?? "—"}</td>
                    <td className="py-3 pr-4">
                      <span className="block text-zinc-100">{e.user.firstName} {e.user.lastName}</span>
                      <span className="block text-xs text-zinc-500">{e.user.email}</span>
                    </td>
                    <td className="py-3 pr-4 text-xs text-zinc-500">
                      {e.finalizedAt ? new Date(e.finalizedAt).toLocaleDateString("es-MX") : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      {/* All enrollments */}
      {enrollments.length > 0 && (
        <SectionCard title={`Historial de inscripciones (${enrollmentTotal})`} subtitle="Todos los miembros con inscripción procesada.">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left">
                  {["Miembro #", "Miembro", "Estado", "Razón", "Acciones"].map((h) => (
                    <th key={h} className="pb-3 pr-4 text-xs font-medium uppercase tracking-wide text-zinc-500">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {enrollments.map((e) => (
                  <tr key={e.id} className="border-b border-zinc-800/50 last:border-0">
                    <td className="py-3 pr-4 font-mono text-xs text-zinc-400">#{e.memberNumber ?? "—"}</td>
                    <td className="py-3 pr-4">
                      <span className="block text-zinc-100">{e.user.firstName} {e.user.lastName}</span>
                      <span className="block text-xs text-zinc-500">{e.user.email}</span>
                    </td>
                    <td className="py-3 pr-4"><StatusBadge status={e.status} waivedReason={e.waivedReason} /></td>
                    <td className="py-3 pr-4 text-xs text-zinc-500">{e.waivedReason ?? "—"}</td>
                    <td className="py-3 pr-4">
                      {e.status === "PAID" ? (
                        <button
                          type="button"
                          disabled={waivedBusy === e.id}
                          onClick={() => void handleAdminWaive(e.id)}
                          className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs font-medium text-zinc-300 hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-50"
                        >
                          {waivedBusy === e.id ? "…" : "Bonificar inscripción"}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      {!loading && enrollments.length === 0 && (
        <div className="rounded-2xl border border-zinc-800/60 bg-zinc-900/30 p-10 text-center">
          <p className="text-sm text-zinc-500">Aún no hay inscripciones procesadas.</p>
        </div>
      )}
    </div>
  );
}
