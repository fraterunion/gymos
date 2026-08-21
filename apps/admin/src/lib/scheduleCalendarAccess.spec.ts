import assert from 'node:assert/strict';
import test from 'node:test';

import { canManageCalendarOperations } from './scheduleCalendarAccess.ts';

test('canManageCalendarOperations allows OWNER and ADMIN', () => {
  assert.equal(canManageCalendarOperations('OWNER'), true);
  assert.equal(canManageCalendarOperations('ADMIN'), true);
});

test('canManageCalendarOperations denies STAFF, INSTRUCTOR, FRONT_DESK, and unknown', () => {
  assert.equal(canManageCalendarOperations('STAFF'), false);
  assert.equal(canManageCalendarOperations('INSTRUCTOR'), false);
  assert.equal(canManageCalendarOperations('FRONT_DESK'), false);
  assert.equal(canManageCalendarOperations(null), false);
  assert.equal(canManageCalendarOperations(undefined), false);
});
