import type {
  MemberBillingStatus,
  MemberProfile,
  MembershipBillingStatus,
  PaymentFailureView,
  PrimaryLifecycleStatus,
  RenewalChangeOrigin,
  SubscriptionEndOrigin,
  TimelineEvent,
} from "@/lib/api/members";

/**
 * Member 360 billing copy. The API classifies (one canonical state per membership, with
 * certainty); this module only words it, in operator Spanish. Rules:
 * - never state as fact what the API marks as inferred (word it as an inference);
 * - access dates come from the membership's own entitlement (effectiveEnd), never Stripe's end;
 * - history (timeline) says what happened then, never a consequence that may no longer hold.
 * Pure: no runtime imports, so the page and the node tests share it.
 */

export type Tone = "ok" | "info" | "warning" | "critical" | "neutral";

const STUDIO_TIME_ZONE = "America/Mexico_City";

/** "26 oct" in the studio's timezone (as studioDate); "2 sep 2027" when it is not this year. */
export function day(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "—";
  const date = new Date(iso);
  const year = (d: Date) => new Intl.DateTimeFormat("es-MX", { timeZone: STUDIO_TIME_ZONE, year: "numeric" }).format(d);
  const withYear = year(date) !== year(now);
  return new Intl.DateTimeFormat("es-MX", { timeZone: STUDIO_TIME_ZONE, day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) }).format(date).replace(".", "");
}

/** "$600.00 MXN" */
export function amount(cents: number, currency: string): string {
  return `$${(cents / 100).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency.toUpperCase()}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// ── Reasons ───────────────────────────────────────────────────────────────────

const FEEDBACK_ES: Record<string, string> = {
  too_expensive: "le parece caro",
  missing_features: "le faltan funciones",
  switched_service: "cambió de servicio",
  unused: "no la usa lo suficiente",
  customer_service: "no quedó satisfecho con la atención",
  too_complex: "le resulta complicado",
  low_quality: "no le convenció la calidad",
  other: "otro motivo",
};

export function feedbackLabel(feedback: string | null | undefined): string | null {
  if (!feedback) return null;
  return FEEDBACK_ES[feedback] ?? feedback;
}

const ROLE_ES: Record<string, string> = { OWNER: "Dueño", ADMIN: "Administración", STAFF: "Staff", FRONT_DESK: "Recepción", INSTRUCTOR: "Instructor" };

/** "Ana López · ADMIN" → "Ana López · Administración". */
export function actorLabel(actorName: string | null | undefined): string | null {
  if (!actorName) return null;
  return actorName.replace(/ · ([A-Z_]+)$/, (_m, role: string) => ` · ${ROLE_ES[role] ?? role}`);
}

/** "…pero <frase>": why the charge did not go through. Never guesses. */
export function failureReasonPhrase(failure: Pick<PaymentFailureView, "reason" | "code" | "liveLookup">): string {
  switch (failure.reason) {
    case "INSUFFICIENT_FUNDS":
      return "la tarjeta fue rechazada por fondos insuficientes";
    case "EXPIRED_CARD":
      return "la tarjeta está vencida";
    case "INCORRECT_CVC":
      return "el código de seguridad (CVC) no coincide";
    case "AUTHENTICATION_REQUIRED":
      return "la tarjeta requiere que el miembro autentique el pago con su banco (3D Secure)";
    case "BLOCKED_BY_STRIPE":
      return "Stripe bloqueó el cargo con su sistema antifraude";
    case "CARD_NOT_SUPPORTED":
      return "la tarjeta no acepta este tipo de cargo";
    case "PROCESSING_ERROR":
      return "hubo un error de procesamiento con la tarjeta";
    case "CARD_DECLINED":
      return failure.code ? `el banco emisor rechazó la tarjeta (código ${failure.code})` : "el banco emisor rechazó la tarjeta";
    case "NO_PAYMENT_METHOD":
      return "no hay un método de pago válido para cobrarla";
    case "OTHER":
      return failure.code ? `el cobro fue rechazado (código ${failure.code})` : "el cobro fue rechazado";
    case "UNKNOWN":
    default:
      if (failure.liveLookup === "unavailable") return "el cobro no se completó (no se pudo consultar el motivo en Stripe en este momento)";
      if (failure.liveLookup === "skipped") return "el cobro no se completó (no se consultó el motivo en Stripe)";
      return "el cobro no se completó (Stripe no informó el motivo)";
  }
}

/** Short form for summaries: "fondos insuficientes", "tarjeta rechazada por el banco"… */
export function failureReasonShort(failure: Pick<PaymentFailureView, "reason" | "code">): string {
  switch (failure.reason) {
    case "INSUFFICIENT_FUNDS": return "fondos insuficientes";
    case "EXPIRED_CARD": return "tarjeta vencida";
    case "INCORRECT_CVC": return "CVC incorrecto";
    case "AUTHENTICATION_REQUIRED": return "requiere autenticación";
    case "BLOCKED_BY_STRIPE": return "bloqueado por el antifraude de Stripe";
    case "CARD_NOT_SUPPORTED": return "tarjeta no admitida";
    case "PROCESSING_ERROR": return "error de procesamiento";
    case "CARD_DECLINED": return failure.code ? `tarjeta rechazada por el banco (${failure.code})` : "tarjeta rechazada por el banco";
    case "NO_PAYMENT_METHOD": return "sin método de pago";
    case "OTHER": return failure.code ? `cobro rechazado (${failure.code})` : "cobro rechazado";
    default: return "motivo no disponible";
  }
}

/** What Stripe was charging: renewal, first payment, plan change… (from the invoice's billing reason). */
export function chargeSubject(billingReason: string | null | undefined, planName: string | null | undefined): string {
  const plan = planName ? ` de ${planName}` : "";
  switch (billingReason) {
    case "subscription_cycle": return `la renovación${plan}`;
    case "subscription_create": return `el primer pago${plan}`;
    case "subscription_update": return `el ajuste de plan${plan}`;
    default: return planName ? `la membresía ${planName}` : "la membresía";
  }
}

/** Who switched auto-renewal off/on, worded by how sure we are. */
export function renewalChangeSentence(change: NonNullable<MembershipBillingStatus["renewal"]["change"]>, planName?: string | null): string {
  const what = planName ? `la renovación automática de ${planName}` : "la renovación automática";
  const reflexive = change.disabled ? "se desactivó" : "se reactivó";
  const motive = feedbackLabel(change.feedback);
  const answered = motive ? ` (el miembro respondió: «${motive}»)` : "";
  const at = day(change.at);
  switch (change.origin) {
    case "CUSTOMER_PORTAL":
      return `${capitalize(what)} ${reflexive} desde el portal de pagos de Stripe el ${at}${answered}.`;
    case "STRIPE_NO_REQUEST":
      return `${capitalize(what)} ${reflexive} en Stripe el ${at}, fuera de GymOS (probablemente desde el portal de pagos)${answered}.`;
    case "STRIPE_API":
      return `${capitalize(what)} ${reflexive} el ${at} desde el panel de Stripe u otra integración (no desde GymOS).`;
    case "GYMOS_STAFF": {
      const actor = actorLabel(change.actorName);
      return `${capitalize(what)} ${reflexive} desde GymOS el ${at}${actor ? ` (${actor})` : ""}.`;
    }
    case "GYMOS":
      return `${capitalize(what)} ${reflexive} desde GymOS el ${at}.`;
    case "STRIPE_TO_CASH":
      return `El cobro con tarjeta${planName ? ` de ${planName}` : ""} se detuvo el ${at} por el cambio a pago en recepción.`;
    default:
      return `${capitalize(what)} ${reflexive} el ${at}.`;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const STRIPE_STATUS_ES: Record<string, string> = {
  active: "activa",
  trialing: "en prueba",
  past_due: "con pago vencido",
  unpaid: "impaga",
  paused: "en pausa",
  incomplete: "incompleta",
  canceled: "cancelada",
  incomplete_expired: "cancelada",
};
const LOCAL_STATUS_ES: Record<string, string> = { PAST_DUE: "Pago pendiente", ACTIVE: "Activa", TRIALING: "Prueba", PAUSED: "Pausada", CANCELED: "Cancelada" };

// ── Per-membership copy ───────────────────────────────────────────────────────

export type CardAction = { label: string; detail: string; tab?: "billing" | "membership"; href?: string };

export type BillingCopy = {
  paymentLabel: string;
  tone: Tone;
  /** True when this membership needs a payment-related follow-up (drives the Pagos KPI). */
  paymentProblem: boolean;
  /** Sentences explaining the state, in reading order. */
  explanation: string[];
  /** A guard-rail for staff (e.g. avoid a double charge). */
  caution: string | null;
  action: CardAction | null;
};

const TONE_BY_SEVERITY: Record<MembershipBillingStatus["severity"], Tone> = { ok: "ok", info: "info", warning: "warning", critical: "critical" };

const ACTIONS: Record<NonNullable<MembershipBillingStatus["action"]>, CardAction> = {
  UPDATE_PAYMENT_METHOD: { label: "Ver facturación", detail: "Pide al miembro que actualice su tarjeta desde la app (portal de pagos de Stripe) para que Stripe pueda cobrar la factura.", tab: "billing" },
  COMPLETE_AUTHENTICATION: { label: "Ver facturación", detail: "Pide al miembro que pague la factura pendiente desde la app para completar la autenticación de su banco (3D Secure).", tab: "billing" },
  RENEW_MANUALLY: { label: "Ir a Ventas", detail: "Si el miembro quiere continuar, registra la renovación en Ventas.", href: "/sales" },
  REVIEW_BILLING: { label: "Ver facturación", detail: "Revisa el cobro en Stripe antes de renovar o cobrar de nuevo.", tab: "billing" },
  RECONCILE: { label: "Ver facturación", detail: "Avisa a un administrador: GymOS y Stripe no coinciden. No cobres ni cambies el estado de la membresía hasta conciliarlo.", tab: "billing" },
};

const DOUBLE_CHARGE_CAUTION = "No registres un cobro en efectivo por este periodo mientras la factura siga abierta en Stripe: se cobraría dos veces.";

export function billingCopy(status: MembershipBillingStatus): BillingCopy {
  const plan = status.planName;
  const failure = status.paymentFailure;
  const change = status.renewal.change;
  const tone = TONE_BY_SEVERITY[status.severity];
  const action = status.action ? ACTIONS[status.action] : null;
  const renewalOffSentence = change?.disabled ? renewalChangeSentence(change, plan) : status.renewal.mode === "DISABLED" ? `La renovación automática de ${plan} está desactivada.` : null;
  const lines = (...items: Array<string | null | undefined | false>) => items.filter((x): x is string => typeof x === "string" && x.length > 0);
  const mismatchLine = status.statusMismatch ? `GymOS todavía la muestra como «${LOCAL_STATUS_ES[status.statusMismatch.local] ?? status.statusMismatch.local}»: requiere conciliación.` : null;
  const base = { tone, action };

  switch (status.state) {
    case "AUTO_RENEW_OK":
      return { ...base, paymentLabel: "Al corriente", paymentProblem: false, explanation: lines(status.renewal.nextChargeAt ? `Renovación automática con tarjeta. Próximo cobro: ${day(status.renewal.nextChargeAt)}.` : "Renovación automática con tarjeta."), caution: null };

    case "RENEWAL_DISABLED":
      return {
        ...base,
        paymentLabel: "Al corriente",
        paymentProblem: false,
        explanation: lines(renewalOffSentence, `La membresía sigue activa hasta el ${day(status.effectiveEnd)} y no volverá a cobrarse automáticamente.`),
        caution: null,
      };

    case "PAYMENT_FAILED":
    case "PAYMENT_FAILED_RETRYING":
    case "PAYMENT_FAILED_FINAL":
    case "PAYMENT_ACTION_REQUIRED": {
      const closed = failure?.invoiceStatus === "void" || failure?.invoiceStatus === "uncollectible";
      // The reason is the latest attempt's; dates live in the attempts line, not next to it.
      const charged = failure
        ? `Stripe intentó cobrar ${chargeSubject(failure.billingReason, plan)} (${amount(failure.amountCents, failure.currency)}), pero ${failureReasonPhrase(failure)}.`
        : `Stripe no pudo cobrar ${chargeSubject(null, plan)}.`;
      const attempts = !failure?.attemptCount
        ? null
        : failure.attemptCount === 1
          ? `1 intento fallido (${day(failure.lastAttemptAt ?? failure.firstFailedAt)}).`
          : `${failure.attemptCount} intentos fallidos desde el ${day(failure.firstFailedAt)}${failure.lastAttemptAt ? `; el último, el ${day(failure.lastAttemptAt)}` : ""}.`;
      const nextAt = failure?.nextAttemptAt ? new Date(failure.nextAttemptAt) : null;
      const next =
        failure?.invoiceStatus === "uncollectible"
          ? "La factura quedó marcada como incobrable en Stripe: ya no se intentará cobrar."
          : failure?.invoiceStatus === "void"
            ? "La factura fue anulada en Stripe: ya no se cobrará."
            : status.state === "PAYMENT_FAILED_RETRYING" && nextAt
              ? nextAt.getTime() > Date.now()
                ? `Stripe volverá a intentarlo el ${day(failure!.nextAttemptAt)}.`
                : `Stripe tenía programado otro intento el ${day(failure!.nextAttemptAt)}; su resultado aún no se refleja.`
              : status.state === "PAYMENT_FAILED_FINAL"
                ? "Stripe ya no reintentará el cobro automáticamente; la factura sigue abierta."
                : status.state === "PAYMENT_FAILED"
                  ? "No se pudo confirmar en Stripe si habrá otro intento."
                  : null;
      const ending = status.renewal.mode === "DISABLED" && renewalOffSentence ? `${renewalOffSentence} Aunque se recupere este pago, la membresía termina el ${day(status.renewal.endsAt)}.` : null;
      const access = status.isEntitled ? null : closed ? `Sin acceso a ${plan}.` : `Sin acceso a ${plan} mientras el pago esté pendiente.`;
      return {
        ...base,
        paymentLabel: status.state === "PAYMENT_ACTION_REQUIRED" ? "Requiere autenticación" : closed ? "Factura cerrada sin pago" : "Pago fallido",
        paymentProblem: true,
        explanation: lines(charged, attempts, next, ending, access),
        caution: closed ? null : DOUBLE_CHARGE_CAUTION,
      };
    }

    case "PAYMENT_PENDING":
      return {
        ...base,
        paymentLabel: "Pago pendiente",
        paymentProblem: true,
        explanation: lines(
          status.stripe?.status === "incomplete"
            ? `El primer pago de ${plan} no se completó en Stripe.`
            : `Stripe aún no confirma el pago de ${plan}; no hay un intento de cobro fallido registrado.`,
          renewalOffSentence,
          status.isEntitled ? null : `Sin acceso a ${plan} mientras el pago esté pendiente.`,
        ),
        caution: "No registres un cobro en efectivo por este periodo sin revisar Stripe: podría cobrarse dos veces.",
      };

    case "INVOICE_PAID_IN_STRIPE":
      return {
        ...base,
        paymentLabel: "Pagado en Stripe",
        paymentProblem: true,
        explanation: lines(`Stripe registra la factura de ${plan} como pagada, pero GymOS aún muestra el pago como fallido.`),
        caution: "No cobres de nuevo: requiere conciliación.",
      };

    case "STATUS_MISMATCH": {
      const local = status.statusMismatch?.local ?? "";
      const stripeLabel = STRIPE_STATUS_ES[status.statusMismatch?.stripe ?? ""] ?? status.statusMismatch?.stripe ?? "";
      const observed = status.stripe?.observedAt ? ` (último dato de Stripe: ${day(status.stripe.observedAt)})` : "";
      const ended = local === "CANCELED" || local === "PAUSED";
      return {
        ...base,
        paymentLabel: ended ? "Stripe sigue activa" : "Pago vencido en Stripe",
        paymentProblem: true,
        explanation: lines(
          ended
            ? `En GymOS la membresía ${plan} está ${local === "CANCELED" ? "cancelada" : "pausada"}, pero Stripe la registra como ${stripeLabel}${observed} y puede seguir cobrándola.`
            : `Stripe registra la suscripción de ${plan} como ${stripeLabel}${observed}, pero GymOS la muestra al corriente.`,
        ),
        caution: ended ? "No vendas otra membresía ni cobres en efectivo hasta conciliar con Stripe." : "Revisa la factura en Stripe antes de cobrar o renovar.",
      };
    }

    case "CANCELED_PAYMENT_FAILED": {
      const at = day(status.stripe?.endedAt ?? status.stripe?.canceledAt ?? status.renewal.endsAt);
      const why = status.stripe?.status === "incomplete_expired"
        ? "porque el primer pago no se completó a tiempo"
        : `porque no pudo cobrar ${chargeSubject(failure?.billingReason ?? "subscription_cycle", null)}${failure ? ` (${failure.attemptCount ? `${failure.attemptCount} intentos; ` : ""}${failureReasonShort(failure)})` : ""}`;
      return {
        ...base,
        paymentLabel: "Cancelada por falta de pago",
        paymentProblem: true,
        explanation: lines(`Stripe canceló la suscripción de ${plan} el ${at} ${why}.`, mismatchLine),
        caution: status.statusMismatch ? "No cobres de nuevo sin revisar Stripe." : null,
      };
    }

    case "CANCELED": {
      const at = day(status.stripe?.endedAt ?? status.stripe?.canceledAt ?? status.renewal.endsAt);
      const first =
        status.stripe?.cancellationReason === "payment_disputed"
          ? `Stripe canceló la suscripción de ${plan} el ${at} por una disputa (contracargo) de un pago.`
          : status.stripe?.cancellationReason === "cancellation_requested"
            ? `La suscripción de ${plan} se canceló el ${at} por solicitud (no por falta de pago).`
            : `La suscripción de ${plan} está cancelada.`;
      return {
        ...base,
        paymentLabel: "Cancelada",
        paymentProblem: status.statusMismatch !== null,
        explanation: lines(first, change ? renewalChangeSentence(change, plan) : null, status.isEntitled ? `Conserva acceso hasta el ${day(status.effectiveEnd)}.` : null, mismatchLine),
        caution: status.statusMismatch ? "No cobres de nuevo sin revisar Stripe." : null,
      };
    }

    case "ENDED_NOT_RENEWED":
      return { ...base, paymentLabel: "Sin cobros pendientes", paymentProblem: false, explanation: lines(renewalOffSentence, `La membresía terminó el ${day(status.effectiveEnd)} sin un nuevo cobro.`), caution: null };

    case "EXPIRED_UNPAID":
      return {
        ...base,
        paymentLabel: "Sin pago de renovación",
        paymentProblem: true,
        explanation: lines(`La membresía venció el ${day(status.effectiveEnd)} y GymOS no tiene registrado un pago de renovación; en Stripe la suscripción sigue activa.`),
        caution: "Revisa Stripe antes de renovar o cobrar: el cargo podría haberse hecho ya.",
      };

    case "PAID_WITHOUT_ENTITLEMENT":
      return { ...base, paymentLabel: "Pagado sin acceso", paymentProblem: true, explanation: lines(`Pago con tarjeta recibido para ${plan} sin ciclo de acceso.`), caution: "No cobres de nuevo: requiere conciliación." };

    case "MANUAL_ACTIVE":
      return status.source === "MANUAL"
        ? { ...base, paymentLabel: "Asignada manualmente", paymentProblem: false, explanation: lines(`Asignada manualmente por el personal: no se cobra automáticamente. Vence el ${day(status.effectiveEnd)}.`), caution: null }
        : { ...base, paymentLabel: "Pagada en recepción", paymentProblem: false, explanation: lines(`Se paga en recepción: no se cobra automáticamente. Vence el ${day(status.effectiveEnd)}.`), caution: null };

    case "MANUAL_EXPIRED":
      return {
        ...base,
        paymentLabel: "Renovación manual",
        paymentProblem: false,
        explanation: lines(
          status.source === "MANUAL"
            ? `Esta membresía fue asignada manualmente y venció el ${day(status.effectiveEnd)}. Requiere renovación manual.`
            : `Esta membresía se paga en recepción y venció el ${day(status.effectiveEnd)}. Requiere renovación manual.`,
        ),
        caution: null,
      };

    case "REPLACED":
      return { ...base, paymentLabel: "Reemplazada", paymentProblem: status.statusMismatch !== null, explanation: lines("Reemplazada por otra membresía (cambio de forma de pago, renovación o plan).", mismatchLine), caution: null };

    case "SCHEDULED":
      return { ...base, paymentLabel: "Programada", paymentProblem: false, explanation: lines("Programada; aún no está vigente."), caution: null };

    case "PAUSED":
      return {
        ...base,
        paymentLabel: "Pausada",
        paymentProblem: status.source === "STRIPE" && status.certainty === "inferred",
        explanation: lines(
          status.source !== "STRIPE"
            ? "Pausada en GymOS; no se cobra mientras esté en pausa."
            : status.certainty === "confirmed"
              ? "La suscripción está en pausa en Stripe; no se realizan cobros."
              : "Pausada en GymOS; no se pudo confirmar el estado en Stripe.",
        ),
        caution: null,
      };

    default:
      return {
        ...base,
        tone: "neutral",
        paymentLabel: status.source === "STRIPE" ? "Revisar en Stripe" : "Sin detalle",
        paymentProblem: status.source === "STRIPE",
        explanation: lines(status.source === "STRIPE" ? "No hay información suficiente para explicar el estado de cobro. Revisa la suscripción en Stripe." : "No hay información suficiente para explicar el estado de esta membresía."),
        caution: null,
      };
  }
}

// ── Top-of-page membership cards ──────────────────────────────────────────────

/** Normalized membership row (from profile.memberships, or currentMembership when none). */
export type MembershipCardInput = {
  subscriptionId: string;
  planName: string;
  source: "STRIPE" | "CASH" | "MANUAL" | "NONE";
  status: string;
  lifecycleStatus: string;
  /** API operational status; absent on older APIs. */
  primaryStatus?: PrimaryLifecycleStatus | null;
  isEntitled: boolean;
  currentPeriodStart: string | null;
  effectiveEnd: string | null;
  cancelAtPeriodEnd: boolean;
  classCredits: number | null;
  creditsUsed: number | null;
  creditsRemaining: number | null;
  paidWithoutEntitlement?: boolean;
};

export type MembershipCard = {
  subscriptionId: string;
  planName: string;
  severity: MembershipBillingStatus["severity"];
  status: { label: string; tone: Tone };
  payment: { label: string; tone: Tone };
  paymentProblem: boolean;
  facts: Array<{ label: string; value: string }>;
  explanation: string[];
  caution: string | null;
  action: CardAction | null;
};

const SEVERITY_RANK: Record<MembershipBillingStatus["severity"], number> = { critical: 0, warning: 1, info: 2, ok: 3 };

/** Access status of a membership, from the API's operational status. */
export function membershipStatusLabel(row: Pick<MembershipCardInput, "primaryStatus" | "isEntitled" | "lifecycleStatus" | "effectiveEnd">, now: Date = new Date()): { label: string; tone: Tone } {
  const primary = row.primaryStatus ?? (row.lifecycleStatus === "ENDING" ? "ACTIVE" : row.lifecycleStatus);
  switch (primary) {
    case "ACTIVE": {
      // "Ending soon" only when it will really end: renewal off, cancelled, or paid at the desk.
      const end = row.effectiveEnd ? new Date(row.effectiveEnd).getTime() : null;
      if (row.lifecycleStatus === "ENDING" && end !== null && end - now.getTime() <= 7 * 86_400_000) return { label: "Activa · termina pronto", tone: "warning" };
      return { label: "Activa", tone: "ok" };
    }
    case "TRIALING": return { label: "Prueba", tone: "info" };
    case "EXPIRED": return { label: "Vencida", tone: "critical" };
    case "PAST_DUE": return { label: "Sin acceso", tone: "critical" };
    case "PAUSED": return { label: "Pausada", tone: "warning" };
    case "SCHEDULED": return { label: "Programada", tone: "info" };
    case "CANCELED": return { label: "Cancelada", tone: "neutral" };
    case "REPLACED": return { label: "Reemplazada", tone: "neutral" };
    default: return row.isEntitled ? { label: "Activa", tone: "ok" } : { label: "Sin acceso", tone: "warning" };
  }
}

function sourceLabel(source: MembershipCardInput["source"]): string {
  return source === "STRIPE" ? "Tarjeta (Stripe)" : source === "CASH" ? "Efectivo / transferencia" : source === "MANUAL" ? "Asignación manual" : "—";
}

function renewalFact(row: MembershipCardInput, status: MembershipBillingStatus | null): string {
  const manual = row.source === "MANUAL" ? "Manual (asignada)" : "Manual (en recepción)";
  if (status) {
    switch (status.renewal.mode) {
      case "AUTOMATIC": return status.renewal.nextChargeAt ? `Automática · próximo cobro ${day(status.renewal.nextChargeAt)}` : "Automática";
      case "DISABLED": return `No renovará · termina el ${day(status.renewal.endsAt)}`;
      case "MANUAL": return manual;
      case "ENDED": return "Terminada";
      default: return "—";
    }
  }
  if (row.source !== "STRIPE") return manual;
  return row.cancelAtPeriodEnd ? "No renovará" : "Automática";
}

function creditsFact(row: MembershipCardInput): string {
  if (row.classCredits === null) return "Ilimitado";
  const used = `${row.creditsUsed ?? 0} / ${row.classCredits} usados`;
  const remaining = row.creditsRemaining ?? 0;
  if (!row.isEntitled) return `${used} · ${plural(remaining, "sin usar", "sin usar")} (ya no dan acceso)`;
  return `${used} · ${plural(remaining, "restante", "restantes")}`;
}

/** Local-only wording while the billing explanation loads, if it failed, or if it has no row. */
function fallbackCopy(row: MembershipCardInput, billing: "loading" | "error" | "missing"): BillingCopy {
  const pending = billing === "loading" ? "Consultando el detalle del cobro…" : billing === "error" ? "No se pudo cargar el detalle del cobro." : "Sin detalle de cobro para esta membresía.";
  if (row.paidWithoutEntitlement) {
    return { paymentLabel: "Pagado sin acceso", tone: "critical", paymentProblem: true, explanation: [`Pago con tarjeta recibido para ${row.planName} sin ciclo de acceso.`], caution: "No cobres de nuevo: requiere conciliación.", action: ACTIONS.REVIEW_BILLING };
  }
  if (row.source !== "STRIPE") {
    if (row.isEntitled) return { paymentLabel: row.source === "MANUAL" ? "Asignada manualmente" : "Pagada en recepción", tone: "ok", paymentProblem: false, explanation: [], caution: null, action: null };
    return { paymentLabel: "Renovación manual", tone: "warning", paymentProblem: false, explanation: [], caution: null, action: null };
  }
  if (row.status === "PAST_DUE") return { paymentLabel: "Pago pendiente", tone: "critical", paymentProblem: true, explanation: [pending], caution: "No registres un cobro en efectivo por este periodo sin revisar Stripe: podría cobrarse dos veces.", action: null };
  if (row.isEntitled) return { paymentLabel: "Al corriente", tone: "ok", paymentProblem: false, explanation: [], caution: null, action: null };
  if (row.status === "ACTIVE" || row.status === "TRIALING") {
    // Same guard as renewalRequiresBillingReview: Stripe still renews this card subscription.
    return { paymentLabel: "Revisar cobro", tone: "warning", paymentProblem: true, explanation: [pending], caution: "Stripe sigue cobrando esta suscripción: revisa el cobro antes de renovar.", action: null };
  }
  return { paymentLabel: "Revisar cobro", tone: "warning", paymentProblem: false, explanation: [pending], caution: null, action: null };
}

export function buildMembershipCards(input: {
  rows: readonly MembershipCardInput[];
  billing: MemberBillingStatus | null;
  billingState: "loading" | "ready" | "error";
  now?: Date;
}): MembershipCard[] {
  const now = input.now ?? new Date();
  const cards = input.rows.map((row): MembershipCard => {
    const status = input.billing?.memberships.find((m) => m.subscriptionId === row.subscriptionId) ?? null;
    const copy = status ? billingCopy(status) : fallbackCopy(row, input.billingState === "ready" ? "missing" : input.billingState);
    const severity: MembershipCard["severity"] = status?.severity ?? (copy.tone === "critical" ? "critical" : copy.tone === "warning" ? "warning" : "ok");
    return {
      subscriptionId: row.subscriptionId,
      planName: row.planName,
      severity,
      status: membershipStatusLabel(row, now),
      payment: { label: copy.paymentLabel, tone: copy.tone },
      paymentProblem: copy.paymentProblem,
      facts: [
        { label: row.isEntitled ? "Vigencia" : "Último periodo", value: `${day(row.currentPeriodStart)} → ${day(row.effectiveEnd)}` },
        { label: "Créditos", value: creditsFact(row) },
        { label: "Renovación", value: renewalFact(row, status) },
        { label: "Método de pago", value: sourceLabel(row.source) },
      ],
      explanation: copy.explanation,
      caution: copy.caution,
      action: copy.action,
    };
  });
  return cards.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/**
 * One row per current membership (scheduled successors stay in the Membresía tab). With none
 * current, the latest membership in any state, so an ended card subscription still gets its "why".
 */
export function membershipCardRows(profile: Pick<MemberProfile, "memberships" | "currentMembership">): MembershipCardInput[] {
  const current = (profile.memberships ?? []).filter((m) => m.status !== "SCHEDULED");
  if (current.length > 0) {
    return current.map((m) => ({
      subscriptionId: m.subscriptionId,
      planName: m.plan.name,
      source: m.source,
      status: m.status,
      lifecycleStatus: m.lifecycleStatus,
      primaryStatus: m.primaryStatus ?? null,
      isEntitled: m.isEntitled,
      currentPeriodStart: m.currentPeriodStart,
      effectiveEnd: m.effectiveEnd,
      cancelAtPeriodEnd: m.cancelAtPeriodEnd,
      classCredits: m.plan.classCredits,
      creditsUsed: m.creditsUsed,
      creditsRemaining: m.creditsRemaining,
      paidWithoutEntitlement: Boolean(m.paidWithoutEntitlement),
    }));
  }
  const c = profile.currentMembership;
  if (!c) return [];
  return [{
    subscriptionId: c.id,
    planName: c.plan.name,
    source: c.source,
    status: c.status,
    lifecycleStatus: c.lifecycleStatus,
    primaryStatus: c.primaryStatus,
    isEntitled: c.isEntitled,
    currentPeriodStart: c.currentPeriodStart,
    effectiveEnd: c.effectiveEnd,
    cancelAtPeriodEnd: c.cancelAtPeriodEnd,
    classCredits: c.plan.classCredits,
    creditsUsed: c.creditsUsed,
    creditsRemaining: c.creditsRemaining,
    paidWithoutEntitlement: Boolean(c.paidWithoutEntitlement),
  }];
}

/** Attention codes a membership card fully expresses (state, reason, plan, action). */
const CARD_EXPRESSED_CODES = new Set(["PAID_WITHOUT_ENTITLEMENT", "PAST_DUE", "EXPIRED", "CANCELLATION_SCHEDULED"]);

/**
 * The "Atención requerida" list without the items the cards already explain. API attention items
 * describe the primary membership: they are only dropped when that membership has a card.
 * Credits and "ending soon" nudges stay (with their "Renovar" shortcut).
 */
export function pageAttentionItems<T extends { code: string }>(
  profile: { currentMembership: { id: string } | null; operations: { attentionItems: T[] } },
  cards: readonly Pick<MembershipCard, "subscriptionId">[],
): T[] {
  const primaryHasCard = profile.currentMembership !== null && cards.some((c) => c.subscriptionId === profile.currentMembership!.id);
  return profile.operations.attentionItems.filter((item) => !(primaryHasCard && CARD_EXPRESSED_CODES.has(item.code)));
}

// ── KPI "Pagos" ───────────────────────────────────────────────────────────────

type LastPayment = { status: string; amountCents: number; currency: string; membershipPlan?: { name: string } | null } | null;

/** "Último pago …" only for a successful payment; a failed charge is never labelled as a payment. */
export function lastPaymentLine(last: LastPayment): string {
  if (!last) return "Sin pago registrado";
  const plan = last.membershipPlan ? ` · ${last.membershipPlan.name}` : "";
  const value = amount(last.amountCents, last.currency);
  switch (last.status) {
    case "SUCCEEDED": return `Último pago ${value}${plan}`;
    case "FAILED": return `Último intento fallido: ${value}${plan}`;
    case "REFUNDED": return `Último movimiento: reembolso de ${value}${plan}`;
    case "PARTIALLY_REFUNDED": return `Último movimiento: reembolso parcial de ${value}${plan}`;
    case "PENDING": return `Pago pendiente de ${value}${plan}`;
    default: return `Último movimiento: ${value}${plan}`;
  }
}

export function paymentsKpi(input: { cards: readonly MembershipCard[]; lastPayment: LastPayment }): { value: string; sub: string } {
  const lastLine = lastPaymentLine(input.lastPayment);
  if (input.cards.length === 0) return { value: "No aplica", sub: lastLine };
  const problems = input.cards.filter((c) => c.paymentProblem);
  if (problems.length === 0) {
    const anyCurrent = input.cards.some((c) => c.status.label.startsWith("Activa") || c.status.label === "Prueba");
    return { value: anyCurrent ? "Al corriente" : "Sin cobros pendientes", sub: lastLine };
  }
  const worst = problems[0];
  const others = problems.length - 1;
  return { value: worst.payment.label, sub: `${worst.planName}${others > 0 ? ` y ${plural(others, "membresía más", "membresías más")} con incidencias` : ""}` };
}

// ── Timeline ──────────────────────────────────────────────────────────────────

type Md = Record<string, unknown>;
const mdStr = (md: Md, key: string): string | null => (typeof md[key] === "string" && md[key] ? (md[key] as string) : null);
const mdFailure = (md: Md): PaymentFailureView | null => (md["failure"] && typeof md["failure"] === "object" ? (md["failure"] as PaymentFailureView) : null);

export function timelineTitle(ev: Pick<TimelineEvent, "type" | "metadata">): string | null {
  const md: Md = ev.metadata ?? {};
  switch (ev.type) {
    case "STRIPE_RENEWAL_EXTERNAL_CHANGE":
      return md["newCancelAtPeriodEnd"] === true ? "Renovación desactivada en Stripe" : md["newCancelAtPeriodEnd"] === false ? "Renovación reactivada en Stripe" : null;
    case "STRIPE_SUBSCRIPTION_ENDED": {
      const reason = mdStr(md, "cancellationReason");
      if (md["endOrigin"] === "STRIPE_AUTOMATIC") return reason === "payment_disputed" ? "Suscripción cancelada por disputa" : "Suscripción cancelada por falta de pago";
      if (md["endOrigin"] === "PERIOD_END") return "Suscripción terminada al final del periodo";
      return "Suscripción cancelada en Stripe";
    }
    case "STRIPE_TO_CASH_IMMEDIATE":
      return "Cambio a pago en recepción";
    case "STRIPE_TO_CASH_PERIOD_END_SCHEDULED":
      return "Cambio a pago en recepción programado";
    default:
      return null;
  }
}

/** The "what happened and why" line under a billing event, or null to keep the API description. */
export function timelineDetail(ev: Pick<TimelineEvent, "type" | "metadata" | "occurredAt">): string | null {
  const md: Md = ev.metadata ?? {};
  const plan = mdStr(md, "planName");
  switch (ev.type) {
    case "PAYMENT_FAILED": {
      const failure = mdFailure(md);
      const cents = typeof md["amountCents"] === "number" ? (md["amountCents"] as number) : null;
      const currency = mdStr(md, "currency");
      const charged = cents !== null && currency ? ` (${amount(cents, currency)})` : "";
      if (!failure) return plan ? `Stripe intentó cobrar ${chargeSubject(null, plan)}${charged}, pero el cobro no se completó.` : null;
      // Attempts are a running total, so they are labelled "hasta ahora"; a retry date is only
      // shown while it is still ahead.
      const tries = failure.attemptCount ? ` Intentos hasta ahora: ${failure.attemptCount}.` : "";
      const next = failure.nextAttemptAt && new Date(failure.nextAttemptAt).getTime() > Date.now() ? ` Próximo intento: ${day(failure.nextAttemptAt)}.` : "";
      return `Stripe intentó cobrar ${chargeSubject(failure.billingReason, plan)}${charged}, pero ${failureReasonPhrase(failure)}.${tries}${next}`;
    }
    case "STRIPE_RENEWAL_EXTERNAL_CHANGE":
    case "STRIPE_RENEWAL_DISABLED":
    case "STRIPE_RENEWAL_REACTIVATED": {
      // Who and when only: consequences ("no new charge") can change after the event, e.g. an open
      // invoice keeps being retried after renewal is switched off.
      const disabled = typeof md["newCancelAtPeriodEnd"] === "boolean" ? (md["newCancelAtPeriodEnd"] as boolean) : ev.type !== "STRIPE_RENEWAL_REACTIVATED";
      const origin = (mdStr(md, "renewalOrigin") ?? (ev.type === "STRIPE_RENEWAL_EXTERNAL_CHANGE" ? "UNKNOWN" : "GYMOS_STAFF")) as RenewalChangeOrigin;
      return renewalChangeSentence({ disabled, at: ev.occurredAt, origin, actorName: null, feedback: mdStr(md, "cancellationFeedback"), certainty: "inferred" }, plan);
    }
    case "STRIPE_SUBSCRIPTION_ENDED": {
      const origin = (mdStr(md, "endOrigin") ?? "UNKNOWN") as SubscriptionEndOrigin;
      const reason = mdStr(md, "cancellationReason");
      const what = plan ? `la suscripción de ${plan}` : "la suscripción";
      if (origin === "STRIPE_AUTOMATIC") {
        if (reason === "payment_disputed") return `Stripe canceló ${what} por una disputa (contracargo) de un pago.`;
        if (reason === "incomplete_expired") return `Stripe canceló ${what} porque el primer pago no se completó a tiempo.`;
        const failure = mdFailure(md);
        const why = failure ? ` (${failure.attemptCount ? `${failure.attemptCount} intentos; ` : ""}${failureReasonShort(failure)})` : "";
        return `Stripe canceló ${what} porque no pudo cobrar la renovación${why}.`;
      }
      if (origin === "PERIOD_END") {
        const by = mdStr(md, "scheduledBy") as RenewalChangeOrigin | null;
        if (by === "STRIPE_TO_CASH") return `${capitalize(what)} con tarjeta terminó al final del periodo por el cambio programado a pago en recepción.`;
        const who =
          by === "CUSTOMER_PORTAL" ? " (la desactivó el miembro desde el portal de pagos de Stripe)"
            : by === "GYMOS_STAFF" || by === "GYMOS" ? " (se desactivó desde GymOS)"
              : by === "STRIPE_API" ? " (se desactivó desde el panel de Stripe u otra integración)"
                : by === "STRIPE_NO_REQUEST" ? " (se desactivó en Stripe, fuera de GymOS)"
                  : "";
        return `${capitalize(what)} terminó al final del periodo porque la renovación automática estaba desactivada${who}.`;
      }
      if (origin === "CUSTOMER_PORTAL") {
        const motive = feedbackLabel(mdStr(md, "cancellationFeedback"));
        return `${capitalize(what)} se canceló desde el portal de pagos de Stripe${motive ? ` (el miembro respondió: «${motive}»)` : ""}.`;
      }
      if (origin === "STRIPE_TO_CASH") return `${capitalize(what)} con tarjeta terminó por el cambio a pago en recepción.`;
      if (origin === "GYMOS_STAFF" || origin === "GYMOS") return `${capitalize(what)} se canceló desde GymOS.`;
      if (origin === "STRIPE_API") return `${capitalize(what)} se canceló desde el panel de Stripe u otra integración (no desde GymOS).`;
      return `${capitalize(what)} se canceló en Stripe, fuera de GymOS.`;
    }
    case "STRIPE_TO_CASH_IMMEDIATE":
      return `El cobro con tarjeta${plan ? ` de ${plan}` : ""} se detuvo para cobrar en recepción.`;
    case "STRIPE_TO_CASH_PERIOD_END_SCHEDULED":
      return `Se programó el cambio a pago en recepción: el cobro con tarjeta${plan ? ` de ${plan}` : ""} se detendrá al terminar el periodo pagado.`;
    default:
      return null;
  }
}
