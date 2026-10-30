import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { canOfferClassCancel, classHasStarted, protectedClassesNote } from "./classCancellation.ts";

const NOW = Date.parse("2026-10-30T15:00:00.000Z");
const FUTURE = "2026-10-30T16:00:00.000Z";

test("a class that started, or is starting now, counts as started", () => {
  assert.equal(classHasStarted("2026-10-30T14:00:00.000Z", NOW), true);
  assert.equal(classHasStarted("2026-10-30T15:00:00.000Z", NOW), true);
  assert.equal(classHasStarted("2026-10-30T15:00:01.000Z", NOW), false);
});

test("cancel is offered only for future classes without attendance", () => {
  assert.equal(canOfferClassCancel({ startsAt: FUTURE }, NOW), true);
  assert.equal(canOfferClassCancel({ startsAt: FUTURE, attendedCount: 0 }, NOW), true);
  assert.equal(canOfferClassCancel({ startsAt: FUTURE, attendedCount: 1 }, NOW), false); // early check-in
  assert.equal(canOfferClassCancel({ startsAt: "2026-10-30T14:30:00.000Z" }, NOW), false); // in progress
  assert.equal(canOfferClassCancel({ startsAt: FUTURE, status: "COMPLETED" }, NOW), false);
  assert.equal(canOfferClassCancel({ startsAt: FUTURE, status: "CANCELLED" }, NOW), false);
});

test("series confirmations mention classes kept because of attendance", () => {
  assert.equal(protectedClassesNote(0), "");
  assert.equal(protectedClassesNote(undefined), "");
  assert.equal(protectedClassesNote(1), " 1 clase con asistencia registrada se conservará.");
  assert.equal(protectedClassesNote(3), " 3 clases con asistencia registrada se conservarán.");
});

test("schedule UI wiring follows the cancellation policy", () => {
  const drawer = readFileSync(new URL("../app/schedule/SessionDrawer.tsx", import.meta.url), "utf8");
  assert.match(drawer, /canOfferClassCancel\(\{ startsAt: session\.class\.startsAt, attendedCount: session\.occupancy\.attended \}\)/);
  const modal = readFileSync(new URL("../app/schedule/ScheduleModal.tsx", import.meta.url), "utf8");
  assert.match(modal, /canOfferClassCancel\(\{ startsAt: modal\.cls\.startsAt, attendedCount: modal\.cls\.checkedInCount \}\)/);
  assert.match(modal, /protectedClassesNote\(impact\.protectedClassCount\)/);
  const page = readFileSync(new URL("../app/schedule/page.tsx", import.meta.url), "utf8");
  assert.match(page, /protectedClassesNote\(impact\.protectedClassCount\)/);
  assert.match(page, /protectedClassesNote\(result\.skippedProtectedCount\)/);
  const finish = readFileSync(new URL("../app/schedule/FinishSeriesModal.tsx", import.meta.url), "utf8");
  assert.match(finish, /protectedClassesNote\(preview\.skippedProtectedCount\)/);
});
