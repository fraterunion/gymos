import { resolveCampaignSender } from './campaign-sender';

describe('resolveCampaignSender', () => {
  const PLATFORM = 'no-reply@arestrainingclub.com';
  const ares = {
    fromName: 'ARES Training Club',
    fromAddress: 'fernando@arestrainingclub.com',
    replyTo: 'fernando@arestrainingclub.com',
  };
  const config = (entries: Record<string, unknown>) => JSON.stringify(entries);

  it('returns the configured ARES campaign sender', () => {
    expect(resolveCampaignSender('ares-fitness', config({ 'ares-fitness': ares }), PLATFORM)).toEqual({
      kind: 'CONFIGURED',
      from: { email: 'fernando@arestrainingclub.com', name: 'ARES Training Club' },
      replyTo: 'fernando@arestrainingclub.com',
    });
  });

  it('defaults Reply-To to the from address', () => {
    const sender = resolveCampaignSender('ares-fitness', config({ 'ares-fitness': { ...ares, replyTo: undefined } }), PLATFORM);
    expect(sender).toMatchObject({ kind: 'CONFIGURED', replyTo: 'fernando@arestrainingclub.com' });
  });

  it('keeps the platform default when unset or when the studio is not listed', () => {
    expect(resolveCampaignSender('ares-fitness', undefined, PLATFORM)).toEqual({ kind: 'PLATFORM_DEFAULT' });
    expect(resolveCampaignSender('ares-fitness', '  ', PLATFORM)).toEqual({ kind: 'PLATFORM_DEFAULT' });
    expect(resolveCampaignSender('pilates-toluca', config({ 'ares-fitness': ares }), PLATFORM)).toEqual({ kind: 'PLATFORM_DEFAULT' });
  });

  it('fails closed on malformed configuration', () => {
    expect(resolveCampaignSender('ares-fitness', '{not json', PLATFORM).kind).toBe('INVALID');
    expect(resolveCampaignSender('ares-fitness', '[]', PLATFORM).kind).toBe('INVALID');
    expect(resolveCampaignSender('ares-fitness', config({ 'ares-fitness': 'fernando' }), PLATFORM).kind).toBe('INVALID');
    expect(resolveCampaignSender('ares-fitness', config({ 'ares-fitness': { ...ares, fromAddress: 'not-an-email' } }), PLATFORM).kind).toBe('INVALID');
    expect(resolveCampaignSender('ares-fitness', config({ 'ares-fitness': { ...ares, replyTo: 'nope' } }), PLATFORM).kind).toBe('INVALID');
  });

  it('refuses display names that could inject header content', () => {
    for (const fromName of ['', 'ARES <x@evil.test>', 'ARES\r\nBcc: x@evil.test', 'ARES "Club"', 'x'.repeat(101)]) {
      expect(resolveCampaignSender('ares-fitness', config({ 'ares-fitness': { ...ares, fromName } }), PLATFORM).kind).toBe('INVALID');
    }
  });

  it('only allows the verified platform sending domain for the From address', () => {
    const other = resolveCampaignSender('ares-fitness', config({ 'ares-fitness': { ...ares, fromAddress: 'fernando@gmail.com' } }), PLATFORM);
    expect(other).toEqual({ kind: 'INVALID', error: expect.stringContaining('arestrainingclub.com') });
    const sub = resolveCampaignSender('ares-fitness', config({ 'ares-fitness': { ...ares, fromAddress: 'fernando@mail.arestrainingclub.com' } }), PLATFORM);
    expect(sub.kind).toBe('INVALID');
    expect(resolveCampaignSender('ares-fitness', config({ 'ares-fitness': ares }), 'not-configured').kind).toBe('INVALID');
    // Reply-To may be any valid mailbox (replies only).
    expect(resolveCampaignSender('ares-fitness', config({ 'ares-fitness': { ...ares, replyTo: 'fernando.ares@gmail.com' } }), PLATFORM).kind).toBe('CONFIGURED');
  });
});
