import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  planAccessSummary,
  planCycleLabel,
  planHealth,
  planUsageLabel,
  planWarnings,
  operationalOverview,
  subscriptionActions,
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

test("allClassesAccess summary reads 'Todas las clases'", () => {
  const plan = basePlan({ classAccess: { allClasses: true, templates: [] } });
  assert.deepEqual(planAccessSummary(plan), {
    label: "Todas las clases",
    regularCount: 0,
    hasOpenGym: false,
  });
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
  });
});

test("plan with several regular classes plus Open Gym", () => {
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
  const summary = planAccessSummary(plan);
  assert.equal(summary.label, "2 clases + Open Gym");
  assert.equal(summary.regularCount, 2);
  assert.equal(summary.hasOpenGym, true);
});

test("Open Gym-only plan shows its access window", () => {
  const plan = basePlan({
    classAccess: {
      allClasses: false,
      templates: [template({ name: "Open Gym", isOpenGymSlot: true, accessWindowStart: "10:00", accessWindowEnd: "17:00" })],
    },
  });
  assert.deepEqual(planAccessSummary(plan), {
    label: "Acceso Open Gym · 10:00–17:00",
    regularCount: 0,
    hasOpenGym: true,
  });
});

test("inactive (soft-deleted) templates do not count toward the access summary", () => {
  const plan = basePlan({
    classAccess: {
      allClasses: false,
      templates: [template({ name: "Retired class", active: false })],
    },
  });
  assert.deepEqual(planAccessSummary(plan), {
    label: "Sin clases permitidas",
    regularCount: 0,
    hasOpenGym: false,
  });
});

test("warning: allClassesAccess=true always flagged", () => {
  const plan = basePlan({ classAccess: { allClasses: true, templates: [] } });
  assert.deepEqual(planWarnings(plan), [
    "Acceso a todas las clases activas — incluye Booty Lab y Open Gym.",
  ]);
});

test("warning: restricted plan with zero allowed classes and no legacy categories", () => {
  const plan = basePlan({ classAccess: { allClasses: false, templates: [] } });
  assert.deepEqual(planWarnings(plan), [
    "Plan restringido sin ninguna clase permitida — nadie puede reservar.",
  ]);
});

test("no warning when a restricted plan has at least one legacy allowedCategories entry", () => {
  const plan = basePlan({
    classAccess: { allClasses: false, templates: [] },
    allowedCategories: ["HIIT"],
  });
  assert.deepEqual(planWarnings(plan), []);
});

test("no warning when a restricted plan has at least one allowed class", () => {
  const plan = basePlan({ classAccess: { allClasses: false, templates: [template()] } });
  assert.deepEqual(planWarnings(plan), []);
});

test("warning: zero or negative credits configured (not intentionally unlimited)", () => {
  const plan = basePlan({ classAccess: { allClasses: false, templates: [template()] }, classCredits: 0 });
  assert.deepEqual(planWarnings(plan), [
    "0 créditos configurados — nadie podrá reservar con este plan.",
  ]);
});

test("warning: invalid entitlementDays (<=0)", () => {
  const plan = basePlan({ classAccess: { allClasses: false, templates: [template()] }, entitlementDays: 0 });
  assert.deepEqual(planWarnings(plan), ["Duración fija inválida (≤ 0 días)."]);
});

test("warning: inactive plan still has active subscribers", () => {
  const plan = basePlan({
    active: false,
    activeSubscriberCount: 3,
    classAccess: { allClasses: false, templates: [template()] },
  });
  assert.deepEqual(planWarnings(plan), ["Plan inactivo con 3 suscripciones activas."]);
});

test("healthy plan (Basic Access shape) has no warnings", () => {
  const plan = basePlan({
    classCredits: 12,
    classAccess: { allClasses: false, templates: [template(), template({ name: "Hyrox" })] },
  });
  assert.deepEqual(planWarnings(plan), []);
});

test("operational overview excludes MRR and counts deterministic attention states", () => {
  assert.deepEqual(operationalOverview({
    totalActivePlans: 5,
    totalActiveSubscribers: 34,
    byStatus: { ENDING: 7, PAST_DUE: 2, PAUSED: 1, EXPIRED: 3 },
    unhealthyPlanCount: 2,
  }), { activePlans: 5, activeMembers: 34, endingSoon: 7, requiringAttention: 8 });
});

test("plan health combines access and Stripe integrity without changing either", () => {
  assert.equal(planHealth(basePlan({ classAccess: { allClasses: false, templates: [template()] } }), "healthy").label, "Saludable");
  assert.deepEqual(planHealth(basePlan({ classAccess: { allClasses: false, templates: [template()] } }), "price_mismatch").issues, [
    "Configuración de GymOS y Stripe desalineada.",
  ]);
});

test("expired CASH exposes renewal operations, never provider cancellation", () => {
  assert.deepEqual(subscriptionActions({ lifecycleStatus: "EXPIRED", source: "CASH", cancelAtPeriodEnd: false, isEntitled: false }), [
    "view_member", "renew", "change_plan", "record_cash_payment",
  ]);
});

test("active Stripe and ending Stripe get mutually exclusive renewal controls", () => {
  assert.deepEqual(subscriptionActions({ lifecycleStatus: "ACTIVE", source: "STRIPE", cancelAtPeriodEnd: false, isEntitled: true }), [
    "view_member", "change_plan", "cancel_at_period_end",
  ]);
  assert.deepEqual(subscriptionActions({ lifecycleStatus: "ENDING", source: "STRIPE", cancelAtPeriodEnd: true, isEntitled: true }), [
    "view_member", "change_plan", "reactivate_renewal",
  ]);
});

test("paused subscription only exposes resume and view", () => {
  assert.deepEqual(subscriptionActions({ lifecycleStatus: "PAUSED", source: "MANUAL", cancelAtPeriodEnd: false, isEntitled: false }), ["view_member", "resume"]);
  assert.deepEqual(subscriptionActions({ lifecycleStatus: "PAUSED", source: "STRIPE", cancelAtPeriodEnd: false, isEntitled: false }), ["view_member"]);
});

test("enabling allClassesAccess still requires an explicit confirmation in the plan editor", () => {
  const source = readFileSync(new URL("../app/memberships/page.tsx", import.meta.url), "utf8");
  assert.match(source, /window\.confirm\(/);
  assert.match(source, /hadRestrictedAccess/);
});

test("plan cards and the day pass panel identify Open Gym without re-deriving it from a class name", () => {
  const source = readFileSync(new URL("../app/memberships/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /name\s*===\s*["']Open Gym["']/);
  assert.match(source, /isOpenGymSlot/);
});

test("Membership Operations Center has no MRR presentation or unsafe immediate cancel", () => {
  const source = readFileSync(new URL("../app/memberships/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Est\. MRR|totalMrrCents|Cancel now/);
  assert.match(source, /Centro de membresías/);
  assert.match(source, /Matriz de acceso a clases/);
});
