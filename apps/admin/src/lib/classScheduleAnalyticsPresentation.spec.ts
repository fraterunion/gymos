import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  groupLimitedHistoryByWeekday,
  LIMITED_HISTORY_FOOTNOTE,
  partitionDrawerSlotsByMaturity,
} from "./classScheduleAnalyticsPresentation.ts";

test("groupLimitedHistoryByWeekday groups Mon→Sun with exact HH:MM and n", () => {
  const groups = groupLimitedHistoryByWeekday([
    { weekday: 4, scheduleTime: "07:15", scheduledSessions: 1 },
    { weekday: 2, scheduleTime: "07:05", scheduledSessions: 1 },
    { weekday: 2, scheduleTime: "06:00", scheduledSessions: 2 },
    { weekday: 1, scheduleTime: "18:00", scheduledSessions: 1 },
  ]);
  assert.deepEqual(
    groups.map((g) => g.label),
    ["Lunes", "Martes", "Jueves"],
  );
  assert.equal(groups[1]!.items[0]!.scheduleTime, "06:00");
  assert.equal(groups[1]!.items[1]!.scheduleTime, "07:05");
  assert.equal(groups[2]!.items[0]!.scheduleTime, "07:15");
  assert.equal(groups[1]!.items[1]!.scheduledSessions, 1);
});

test("LIMITED_HISTORY_FOOTNOTE is a single shared caption", () => {
  assert.match(LIMITED_HISTORY_FOOTNOTE, /KPIs generales/);
  assert.doesNotMatch(LIMITED_HISTORY_FOOTNOTE, /incluidas en KPIs/);
});

test("partitionDrawerSlotsByMaturity puts established before limited even if limited avg is higher", () => {
  const { established, limited } = partitionDrawerSlotsByMaturity([
    {
      slotMaturity: "LIMITED_HISTORY_SLOT" as const,
      avgAttendance: 5,
      scheduleTime: "07:00",
    },
    {
      slotMaturity: "ESTABLISHED_SLOT" as const,
      avgAttendance: 1.8,
      scheduleTime: "09:00",
    },
    {
      slotMaturity: "LIMITED_HISTORY_SLOT" as const,
      avgAttendance: 4,
      scheduleTime: "06:00",
    },
    {
      slotMaturity: "ESTABLISHED_SLOT" as const,
      avgAttendance: 2.1,
      scheduleTime: "08:00",
    },
  ]);
  assert.equal(established[0]!.avgAttendance, 2.1);
  assert.equal(established[1]!.avgAttendance, 1.8);
  assert.equal(limited[0]!.avgAttendance, 5);
  assert.equal(limited[1]!.avgAttendance, 4);
  // n=1 limited cannot precede the established section.
  assert.ok(established.length > 0);
  assert.notEqual(limited[0]!.scheduleTime, established[0]!.scheduleTime);
});

test("exact odd minutes 07:05 and 07:15 are preserved in grouping", () => {
  const groups = groupLimitedHistoryByWeekday([
    { weekday: 2, scheduleTime: "07:05", scheduledSessions: 1 },
    { weekday: 4, scheduleTime: "07:15", scheduledSessions: 1 },
  ]);
  const times = groups.flatMap((g) => g.items.map((i) => i.scheduleTime));
  assert.deepEqual(times, ["07:05", "07:15"]);
  assert.ok(!times.includes("07:00"));
  assert.ok(!times.includes("07:10"));
});

test("classes page heatmap preserves exact HH:MM and established-first slot table", () => {
  const src = readFileSync(
    new URL("../app/analytics/classes/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(src, /whitespace-nowrap/);
  assert.match(src, /min-w-\[3\.25rem\]/);
  assert.match(src, /overflow-x-auto/);
  assert.match(src, /from-white to-transparent md:hidden/);
  assert.match(src, /slotsLimitedOpen/);
  assert.match(src, /Ver \$\{limitedSlots\.length\}/);
  assert.match(src, /LIMITED_HISTORY_FOOTNOTE/);
  assert.match(src, /Horarios con evidencia suficiente/);
  assert.match(src, /partitionDrawerSlotsByMaturity/);
  assert.doesNotMatch(src, /incluidas en KPIs; aún no en comparación estratégica/);
});
