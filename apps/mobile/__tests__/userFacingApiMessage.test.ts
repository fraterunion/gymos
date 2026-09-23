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

  it('never shows the legacy English Day Pass 409 and never calls an abandoned attempt a purchase', () => {
    // The pre-fix API raised this 409 for abandoned PaymentSheet attempts, so the copy must
    // invite a retry, not claim the member already owns a pass.
    const legacy = userFacingApiMessage(new ApiError('A Day Pass already exists for this date', 409));
    expect(legacy).toBe(
      'No pudimos iniciar el pago de tu pase diario. Espera unos segundos e inténtalo de nuevo.',
    );
    expect(legacy).not.toMatch(/already exists/i);
    expect(legacy).not.toMatch(/ya tienes/i);
  });

  it('maps the current Spanish Day Pass lifecycle messages verbatim', () => {
    expect(
      userFacingApiMessage(new ApiError('Ya tienes un pase diario activo para esta fecha.', 409)),
    ).toBe('Ya tienes un pase diario activo para esta fecha.');
    expect(
      userFacingApiMessage(
        new ApiError(
          'Tu pago está en proceso. En cuanto se confirme verás tu pase aquí; no vuelvas a pagar.',
          409,
        ),
      ),
    ).toBe('Tu pago está en proceso. En cuanto se confirme verás tu pase aquí; no vuelvas a pagar.');
    expect(
      userFacingApiMessage(
        new ApiError(
          'Ya hay un intento de compra en curso para esta fecha. Espera unos segundos e inténtalo de nuevo.',
          409,
        ),
      ),
    ).toBe(
      'Ya hay un intento de compra en curso para esta fecha. Espera unos segundos e inténtalo de nuevo.',
    );
    expect(
      userFacingApiMessage(
        new ApiError('validForDate must be today or a future date in the studio timezone', 400),
      ),
    ).toBe('Solo puedes comprar un pase diario para hoy o una fecha próxima.');
    expect(userFacingApiMessage(new ApiError('Day Pass no está disponible en este momento.', 400))).toBe(
      'El pase diario no está disponible en este momento.',
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
