import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PAYMENT_SOURCE_PRESENTATION, renewalPresentation } from "./memberPresentation.ts";

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

test("recurring custom entitlement shows billing renewal and entitlement window", () => {
  assert.deepEqual(renewalPresentation({ ...base, effectiveEnd: "2026-10-02T18:00:00.000Z", entitlementDays: 45 }), {
    title: "Renueva 18 sep",
    detail: "Ciclo de 45 días · vigencia hasta 2 oct",
  });
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
  const headers = [...source.matchAll(/<th[^>]*>([^<]+)<\/th>/g)].map((match) => match[1].trim());
  assert.equal(headers.includes("Atención"), false);
  assert.match(source, /colSpan=\{8\}/);
  assert.match(source, /\[\.\.\.Array\(8\)\]/);
});
