import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveDisplayWeekStartKey,
  shiftDisplayWeekStartKey,
  weekBoundsFromStartKey,
} from './scheduleWeekNavigation.ts';

const TZ = 'America/Mexico_City';

test('shiftDisplayWeekStartKey moves exactly one week forward and back', () => {
  const start = '2026-08-17';
  assert.equal(shiftDisplayWeekStartKey(start, 1), '2026-08-24');
  assert.equal(shiftDisplayWeekStartKey(start, -1), '2026-08-10');
  assert.equal(shiftDisplayWeekStartKey(shiftDisplayWeekStartKey(start, 1), -1), start);
});

test('resolveDisplayWeekStartKey prefers explicit display state over URL', () => {
  assert.equal(
    resolveDisplayWeekStartKey('2026-08-24', '2026-08-17T12:00:00.000Z', TZ),
    '2026-08-24',
  );
});

test('resolveDisplayWeekStartKey falls back to URL then current week', () => {
  assert.equal(
    resolveDisplayWeekStartKey(null, '2026-08-20T12:00:00.000Z', TZ),
    '2026-08-17',
  );
  const current = resolveDisplayWeekStartKey(null, null, TZ);
  assert.match(current, /^\d{4}-\d{2}-\d{2}$/);
});

test('weekBoundsFromStartKey matches explicit Monday start', () => {
  const bounds = weekBoundsFromStartKey('2026-08-24', TZ);
  assert.equal(bounds.startKey, '2026-08-24');
  assert.equal(bounds.endKey, '2026-08-30');
});

test('next then previous week returns to original start key', () => {
  const start = '2026-08-17';
  const next = shiftDisplayWeekStartKey(start, 1);
  const back = shiftDisplayWeekStartKey(next, -1);
  assert.equal(back, start);
});
