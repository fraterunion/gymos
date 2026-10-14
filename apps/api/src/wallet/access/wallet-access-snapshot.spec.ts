import { DayPassStatus, SubscriptionEndReason, SubscriptionSource, SubscriptionStatus } from '@prisma/client';
import {
  computeWalletAccessSnapshot,
  resolveEntitledPrimaryPlanName,
  type WalletAccessInput,
  type WalletAccessPlanInput,
  type WalletAccessSubscriptionInput,
} from './wallet-access-snapshot';
import { buildWalletPassDisplay, describeScopeEs, formatInclusiveEndEs } from './wallet-access-display';

const TZ = 'America/Mexico_City';

const FULL_ACCESS: WalletAccessPlanInput = {
  id: 'plan_full',
  name: 'Full Access',
  classCredits: null,
  allClassesAccess: true,
  entitlementDays: null,
  openGymAccess: true,
  openGymWindowStart: '05:00',
  openGymWindowEnd: '22:00',
};
const BOOTY_LAB: WalletAccessPlanInput = {
  id: 'plan_booty',
  name: 'Booty Lab',
  classCredits: 4,
  allClassesAccess: false,
  entitlementDays: 45,
  openGymAccess: false,
  openGymWindowStart: null,
  openGymWindowEnd: null,
};

let seq = 0;
function sub(overrides: Partial<WalletAccessSubscriptionInput> = {}): WalletAccessSubscriptionInput {
  seq += 1;
  return {
    id: `sub_${seq}`,
    status: SubscriptionStatus.ACTIVE,
    source: SubscriptionSource.CASH,
    currentPeriodStart: new Date('2026-09-09T12:03:37.824Z'),
    currentPeriodEnd: new Date('2026-10-09T12:03:37.824Z'),
    entitlementEndsAt: null,
    cancelAtPeriodEnd: true,
    exclusiveGroupKey: 'CORE',
    supersededBySubscriptionId: null,
    endReason: null,
    createdAt: new Date('2026-09-09T12:03:38.567Z'),
    plan: FULL_ACCESS,
    ...overrides,
  };
}

function input(overrides: Partial<WalletAccessInput> = {}): WalletAccessInput {
  return {
    studio: { id: 'studio_ares', timezone: TZ },
    member: { userId: 'user_1', firstName: 'Ana', lastName: 'Prueba' },
    credential: { id: 'wc_1', revokedAt: null },
    studioMembershipActive: true,
    subscriptions: [],
    dayPasses: [],
    ...overrides,
  };
}

describe('WalletAccessSnapshot — October 2026 expired-cash regression', () => {
  // The incident shape: the member's cash Full Access row still reads status ACTIVE after its
  // paid period ended on Oct 9 06:03 (Mexico City); the renewal row it replaced is CANCELED.
  const previous = sub({
    id: 'sub_prev',
    status: SubscriptionStatus.CANCELED,
    currentPeriodStart: new Date('2026-07-27T18:00:00.000Z'),
    currentPeriodEnd: new Date('2026-08-28T05:59:59.000Z'),
    endReason: SubscriptionEndReason.SUPERSEDED_RENEWAL,
    supersededBySubscriptionId: 'sub_current',
    createdAt: new Date('2026-07-27T13:14:33.913Z'),
  });
  const current = sub({ id: 'sub_current' });
  const subs = [previous, current];

  it('is NOT a current membership on Oct 13 even though the stored status is ACTIVE', () => {
    const snap = computeWalletAccessSnapshot(input({ subscriptions: subs }), new Date('2026-10-13T12:05:41.000Z'));
    expect(snap.overall).toBe('INACTIVE');
    expect(snap.headline).toMatchObject({ subscriptionId: 'sub_current', isEntitled: false, accessState: 'EXPIRED', lifecycleStatus: 'EXPIRED' });
    // The superseded renewal row is history, not something to show.
    expect(snap.memberships.map((m) => m.subscriptionId)).toEqual(['sub_current']);
    expect(snap.nextTransitionAt).toBeNull();

    const display = buildWalletPassDisplay(snap);
    expect(display.status.value).toBe('VENCIDA');
    expect(display.validity?.value).toBe('Venció el 9 oct 2026');
    expect(display.scope).toBeNull();
    expect(display.voided).toBe(false); // an identity pass is never voided because a period lapsed
  });

  it('the corrected plan source names no plan once the period ended', () => {
    expect(resolveEntitledPrimaryPlanName(subs, new Date('2026-10-13T12:05:41.000Z'))).toBeNull();
  });

  it('uses the exclusive end boundary exactly like check-in does', () => {
    const end = new Date('2026-10-09T12:03:37.824Z');
    const before = computeWalletAccessSnapshot(input({ subscriptions: subs }), new Date(end.getTime() - 1));
    expect(before.overall).toBe('ACCESS_VALID');
    expect(before.headline?.renewal).toBe('ENDS_AT_PERIOD_END');
    expect(before.nextTransitionAt).toBe(end.toISOString());
    expect(buildWalletPassDisplay(before).validity?.value).toBe('Vigente hasta el 9 oct 2026, 06:03');

    const atEnd = computeWalletAccessSnapshot(input({ subscriptions: subs }), end);
    expect(atEnd.overall).toBe('INACTIVE');
  });
});

describe('WalletAccessSnapshot — membership kinds', () => {
  const NOW = new Date('2026-10-13T18:00:00.000Z');

  it('Stripe renewing membership: current, renews on the period end', () => {
    const stripe = sub({
      source: SubscriptionSource.STRIPE,
      cancelAtPeriodEnd: false,
      currentPeriodStart: new Date('2026-10-14T01:12:27.000Z'),
      currentPeriodEnd: new Date('2026-11-14T01:12:27.000Z'),
    });
    const snap = computeWalletAccessSnapshot(input({ subscriptions: [stripe] }), new Date('2026-10-20T18:00:00.000Z'));
    expect(snap.overall).toBe('ACCESS_VALID');
    expect(snap.headline).toMatchObject({ renewal: 'AUTO_RENEWS', isPrimary: true });
    const display = buildWalletPassDisplay(snap);
    expect(display.status.value).toBe('VIGENTE');
    expect(display.plan).toEqual({ key: 'plan', label: 'PLAN', value: 'Full Access' });
    expect(display.validity?.value).toBe('Renueva el 13 nov 2026');
    expect(display.scope?.value).toBe('Todas las clases · Gimnasio 05:00–22:00');
  });

  it('Stripe PAST_DUE: payment pending, never shown as current', () => {
    const pastDue = sub({ source: SubscriptionSource.STRIPE, status: SubscriptionStatus.PAST_DUE, cancelAtPeriodEnd: false, currentPeriodEnd: new Date('2026-11-14T01:12:27.000Z') });
    const snap = computeWalletAccessSnapshot(input({ subscriptions: [pastDue] }), NOW);
    expect(snap.overall).toBe('PAYMENT_PENDING');
    const display = buildWalletPassDisplay(snap);
    expect(display.status.value).toBe('PAGO PENDIENTE');
    expect(display.validity?.value).toBe('Actualiza tu método de pago');
  });

  it('fixed-duration Stripe membership: the paid cycle (entitlementEndsAt) is the window', () => {
    const booty = sub({
      plan: BOOTY_LAB,
      exclusiveGroupKey: null,
      source: SubscriptionSource.STRIPE,
      cancelAtPeriodEnd: false,
      currentPeriodStart: new Date('2026-10-02T16:54:40.000Z'),
      currentPeriodEnd: new Date('2026-11-16T16:54:40.000Z'),
      entitlementEndsAt: new Date('2026-11-16T16:54:40.000Z'),
    });
    const snap = computeWalletAccessSnapshot(input({ subscriptions: [booty] }), NOW);
    expect(snap.overall).toBe('ACCESS_VALID');
    expect(snap.headline).toMatchObject({ fixedDuration: true, effectiveEnd: '2026-11-16T16:54:40.000Z' });
    expect(buildWalletPassDisplay(snap).validity?.value).toBe('Renueva el 16 nov 2026');
  });

  it('CANCELED but still entitled (paid window running): current, ends without renewing', () => {
    const canceled = sub({
      plan: BOOTY_LAB,
      exclusiveGroupKey: null,
      status: SubscriptionStatus.CANCELED,
      source: SubscriptionSource.STRIPE,
      cancelAtPeriodEnd: false,
      entitlementEndsAt: new Date('2026-11-16T16:54:40.000Z'),
    });
    const snap = computeWalletAccessSnapshot(input({ subscriptions: [canceled] }), NOW);
    expect(snap.overall).toBe('ACCESS_VALID');
    expect(snap.headline).toMatchObject({ lifecycleStatus: 'ENDING', renewal: 'ENDS_AT_PERIOD_END' });
    expect(buildWalletPassDisplay(snap).validity?.value).toBe('Vigente hasta el 16 nov 2026, 10:54');
  });

  it('CANCELED with no paid window and PAUSED are not current', () => {
    const canceled = sub({ status: SubscriptionStatus.CANCELED, source: SubscriptionSource.STRIPE, currentPeriodEnd: new Date('2026-11-14T01:12:27.000Z') });
    const snapC = computeWalletAccessSnapshot(input({ subscriptions: [canceled] }), NOW);
    expect(snapC.overall).toBe('INACTIVE');
    expect(buildWalletPassDisplay(snapC).status.value).toBe('NO VIGENTE');
    expect(buildWalletPassDisplay(snapC).details[0]!.value).toBe('Cancelada');

    const paused = sub({ status: SubscriptionStatus.PAUSED, source: SubscriptionSource.STRIPE, currentPeriodEnd: new Date('2026-11-14T01:12:27.000Z') });
    const snapP = computeWalletAccessSnapshot(input({ subscriptions: [paused] }), NOW);
    expect(snapP.overall).toBe('INACTIVE');
    expect(buildWalletPassDisplay(snapP).details[0]!.value).toBe('En pausa');
  });

  it('an ACTIVE row with no end dates is not current (canonical rule), never a free pass', () => {
    const noEnds = sub({ currentPeriodEnd: null, entitlementEndsAt: null });
    expect(computeWalletAccessSnapshot(input({ subscriptions: [noEnds] }), NOW).overall).toBe('INACTIVE');
  });
});

describe('WalletAccessSnapshot — multiple, scheduled and future memberships', () => {
  const NOW = new Date('2026-10-13T18:00:00.000Z');
  const fullCash = sub({ id: 'sub_full', currentPeriodStart: new Date('2026-10-01T06:00:00.000Z'), currentPeriodEnd: new Date('2026-11-01T06:00:00.000Z'), createdAt: new Date('2026-10-01T06:00:00.000Z') });
  const booty = sub({
    id: 'sub_booty',
    plan: BOOTY_LAB,
    exclusiveGroupKey: null,
    source: SubscriptionSource.STRIPE,
    cancelAtPeriodEnd: false,
    currentPeriodStart: new Date('2026-10-02T16:54:40.000Z'),
    currentPeriodEnd: new Date('2026-11-16T16:54:40.000Z'),
    entitlementEndsAt: new Date('2026-11-16T16:54:40.000Z'),
    createdAt: new Date('2026-10-05T00:00:00.000Z'), // NEWER than Full Access
  });

  it('two entitled memberships: CORE is primary (canonical), both listed, nothing collapsed', () => {
    const snap = computeWalletAccessSnapshot(input({ subscriptions: [booty, fullCash] }), NOW);
    expect(snap.overall).toBe('ACCESS_VALID');
    expect(snap.headline?.subscriptionId).toBe('sub_full');
    expect(snap.memberships.map((m) => [m.subscriptionId, m.isPrimary])).toEqual([['sub_full', true], ['sub_booty', false]]);
    expect(snap.nextTransitionAt).toBe('2026-11-01T06:00:00.000Z');
    const display = buildWalletPassDisplay(snap);
    expect(display.plan).toEqual({ key: 'plan', label: 'MEMBRESÍAS', value: 'Full Access + 1 más' });
    expect(display.validity?.value).toBe('Vigente hasta el 31 oct 2026');
    expect(display.details.map((d) => d.label)).toEqual(['FULL ACCESS', 'BOOTY LAB']);
    expect(display.details[1]!.value).toBe('Vigente · Renueva el 16 nov 2026 · Clases de tu plan · 4 clases por periodo');
    expect(resolveEntitledPrimaryPlanName([booty, fullCash], NOW)).toBe('Full Access');
  });

  it('a newer ACTIVE row whose period ended does not displace the entitled one (incident inverse)', () => {
    const staleNewer = sub({ id: 'sub_stale', createdAt: new Date('2026-10-10T00:00:00.000Z'), currentPeriodEnd: new Date('2026-10-11T00:00:00.000Z') });
    const canceledEntitled = sub({ id: 'sub_ok', plan: BOOTY_LAB, exclusiveGroupKey: null, status: SubscriptionStatus.CANCELED, entitlementEndsAt: new Date('2026-11-16T16:54:40.000Z'), createdAt: new Date('2026-09-01T00:00:00.000Z') });
    expect(resolveEntitledPrimaryPlanName([staleNewer, canceledEntitled], NOW)).toBe('Booty Lab');
  });

  it('a SCHEDULED successor is listed but never current; the overall state follows what is entitled', () => {
    const stripe = sub({ id: 'sub_stripe', source: SubscriptionSource.STRIPE, cancelAtPeriodEnd: true, currentPeriodStart: new Date('2026-09-20T00:00:00.000Z'), currentPeriodEnd: new Date('2026-10-20T00:00:00.000Z') });
    const scheduled = sub({ id: 'sub_sched', status: SubscriptionStatus.SCHEDULED, currentPeriodStart: new Date('2026-10-20T00:00:00.000Z'), currentPeriodEnd: new Date('2026-11-20T00:00:00.000Z') });
    const snap = computeWalletAccessSnapshot(input({ subscriptions: [stripe, scheduled] }), NOW);
    expect(snap.overall).toBe('ACCESS_VALID');
    expect(snap.memberships.map((m) => [m.subscriptionId, m.isEntitled, m.accessState])).toEqual([
      ['sub_stripe', true, 'ENTITLED'],
      ['sub_sched', false, 'NOT_STARTED'],
    ]);
    expect(buildWalletPassDisplay(snap).details[1]!.value).toBe('Programada · Inicia el 19 oct 2026');

    const onlyScheduled = computeWalletAccessSnapshot(input({ subscriptions: [scheduled] }), NOW);
    expect(onlyScheduled.overall).toBe('SCHEDULED');
    expect(onlyScheduled.nextTransitionAt).toBe('2026-10-20T00:00:00.000Z');
    expect(buildWalletPassDisplay(onlyScheduled).status.value).toBe('PROGRAMADA');
  });

  it('an ACTIVE row that starts in the future (future-dated cash sale) is SCHEDULED until it starts', () => {
    const future = sub({ currentPeriodStart: new Date('2026-10-15T06:00:00.000Z'), currentPeriodEnd: new Date('2026-11-15T06:00:00.000Z') });
    const snap = computeWalletAccessSnapshot(input({ subscriptions: [future] }), NOW);
    expect(snap.overall).toBe('SCHEDULED');
    expect(buildWalletPassDisplay(snap).validity?.value).toBe('Inicia el 15 oct 2026');
  });
});

describe('WalletAccessSnapshot — day passes in studio-local time', () => {
  const passOn = (dateKey: string, status: DayPassStatus = DayPassStatus.ACTIVE) => ({
    id: `dp_${dateKey}`,
    status,
    // UTC instant of studio-local midnight (UTC-6, no DST): YYYY-MM-DDT06:00:00Z
    validForDate: new Date(`${dateKey}T06:00:00.000Z`),
  });

  it('an ACTIVE day pass for today is valid until studio-local midnight, classes only', () => {
    const lateEvening = new Date('2026-10-14T05:30:00.000Z'); // Oct 13, 23:30 in Mexico City
    const snap = computeWalletAccessSnapshot(input({ dayPasses: [passOn('2026-10-13')] }), lateEvening);
    expect(snap.overall).toBe('DAY_PASS_TODAY');
    expect(snap.nextTransitionAt).toBe('2026-10-14T06:00:00.000Z');
    const display = buildWalletPassDisplay(snap);
    expect(display.status.value).toBe('PASE DE DÍA');
    expect(display.validity?.value).toBe('Válido hoy, 13 oct 2026');
    expect(display.scope?.value).toBe('Clases del pase de día');
    expect(JSON.stringify(display)).not.toMatch(/Gimnasio/);

    const afterMidnight = computeWalletAccessSnapshot(input({ dayPasses: [passOn('2026-10-13')] }), new Date('2026-10-14T06:00:00.000Z'));
    expect(afterMidnight.overall).toBe('NO_MEMBERSHIP');
    expect(afterMidnight.dayPasses).toEqual([]);
  });

  it('upcoming passes are listed, not current; unpaid/expired/refunded passes are ignored', () => {
    const NOW = new Date('2026-10-13T18:00:00.000Z');
    const snap = computeWalletAccessSnapshot(
      input({ dayPasses: [passOn('2026-10-20'), passOn('2026-10-13', DayPassStatus.PENDING), passOn('2026-10-12', DayPassStatus.EXPIRED), passOn('2026-10-13', DayPassStatus.REFUNDED)] }),
      NOW,
    );
    expect(snap.overall).toBe('NO_MEMBERSHIP');
    expect(snap.dayPasses).toEqual([{ dayPassId: 'dp_2026-10-20', dateKey: '2026-10-20', relative: 'upcoming' }]);
    expect(snap.nextTransitionAt).toBe('2026-10-20T06:00:00.000Z');
  });

  it('a membership outranks a day pass; the day pass is still listed', () => {
    const NOW = new Date('2026-10-13T18:00:00.000Z');
    const full = sub({ currentPeriodStart: new Date('2026-10-01T06:00:00.000Z'), currentPeriodEnd: new Date('2026-11-01T06:00:00.000Z') });
    const snap = computeWalletAccessSnapshot(input({ subscriptions: [full], dayPasses: [passOn('2026-10-13')] }), NOW);
    expect(snap.overall).toBe('ACCESS_VALID');
    expect(buildWalletPassDisplay(snap).details.map((d) => d.label)).toEqual(['FULL ACCESS', 'PASE DE DÍA']);
  });
});

describe('WalletAccessSnapshot — credential and studio membership', () => {
  const NOW = new Date('2026-10-13T18:00:00.000Z');
  const full = sub({ currentPeriodStart: new Date('2026-10-01T06:00:00.000Z'), currentPeriodEnd: new Date('2026-11-01T06:00:00.000Z') });

  it('a revoked credential says nothing about the membership and is the only voided state', () => {
    const snap = computeWalletAccessSnapshot(input({ credential: { id: 'wc_old', revokedAt: new Date('2026-10-12T00:00:00.000Z') }, subscriptions: [full] }), NOW);
    expect(snap).toMatchObject({ overall: 'CREDENTIAL_REVOKED', credentialState: 'REVOKED', headline: null, memberships: [], dayPasses: [] });
    const display = buildWalletPassDisplay(snap);
    expect(display.voided).toBe(true);
    expect(display.status.value).toBe('REEMPLAZADO');
  });

  it('no studio membership: nothing is disclosed', () => {
    const snap = computeWalletAccessSnapshot(input({ studioMembershipActive: false, subscriptions: [full] }), NOW);
    expect(snap).toMatchObject({ overall: 'NO_MEMBERSHIP', memberships: [] });
  });

  it('no memberships at all', () => {
    const snap = computeWalletAccessSnapshot(input(), NOW);
    expect(snap.overall).toBe('NO_MEMBERSHIP');
    expect(buildWalletPassDisplay(snap)).toMatchObject({ status: { value: 'SIN MEMBRESÍA' }, plan: null, validity: null, voided: false });
  });

  it('is deterministic for the same input and clock', () => {
    const a = computeWalletAccessSnapshot(input({ subscriptions: [full] }), NOW);
    const b = computeWalletAccessSnapshot(input({ subscriptions: [full] }), NOW);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('Wallet display wording', () => {
  it('never describes a class-limited plan as gym access or unlimited', () => {
    const text = describeScopeEs({ allClasses: false, classCredits: 8, openGym: null });
    expect(text).toBe('Clases de tu plan · 8 clases por periodo');
    expect(text).not.toMatch(/gimnasio|ilimitad|acceso total|libre/i);
  });

  it('describes gym access only from the plan fields, with its window when it has one', () => {
    expect(describeScopeEs({ allClasses: true, classCredits: null, openGym: { windowStart: '05:00', windowEnd: '22:00' } })).toBe('Todas las clases · Gimnasio 05:00–22:00');
    expect(describeScopeEs({ allClasses: false, classCredits: null, openGym: { windowStart: null, windowEnd: null } })).toBe('Clases de tu plan · Gimnasio');
  });

  it('a window ending at studio-local midnight is shown as the previous day, without a time', () => {
    expect(formatInclusiveEndEs(new Date('2026-11-01T06:00:00.000Z'), TZ)).toBe('31 oct 2026');
    expect(formatInclusiveEndEs(new Date('2026-10-09T12:03:37.824Z'), TZ)).toBe('9 oct 2026, 06:03');
  });
});
