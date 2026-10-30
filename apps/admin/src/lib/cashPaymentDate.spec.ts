import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildCashSaleRequest, cashReceiptRows, checkCashPaidOn, studioDateKey } from "./cashPaymentDate.ts";
import { resolveCashSalePeriodPayload } from "./cashSalePeriod.ts";

const MX = "America/Mexico_City";
// 19:41 on Aug 24 in Mexico City, already Aug 25 in UTC.
const MX_EVENING = new Date("2026-08-25T01:41:00.000Z");

function saleInput(paidOn: string, periodStartDateKey: string) {
  return {
    planId: "plan_full",
    amountCents: 120_000,
    period: resolveCashSalePeriodPayload({
      periodStartDateKey,
      periodEndDateKey: "2026-09-24",
      timeZone: MX,
      now: MX_EVENING,
    }),
    paidOn,
    todayKey: studioDateKey(MX_EVENING, MX),
  };
}

describe("cash payment date (paidOn)", () => {
  it("defaults to the studio's calendar day, not the UTC or browser day", () => {
    assert.equal(studioDateKey(MX_EVENING, MX), "2026-08-24");
    assert.equal(studioDateKey(MX_EVENING, "UTC"), "2026-08-25");
    assert.equal(studioDateKey("2026-08-24T16:00:00.000Z", "Asia/Tokyo"), "2026-08-25");
  });

  it("accepts today and yesterday, and older historical days", () => {
    assert.deepEqual(checkCashPaidOn("2026-08-24", "2026-08-24"), { ok: true });
    assert.deepEqual(checkCashPaidOn("2026-08-23", "2026-08-24"), { ok: true });
    assert.deepEqual(checkCashPaidOn("2025-12-31", "2026-08-24"), { ok: true });
  });

  it("rejects future, empty, malformed and impossible days", () => {
    assert.deepEqual(checkCashPaidOn("2026-08-25", "2026-08-24"), { ok: false, message: "La fecha del pago no puede ser futura." });
    assert.deepEqual(checkCashPaidOn("", "2026-08-24"), { ok: false, message: "Selecciona la fecha del pago." });
    assert.deepEqual(checkCashPaidOn("2026-8-1", "2026-08-24"), { ok: false, message: "Selecciona la fecha del pago." });
    assert.deepEqual(checkCashPaidOn("2026-02-30", "2026-08-24"), { ok: false, message: "La fecha del pago no es válida." });
  });

  it("timezone boundary: at 19:41 Mexico City the UTC date (Aug 25) is still a future payment day", () => {
    const built = buildCashSaleRequest(saleInput("2026-08-25", "2026-08-24"));
    assert.deepEqual(built, { ok: false, message: "La fecha del pago no puede ser futura." });
    assert.equal(buildCashSaleRequest(saleInput("2026-08-24", "2026-08-24")).ok, true);
  });

  it("sends the selected paidOn in the offline-subscription payload", () => {
    const built = buildCashSaleRequest({ ...saleInput("2026-08-23", "2026-08-24"), notes: "  recibo 41  ", priceOverrideNote: "  " });
    assert.ok(built.ok);
    assert.deepEqual(built.request, {
      planId: "plan_full",
      amountCents: 120_000,
      paidOn: "2026-08-23",
      paymentMethod: "CASH",
      notes: "recibo 41",
      priceOverrideNote: undefined,
    });
  });

  it("never changes the membership period: same period fields for any paidOn", () => {
    const periodFields = (paidOn: string, start: string) => {
      const built = buildCashSaleRequest(saleInput(paidOn, start));
      assert.ok(built.ok);
      const { periodStart, periodEnd } = built.request;
      return { periodStart, periodEnd, hasPeriodKeys: "periodStart" in built.request || "periodEnd" in built.request };
    };
    // Immediate sale (vigencia starts today): no period sent, whatever the payment day.
    for (const paidOn of ["2026-08-24", "2026-08-23", "2026-07-01"]) {
      assert.deepEqual(periodFields(paidOn, "2026-08-24"), { periodStart: undefined, periodEnd: undefined, hasPeriodKeys: false });
    }
    // Explicit vigencia: identical anchors for today, yesterday and a month ago.
    const scheduled = periodFields("2026-08-24", "2026-08-26");
    assert.equal(scheduled.periodStart, "2026-08-26T06:00:00.000Z");
    assert.deepEqual(periodFields("2026-08-23", "2026-08-26"), scheduled);
    assert.deepEqual(periodFields("2026-07-24", "2026-08-26"), scheduled);
  });

  it("confirmation keeps payment day, vigencia and real insertion time apart", () => {
    const rows = cashReceiptRows(
      {
        subscription: {
          id: "sub_1",
          status: "ACTIVE",
          source: "CASH",
          currentPeriodStart: "2026-08-25T01:41:00.000Z",
          currentPeriodEnd: "2026-09-25T01:41:00.000Z",
          membershipPlan: { id: "plan_full", name: "Full", priceCents: 120_000, currency: "mxn" },
        },
        // API: past paidOn → studio-local noon; createdAt → the real insertion instant.
        payment: { id: "pay_1", amountCents: 120_000, status: "SUCCEEDED", paymentMethod: "CASH", paidAt: "2026-08-23T18:00:00.000Z", createdAt: "2026-08-25T01:41:02.000Z" },
      },
      "2026-08-23",
      MX,
    );
    assert.deepEqual(
      rows.map((r) => [r.label, r.dateKey]),
      [
        ["Fecha del pago", "2026-08-23"],
        ["Inicio de la membresía", "2026-08-24"],
        ["Fin de la membresía", "2026-09-24"],
        ["Registrado en el sistema", "2026-08-24"],
      ],
    );
    assert.match(rows[3]!.value, /19:41/);
  });

  it("confirmation falls back to the submitted day when the API returns no paidAt", () => {
    const rows = cashReceiptRows(
      {
        subscription: { id: "s", status: "ACTIVE", source: "CASH", currentPeriodStart: null, currentPeriodEnd: null, membershipPlan: { id: "p", name: "P", priceCents: 1, currency: "mxn" } },
        payment: { id: "p", amountCents: 1, status: "SUCCEEDED", paymentMethod: "CASH", paidAt: null, createdAt: "2026-08-25T01:41:02.000Z" },
      },
      "2026-08-22",
      MX,
    );
    assert.deepEqual(rows[0], { label: "Fecha del pago", dateKey: "2026-08-22", value: "2026-08-22" });
    assert.equal(rows[1]!.value, "—");
  });
});
