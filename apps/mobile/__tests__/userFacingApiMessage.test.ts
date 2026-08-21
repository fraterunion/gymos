import { ApiError } from '@/lib/api/errors';
import { userFacingApiMessage } from '@/lib/userFacingApiMessage';

describe('userFacingApiMessage', () => {
  it('maps expected booking errors to concise Spanish', () => {
    expect(userFacingApiMessage(new ApiError('Already booked for this class', 409))).toBe(
      'Ya estás reservado en esta clase.',
    );
    expect(userFacingApiMessage(new ApiError('Ya estás reservado en esta clase.', 409))).toBe(
      'Ya estás reservado en esta clase.',
    );
    expect(userFacingApiMessage(new ApiError('Class is full', 409))).toBe('La clase está llena.');
    expect(userFacingApiMessage(new ApiError('MEMBERSHIP_EXPIRED', 403))).toBe(
      'Tu membresía no está vigente.',
    );
    expect(
      userFacingApiMessage(new ApiError('This membership does not include access to this class.', 403)),
    ).toBe('Tu membresía no incluye esta clase.');
  });

  it('does not expose Prisma or Nest internals', () => {
    expect(
      userFacingApiMessage(new ApiError('Unique constraint failed on the fields: (`studio_id`)', 409)),
    ).toBe('Algo salió mal. Por favor, inténtalo de nuevo.');
    expect(userFacingApiMessage(new ApiError('Internal server error', 500))).toBe(
      'El servicio del estudio no está disponible por el momento. Inténtalo de nuevo en un momento.',
    );
    expect(userFacingApiMessage(new ApiError('P2002', 409))).toBe(
      'Algo salió mal. Por favor, inténtalo de nuevo.',
    );
  });

  it('keeps unexpected 500s generic while remaining observable as status 500', () => {
    const error = new ApiError('TypeError: Cannot read properties of undefined', 500);
    expect(error.status).toBe(500);
    expect(userFacingApiMessage(error)).toBe(
      'El servicio del estudio no está disponible por el momento. Inténtalo de nuevo en un momento.',
    );
  });
});
