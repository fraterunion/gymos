import { statusConfig } from './membershipStatus';

describe('membership status display', () => {
  const end = '2026-08-19T12:00:00.000Z';

  it('shows Termina pronto only before the effective end', () => {
    expect(statusConfig('ACTIVE', true, end, new Date('2026-08-19T11:59:59.999Z')).label).toBe(
      'Termina pronto',
    );
  });

  it('shows Vencida at and after the effective end despite stale ACTIVE status', () => {
    expect(statusConfig('ACTIVE', true, end, new Date(end)).label).toBe('Vencida');
    expect(statusConfig('ACTIVE', false, end, new Date('2026-08-20T00:00:00.000Z')).label).toBe(
      'Vencida',
    );
  });
});
