import { readUnsubscribeToken, signUnsubscribeToken } from './unsubscribe-token';

describe('unsubscribe tokens', () => {
  it('round-trips and rejects a tampered token', () => {
    const token = signUnsubscribeToken({ studioId: 'studio-1', email: 'Member@Ares.test' }, 'secret');
    expect(readUnsubscribeToken(token, 'secret')).toEqual({ studioId: 'studio-1', email: 'member@ares.test' });
    expect(readUnsubscribeToken(token, 'other')).toBeNull();
    expect(readUnsubscribeToken(`${token}x`, 'secret')).toBeNull();
  });
});
