"use client";

// Deployment marker: Memberships 4.0 production release.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useDeskStudio } from "@/contexts/DeskStudioContext";
import { ApiError } from "@/lib/api/errors";
import {
  archiveMembershipPlan,
  createMembershipPlan,
  fetchMembershipPlans,
  fetchMembershipsOverview,
  fetchPlanBillingIntegrity,
  fetchSubscriptions,
  setCancelAtPeriodEnd,
  updateMembershipPlan,
  updateSubscriptionStatus,
  type BillingInterval,
  type MembershipPlanDto,
  type MembershipPlanInput,
  type MembershipsOverview,
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
import {
  planAccessSummary,
  planCycleLabel,
  planHealth,
  planUsageLabel,
  operationalOverview,
  subscriptionActions,
} from "@/lib/membershipPlanSummary";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatCents(cents: number, currency = "usd") {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 0,
  }).format(cents / 100);
}

function OpenGymPanel({ studioId, template, plans, onSaved }: { studioId: string; template?: ClassTemplateDto; plans: MembershipPlanDto[]; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [start, setStart] = useState(template?.accessWindowStart ?? "");
  const [end, setEnd] = useState(template?.accessWindowEnd ?? "");
  const [saving, setSaving] = useState(false);
  useEffect(() => { setStart(template?.accessWindowStart ?? ""); setEnd(template?.accessWindowEnd ?? ""); }, [template]);
  if (!template) return null;
  const allowedPlans = plans.filter((plan) => plan.active && !plan.deletedAt && (plan.classAccess.allClasses || plan.classAccess.templates.some((entry) => entry.id === template.id)));
  async function saveWindow() {
    if (!template || !start || !end || start >= end) return;
    setSaving(true);
    try {
      await updateClassTemplate(studioId, template.id, { accessWindowStart: start, accessWindowEnd: end });
      setEditing(false);
      onSaved();
    } finally { setSaving(false); }
  }
  return (
    <div className="mb-10 rounded-xl border border-sky-200 bg-sky-50/50 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><p className="text-xs font-semibold uppercase tracking-widest text-sky-700">Open Gym</p><p className="mt-1 text-lg font-semibold text-zinc-900">Horario permitido: {template.accessWindowStart && template.accessWindowEnd ? `${template.accessWindowStart}–${template.accessWindowEnd}` : "sin configurar"}</p><p className="mt-1 text-sm text-zinc-600">Accesible por: {allowedPlans.map((plan) => plan.name).join(", ") || "ningún plan"}</p></div>
        <button onClick={() => setEditing((value) => !value)} className="rounded-lg border border-sky-200 bg-white px-3 py-2 text-xs font-semibold text-sky-800">{editing ? "Cerrar" : "Editar horario"}</button>
      </div>
      {editing ? <div className="mt-4 flex flex-wrap items-end gap-3"><label className="text-xs text-zinc-600">Inicio<input type="time" value={start} onChange={(event) => setStart(event.target.value)} className="mt-1 block rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm" /></label><label className="text-xs text-zinc-600">Fin<input type="time" value={end} onChange={(event) => setEnd(event.target.value)} className="mt-1 block rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm" /></label><button disabled={saving || !start || !end || start >= end} onClick={() => void saveWindow()} className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">{saving ? "Guardando…" : "Guardar horario"}</button></div> : null}
      <p className="mt-3 text-xs text-zinc-500">Usa la hora local del estudio. Los bypass de staff, instructor y administración conservan exactamente la lógica actual.</p>
    </div>
  );
}

function fmtDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const INTERVAL_LABELS: Record<BillingInterval, string> = {
  MONTHLY: "Mes",
  YEARLY: "Año",
  WEEKLY: "Semana",
};

const STATUS_LABELS: Record<SubscriptionStatus, string> = {
  ACTIVE: "Activa",
  TRIALING: "Prueba",
  PAST_DUE: "Pago pendiente",
  PAUSED: "Pausada",
  CANCELED: "Cancelada",
};

const STATUS_COLORS: Record<SubscriptionStatus, string> = {
  ACTIVE: "bg-emerald-100 text-emerald-800",
  TRIALING: "bg-sky-100 text-sky-800",
  PAST_DUE: "bg-amber-100 text-amber-800",
  PAUSED: "bg-zinc-100 text-zinc-600",
  CANCELED: "bg-red-100 text-red-700",
};

const LIFECYCLE_LABELS = {
  ...STATUS_LABELS,
  ENDING: "Por vencer",
  SCHEDULED: "Programada",
  EXPIRED: "Vencida",
} as const;

const LIFECYCLE_COLORS = {
  ...STATUS_COLORS,
  ENDING: "bg-amber-100 text-amber-800",
  SCHEDULED: "bg-sky-100 text-sky-800",
  EXPIRED: "bg-red-100 text-red-700",
} as const;

// ── Overview stats bar ────────────────────────────────────────────────────────

function OverviewBar({ data, unhealthyPlanCount }: { data: MembershipsOverview; unhealthyPlanCount: number }) {
  const summary = operationalOverview({ ...data, unhealthyPlanCount });

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 mb-8">
      {[
        { label: "Planes activos", value: summary.activePlans },
        { label: "Miembros activos", value: summary.activeMembers },
        { label: "Por vencer", value: summary.endingSoon },
        { label: "Requieren atención", value: summary.requiringAttention },
      ].map(({ label, value }) => (
        <div
          key={label}
          className="rounded-xl border border-zinc-200 bg-white px-5 py-4"
        >
          <p className="text-xs font-medium text-zinc-500">{label}</p>
          <p className="mt-1 text-2xl font-bold text-zinc-900">{value}</p>
        </div>
      ))}
    </div>
  );
}

// ── Plan card ─────────────────────────────────────────────────────────────────

function PlanCard({
  plan,
  integrity,
  integrityAvailable,
  onEdit,
  onArchive,
  onViewMembers,
  onManageAccess,
}: {
  plan: MembershipPlanDto;
  integrity?: PlanIntegrityResult;
  integrityAvailable: boolean;
  onEdit: (p: MembershipPlanDto) => void;
  onArchive: (p: MembershipPlanDto) => void;
  onViewMembers: (p: MembershipPlanDto) => void;
  onManageAccess: (p: MembershipPlanDto) => void;
}) {
  const archived = !!plan.deletedAt || !plan.active;
  const cycleLabel = planCycleLabel(plan);
  const usageLabel = planUsageLabel(plan);
  const access = planAccessSummary(plan);
  const health = planHealth(plan, integrity?.status);
  return (
    <div
      className={`relative rounded-xl border p-5 ${
        archived
          ? "border-zinc-200 bg-zinc-50 opacity-60"
          : "border-zinc-200 bg-white"
      }`}
    >
      {archived && (
        <span className="absolute right-3 top-3 rounded-full bg-zinc-200 px-2 py-0.5 text-xs font-medium text-zinc-600">
          Inactivo
        </span>
      )}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-zinc-900">
            {plan.name}
          </h3>
          <p className="mt-0.5 text-sm text-zinc-500">
            {formatCents(plan.priceCents, plan.currency)}
            {cycleLabel === null ? ` / ${INTERVAL_LABELS[plan.billingInterval].toLowerCase()}` : ""}
          </p>
          {cycleLabel !== null && (
            <p className="text-sm text-zinc-500">{cycleLabel}</p>
          )}
          <p className="mt-0.5 text-sm text-zinc-500">{usageLabel}</p>
          <p className="mt-1 text-xs text-zinc-500">
            Acceso: {access.label}
          </p>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-zinc-100 pt-3">
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${health.tone === "healthy" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>
          {health.label}
        </span>
        <span className="text-xs text-zinc-500">{plan.activeSubscriberCount} miembros activos</span>
      </div>

      {health.issues.length > 0 && (
        <div className="mt-2 space-y-1">
          {health.issues.slice(0, 2).map((w) => (
            <p
              key={w}
              className="rounded-lg bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-800"
            >
              ⚠ {w}
            </p>
          ))}
        </div>
      )}

      {plan.description && (
        <p className="mt-2 text-sm text-zinc-600 line-clamp-2">
          {plan.description}
        </p>
      )}

      <div className="mt-3 flex items-center gap-2 text-xs text-zinc-400">
        {integrity ? (
          integrity.status === "healthy" ? (
            <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-indigo-600">
              Stripe sincronizado ✓
            </span>
          ) : integrity.status === "price_mismatch" ? (
            <span
              className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-700"
              title={`GymOS: ${formatCents(integrity.localPriceCents, integrity.localCurrency)} / Stripe: ${formatCents(integrity.stripeUnitAmount ?? 0, integrity.stripeCurrency ?? integrity.localCurrency)}`}
            >
              Stripe desalineado ⚠
            </span>
          ) : integrity.status === "no_stripe_price" ? (
            <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-500">
              Sin Price de Stripe
            </span>
          ) : integrity.status === "inactive_stripe_price" ? (
            <span className="rounded bg-red-50 px-1.5 py-0.5 text-red-600">
              Price de Stripe inactivo
            </span>
          ) : (
            <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-700">
              {integrity.status.replace(/_/g, " ")} ⚠
            </span>
          )
        ) : !integrityAvailable ? (
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-400">
            Estado de Stripe no disponible
          </span>
        ) : null}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <button
          onClick={() => onEdit(plan)}
          className="flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
        >
          Editar plan
        </button>
        <button onClick={() => onManageAccess(plan)} className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50">
          Gestionar acceso
        </button>
        <button onClick={() => onViewMembers(plan)} className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50">
          Ver miembros
        </button>
        {!archived && (
          <button
            onClick={() => onArchive(plan)}
            className="flex-1 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
          >
            Archivar
          </button>
        )}
      </div>
    </div>
  );
}

// ── Plan modal ────────────────────────────────────────────────────────────────

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
            <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">
              Vinculación de cobro
            </p>
            <p className="text-[11px] text-zinc-500">
              Guardar aquí solo actualiza la configuración local de GymOS. Nunca crea, modifica
              ni sincroniza precios o productos en Stripe automáticamente.
            </p>
            {editing ? (
              <div className="grid grid-cols-2 gap-2 rounded-lg border border-zinc-200 bg-white p-3 text-xs">
                <div><p className="text-zinc-400">GymOS</p><p className="mt-1 font-semibold text-zinc-900">{formatCents(editing.priceCents, editing.currency)}</p></div>
                <div><p className="text-zinc-400">Stripe</p><p className="mt-1 font-semibold text-zinc-900">{integrity?.stripeUnitAmount == null ? "No disponible" : formatCents(integrity.stripeUnitAmount, integrity.stripeCurrency ?? editing.currency)}</p></div>
                <p className={`col-span-2 font-semibold ${integrity?.status === "healthy" ? "text-emerald-700" : "text-amber-700"}`}>Estado: {integrity?.status === "healthy" ? "Sincronizado" : "Revisar configuración"}</p>
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

// ── Subscriptions table ───────────────────────────────────────────────────────

function SubRow({
  sub,
  onAction,
  onCancelAtPeriodEnd,
}: {
  sub: SubscriptionListItem;
  onAction: (sub: SubscriptionListItem, status: SubscriptionStatus) => void;
  onCancelAtPeriodEnd: (sub: SubscriptionListItem, cancel: boolean) => void;
}) {
  const status = sub.status as SubscriptionStatus;
  const lifecycleStatus = sub.lifecycleStatus;
  const operationalStatus = lifecycleStatus === "ENDING" ? "ENDING" : sub.primaryStatus;
  const actions = subscriptionActions(sub);

  return (
    <tr className="border-b border-zinc-100 text-sm">
      <td className="px-4 py-3 font-medium text-zinc-900">
        <Link href={`/members/${sub.user.id}`} className="hover:underline">{sub.user.firstName} {sub.user.lastName}</Link>
        <p className="text-xs font-normal text-zinc-400">{sub.user.email}</p>
      </td>
      <td className="px-4 py-3 text-zinc-600">
        {sub.membershipPlan.name}
        <p className="text-xs text-zinc-400">
          {formatCents(sub.membershipPlan.priceCents, sub.membershipPlan.currency)} · {sub.membershipPlan.entitlementDays ? `${sub.membershipPlan.entitlementDays} días` : INTERVAL_LABELS[sub.membershipPlan.billingInterval].toLowerCase()}
        </p>
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-col gap-1">
          <span
            className={`inline-flex w-fit rounded-full px-2 py-0.5 text-xs font-semibold ${LIFECYCLE_COLORS[operationalStatus]}`}
          >
            {LIFECYCLE_LABELS[operationalStatus]}
          </span>
          <span className={`inline-flex w-fit rounded-full px-2 py-0.5 text-[11px] font-medium ${status === "PAST_DUE" ? "bg-amber-50 text-amber-800" : "bg-zinc-100 text-zinc-600"}`}>
            Pago: {status === "PAST_DUE" ? "Pendiente" : "Al corriente"}
          </span>
          {sub.source === "STRIPE" ? (
            <span className="inline-flex w-fit items-center gap-1 text-xs text-indigo-600">
              <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" />
              Stripe · {sub.cancelAtPeriodEnd ? "no renovará" : "renovación automática"}
            </span>
          ) : (
            <span className="inline-flex w-fit items-center gap-1 text-xs text-amber-600">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
              Renovación manual
            </span>
          )}
        </div>
      </td>
      <td className="px-4 py-3 text-zinc-500">
        {fmtDate(sub.effectiveEnd)}
        {sub.lifecycleStatus === "ENDING" && (
          <p className="mt-0.5 text-xs font-medium text-amber-500">
            Finaliza al cierre del periodo
          </p>
        )}
      </td>
      <td className="px-4 py-3 text-xs text-zinc-500">
        {sub.membershipPlan.classCredits === null ? "Ilimitado" : `${sub.membershipPlan.classCredits} créditos por ciclo`}
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-1.5">
          <Link href={`/members/${sub.user.id}`} className="rounded bg-zinc-100 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-200">Ver miembro</Link>
          {actions.includes("cancel_at_period_end") && (
            <button
              onClick={() => onCancelAtPeriodEnd(sub, true)}
              className="rounded px-2 py-1 text-xs bg-amber-50 text-amber-700 hover:bg-amber-100"
            >
              Cancelar al final
            </button>
          )}
          {actions.includes("reactivate_renewal") && (
            <button
              onClick={() => onCancelAtPeriodEnd(sub, false)}
              className="rounded px-2 py-1 text-xs bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
            >
              Reactivar renovación
            </button>
          )}
          {actions.includes("pause") && (
            <button
              onClick={() => onAction(sub, "PAUSED")}
              className="rounded px-2 py-1 text-xs bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
            >
              Pausar
            </button>
          )}
          {actions.includes("resume") && (
            <button
              onClick={() => onAction(sub, "ACTIVE")}
              className="rounded px-2 py-1 text-xs bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
            >
              Reanudar
            </button>
          )}
          {actions.includes("renew") ? <Link href={`/members/${sub.user.id}?tab=membership`} className="rounded bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">Renovar</Link> : null}
          {actions.includes("change_plan") ? <Link href={`/members/${sub.user.id}?tab=membership`} className="rounded bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-700">Cambiar plan</Link> : null}
          {actions.includes("record_cash_payment") ? <Link href={`/members/${sub.user.id}?tab=billing`} className="rounded bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800">Registrar efectivo</Link> : null}
        </div>
      </td>
    </tr>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

function DayPassAccessSection({ studioId }: { studioId: string }) {
  const [templates, setTemplates] = useState<DayPassClassAccessTemplateDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchDayPassClassAccess(studioId);
      setTemplates(data);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo cargar el acceso de Day Pass.");
    } finally {
      setLoading(false);
    }
  }, [studioId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(t: DayPassClassAccessTemplateDto) {
    setPendingId(t.id);
    setError(null);
    try {
      if (t.allowed) {
        await revokeDayPassClassAccess(studioId, t.id);
      } else {
        await grantDayPassClassAccess(studioId, t.id);
      }
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo actualizar el acceso.");
    } finally {
      setPendingId(null);
    }
  }

  const allowedCount = templates.filter((t) => t.allowed).length;
  const zeroAccess = !loading && templates.length > 0 && allowedCount === 0;

  return (
    <section id="day-pass" className="mb-10 scroll-mt-6">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-2 rounded-xl border border-zinc-200 bg-white px-5 py-4 text-left"
      >
        <div>
          <h2 className="text-lg font-semibold text-zinc-900">Acceso de Day Pass</h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            Lista explícita de clases reservables. Las clases nuevas se niegan hasta habilitarlas aquí.
            {!loading ? ` · ${allowedCount} de ${templates.length} permitidas` : ""}
          </p>
          {zeroAccess && (
            <p className="mt-1 text-xs font-semibold text-red-600">
              ⚠ Sin acceso — ningún Day Pass puede reservar ninguna clase ahora mismo.
            </p>
          )}
        </div>
        <span className="text-sm text-zinc-400">{expanded ? "Ocultar" : "Gestionar"}</span>
      </button>

      {expanded && (
        <div className="mt-2 rounded-xl border border-zinc-200 bg-white p-4">
          {error && (
            <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
          )}
          {loading ? (
            <p className="text-xs text-zinc-500">Cargando…</p>
          ) : templates.length === 0 ? (
            <p className="text-xs text-zinc-500">No hay plantillas de clase en este estudio.</p>
          ) : (
            <div className="divide-y divide-zinc-100">
              {templates.map((t) => (
                <label
                  key={t.id}
                  className="flex items-center justify-between gap-3 py-2 text-sm"
                >
                  <span className="flex items-center gap-2 text-zinc-700">
                    {t.name}
                    {t.isOpenGymSlot && (
                      <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-500">
                        Open Gym
                      </span>
                    )}
                  </span>
                  <input
                    type="checkbox"
                    checked={t.allowed}
                    disabled={pendingId === t.id}
                    onChange={() => void toggle(t)}
                    className="rounded"
                  />
                </label>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ClassAccessMatrix({
  plans,
  templates,
  dayPass,
  onManagePlan,
}: {
  plans: MembershipPlanDto[];
  templates: ClassTemplateDto[];
  dayPass: DayPassClassAccessTemplateDto[];
  onManagePlan: (plan: MembershipPlanDto) => void;
}) {
  const activePlans = plans.filter((plan) => plan.active && !plan.deletedAt);
  const dayPassById = new Map(dayPass.map((template) => [template.id, template.allowed]));
  return (
    <section id="acceso" className="mb-10 scroll-mt-6">
      <div className="mb-4">
        <p className="text-xs font-semibold uppercase tracking-widest text-zinc-400">Acceso y configuración</p>
        <h2 className="mt-1 text-lg font-semibold text-zinc-900">Matriz de acceso a clases</h2>
        <p className="mt-1 text-sm text-zinc-500">Fuente canónica: permisos explícitos por plantilla. Los cambios se realizan de uno en uno desde el editor protegido.</p>
      </div>
      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-zinc-200 bg-zinc-50 text-xs text-zinc-500">
            <tr>
              <th className="sticky left-0 bg-zinc-50 px-4 py-3 font-semibold">Clase</th>
              {activePlans.map((plan) => <th key={plan.id} className="px-3 py-3 font-semibold"><button onClick={() => onManagePlan(plan)} className="hover:text-zinc-900">{plan.name}</button></th>)}
              <th className="px-3 py-3 font-semibold">Day Pass</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {templates.map((template) => {
              const entitled = activePlans.filter((plan) => plan.classAccess.allClasses || plan.classAccess.templates.some((allowed) => allowed.id === template.id));
              const orphan = entitled.length === 0 && !dayPassById.get(template.id);
              return (
                <tr key={template.id} className={orphan ? "bg-red-50/60" : ""}>
                  <td className="sticky left-0 bg-inherit px-4 py-3 font-medium text-zinc-800">
                    {template.name}
                    {template.isOpenGymSlot ? <span className="ml-2 block text-[11px] font-normal text-sky-700">Open Gym · {template.accessWindowStart && template.accessWindowEnd ? `${template.accessWindowStart}–${template.accessWindowEnd}` : "sin horario"}</span> : null}
                    {orphan ? <span className="mt-1 block text-[11px] font-semibold text-red-700">SIN ACCESO</span> : null}
                  </td>
                  {activePlans.map((plan) => {
                    const allowed = plan.classAccess.allClasses || plan.classAccess.templates.some((entry) => entry.id === template.id);
                    return <td key={plan.id} className="px-3 py-3 text-center"><span className={allowed ? "text-emerald-600" : "text-zinc-300"}>{allowed ? "✓" : "—"}</span></td>;
                  })}
                  <td className="px-3 py-3 text-center"><span className={dayPassById.get(template.id) ? "text-emerald-600" : "text-zinc-300"}>{dayPassById.get(template.id) ? "✓" : "—"}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function MembershipsPage() {
  const { selectedStudioId } = useDeskStudio();

  const [overview, setOverview] = useState<MembershipsOverview | null>(null);
  const [plans, setPlans] = useState<MembershipPlanDto[]>([]);
  const [classTemplates, setClassTemplates] = useState<ClassTemplateDto[]>([]);
  const [dayPassTemplates, setDayPassTemplates] = useState<DayPassClassAccessTemplateDto[]>([]);
  const [planIntegrity, setPlanIntegrity] = useState<Map<string, PlanIntegrityResult>>(new Map());
  const [integrityAvailable, setIntegrityAvailable] = useState(true);
  const [subs, setSubs] = useState<SubscriptionListItem[]>([]);
  const [subsTotal, setSubsTotal] = useState(0);
  const [subsPage, setSubsPage] = useState(1);

  const [loadingPlans, setLoadingPlans] = useState(true);
  const [loadingSubs, setLoadingSubs] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showInactive, setShowInactive] = useState(false);
  const [statusFilter, setStatusFilter] = useState<SubscriptionStatus | "">("");
  const [planFilter, setPlanFilter] = useState<string>("");

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
        setIntegrityAvailable(true);
      } else {
        setPlanIntegrity(new Map());
        setIntegrityAvailable(false);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load plans.");
    } finally {
      setLoadingPlans(false);
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
        status: statusFilter || undefined,
        planId: planFilter || undefined,
        page,
        limit: SUBS_LIMIT,
      });
      setSubs(res.data);
      setSubsTotal(res.total);
      setSubsPage(res.page);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load subscriptions.");
    } finally {
      setLoadingSubs(false);
    }
  }, [selectedStudioId, statusFilter, planFilter]);

  useEffect(() => {
    const t = setTimeout(() => { void loadPlans(); void loadOverview(); }, 0);
    return () => clearTimeout(t);
  }, [loadPlans, loadOverview]);

  useEffect(() => {
    const t = setTimeout(() => void loadSubs(1), 0);
    return () => clearTimeout(t);
  }, [loadSubs]);

  async function handleSubAction(sub: SubscriptionListItem, newStatus: SubscriptionStatus) {
    if (!selectedStudioId) return;
    try {
      await updateSubscriptionStatus(
        selectedStudioId,
        sub.user.id,
        sub.id,
        newStatus,
      );
      void loadSubs(subsPage);
      void loadOverview();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Action failed.");
    }
  }

  async function handleCancelAtPeriodEnd(sub: SubscriptionListItem, cancel: boolean) {
    if (!selectedStudioId) return;
    try {
      await setCancelAtPeriodEnd(selectedStudioId, sub.user.id, sub.id, cancel);
      void loadSubs(subsPage);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Action failed.");
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

  const visiblePlans = showInactive
    ? plans
    : plans.filter((p) => p.active && !p.deletedAt);

  const totalSubPages = Math.ceil(subsTotal / SUBS_LIMIT);
  const unhealthyPlanCount = useMemo(
    () => plans.filter((plan) => plan.active && !plan.deletedAt && planHealth(plan, planIntegrity.get(plan.id)?.status).tone === "warning").length,
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
      {/* Page header */}
      <div className="mb-8 flex items-center justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-zinc-400">Operaciones</p>
          <h1 className="mt-1 text-2xl font-bold text-zinc-900">Centro de membresías</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Configura planes, accesos y suscripciones desde una sola superficie segura.
          </p>
        </div>
        <button
          onClick={() => { setEditingPlan(null); setShowPlanModal(true); }}
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-700"
        >
          + Nuevo plan
        </button>
      </div>

      {error && (
        <div className="mb-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
          <button onClick={() => setError(null)} className="ml-3 underline">Cerrar</button>
        </div>
      )}

      <nav className="mb-6 flex gap-1 overflow-x-auto rounded-xl border border-zinc-200 bg-white p-1 text-sm">
        {[{ href: "#planes", label: "Planes" }, { href: "#suscripciones", label: "Suscripciones" }, { href: "#acceso", label: "Acceso a clases" }, { href: "#day-pass", label: "Day Pass" }].map((item) => (
          <a key={item.href} href={item.href} className="whitespace-nowrap rounded-lg px-3 py-2 font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900">{item.label}</a>
        ))}
      </nav>

      {overview && <OverviewBar data={overview} unhealthyPlanCount={unhealthyPlanCount} />}

      {/* Plans section */}
      <section id="planes" className="mb-10 scroll-mt-6">
        <div className="mb-4 flex items-center justify-between">
          <div><p className="text-xs font-semibold uppercase tracking-widest text-zinc-400">Planes</p><h2 className="mt-1 text-lg font-semibold text-zinc-900">Catálogo y configuración</h2></div>
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
              <div key={i} className="h-48 rounded-xl bg-zinc-100 animate-pulse" />
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
                integrityAvailable={integrityAvailable}
                onEdit={(p) => { setEditingPlan(p); setShowPlanModal(true); }}
                onArchive={handleArchivePlan}
                onViewMembers={(p) => { setPlanFilter(p.id); document.getElementById("suscripciones")?.scrollIntoView({ behavior: "smooth" }); }}
                onManageAccess={(p) => { setEditingPlan(p); setShowPlanModal(true); }}
              />
            ))}
          </div>
        )}
      </section>

      <ClassAccessMatrix plans={plans} templates={classTemplates} dayPass={dayPassTemplates} onManagePlan={(p) => { setEditingPlan(p); setShowPlanModal(true); }} />
      <OpenGymPanel studioId={selectedStudioId} template={classTemplates.find((template) => template.isOpenGymSlot)} plans={plans} onSaved={() => void loadPlans()} />

      <DayPassAccessSection studioId={selectedStudioId} />

      {/* Subscriptions section */}
      <section id="suscripciones" className="scroll-mt-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-zinc-900">
            Suscripciones
            {subsTotal > 0 && (
              <span className="ml-2 text-sm font-normal text-zinc-400">
                ({subsTotal})
              </span>
            )}
          </h2>

          <div className="flex flex-wrap gap-2">
            <select
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value as SubscriptionStatus | ""); }}
              className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm"
            >
              <option value="">Todos los estados</option>
              {(Object.keys(STATUS_LABELS) as SubscriptionStatus[]).map((s) => (
                <option key={s} value={s}>{STATUS_LABELS[s]}</option>
              ))}
            </select>

            <select
              value={planFilter}
              onChange={(e) => setPlanFilter(e.target.value)}
              className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm"
            >
              <option value="">Todos los planes</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        </div>

        <p className="mb-3 text-xs text-zinc-400">
          El precio y la fuente de facturación no confirman que el pago del periodo ya esté registrado. Consulta Analytics para ver ingresos cobrados.
        </p>

        <div className="overflow-x-auto rounded-xl border border-zinc-200">
          <table className="w-full min-w-[640px] text-left">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-xs font-semibold uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-3">Miembro</th>
                <th className="px-4 py-3">Plan</th>
                <th className="px-4 py-3">Estado / pago</th>
                <th className="px-4 py-3">Vigencia</th>
                <th className="px-4 py-3">Uso</th>
                <th className="px-4 py-3">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 bg-white">
              {loadingSubs
                ? [...Array(5)].map((_, i) => (
                    <tr key={i} className="border-b border-zinc-100">
                      {[...Array(6)].map((__, j) => (
                        <td key={j} className="px-4 py-3">
                          <div className="h-4 rounded bg-zinc-200 animate-pulse" />
                        </td>
                      ))}
                    </tr>
                  ))
                : subs.length === 0
                ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-12 text-center text-sm text-zinc-400">
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

        {totalSubPages > 1 && (
          <div className="mt-4 flex items-center justify-between text-sm text-zinc-500">
            <span>
              Página {subsPage} de {totalSubPages}
            </span>
            <div className="flex gap-2">
              <button
                disabled={subsPage <= 1}
                onClick={() => void loadSubs(subsPage - 1)}
                className="rounded-lg border border-zinc-200 px-3 py-1.5 hover:bg-zinc-50 disabled:opacity-40"
              >
                ← Anterior
              </button>
              <button
                disabled={subsPage >= totalSubPages}
                onClick={() => void loadSubs(subsPage + 1)}
                className="rounded-lg border border-zinc-200 px-3 py-1.5 hover:bg-zinc-50 disabled:opacity-40"
              >
                Siguiente →
              </button>
            </div>
          </div>
        )}
      </section>

      {showPlanModal && selectedStudioId && (
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
      )}
    </div>
  );
}
