"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import type {
  BillingInterval,
  MembershipPlanDto,
  MembershipsOverview,
  PlanConfigurationHistoryEntry,
  PlanIntegrityResult,
  SubscriptionListItem,
  SubscriptionStatus,
} from "@/lib/api/memberships";
import type { ClassTemplateDto } from "@/lib/api/classTemplates";
import type { DayPassClassAccessTemplateDto } from "@/lib/api/dayPassClassAccess";
import {
  dayPassHealthLabel,
  integrityIssueLabel,
  operationalOverview,
  planCardLines,
  planCycleLabel,
  planHealth,
  formatHistoryEntry,
  subscriptionActionLabel,
  subscriptionActions,
  subscriptionOperationalStatusLabel,
  subscriptionPaymentSourceLabel,
  subscriptionValidityLines,
  type SubscriptionAction,
} from "@/lib/membershipPlanSummary";

export type MembershipTab = "planes" | "suscripciones" | "acceso" | "day-pass";

export function formatCents(cents: number, currency = "usd") {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 0,
  }).format(cents / 100);
}

const INTERVAL_LABELS: Record<BillingInterval, string> = {
  MONTHLY: "mes",
  YEARLY: "año",
  WEEKLY: "semana",
};

const LIFECYCLE_COLORS: Record<string, string> = {
  ACTIVE: "bg-emerald-100 text-emerald-800",
  TRIALING: "bg-sky-100 text-sky-800",
  ENDING: "bg-amber-100 text-amber-800",
  PAST_DUE: "bg-amber-100 text-amber-800",
  PAUSED: "bg-zinc-100 text-zinc-600",
  EXPIRED: "bg-red-100 text-red-700",
  SCHEDULED: "bg-sky-100 text-sky-800",
  CANCELED: "bg-red-100 text-red-700",
};

function fmtDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("es-MX", {
    day: "numeric",
    month: "short",
  });
}

function OverflowMenu({
  items,
}: {
  items: Array<{ label: string; onClick?: () => void; href?: string; danger?: boolean }>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-50"
        aria-label="Más acciones"
      >
        •••
      </button>
      {open ? (
        <div className="absolute right-0 z-20 mt-1 min-w-[11rem] rounded-lg border border-zinc-200 bg-white py-1 shadow-lg">
          {items.map((item) =>
            item.href ? (
              <Link
                key={item.label}
                href={item.href}
                className={`block px-3 py-2 text-sm hover:bg-zinc-50 ${item.danger ? "text-red-600" : "text-zinc-700"}`}
                onClick={() => setOpen(false)}
              >
                {item.label}
              </Link>
            ) : (
              <button
                key={item.label}
                type="button"
                onClick={() => {
                  item.onClick?.();
                  setOpen(false);
                }}
                className={`block w-full px-3 py-2 text-left text-sm hover:bg-zinc-50 ${item.danger ? "text-red-600" : "text-zinc-700"}`}
              >
                {item.label}
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

export function TabNav({
  activeTab,
  onChange,
}: {
  activeTab: MembershipTab;
  onChange: (tab: MembershipTab) => void;
}) {
  const tabs: Array<{ id: MembershipTab; label: string }> = [
    { id: "planes", label: "Planes" },
    { id: "suscripciones", label: "Suscripciones" },
    { id: "acceso", label: "Acceso a clases" },
    { id: "day-pass", label: "Day Pass" },
  ];
  return (
    <nav className="mb-6 flex gap-1 overflow-x-auto rounded-xl border border-zinc-200 bg-white p-1 text-sm">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={`whitespace-nowrap rounded-lg px-3 py-2 font-medium transition-colors ${
            activeTab === tab.id
              ? "bg-zinc-900 text-white"
              : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}

export function OverviewBar({
  data,
  unhealthyPlanCount,
  onExpiringClick,
  onAttentionClick,
}: {
  data: MembershipsOverview;
  unhealthyPlanCount: number;
  onExpiringClick?: () => void;
  onAttentionClick?: () => void;
}) {
  const summary = operationalOverview({ ...data, unhealthyPlanCount });
  const tiles = [
    { label: "Planes activos", value: summary.activePlans, onClick: undefined },
    { label: "Miembros activos", value: summary.activeMembers, onClick: undefined },
    { label: "Vencen en 7 días", value: summary.expiringWithin7Days, onClick: onExpiringClick },
    { label: "Requieren atención", value: summary.requiringAttention, onClick: onAttentionClick },
  ];

  return (
    <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
      {tiles.map(({ label, value, onClick }) => {
        const inner = (
          <>
            <p className="text-xs font-medium text-zinc-500">{label}</p>
            <p className="mt-1 text-2xl font-bold text-zinc-900">{value}</p>
          </>
        );
        if (onClick) {
          return (
            <button
              key={label}
              type="button"
              onClick={onClick}
              className="rounded-xl border border-zinc-200 bg-white px-5 py-4 text-left transition-colors hover:border-zinc-300 hover:bg-zinc-50"
            >
              {inner}
            </button>
          );
        }
        return (
          <div key={label} className="rounded-xl border border-zinc-200 bg-white px-5 py-4">
            {inner}
          </div>
        );
      })}
    </div>
  );
}

export function PlanCard({
  plan,
  integrity,
  onEdit,
  onArchive,
  onViewMembers,
  onManageAccess,
  onToggleActive,
}: {
  plan: MembershipPlanDto;
  integrity?: PlanIntegrityResult;
  onEdit: (p: MembershipPlanDto) => void;
  onArchive: (p: MembershipPlanDto) => void;
  onViewMembers: (p: MembershipPlanDto) => void;
  onManageAccess: (p: MembershipPlanDto) => void;
  onToggleActive: (p: MembershipPlanDto) => void;
}) {
  const [showIssues, setShowIssues] = useState(false);
  const archived = !!plan.deletedAt || !plan.active;
  const cycleLabel = planCycleLabel(plan);
  const lines = planCardLines(plan);
  const health = planHealth(plan, integrity?.status);

  return (
    <div
      className={`relative flex flex-col rounded-xl border p-5 ${
        archived ? "border-zinc-200 bg-zinc-50 opacity-70" : "border-zinc-200 bg-white"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold text-zinc-900">{plan.name}</h3>
          <p className="mt-1 text-lg font-semibold text-zinc-900">
            {formatCents(plan.priceCents, plan.currency)}
            {cycleLabel === null ? (
              <span className="text-sm font-normal text-zinc-500"> / {INTERVAL_LABELS[plan.billingInterval]}</span>
            ) : null}
          </p>
          {cycleLabel ? <p className="text-sm text-zinc-500">{cycleLabel}</p> : null}
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
            health.tone === "healthy" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"
          }`}
        >
          {health.label}
        </span>
      </div>

      <div className="mt-3 space-y-0.5 text-sm text-zinc-600">
        <p>{lines.usageLine}</p>
        <p>{lines.accessLine}</p>
        {lines.scheduleLine ? <p className="text-zinc-500">{lines.scheduleLine}</p> : null}
      </div>

      <p className="mt-3 text-sm font-medium text-zinc-700">
        {plan.activeSubscriberCount}{" "}
        {plan.activeSubscriberCount === 1 ? "miembro activo" : "miembros activos"}
      </p>

      {health.primaryIssue ? (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowIssues((v) => !v)}
            className="w-full rounded-lg bg-amber-50 px-3 py-2 text-left text-xs text-amber-900"
          >
            <span className="font-semibold">Requiere atención</span>
            <span className="mt-0.5 block">{health.primaryIssue}</span>
            {health.extraIssueCount > 0 ? (
              <span className="mt-1 block text-amber-700">
                {health.extraIssueCount + 1} problemas de configuración — {showIssues ? "ocultar" : "ver detalle"}
              </span>
            ) : null}
          </button>
          {showIssues && health.issues.length > 1 ? (
            <ul className="mt-2 space-y-1 rounded-lg border border-amber-100 bg-amber-50/50 px-3 py-2 text-xs text-amber-900">
              {health.issues.map((issue) => (
                <li key={issue}>• {issue}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {plan.description ? (
        <p className="mt-3 text-sm text-zinc-500 line-clamp-2">{plan.description}</p>
      ) : null}

      <div className="mt-auto flex items-center gap-2 pt-4">
        <button
          type="button"
          onClick={() => onEdit(plan)}
          className="flex-1 rounded-lg bg-zinc-900 px-3 py-2 text-xs font-semibold text-white hover:bg-zinc-700"
        >
          Editar plan
        </button>
        <button
          type="button"
          onClick={() => onViewMembers(plan)}
          className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
        >
          Ver miembros
        </button>
        <OverflowMenu
          items={[
            { label: "Gestionar acceso", onClick: () => onManageAccess(plan) },
            ...(!archived
              ? [{ label: plan.active ? "Desactivar" : "Activar", onClick: () => onToggleActive(plan) }]
              : []),
            ...(!archived ? [{ label: "Archivar", onClick: () => onArchive(plan), danger: true }] : []),
          ]}
        />
      </div>
    </div>
  );
}

export function PlanHistoryDisclosure({
  expanded,
  onToggle,
  children,
}: {
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold text-zinc-800"
        aria-expanded={expanded}
      >
        <span>Historial de cambios</span>
        <span className="text-zinc-400" aria-hidden>
          {expanded ? "⌄" : "›"}
        </span>
      </button>
      {expanded ? <div className="border-t border-zinc-200 px-4 py-3">{children}</div> : null}
    </div>
  );
}

export function PlanConfigurationHistoryPanel({
  entries,
  loading,
}: {
  entries: PlanConfigurationHistoryEntry[];
  loading: boolean;
}) {
  if (loading) return <p className="text-xs text-zinc-500">Cargando historial…</p>;
  if (entries.length === 0) return <p className="text-xs text-zinc-500">Sin cambios registrados aún.</p>;
  return (
    <div className="space-y-2">
      {entries.map((entry) => (
        <div key={entry.id} className="rounded-lg border border-zinc-100 bg-zinc-50 px-3 py-2 text-xs text-zinc-700">
          <p className="font-medium text-zinc-900">{formatHistoryEntry(entry)}</p>
          <p className="mt-0.5 text-zinc-500">
            {entry.actor.firstName} {entry.actor.lastName} ·{" "}
            {new Date(entry.createdAt).toLocaleDateString("es-MX", {
              day: "numeric",
              month: "short",
            })}{" "}
            ·{" "}
            {new Date(entry.createdAt).toLocaleTimeString("es-MX", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
        </div>
      ))}
    </div>
  );
}

export function SubRow({
  sub,
  onAction,
  onCancelAtPeriodEnd,
}: {
  sub: SubscriptionListItem;
  onAction: (sub: SubscriptionListItem, status: SubscriptionStatus) => void;
  onCancelAtPeriodEnd: (sub: SubscriptionListItem, cancel: boolean) => void;
}) {
  const operationalStatus = sub.lifecycleStatus === "ENDING" ? "ENDING" : sub.primaryStatus;
  const actions = subscriptionActions(sub).filter((a) => a !== "view_member");
  const validity = subscriptionValidityLines({
    lifecycleStatus: sub.lifecycleStatus,
    source: sub.source,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    effectiveEnd: sub.effectiveEnd,
    entitlementDays: sub.membershipPlan.entitlementDays,
    billingInterval: sub.membershipPlan.billingInterval,
  });

  const overflowItems: Array<{ label: string; onClick?: () => void; href?: string }> = [];
  for (const action of actions) {
    if (action === "cancel_at_period_end") {
      overflowItems.push({ label: subscriptionActionLabel(action), onClick: () => onCancelAtPeriodEnd(sub, true) });
    } else if (action === "reactivate_renewal") {
      overflowItems.push({ label: subscriptionActionLabel(action), onClick: () => onCancelAtPeriodEnd(sub, false) });
    } else if (action === "pause") {
      overflowItems.push({ label: subscriptionActionLabel(action), onClick: () => onAction(sub, "PAUSED") });
    } else if (action === "resume") {
      overflowItems.push({ label: subscriptionActionLabel(action), onClick: () => onAction(sub, "ACTIVE") });
    } else if (action === "renew") {
      overflowItems.push({ label: subscriptionActionLabel(action), href: `/members/${sub.user.id}?tab=membership` });
    } else if (action === "change_plan") {
      overflowItems.push({ label: subscriptionActionLabel(action), href: `/members/${sub.user.id}?tab=membership` });
    } else if (action === "record_cash_payment") {
      overflowItems.push({ label: subscriptionActionLabel(action), href: `/members/${sub.user.id}?tab=billing` });
    }
  }

  return (
    <tr className="border-b border-zinc-100 text-sm">
      <td className="px-4 py-3 font-medium text-zinc-900">
        <Link href={`/members/${sub.user.id}`} className="hover:underline">
          {sub.user.firstName} {sub.user.lastName}
        </Link>
        <p className="text-xs font-normal text-zinc-400">{sub.user.email}</p>
      </td>
      <td className="px-4 py-3 text-zinc-600">{sub.membershipPlan.name}</td>
      <td className="px-4 py-3">
        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${LIFECYCLE_COLORS[operationalStatus] ?? "bg-zinc-100 text-zinc-600"}`}>
          {subscriptionOperationalStatusLabel(operationalStatus)}
        </span>
      </td>
      <td className="px-4 py-3 text-zinc-600">{subscriptionPaymentSourceLabel(sub.source)}</td>
      <td className="px-4 py-3 text-zinc-600">
        <p>{validity.primary}</p>
        {validity.secondary ? <p className="text-xs text-zinc-400">{validity.secondary}</p> : null}
      </td>
      <td className="px-4 py-3 text-zinc-500">
        {sub.membershipPlan.classCredits === null
          ? "Ilimitado"
          : `${sub.membershipPlan.classCredits} créditos`}
      </td>
      <td className="px-4 py-3 text-zinc-500">{fmtDate(sub.effectiveEnd ?? sub.currentPeriodEnd)}</td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <Link
            href={`/members/${sub.user.id}`}
            className="rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Ver miembro
          </Link>
          {overflowItems.length > 0 ? <OverflowMenu items={overflowItems} /> : null}
        </div>
      </td>
    </tr>
  );
}

export function ClassAccessMatrix({
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
    <div>
      <div className="mb-4">
        <p className="text-xs font-semibold uppercase tracking-widest text-zinc-400">Acceso a clases</p>
        <h2 className="mt-1 text-lg font-semibold text-zinc-900">Matriz plan × clase</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Fuente canónica de permisos. Edita acceso desde el editor de cada plan.
        </p>
      </div>
      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-zinc-200 bg-zinc-50 text-xs text-zinc-500">
            <tr>
              <th className="sticky left-0 bg-zinc-50 px-4 py-3 font-semibold">Clase</th>
              {activePlans.map((plan) => (
                <th key={plan.id} className="px-3 py-3 font-semibold">
                  <button type="button" onClick={() => onManagePlan(plan)} className="hover:text-zinc-900">
                    {plan.name}
                  </button>
                </th>
              ))}
              <th className="px-3 py-3 font-semibold">Day Pass</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {templates.map((template) => {
              const entitled = activePlans.filter(
                (plan) =>
                  plan.classAccess.allClasses ||
                  plan.classAccess.templates.some((allowed) => allowed.id === template.id),
              );
              const orphan = entitled.length === 0 && !dayPassById.get(template.id);
              const isSpecial = template.isOpenGymSlot || template.name.toLowerCase().includes("booty");
              return (
                <tr
                  key={template.id}
                  className={orphan ? "bg-red-50/40" : isSpecial ? "bg-sky-50/30" : undefined}
                >
                  <td className="sticky left-0 bg-inherit px-4 py-3 font-medium text-zinc-800">
                    {template.name}
                    {template.isOpenGymSlot ? (
                      <span className="mt-0.5 block text-[11px] font-normal text-sky-700">
                        {template.accessWindowStart && template.accessWindowEnd
                          ? `${template.accessWindowStart}–${template.accessWindowEnd}`
                          : "sin horario"}
                      </span>
                    ) : null}
                    {orphan ? (
                      <span className="mt-1 block text-[11px] font-semibold text-red-700">SIN ACCESO</span>
                    ) : null}
                  </td>
                  {activePlans.map((plan) => {
                    const allowed =
                      plan.classAccess.allClasses ||
                      plan.classAccess.templates.some((entry) => entry.id === template.id);
                    return (
                      <td key={plan.id} className="px-3 py-3 text-center">
                        <span className={allowed ? "font-medium text-emerald-600" : "text-zinc-300"}>
                          {allowed ? "✓" : "—"}
                        </span>
                      </td>
                    );
                  })}
                  <td className="px-3 py-3 text-center">
                    <span className={dayPassById.get(template.id) ? "font-medium text-emerald-600" : "text-zinc-300"}>
                      {dayPassById.get(template.id) ? "✓" : "—"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function OpenGymPanel({
  studioId,
  template,
  plans,
  onSaved,
  onUpdateTemplate,
}: {
  studioId: string;
  template?: ClassTemplateDto;
  plans: MembershipPlanDto[];
  onSaved: () => void;
  onUpdateTemplate: (
    studioId: string,
    templateId: string,
    data: { accessWindowStart: string; accessWindowEnd: string },
  ) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [start, setStart] = useState(template?.accessWindowStart ?? "");
  const [end, setEnd] = useState(template?.accessWindowEnd ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setStart(template?.accessWindowStart ?? "");
    setEnd(template?.accessWindowEnd ?? "");
  }, [template]);

  if (!template) return null;

  const allowedPlans = plans.filter(
    (plan) =>
      plan.active &&
      !plan.deletedAt &&
      (plan.classAccess.allClasses ||
        plan.classAccess.templates.some((entry) => entry.id === template.id)),
  );

  async function saveWindow() {
    if (!template || !start || !end || start >= end) return;
    setSaving(true);
    try {
      await onUpdateTemplate(studioId, template.id, {
        accessWindowStart: start,
        accessWindowEnd: end,
      });
      setEditing(false);
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-6 rounded-xl border border-sky-100 bg-sky-50/40 p-5">
      <p className="text-xs font-semibold uppercase tracking-widest text-sky-700">Open Gym</p>
      <p className="mt-1 text-base font-semibold text-zinc-900">
        Horario permitido{" "}
        {template.accessWindowStart && template.accessWindowEnd
          ? `${template.accessWindowStart}–${template.accessWindowEnd}`
          : "sin configurar"}
      </p>
      <p className="mt-1 text-sm text-zinc-600">
        Acceso: {allowedPlans.map((plan) => plan.name).join(", ") || "ningún plan"}
      </p>
      <p className="mt-1 text-xs text-zinc-500">Horario en zona local del estudio</p>
      <button
        type="button"
        onClick={() => setEditing((value) => !value)}
        className="mt-3 rounded-lg border border-sky-200 bg-white px-3 py-2 text-xs font-semibold text-sky-800"
      >
        {editing ? "Cerrar" : "Editar horario"}
      </button>
      {editing ? (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="text-xs text-zinc-600">
            Inicio
            <input
              type="time"
              value={start}
              onChange={(event) => setStart(event.target.value)}
              className="mt-1 block rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm"
            />
          </label>
          <label className="text-xs text-zinc-600">
            Fin
            <input
              type="time"
              value={end}
              onChange={(event) => setEnd(event.target.value)}
              className="mt-1 block rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm"
            />
          </label>
          <button
            type="button"
            disabled={saving || !start || !end || start >= end}
            onClick={() => void saveWindow()}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            {saving ? "Guardando…" : "Guardar horario"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function DayPassTab({
  studioId,
  templates,
  onToggle,
  pendingId,
  loading,
  error,
}: {
  studioId: string;
  templates: DayPassClassAccessTemplateDto[];
  onToggle: (t: DayPassClassAccessTemplateDto) => void;
  pendingId: string | null;
  loading: boolean;
  error: string | null;
}) {
  void studioId;
  const allowed = templates.filter((t) => t.allowed);
  const denied = templates.filter((t) => !t.allowed);
  const health = dayPassHealthLabel(allowed.length, templates.length);

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-zinc-400">Day Pass</p>
          <h2 className="mt-1 text-lg font-semibold text-zinc-900">Acceso de Day Pass</h2>
          <p className="mt-1 text-sm text-zinc-500">
            {allowed.length} {allowed.length === 1 ? "clase permitida" : "clases permitidas"}
          </p>
        </div>
        <span
          className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase ${
            health.tone === "healthy" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"
          }`}
        >
          {health.label}
        </span>
      </div>

      {error ? (
        <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
      ) : null}

      {loading ? (
        <p className="text-sm text-zinc-500">Cargando…</p>
      ) : (
        <div className="grid gap-6 md:grid-cols-2">
          <div className="rounded-xl border border-zinc-200 bg-white p-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-emerald-700">Permitidas</p>
            <div className="space-y-2">
              {allowed.map((t) => (
                <label key={t.id} className="flex items-center justify-between gap-3 text-sm text-zinc-700">
                  <span>{t.name}</span>
                  <input
                    type="checkbox"
                    checked
                    disabled={pendingId === t.id}
                    onChange={() => onToggle(t)}
                    className="rounded"
                  />
                </label>
              ))}
              {allowed.length === 0 ? <p className="text-xs text-zinc-500">Ninguna</p> : null}
            </div>
          </div>
          <div className="rounded-xl border border-zinc-200 bg-white p-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">No permitidas</p>
            <div className="space-y-2">
              {denied.map((t) => (
                <label key={t.id} className="flex items-center justify-between gap-3 text-sm text-zinc-500">
                  <span>{t.name}</span>
                  <input
                    type="checkbox"
                    checked={false}
                    disabled={pendingId === t.id}
                    onChange={() => onToggle(t)}
                    className="rounded"
                  />
                </label>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export { integrityIssueLabel };
