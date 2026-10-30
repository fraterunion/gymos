import assert from "node:assert/strict";
import test from "node:test";

import { groupByWeek, rangeCancelConfirmText, validateRangeDates, weekStartKey } from "./rangeCancel.ts";

test("validates the inclusive studio-local range like the API", () => {
  assert.equal(validateRangeDates("2026-11-02", "2026-11-22"), null);
  assert.equal(validateRangeDates("2026-11-02", "2026-11-02"), null);
  assert.match(validateRangeDates("2026-11-22", "2026-11-02") ?? "", /posterior/);
  assert.match(validateRangeDates("2026-02-30", "2026-03-02") ?? "", /inválida/);
  assert.match(validateRangeDates("", "2026-03-02") ?? "", /Selecciona/);
  assert.equal(validateRangeDates("2026-01-01", "2026-07-03"), null); // 184 days
  assert.match(validateRangeDates("2026-01-01", "2026-07-04") ?? "", /184/);
});

test("weeks start on Monday and preview rows group by week", () => {
  assert.equal(weekStartKey("2026-11-02"), "2026-11-02");
  assert.equal(weekStartKey("2026-11-08"), "2026-11-02");
  assert.equal(weekStartKey("2027-01-01"), "2026-12-28");
  const groups = groupByWeek([{ localDate: "2026-11-03" }, { localDate: "2026-11-08" }, { localDate: "2026-11-09" }, { localDate: "2026-11-23" }]);
  assert.deepEqual(groups.map((g) => [g.weekStart, g.rows.length]), [["2026-11-02", 2], ["2026-11-09", 1], ["2026-11-23", 1]]);
});

test("the confirmation states the exact impact", () => {
  assert.equal(
    rangeCancelConfirmText({ classes: 12, bookings: 7, waitlist: 2 }),
    "Entiendo que se cancelarán 12 clases, 7 reservas y 2 lugares en lista de espera.",
  );
});
