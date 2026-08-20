import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PAYMENT_SOURCE_PRESENTATION, primaryStatus, renewalPresentation } from "./memberPresentation.ts";
import { allowedClassPresentation, billingOperationalState, cyclePayment, member360Actions, usagePresentation } from "./member360.ts";

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
  assert.deepEqual(usagePresentation(creditProfile), { value: "8 / 12", detail: "4 restantes" });
  assert.deepEqual(usagePresentation({ currentMembership: { plan: { classCredits: null } }, engagement: { visitsCurrentPeriod: 5, visitsLast30Days: 7 } } as never), { value: "5", detail: "visitas este periodo" });
  assert.deepEqual(usagePresentation({ currentMembership: null, engagement: { visitsCurrentPeriod: 0, visitsLast30Days: 7 } } as never), { value: "7", detail: "visitas en 30 días" });
});

test("Member 360 billing state separates current, past-due, expired, and manual", () => {
  const profile = (currentMembership: unknown) => ({ currentMembership, operations: {} }) as never;
  assert.equal(billingOperationalState(profile(null)), "Sin membresía");
  assert.equal(billingOperationalState(profile({ lifecycleStatus: "PAST_DUE", primaryStatus: "PAST_DUE", source: "STRIPE", cancelAtPeriodEnd: false })), "Pago pendiente");
  assert.equal(billingOperationalState(profile({ lifecycleStatus: "EXPIRED", primaryStatus: "EXPIRED", source: "CASH", cancelAtPeriodEnd: true })), "Vencida");
  assert.equal(billingOperationalState(profile({ lifecycleStatus: "ACTIVE", primaryStatus: "ACTIVE", source: "CASH", cancelAtPeriodEnd: false })), "Renovación manual");
  assert.equal(billingOperationalState(profile({ lifecycleStatus: "ACTIVE", primaryStatus: "ACTIVE", source: "STRIPE", cancelAtPeriodEnd: false })), "Al corriente");
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
  for (const label of ["Uso del periodo", "Actividad reciente", "Historial de ciclos pagados", "Actividad próxima", "Facturación", "Carta Responsiva"]) assert.match(source, new RegExp(label));
  assert.match(source, /Los ciclos futuros aparecen únicamente después de un pago válido/);
  assert.doesNotMatch(source, /churn score|riesgo de abandono/i);
});
