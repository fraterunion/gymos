import assert from "node:assert/strict";
import test, { mock } from "node:test";

import {
  actorLabel,
  billingCopy,
  buildMembershipCards,
  failureReasonPhrase,
  lastPaymentLine,
  membershipCardRows,
  membershipStatusLabel,
  pageAttentionItems,
  paymentsKpi,
  renewalChangeSentence,
  timelineDetail,
  timelineTitle,
  type MembershipCardInput,
} from "./membershipBilling.ts";
import type { MemberBillingStatus, MembershipBillingStatus, PaymentFailureView, TimelineEvent } from "./api/members.ts";

const NOW = new Date("2026-10-08T12:00:00.000Z");
// Copy omits the year for dates in the current year and compares retry dates with "now": pin it.
mock.timers.enable({ apis: ["Date"], now: NOW });

const DOUBLE_CHARGE = "No registres un cobro en efectivo por este periodo mientras la factura siga abierta en Stripe: se cobraría dos veces.";

function failure(overrides: Partial<PaymentFailureView> = {}): PaymentFailureView {
  return {
    paymentId: "pay_failed",
    invoiceId: "in_pro_renewal",
    amountCents: 60000,
    currency: "mxn",
    firstFailedAt: "2026-09-26T16:00:00.000Z",
    lastAttemptAt: "2026-10-08T06:00:00.000Z",
    attemptCount: 7,
    nextAttemptAt: "2026-10-09T21:00:00.000Z",
    invoiceStatus: "open",
    billingReason: "subscription_cycle",
    reason: "CARD_DECLINED",
    code: "do_not_honor",
    detailSource: "stripe_live",
    liveLookup: "ok",
    ...overrides,
  };
}

function status(overrides: Partial<MembershipBillingStatus> = {}): MembershipBillingStatus {
  return {
    subscriptionId: "sub_pro",
    planName: "Pro",
    source: "STRIPE",
    state: "AUTO_RENEW_OK",
    severity: "ok",
    certainty: "confirmed",
    isEntitled: true,
    lifecycleStatus: "ACTIVE",
    effectiveEnd: "2026-10-26T15:00:00.000Z",
    renewal: { mode: "AUTOMATIC", endsAt: "2026-10-26T15:00:00.000Z", nextChargeAt: "2026-10-26T15:00:00.000Z", change: null },
    paymentFailure: null,
    stripe: null,
    statusMismatch: null,
    action: null,
    ...overrides,
  };
}

const PORTAL_OFF = { disabled: true, at: "2026-09-27T22:00:01.000Z", origin: "CUSTOMER_PORTAL" as const, actorName: null, feedback: "unused", certainty: "inferred" as const };

/** Example member: card Pro renewal declined, renewal later switched off in the portal; cash Booty Lab expired (synthetic times). */
const PRO_FAILED = status({
  state: "PAYMENT_FAILED_RETRYING",
  severity: "critical",
  isEntitled: false,
  lifecycleStatus: "PAST_DUE",
  renewal: { mode: "DISABLED", endsAt: "2026-10-26T15:00:00.000Z", nextChargeAt: null, change: PORTAL_OFF },
  paymentFailure: failure(),
  stripe: { status: "past_due", cancellationReason: "cancellation_requested", canceledAt: "2026-09-27T22:00:00.000Z", endedAt: null, cancelAt: "2026-10-26T15:00:00.000Z", observedAt: "2026-09-27T22:00:02.000Z" },
  action: "UPDATE_PAYMENT_METHOD",
});
const BOOTY_CASH_EXPIRED = status({
  subscriptionId: "sub_booty",
  planName: "Booty Lab by Etzia",
  source: "CASH",
  state: "MANUAL_EXPIRED",
  severity: "warning",
  isEntitled: false,
  lifecycleStatus: "EXPIRED",
  effectiveEnd: "2026-10-02T18:00:00.000Z",
  renewal: { mode: "MANUAL", endsAt: "2026-10-02T18:00:00.000Z", nextChargeAt: null, change: null },
  action: "RENEW_MANUALLY",
});

function row(overrides: Partial<MembershipCardInput> = {}): MembershipCardInput {
  return {
    subscriptionId: "sub_pro",
    planName: "Pro",
    source: "STRIPE",
    status: "ACTIVE",
    lifecycleStatus: "ACTIVE",
    primaryStatus: "ACTIVE",
    isEntitled: true,
    currentPeriodStart: "2026-09-26T15:00:00.000Z",
    effectiveEnd: "2026-10-26T15:00:00.000Z",
    cancelAtPeriodEnd: false,
    classCredits: null,
    creditsUsed: null,
    creditsRemaining: null,
    ...overrides,
  };
}
const MIXED_ROWS = [
  row({ status: "PAST_DUE", lifecycleStatus: "PAST_DUE", primaryStatus: "PAST_DUE", isEntitled: false, cancelAtPeriodEnd: true, classCredits: 5, creditsUsed: 1, creditsRemaining: 4 }),
  row({ subscriptionId: "sub_booty", planName: "Booty Lab by Etzia", source: "CASH", lifecycleStatus: "EXPIRED", primaryStatus: "EXPIRED", isEntitled: false, currentPeriodStart: "2026-08-18T18:00:00.000Z", effectiveEnd: "2026-10-02T18:00:00.000Z", cancelAtPeriodEnd: true, classCredits: 4, creditsUsed: 3, creditsRemaining: 1 }),
];
const billing = (memberships: MembershipBillingStatus[]): MemberBillingStatus => ({ generatedAt: NOW.toISOString(), memberships, failedPayments: [] });

// ── Cards ─────────────────────────────────────────────────────────────────────

test("1. one active card membership: renews automatically, next charge date", () => {
  const [card] = buildMembershipCards({ rows: [row()], billing: billing([status()]), billingState: "ready", now: NOW });
  assert.deepEqual([card.status, card.payment, card.paymentProblem], [{ label: "Activa", tone: "ok" }, { label: "Al corriente", tone: "ok" }, false]);
  assert.deepEqual(card.explanation, ["Renovación automática con tarjeta. Próximo cobro: 26 oct."]);
  assert.deepEqual(card.facts, [
    { label: "Vigencia", value: "26 sep → 26 oct" },
    { label: "Créditos", value: "Ilimitado" },
    { label: "Renovación", value: "Automática · próximo cobro 26 oct" },
    { label: "Método de pago", value: "Tarjeta (Stripe)" },
  ]);
  assert.equal(card.action, null);
});

test("2/3/8/9. card + cash memberships get one explicit card each, worst first — no '+1 membresía'", () => {
  const cards = buildMembershipCards({ rows: MIXED_ROWS, billing: billing([BOOTY_CASH_EXPIRED, PRO_FAILED]), billingState: "ready", now: NOW });
  assert.deepEqual(cards.map((c) => [c.planName, c.status.label, c.payment.label]), [
    ["Pro", "Sin acceso", "Pago fallido"],
    ["Booty Lab by Etzia", "Vencida", "Renovación manual"],
  ]);
  assert.equal(JSON.stringify(cards).includes("+1"), false);
  const [pro, booty] = cards;
  assert.deepEqual(pro.facts, [
    { label: "Último periodo", value: "26 sep → 26 oct" },
    { label: "Créditos", value: "1 / 5 usados · 4 sin usar (ya no dan acceso)" },
    { label: "Renovación", value: "No renovará · termina el 26 oct" },
    { label: "Método de pago", value: "Tarjeta (Stripe)" },
  ]);
  assert.deepEqual(booty.facts, [
    { label: "Último periodo", value: "18 ago → 2 oct" },
    { label: "Créditos", value: "3 / 4 usados · 1 sin usar (ya no dan acceso)" },
    { label: "Renovación", value: "Manual (en recepción)" },
    { label: "Método de pago", value: "Efectivo / transferencia" },
  ]);
  assert.deepEqual(booty.explanation, ["Esta membresía se paga en recepción y venció el 2 oct. Requiere renovación manual."]);
  assert.deepEqual(booty.action, { label: "Ir a Ventas", detail: "Si el miembro quiere continuar, registra la renovación en Ventas.", href: "/sales" });
});

test("5. card decline: what was charged, why, retries, the renewal switch-off and the access consequence", () => {
  const copy = billingCopy(PRO_FAILED);
  assert.equal(copy.paymentLabel, "Pago fallido");
  assert.deepEqual(copy.explanation, [
    "Stripe intentó cobrar la renovación de Pro ($600.00 MXN), pero el banco emisor rechazó la tarjeta (código do_not_honor).",
    "7 intentos fallidos desde el 26 sep; el último, el 8 oct.",
    "Stripe volverá a intentarlo el 9 oct.",
    "La renovación automática de Pro se desactivó desde el portal de pagos de Stripe el 27 sep (el miembro respondió: «no la usa lo suficiente»). Aunque se recupere este pago, la membresía termina el 26 oct.",
    "Sin acceso a Pro mientras el pago esté pendiente.",
  ]);
  assert.equal(copy.caution, DOUBLE_CHARGE);
  assert.deepEqual(copy.action, { label: "Ver facturación", detail: "Pide al miembro que actualice su tarjeta desde la app (portal de pagos de Stripe) para que Stripe pueda cobrar la factura.", tab: "billing" });
});

test("5b. retry states never over-claim: due, unknown, no more retries, closed invoice", () => {
  const due = billingCopy({ ...PRO_FAILED, paymentFailure: failure({ nextAttemptAt: "2026-10-08T11:30:00.000Z" }) });
  assert.ok(due.explanation.includes("Stripe tenía programado otro intento el 8 oct; su resultado aún no se refleja."));
  assert.equal(due.caution, DOUBLE_CHARGE);

  const unknown = billingCopy({ ...PRO_FAILED, state: "PAYMENT_FAILED", certainty: "inferred", paymentFailure: failure({ nextAttemptAt: null, detailSource: "local", liveLookup: "unavailable", reason: "UNKNOWN", code: null, attemptCount: null }) });
  assert.deepEqual(unknown.explanation.slice(0, 2), [
    "Stripe intentó cobrar la renovación de Pro ($600.00 MXN), pero el cobro no se completó (no se pudo consultar el motivo en Stripe en este momento).",
    "No se pudo confirmar en Stripe si habrá otro intento.",
  ]);
  assert.equal(unknown.caution, DOUBLE_CHARGE);

  const noMoreRetries = billingCopy({ ...PRO_FAILED, state: "PAYMENT_FAILED_FINAL", paymentFailure: failure({ nextAttemptAt: null }) });
  assert.ok(noMoreRetries.explanation.includes("Stripe ya no reintentará el cobro automáticamente; la factura sigue abierta."));
  assert.equal(noMoreRetries.caution, DOUBLE_CHARGE);

  for (const [invoiceStatus, sentence] of [["uncollectible", "La factura quedó marcada como incobrable en Stripe: ya no se intentará cobrar."], ["void", "La factura fue anulada en Stripe: ya no se cobrará."]] as const) {
    const closed = billingCopy({ ...PRO_FAILED, state: "PAYMENT_FAILED_FINAL", severity: "warning", action: "REVIEW_BILLING", paymentFailure: failure({ nextAttemptAt: null, invoiceStatus }) });
    assert.equal(closed.paymentLabel, "Factura cerrada sin pago");
    assert.equal(closed.tone, "warning");
    assert.ok(closed.explanation.includes(sentence));
    assert.ok(closed.explanation.includes("Sin acceso a Pro."));
    assert.equal(closed.caution, null);
  }
});

test("every decline reason has a truthful phrase; unknown is never dressed up", () => {
  const phrase = (reason: PaymentFailureView["reason"], extra: Partial<PaymentFailureView> = {}) => failureReasonPhrase(failure({ reason, code: null, ...extra }));
  assert.equal(phrase("INSUFFICIENT_FUNDS"), "la tarjeta fue rechazada por fondos insuficientes");
  assert.equal(phrase("EXPIRED_CARD"), "la tarjeta está vencida");
  assert.equal(phrase("INCORRECT_CVC"), "el código de seguridad (CVC) no coincide");
  assert.equal(phrase("AUTHENTICATION_REQUIRED"), "la tarjeta requiere que el miembro autentique el pago con su banco (3D Secure)");
  assert.equal(phrase("BLOCKED_BY_STRIPE"), "Stripe bloqueó el cargo con su sistema antifraude");
  assert.equal(phrase("CARD_NOT_SUPPORTED"), "la tarjeta no acepta este tipo de cargo");
  assert.equal(phrase("PROCESSING_ERROR"), "hubo un error de procesamiento con la tarjeta");
  assert.equal(phrase("NO_PAYMENT_METHOD"), "no hay un método de pago válido para cobrarla");
  assert.equal(phrase("CARD_DECLINED"), "el banco emisor rechazó la tarjeta");
  assert.equal(phrase("OTHER", { code: "card_velocity_exceeded" }), "el cobro fue rechazado (código card_velocity_exceeded)");
  assert.equal(phrase("UNKNOWN", { liveLookup: "unavailable" }), "el cobro no se completó (no se pudo consultar el motivo en Stripe en este momento)");
  assert.equal(phrase("UNKNOWN", { liveLookup: "skipped" }), "el cobro no se completó (no se consultó el motivo en Stripe)");
  assert.equal(phrase("UNKNOWN", { liveLookup: "ok" }), "el cobro no se completó (Stripe no informó el motivo)");
});

test("authentication required asks the customer to pay the pending invoice, not to call the bank", () => {
  const copy = billingCopy(status({ ...PRO_FAILED, state: "PAYMENT_ACTION_REQUIRED", renewal: { mode: "AUTOMATIC", endsAt: "2026-10-26T15:00:00.000Z", nextChargeAt: null, change: null }, paymentFailure: failure({ reason: "AUTHENTICATION_REQUIRED", code: null, billingReason: "subscription_create" }), action: "COMPLETE_AUTHENTICATION" }));
  assert.equal(copy.paymentLabel, "Requiere autenticación");
  assert.equal(copy.explanation[0], "Stripe intentó cobrar el primer pago de Pro ($600.00 MXN), pero la tarjeta requiere que el miembro autentique el pago con su banco (3D Secure).");
  assert.equal(copy.action?.detail, "Pide al miembro que pague la factura pendiente desde la app para completar la autenticación de su banco (3D Secure).");
});

test("4. cancel_at_period_end: still active until the entitlement end, will not be charged again (portal switch-off)", () => {
  const offInPortal = status({
    subscriptionId: "sub_booty_card",
    planName: "Booty Lab by Etzia",
    state: "RENEWAL_DISABLED",
    severity: "info",
    lifecycleStatus: "ENDING",
    effectiveEnd: "2026-11-16T17:24:56.000Z",
    renewal: { mode: "DISABLED", endsAt: "2026-11-16T17:24:56.000Z", nextChargeAt: null, change: { ...PORTAL_OFF, at: "2026-10-02T18:00:00.000Z" } },
  });
  const [card] = buildMembershipCards({ rows: [row({ subscriptionId: "sub_booty_card", planName: "Booty Lab by Etzia", cancelAtPeriodEnd: true, lifecycleStatus: "ENDING", currentPeriodStart: "2026-10-02T17:24:56.000Z", effectiveEnd: "2026-11-16T17:24:56.000Z", classCredits: 4, creditsUsed: 0, creditsRemaining: 4 })], billing: billing([offInPortal]), billingState: "ready", now: NOW });
  assert.deepEqual([card.status.label, card.payment.label, card.paymentProblem], ["Activa", "Al corriente", false]);
  assert.deepEqual(card.explanation, [
    "La renovación automática de Booty Lab by Etzia se desactivó desde el portal de pagos de Stripe el 2 oct (el miembro respondió: «no la usa lo suficiente»).",
    "La membresía sigue activa hasta el 16 nov y no volverá a cobrarse automáticamente.",
  ]);
  assert.equal(card.facts[2].value, "No renovará · termina el 16 nov");
  assert.equal(card.facts[1].value, "0 / 4 usados · 4 restantes");
  assert.equal(card.action, null);
});

test("renewal origin wording matches the certainty of each source", () => {
  const at = "2026-09-27T22:00:01.000Z";
  const say = (origin: NonNullable<MembershipBillingStatus["renewal"]["change"]>["origin"], extra: Partial<NonNullable<MembershipBillingStatus["renewal"]["change"]>> = {}) => renewalChangeSentence({ disabled: true, at, origin, actorName: null, feedback: null, certainty: "inferred", ...extra }, "Pro");
  assert.equal(say("STRIPE_NO_REQUEST"), "La renovación automática de Pro se desactivó en Stripe el 27 sep, fuera de GymOS (probablemente desde el portal de pagos).");
  assert.equal(say("STRIPE_API"), "La renovación automática de Pro se desactivó el 27 sep desde el panel de Stripe u otra integración (no desde GymOS).");
  assert.equal(say("GYMOS_STAFF", { actorName: "Ana López · ADMIN" }), "La renovación automática de Pro se desactivó desde GymOS el 27 sep (Ana López · Administración).");
  assert.equal(say("GYMOS"), "La renovación automática de Pro se desactivó desde GymOS el 27 sep.");
  assert.equal(say("STRIPE_TO_CASH"), "El cobro con tarjeta de Pro se detuvo el 27 sep por el cambio a pago en recepción.");
  assert.equal(renewalChangeSentence({ disabled: false, at, origin: "GYMOS", actorName: null, feedback: null, certainty: "confirmed" }, "Pro"), "La renovación automática de Pro se reactivó desde GymOS el 27 sep.");
  assert.equal(actorLabel("Luis Pérez · FRONT_DESK"), "Luis Pérez · Recepción");
});

test("6. pending payment is pending, not failed; a first payment that never completed says so", () => {
  const pending = billingCopy(status({ state: "PAYMENT_PENDING", severity: "warning", certainty: "inferred", isEntitled: false, lifecycleStatus: "PAST_DUE", renewal: { mode: "AUTOMATIC", endsAt: null, nextChargeAt: null, change: null }, action: "REVIEW_BILLING" }));
  assert.equal(pending.paymentLabel, "Pago pendiente");
  assert.deepEqual(pending.explanation, ["Stripe aún no confirma el pago de Pro; no hay un intento de cobro fallido registrado.", "Sin acceso a Pro mientras el pago esté pendiente."]);
  assert.equal(pending.caution, "No registres un cobro en efectivo por este periodo sin revisar Stripe: podría cobrarse dos veces.");
  const incomplete = billingCopy(status({ state: "PAYMENT_PENDING", severity: "warning", isEntitled: false, lifecycleStatus: "PAUSED", stripe: { status: "incomplete", cancellationReason: null, canceledAt: null, endedAt: null, cancelAt: null, observedAt: "2026-10-07T00:00:00.000Z" }, renewal: { mode: "AUTOMATIC", endsAt: null, nextChargeAt: null, change: null } }));
  assert.equal(incomplete.explanation[0], "El primer pago de Pro no se completó en Stripe.");
});

test("GymOS and Stripe disagree: cancelled/paused in GymOS but alive in Stripe; current in GymOS but past due in Stripe", () => {
  const stripe = (s: string) => ({ status: s, cancellationReason: null, canceledAt: null, endedAt: null, cancelAt: null, observedAt: "2026-10-05T10:00:00.000Z" });
  const ended = billingCopy(status({ state: "STATUS_MISMATCH", severity: "critical", certainty: "inferred", isEntitled: false, lifecycleStatus: "CANCELED", stripe: stripe("active"), statusMismatch: { local: "CANCELED", stripe: "active" }, action: "RECONCILE" }));
  assert.equal(ended.paymentLabel, "Stripe sigue activa");
  assert.deepEqual(ended.explanation, ["En GymOS la membresía Pro está cancelada, pero Stripe la registra como activa (último dato de Stripe: 5 oct) y puede seguir cobrándola."]);
  assert.equal(ended.caution, "No vendas otra membresía ni cobres en efectivo hasta conciliar con Stripe.");
  assert.equal(ended.action?.detail, "Avisa a un administrador: GymOS y Stripe no coinciden. No cobres ni cambies el estado de la membresía hasta conciliarlo.");
  const overdue = billingCopy(status({ state: "STATUS_MISMATCH", severity: "warning", certainty: "inferred", stripe: stripe("past_due"), statusMismatch: { local: "ACTIVE", stripe: "past_due" }, action: "REVIEW_BILLING" }));
  assert.deepEqual([overdue.paymentLabel, overdue.explanation[0]], ["Pago vencido en Stripe", "Stripe registra la suscripción de Pro como con pago vencido (último dato de Stripe: 5 oct), pero GymOS la muestra al corriente."]);
});

test("Stripe cancelled for non-payment while GymOS still shows it pending (pre-fix race)", () => {
  const copy = billingCopy(status({
    planName: "Full Access",
    state: "CANCELED_PAYMENT_FAILED",
    severity: "critical",
    isEntitled: false,
    lifecycleStatus: "PAST_DUE",
    renewal: { mode: "ENDED", endsAt: "2026-09-28T02:14:01.000Z", nextChargeAt: null, change: null },
    paymentFailure: failure({ amountCents: 150000, attemptCount: 9, nextAttemptAt: null, reason: "INSUFFICIENT_FUNDS", code: "insufficient_funds" }),
    stripe: { status: "canceled", cancellationReason: "payment_failed", canceledAt: "2026-09-28T02:14:01.000Z", endedAt: "2026-09-28T02:14:01.000Z", cancelAt: null, observedAt: "2026-09-28T02:14:04.000Z" },
    statusMismatch: { local: "PAST_DUE", stripe: "canceled" },
    action: "RECONCILE",
  }));
  assert.equal(copy.paymentLabel, "Cancelada por falta de pago");
  assert.deepEqual(copy.explanation, [
    "Stripe canceló la suscripción de Full Access el 27 sep porque no pudo cobrar la renovación (9 intentos; fondos insuficientes).",
    "GymOS todavía la muestra como «Pago pendiente»: requiere conciliación.",
  ]);
  assert.equal(copy.caution, "No cobres de nuevo sin revisar Stripe.");
  assert.equal(copy.action?.label, "Ver facturación");
  const firstPayment = billingCopy(status({ planName: "Full Access", state: "CANCELED_PAYMENT_FAILED", severity: "warning", isEntitled: false, lifecycleStatus: "CANCELED", stripe: { status: "incomplete_expired", cancellationReason: null, canceledAt: "2026-09-02T00:00:00.000Z", endedAt: "2026-09-02T00:00:00.000Z", cancelAt: null, observedAt: "2026-09-02T00:00:00.000Z" } }));
  assert.equal(firstPayment.explanation[0], "Stripe canceló la suscripción de Full Access el 1 sep porque el primer pago no se completó a tiempo.");
});

test("cancellations: on request, by dispute, and still within a paid window (access date from the entitlement, not Stripe)", () => {
  const stripe = (reason: string) => ({ status: "canceled", cancellationReason: reason, canceledAt: "2026-10-01T15:00:00.000Z", endedAt: "2026-10-01T15:00:00.000Z", cancelAt: null, observedAt: "2026-10-01T15:00:02.000Z" });
  const requested = billingCopy(status({ state: "CANCELED", severity: "info", isEntitled: true, lifecycleStatus: "ENDING", effectiveEnd: "2026-11-16T17:24:56.000Z", renewal: { mode: "ENDED", endsAt: "2026-10-01T15:00:00.000Z", nextChargeAt: null, change: null }, stripe: stripe("cancellation_requested") }));
  assert.deepEqual(requested.explanation, ["La suscripción de Pro se canceló el 1 oct por solicitud (no por falta de pago).", "Conserva acceso hasta el 16 nov."]);
  const disputed = billingCopy(status({ state: "CANCELED", severity: "info", isEntitled: false, lifecycleStatus: "CANCELED", stripe: stripe("payment_disputed") }));
  assert.equal(disputed.explanation[0], "Stripe canceló la suscripción de Pro el 1 oct por una disputa (contracargo) de un pago.");
});

test("card membership whose access ended with no renewal payment in GymOS: worded as what GymOS knows", () => {
  const copy = billingCopy(status({ state: "EXPIRED_UNPAID", severity: "warning", certainty: "inferred", isEntitled: false, lifecycleStatus: "EXPIRED", effectiveEnd: "2026-10-02T16:54:40.000Z", action: "REVIEW_BILLING" }));
  assert.equal(copy.paymentLabel, "Sin pago de renovación");
  assert.deepEqual(copy.explanation, ["La membresía venció el 2 oct y GymOS no tiene registrado un pago de renovación; en Stripe la suscripción sigue activa."]);
  assert.equal(copy.caution, "Revisa Stripe antes de renovar o cobrar: el cargo podría haberse hecho ya.");
});

test("7. manual memberships are worded by how they are paid: front desk vs assigned by staff", () => {
  const cash = billingCopy(status({ source: "CASH", state: "MANUAL_ACTIVE", renewal: { mode: "MANUAL", endsAt: null, nextChargeAt: null, change: null } }));
  assert.deepEqual([cash.paymentLabel, cash.explanation], ["Pagada en recepción", ["Se paga en recepción: no se cobra automáticamente. Vence el 26 oct."]]);
  const assigned = billingCopy(status({ source: "MANUAL", state: "MANUAL_ACTIVE", renewal: { mode: "MANUAL", endsAt: null, nextChargeAt: null, change: null } }));
  assert.deepEqual([assigned.paymentLabel, assigned.explanation], ["Asignada manualmente", ["Asignada manualmente por el personal: no se cobra automáticamente. Vence el 26 oct."]]);
  const assignedExpired = billingCopy(status({ source: "MANUAL", state: "MANUAL_EXPIRED", isEntitled: false, effectiveEnd: "2026-10-02T18:00:00.000Z" }));
  assert.equal(assignedExpired.explanation[0], "Esta membresía fue asignada manualmente y venció el 2 oct. Requiere renovación manual.");
  const pausedCash = billingCopy(status({ source: "CASH", state: "PAUSED", severity: "info" }));
  assert.deepEqual([pausedCash.explanation, pausedCash.paymentProblem], [["Pausada en GymOS; no se cobra mientras esté en pausa."], false]);
  const unknownCash = billingCopy(status({ source: "CASH", state: "UNKNOWN", severity: "info", certainty: "inferred" }));
  assert.deepEqual(unknownCash.explanation, ["No hay información suficiente para explicar el estado de esta membresía."]);
});

test("dates outside the current year carry the year (a cash membership valid until next year)", () => {
  const copy = billingCopy(status({ planName: "Pro", source: "CASH", state: "MANUAL_ACTIVE", effectiveEnd: "2027-09-02T18:00:00.000Z", renewal: { mode: "MANUAL", endsAt: "2027-09-02T18:00:00.000Z", nextChargeAt: null, change: null } }));
  assert.deepEqual(copy.explanation, ["Se paga en recepción: no se cobra automáticamente. Vence el 2 sep 2027."]);
  const [card] = buildMembershipCards({ rows: [row({ source: "CASH", currentPeriodStart: "2026-09-02T18:00:00.000Z", effectiveEnd: "2027-09-02T18:00:00.000Z" })], billing: null, billingState: "loading", now: NOW });
  assert.equal(card.facts[0].value, "2 sep → 2 sep 2027");
});

test("status label: 'termina pronto' only when it will really end; trials stay trials", () => {
  const soon = "2026-10-12T00:00:00.000Z";
  assert.deepEqual(membershipStatusLabel(row({ effectiveEnd: soon }), NOW), { label: "Activa", tone: "ok" });
  assert.deepEqual(membershipStatusLabel(row({ effectiveEnd: soon, lifecycleStatus: "ENDING" }), NOW), { label: "Activa · termina pronto", tone: "warning" });
  assert.deepEqual(membershipStatusLabel(row({ lifecycleStatus: "TRIALING", primaryStatus: "TRIALING" }), NOW), { label: "Prueba", tone: "info" });
  assert.deepEqual(membershipStatusLabel(row({ lifecycleStatus: "TRIALING", primaryStatus: "ACTIVE" }), NOW), { label: "Activa", tone: "ok" });
  assert.deepEqual(membershipStatusLabel(row({ isEntitled: false, lifecycleStatus: "PAST_DUE", primaryStatus: "PAST_DUE" }), NOW), { label: "Sin acceso", tone: "critical" });
});

test("while the explanation loads, fails or has no row, the cards keep the local guards", () => {
  const loading = buildMembershipCards({ rows: MIXED_ROWS, billing: null, billingState: "loading", now: NOW });
  assert.deepEqual(loading.map((c) => [c.planName, c.payment.label, c.explanation]), [
    ["Pro", "Pago pendiente", ["Consultando el detalle del cobro…"]],
    ["Booty Lab by Etzia", "Renovación manual", []],
  ]);
  assert.equal(loading[0].caution, "No registres un cobro en efectivo por este periodo sin revisar Stripe: podría cobrarse dos veces.");
  assert.deepEqual(buildMembershipCards({ rows: MIXED_ROWS, billing: null, billingState: "error", now: NOW })[0].explanation, ["No se pudo cargar el detalle del cobro."]);
  assert.deepEqual(buildMembershipCards({ rows: MIXED_ROWS, billing: billing([]), billingState: "ready", now: NOW })[0].explanation, ["Sin detalle de cobro para esta membresía."]);

  const paidNoAccess = buildMembershipCards({ rows: [row({ status: "ACTIVE", lifecycleStatus: "EXPIRED", primaryStatus: "EXPIRED", isEntitled: false, paidWithoutEntitlement: true })], billing: null, billingState: "loading", now: NOW })[0];
  assert.deepEqual([paidNoAccess.payment.label, paidNoAccess.caution], ["Pagado sin acceso", "No cobres de nuevo: requiere conciliación."]);
  const stripeStillRenewing = buildMembershipCards({ rows: [row({ status: "ACTIVE", lifecycleStatus: "EXPIRED", primaryStatus: "EXPIRED", isEntitled: false })], billing: null, billingState: "error", now: NOW })[0];
  assert.deepEqual([stripeStillRenewing.payment.label, stripeStillRenewing.caution], ["Revisar cobro", "Stripe sigue cobrando esta suscripción: revisa el cobro antes de renovar."]);
});

test("card rows: current memberships (scheduled excluded) with the API status, or the latest one when none is current", () => {
  const summary = (id: string, name: string, s: string, extra: Record<string, unknown> = {}) => ({
    subscriptionId: id, status: s, source: "STRIPE", lifecycleStatus: s, primaryStatus: s, isEntitled: s === "ACTIVE", currentPeriodStart: null, effectiveEnd: null, cancelAtPeriodEnd: false,
    plan: { name, classCredits: 4 }, creditsUsed: 1, creditsRemaining: 3, ...extra,
  });
  const profile = {
    memberships: [summary("s1", "Pro", "PAST_DUE"), summary("s2", "Booty Lab by Etzia", "ACTIVE", { paidWithoutEntitlement: { stripeInvoiceId: "in_x", amountCents: 1, currency: "mxn", paidAt: "x" } }), summary("s3", "Pro", "SCHEDULED")],
    currentMembership: null,
  } as unknown as Parameters<typeof membershipCardRows>[0];
  assert.deepEqual(membershipCardRows(profile).map((r) => [r.subscriptionId, r.primaryStatus, r.paidWithoutEntitlement]), [["s1", "PAST_DUE", false], ["s2", "ACTIVE", true]]);

  const ended = {
    memberships: [],
    currentMembership: { id: "s9", status: "CANCELED", source: "STRIPE", lifecycleStatus: "CANCELED", primaryStatus: "CANCELED", isEntitled: false, currentPeriodStart: null, effectiveEnd: "2026-10-03T13:00:00.000Z", cancelAtPeriodEnd: false, plan: { name: "Full Access", classCredits: null }, creditsUsed: null, creditsRemaining: null },
  } as unknown as Parameters<typeof membershipCardRows>[0];
  assert.deepEqual(membershipCardRows(ended).map((r) => [r.subscriptionId, r.planName, r.primaryStatus]), [["s9", "Full Access", "CANCELED"]]);
  assert.deepEqual(membershipCardRows({ memberships: [], currentMembership: null }), []);
});

test("attention list drops only what the primary membership's card already explains", () => {
  const items = ["PAST_DUE", "EXPIRED", "CANCELLATION_SCHEDULED", "PAID_WITHOUT_ENTITLEMENT", "ZERO_CREDITS", "ENDING", "NO_SHOWS", "INACTIVE"].map((code) => ({ code }));
  const profile = { currentMembership: { id: "sub_pro" }, operations: { attentionItems: items } };
  assert.deepEqual(pageAttentionItems(profile, [{ subscriptionId: "sub_pro" }]).map((i) => i.code), ["ZERO_CREDITS", "ENDING", "NO_SHOWS", "INACTIVE"]);
  // The primary has no card (e.g. it is not among the current memberships): keep its alerts.
  assert.equal(pageAttentionItems(profile, [{ subscriptionId: "sub_other" }]).length, items.length);
});

test("Pagos KPI names the plan with a payment problem and never calls a failed charge 'Último pago'", () => {
  const cards = buildMembershipCards({ rows: MIXED_ROWS, billing: billing([PRO_FAILED, BOOTY_CASH_EXPIRED]), billingState: "ready", now: NOW });
  assert.deepEqual(paymentsKpi({ cards, lastPayment: { status: "FAILED", amountCents: 60000, currency: "mxn", membershipPlan: { name: "Pro" } } }), { value: "Pago fallido", sub: "Pro" });
  const two = buildMembershipCards({ rows: [MIXED_ROWS[0], row({ subscriptionId: "sub_b", planName: "Yoga", status: "PAST_DUE", isEntitled: false, lifecycleStatus: "PAST_DUE", primaryStatus: "PAST_DUE" })], billing: billing([PRO_FAILED, status({ subscriptionId: "sub_b", planName: "Yoga", state: "PAYMENT_PENDING", severity: "warning", isEntitled: false, lifecycleStatus: "PAST_DUE" })]), billingState: "ready", now: NOW });
  assert.deepEqual(paymentsKpi({ cards: two, lastPayment: null }), { value: "Pago fallido", sub: "Pro y 1 membresía más con incidencias" });
  const okCards = buildMembershipCards({ rows: [row()], billing: billing([status()]), billingState: "ready", now: NOW });
  assert.deepEqual(paymentsKpi({ cards: okCards, lastPayment: { status: "FAILED", amountCents: 60000, currency: "mxn", membershipPlan: { name: "Pro" } } }), { value: "Al corriente", sub: "Último intento fallido: $600.00 MXN · Pro" });
  const expiredCashOnly = buildMembershipCards({ rows: [MIXED_ROWS[1]], billing: billing([BOOTY_CASH_EXPIRED]), billingState: "ready", now: NOW });
  assert.deepEqual(paymentsKpi({ cards: expiredCashOnly, lastPayment: { status: "SUCCEEDED", amountCents: 80000, currency: "mxn", membershipPlan: { name: "Booty Lab by Etzia" } } }), { value: "Sin cobros pendientes", sub: "Último pago $800.00 MXN · Booty Lab by Etzia" });
  assert.equal(lastPaymentLine({ status: "REFUNDED", amountCents: 60000, currency: "mxn", membershipPlan: null }), "Último movimiento: reembolso de $600.00 MXN");
  assert.equal(lastPaymentLine(null), "Sin pago registrado");
});

// ── Timeline ──────────────────────────────────────────────────────────────────

type Ev = Pick<TimelineEvent, "type" | "metadata" | "occurredAt">;

test("10. timeline: a failed payment says what, how much and why, with running totals", () => {
  const ev: Ev = { type: "PAYMENT_FAILED", occurredAt: "2026-09-26T16:00:00.000Z", metadata: { planName: "Pro", amountCents: 60000, currency: "mxn", failure: failure() } };
  assert.equal(timelineDetail(ev), "Stripe intentó cobrar la renovación de Pro ($600.00 MXN), pero el banco emisor rechazó la tarjeta (código do_not_honor). Intentos hasta ahora: 7. Próximo intento: 9 oct.");
  // A retry date already in the past is not presented as upcoming.
  assert.equal(timelineDetail({ ...ev, metadata: { ...ev.metadata, failure: failure({ nextAttemptAt: "2026-10-01T00:00:00.000Z" }) } }), "Stripe intentó cobrar la renovación de Pro ($600.00 MXN), pero el banco emisor rechazó la tarjeta (código do_not_honor). Intentos hasta ahora: 7.");
  assert.equal(timelineDetail({ ...ev, metadata: { planName: "Pro", amountCents: 60000, currency: "mxn", failure: null } }), "Stripe intentó cobrar la membresía Pro ($600.00 MXN), pero el cobro no se completó.");
});

test("10b. timeline: a renewal change says who and when, never a consequence that may no longer hold", () => {
  const ev: Ev = { type: "STRIPE_RENEWAL_EXTERNAL_CHANGE", occurredAt: "2026-09-27T22:00:04.000Z", metadata: { planName: "Pro", renewalOrigin: "CUSTOMER_PORTAL", cancellationFeedback: "unused", newCancelAtPeriodEnd: true, currentPeriodEnd: "2026-10-26T15:00:00.000Z" } };
  assert.equal(timelineTitle(ev), "Renovación desactivada en Stripe");
  assert.equal(timelineDetail(ev), "La renovación automática de Pro se desactivó desde el portal de pagos de Stripe el 27 sep (el miembro respondió: «no la usa lo suficiente»).");
  assert.equal(/nuevo cobro|acceso hasta/.test(timelineDetail(ev) ?? ""), false);
  const gymos: Ev = { type: "STRIPE_RENEWAL_REACTIVATED", occurredAt: "2026-09-27T22:00:04.000Z", metadata: { planName: "Pro", renewalOrigin: "GYMOS_STAFF", newCancelAtPeriodEnd: false } };
  assert.equal(timelineDetail(gymos), "La renovación automática de Pro se reactivó desde GymOS el 27 sep.");
});

test("10c. timeline: why and by whom a subscription ended in Stripe", () => {
  const end = (metadata: Record<string, unknown>): Ev => ({ type: "STRIPE_SUBSCRIPTION_ENDED", occurredAt: "2026-09-28T02:14:01.000Z", metadata: { planName: "Full Access", ...metadata } });
  assert.equal(timelineTitle(end({ endOrigin: "STRIPE_AUTOMATIC", cancellationReason: "payment_failed" })), "Suscripción cancelada por falta de pago");
  assert.equal(timelineDetail(end({ endOrigin: "STRIPE_AUTOMATIC", cancellationReason: "payment_failed", failure: failure({ attemptCount: 9, reason: "INSUFFICIENT_FUNDS", code: "insufficient_funds" }) })), "Stripe canceló la suscripción de Full Access porque no pudo cobrar la renovación (9 intentos; fondos insuficientes).");
  assert.equal(timelineTitle(end({ endOrigin: "STRIPE_AUTOMATIC", cancellationReason: "payment_disputed" })), "Suscripción cancelada por disputa");
  assert.equal(timelineDetail(end({ endOrigin: "STRIPE_AUTOMATIC", cancellationReason: "payment_disputed" })), "Stripe canceló la suscripción de Full Access por una disputa (contracargo) de un pago.");
  assert.equal(timelineDetail(end({ endOrigin: "STRIPE_AUTOMATIC", cancellationReason: "incomplete_expired" })), "Stripe canceló la suscripción de Full Access porque el primer pago no se completó a tiempo.");
  assert.equal(timelineTitle(end({ endOrigin: "PERIOD_END", scheduledBy: "GYMOS" })), "Suscripción terminada al final del periodo");
  assert.equal(timelineDetail(end({ endOrigin: "PERIOD_END", scheduledBy: "GYMOS" })), "La suscripción de Full Access terminó al final del periodo porque la renovación automática estaba desactivada (se desactivó desde GymOS).");
  assert.equal(timelineDetail(end({ endOrigin: "PERIOD_END", scheduledBy: "CUSTOMER_PORTAL" })), "La suscripción de Full Access terminó al final del periodo porque la renovación automática estaba desactivada (la desactivó el miembro desde el portal de pagos de Stripe).");
  assert.equal(timelineDetail(end({ endOrigin: "PERIOD_END", scheduledBy: "STRIPE_TO_CASH" })), "La suscripción de Full Access con tarjeta terminó al final del periodo por el cambio programado a pago en recepción.");
  assert.equal(timelineDetail(end({ endOrigin: "PERIOD_END", scheduledBy: null })), "La suscripción de Full Access terminó al final del periodo porque la renovación automática estaba desactivada.");
  assert.equal(timelineDetail(end({ endOrigin: "CUSTOMER_PORTAL", cancellationFeedback: "too_expensive" })), "La suscripción de Full Access se canceló desde el portal de pagos de Stripe (el miembro respondió: «le parece caro»).");
  assert.equal(timelineDetail(end({ endOrigin: "STRIPE_TO_CASH" })), "La suscripción de Full Access con tarjeta terminó por el cambio a pago en recepción.");
  assert.equal(timelineDetail(end({ endOrigin: "STRIPE_API" })), "La suscripción de Full Access se canceló desde el panel de Stripe u otra integración (no desde GymOS).");
  assert.equal(timelineDetail(end({ endOrigin: "STRIPE_NO_REQUEST" })), "La suscripción de Full Access se canceló en Stripe, fuera de GymOS.");
});

test("10d. timeline: Stripe→cash, done vs scheduled", () => {
  assert.equal(timelineTitle({ type: "STRIPE_TO_CASH_IMMEDIATE", metadata: {} }), "Cambio a pago en recepción");
  assert.equal(timelineDetail({ type: "STRIPE_TO_CASH_IMMEDIATE", occurredAt: "2026-10-01T14:00:01.000Z", metadata: { planName: "Basic Access" } }), "El cobro con tarjeta de Basic Access se detuvo para cobrar en recepción.");
  assert.equal(timelineTitle({ type: "STRIPE_TO_CASH_PERIOD_END_SCHEDULED", metadata: {} }), "Cambio a pago en recepción programado");
  assert.equal(timelineDetail({ type: "STRIPE_TO_CASH_PERIOD_END_SCHEDULED", occurredAt: "2026-10-01T14:00:01.000Z", metadata: { planName: "Basic Access" } }), "Se programó el cambio a pago en recepción: el cobro con tarjeta de Basic Access se detendrá al terminar el periodo pagado.");
  assert.equal(timelineDetail({ type: "BOOKING_CREATED", occurredAt: "2026-10-01T00:00:00.000Z", metadata: null }), null);
});
