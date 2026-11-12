import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  filterOpenGymSlots,
  isOpenGymSlotIncluded,
  NO_OPEN_GYM,
  openGymCardTitle,
  resolveOpenGymEntitlement,
} from './openGymEntitlement.ts';

const STUDIO_LABEL = 'Open Gym · 10:00 a.m. – 5:00 p.m.';

const cls = (id: string, isOpenGymSlot?: boolean) => ({ id, classTemplate: { isOpenGymSlot } });

test('fail-closed: missing profile, missing field, or included !== true → hidden', () => {
  assert.deepEqual(resolveOpenGymEntitlement(null), NO_OPEN_GYM);
  assert.deepEqual(resolveOpenGymEntitlement({}), NO_OPEN_GYM);
  assert.deepEqual(resolveOpenGymEntitlement({ openGym: null }), NO_OPEN_GYM);
  assert.deepEqual(resolveOpenGymEntitlement({ openGym: { included: false, membershipPlanName: 'Basic Access' } }), NO_OPEN_GYM);
});

test('Full Access (unrestricted) is included and keeps the studio label', () => {
  const ent = resolveOpenGymEntitlement({
    openGym: { included: true, membershipPlanName: 'Full Access', windowStart: null, windowEnd: null },
  });
  assert.equal(ent.included, true);
  assert.equal(openGymCardTitle(ent, STUDIO_LABEL), STUDIO_LABEL);
});

test('a plan with its own window shows the hours the door enforces', () => {
  const ent = resolveOpenGymEntitlement({
    openGym: { included: true, membershipPlanName: 'Open Gym', windowStart: '11:00', windowEnd: '17:00' },
  });
  assert.equal(openGymCardTitle(ent, STUDIO_LABEL), 'Open Gym · 11:00 AM – 5:00 PM');
});

test('Basic / Pro: Open Gym slots removed from browsing lists, every other class kept', () => {
  const classes = [cls('strength', false), cls('og', true), cls('legacy')];
  assert.deepEqual(
    filterOpenGymSlots(classes, NO_OPEN_GYM).map((c) => c.id),
    ['strength', 'legacy'],
  );
});

test('Full Access: Open Gym slots stay visible', () => {
  const classes = [cls('strength', false), cls('og', true)];
  assert.deepEqual(
    filterOpenGymSlots(classes, { included: true }).map((c) => c.id),
    ['strength', 'og'],
  );
});

test('class detail: Open Gym slot included only with entitlement; ordinary classes unaffected', () => {
  assert.equal(isOpenGymSlotIncluded({ isOpenGymSlot: true }, NO_OPEN_GYM), false);
  assert.equal(isOpenGymSlotIncluded({ isOpenGymSlot: true }, { included: true }), true);
  assert.equal(isOpenGymSlotIncluded({ isOpenGymSlot: false }, NO_OPEN_GYM), true);
  assert.equal(isOpenGymSlotIncluded({}, NO_OPEN_GYM), true);
});

test('no screen renders the Open Gym card without an entitlement, and guests never see it', () => {
  // Resolve a plain filesystem path: the mobile tsconfig's global `URL` is the DOM / React Native
  // type, which Node's readFileSync overloads do not accept.
  const specDir = dirname(fileURLToPath(import.meta.url));
  const read = (p: string) => readFileSync(join(specDir, p), 'utf8');
  const card = read('../components/OpenGymBenefitCard.tsx');
  assert.match(card, /if \(!entitlement\.included\) return null;/);
  for (const screen of ['../app/(app)/(tabs)/index.tsx', '../app/(app)/(tabs)/schedule.tsx']) {
    const source = read(screen);
    const usages = source.match(/<OpenGymBenefitCard\b[^>]*>/g) ?? [];
    assert.ok(usages.length > 0, `${screen} should still render the card for entitled members`);
    for (const usage of usages) assert.match(usage, /entitlement=\{/);
  }
});
