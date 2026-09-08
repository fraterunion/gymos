import assert from "node:assert/strict";
import test from "node:test";

import {
  attentionItemTitle,
  currentMembershipRows,
  extraMembershipsChip,
  membershipRowRenewalActions,
  membershipUsageLine,
} from "./member360.ts";
import type { MembershipSummary } from "./api/members.ts";

function row(overrides: Partial<MembershipSummary>): MembershipSummary {
  return {
    subscriptionId: "sub-full",
    membershipPlanId: "plan-full",
    exclusiveGroup: "CORE",
    status: "ACTIVE",
    source: "STRIPE",
    accessState: "ENTITLED",
    lifecycleStatus: "ACTIVE",
    isEntitled: true,
    currentPeriodStart: "2026-09-01T00:00:00.000Z",
    currentPeriodEnd: "2026-10-01T00:00:00.000Z",
    entitlementEndsAt: null,
    effectiveEnd: "2026-10-01T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    supersededBySubscriptionId: null,
    plan: {
      id: "plan-full",
      name: "Full Access",
      priceCents: 150000,
      currency: "mxn",
      billingInterval: "MONTHLY",
      classCredits: null,
      entitlementDays: null,
      openGymAccess: true,
      allClassesAccess: false,
      allowedCategories: [],
      allowedTemplates: [],
    } as MembershipSummary["plan"],
    pendingPlan: null,
    creditsUsed: null,
    creditsRemaining: null,
    ...overrides,
  };
}

const bootyRow = row({
  subscriptionId: "sub-booty",
  membershipPlanId: "plan-booty",
  exclusiveGroup: null,
  source: "CASH",
  plan: {
    ...row({}).plan,
    id: "plan-booty",
    name: "Booty Lab by Etzia",
    classCredits: 4,
    entitlementDays: 45,
  },
  creditsUsed: 1,
  creditsRemaining: 3,
});

test("renewal actions bind to the EXACT row id — Booty action can never carry the Full id", () => {
  const full = row({ cancelAtPeriodEnd: false });
  const bootyStripe = row({
    subscriptionId: "sub-booty",
    membershipPlanId: "plan-booty",
    exclusiveGroup: null,
    cancelAtPeriodEnd: true,
  });
  const fullActions = membershipRowRenewalActions("ADMIN", full);
  const bootyActions = membershipRowRenewalActions("ADMIN", bootyStripe);
  assert.deepEqual(fullActions.map((a) => a.subscriptionId), ["sub-full"]);
  assert.deepEqual(bootyActions.map((a) => a.subscriptionId), ["sub-booty"]);
  assert.equal(fullActions[0]?.kind, "cancel_renewal");
  assert.equal(bootyActions[0]?.kind, "reactivate_renewal");
  assert.equal(fullActions.some((a) => a.subscriptionId === "sub-booty"), false);
  assert.equal(bootyActions.some((a) => a.subscriptionId === "sub-full"), false);
});

test("renewal actions: cash rows, replaced rows and non-managers get none", () => {
  assert.deepEqual(membershipRowRenewalActions("ADMIN", bootyRow), []); // CASH
  assert.deepEqual(membershipRowRenewalActions("STAFF", row({})), []);
  assert.deepEqual(
    membershipRowRenewalActions("OWNER", row({ lifecycleStatus: "REPLACED" })),
    [],
  );
});

test("header chip appears only for >1 current membership; SCHEDULED rows do not count", () => {
  assert.equal(extraMembershipsChip([row({})]), null);
  assert.equal(extraMembershipsChip([row({}), bootyRow]), "+1 membresía");
  assert.equal(
    extraMembershipsChip([row({}), bootyRow, row({ subscriptionId: "s3", status: "SCHEDULED" })]),
    "+1 membresía",
  );
  assert.equal(currentMembershipRows([row({}), bootyRow]).length, 2);
});

test("usage line is per-membership — Full unlimited and Booty 1/4 stay independent", () => {
  assert.equal(membershipUsageLine(row({})), "Ilimitado");
  assert.equal(membershipUsageLine(bootyRow), "1 / 4 · 3 restantes");
});

test("attention item titles carry the plan name only when the member holds >1 membership", () => {
  assert.equal(attentionItemTitle("Sin créditos", "Booty Lab", 2), "Booty Lab · Sin créditos");
  assert.equal(attentionItemTitle("Sin créditos", "Booty Lab", 1), "Sin créditos");
});
