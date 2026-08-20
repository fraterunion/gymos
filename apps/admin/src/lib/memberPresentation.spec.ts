import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PAYMENT_SOURCE_PRESENTATION, primaryStatus, renewalPresentation } from "./memberPresentation.ts";

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
