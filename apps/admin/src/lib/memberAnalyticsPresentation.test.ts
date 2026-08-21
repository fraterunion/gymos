import test from "node:test";
import assert from "node:assert/strict";
import {
  ENGAGEMENT_STATUS_LABELS,
  formatLastVisit,
  formatTrendPct,
} from "@/lib/memberAnalyticsPresentation";

test("formatTrendPct handles null and directions", () => {
  assert.equal(formatTrendPct(null), "—");
  assert.equal(formatTrendPct(12), "↑ +12%");
  assert.equal(formatTrendPct(-8), "↓ -8%");
});

test("formatLastVisit shows relative labels", () => {
  const now = new Date("2026-08-21T12:00:00.000Z");
  assert.equal(formatLastVisit(now.toISOString()), "Hoy");
});

test("engagement labels are Spanish", () => {
  assert.equal(ENGAGEMENT_STATUS_LABELS.AT_RISK, "En riesgo");
});
