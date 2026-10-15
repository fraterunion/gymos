import { nextLastModifiedAt } from './wallet-dynamic-pass.service';

describe('nextLastModifiedAt (HTTP Last-Modified has one-second precision)', () => {
  it('uses the write time when the previous version is in an earlier second', () => {
    const previous = new Date('2026-10-15T04:07:40.900Z');
    expect(nextLastModifiedAt(previous, Date.parse('2026-10-15T04:07:48.100Z')).toISOString()).toBe('2026-10-15T04:07:48.100Z');
    expect(nextLastModifiedAt(null, Date.parse('2026-10-15T04:07:48.100Z')).toISOString()).toBe('2026-10-15T04:07:48.100Z');
  });

  it('moves a version written within the same second into the next whole second', () => {
    const previous = new Date('2026-10-15T04:07:48.100Z');
    expect(nextLastModifiedAt(previous, Date.parse('2026-10-15T04:07:48.700Z')).toISOString()).toBe('2026-10-15T04:07:49.000Z');
  });

  it('stays monotonic even when the clock is behind the stored value', () => {
    const previous = new Date('2026-10-15T04:07:50.000Z');
    expect(nextLastModifiedAt(previous, Date.parse('2026-10-15T04:07:45.000Z')).toISOString()).toBe('2026-10-15T04:07:51.000Z');
  });
});
