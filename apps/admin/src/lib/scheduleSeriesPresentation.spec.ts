import assert from "node:assert/strict";
import test from "node:test";

import {
  formatFrequency,
  formatLocalDateRange,
  occurrenceExceptionCopy,
  seriesStatusLabel,
} from "./scheduleSeriesPresentation.ts";

test("series status labels are staff-facing Spanish", () => {
  assert.equal(seriesStatusLabel("ACTIVE"), "Activa");
  assert.equal(seriesStatusLabel("ENDING_SOON"), "Finaliza pronto");
  assert.equal(seriesStatusLabel("ENDED"), "Finalizada");
});

test("frequency labels", () => {
  assert.equal(formatFrequency(1), "Semanal");
  assert.equal(formatFrequency(2), "Cada 2 semanas");
});

test("legacy unbounded vigencia copy", () => {
  const copy = formatLocalDateRange(null, null, true, "America/Mexico_City");
  assert.match(copy, /Horario histórico/);
  assert.match(copy, /Sin fecha de fin/);
});

test("occurrence exception copy hides enums", () => {
  assert.equal(occurrenceExceptionCopy("DETACHED"), "Modificada individualmente");
  assert.equal(occurrenceExceptionCopy("CANCELLED"), "Cancelada");
  assert.equal(occurrenceExceptionCopy(null), null);
});
