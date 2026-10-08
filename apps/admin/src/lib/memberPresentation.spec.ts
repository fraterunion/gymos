import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PAYMENT_SOURCE_PRESENTATION, PRIMARY_STATUS_LABELS, primaryStatus, renewalPresentation } from "./memberPresentation.ts";
import { allowedClassPresentation, billingOperationalState, cyclePayment, member360Actions, nextChargePresentation, paymentSourceLabel, renewalBehavior, renewalRequiresBillingReview, usagePresentation } from "./member360.ts";

const base = {
  lifecycleStatus: "ACTIVE" as const,
  source: "STRIPE" as const,
  cancelAtPeriodEnd: false,
  currentPeriodStart: "2026-08-18T18:00:00.000Z",
  currentPeriodEnd: "2026-09-18T18:00:00.000Z",
  effectiveEnd: "2026-09-18T18:00:00.000Z",
  entitlementDays: null,
};

test("recurring Stripe membership says Renueva and Automática", () => {
  assert.deepEqual(renewalPresentation(base), { title: "Renueva 18 sep", detail: "Automática" });
});

test("Stripe membership scheduled to stop says Vence and No renovará", () => {
  assert.deepEqual(renewalPresentation({ ...base, cancelAtPeriodEnd: true }), { title: "Vence 18 sep", detail: "No renovará" });
});

test("cash membership says Vence and Renovación manual", () => {
  assert.deepEqual(renewalPresentation({ ...base, source: "CASH" }), { title: "Vence 18 sep", detail: "Renovación manual" });
});

test("expired membership says Venció", () => {
  const value = renewalPresentation({ ...base, lifecycleStatus: "EXPIRED" }, new Date("2026-09-20T18:00:00.000Z"));
  assert.equal(value.title, "Venció 18 sep");
  assert.equal(value.detail, "hace 2 días");
});

test("scheduled membership says Inicia", () => {
  assert.deepEqual(renewalPresentation({ ...base, lifecycleStatus: "SCHEDULED" }), { title: "Inicia 18 ago", detail: null });
});

test("renewable fixed-duration Stripe membership shows its cadence", () => {
  assert.deepEqual(renewalPresentation({ ...base, effectiveEnd: "2026-10-02T18:00:00.000Z", entitlementDays: 45 }), {
    title: "Renueva 18 sep",
    detail: "Cada 45 días",
  });
});

test("cash fixed-duration membership is a program, not an automatic renewal", () => {
  assert.deepEqual(renewalPresentation({ ...base, source: "CASH", effectiveEnd: "2026-10-02T18:00:00.000Z", entitlementDays: 45 }), {
    title: "Vence 2 oct",
    detail: "Programa de 45 días",
  });
});

test("ENDING remains ACTIVE in client-side primary presentation", () => {
  assert.equal(primaryStatus("ENDING"), "ACTIVE");
});

test("Booty Lab scheduled to stop uses its entitlement end", () => {
  assert.deepEqual(renewalPresentation({ ...base, cancelAtPeriodEnd: true, effectiveEnd: "2026-10-02T18:00:00.000Z", entitlementDays: 45 }), {
    title: "Vence 2 oct",
    detail: "No renovará",
  });
});

test("payment source badges use canonical labels and distinct treatments", () => {
  assert.equal(PAYMENT_SOURCE_PRESENTATION.STRIPE.label, "Stripe");
  assert.match(PAYMENT_SOURCE_PRESENTATION.STRIPE.className, /violet/);
  assert.equal(PAYMENT_SOURCE_PRESENTATION.CASH.label, "Efectivo");
  assert.match(PAYMENT_SOURCE_PRESENTATION.CASH.className, /emerald/);
  assert.equal(PAYMENT_SOURCE_PRESENTATION.MANUAL.label, "Manual");
  assert.match(PAYMENT_SOURCE_PRESENTATION.MANUAL.className, /sky/);
});

test("member directory has eight operational columns and no Atención column", () => {
  const source = readFileSync(new URL("../app/members/page.tsx", import.meta.url), "utf8");
  const expectedColumns = ["Miembro", "Plan", "Estado", "Pago", "Renovación / vencimiento", "Uso", "Última visita", "Próxima clase"];
  const headers = [...source.matchAll(/<th[^>]*>([^<]+)<\/th>/g)].map((match) => match[1].trim());
  for (const column of expectedColumns) assert.match(source, new RegExp(`(?:label=\\"${column}\\"|>${column}<)`));
  assert.equal(headers.includes("Atención"), false);
  assert.doesNotMatch(source, /m\.attention|member\.attention/);
  assert.match(source, /colSpan=\{8\}/);
  assert.match(source, /\[\.\.\.Array\(8\)\]/);
});

test("directory and profile render the API operational primary status", () => {
  const directory = readFileSync(new URL("../app/members/page.tsx", import.meta.url), "utf8");
  const profile = readFileSync(new URL("../app/members/[userId]/page.tsx", import.meta.url), "utf8");
  assert.match(directory, /subscription\.primaryStatus/);
  assert.match(profile, /currentMembership\.primaryStatus/);
  assert.doesNotMatch(profile, /primaryStatus\(profile\.currentMembership\.lifecycleStatus\)/);
});

test("directory renders payment sources through compact badge styling", () => {
  const source = readFileSync(new URL("../app/members/page.tsx", import.meta.url), "utf8");
  assert.match(source, /function PaymentSourceBadge/);
  assert.match(source, /adminStatusPill/);
  assert.match(source, /<PaymentSourceBadge source=\{m\.subscription\.source\}/);
});

test("Member 360 action center is lifecycle and RBAC aware", () => {
  const activeStripe = { primaryStatus: "ACTIVE" as const, source: "STRIPE" as const, cancelAtPeriodEnd: false };
  assert.deepEqual(member360Actions("OWNER", activeStripe).map((action) => action.label), ["Gestionar membresía", "Ver facturación", "Notas y CRM"]);
  assert.equal(member360Actions("ADMIN", { ...activeStripe, primaryStatus: "EXPIRED" }).at(0)?.label, "Renovar membresía");
  assert.equal(member360Actions("ADMIN", { ...activeStripe, cancelAtPeriodEnd: true }).at(0)?.label, "Revisar renovación");
  assert.deepEqual(member360Actions("FRONT_DESK", activeStripe).map((action) => action.label), ["Ver facturación", "Ver notas"]);
  assert.deepEqual(member360Actions("INSTRUCTOR", activeStripe), []);
});

test("Member 360 distinguishes credit, unlimited, and no-membership usage", () => {
  const creditProfile = { currentMembership: { plan: { classCredits: 12 }, creditsUsed: 8, creditsRemaining: 4 }, engagement: { visitsCurrentPeriod: 5, visitsLast30Days: 7 } } as never;
  assert.deepEqual(usagePresentation(creditProfile), { label: "Créditos del periodo", value: "8 / 12", detail: "4 restantes" });
  assert.deepEqual(usagePresentation({ currentMembership: { plan: { classCredits: null } }, engagement: { visitsCurrentPeriod: 5, visitsLast30Days: 7 } } as never), { label: "Visitas este periodo", value: "5", detail: "membresía ilimitada" });
  assert.deepEqual(usagePresentation({ currentMembership: null, engagement: { visitsCurrentPeriod: 0, visitsLast30Days: 7 } } as never), { label: "Visitas · 30 días", value: "7", detail: "historial reciente" });
});

test("Member 360 billing state separates current, past-due, expired, and manual", () => {
  const profile = (currentMembership: unknown) => ({ currentMembership, operations: {} }) as never;
  assert.equal(billingOperationalState(profile(null)), "No aplica");
  assert.equal(billingOperationalState(profile({ lifecycleStatus: "PAST_DUE", primaryStatus: "PAST_DUE", source: "STRIPE", cancelAtPeriodEnd: false })), "Pago pendiente");
  assert.equal(billingOperationalState(profile({ lifecycleStatus: "EXPIRED", primaryStatus: "EXPIRED", source: "CASH", cancelAtPeriodEnd: true })), "Al corriente");
  assert.equal(billingOperationalState(profile({ lifecycleStatus: "ACTIVE", primaryStatus: "ACTIVE", source: "CASH", cancelAtPeriodEnd: false })), "Al corriente");
  assert.equal(billingOperationalState(profile({ lifecycleStatus: "ACTIVE", primaryStatus: "ACTIVE", source: "STRIPE", cancelAtPeriodEnd: false })), "Al corriente");
});

test("membership lifecycle and payment state remain independent for expired CASH", () => {
  const matias = { lifecycleStatus: "EXPIRED", primaryStatus: "EXPIRED", source: "CASH", cancelAtPeriodEnd: true } as const;
  assert.equal(PRIMARY_STATUS_LABELS[matias.primaryStatus], "Vencida");
  assert.equal(billingOperationalState({ currentMembership: matias, operations: {} } as never), "Al corriente");
  assert.equal(paymentSourceLabel(matias.source), "Efectivo");
  assert.equal(renewalBehavior(matias), "Requiere renovación manual");
});

test("renewal behavior is source-aware and never applies Stripe cancellation semantics to CASH", () => {
  assert.equal(renewalBehavior({ source: "CASH", cancelAtPeriodEnd: true, primaryStatus: "ACTIVE" }), "Manual");
  assert.equal(renewalBehavior({ source: "MANUAL", cancelAtPeriodEnd: true, primaryStatus: "EXPIRED" }), "Requiere renovación manual");
  assert.equal(renewalBehavior({ source: "STRIPE", cancelAtPeriodEnd: false, primaryStatus: "ACTIVE" }), "Automática");
  assert.equal(renewalBehavior({ source: "STRIPE", cancelAtPeriodEnd: true, primaryStatus: "ACTIVE" }), "No renovará");
});

test("historical successful payment amount is preserved independently from current catalog price", () => {
  const subscription = { membershipPlan: { priceCents: 150000 }, payments: [{ stripeInvoiceId: "historical", status: "SUCCEEDED", amountCents: 195000, currency: "mxn", paymentMethod: "CASH" }] };
  assert.equal(cyclePayment(subscription, "historical")?.amountCents, 195000);
  assert.notEqual(cyclePayment(subscription, "historical")?.amountCents, subscription.membershipPlan.priceCents);
});

test("paid Booty bridge is operationally active while genuine unpaid trial remains Prueba", () => {
  assert.equal(primaryStatus("ENDING"), "ACTIVE");
  assert.equal(primaryStatus("TRIALING"), "TRIALING");
  assert.equal(PRIMARY_STATUS_LABELS[primaryStatus("TRIALING")], "Prueba");
});

test("allowed classes use canonical mappings and include Open Gym hours", () => {
  assert.deepEqual(allowedClassPresentation({ isEntitled: false, plan: { allClassesAccess: false, allowedTemplates: [] } } as never), ["Sin acceso vigente"]);
  assert.deepEqual(allowedClassPresentation({ isEntitled: true, plan: { allClassesAccess: true, allowedTemplates: [] } } as never), ["Todas las clases"]);
  assert.deepEqual(allowedClassPresentation({ isEntitled: true, plan: { allClassesAccess: false, allowedTemplates: [{ name: "Open Gym", isOpenGymSlot: true, accessWindowStart: "06:00", accessWindowEnd: "12:00" }] } } as never), ["Open Gym · 06:00–12:00"]);
});

test("cycle ledger links only real successful invoice-backed payments", () => {
  const subscription = { payments: [{ stripeInvoiceId: "in_paid", status: "SUCCEEDED", amountCents: 80000, currency: "mxn", paymentMethod: "STRIPE" }, { stripeInvoiceId: "in_failed", status: "FAILED", amountCents: 80000, currency: "mxn", paymentMethod: "STRIPE" }] };
  assert.equal(cyclePayment(subscription, "in_paid")?.amountCents, 80000);
  assert.equal(cyclePayment(subscription, "in_failed"), null);
  assert.equal(cyclePayment(subscription, null), null);
});

test("profile source exposes 360 sections without fabricating a future cycle", () => {
  const source = readFileSync(new URL("../app/members/[userId]/page.tsx", import.meta.url), "utf8");
  for (const label of ["usageKpi?.label", "Actividad reciente", "Historial de ciclos pagados", "Actividad próxima", "Facturación", "Carta Responsiva"]) assert.match(source, new RegExp(label.replace(/[?.]/g, "\\$&")));
  assert.match(source, /Los ciclos futuros aparecen únicamente después de un pago válido/);
  assert.doesNotMatch(source, /churn score|riesgo de abandono/i);
});

test("Member 360 uses Spanish navigation and hides raw provider status from membership facts", () => {
  const source = readFileSync(new URL("../app/members/[userId]/page.tsx", import.meta.url), "utf8");
  for (const label of ["Resumen", "Membresía", "Reservas", "Asistencia", "Facturación", "Notas y CRM", "Historial"]) assert.match(source, new RegExp(`label: \\"${label}\\"`));
  assert.doesNotMatch(source, /Provider \/ pago|Cancel at period end|Period start|Period end|>Credits<|>Unlimited</);
  assert.doesNotMatch(source, /\{s\.status\} ·/);
  assert.match(source, /renewalBehavior\(s\)/);
});

test("header shows one card per membership with the API status, never a '+N membresía' chip", () => {
  const source = readFileSync(new URL("../app/members/[userId]/page.tsx", import.meta.url), "utf8");
  const billing = readFileSync(new URL("./membershipBilling.ts", import.meta.url), "utf8");
  assert.match(source, /buildMembershipCards\(\{ rows: membershipCardRows\(profile\)/);
  assert.match(source, /<MembershipCards cards=\{membershipCards\}/);
  assert.doesNotMatch(source, /extraMembershipsChip|membresía\$\{extra/);
  // Card status comes from the API's operational status, not a client re-derivation.
  assert.match(billing, /primaryStatus: m\.primaryStatus/);
  // Empty state and per-plan alerts keep their wording; status is never glued to the plan name.
  assert.match(source, /currentMembership\?\.plan\.name \?\? "Sin membresía"/);
  assert.doesNotMatch(source, /plan\.name\} · \$\{PRIMARY_STATUS_LABELS/);
  assert.match(source, /Membresía vencida/);
  // The attention list only drops what the primary membership's card explains.
  assert.match(source, /pageAttentionItems\(profile, membershipCards\)/);
});

test("Member 360 stays usable when the billing-status endpoint is unavailable", () => {
  const source = readFileSync(new URL("../app/members/[userId]/page.tsx", import.meta.url), "utf8");
  // Fetched on its own (never inside the profile Promise.all), failures fall back to local facts,
  // and only the newest response may update the page.
  assert.match(source, /void fetchMemberBillingStatus\(selectedStudioId, userId\)/);
  assert.doesNotMatch(source, /Promise\.all\(\[[^\]]*fetchMemberBillingStatus/);
  assert.match(source, /\.catch\(\(\) => \{ if \(request === billingRequest\.current\) \{ setBilling\(null\); setBillingLoad\("error"\); \} \}\)/);
  assert.match(source, /if \(request === billingRequest\.current\) \{ setBilling\(b\); setBillingLoad\("ready"\); \}/);
});

// ── 2026-10 Booty Lab incident: paid card renewal with no entitlement cycle ──────────

const paidButExpired = {
  lifecycleStatus: "EXPIRED", primaryStatus: "EXPIRED", status: "ACTIVE", source: "STRIPE", cancelAtPeriodEnd: false,
  isEntitled: false, effectiveEnd: "2026-10-02T16:54:40.000Z",
  paidWithoutEntitlement: { stripeInvoiceId: "in_fx", amountCents: 80000, currency: "mxn", paidAt: "2026-10-02T17:55:59.000Z" },
} as const;

test("a paid card renewal without its entitlement is never presented as healthy billing", () => {
  assert.equal(billingOperationalState({ currentMembership: paidButExpired, operations: { attentionItems: [] } } as never), "Pagado sin acceso");
  const flaggedOnlyByAttention = { ...paidButExpired, paidWithoutEntitlement: null };
  assert.equal(
    billingOperationalState({ currentMembership: flaggedOnlyByAttention, operations: { attentionItems: [{ code: "PAID_WITHOUT_ENTITLEMENT" }] } } as never),
    "Pagado sin acceso",
  );
});

test("a past entitlement end is never shown as the next card charge", () => {
  const now = new Date("2026-10-07T18:00:00.000Z");
  assert.equal(nextChargePresentation(paidButExpired, now), null);
  assert.equal(nextChargePresentation({ ...paidButExpired, isEntitled: true }, now), null); // date already passed
  assert.deepEqual(
    nextChargePresentation({ source: "STRIPE", cancelAtPeriodEnd: false, isEntitled: true, effectiveEnd: "2026-11-16T16:54:40.000Z" }, now),
    { label: "Próximo cobro", date: "2026-11-16T16:54:40.000Z" },
  );
  assert.deepEqual(
    nextChargePresentation({ source: "STRIPE", cancelAtPeriodEnd: true, isEntitled: true, effectiveEnd: "2026-11-16T16:54:40.000Z" }, now),
    { label: "Vence", date: "2026-11-16T16:54:40.000Z" },
  );
  assert.equal(nextChargePresentation({ source: "CASH", cancelAtPeriodEnd: true, isEntitled: true, effectiveEnd: "2026-11-16T16:54:40.000Z" }, now), null);
});

test("an expired membership that Stripe still renews never offers Renovar — billing review comes first", () => {
  const labels = (m: unknown) => member360Actions("OWNER", m as never).map((a) => [a.id, a.label]);
  assert.deepEqual(labels(paidButExpired), [
    ["billing", "Revisar cobro antes de renovar"],
    ["membership", "Gestionar membresía"],
    ["notes", "Notas y CRM"],
  ]);
  assert.deepEqual(labels({ ...paidButExpired, paidWithoutEntitlement: null }).at(0), ["billing", "Revisar cobro antes de renovar"]);
  // Expired CASH, or a Stripe subscription that really ended, may still be renewed.
  assert.equal(member360Actions("OWNER", { primaryStatus: "EXPIRED", source: "CASH", status: "ACTIVE", cancelAtPeriodEnd: true }).at(0)?.label, "Renovar membresía");
  assert.equal(member360Actions("OWNER", { primaryStatus: "EXPIRED", source: "STRIPE", status: "CANCELED", cancelAtPeriodEnd: true }).at(0)?.label, "Renovar membresía");
  assert.equal(renewalRequiresBillingReview({ source: "STRIPE", status: "TRIALING" }), true);
  assert.equal(renewalRequiresBillingReview(null), false);
});
