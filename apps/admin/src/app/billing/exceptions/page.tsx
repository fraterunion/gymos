"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { AdminPageShell } from "@/components/shell/AdminPageShell";
import { PageHeader } from "@/components/shell/PageHeader";
import { SurfaceCard } from "@/components/shell/SurfaceCard";
import { useDeskStudio } from "@/contexts/DeskStudioContext";
import { adminPrimaryBtn, adminSecondaryBtn, adminTableWrap } from "@/lib/adminSurface";
import {
  applyBillingCaseAction,
  fetchBillingCases,
  fetchLatestBillingReconciliationRun,
  runBillingReconciliation,
  type BillingCase,
  type BillingCaseAction,
  type BillingCaseListResponse,
  type BillingReconciliationRun,
} from "@/lib/api/billingReconciliation";
import { ApiError } from "@/lib/api/errors";
import {
  FILTER_PRESETS,
  activeSeverityCounts,
  availableActions,
  evidenceRows,
  headerSummary,
  runSummaryLine,
  severityTone,
  statusTone,
  toneClasses,
  when,
  type CaseFilterPreset,
} from "@/lib/billingCases";
import { canManageStudioSettings, normalizeStudioRole } from "@/lib/deskRoles";

/** Mirrors the API: OWNER/ADMIN/STAFF read cases; FRONT_DESK and members get a plain notice. */
function canViewBillingCases(role: string | null): boolean {
  const normalized = normalizeStudioRole(role);
  return normalized === "OWNER" || normalized === "ADMIN" || normalized === "STAFF";
}

function Pill({ label, tone }: { label: string; tone: ReturnType<typeof severityTone> }) {
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${toneClasses(tone)}`}>{label}</span>;
}

function CaseDetail({
  studioId,
  item,
  canAct,
  onChanged,
  onClose,
}: {
  studioId: string;
  item: BillingCase;
  canAct: boolean;
  onChanged: (next: BillingCase) => void;
  onClose: () => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<BillingCaseAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const actions = availableActions(item.status);

  async function act(action: BillingCaseAction, requiresNote: boolean) {
    if (requiresNote && note.trim().length < 3) {
      setError("Escribe una nota breve (qué se hizo o por qué se descarta).");
      return;
    }
    setBusy(action);
    setError(null);
    try {
      onChanged(await applyBillingCaseAction(studioId, item.id, action, note.trim() || undefined));
      setNote("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo actualizar el caso.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <SurfaceCard>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Pill label={item.severityLabel} tone={severityTone(item.severity)} />
            <Pill label={item.statusLabel} tone={statusTone(item.status)} />
            <span className="text-xs text-zinc-500">{item.categoryLabel}</span>
          </div>
          <h2 className="text-lg font-semibold text-zinc-900">{item.title}</h2>
          <p className="text-sm text-zinc-700">{item.summary}</p>
          <p className="text-sm text-zinc-900"><span className="font-semibold">Acción recomendada:</span> {item.suggestedAction}</p>
          <p className="text-xs text-zinc-500">{item.statusSentence}</p>
        </div>
        <button type="button" onClick={onClose} className={adminSecondaryBtn}>Cerrar</button>
      </div>

      <dl className="mt-4 grid gap-x-6 gap-y-2 border-t border-zinc-100 pt-4 text-sm sm:grid-cols-2">
        {item.member ? (
          <div className="flex justify-between gap-3"><dt className="text-zinc-500">Miembro</dt><dd className="text-right"><Link href={`/members/${item.member.id}`} className="font-medium text-zinc-900 underline">{item.member.reference}</Link></dd></div>
        ) : null}
        <div className="flex justify-between gap-3"><dt className="text-zinc-500">Detectado</dt><dd>{when(item.firstDetectedAt)}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-zinc-500">Última observación</dt><dd>{when(item.lastObservedAt)} · {item.observationCount}×{item.occurrenceCount > 1 ? ` · reabierto ${item.occurrenceCount - 1}×` : ""}</dd></div>
        {item.stripeInvoiceId ? <div className="flex justify-between gap-3"><dt className="text-zinc-500">Factura Stripe</dt><dd className="font-mono text-xs">{item.stripeInvoiceId}</dd></div> : null}
        {item.stripeSubscriptionId ? <div className="flex justify-between gap-3"><dt className="text-zinc-500">Suscripción Stripe</dt><dd className="font-mono text-xs">{item.stripeSubscriptionId}</dd></div> : null}
        {item.stripeEventId ? <div className="flex justify-between gap-3"><dt className="text-zinc-500">Evento Stripe</dt><dd className="font-mono text-xs">{item.stripeEventId}</dd></div> : null}
        {item.lastAlertedAt ? <div className="flex justify-between gap-3"><dt className="text-zinc-500">Última alerta</dt><dd>{when(item.lastAlertedAt)} ({item.alertCount})</dd></div> : null}
        {item.resolutionNote ? <div className="flex justify-between gap-3 sm:col-span-2"><dt className="text-zinc-500">Nota de resolución</dt><dd className="text-right">{item.resolutionNote}</dd></div> : null}
        {item.dismissReason ? <div className="flex justify-between gap-3 sm:col-span-2"><dt className="text-zinc-500">Motivo de descarte</dt><dd className="text-right">{item.dismissReason}</dd></div> : null}
      </dl>

      {evidenceRows(item).length > 0 ? (
        <div className="mt-4 border-t border-zinc-100 pt-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Evidencia</p>
          <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {evidenceRows(item).map((row) => (
              <div key={row.label} className="flex justify-between gap-3"><dt className="text-zinc-500">{row.label}</dt><dd className="text-right">{row.value}</dd></div>
            ))}
          </dl>
        </div>
      ) : null}

      {canAct ? (
        <div className="mt-4 space-y-2 border-t border-zinc-100 pt-4">
          <label className="block text-xs font-medium text-zinc-600" htmlFor={`note-${item.id}`}>Nota (obligatoria para resolver o descartar)</label>
          <textarea id={`note-${item.id}`} value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm" placeholder="Qué se revisó, qué se decidió…" />
          {error ? <p className="text-sm text-red-700">{error}</p> : null}
          <div className="flex flex-wrap gap-2">
            {actions.map((a) => (
              <button key={a.id} type="button" disabled={busy !== null} onClick={() => void act(a.id, a.requiresNote)} className={a.id === "resolve" ? adminPrimaryBtn : adminSecondaryBtn}>
                {busy === a.id ? "Guardando…" : a.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-zinc-500">Estas acciones solo cambian el seguimiento del caso. Nunca cobran, reembolsan ni modifican Stripe.</p>
        </div>
      ) : null}
    </SurfaceCard>
  );
}

export default function BillingExceptionsPage() {
  const { selectedStudioId, studioRole } = useDeskStudio();
  const searchParams = useSearchParams();
  const canAct = canManageStudioSettings(studioRole ?? null);
  const [preset, setPreset] = useState<CaseFilterPreset>("active");
  const [data, setData] = useState<BillingCaseListResponse | null>(null);
  const [run, setRun] = useState<BillingReconciliationRun | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get("case"));
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!selectedStudioId) return;
    setLoading(true);
    setError(null);
    try {
      const status = FILTER_PRESETS.find((p) => p.id === preset)?.status;
      const [cases, latest] = await Promise.all([
        fetchBillingCases(selectedStudioId, { status, limit: 100 }),
        fetchLatestBillingReconciliationRun(selectedStudioId).catch(() => null),
      ]);
      setData(cases);
      setRun(latest);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudieron cargar los casos de facturación.");
    } finally {
      setLoading(false);
    }
  }, [selectedStudioId, preset]);

  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);

  async function triggerRun() {
    if (!selectedStudioId) return;
    setRunning(true);
    setError(null);
    try {
      await runBillingReconciliation(selectedStudioId);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo ejecutar la revisión.");
    } finally {
      setRunning(false);
    }
  }

  if (!selectedStudioId) return null;
  if (!canViewBillingCases(studioRole ?? null)) {
    return (
      <AdminPageShell>
        <PageHeader title="Facturación · casos por revisar" subtitle="Esta sección es para administradores y staff del estudio." />
      </AdminPageShell>
    );
  }
  const counts = activeSeverityCounts(data?.counts ?? []);
  const selected = data?.items.find((c) => c.id === selectedId) ?? null;

  return (
    <AdminPageShell>
      <div className="space-y-6">
        <PageHeader
          title="Facturación · casos por revisar"
          subtitle={`${headerSummary(counts)} ${runSummaryLine(run)}`}
          actions={canAct ? <button type="button" onClick={() => void triggerRun()} disabled={running} className={adminSecondaryBtn}>{running ? "Revisando…" : "Revisar ahora"}</button> : null}
        />

        {error ? <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div> : null}

        <div className="flex flex-wrap gap-2">
          {FILTER_PRESETS.map((p) => (
            <button key={p.id} type="button" onClick={() => { setPreset(p.id); setSelectedId(null); }} className={`rounded-full px-3 py-1 text-xs font-medium ${preset === p.id ? "bg-zinc-900 text-white" : "border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50"}`}>
              {p.label}
            </button>
          ))}
        </div>

        {selected ? <CaseDetail studioId={selectedStudioId} item={selected} canAct={canAct} onClose={() => setSelectedId(null)} onChanged={(next) => setData((prev) => (prev ? { ...prev, items: prev.items.map((c) => (c.id === next.id ? next : c)) } : prev))} /> : null}

        <div className={adminTableWrap}>
          <table className="min-w-full divide-y divide-zinc-200 text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-3">Severidad</th>
                <th className="px-4 py-3">Caso</th>
                <th className="px-4 py-3">Miembro</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3">Detectado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 bg-white">
              {loading && !data ? (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-zinc-500">Cargando…</td></tr>
              ) : (data?.items.length ?? 0) === 0 ? (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-zinc-500">No hay casos en esta vista.</td></tr>
              ) : (
                data!.items.map((c) => (
                  <tr key={c.id} onClick={() => setSelectedId(c.id)} className={`cursor-pointer hover:bg-zinc-50 ${selectedId === c.id ? "bg-zinc-50" : ""}`}>
                    <td className="px-4 py-3"><Pill label={c.severityLabel} tone={severityTone(c.severity)} /></td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-zinc-900">{c.title}</p>
                      <p className="text-xs text-zinc-500">{c.categoryLabel}</p>
                    </td>
                    <td className="px-4 py-3 text-zinc-700">{c.member ? c.member.reference : "—"}</td>
                    <td className="px-4 py-3"><Pill label={c.statusLabel} tone={statusTone(c.status)} /></td>
                    <td className="px-4 py-3 text-zinc-500">{when(c.firstDetectedAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {data?.nextCursor ? <p className="text-xs text-zinc-500">Mostrando los primeros 100 casos. Resuelve o descarta casos para ver el resto.</p> : null}
      </div>
    </AdminPageShell>
  );
}
