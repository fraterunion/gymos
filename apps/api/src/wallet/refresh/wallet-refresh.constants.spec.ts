import {
  certificateExpiryLevel,
  isRefreshFailureSpike,
  WALLET_REFRESH_BACKOFF_CAP_MS,
  WALLET_REFRESH_RECONCILE_INITIAL_DELAY_MAX_MS,
  WALLET_REFRESH_RECONCILE_INITIAL_DELAY_MIN_MS,
  walletRefreshBackoffMs,
  walletRefreshBackoffWithJitterMs,
  walletRefreshInitialReconcileDelayMs,
} from './wallet-refresh.constants';
import { sanitizeRefreshError } from './wallet-refresh-queue.service';

const DAY = 24 * 60 * 60_000;

describe('refresh retry backoff', () => {
  it('doubles from 30 s and caps at 30 min', () => {
    expect([1, 2, 3, 4, 5, 6].map(walletRefreshBackoffMs)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 960_000]);
    expect(walletRefreshBackoffMs(7)).toBe(WALLET_REFRESH_BACKOFF_CAP_MS);
    expect(walletRefreshBackoffMs(50)).toBe(WALLET_REFRESH_BACKOFF_CAP_MS);
    expect(walletRefreshBackoffMs(0)).toBe(30_000);
  });

  it('jitter stays within ±20 % of the deterministic delay', () => {
    expect(walletRefreshBackoffWithJitterMs(3, () => 0)).toBe(96_000);
    expect(walletRefreshBackoffWithJitterMs(3, () => 0.5)).toBe(120_000);
    expect(walletRefreshBackoffWithJitterMs(3, () => 0.999999)).toBeLessThanOrEqual(144_000);
    for (let i = 0; i < 200; i += 1) {
      const d = walletRefreshBackoffWithJitterMs(2);
      expect(d).toBeGreaterThanOrEqual(48_000);
      expect(d).toBeLessThanOrEqual(72_000);
    }
  });
});

describe('certificateExpiryLevel', () => {
  const now = new Date('2026-10-15T12:00:00.000Z');
  const at = (days: number) => new Date(now.getTime() + days * DAY);

  it('grades the remaining validity', () => {
    expect(certificateExpiryLevel(at(400), now)).toEqual({ daysLeft: 400, level: 'OK' });
    expect(certificateExpiryLevel(at(30), now)).toEqual({ daysLeft: 30, level: 'OK' });
    expect(certificateExpiryLevel(at(29.5), now)).toEqual({ daysLeft: 29, level: 'WARN' });
    expect(certificateExpiryLevel(at(7), now)).toEqual({ daysLeft: 7, level: 'WARN' });
    expect(certificateExpiryLevel(at(6.9), now)).toEqual({ daysLeft: 6, level: 'CRITICAL' });
    expect(certificateExpiryLevel(at(0.01), now)).toEqual({ daysLeft: 0, level: 'CRITICAL' });
    expect(certificateExpiryLevel(now, now).level).toBe('EXPIRED');
    expect(certificateExpiryLevel(at(-3), now)).toEqual({ daysLeft: -3, level: 'EXPIRED' });
  });
});

describe('refresh-failure spike rule', () => {
  it('needs an absolute floor and a multiple of the previous day’s hourly average', () => {
    expect(isRefreshFailureSpike(4, 0)).toBe(false); // below the floor
    expect(isRefreshFailureSpike(5, 0)).toBe(true);
    expect(isRefreshFailureSpike(5, 48)).toBe(false); // baseline 2/h → needs >= 6
    expect(isRefreshFailureSpike(6, 48)).toBe(true);
    expect(isRefreshFailureSpike(30, 240)).toBe(true); // baseline 10/h → needs >= 30
    expect(isRefreshFailureSpike(29, 240)).toBe(false);
  });
});

describe('first reconciliation delay after a worker starts', () => {
  it('is always inside the 5–15 minute window', () => {
    expect(walletRefreshInitialReconcileDelayMs(() => 0)).toBe(WALLET_REFRESH_RECONCILE_INITIAL_DELAY_MIN_MS);
    expect(walletRefreshInitialReconcileDelayMs(() => 1)).toBe(WALLET_REFRESH_RECONCILE_INITIAL_DELAY_MAX_MS);
    for (let i = 0; i < 100; i += 1) {
      const d = walletRefreshInitialReconcileDelayMs();
      expect(d).toBeGreaterThanOrEqual(5 * 60_000);
      expect(d).toBeLessThanOrEqual(15 * 60_000);
    }
  });
});

describe('sanitizeRefreshError', () => {
  it('keeps the error class and message but redacts token-like runs and bounds the length', () => {
    const token = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    expect(sanitizeRefreshError(new Error(`bad token ${token} for pass`))).toBe('Error: bad token [redacted] for pass');
    expect(sanitizeRefreshError(new TypeError('x'))).toBe('TypeError: x');
    expect(sanitizeRefreshError('plain')).toBe('plain');
    expect(sanitizeRefreshError(new Error('y '.repeat(500))).length).toBe(300);
    expect(sanitizeRefreshError(new Error(`push ${'ab'.repeat(32)}`))).not.toContain('ab'.repeat(32));
  });
});
