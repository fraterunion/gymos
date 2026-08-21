import assert from "node:assert/strict";
import test from "node:test";

import {
  formatReconciliationPreviewLine,
  visibleReconciliationItems,
} from "./scheduleReconciliationPreview.ts";

test("formatReconciliationPreviewLine renders compact staff copy", () => {
  const line = formatReconciliationPreviewLine({
    kind: "UPDATE",
    classTemplateName: "Upperbody",
    dateLabel: "mar 25 ago",
    timeLabel: "7 a.m.",
    actionLabel: "Se actualizará",
    detail: "Cambiará instructor: Ana → Fernando",
  });
  assert.match(line, /Upperbody/);
  assert.match(line, /Se actualizará/);
  assert.match(line, /Fernando/);
});

test("visibleReconciliationItems caps preview list", () => {
  const items = Array.from({ length: 12 }, (_, i) => ({
    kind: "CREATE" as const,
    classTemplateName: `Class ${i}`,
  }));
  assert.equal(visibleReconciliationItems(items, 8).length, 8);
});
