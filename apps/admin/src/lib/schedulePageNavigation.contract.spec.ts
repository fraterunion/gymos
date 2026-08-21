import assert from "node:assert/strict";
import test from "node:test";

import {
  currentWeekStartKey,
  resolveDisplayWeekStartKey,
  shiftDisplayWeekStartKey,
  weekBoundsFromStartKey,
} from "./scheduleWeekNavigation.ts";

const TZ = "America/Mexico_City";

/** Mirrors schedule page week navigation state transitions. */
type PageNavState = {
  displayWeekStartKey: string | null;
  urlWeekStart: string | null;
  sessionClassId: string | null;
};

function effectiveWeekStartKey(state: PageNavState): string {
  return resolveDisplayWeekStartKey(state.displayWeekStartKey, state.urlWeekStart, TZ);
}

function shiftWeek(state: PageNavState, delta: number): PageNavState {
  const base = effectiveWeekStartKey(state);
  return {
    ...state,
    displayWeekStartKey: shiftDisplayWeekStartKey(base, delta),
    urlWeekStart: null,
  };
}

function goToToday(state: PageNavState): PageNavState {
  return {
    ...state,
    displayWeekStartKey: currentWeekStartKey(TZ),
    urlWeekStart: null,
  };
}

function openSession(state: PageNavState, classId: string): PageNavState {
  return { ...state, sessionClassId: classId };
}

function closeSession(state: PageNavState): PageNavState {
  return { ...state, sessionClassId: null };
}

function weekStartForFetch(state: PageNavState): string {
  return weekBoundsFromStartKey(effectiveWeekStartKey(state), TZ).startKey;
}

test("next week changes displayed week and schedule fetch week", () => {
  const initial: PageNavState = {
    displayWeekStartKey: "2026-08-17",
    urlWeekStart: null,
    sessionClassId: null,
  };
  const before = weekStartForFetch(initial);
  const next = shiftWeek(initial, 1);
  assert.equal(effectiveWeekStartKey(next), "2026-08-24");
  const after = weekStartForFetch(next);
  assert.notEqual(before, after);
});

test("previous week returns to original week", () => {
  const initial: PageNavState = {
    displayWeekStartKey: "2026-08-17",
    urlWeekStart: null,
    sessionClassId: null,
  };
  const back = shiftWeek(shiftWeek(initial, 1), -1);
  assert.equal(effectiveWeekStartKey(back), "2026-08-17");
});

test("Hoy returns to current studio-local week", () => {
  const far: PageNavState = {
    displayWeekStartKey: "2026-12-01",
    urlWeekStart: null,
    sessionClassId: null,
  };
  const today = goToToday(far);
  assert.equal(effectiveWeekStartKey(today), currentWeekStartKey(TZ));
});

test("SessionDrawer open/close does not alter displayed week", () => {
  const initial: PageNavState = {
    displayWeekStartKey: "2026-08-24",
    urlWeekStart: null,
    sessionClassId: null,
  };
  const opened = openSession(initial, "class-123");
  const closed = closeSession(opened);
  assert.equal(effectiveWeekStartKey(closed), "2026-08-24");
});

test("duplicate-week source equals displayed week start key", () => {
  const state: PageNavState = {
    displayWeekStartKey: "2026-08-24",
    urlWeekStart: "2026-08-17T12:00:00.000Z",
    sessionClassId: null,
  };
  assert.equal(effectiveWeekStartKey(state), "2026-08-24");
});

test("URL week is used only until display state is initialized", () => {
  const fromUrl: PageNavState = {
    displayWeekStartKey: null,
    urlWeekStart: "2026-08-20T12:00:00.000Z",
    sessionClassId: null,
  };
  assert.equal(effectiveWeekStartKey(fromUrl), "2026-08-17");
  const navigated = shiftWeek(
    { ...fromUrl, displayWeekStartKey: resolveDisplayWeekStartKey(null, fromUrl.urlWeekStart, TZ) },
    1,
  );
  assert.equal(effectiveWeekStartKey(navigated), "2026-08-24");
});
