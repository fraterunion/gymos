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
  previewCampaign,
  type CampaignDetail,
  type CampaignRecipient,
  type CampaignSummary,
} from "@/lib/api/communications";
import { ApiError } from "@/lib/api/errors";
import { fetchMembers, type MemberListItem } from "@/lib/api/members";
import { fetchMembershipPlans, type MembershipPlanDto } from "@/lib/api/memberships";

const STATUSES = ["ACTIVE", "TRIALING", "ENDING", "PAST_DUE", "PAUSED", "CANCELED", "REPLACED", "SCHEDULED", "EXPIRED", "NONE"] as const;
const SOURCES = ["STRIPE", "CASH", "MANUAL", "NONE"] as const;

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
  const [previewCount, setPreviewCount] = useState(0);
  const [history, setHistory] = useState<CampaignSummary[]>([]);
  const [open, setOpen] = useState<CampaignDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const loadHistory = useCallback(async () => {
    if (!selectedStudioId) return;
    setHistory(await fetchCampaigns(selectedStudioId));
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

  async function onPreview() {
    if (!selectedStudioId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await previewCampaign(selectedStudioId, audience());
      setPreview(result.recipients);
      setPreviewCount(result.recipientCount);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo calcular la audiencia.");
    } finally {
      setBusy(false);
    }
  }

  async function onSend() {
    if (!selectedStudioId || !preview) return;
    const approved = window.confirm(`¿Enviar este correo a ${previewCount} personas? Esta acción despacha la campaña.`);
    if (!approved) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createCampaign(selectedStudioId, {
        subject,
        bodyText,
        idempotencyKey,
        ...audience(),
      });
      await confirmCampaign(selectedStudioId, created.id);
      setSubject("");
      setBodyText("");
      setPreview(null);
      setIdempotencyKey(crypto.randomUUID());
      await loadHistory();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo enviar la campaña.");
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
            <button type="button" className={adminPrimaryBtn} disabled={busy || !preview || !subject.trim() || !bodyText.trim()} onClick={() => void onSend()}>
              Confirmar envío
            </button>
          </div>
          {preview ? (
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
                  <span className="text-xs text-zinc-500">{campaign.status} · {campaign.sentCount}/{campaign.recipientCount} enviados · {campaign.failedCount} fallos</span>
                </button>
              </li>
            ))}
          </ul>
          {open ? (
            <div className="rounded-xl border border-zinc-200 bg-white p-3 text-sm">
              <p className="font-medium">{open.subject}</p>
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
