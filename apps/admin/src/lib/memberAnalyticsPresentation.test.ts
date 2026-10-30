import test from "node:test";
import assert from "node:assert/strict";
import {
  ENGAGEMENT_STATUS_LABELS,
  formatLastVisit,
  formatTrendPct,
} from "./memberAnalyticsPresentation.ts";

test("formatTrendPct handles null and directions", () => {
  assert.equal(formatTrendPct(null), "—");
  assert.equal(formatTrendPct(12), "↑ +12%");
  assert.equal(formatTrendPct(-8), "↓ -8%");
});

test("formatLastVisit shows relative labels", () => {
  // formatLastVisit compares against the real clock, so the inputs must be relative to now.
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  assert.equal(formatLastVisit(hoursAgo(1)), "Hoy");
  assert.equal(formatLastVisit(hoursAgo(30)), "Ayer");
  assert.equal(formatLastVisit(hoursAgo(3 * 24 + 1)), "Hace 3 d");
  assert.equal(formatLastVisit(null), "Sin visitas");
});

test("engagement labels are Spanish", () => {
  assert.equal(ENGAGEMENT_STATUS_LABELS.AT_RISK, "En riesgo");
});
