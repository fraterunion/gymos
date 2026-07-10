"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useAuth } from "@/contexts/AuthContext";
import { useDeskStudio } from "@/contexts/DeskStudioContext";
import { ApiError } from "@/lib/api/errors";
import { fetchMembers, type MemberListItem } from "@/lib/api/members";
import { fetchMembershipPlans, type MembershipPlanDto } from "@/lib/api/memberships";
import {
  createOfflineSubscription,
  createStaffCheckoutSession,
  createWalkInMember,
  fetchSalesSettings,
  formatMoney,
  memberDisplayName,
  type SalesSettings,
} from "@/lib/api/sales";
import {
  attestMemberWaiver,
  fetchMemberWaiverStatus,
  waiverStatusLabel,
  type MemberWaiverStatus,
} from "@/lib/api/waiver";
import { canRecordCashSales, normalizeStudioRole } from "@/lib/deskRoles";

type Step = 1 | 2 | 3 | 4 | 5;
type MemberMode = "create" | "search";
type PaymentMethodChoice = "stripe" | "cash";

function qrImageUrl(url: string): string {
  return `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(url)}`;
}

function defaultPeriodEnd(startIso: string, interval: MembershipPlanDto["billingInterval"]): string {
  const start = new Date(startIso);
  const end = new Date(start);
  if (interval === "MONTHLY") end.setMonth(end.getMonth() + 1);
  else if (interval === "YEARLY") end.setFullYear(end.getFullYear() + 1);
  else end.setDate(end.getDate() + 7);
  return end.toISOString().slice(0, 10);
}

export default function WalkInSalesPage() {
  const { user: authUser } = useAuth();
  const { selectedStudioId, studioRole, loading: studioLoading } = useDeskStudio();

  const [step, setStep] = useState<Step>(1);
  const [memberMode, setMemberMode] = useState<MemberMode>("search");
  const [salesSettings, setSalesSettings] = useState<SalesSettings | null>(null);

  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<MemberListItem[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  const [createForm, setCreateForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    temporaryPassword: "",
  });

  const [selectedMember, setSelectedMember] = useState<MemberListItem | null>(null);
  const [waiverStatus, setWaiverStatus] = useState<MemberWaiverStatus | null>(null);
  const [waiverLoading, setWaiverLoading] = useState(false);
  const [attestNote, setAttestNote] = useState("");
  const [attesting, setAttesting] = useState(false);

  const [plans, setPlans] = useState<MembershipPlanDto[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<string>("");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodChoice>("stripe");

  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [cashNotes, setCashNotes] = useState("");
  const [priceOverrideNote, setPriceOverrideNote] = useState("");
  const [periodStart, setPeriodStart] = useState(() => new Date().toISOString().slice(0, 10));
  const [periodEnd, setPeriodEnd] = useState("");
  const [activeUntil, setActiveUntil] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const role = normalizeStudioRole(studioRole);
  const canRecordCash = canRecordCashSales(role, salesSettings ?? undefined);
  const isOwner = role === "OWNER";

  const selectedPlan = useMemo(
    () => plans.find((p) => p.id === selectedPlanId) ?? null,
    [plans, selectedPlanId],
  );

  useEffect(() => {
    if (!selectedStudioId) return;
    fetchSalesSettings(selectedStudioId)
      .then(setSalesSettings)
      .catch(() =>
        setSalesSettings({
          frontDeskCanCreateMember: true,
          frontDeskCanIssueCheckout: true,
          frontDeskCanRecordCash: false,
        }),
      );
  }, [selectedStudioId]);

  useEffect(() => {
    if (!selectedStudioId) return;
    fetchMembershipPlans(selectedStudioId)
      .then((rows) => setPlans(rows.filter((p) => p.active)))
      .catch(() => setPlans([]));
  }, [selectedStudioId]);

  useEffect(() => {
    if (!selectedPlan) return;
    setPeriodEnd(defaultPeriodEnd(periodStart, selectedPlan.billingInterval));
  }, [selectedPlan, periodStart]);

  const loadWaiver = useCallback(async (studioId: string, userId: string) => {
    setWaiverLoading(true);
    setError(null);
    try {
      const status = await fetchMemberWaiverStatus(studioId, userId);
      setWaiverStatus(status);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo cargar la carta responsiva");
    } finally {
      setWaiverLoading(false);
    }
  }, []);

  const runSearch = useCallback(async () => {
    if (!selectedStudioId || !search.trim()) return;
    setSearchLoading(true);
    setError(null);
    try {
      const res = await fetchMembers(selectedStudioId, {
        role: "MEMBER",
        search: search.trim(),
        limit: 20,
      });
      setSearchResults(res.data);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Error al buscar clientes");
    } finally {
      setSearchLoading(false);
    }
  }, [selectedStudioId, search]);

  async function handleCreateMember() {
    if (!selectedStudioId) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createWalkInMember(selectedStudioId, {
        email: createForm.email.trim(),
        firstName: createForm.firstName.trim(),
        lastName: createForm.lastName.trim(),
        phone: createForm.phone.trim() || undefined,
        temporaryPassword: createForm.temporaryPassword,
      });
      const asListItem: MemberListItem = {
        membershipId: created.membership.id,
        role: "MEMBER",
        joinedAt: created.membership.createdAt,
        user: created.user,
        totalBookings: 0,
        noShowCount: 0,
        lastAttendanceAt: null,
        subscription: null,
      };
      setSelectedMember(asListItem);
      await loadWaiver(selectedStudioId, created.user.id);
      setStep(2);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo crear el cliente");
    } finally {
      setBusy(false);
    }
  }

  function selectExistingMember(member: MemberListItem) {
    setSelectedMember(member);
    if (selectedStudioId) {
      void loadWaiver(selectedStudioId, member.user.id);
    }
    setStep(2);
  }

  async function handleAttest() {
    if (!selectedStudioId || !selectedMember || !waiverStatus?.activeWaiverDocumentId) return;
    setAttesting(true);
    setError(null);
    try {
      await attestMemberWaiver(selectedStudioId, selectedMember.user.id, {
        waiverDocumentId: waiverStatus.activeWaiverDocumentId,
        attestationNote: attestNote.trim() || undefined,
      });
      await loadWaiver(selectedStudioId, selectedMember.user.id);
      setAttestNote("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo registrar la firma");
    } finally {
      setAttesting(false);
    }
  }

  async function handleGenerateCheckout() {
    if (!selectedStudioId || !selectedMember || !selectedPlanId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await createStaffCheckoutSession(
        selectedStudioId,
        selectedMember.user.id,
        selectedPlanId,
      );
      setCheckoutUrl(res.checkoutUrl);
      setStep(5);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo generar el link de pago");
    } finally {
      setBusy(false);
    }
  }

  async function handleRecordCash() {
    if (!selectedStudioId || !selectedMember || !selectedPlan) return;
    setBusy(true);
    setError(null);
    try {
      const amountCents = selectedPlan.priceCents;
      const res = await createOfflineSubscription(selectedStudioId, selectedMember.user.id, {
        planId: selectedPlan.id,
        amountCents,
        periodStart: new Date(`${periodStart}T12:00:00`).toISOString(),
        periodEnd: new Date(`${periodEnd}T23:59:59`).toISOString(),
        paymentMethod: "CASH",
        notes: cashNotes.trim() || undefined,
        priceOverrideNote: priceOverrideNote.trim() || undefined,
      });
      setActiveUntil(res.subscription.currentPeriodEnd);
      setStep(5);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo registrar el pago en efectivo");
    } finally {
      setBusy(false);
    }
  }

  function resetFlow() {
    setStep(1);
    setSelectedMember(null);
    setWaiverStatus(null);
    setSelectedPlanId("");
    setCheckoutUrl(null);
    setActiveUntil(null);
    setPaymentMethod("stripe");
    setError(null);
  }

  const waiverOk =
    !waiverStatus?.required || waiverStatus.accepted;

  const cashBlockedByWaiver = paymentMethod === "cash" && !waiverOk;

  if (studioLoading) {
    return <p className="p-6 text-sm text-zinc-500">Cargando estudio…</p>;
  }

  if (!selectedStudioId) {
    return <p className="p-6 text-sm text-zinc-500">Selecciona un estudio para continuar.</p>;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Ventas / Walk-ins</h1>
        <p className="mt-1 text-sm text-zinc-600">
          Registra clientes nuevos y vende membresías en recepción.
        </p>
      </header>

      <ol className="flex flex-wrap gap-2 text-xs font-medium text-zinc-500">
        {[
          "Cliente",
          "Carta responsiva",
          "Plan",
          "Pago",
          "Confirmación",
        ].map((label, i) => {
          const n = (i + 1) as Step;
          const active = step === n;
          const done = step > n;
          return (
            <li
              key={label}
              className={`rounded-full px-3 py-1 ${
                active
                  ? "bg-zinc-900 text-white"
                  : done
                    ? "bg-emerald-100 text-emerald-800"
                    : "bg-zinc-100"
              }`}
            >
              {n}. {label}
            </li>
          );
        })}
      </ol>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      {step === 1 ? (
        <section className="space-y-4 rounded-xl border border-zinc-200 bg-white p-6">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setMemberMode("search")}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                memberMode === "search"
                  ? "bg-zinc-900 text-white"
                  : "bg-zinc-100"
              }`}
            >
              Buscar cliente
            </button>
            <button
              type="button"
              onClick={() => setMemberMode("create")}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                memberMode === "create"
                  ? "bg-zinc-900 text-white"
                  : "bg-zinc-100"
              }`}
            >
              Nuevo cliente
            </button>
          </div>

          {memberMode === "search" ? (
            <div className="space-y-3">
              <div className="flex gap-2">
                <input
                  type="search"
                  placeholder="Nombre o correo"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void runSearch()}
                  className="flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-sm"
                />
                <button
                  type="button"
                  onClick={() => void runSearch()}
                  disabled={searchLoading}
                  className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {searchLoading ? "Buscando…" : "Buscar"}
                </button>
              </div>
              <ul className="divide-y divide-zinc-100">
                {searchResults.map((m) => (
                  <li key={m.user.id}>
                    <button
                      type="button"
                      onClick={() => selectExistingMember(m)}
                      className="flex w-full items-center justify-between py-3 text-left text-sm hover:bg-zinc-50"
                    >
                      <span>
                        <span className="font-medium">{memberDisplayName(m)}</span>
                        <span className="ml-2 text-zinc-500">{m.user.email}</span>
                      </span>
                      <span className="text-zinc-400">→</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {(
                [
                  ["firstName", "Nombre"],
                  ["lastName", "Apellido"],
                  ["email", "Correo"],
                  ["phone", "Teléfono (opcional)"],
                  ["temporaryPassword", "Contraseña temporal"],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="block text-sm sm:col-span-1">
                  <span className="mb-1 block text-zinc-600">{label}</span>
                  <input
                    type={key === "temporaryPassword" ? "password" : key === "email" ? "email" : "text"}
                    value={createForm[key]}
                    onChange={(e) => setCreateForm((f) => ({ ...f, [key]: e.target.value }))}
                    className="w-full rounded-lg border border-zinc-300 px-3 py-2"
                  />
                </label>
              ))}
              <div className="sm:col-span-2">
                <button
                  type="button"
                  onClick={() => void handleCreateMember()}
                  disabled={busy}
                  className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {busy ? "Creando…" : "Crear cliente"}
                </button>
              </div>
            </div>
          )}
        </section>
      ) : null}

      {step === 2 && selectedMember ? (
        <section className="space-y-4 rounded-xl border border-zinc-200 bg-white p-6">
          <h2 className="text-lg font-medium">Carta responsiva</h2>
          <p className="text-sm text-zinc-600">
            Cliente: <strong>{memberDisplayName(selectedMember)}</strong> ({selectedMember.user.email})
          </p>
          {waiverLoading ? (
            <p className="text-sm text-zinc-500">Verificando carta responsiva…</p>
          ) : waiverStatus ? (
            <div className="space-y-3">
              <p
                className={`inline-flex rounded-full px-3 py-1 text-sm font-medium ${
                  waiverOk
                    ? "bg-emerald-100 text-emerald-800"
                    : "bg-amber-100 text-amber-900"
                }`}
              >
                {waiverStatusLabel(waiverStatus)}
              </p>
              {!waiverOk && waiverStatus.activeWaiverDocumentId ? (
                <div className="space-y-2 rounded-lg border border-zinc-200 p-4">
                  <p className="text-sm text-zinc-600">
                    Puedes continuar con link de pago Stripe. Para efectivo, firma presencial requerida.
                  </p>
                  <textarea
                    placeholder="Nota de attestation (opcional)"
                    value={attestNote}
                    onChange={(e) => setAttestNote(e.target.value)}
                    rows={2}
                    className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => void handleAttest()}
                    disabled={attesting}
                    className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium"
                  >
                    {attesting ? "Registrando…" : "Registrar firma presencial"}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="flex gap-2">
            <button type="button" onClick={() => setStep(1)} className="text-sm text-zinc-500">
              ← Atrás
            </button>
            <button
              type="button"
              onClick={() => setStep(3)}
              className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white"
            >
              Continuar
            </button>
          </div>
        </section>
      ) : null}

      {step === 3 && selectedMember ? (
        <section className="space-y-4 rounded-xl border border-zinc-200 bg-white p-6">
          <h2 className="text-lg font-medium">Seleccionar membresía</h2>
          <ul className="space-y-2">
            {plans.map((plan) => (
              <li key={plan.id}>
                <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-zinc-200 p-3">
                  <input
                    type="radio"
                    name="plan"
                    checked={selectedPlanId === plan.id}
                    onChange={() => setSelectedPlanId(plan.id)}
                  />
                  <span className="flex-1 text-sm">
                    <span className="font-medium">{plan.name}</span>
                    <span className="ml-2 text-zinc-500">
                      {formatMoney(plan.priceCents, plan.currency)} / {plan.billingInterval.toLowerCase()}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <button type="button" onClick={() => setStep(2)} className="text-sm text-zinc-500">
              ← Atrás
            </button>
            <button
              type="button"
              disabled={!selectedPlanId}
              onClick={() => setStep(4)}
              className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Continuar
            </button>
          </div>
        </section>
      ) : null}

      {step === 4 && selectedMember && selectedPlan ? (
        <section className="space-y-4 rounded-xl border border-zinc-200 bg-white p-6">
          <h2 className="text-lg font-medium">Método de pago</h2>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setPaymentMethod("stripe")}
              className={`rounded-lg px-4 py-2 text-sm font-medium ${
                paymentMethod === "stripe"
                  ? "bg-zinc-900 text-white"
                  : "bg-zinc-100"
              }`}
            >
              Generar link de pago / QR Stripe
            </button>
            {canRecordCash ? (
              <button
                type="button"
                onClick={() => setPaymentMethod("cash")}
                className={`rounded-lg px-4 py-2 text-sm font-medium ${
                  paymentMethod === "cash"
                    ? "bg-zinc-900 text-white"
                    : "bg-zinc-100"
                }`}
              >
                Registrar pago en efectivo
              </button>
            ) : null}
          </div>

          {paymentMethod === "stripe" ? (
            <p className="text-sm text-zinc-600">
              El cliente escanea el QR y paga en su teléfono. La membresía se activa vía webhook de Stripe.
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm">
                <span className="mb-1 block text-zinc-600">Inicio del periodo</span>
                <input
                  type="date"
                  value={periodStart}
                  onChange={(e) => setPeriodStart(e.target.value)}
                  className="w-full rounded-lg border border-zinc-300 px-3 py-2"
                />
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-zinc-600">Fin del periodo</span>
                <input
                  type="date"
                  value={periodEnd}
                  onChange={(e) => setPeriodEnd(e.target.value)}
                  className="w-full rounded-lg border border-zinc-300 px-3 py-2"
                />
              </label>
              <label className="text-sm sm:col-span-2">
                <span className="mb-1 block text-zinc-600">Monto</span>
                <input
                  readOnly
                  value={formatMoney(selectedPlan.priceCents, selectedPlan.currency)}
                  className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2"
                />
              </label>
              {isOwner ? (
                <label className="text-sm sm:col-span-2">
                  <span className="mb-1 block text-zinc-600">Nota de override de precio (solo OWNER)</span>
                  <input
                    value={priceOverrideNote}
                    onChange={(e) => setPriceOverrideNote(e.target.value)}
                    className="w-full rounded-lg border border-zinc-300 px-3 py-2"
                  />
                </label>
              ) : null}
              <label className="text-sm sm:col-span-2">
                <span className="mb-1 block text-zinc-600">Notas</span>
                <textarea
                  value={cashNotes}
                  onChange={(e) => setCashNotes(e.target.value)}
                  rows={2}
                  className="w-full rounded-lg border border-zinc-300 px-3 py-2"
                />
              </label>
              {cashBlockedByWaiver ? (
                <p className="text-sm text-amber-700 sm:col-span-2">
                  Se requiere carta responsiva aceptada o firmada presencialmente para registrar efectivo.
                </p>
              ) : null}
            </div>
          )}

          <div className="flex gap-2">
            <button type="button" onClick={() => setStep(3)} className="text-sm text-zinc-500">
              ← Atrás
            </button>
            <button
              type="button"
              disabled={busy || (paymentMethod === "cash" && cashBlockedByWaiver)}
              onClick={() =>
                void (paymentMethod === "stripe" ? handleGenerateCheckout() : handleRecordCash())
              }
              className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy
                ? "Procesando…"
                : paymentMethod === "stripe"
                  ? "Generar link de pago"
                  : "Registrar pago en efectivo"}
            </button>
          </div>
        </section>
      ) : null}

      {step === 5 ? (
        <section className="space-y-4 rounded-xl border border-zinc-200 bg-white p-6">
          <h2 className="text-lg font-medium">Confirmación</h2>
          {checkoutUrl ? (
            <div className="space-y-4">
              <p className="text-sm font-medium">Mostrar QR de pago</p>
              <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={qrImageUrl(checkoutUrl)}
                  alt="QR de pago Stripe"
                  width={240}
                  height={240}
                  className="rounded-lg border border-zinc-200"
                />
                <div className="min-w-0 flex-1 space-y-2">
                  <p className="text-sm text-zinc-600">Link de pago</p>
                  <input
                    readOnly
                    value={checkoutUrl}
                    className="w-full truncate rounded-lg border border-zinc-300 px-3 py-2 text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => void navigator.clipboard.writeText(checkoutUrl)}
                    className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm"
                  >
                    Copiar link
                  </button>
                </div>
              </div>
            </div>
          ) : null}
          {activeUntil ? (
            <p className="text-sm">
              Membresía activa hasta{" "}
              <strong>
                {new Date(activeUntil).toLocaleDateString("es-MX", {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}
              </strong>
            </p>
          ) : null}
          <button
            type="button"
            onClick={resetFlow}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white"
          >
            Nueva venta
          </button>
        </section>
      ) : null}

      {authUser ? (
        <p className="text-xs text-zinc-400">Operador: {authUser.email}</p>
      ) : null}
    </div>
  );
}
