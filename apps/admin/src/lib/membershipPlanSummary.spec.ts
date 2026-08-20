import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  dayPassHealthLabel,
  integrityIssueLabel,
  planAccessSummary,
  planCardLines,
  planCycleLabel,
  planHealth,
  planUsageLabel,
  planWarnings,
  operationalOverview,
  subscriptionActionLabel,
  subscriptionActions,
  subscriptionOperationalStatusLabel,
  subscriptionPaymentSourceLabel,
  subscriptionValidityLines,
  type PlanForSummary,
} from "./membershipPlanSummary.ts";

const template = (overrides: Partial<PlanForSummary["classAccess"]["templates"][number]> = {}) => ({
  name: "Calirox",
  active: true,
  isOpenGymSlot: false,
  accessWindowStart: null,
  accessWindowEnd: null,
  ...overrides,
});

const basePlan = (overrides: Partial<PlanForSummary> = {}): PlanForSummary => ({
  active: true,
  entitlementDays: null,
  classCredits: null,
  allowedCategories: [],
  activeSubscriberCount: 0,
  classAccess: { allClasses: false, templates: [] },
  ...overrides,
});

test("recurring plan has no fixed cycle label", () => {
  assert.equal(planCycleLabel(basePlan()), null);
});

test("fixed-duration plan (Booty Lab) shows its 45-day cycle", () => {
  assert.equal(planCycleLabel(basePlan({ entitlementDays: 45 })), "Cada 45 días");
});

test("unlimited plan usage label", () => {
  assert.equal(planUsageLabel(basePlan()), "Ilimitado");
});

test("Basic Access usage label = 12 créditos", () => {
  assert.equal(planUsageLabel(basePlan({ classCredits: 12 })), "12 créditos");
});

test("Pro usage label = 5 créditos", () => {
  assert.equal(planUsageLabel(basePlan({ classCredits: 5 })), "5 créditos");
});

test("Full Access card lines: unlimited + classes + Open Gym", () => {
  const plan = basePlan({
    classAccess: {
      allClasses: false,
      templates: [
        template({ name: "Calirox" }),
        template({ name: "Hyrox" }),
        template({ name: "Open Gym", isOpenGymSlot: true, accessWindowStart: "10:00", accessWindowEnd: "17:00" }),
      ],
    },
  });
  const lines = planCardLines(plan);
  assert.equal(lines.usageLine, "Ilimitado");
  assert.match(lines.accessLine, /clases \+ Open Gym/);
  assert.equal(lines.scheduleLine, null);
});

test("Open Gym-only card uses schedule line without redundant access prefix", () => {
  const plan = basePlan({
    classAccess: {
      allClasses: false,
      templates: [template({ name: "Open Gym", isOpenGymSlot: true, accessWindowStart: "10:00", accessWindowEnd: "17:00" })],
    },
  });
  const lines = planCardLines(plan);
  assert.equal(lines.accessLine, "Solo Open Gym");
  assert.equal(lines.scheduleLine, "Horario 10:00–17:00");
});

test("Booty Lab summary: single restricted class, no Open Gym", () => {
  const plan = basePlan({
    entitlementDays: 45,
    classCredits: 4,
    classAccess: { allClasses: false, templates: [template({ name: "Booty Lab" })] },
  });
  assert.equal(planCycleLabel(plan), "Cada 45 días");
  assert.equal(planUsageLabel(plan), "4 créditos");
  assert.deepEqual(planAccessSummary(plan), {
    label: "Solo Booty Lab",
    regularCount: 1,
    hasOpenGym: false,
    openGymWindow: null,
  });
});

test("operational overview uses 7-day expiring count and excludes MRR", () => {
  assert.deepEqual(
    operationalOverview({
      totalActivePlans: 5,
      totalActiveSubscribers: 34,
      expiringWithin7Days: 3,
      requiringAttentionSubscriptions: 6,
      unhealthyPlanCount: 2,
    }),
    { activePlans: 5, activeMembers: 34, expiringWithin7Days: 3, requiringAttention: 8 },
  );
});

test("plan health consolidates Stripe issues into one staff-friendly label", () => {
  assert.equal(planHealth(basePlan({ classAccess: { allClasses: false, templates: [template()] } }), "healthy").label, "Saludable");
  assert.equal(
    integrityIssueLabel("interval_mismatch"),
    "Ciclo de GymOS y Stripe desalineado",
  );
  const health = planHealth(basePlan({ classAccess: { allClasses: false, templates: [template()] } }), "interval_mismatch");
  assert.equal(health.primaryIssue, "Ciclo de GymOS y Stripe desalineado");
  assert.equal(health.label, "Requiere atención");
});

test("Booty Lab with healthy Stripe integrity is Saludable", () => {
  const booty = basePlan({
    entitlementDays: 45,
    classCredits: 4,
    classAccess: { allClasses: false, templates: [template({ name: "Booty Lab" })] },
  });
  assert.equal(planHealth(booty, "healthy").label, "Saludable");
});

test("subscription operational labels are Spanish", () => {
  assert.equal(subscriptionOperationalStatusLabel("ACTIVE"), "Activa");
  assert.equal(subscriptionOperationalStatusLabel("PAST_DUE"), "Pago pendiente");
  assert.equal(subscriptionPaymentSourceLabel("STRIPE"), "Stripe");
  assert.equal(subscriptionPaymentSourceLabel("CASH"), "Efectivo");
});

test("subscription validity lines for Stripe renewal", () => {
  const lines = subscriptionValidityLines({
    lifecycleStatus: "ACTIVE",
    source: "STRIPE",
    cancelAtPeriodEnd: false,
    effectiveEnd: "2026-10-02T00:00:00.000Z",
    entitlementDays: null,
    billingInterval: "MONTHLY",
  });
  assert.match(lines.primary, /Renueva/);
  assert.equal(lines.secondary, "Automática");
});

test("expired CASH exposes renewal operations, never provider cancellation", () => {
  assert.deepEqual(
    subscriptionActions({ lifecycleStatus: "EXPIRED", source: "CASH", cancelAtPeriodEnd: false, isEntitled: false }),
    ["view_member", "renew", "change_plan", "record_cash_payment"],
  );
});

test("active Stripe gets cancel-at-period-end, not immediate cancel", () => {
  assert.deepEqual(
    subscriptionActions({ lifecycleStatus: "ACTIVE", source: "STRIPE", cancelAtPeriodEnd: false, isEntitled: true }),
    ["view_member", "change_plan", "cancel_at_period_end"],
  );
  assert.doesNotMatch(subscriptionActionLabel("cancel_at_period_end"), /now/i);
});

test("day pass health: configured vs empty", () => {
  assert.equal(dayPassHealthLabel(7, 9).label, "Saludable");
  assert.equal(dayPassHealthLabel(0, 9).primaryIssue, "Sin acceso configurado");
});

test("warning: allClassesAccess=true always flagged", () => {
  const plan = basePlan({ classAccess: { allClasses: true, templates: [] } });
  assert.ok(planWarnings(plan).length > 0);
});

test("plan cards identify Open Gym without re-deriving from class name", () => {
  const source = readFileSync(new URL("../app/memberships/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /name\s*===\s*["']Open Gym["']/);
  assert.match(source, /isOpenGymSlot/);
});

test("Membership Operations Center has no MRR and uses tab isolation", () => {
  const pageSource = readFileSync(new URL("../app/memberships/page.tsx", import.meta.url), "utf8");
  const uiSource = readFileSync(new URL("../app/memberships/memberships-ui.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(pageSource, /Est\. MRR|totalMrrCents|Cancel now/);
  assert.match(pageSource, /Centro de membresías/);
  assert.match(pageSource, /activeTab === "acceso"/);
  assert.match(pageSource, /activeTab === "acceso"[\s\S]*ClassAccessMatrix/);
  assert.doesNotMatch(pageSource, /activeTab === "planes"[\s\S]{0,400}ClassAccessMatrix/);
  assert.match(uiSource, /Vencen en 7 días/);
  assert.match(uiSource, /Matriz plan × clase/);
});

test("enabling allClassesAccess still requires explicit confirmation in the plan editor", () => {
  const source = readFileSync(new URL("../app/memberships/page.tsx", import.meta.url), "utf8");
  assert.match(source, /window\.confirm\(/);
  assert.match(source, /hadRestrictedAccess/);
});
