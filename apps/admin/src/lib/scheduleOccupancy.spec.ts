import assert from 'node:assert/strict';
import test from 'node:test';

import { formatOccupancyLabel, formatRosterStatus } from './scheduleOccupancy.ts';
import { translateConflictMessage } from './scheduleConflictCopy.ts';

test('formatOccupancyLabel uses Spanish patterns', () => {
  assert.deepEqual(formatOccupancyLabel(4, 12), {
    label: '4/12 reservados',
    tone: 'normal',
  });
  assert.equal(formatOccupancyLabel(12, 12).label, '12/12 · Llena');
  assert.equal(formatOccupancyLabel(12, 12, 3).label, '12/12 · +3 en espera');
});

test('formatRosterStatus returns Spanish operational labels', () => {
  assert.equal(formatRosterStatus('RESERVED', null, 'America/Mexico_City'), 'Reservado');
  assert.match(
    formatRosterStatus('ATTENDED', '2026-09-10T13:03:00.000Z', 'America/Mexico_City'),
    /^Asistió · /,
  );
});

test('translateConflictMessage localizes instructor overlap', () => {
  const msg = translateConflictMessage('Etzia Ferrabone already teaches Booty Lab at this time.');
  assert.equal(msg, 'Etzia Ferrabone ya tiene una clase asignada en ese horario (Booty Lab).');
});
