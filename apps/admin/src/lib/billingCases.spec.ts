import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { activeSeverityCounts, availableActions, evidenceRows, headerSummary, runSummaryLine, severityTone } from "./billingCases.ts";
import { applyOpenCaseToCopy, openCaseForSubscription } from "./membershipBilling.ts";
import type { MemberBillingCaseView } from "./api/members.ts";

const paidWithoutAccess: MemberBillingCaseView = {
  id: "case_1",
  category: "PAID_WITHOUT_ENTITLEMENT",
  severity: "CRITICAL",
  status: "OPEN",
  reasonCode: "SUBSCRIPTION_ENDED",
  title: "Pago recibido sin acceso: $1,500.00 de Full Access",
  summary: "Stripe cobró una factura de una suscripción ya terminada: el dinero se registró, pero no se restauró el acceso.",
  suggestedAction: "Decide con el miembro: reembolsa en Stripe o vende/activa la membresía correcta en GymOS.",
  subscriptionId: "sub_local_1",
  stripeInvoiceId: "in_test",
  firstDetectedAt: "2026-10-09T07:00:00.000Z",
  lastObservedAt: "2026-10-09T07:00:00.000Z",
  acknowledgedAt: null,
};

describe("billing cases — presentation", () => {
  it("summarises unresolved cases by severity and never counts resolved ones", () => {
    const counts = activeSeverityCounts([
      { status: "OPEN", severity: "CRITICAL", count: 1 },
      { status: "ACKNOWLEDGED", severity: "HIGH", count: 2 },
      { status: "RESOLVED", severity: "CRITICAL", count: 5 },
    ]);
    assert.deepEqual(counts, { CRITICAL: 1, HIGH: 2, MEDIUM: 0, LOW: 0 });
    assert.equal(headerSummary(counts), "3 casos pendientes: 1 crítico, 2 altos.");
    assert.equal(headerSummary({ CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }), "Sin casos pendientes.");
  });

  it("offers only the actions that make sense for each status", () => {
    assert.deepEqual(availableActions("OPEN").map((a) => a.id), ["acknowledge", "resolve", "dismiss"]);
    assert.deepEqual(availableActions("ACKNOWLEDGED").map((a) => a.id), ["resolve", "dismiss"]);
    assert.deepEqual(availableActions("RESOLVED").map((a) => a.id), ["reopen"]);
    assert.ok(availableActions("OPEN").find((a) => a.id === "resolve")?.requiresNote);
  });

  it("renders evidence with money, booleans and dates in operator Spanish", () => {
    const rows = evidenceRows({ evidence: { amountCents: 150000, currency: "mxn", entitlementGranted: false, stripeStatus: "canceled", paidAt: "2026-10-09T07:00:00.000Z", paymentId: "hidden" } });
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    assert.equal(byLabel["Monto"], "$1,500.00");
    assert.equal(byLabel["Vigencia otorgada"], "No");
    assert.equal(byLabel["Estado en Stripe"], "canceled");
    assert.ok(!("paymentId" in byLabel));
    assert.equal(severityTone("CRITICAL"), "critical");
  });

  it("describes the last automatic run", () => {
    const now = new Date("2026-10-09T10:00:00.000Z");
    assert.equal(runSummaryLine(null), "Aún no se ha ejecutado una revisión automática.");
    assert.equal(
      runSummaryLine({ id: "r", studioId: null, trigger: "CRON", status: "COMPLETED", startedAt: "2026-10-09T07:00:00.000Z", finishedAt: "2026-10-09T07:02:00.000Z", stats: {}, error: null }, now),
      "Última revisión automática: hace 3 h · completa.",
    );
  });
});

describe("Member 360 — open cases override the card copy", () => {
  it("picks the most severe open case for the subscription and ignores MEDIUM/LOW and other rows", () => {
    const other: MemberBillingCaseView = { ...paidWithoutAccess, id: "case_2", subscriptionId: "sub_other", severity: "HIGH" };
    const low: MemberBillingCaseView = { ...paidWithoutAccess, id: "case_3", severity: "LOW" };
    assert.equal(openCaseForSubscription([other, low, paidWithoutAccess], "sub_local_1")?.id, "case_1");
    assert.equal(openCaseForSubscription([low], "sub_local_1"), null);
    assert.equal(openCaseForSubscription(undefined, "sub_local_1"), null);
  });

  it("never shows 'Al corriente' or a cash-charge action while a critical case is open", () => {
    const copy = applyOpenCaseToCopy(
      { paymentLabel: "Al corriente", tone: "ok", paymentProblem: false, explanation: [], caution: null, action: null },
      paidWithoutAccess,
    );
    assert.equal(copy.paymentLabel, "Pago recibido sin acceso");
    assert.equal(copy.tone, "critical");
    assert.equal(copy.paymentProblem, true);
    assert.match(copy.caution ?? "", /No cobres de nuevo/);
    assert.equal(copy.action?.detail, paidWithoutAccess.suggestedAction);
    assert.ok(copy.explanation[0]?.startsWith("Stripe cobró una factura"));
  });

  it("says when the case was already reviewed", () => {
    const copy = applyOpenCaseToCopy(
      { paymentLabel: "Al corriente", tone: "ok", paymentProblem: false, explanation: [], caution: null, action: null },
      { ...paidWithoutAccess, status: "ACKNOWLEDGED", acknowledgedAt: "2026-10-09T08:00:00.000Z" },
    );
    assert.match(copy.explanation[0] ?? "", /Este caso ya fue revisado/);
  });
});
