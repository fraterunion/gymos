import { WalletPassEventType as T } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  analyzeRegistrationHistory,
  deviceHashOf,
  devicesNotListedSince,
  NO_ACTIVE_UPDATE_REGISTRATION,
  type PassEventRow,
  WalletPassEventsService,
} from './wallet-pass-events.service';
import { isPassNotModified } from './passkit.service';

const t0 = new Date('2026-10-14T18:40:00.000Z');
const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);
const A = deviceHashOf('device-a');
const B = deviceHashOf('device-b');

function ev(type: T, seconds: number, device: string | null, passVersion: number | null = null, httpStatus: number | null = null): PassEventRow {
  return { type, occurredAt: at(seconds), deviceHash: device, passVersion, httpStatus };
}

describe('deviceHashOf', () => {
  it('is a stable 16-hex digest, never the identifier itself', () => {
    expect(deviceHashOf('device-a')).toMatch(/^[0-9a-f]{16}$/);
    expect(deviceHashOf('device-a')).toBe(A);
    expect(deviceHashOf('device-b')).not.toBe(A);
    expect(A).not.toContain('device');
  });
});

describe('analyzeRegistrationHistory', () => {
  it('a healthy pass: registered, pushed, current version downloaded', () => {
    const r = analyzeRegistrationHistory(
      [ev(T.REGISTERED, 0, A, 1, 201), ev(T.PASS_RETRIEVED, 60, A, 1, 200), ev(T.APNS_ACCEPTED, 600, A, 2, 200), ev(T.PASS_RETRIEVED, 602, A, 2, 200)],
      [A],
      { passVersion: 2, lastModifiedAt: at(590) },
    );
    expect(r).toMatchObject({
      lastRegisteredAt: at(0),
      lastUnregisteredAt: null,
      lastApnsAcceptedAt: at(600),
      lastPassRetrievedAt: at(602),
      lastPassRetrievedVersion: 2,
      currentVersionRetrieved: true,
      churnSuspectedDevices: [],
      findings: [],
    });
  });

  it('Stage 2 replacement pattern: register then unregister within minutes, nothing active — churn, never "uninstalled"', () => {
    const r = analyzeRegistrationHistory(
      [ev(T.PASS_RETRIEVED, 0, null, 1, 200), ev(T.REGISTERED, 5, A, 1, 201), ev(T.UNREGISTERED, 45, A), ev(T.REGISTERED, 50, A, 1, 201), ev(T.UNREGISTERED, 87, A)],
      [],
      { passVersion: 1, lastModifiedAt: at(-10) },
    );
    expect(r.churnSuspectedDevices).toEqual([A]);
    expect(r.findings).toHaveLength(2);
    expect(r.findings[0]).toMatch(/^NO_ACTIVE_UPDATE_REGISTRATION: no active update registration/);
    expect(r.findings[0]).toMatch(/does not mean the pass was removed/);
    expect(r.findings[1]).toMatch(/^REGISTRATION_CHURN/);
    expect(r.findings[1]).toMatch(/do not recreate registrations server-side/);
    expect(r.findings.join(' ')).not.toMatch(/uninstalled|deleted by the member/i);
  });

  it('recovery: a device that churned and later re-registered is no longer flagged', () => {
    const r = analyzeRegistrationHistory(
      [ev(T.REGISTERED, 0, A), ev(T.UNREGISTERED, 40, A), ev(T.REGISTERED, 33_000, A, 1, 201)],
      [A],
      { passVersion: 1, lastModifiedAt: null },
    );
    expect(r.churnSuspectedDevices).toEqual([]);
    expect(r.findings).toEqual(['CURRENT_VERSION_NOT_YET_RETRIEVED: registered devices have not downloaded the latest pass version.']);
  });

  it('an unregistration long after registering is not churn', () => {
    const r = analyzeRegistrationHistory([ev(T.REGISTERED, 0, B), ev(T.UNREGISTERED, 3 * 24 * 3600, B)], [], { passVersion: 1, lastModifiedAt: null });
    expect(r.churnSuspectedDevices).toEqual([]);
    expect(r.findings.map((f) => f.split(':')[0])).toEqual([NO_ACTIVE_UPDATE_REGISTRATION]);
  });

  it('a 304 is not a retrieval, and a retrieval of an older version does not count', () => {
    const r = analyzeRegistrationHistory(
      [ev(T.PASS_RETRIEVED, 0, null, 1, 200), ev(T.APNS_ACCEPTED, 100, A, 2, 200), ev(T.PASS_NOT_MODIFIED, 101, null, 2, 304)],
      [A],
      { passVersion: 2, lastModifiedAt: at(90) },
    );
    expect(r.currentVersionRetrieved).toBe(false);
    expect(r.lastPassRetrievedVersion).toBe(1);
    expect(r.lastNotModifiedAt).toEqual(at(101));
    expect(r.findings.map((f) => f.split(':')[0])).toEqual(['CURRENT_VERSION_NOT_YET_RETRIEVED']);
  });

  it('APNs failures are surfaced separately from acceptances', () => {
    const r = analyzeRegistrationHistory([ev(T.APNS_FAILED, 10, A, 1, 503), ev(T.APNS_INVALID_TOKEN, 20, B, 1, 410)], [A], { passVersion: 1, lastModifiedAt: null });
    expect(r.lastApnsAcceptedAt).toBeNull();
    expect(r.lastApnsFailureAt).toEqual(at(20));
  });
});

describe('devicesNotListedSince (APNs acceptance is not proof of display)', () => {
  const pushAt = at(600);
  it('a device counts as having acted on a push only if it listed changed passes at or after the push', () => {
    const events = [
      ev(T.SERIALS_LISTED, 300, A, 1, 200), // before the push: does not count
      ev(T.APNS_ACCEPTED, 600, A, 2, 200),
      ev(T.APNS_ACCEPTED, 600, B, 2, 200),
      ev(T.SERIALS_LISTED, 601, A, 2, 200),
      ev(T.PASS_RETRIEVED, 602, null, 2, 200), // device-less: never attributed
    ];
    expect(devicesNotListedSince(events, [A, B], pushAt)).toEqual([B]);
    expect(devicesNotListedSince(events, [A], pushAt)).toEqual([]);
    expect(devicesNotListedSince([], [A, B], pushAt)).toEqual([A, B]);
  });

  it('records when a device last listed the pass', () => {
    const r = analyzeRegistrationHistory([ev(T.REGISTERED, 0, A), ev(T.SERIALS_LISTED, 700, A, 2, 200)], [A], { passVersion: 2, lastModifiedAt: at(650) });
    expect(r.lastSerialsListedAt).toEqual(at(700));
  });
});

describe('WalletPassEventsService.record', () => {
  function serviceWith(create: jest.Mock) {
    return new WalletPassEventsService({ walletPassEvent: { create } } as unknown as PrismaService);
  }

  it('stores only a device hash and allow-listed, bounded detail', async () => {
    const create = jest.fn().mockResolvedValue({});
    await serviceWith(create).record({
      studioId: 's1',
      walletPassArtifactId: 'a1',
      walletCredentialId: 'c1',
      type: T.REGISTERED,
      deviceLibraryIdentifier: 'raw-device-library-identifier',
      passVersion: 3,
      httpStatus: 201,
      detail: { outcome: 'created', pushToken: 'ab'.repeat(32), authenticationToken: 'secret', reason: 'r'.repeat(500), nested: { x: 1 } },
    });
    const data = create.mock.calls[0][0].data;
    expect(data.deviceHash).toBe(deviceHashOf('raw-device-library-identifier'));
    expect(data.detail).toEqual({ outcome: 'created', reason: 'r'.repeat(64) });
    expect(JSON.stringify(data)).not.toContain('raw-device-library-identifier');
    expect(JSON.stringify(data)).not.toContain('ab'.repeat(32));
    expect(JSON.stringify(data)).not.toContain('secret');
  });

  it('is best-effort: a failed insert never throws into the device request', async () => {
    const create = jest.fn().mockRejectedValue(new Error('db down'));
    await expect(
      serviceWith(create).record({ studioId: 's1', walletPassArtifactId: 'a1', walletCredentialId: 'c1', type: T.PASS_RETRIEVED }),
    ).resolves.toBeUndefined();
  });
});

describe('isPassNotModified (second precision, like the HTTP date it compares)', () => {
  const lastModified = new Date('2026-10-15T04:07:48.731Z');

  it('304 only when If-Modified-Since is at or after the content second', () => {
    expect(isPassNotModified(lastModified, lastModified.toUTCString())).toBe(true);
    expect(isPassNotModified(lastModified, 'Thu, 15 Oct 2026 04:07:49 GMT')).toBe(true);
    expect(isPassNotModified(lastModified, 'Thu, 15 Oct 2026 04:07:47 GMT')).toBe(false);
  });

  it('a missing, malformed, repeated or oversized header always gets the full pass', () => {
    expect(isPassNotModified(lastModified, undefined)).toBe(false);
    expect(isPassNotModified(lastModified, 'yesterday-ish')).toBe(false);
    expect(isPassNotModified(lastModified, [lastModified.toUTCString()])).toBe(false);
    expect(isPassNotModified(lastModified, `${lastModified.toUTCString()}${' '.repeat(80)}`)).toBe(false);
  });
});
