"use client";

import { useCallback, useEffect, useState } from "react";

import { useDeskStudio } from "@/contexts/DeskStudioContext";
import { ApiError } from "@/lib/api/errors";
import {
  archiveMembershipPlan,
  createMembershipPlan,
  fetchMembershipPlans,
  fetchMembershipsOverview,
  fetchSubscriptions,
  setCancelAtPeriodEnd,
  updateMembershipPlan,
  updateSubscriptionStatus,
  type BillingInterval,
  type MembershipPlanDto,
  type MembershipPlanInput,
  type MembershipsOverview,
  type SubscriptionListItem,
  type SubscriptionStatus,
} from "@/lib/api/memberships";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatCents(cents: number, currency = "usd") {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 0,
  }).format(cents / 100);
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
  MONTHLY: "Monthly",
  YEARLY: "Yearly",
  WEEKLY: "Weekly",
};

const STATUS_LABELS: Record<SubscriptionStatus, string> = {
  ACTIVE: "Active",
  TRIALING: "Trialing",
  PAST_DUE: "Past due",
  PAUSED: "Paused",
  CANCELED: "Canceled",
};

const STATUS_COLORS: Record<SubscriptionStatus, string> = {
  ACTIVE: "bg-emerald-100 text-emerald-800",
  TRIALING: "bg-sky-100 text-sky-800",
  PAST_DUE: "bg-amber-100 text-amber-800",
  PAUSED: "bg-zinc-100 text-zinc-600",
  CANCELED: "bg-red-100 text-red-700",
};

// ── Overview stats bar ────────────────────────────────────────────────────────

function OverviewBar({ data }: { data: MembershipsOverview }) {
  const active = data.byStatus["ACTIVE"] ?? 0;
  const trialing = data.byStatus["TRIALING"] ?? 0;
  const pastDue = data.byStatus["PAST_DUE"] ?? 0;
  const paused = data.byStatus["PAUSED"] ?? 0;

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 mb-8">
      {[
        { label: "Active Plans", value: data.totalActivePlans },
        { label: "Active Members", value: active + trialing },
        { label: "Past Due / Paused", value: pastDue + paused },
        {
          label: "Est. MRR",
          value: formatCents(data.totalMrrCents),
        },
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
  onEdit,
  onArchive,
}: {
  plan: MembershipPlanDto;
  onEdit: (p: MembershipPlanDto) => void;
  onArchive: (p: MembershipPlanDto) => void;
}) {
  const archived = !!plan.deletedAt || !plan.active;
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
          Inactive
        </span>
      )}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-zinc-900">
            {plan.name}
          </h3>
          <p className="mt-0.5 text-sm text-zinc-500">
            {formatCents(plan.priceCents, plan.currency)} /{" "}
            {INTERVAL_LABELS[plan.billingInterval].toLowerCase()}
            {plan.classCredits === null
              ? " · Unlimited credits"
              : plan.classCredits === 0
              ? ""
              : ` · ${plan.classCredits} class credits`}
          </p>
        </div>
      </div>

      {plan.description && (
        <p className="mt-2 text-sm text-zinc-600 line-clamp-2">
          {plan.description}
        </p>
      )}

      <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <p className="text-xs text-zinc-400">Subscribers</p>
          <p className="font-semibold text-zinc-900">
            {plan.activeSubscriberCount}
          </p>
        </div>
        <div>
          <p className="text-xs text-zinc-400">MRR</p>
          <p className="font-semibold text-zinc-900">
            {formatCents(plan.mrrCents, plan.currency)}
          </p>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2 text-xs text-zinc-400">
        {plan.stripeProductId ? (
          <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-indigo-600">
            Stripe synced
          </span>
        ) : (
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-500">
            No Stripe ID
          </span>
        )}
      </div>

      <div className="mt-4 flex gap-2">
        <button
          onClick={() => onEdit(plan)}
          className="flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
        >
          Edit
        </button>
        {!archived && (
          <button
            onClick={() => onArchive(plan)}
            className="flex-1 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
          >
            Archive
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
  stripeProductId: string;
  stripePriceId: string;
  active: boolean;
};

const emptyForm = (): PlanFormState => ({
  name: "",
  description: "",
  priceCents: "",
  currency: "usd",
  billingInterval: "MONTHLY",
  classCredits: "",
  unlimitedCredits: true,
  stripeProductId: "",
  stripePriceId: "",
  active: true,
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
    stripeProductId: p.stripeProductId ?? "",
    stripePriceId: p.stripePriceId ?? "",
    active: p.active,
  };
}

function PlanModal({
  editing,
  onClose,
  onSaved,
  studioId,
}: {
  editing: MembershipPlanDto | null;
  onClose: () => void;
  onSaved: () => void;
  studioId: string;
}) {
  const [form, setForm] = useState<PlanFormState>(() =>
    editing ? planToForm(editing) : emptyForm()
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof PlanFormState>(key: K, val: PlanFormState[K]) {
    setForm((f) => ({ ...f, [key]: val }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const cents = Math.round(parseFloat(form.priceCents) * 100);
    if (isNaN(cents) || cents < 0) {
      setError("Enter a valid price.");
      return;
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
      stripeProductId: form.stripeProductId.trim() || null,
      stripePriceId: form.stripePriceId.trim() || null,
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
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-200 px-6 py-4">
          <h2 className="text-base font-semibold text-zinc-900">
            {editing ? "Edit Plan" : "New Membership Plan"}
          </h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
          >
            ✕
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="px-6 py-5 space-y-4 overflow-y-auto max-h-[70vh]">
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-600">
              Plan name *
            </label>
            <input
              required
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-900"
              placeholder="e.g. Monthly Unlimited"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-600">
              Description
            </label>
            <textarea
              rows={2}
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-900"
              placeholder="What's included…"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-600">
                Price *
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
                Currency
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
              Billing interval
            </label>
            <select
              value={form.billingInterval}
              onChange={(e) => set("billingInterval", e.target.value as BillingInterval)}
              className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm"
            >
              <option value="MONTHLY">Monthly</option>
              <option value="YEARLY">Yearly</option>
              <option value="WEEKLY">Weekly</option>
            </select>
          </div>

          <div>
            <label className="mb-1 flex items-center gap-2 text-xs font-medium text-zinc-600">
              <input
                type="checkbox"
                checked={form.unlimitedCredits}
                onChange={(e) => set("unlimitedCredits", e.target.checked)}
                className="rounded"
              />
              Unlimited class credits
            </label>
            {!form.unlimitedCredits && (
              <input
                type="number"
                min="0"
                value={form.classCredits}
                onChange={(e) => set("classCredits", e.target.value)}
                className="mt-1 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm"
                placeholder="Number of classes per period"
              />
            )}
          </div>

          <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 space-y-3">
            <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">
              Stripe IDs (optional — automation coming soon)
            </p>
            <div>
              <label className="mb-1 block text-xs text-zinc-500">Stripe Product ID</label>
              <input
                value={form.stripeProductId}
                onChange={(e) => set("stripeProductId", e.target.value)}
                className="w-full rounded border border-zinc-200 bg-white px-2 py-1.5 text-xs font-mono"
                placeholder="prod_…"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-500">Stripe Price ID</label>
              <input
                value={form.stripePriceId}
                onChange={(e) => set("stripePriceId", e.target.value)}
                className="w-full rounded border border-zinc-200 bg-white px-2 py-1.5 text-xs font-mono"
                placeholder="price_…"
              />
            </div>
          </div>

          {editing && (
            <label className="flex items-center gap-2 text-sm text-zinc-700">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => set("active", e.target.checked)}
                className="rounded"
              />
              Plan is active (visible to members)
            </label>
          )}

          {error && (
            <p className="text-sm text-red-600">{error}</p>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-700 disabled:opacity-50"
            >
              {saving ? "Saving…" : editing ? "Save changes" : "Create plan"}
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
  const isStripeLinked = !!sub.stripeSubscriptionId;

  return (
    <tr className="border-b border-zinc-100 text-sm">
      <td className="px-4 py-3 font-medium text-zinc-900">
        {sub.user.firstName} {sub.user.lastName}
        <p className="text-xs font-normal text-zinc-400">{sub.user.email}</p>
      </td>
      <td className="px-4 py-3 text-zinc-600">
        {sub.membershipPlan.name}
        <p className="text-xs text-zinc-400">
          {formatCents(sub.membershipPlan.priceCents, sub.membershipPlan.currency)} /{" "}
          {INTERVAL_LABELS[sub.membershipPlan.billingInterval].toLowerCase()}
        </p>
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-col gap-1">
          <span
            className={`inline-flex w-fit rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_COLORS[status]}`}
          >
            {STATUS_LABELS[status]}
          </span>
          {isStripeLinked ? (
            <span className="inline-flex w-fit items-center gap-1 text-xs text-indigo-600">
              <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" />
              Stripe
            </span>
          ) : (
            <span className="inline-flex w-fit items-center gap-1 text-xs text-amber-600">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
              Manual
            </span>
          )}
        </div>
      </td>
      <td className="px-4 py-3 text-zinc-500">
        {fmtDate(sub.currentPeriodEnd)}
        {sub.cancelAtPeriodEnd && (
          <p className="mt-0.5 text-xs font-medium text-amber-500">
            Cancels at period end
          </p>
        )}
      </td>
      <td className="px-4 py-3 text-xs text-zinc-400">
        {fmtDate(sub.createdAt)}
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-1.5">
          {status === "ACTIVE" && !sub.cancelAtPeriodEnd && (
            <button
              onClick={() => onCancelAtPeriodEnd(sub, true)}
              className="rounded px-2 py-1 text-xs bg-amber-50 text-amber-700 hover:bg-amber-100"
            >
              Cancel at period end
            </button>
          )}
          {status === "ACTIVE" && sub.cancelAtPeriodEnd && (
            <button
              onClick={() => onCancelAtPeriodEnd(sub, false)}
              className="rounded px-2 py-1 text-xs bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
            >
              Keep active
            </button>
          )}
          {status === "ACTIVE" && (
            <button
              onClick={() => onAction(sub, "PAUSED")}
              className="rounded px-2 py-1 text-xs bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
            >
              Pause
            </button>
          )}
          {status === "ACTIVE" && (
            <button
              onClick={() => onAction(sub, "CANCELED")}
              className="rounded px-2 py-1 text-xs bg-red-50 text-red-600 hover:bg-red-100"
            >
              Cancel now
            </button>
          )}
          {(status === "PAUSED" || status === "PAST_DUE") && (
            <button
              onClick={() => onAction(sub, "ACTIVE")}
              className="rounded px-2 py-1 text-xs bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
            >
              Reactivate
            </button>
          )}
          {status === "CANCELED" && (
            <button
              onClick={() => onAction(sub, "ACTIVE")}
              className="rounded px-2 py-1 text-xs bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
            >
              Reactivate manually
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function MembershipsPage() {
  const { selectedStudioId } = useDeskStudio();

  const [overview, setOverview] = useState<MembershipsOverview | null>(null);
  const [plans, setPlans] = useState<MembershipPlanDto[]>([]);
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
      const data = await fetchMembershipPlans(selectedStudioId, true);
      setPlans(data);
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
    if (!confirm(`Archive "${plan.name}"? Members with active subscriptions won't be affected.`)) return;
    try {
      await archiveMembershipPlan(selectedStudioId, plan.id);
      void loadPlans();
      void loadOverview();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Archive failed.");
    }
  }

  const visiblePlans = showInactive
    ? plans
    : plans.filter((p) => p.active && !p.deletedAt);

  const totalSubPages = Math.ceil(subsTotal / SUBS_LIMIT);

  if (!selectedStudioId) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <p className="text-sm text-zinc-500">Select a studio to manage memberships.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      {/* Page header */}
      <div className="mb-8 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900">Memberships</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Manage plans and member subscriptions.
          </p>
        </div>
        <button
          onClick={() => { setEditingPlan(null); setShowPlanModal(true); }}
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-700"
        >
          + New plan
        </button>
      </div>

      {error && (
        <div className="mb-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
          <button onClick={() => setError(null)} className="ml-3 underline">Dismiss</button>
        </div>
      )}

      {/* Overview stats */}
      {overview && <OverviewBar data={overview} />}

      {/* Plans section */}
      <section className="mb-10">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-zinc-900">Plans</h2>
          <label className="flex items-center gap-2 text-sm text-zinc-500">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="rounded"
            />
            Show inactive
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
            <p className="text-sm text-zinc-500">No plans yet. Create one to get started.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {visiblePlans.map((plan) => (
              <PlanCard
                key={plan.id}
                plan={plan}
                onEdit={(p) => { setEditingPlan(p); setShowPlanModal(true); }}
                onArchive={handleArchivePlan}
              />
            ))}
          </div>
        )}
      </section>

      {/* Subscriptions section */}
      <section>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-zinc-900">
            Subscriptions
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
              <option value="">All statuses</option>
              {(Object.keys(STATUS_LABELS) as SubscriptionStatus[]).map((s) => (
                <option key={s} value={s}>{STATUS_LABELS[s]}</option>
              ))}
            </select>

            <select
              value={planFilter}
              onChange={(e) => setPlanFilter(e.target.value)}
              className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm"
            >
              <option value="">All plans</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="overflow-x-auto rounded-xl border border-zinc-200">
          <table className="w-full min-w-[640px] text-left">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-xs font-semibold uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-3">Member</th>
                <th className="px-4 py-3">Plan</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Period ends</th>
                <th className="px-4 py-3">Since</th>
                <th className="px-4 py-3">Actions</th>
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
                        No subscriptions found.
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
              Page {subsPage} of {totalSubPages}
            </span>
            <div className="flex gap-2">
              <button
                disabled={subsPage <= 1}
                onClick={() => void loadSubs(subsPage - 1)}
                className="rounded-lg border border-zinc-200 px-3 py-1.5 hover:bg-zinc-50 disabled:opacity-40"
              >
                ← Prev
              </button>
              <button
                disabled={subsPage >= totalSubPages}
                onClick={() => void loadSubs(subsPage + 1)}
                className="rounded-lg border border-zinc-200 px-3 py-1.5 hover:bg-zinc-50 disabled:opacity-40"
              >
                Next →
              </button>
            </div>
          </div>
        )}
      </section>

      {showPlanModal && selectedStudioId && (
        <PlanModal
          editing={editingPlan}
          studioId={selectedStudioId}
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
