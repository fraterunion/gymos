"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useDeskStudio } from "@/contexts/DeskStudioContext";
import { ApiError } from "@/lib/api/errors";
import {
  archiveMembershipPlan,
  createMembershipPlan,
  fetchMembershipPlans,
  fetchMembershipsOverview,
  fetchPlanBillingIntegrity,
  fetchPlanConfigurationHistory,
  fetchSubscriptions,
  setCancelAtPeriodEnd,
  updateMembershipPlan,
  updateSubscriptionStatus,
  type BillingInterval,
  type MembershipPlanDto,
  type MembershipPlanInput,
  type MembershipsOverview,
  type PlanConfigurationHistoryEntry,
  type PlanIntegrityResult,
  type SubscriptionListItem,
  type SubscriptionStatus,
} from "@/lib/api/memberships";
import {
  fetchClassTemplates,
  updateClassTemplate,
  type ClassTemplateDto,
} from "@/lib/api/classTemplates";
import {
  fetchDayPassClassAccess,
  grantDayPassClassAccess,
  revokeDayPassClassAccess,
  type DayPassClassAccessTemplateDto,
} from "@/lib/api/dayPassClassAccess";
import { planHealth } from "@/lib/membershipPlanSummary";
import {
  ClassAccessMatrix,
  DayPassTab,
  formatCents,
  integrityIssueLabel,
  OpenGymPanel,
  OverviewBar,
  PlanCard,
  PlanConfigurationHistoryPanel,
  SubRow,
  TabNav,
  type MembershipTab,
} from "./memberships-ui";

// ── Plan modal helpers ────────────────────────────────────────────────────────

type PlanFormState = {
  name: string;
  description: string;
  priceCents: string;
  currency: string;
  billingInterval: BillingInterval;
  classCredits: string;
  unlimitedCredits: boolean;
  fixedDuration: boolean;
  entitlementDays: string;
  stripeProductId: string;
  stripePriceId: string;
  active: boolean;
  allClassesAccess: boolean;
  selectedTemplateIds: string[];
};

const emptyForm = (): PlanFormState => ({
  name: "",
  description: "",
  priceCents: "",
  currency: "usd",
  billingInterval: "MONTHLY",
  classCredits: "",
  unlimitedCredits: true,
  fixedDuration: false,
  entitlementDays: "",
  stripeProductId: "",
  stripePriceId: "",
  active: true,
  allClassesAccess: false,
  selectedTemplateIds: [],
});

function planToForm(p: MembershipPlanDto): PlanFormState {
  return {
    name: p.name,
    description: p.description ?? "",
    priceCents: String(p.priceCents / 100),
    currency: p.currency,
    billingInterval: p.billingInterval,
    classCredits: p.classCredits === null ? "" : String(p.classCredits),
    unlimitedCredits: p.classCredits === null,
    fixedDuration: p.entitlementDays !== null,
    entitlementDays: p.entitlementDays === null ? "" : String(p.entitlementDays),
    stripeProductId: p.stripeProductId ?? "",
    stripePriceId: p.stripePriceId ?? "",
    active: p.active,
    allClassesAccess: p.classAccess.allClasses,
    selectedTemplateIds: p.classAccess.templates.map((t) => t.id),
  };
}

function activeClassTemplateIds(templates: ClassTemplateDto[]): string[] {
  return templates.map((t) => t.id);
}

function isTemplateRowChecked(
  templateId: string,
  allClassesAccess: boolean,
  selectedTemplateIds: string[],
  isInactive = false,
): boolean {
  if (allClassesAccess) return !isInactive || selectedTemplateIds.includes(templateId);
  return selectedTemplateIds.includes(templateId);
}

function ClassAccessTemplateRow({
  name,
  durationMinutes,
  checked,
  disabled,
  inactive,
  isOpenGymSlot,
  accessWindowStart,
  accessWindowEnd,
  onToggle,
}: {
  name: string;
  durationMinutes: number;
  checked: boolean;
  disabled: boolean;
  inactive?: boolean;
  isOpenGymSlot?: boolean;
  accessWindowStart?: string | null;
  accessWindowEnd?: string | null;
  onToggle?: () => void;
}) {
  return (
    <label
      className={`flex items-center gap-2 py-1.5 text-sm ${
        disabled ? "text-zinc-500" : "text-zinc-700"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={() => onToggle?.()}
        className="rounded"
      />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {isOpenGymSlot ? (
        <span className="shrink-0 rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-700">
          Open Gym{accessWindowStart && accessWindowEnd ? ` ${accessWindowStart}–${accessWindowEnd}` : ""}
        </span>
      ) : null}
      {inactive ? (
        <span className="shrink-0 text-xs text-zinc-400">Inactiva</span>
      ) : null}
      <span className="shrink-0 text-xs text-zinc-400 tabular-nums">
        {durationMinutes} min
      </span>
    </label>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <p className="border-t border-zinc-100 pt-3 text-[11px] font-bold uppercase tracking-widest text-zinc-400 first:border-t-0 first:pt-0">
      {children}
    </p>
  );
}

function PlanModal({
  editing,
  onClose,
  onSaved,
  studioId,
  integrity,
}: {
  editing: MembershipPlanDto | null;
  onClose: () => void;
  onSaved: () => void;
  studioId: string;
  integrity?: PlanIntegrityResult;
}) {
  const [form, setForm] = useState<PlanFormState>(() =>
    editing ? planToForm(editing) : emptyForm()
  );
  const [templates, setTemplates] = useState<ClassTemplateDto[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<PlanConfigurationHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchClassTemplates(studioId)
      .then((data) => {
        if (!cancelled) setTemplates(data);
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      })
      .finally(() => {
        if (!cancelled) setTemplatesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [studioId]);

  useEffect(() => {
    if (!editing || !showHistory) return;
    let cancelled = false;
    setHistoryLoading(true);
    void fetchPlanConfigurationHistory(studioId, editing.id)
      .then((data) => {
        if (!cancelled) setHistory(data);
      })
      .catch(() => {
        if (!cancelled) setHistory([]);
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [studioId, editing, showHistory]);

  function set<K extends keyof PlanFormState>(key: K, val: PlanFormState[K]) {
    setForm((f) => ({ ...f, [key]: val }));
  }

  function toggleTemplate(templateId: string) {
    if (form.allClassesAccess) return;
    setForm((f) => {
      const selected = new Set(f.selectedTemplateIds);
      if (selected.has(templateId)) {
        selected.delete(templateId);
      } else {
        selected.add(templateId);
      }
      return { ...f, selectedTemplateIds: [...selected] };
    });
  }

  function handleAllClassesAccessChange(checked: boolean) {
    if (checked) {
      const hadRestrictedAccess = editing != null && !editing.classAccess.allClasses;
      if (hadRestrictedAccess) {
        const confirmed = window.confirm(
          `«${editing!.name}» currently restricts access to ${editing!.classAccess.templates.length} class(es). ` +
            "Switching to «Todas las clases» will immediately grant this plan access to every active class in the studio, " +
            "including classes it was deliberately excluded from (e.g. Booty Lab, Open Gym). Continue?",
        );
        if (!confirmed) return;
      }
      set("allClassesAccess", true);
      return;
    }
    setForm((f) => {
      const activeIds = activeClassTemplateIds(templates);
      const inactivePreserved = (editing?.classAccess.templates ?? [])
        .filter((t) => !t.active)
        .map((t) => t.id);
      return {
        ...f,
        allClassesAccess: false,
        selectedTemplateIds: [...new Set([...activeIds, ...inactivePreserved])],
      };
    });
  }

  const inactiveSavedTemplates =
    editing?.classAccess.templates.filter((t) => !t.active) ?? [];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const cents = Math.round(parseFloat(form.priceCents) * 100);
    if (isNaN(cents) || cents < 0) {
      setError("Ingresa un precio válido.");
      return;
    }
    if (!form.allClassesAccess && form.selectedTemplateIds.length === 0) {
      setError("Selecciona al menos una clase o activa «Todas las clases».");
      return;
    }
    if (form.fixedDuration) {
      const days = parseInt(form.entitlementDays, 10);
      if (isNaN(days) || days < 1) {
        setError("Ingresa una duración fija válida (días).");
        return;
      }
    }
    const input: MembershipPlanInput = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      priceCents: cents,
      currency: form.currency.trim().toLowerCase(),
      billingInterval: form.billingInterval,
      classCredits: form.unlimitedCredits
        ? null
        : parseInt(form.classCredits, 10) || 0,
      entitlementDays: form.fixedDuration
        ? parseInt(form.entitlementDays, 10)
        : null,
      stripeProductId: form.stripeProductId.trim() || null,
      stripePriceId: form.stripePriceId.trim() || null,
      allClassesAccess: form.allClassesAccess,
      classTemplateIds: form.allClassesAccess ? [] : form.selectedTemplateIds,
    };
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        await updateMembershipPlan(studioId, editing.id, {
          ...input,
          active: form.active,
        });
      } else {
        await createMembershipPlan(studioId, input);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo guardar el plan.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-200 px-6 py-4">
          <h2 className="text-base font-semibold text-zinc-900">
            {editing ? "Editar plan" : "Nuevo plan de membresía"}
          </h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
          >
            ✕
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="px-6 py-5 space-y-4 overflow-y-auto max-h-[70vh]">
          <SectionHeader>General</SectionHeader>
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-600">
              Nombre del plan *
            </label>
            <input
              required
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-900"
              placeholder="Ej. Acceso mensual"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-600">
              Descripción para miembros
            </label>
            <textarea
              rows={2}
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-900"
              placeholder="Qué incluye este plan…"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-600">
                Precio GymOS *
              </label>
              <input
                required
                type="number"
                min="0"
                step="0.01"
                value={form.priceCents}
                onChange={(e) => set("priceCents", e.target.value)}
                className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm"
                placeholder="49.00"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-600">
                Moneda
              </label>
              <select
                value={form.currency}
                onChange={(e) => set("currency", e.target.value)}
                className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm"
              >
                <option value="usd">USD</option>
                <option value="eur">EUR</option>
                <option value="gbp">GBP</option>
                <option value="cad">CAD</option>
                <option value="aud">AUD</option>
                <option value="mxn">MXN</option>
              </select>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-600">
              Intervalo de facturación
            </label>
            <select
              value={form.billingInterval}
              onChange={(e) => set("billingInterval", e.target.value as BillingInterval)}
              className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm"
            >
              <option value="MONTHLY">Mensual</option>
              <option value="YEARLY">Anual</option>
              <option value="WEEKLY">Semanal</option>
            </select>
          </div>

          {editing && (
            <label className="flex items-center gap-2 text-sm text-zinc-700">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => set("active", e.target.checked)}
                className="rounded"
              />
              Plan activo y disponible para nuevas ventas
            </label>
          )}

          <SectionHeader>Ciclo</SectionHeader>
          <div>
            <label className="mb-1 flex items-center gap-2 text-xs font-medium text-zinc-600">
              <input
                type="checkbox"
                checked={form.fixedDuration}
                onChange={(e) => set("fixedDuration", e.target.checked)}
                className="rounded"
              />
              Duración fija (ej. Booty Lab = 45 días)
            </label>
            {form.fixedDuration ? (
              <>
                <input
                  type="number"
                  min="1"
                  value={form.entitlementDays}
                  onChange={(e) => set("entitlementDays", e.target.value)}
                  className="mt-1 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm"
                  placeholder="Número de días de vigencia"
                />
                <p className="mt-1 text-xs text-zinc-500">
                  Anula el intervalo de facturación de arriba: el ciclo de acceso y el precio
                  recurrente de Stripe usarán este número de días en lugar de {form.billingInterval.toLowerCase()}.
                </p>
              </>
            ) : null}
          </div>

          <SectionHeader>Uso</SectionHeader>
          <div>
            <label className="mb-1 flex items-center gap-2 text-xs font-medium text-zinc-600">
              <input
                type="checkbox"
                checked={form.unlimitedCredits}
                onChange={(e) => set("unlimitedCredits", e.target.checked)}
                className="rounded"
              />
              Créditos ilimitados
            </label>
            {!form.unlimitedCredits && (
              <input
                type="number"
                min="0"
                value={form.classCredits}
                onChange={(e) => set("classCredits", e.target.value)}
                className="mt-1 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm"
                placeholder="Clases por ciclo"
              />
            )}
          </div>

          <SectionHeader>Acceso</SectionHeader>
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 space-y-3">
            <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">
              Acceso a clases
            </p>
            <label className="flex items-center gap-2 text-sm text-zinc-700">
              <input
                type="checkbox"
                checked={form.allClassesAccess}
                onChange={(e) => handleAllClassesAccessChange(e.target.checked)}
                className="rounded"
              />
              Todas las clases
            </label>

            {form.allClassesAccess ? (
              <p className="text-xs text-amber-700">
                ⚠ Esta membresía incluye acceso a <strong>todas</strong> las clases activas del
                estudio, incluyendo clases restringidas como Booty Lab u Open Gym. Úsalo solo para
                planes de acceso total.
              </p>
            ) : null}

            <div>
              <p className="mb-1 text-xs font-medium text-zinc-500">Clases incluidas</p>
              {templatesLoading ? (
                <p className="text-xs text-zinc-500">Cargando clases…</p>
              ) : templates.length === 0 && inactiveSavedTemplates.length === 0 ? (
                <p className="text-xs text-zinc-500">
                  No hay plantillas de clase en este estudio.
                </p>
              ) : (
                <div className="max-h-48 overflow-y-auto pr-1">
                  {templates.map((template) => (
                    <ClassAccessTemplateRow
                      key={template.id}
                      name={template.name}
                      durationMinutes={template.durationMinutes}
                      checked={isTemplateRowChecked(
                        template.id,
                        form.allClassesAccess,
                        form.selectedTemplateIds,
                      )}
                      disabled={form.allClassesAccess}
                      isOpenGymSlot={template.isOpenGymSlot}
                      accessWindowStart={template.accessWindowStart}
                      accessWindowEnd={template.accessWindowEnd}
                      onToggle={() => toggleTemplate(template.id)}
                    />
                  ))}

                  {inactiveSavedTemplates.length > 0 ? (
                    <div className="mt-2 border-t border-zinc-200 pt-2">
                      <p className="mb-1 text-xs text-zinc-400">Inactivas</p>
                      {inactiveSavedTemplates.map((template) => (
                        <ClassAccessTemplateRow
                          key={template.id}
                          name={template.name}
                          durationMinutes={template.durationMinutes}
                          checked={isTemplateRowChecked(
                            template.id,
                            form.allClassesAccess,
                            form.selectedTemplateIds,
                            true,
                          )}
                          disabled
                          inactive
                          isOpenGymSlot={template.isOpenGymSlot}
                          accessWindowStart={template.accessWindowStart}
                          accessWindowEnd={template.accessWindowEnd}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </div>

          <SectionHeader>Stripe / Billing</SectionHeader>
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Vinculación de cobro
            </p>
            <p className="text-[11px] text-zinc-500">
              Guardar este plan no modifica automáticamente Stripe. Solo actualiza la
              configuración local de GymOS.
            </p>
            {editing ? (
              <div className="grid grid-cols-2 gap-2 rounded-lg border border-zinc-200 bg-white p-3 text-xs">
                <div>
                  <p className="text-zinc-400">Precio GymOS</p>
                  <p className="mt-1 font-semibold text-zinc-900">
                    {formatCents(editing.priceCents, editing.currency)}
                  </p>
                </div>
                <div>
                  <p className="text-zinc-400">Precio Stripe</p>
                  <p className="mt-1 font-semibold text-zinc-900">
                    {integrity?.stripeUnitAmount == null
                      ? "No disponible"
                      : formatCents(
                          integrity.stripeUnitAmount,
                          integrity.stripeCurrency ?? editing.currency,
                        )}
                  </p>
                </div>
                <p
                  className={`col-span-2 font-semibold ${integrity?.status === "healthy" ? "text-emerald-700" : "text-amber-700"}`}
                >
                  Estado:{" "}
                  {integrity?.status === "healthy"
                    ? "Sincronizado"
                    : integrity?.status
                      ? integrityIssueLabel(integrity.status)
                      : "Revisar configuración"}
                </p>
              </div>
            ) : null}
            <div>
              <label className="mb-1 block text-xs text-zinc-500">Product ID de Stripe</label>
              <input
                value={form.stripeProductId}
                onChange={(e) => set("stripeProductId", e.target.value)}
                className="w-full rounded border border-zinc-200 bg-white px-2 py-1.5 text-xs font-mono"
                placeholder="prod_…"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-500">Price ID de Stripe</label>
              <input
                value={form.stripePriceId}
                onChange={(e) => set("stripePriceId", e.target.value)}
                className="w-full rounded border border-zinc-200 bg-white px-2 py-1.5 text-xs font-mono"
                placeholder="price_…"
              />
            </div>
          </div>

          {editing ? (
            <div>
              <button
                type="button"
                onClick={() => setShowHistory((v) => !v)}
                className="text-xs font-semibold text-zinc-600 underline-offset-2 hover:underline"
              >
                {showHistory ? "Ocultar historial de cambios" : "Historial de cambios"}
              </button>
              {showHistory ? (
                <div className="mt-2">
                  <PlanConfigurationHistoryPanel entries={history} loading={historyLoading} />
                </div>
              ) : null}
            </div>
          ) : null}

          {error && (
            <p className="text-sm text-red-600">{error}</p>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
            >
              Cerrar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-700 disabled:opacity-50"
            >
              {saving ? "Guardando…" : editing ? "Guardar cambios" : "Crear plan"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const STATUS_LABELS: Record<SubscriptionStatus, string> = {
  ACTIVE: "Activa",
  TRIALING: "Prueba",
  PAST_DUE: "Pago pendiente",
  PAUSED: "Pausada",
  CANCELED: "Cancelada",
};

export default function MembershipsPage() {
  const { selectedStudioId } = useDeskStudio();

  const [activeTab, setActiveTab] = useState<MembershipTab>("planes");
  const [overview, setOverview] = useState<MembershipsOverview | null>(null);
  const [plans, setPlans] = useState<MembershipPlanDto[]>([]);
  const [classTemplates, setClassTemplates] = useState<ClassTemplateDto[]>([]);
  const [dayPassTemplates, setDayPassTemplates] = useState<DayPassClassAccessTemplateDto[]>([]);
  const [planIntegrity, setPlanIntegrity] = useState<Map<string, PlanIntegrityResult>>(new Map());
  const [subs, setSubs] = useState<SubscriptionListItem[]>([]);
  const [subsTotal, setSubsTotal] = useState(0);
  const [subsPage, setSubsPage] = useState(1);

  const [loadingPlans, setLoadingPlans] = useState(true);
  const [loadingSubs, setLoadingSubs] = useState(true);
  const [dayPassLoading, setDayPassLoading] = useState(true);
  const [dayPassError, setDayPassError] = useState<string | null>(null);
  const [dayPassPendingId, setDayPassPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [showInactive, setShowInactive] = useState(false);
  const [statusFilter, setStatusFilter] = useState<SubscriptionStatus | "">("");
  const [planFilter, setPlanFilter] = useState<string>("");
  const [subscriptionViewFilter, setSubscriptionViewFilter] = useState<"" | "attention" | "expiring">("");

  const [showPlanModal, setShowPlanModal] = useState(false);
  const [editingPlan, setEditingPlan] = useState<MembershipPlanDto | null>(null);

  const SUBS_LIMIT = 25;

  const loadPlans = useCallback(async () => {
    if (!selectedStudioId) return;
    setLoadingPlans(true);
    try {
      const [data, integrityResult, templateData, dayPassData] = await Promise.all([
        fetchMembershipPlans(selectedStudioId, true),
        fetchPlanBillingIntegrity(selectedStudioId)
          .then((r) => ({ ok: true as const, data: r }))
          .catch(() => ({ ok: false as const, data: [] as PlanIntegrityResult[] })),
        fetchClassTemplates(selectedStudioId),
        fetchDayPassClassAccess(selectedStudioId),
      ]);
      setPlans(data);
      setClassTemplates(templateData);
      setDayPassTemplates(dayPassData);
      if (integrityResult.ok) {
        setPlanIntegrity(new Map(integrityResult.data.map((r) => [r.planId, r])));
      } else {
        setPlanIntegrity(new Map());
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudieron cargar los planes.");
    } finally {
      setLoadingPlans(false);
      setDayPassLoading(false);
    }
  }, [selectedStudioId]);

  const loadOverview = useCallback(async () => {
    if (!selectedStudioId) return;
    try {
      const data = await fetchMembershipsOverview(selectedStudioId);
      setOverview(data);
    } catch {
      /* non-critical */
    }
  }, [selectedStudioId]);

  const loadSubs = useCallback(async (page = 1) => {
    if (!selectedStudioId) return;
    setLoadingSubs(true);
    try {
      const res = await fetchSubscriptions(selectedStudioId, {
        status: subscriptionViewFilter ? undefined : statusFilter || undefined,
        planId: planFilter || undefined,
        attention: subscriptionViewFilter === "attention" ? true : undefined,
        expiringWithin7Days: subscriptionViewFilter === "expiring" ? true : undefined,
        page,
        limit: SUBS_LIMIT,
      });
      setSubs(res.data);
      setSubsTotal(res.total);
      setSubsPage(res.page);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudieron cargar las suscripciones.");
    } finally {
      setLoadingSubs(false);
    }
  }, [selectedStudioId, statusFilter, planFilter, subscriptionViewFilter]);

  useEffect(() => {
    const t = setTimeout(() => {
      void loadPlans();
      void loadOverview();
    }, 0);
    return () => clearTimeout(t);
  }, [loadPlans, loadOverview]);

  useEffect(() => {
    const t = setTimeout(() => void loadSubs(1), 0);
    return () => clearTimeout(t);
  }, [loadSubs]);

  async function handleSubAction(sub: SubscriptionListItem, newStatus: SubscriptionStatus) {
    if (!selectedStudioId) return;
    try {
      await updateSubscriptionStatus(selectedStudioId, sub.user.id, sub.id, newStatus);
      void loadSubs(subsPage);
      void loadOverview();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo completar la acción.");
    }
  }

  async function handleCancelAtPeriodEnd(sub: SubscriptionListItem, cancel: boolean) {
    if (!selectedStudioId) return;
    try {
      await setCancelAtPeriodEnd(selectedStudioId, sub.user.id, sub.id, cancel);
      void loadSubs(subsPage);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo completar la acción.");
    }
  }

  async function handleArchivePlan(plan: MembershipPlanDto) {
    if (!selectedStudioId) return;
    if (!confirm(`¿Archivar «${plan.name}»? Dejará de venderse, pero conservará sus suscripciones e historial.`)) return;
    try {
      await archiveMembershipPlan(selectedStudioId, plan.id);
      void loadPlans();
      void loadOverview();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo archivar el plan.");
    }
  }

  async function handleToggleActive(plan: MembershipPlanDto) {
    if (!selectedStudioId) return;
    try {
      await updateMembershipPlan(selectedStudioId, plan.id, { active: !plan.active });
      void loadPlans();
      void loadOverview();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo actualizar el plan.");
    }
  }

  async function handleDayPassToggle(t: DayPassClassAccessTemplateDto) {
    if (!selectedStudioId) return;
    setDayPassPendingId(t.id);
    setDayPassError(null);
    try {
      if (t.allowed) {
        await revokeDayPassClassAccess(selectedStudioId, t.id);
      } else {
        await grantDayPassClassAccess(selectedStudioId, t.id);
      }
      const data = await fetchDayPassClassAccess(selectedStudioId);
      setDayPassTemplates(data);
    } catch (e) {
      setDayPassError(e instanceof ApiError ? e.message : "No se pudo actualizar el acceso.");
    } finally {
      setDayPassPendingId(null);
    }
  }

  function goToSubscriptions(planId?: string) {
    if (planId) setPlanFilter(planId);
    setActiveTab("suscripciones");
  }

  const visiblePlans = showInactive ? plans : plans.filter((p) => p.active && !p.deletedAt);
  const totalSubPages = Math.ceil(subsTotal / SUBS_LIMIT);
  const unhealthyPlanCount = useMemo(
    () =>
      plans.filter(
        (plan) =>
          plan.active &&
          !plan.deletedAt &&
          planHealth(plan, planIntegrity.get(plan.id)?.status).tone === "warning",
      ).length,
    [plans, planIntegrity],
  );

  if (!selectedStudioId) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <p className="text-sm text-zinc-500">Selecciona un estudio para gestionar membresías.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-8 flex items-center justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-zinc-400">Operaciones</p>
          <h1 className="mt-1 text-2xl font-bold text-zinc-900">Centro de membresías</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Configura planes, accesos y suscripciones desde una sola superficie segura.
          </p>
        </div>
        {activeTab === "planes" ? (
          <button
            type="button"
            onClick={() => {
              setEditingPlan(null);
              setShowPlanModal(true);
            }}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-700"
          >
            + Nuevo plan
          </button>
        ) : null}
      </div>

      {error ? (
        <div className="mb-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
          <button type="button" onClick={() => setError(null)} className="ml-3 underline">
            Cerrar
          </button>
        </div>
      ) : null}

      <TabNav activeTab={activeTab} onChange={setActiveTab} />

      {activeTab === "planes" && overview ? (
        <OverviewBar
          data={overview}
          unhealthyPlanCount={unhealthyPlanCount}
          onExpiringClick={() => {
            setSubscriptionViewFilter("expiring");
            setStatusFilter("");
            setActiveTab("suscripciones");
          }}
          onAttentionClick={() => {
            setSubscriptionViewFilter("attention");
            setStatusFilter("");
            setActiveTab("suscripciones");
          }}
        />
      ) : null}

      {activeTab === "planes" ? (
        <section>
          <div className="mb-4 flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-zinc-400">Planes</p>
              <h2 className="mt-1 text-lg font-semibold text-zinc-900">Catálogo operativo</h2>
            </div>
            <label className="flex items-center gap-2 text-sm text-zinc-500">
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
                className="rounded"
              />
              Mostrar inactivos
            </label>
          </div>

          {loadingPlans ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="h-52 animate-pulse rounded-xl bg-zinc-100" />
              ))}
            </div>
          ) : visiblePlans.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-300 py-12 text-center">
              <p className="text-sm text-zinc-500">Todavía no hay planes. Crea el primero para comenzar.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {visiblePlans.map((plan) => (
                <PlanCard
                  key={plan.id}
                  plan={plan}
                  integrity={planIntegrity.get(plan.id)}
                  onEdit={(p) => {
                    setEditingPlan(p);
                    setShowPlanModal(true);
                  }}
                  onArchive={handleArchivePlan}
                  onViewMembers={(p) => goToSubscriptions(p.id)}
                  onManageAccess={(p) => {
                    setEditingPlan(p);
                    setShowPlanModal(true);
                  }}
                  onToggleActive={handleToggleActive}
                />
              ))}
            </div>
          )}
        </section>
      ) : null}

      {activeTab === "suscripciones" ? (
        <section>
          {subscriptionViewFilter === "attention" ? (
            <div className="mb-4 space-y-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <p>
                Mostrando suscripciones que requieren atención: pago pendiente, pausadas y vencidas.
              </p>
              {unhealthyPlanCount > 0 ? (
                <p>
                  {unhealthyPlanCount} plan{unhealthyPlanCount === 1 ? "" : "es"} también requiere
                  atención por problemas de facturación.{" "}
                  <button
                    type="button"
                    onClick={() => {
                      setSubscriptionViewFilter("");
                      setActiveTab("planes");
                    }}
                    className="font-medium underline"
                  >
                    Ver planes
                  </button>
                </p>
              ) : null}
              <button
                type="button"
                onClick={() => setSubscriptionViewFilter("")}
                className="text-xs font-medium underline"
              >
                Quitar filtro
              </button>
            </div>
          ) : null}
          {subscriptionViewFilter === "expiring" ? (
            <div className="mb-4 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
              <p>
                Mostrando suscripciones con acceso vigente que vence en los próximos 7 días (comparación UTC).
              </p>
              <button
                type="button"
                onClick={() => setSubscriptionViewFilter("")}
                className="mt-1 text-xs font-medium underline"
              >
                Quitar filtro
              </button>
            </div>
          ) : null}
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-zinc-900">
              Suscripciones
              {subsTotal > 0 ? (
                <span className="ml-2 text-sm font-normal text-zinc-400">({subsTotal})</span>
              ) : null}
            </h2>
            <div className="flex flex-wrap gap-2">
              <select
                value={statusFilter}
                onChange={(e) => {
                  setSubscriptionViewFilter("");
                  setStatusFilter(e.target.value as SubscriptionStatus | "");
                }}
                className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm"
              >
                <option value="">Todos los estados</option>
                {(Object.keys(STATUS_LABELS) as SubscriptionStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
              <select
                value={planFilter}
                onChange={(e) => {
                  setSubscriptionViewFilter("");
                  setPlanFilter(e.target.value);
                }}
                className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm"
              >
                <option value="">Todos los planes</option>
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="overflow-x-auto rounded-xl border border-zinc-200">
            <table className="w-full min-w-[960px] text-left">
              <thead className="border-b border-zinc-200 bg-zinc-50 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="px-4 py-3">Miembro</th>
                  <th className="px-4 py-3">Plan</th>
                  <th className="px-4 py-3">Estado</th>
                  <th className="px-4 py-3">Pago</th>
                  <th className="px-4 py-3">Vigencia / renovación</th>
                  <th className="px-4 py-3">Uso</th>
                  <th className="px-4 py-3">Próximo cobro</th>
                  <th className="px-4 py-3">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 bg-white">
                {loadingSubs
                  ? [...Array(5)].map((_, i) => (
                      <tr key={i}>
                        {[...Array(8)].map((__, j) => (
                          <td key={j} className="px-4 py-3">
                            <div className="h-4 animate-pulse rounded bg-zinc-200" />
                          </td>
                        ))}
                      </tr>
                    ))
                  : subs.length === 0
                    ? (
                        <tr>
                          <td colSpan={8} className="px-4 py-12 text-center text-sm text-zinc-400">
                            No se encontraron suscripciones.
                          </td>
                        </tr>
                      )
                    : subs.map((sub) => (
                        <SubRow
                          key={sub.id}
                          sub={sub}
                          onAction={(s, st) => void handleSubAction(s, st)}
                          onCancelAtPeriodEnd={(s, c) => void handleCancelAtPeriodEnd(s, c)}
                        />
                      ))}
              </tbody>
            </table>
          </div>

          {totalSubPages > 1 ? (
            <div className="mt-4 flex items-center justify-between text-sm text-zinc-500">
              <span>
                Página {subsPage} de {totalSubPages}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={subsPage <= 1}
                  onClick={() => void loadSubs(subsPage - 1)}
                  className="rounded-lg border border-zinc-200 px-3 py-1.5 hover:bg-zinc-50 disabled:opacity-40"
                >
                  ← Anterior
                </button>
                <button
                  type="button"
                  disabled={subsPage >= totalSubPages}
                  onClick={() => void loadSubs(subsPage + 1)}
                  className="rounded-lg border border-zinc-200 px-3 py-1.5 hover:bg-zinc-50 disabled:opacity-40"
                >
                  Siguiente →
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {activeTab === "acceso" ? (
        <section>
          <ClassAccessMatrix
            plans={plans}
            templates={classTemplates}
            dayPass={dayPassTemplates}
            onManagePlan={(p) => {
              setEditingPlan(p);
              setShowPlanModal(true);
            }}
          />
          <OpenGymPanel
            studioId={selectedStudioId}
            template={classTemplates.find((template) => template.isOpenGymSlot)}
            plans={plans}
            onSaved={() => void loadPlans()}
            onUpdateTemplate={updateClassTemplate}
          />
        </section>
      ) : null}

      {activeTab === "day-pass" ? (
        <DayPassTab
          studioId={selectedStudioId}
          templates={dayPassTemplates}
          onToggle={(t) => void handleDayPassToggle(t)}
          pendingId={dayPassPendingId}
          loading={dayPassLoading}
          error={dayPassError}
        />
      ) : null}

      {showPlanModal && selectedStudioId ? (
        <PlanModal
          editing={editingPlan}
          studioId={selectedStudioId}
          integrity={editingPlan ? planIntegrity.get(editingPlan.id) : undefined}
          onClose={() => setShowPlanModal(false)}
          onSaved={() => {
            setShowPlanModal(false);
            void loadPlans();
            void loadOverview();
          }}
        />
      ) : null}
    </div>
  );
}
