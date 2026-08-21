import { MEMBER_ERRORS } from './member-errors';

describe('MEMBER_ERRORS', () => {
  it('exposes Spanish copy for every expected member booking condition', () => {
    const values = Object.values(MEMBER_ERRORS);
    expect(values.length).toBeGreaterThanOrEqual(12);
    for (const message of values) {
      expect(message).toMatch(/[áéíóúñÁÉÍÓÚÑ¿¡]|Ya |Tu |Esta |La |Hay |No |Necesitas /);
      expect(message).not.toMatch(/Prisma|P2002|ConflictException|Internal server/i);
      expect(message.length).toBeLessThan(180);
    }
  });
});
