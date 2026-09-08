import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addConfirmationCopy,
  staffSaleRelationshipCopy,
  attachScheduledSuccessors,
  blockedReasonCopy,
  bookingChargeLine,
  changeConfirmationCopy,
  isPurchaseActionDisabled,
  membershipCreditsDisplay,
  membershipPriceLine,
  membershipStatusDisplay,
  orderMembershipsForDisplay,
  passPlanLine,
  purchaseCtaLabel,
  scheduledSuccessorLine,
  type MembershipSummaryLike,
} from './membershipDisplay.ts';

const NOW = new Date('2026-09-08T12:00:00Z');
const FUTURE = '2026-10-22T12:00:00.000Z';
const PAST = '2026-08-01T12:00:00.000Z';

function row(overrides: Partial<MembershipSummaryLike>): MembershipSummaryLike {
  return {
    subscriptionId: 'sub-1',
    membershipPlanId: 'plan-full',
    exclusiveGroup: 'CORE',
    status: 'ACTIVE',
    source: 'STRIPE',
    isEntitled: true,
    currentPeriodStart: '2026-09-01T00:00:00.000Z',
    currentPeriodEnd: FUTURE,
    entitlementEndsAt: null,
    effectiveEnd: FUTURE,
    cancelAtPeriodEnd: false,
    supersededBySubscriptionId: null,
    creditsUsed: null,
    creditsRemaining: null,
    plan: {
      id: 'plan-full',
      name: 'Full Access',
      priceCents: 150000,
      currency: 'mxn',
      billingInterval: 'MONTHLY',
      classCredits: null,
      entitlementDays: null,
    },
    pendingPlan: null,
    ...overrides,
  };
}

// ── Status copy matrix ─────────────────────────────────────────────────────────

test('ACTIVE renewing → Activa + Renueva date line', () => {
  const d = membershipStatusDisplay(row({}), { now: NOW });
  assert.equal(d.label, 'Activa');
  assert.equal(d.tone, 'positive');
  assert.match(d.dateLine ?? '', /^Renueva el /);
});

test('ACTIVE + cancelAtPeriodEnd → Activa · No renovará (never plain Cancelada)', () => {
  const d = membershipStatusDisplay(row({ cancelAtPeriodEnd: true }), { now: NOW });
  assert.equal(d.label, 'Activa · No renovará');
  assert.equal(d.tone, 'caution');
  assert.match(d.dateLine ?? '', /^Acceso hasta el /);
});

test('CANCELED-but-entitled → "Activa hasta <date>" + "No renovará", NOT Cancelada', () => {
  const d = membershipStatusDisplay(
    row({ status: 'CANCELED', isEntitled: true, entitlementEndsAt: FUTURE, effectiveEnd: FUTURE }),
    { now: NOW },
  );
  assert.match(d.label, /^Activa hasta el /);
  assert.equal(d.dateLine, 'No renovará');
  assert.notEqual(d.tone, 'negative');
});

test('fixed-duration ACTIVE (Booty) → Válida hasta, even with cancelAtPeriodEnd (cash-by-design)', () => {
  const d = membershipStatusDisplay(
    row({
      cancelAtPeriodEnd: true,
      entitlementEndsAt: FUTURE,
      plan: { ...row({}).plan, entitlementDays: 45, classCredits: 4 },
    }),
    { now: NOW },
  );
  assert.equal(d.label, 'Activa');
  assert.match(d.dateLine ?? '', /^Válida hasta el /);
});

test('expired → Vencida regardless of raw status', () => {
  for (const status of ['ACTIVE', 'TRIALING', 'CANCELED']) {
    const d = membershipStatusDisplay(
      row({ status, effectiveEnd: PAST, entitlementEndsAt: PAST, currentPeriodEnd: PAST, isEntitled: false }),
      { now: NOW },
    );
    assert.equal(d.label, 'Vencida');
    assert.equal(d.tone, 'negative');
  }
});

test('PAST_DUE / PAUSED / SCHEDULED labels', () => {
  assert.equal(membershipStatusDisplay(row({ status: 'PAST_DUE', isEntitled: false }), { now: NOW }).label, 'Pago pendiente');
  assert.equal(membershipStatusDisplay(row({ status: 'PAUSED', isEntitled: false }), { now: NOW }).label, 'Pausada');
  assert.equal(membershipStatusDisplay(row({ status: 'SCHEDULED', isEntitled: false }), { now: NOW }).label, 'Programada');
});

// ── Credits — never aggregated ────────────────────────────────────────────────

test('credits render per membership; unlimited says Clases ilimitadas', () => {
  assert.equal(membershipCreditsDisplay(null, null, null).primary, 'Clases ilimitadas');
  const limited = membershipCreditsDisplay(4, 1, 3);
  assert.equal(limited.primary, '3 de 4 créditos disponibles');
  assert.equal(limited.secondary, '1 usados en este periodo');
});

test('two credit-limited memberships keep independent counters (no aggregation possible by design)', () => {
  const a = membershipCreditsDisplay(4, 1, 3);
  const b = membershipCreditsDisplay(12, 2, 10);
  assert.notEqual(a.primary, b.primary);
  assert.equal(a.primary.includes('4'), true);
  assert.equal(b.primary.includes('12'), true);
});

// ── Ordering + scheduled attachment ───────────────────────────────────────────

test('ordering: base (group) entitled first, then entitled specialty, then non-entitled', () => {
  const booty = row({ subscriptionId: 's-booty', membershipPlanId: 'plan-booty', exclusiveGroup: null });
  const full = row({ subscriptionId: 's-full' });
  const pastDue = row({ subscriptionId: 's-pd', status: 'PAST_DUE', isEntitled: false, exclusiveGroup: null });
  const ordered = orderMembershipsForDisplay([pastDue, booty, full]);
  assert.deepEqual(ordered.map((r) => r.subscriptionId), ['s-full', 's-booty', 's-pd']);
});

test('scheduled successor attaches to the row that points at it and never renders as a peer', () => {
  const successor = row({ subscriptionId: 's-next', status: 'SCHEDULED', source: 'CASH', isEntitled: false });
  const full = row({ subscriptionId: 's-full', supersededBySubscriptionId: 's-next' });
  const booty = row({ subscriptionId: 's-booty', membershipPlanId: 'plan-booty', exclusiveGroup: null });
  const { memberships, orphanSuccessors } = attachScheduledSuccessors([successor, booty, full]);
  assert.equal(orphanSuccessors.length, 0);
  const fullEntry = memberships.find((m) => m.membership.subscriptionId === 's-full');
  const bootyEntry = memberships.find((m) => m.membership.subscriptionId === 's-booty');
  assert.equal(fullEntry?.successor?.subscriptionId, 's-next');
  assert.equal(bootyEntry?.successor, null);
  assert.equal(memberships.some((m) => m.membership.subscriptionId === 's-next'), false);
});

test('scheduled successor line for a cash transition', () => {
  const line = scheduledSuccessorLine({ currentPeriodStart: '2026-10-13T06:00:00.000Z', source: 'CASH' });
  assert.match(line, /^Cambia a pago en el estudio el /);
});

// ── Catalog CTAs — server verdicts rendered verbatim ──────────────────────────

test('purchaseAction → CTA label matrix', () => {
  assert.equal(purchaseCtaLabel('SUBSCRIBE'), 'Suscribirme');
  assert.equal(purchaseCtaLabel('CURRENT'), 'Plan actual');
  assert.equal(purchaseCtaLabel('RENEW'), 'Renovar');
  assert.equal(purchaseCtaLabel('CHANGE'), 'Cambiar plan');
  assert.equal(purchaseCtaLabel('ADD'), 'Agregar membresía');
  assert.equal(purchaseCtaLabel('SCHEDULED'), 'Programada');
  assert.equal(purchaseCtaLabel('BLOCKED'), 'No disponible');
});

test('CURRENT/SCHEDULED/BLOCKED are disabled; blocked reasons have copy', () => {
  assert.equal(isPurchaseActionDisabled('CURRENT'), true);
  assert.equal(isPurchaseActionDisabled('SCHEDULED'), true);
  assert.equal(isPurchaseActionDisabled('BLOCKED'), true);
  assert.equal(isPurchaseActionDisabled('ADD'), false);
  assert.match(blockedReasonCopy('STACKING_DISABLED') ?? '', /recepción/);
  assert.match(blockedReasonCopy('PAST_DUE') ?? '', /pago pendiente/i);
});

// ── Confirmations ─────────────────────────────────────────────────────────────

test('ADD confirmation never implies replacement and names the kept membership', () => {
  const copy = addConfirmationCopy({ planName: 'Booty Lab by Etzia', keptPlanNames: ['Full Access'] });
  assert.equal(copy.title, 'Agregar Booty Lab by Etzia');
  assert.match(copy.body, /se agregará a tus membresías/);
  assert.match(copy.keptLine ?? '', /Full Access seguirá activa, sin cambios/);
  assert.doesNotMatch(copy.body + (copy.keptLine ?? ''), /reemplaz|cambiar/i);
});

test('CHANGE confirmation names both plans explicitly', () => {
  const copy = changeConfirmationCopy({ currentPlanName: 'Full Access', targetPlanName: 'Basic Access' });
  assert.equal(copy.title, 'Cambiar Full Access → Basic Access');
  assert.match(copy.body, /Full Access/);
  assert.match(copy.body, /Basic Access/);
});

// ── Booking attribution + Mi Pase ─────────────────────────────────────────────

test('booking charge line only speaks when a scarce credit is consumed', () => {
  assert.equal(bookingChargeLine(null), null);
  assert.equal(bookingChargeLine({ planName: 'Full Access', creditConsumed: false }), null);
  assert.equal(
    bookingChargeLine({ planName: 'Booty Lab by Etzia', creditConsumed: true }),
    'Usará 1 crédito de Booty Lab by Etzia',
  );
});

test('Mi Pase line shows primary plus compact count when stacked', () => {
  assert.equal(passPlanLine('Full Access', 1), 'Full Access');
  assert.equal(passPlanLine('Full Access', 2), 'Full Access · +1 membresía');
  assert.equal(passPlanLine('Full Access', 3), 'Full Access · +2 membresías');
  assert.equal(passPlanLine(null, 2), null);
});

test('price line: interval vs fixed-duration', () => {
  assert.match(membershipPriceLine({ priceCents: 150000, currency: 'mxn', billingInterval: 'MONTHLY', entitlementDays: null }), /\/mes$/);
  assert.match(membershipPriceLine({ priceCents: 80000, currency: 'mxn', billingInterval: 'MONTHLY', entitlementDays: 45 }), /45 días$/);
});

test('staff sale relationship copy distinguishes add / change / renew', () => {
  const add = staffSaleRelationshipCopy({ action: 'ADD', planName: 'Booty Lab', relatedPlanName: null, memberName: 'Ana' });
  assert.equal(add.title, 'Agregar Booty Lab');
  assert.match(add.note ?? '', /de Ana no se modifican/);
  const change = staffSaleRelationshipCopy({ action: 'CHANGE', planName: 'Basic Access', relatedPlanName: 'Full Access' });
  assert.equal(change.title, 'Cambiar Full Access → Basic Access');
  const renew = staffSaleRelationshipCopy({ action: 'RENEW', planName: 'Full Access', relatedPlanName: 'Full Access' });
  assert.equal(renew.title, 'Renovar Full Access');
});
