import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveAresPlanBenefits } from './membershipBenefits.ts';

describe('member-facing benefits reflect editable plan description', () => {
  it('renders each admin-entered line as a separate bullet in order', () => {
    assert.deepEqual(resolveAresPlanBenefits({
      description: '12 clases al mes\nAcceso a Open Gym\n3 guest passes',
    }), ['12 clases al mes', 'Acceso a Open Gym', '3 guest passes']);
  });

  it('accepts pasted bullet and numbered text', () => {
    assert.deepEqual(resolveAresPlanBenefits({
      description: '• Clases ilimitadas\n- Tina de hielo\n2. Eventos',
    }), ['Clases ilimitadas', 'Tina de hielo', 'Eventos']);
  });

  it('does not show hardcoded text when admin clears the description', () => {
    assert.deepEqual(resolveAresPlanBenefits({ description: null }), []);
    assert.deepEqual(resolveAresPlanBenefits({ description: '  \n  ' }), []);
  });

  it('supports an ordinary single-line description', () => {
    assert.deepEqual(resolveAresPlanBenefits({
      description: 'Membresía personalizada',
    }), ['Membresía personalizada']);
  });
});
