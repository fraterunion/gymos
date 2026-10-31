"use client";

import { useCallback, useEffect, useState } from "react";

import { AdminPageShell } from "@/components/shell/AdminPageShell";
import { PageHeader } from "@/components/shell/PageHeader";
import { useDeskStudio } from "@/contexts/DeskStudioContext";
import { adminInput, adminPrimaryBtn, adminSecondaryBtn } from "@/lib/adminSurface";
import {
  confirmCampaign,
  createCampaign,
  fetchCampaign,
  fetchCampaigns,
  fetchCommunicationsStatus,
  previewCampaign,
  retryCampaign,
  type CampaignDetail,
  type CampaignRecipient,
  type CampaignSummary,
  type CommunicationsStatus,
} from "@/lib/api/communications";
import { CAMPAIGN_ACTION_LABEL, campaignAction, campaignStateLabel, formatSender, type CampaignTone } from "@/lib/campaignDelivery";
import { ApiError } from "@/lib/api/errors";
import { fetchMembers, type MemberListItem } from "@/lib/api/members";
import { fetchMembershipPlans, type MembershipPlanDto } from "@/lib/api/memberships";

const STATUSES = ["ACTIVE", "TRIALING", "ENDING", "PAST_DUE", "PAUSED", "CANCELED", "REPLACED", "SCHEDULED", "EXPIRED", "NONE"] as const;
const SOURCES = ["STRIPE", "CASH", "MANUAL", "NONE"] as const;
const TONE_CLASS: Record<CampaignTone, string> = {
  neutral: "text-zinc-500",
  progress: "text-sky-700",
  warning: "text-amber-700",
  success: "text-emerald-700",
  danger: "text-red-700",
};

export default function CommunicationsPage() {
  const { selectedStudioId } = useDeskStudio();
  const [plans, setPlans] = useState<MembershipPlanDto[]>([]);
  const [subject, setSubject] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [planIds, setPlanIds] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [paymentSources, setPaymentSources] = useState<string[]>([]);
  const [allMembers, setAllMembers] = useState(false);
  const [includeUserIds, setIncludeUserIds] = useState<string[]>([]);
  const [excludeUserIds, setExcludeUserIds] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [found, setFound] = useState<MemberListItem[]>([]);
  const [preview, setPreview] = useState<CampaignRecipient[] | null>(null);
  const [previewSignature, setPreviewSignature] = useState<string | null>(null);
  const [previewFingerprint, setPreviewFingerprint] = useState<string | null>(null);
  const [previewCount, setPreviewCount] = useState(0);
  const [history, setHistory] = useState<CampaignSummary[]>([]);
  const [open, setOpen] = useState<CampaignDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [status, setStatus] = useState<CommunicationsStatus | null>(null);

  const loadHistory = useCallback(async () => {
    if (!selectedStudioId) return;
    const [rows, nextStatus] = await Promise.all([
      fetchCampaigns(selectedStudioId),
      fetchCommunicationsStatus(selectedStudioId).catch(() => null),
    ]);
    setHistory(rows);
    setStatus(nextStatus);
  }, [selectedStudioId]);

  useEffect(() => {
    if (!selectedStudioId) return;
    let cancelled = false;
    void fetchMembershipPlans(selectedStudioId, true)
      .then((rows) => { if (!cancelled) setPlans(rows); })
      .catch(() => { if (!cancelled) setPlans([]); });
    void fetchCampaigns(selectedStudioId)
      .then((rows) => { if (!cancelled) setHistory(rows); })
      .catch(() => { if (!cancelled) setHistory([]); });
    void fetchCommunicationsStatus(selectedStudioId)
      .then((next) => { if (!cancelled) setStatus(next); })
      .catch(() => { if (!cancelled) setStatus(null); });
    return () => { cancelled = true; };
  }, [selectedStudioId]);

  function audience() {
    return {
      allMembers,
      filters: { planIds, statuses, paymentSources },
      includeUserIds,
      excludeUserIds,
    };
  }

  // When Fer changes any targeting input after preview, the old snapshot no
  // longer grants permission to send. Re-preview even if the displayed count
  // happens to be equal: the actual recipients might be different.
  const audienceSignature = JSON.stringify({
    studioId: selectedStudioId,
    allMembers,
    plans: [...planIds].sort(),
    statuses: [...statuses].sort(),
    paymentSources: [...paymentSources].sort(),
    includeUserIds: [...includeUserIds].sort(),
    excludeUserIds: [...excludeUserIds].sort(),
  });
  const previewIsCurrent = preview !== null && previewSignature === audienceSignature && previewFingerprint !== null;

  async function onPreview() {
    if (!selectedStudioId) return;
    setBusy(true);
    setError(null);
    const requestedSignature = audienceSignature;
    try {
      const result = await previewCampaign(selectedStudioId, audience());
      setPreview(result.recipients);
      setPreviewCount(result.recipientCount);
      setPreviewSignature(requestedSignature);
      setPreviewFingerprint(result.previewFingerprint);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo calcular la audiencia.");
    } finally {
      setBusy(false);
    }
  }

  async function onSend() {
    if (!selectedStudioId || !previewIsCurrent || !previewFingerprint) {
      setError('La audiencia cambió. Actualiza la vista previa antes de confirmar.');
      return;
    }
    const approved = window.confirm(`¿Enviar este correo a ${previewCount} personas? Esta acción despacha la campaña.`);
    if (!approved) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createCampaign(selectedStudioId, {
        subject,
        bodyText,
        idempotencyKey,
        previewFingerprint,
        ...audience(),
      });
      await confirmCampaign(selectedStudioId, created.id);
      setSubject("");
      setBodyText("");
      setPreview(null);
      setPreviewSignature(null);
      setPreviewFingerprint(null);
      setIdempotencyKey(crypto.randomUUID());
      await loadHistory();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo enviar la campaña.");
    } finally {
      setBusy(false);
    }
  }

  const deliveryActive = status?.delivery.active === true;
  const canSend = deliveryActive && status?.sender.source !== "INVALID" && status?.unsubscribeConfigured === true;

  async function onCampaignAction(campaign: CampaignSummary) {
    if (!selectedStudioId) return;
    const action = campaignAction(campaign, deliveryActive);
    if (!action) return;
    const pending = campaign.pendingCount ?? 0;
    const prompt = action === "CONFIRM"
      ? `¿Enviar "${campaign.subject}" a ${campaign.recipientCount} personas?`
      : action === "RESUME"
        ? `¿Reanudar el envío de "${campaign.subject}"? Se enviará a ${pending} personas pendientes.`
        : `¿Reintentar los ${campaign.failedCount} envíos fallidos de "${campaign.subject}"?`;
    if (!window.confirm(prompt)) return;
    setBusy(true);
    setError(null);
    try {
      const updated = action === "CONFIRM"
        ? await confirmCampaign(selectedStudioId, campaign.id)
        : await retryCampaign(selectedStudioId, campaign.id);
      setOpen(updated);
      await loadHistory();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo actualizar la campaña.");
    } finally {
      setBusy(false);
    }
  }

  async function searchMembers() {
    if (!selectedStudioId || search.trim().length < 2) return;
    const res = await fetchMembers(selectedStudioId, { search: search.trim(), role: "MEMBER", limit: 20 });
    setFound(res.data);
  }

  function toggle(list: string[], id: string, setList: (ids: string[]) => void) {
    setList(list.includes(id) ? list.filter((row) => row !== id) : [...list, id]);
  }

  return (
    <AdminPageShell>
      <PageHeader title="Comunicaciones" subtitle="Correo a miembros del estudio. El envío queda en historial y no sale hasta que lo confirmas." />
      {status ? (
        <div className={`mt-6 rounded-2xl border p-4 text-sm ${canSend ? "border-emerald-200 bg-emerald-50" : "border-amber-300 bg-amber-50"}`}>
          <p className="font-medium text-zinc-900">
            {deliveryActive ? "Envíos activos" : "Envíos pausados"}
          </p>
          {status.delivery.message ? <p className="mt-1 text-amber-800">{status.delivery.message}</p> : null}
          {status.sender.source === "INVALID" ? (
            <p className="mt-1 text-red-700">Remitente de campañas inválido: {status.sender.error}</p>
          ) : (
            <p className="mt-1 text-zinc-700">
              De: {formatSender(status.sender.fromName, status.sender.fromAddress)} · Responder a: {status.sender.replyTo ?? "—"}
            </p>
          )}
          {!status.unsubscribeConfigured ? (
            <p className="mt-1 text-red-700">Falta configurar el enlace público para cancelar correos; no se pueden enviar campañas.</p>
          ) : null}
        </div>
      ) : null}
      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-5">
          <label className="block text-sm">
            <span className="mb-1 block text-zinc-600">Asunto</span>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} className={adminInput} maxLength={200} />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-zinc-600">Mensaje</span>
            <textarea value={bodyText} onChange={(e) => setBodyText(e.target.value)} rows={8} className={adminInput} maxLength={10000} />
          </label>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-zinc-800">Plan</legend>
            <div className="flex flex-wrap gap-2">
              {plans.map((plan) => (
                <label key={plan.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={planIds.includes(plan.id)} onChange={() => toggle(planIds, plan.id, setPlanIds)} />
                  {plan.name}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-zinc-800">Estado de membresía</legend>
            <div className="flex flex-wrap gap-2">
              {STATUSES.map((status) => (
                <label key={status} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={statuses.includes(status)} onChange={() => toggle(statuses, status, setStatuses)} />
                  {status}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-zinc-800">Método de pago</legend>
            <div className="flex flex-wrap gap-2">
              {SOURCES.map((source) => (
                <label key={source} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={paymentSources.includes(source)} onChange={() => toggle(paymentSources, source, setPaymentSources)} />
                  {source}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={allMembers} onChange={(e) => setAllMembers(e.target.checked)} />
            Todos los miembros, sin filtrar
          </label>
          <div className="flex gap-2">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar miembro" className={adminInput} />
            <button type="button" className={adminSecondaryBtn} onClick={() => void searchMembers()}>Buscar</button>
          </div>
          <ul className="space-y-1 text-sm">
            {found.map((member) => (
              <li key={member.user.id} className="flex items-center justify-between gap-2">
                <span>{member.user.firstName} {member.user.lastName} · {member.user.email}</span>
                <span className="flex gap-2">
                  <button type="button" className="text-xs underline" onClick={() => toggle(includeUserIds, member.user.id, setIncludeUserIds)}>Incluir</button>
                  <button type="button" className="text-xs underline" onClick={() => toggle(excludeUserIds, member.user.id, setExcludeUserIds)}>Excluir</button>
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-zinc-500">Incluidos: {includeUserIds.length}. Excluidos: {excludeUserIds.length}.</p>
          {error ? <p className="text-sm text-red-700">{error}</p> : null}
          <div className="flex gap-2">
            <button type="button" className={adminSecondaryBtn} disabled={busy} onClick={() => void onPreview()}>Vista previa</button>
            <button type="button" className={adminPrimaryBtn} disabled={busy || !canSend || !previewIsCurrent || !subject.trim() || !bodyText.trim()} onClick={() => void onSend()}>
              Confirmar envío
            </button>
          </div>
          {status && !canSend ? (
            <p className="text-sm text-amber-700">El envío está deshabilitado mientras los envíos estén pausados o el remitente no esté configurado.</p>
          ) : null}
          {preview && !previewIsCurrent ? (
            <p className="text-sm text-amber-700">Los filtros o miembros seleccionados cambiaron. Vuelve a generar la vista previa antes de enviar.</p>
          ) : null}
          {preview && previewIsCurrent ? (
            <div>
              <p className="mb-2 text-sm font-medium">{previewCount} destinatarios</p>
              <ul className="max-h-64 overflow-y-auto text-sm text-zinc-700">
                {preview.map((recipient) => (
                  <li key={recipient.userId}>{recipient.name} · {recipient.email} · {recipient.planName ?? "sin plan"} · {recipient.paymentSource ?? "—"}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
        <aside className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-900">Historial</h2>
            <button type="button" className="text-xs underline" onClick={() => void loadHistory()}>Actualizar</button>
          </div>
          <ul className="space-y-2">
            {history.map((campaign) => (
              <li key={campaign.id}>
                <button type="button" className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-left text-sm" onClick={() => selectedStudioId && void fetchCampaign(selectedStudioId, campaign.id).then(setOpen)}>
                  <span className="block font-medium">{campaign.subject}</span>
                  <span className={`text-xs ${TONE_CLASS[campaignStateLabel(campaign).tone]}`}>{campaignStateLabel(campaign).label}</span>
                </button>
              </li>
            ))}
          </ul>
          {open ? (
            <div className="rounded-xl border border-zinc-200 bg-white p-3 text-sm">
              <p className="font-medium">{open.subject}</p>
              <p className={`mt-1 text-xs ${TONE_CLASS[campaignStateLabel(open).tone]}`}>
                {campaignStateLabel(open).label} · {open.sentCount} enviados · {open.failedCount} fallos · {open.skippedCount} omitidos
              </p>
              {campaignAction(open, deliveryActive) ? (
                <button type="button" className={`${adminSecondaryBtn} mt-2`} disabled={busy} onClick={() => void onCampaignAction(open)}>
                  {CAMPAIGN_ACTION_LABEL[campaignAction(open, deliveryActive)!]}
                </button>
              ) : null}
              <p className="mt-2 whitespace-pre-wrap text-zinc-700">{open.bodyText}</p>
              <ul className="mt-3 max-h-48 overflow-y-auto text-xs text-zinc-600">
                {open.recipients.map((recipient) => (
                  <li key={recipient.id}>{recipient.email} · {recipient.status}{recipient.error ? ` · ${recipient.error}` : ""}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </aside>
      </div>
    </AdminPageShell>
  );
}
