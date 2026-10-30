import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { classHasStarted } from "./classCancellation.ts";

const NOW = Date.parse("2026-10-30T15:00:00.000Z");

test("a class that started, or is starting now, counts as started", () => {
  assert.equal(classHasStarted("2026-10-30T14:00:00.000Z", NOW), true);
  assert.equal(classHasStarted("2026-10-30T15:00:00.000Z", NOW), true);
  assert.equal(classHasStarted("2026-10-30T15:00:01.000Z", NOW), false);
});

test("schedule drawer and class modal hide 'Cancelar clase' once the class has started", () => {
  const drawer = readFileSync(new URL("../app/schedule/SessionDrawer.tsx", import.meta.url), "utf8");
  assert.match(drawer, /session\.class\.status === "SCHEDULED" && !classHasStarted\(session\.class\.startsAt\)/);
  const modal = readFileSync(new URL("../app/schedule/ScheduleModal.tsx", import.meta.url), "utf8");
  assert.match(modal, /modal\.type === "edit" && !isCancelled && !classHasStarted\(modal\.cls\.startsAt\)/);
});
