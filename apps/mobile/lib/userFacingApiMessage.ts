import { ApiError } from '@/lib/api/errors';

const GENERIC = 'Algo salió mal. Por favor, inténtalo de nuevo.';

/** Maps API / config errors to copy safe for members (no env var names, shorter technical noise). */
export function userFacingApiMessage(error: unknown, fallback = GENERIC): string {
  if (!(error instanceof ApiError)) {
    return fallback;
  }
  const m = error.message;
  if (/EXPO_PUBLIC_API_URL|not configured/i.test(m)) {
    return 'Esta app aún no está conectada a un servidor. Pídele a tu estudio una versión actualizada.';
  }
  if (error.status >= 500) {
    return 'El servicio del estudio no está disponible por el momento. Inténtalo de nuevo en un momento.';
  }
  if (/Prisma|P2002|unique constraint|studio_id|Internal server error|\[object /i.test(m)) {
    return fallback;
  }
  if (error.status === 401) {
    if (/session/i.test(m)) return 'Tu sesión expiró. Inicia sesión de nuevo.';
    return 'No pudimos verificar tu cuenta. Inicia sesión de nuevo.';
  }

  if (/MEMBERSHIP_EXPIRED|membresía no está vigente|membership expired/i.test(m)) {
    return 'Tu membresía no está vigente.';
  }
  if (/active membership or day pass|membresía o pase de día|active membership required to book|active subscription required/i.test(m)) {
    return 'Necesitas una membresía o pase de día activo para reservar esta clase.';
  }
  if (/does not include access|no incluye esta clase/i.test(m)) {
    return 'Tu membresía no incluye esta clase.';
  }
  if (/credits exhausted|usaste todos los créditos/i.test(m)) {
    return 'Ya usaste todos los créditos de tu membresía.';
  }
  if (/already have a class booked|ya tienes una clase reservada/i.test(m)) {
    return 'Ya tienes una clase reservada a esta hora. Cancélala antes de reservar otra.';
  }
  if (/lista de espera de una clase que ya comenzó|waitlist for a class that has already started/i.test(m)) {
    return 'No puedes unirte a la lista de espera de una clase que ya comenzó.';
  }
  if (/not open for the waitlist|no está abierta para lista de espera/i.test(m)) {
    return 'Esta clase no está abierta para lista de espera.';
  }
  if (/already booked for this class|ya estás reservado/i.test(m)) {
    return 'Ya estás reservado en esta clase.';
  }
  if (/class is full|la clase está llena/i.test(m)) {
    return 'La clase está llena.';
  }
  if (/not open for booking|no está abierta para reservar/i.test(m)) {
    return 'Esta clase no está abierta para reservar.';
  }
  if (/already started|ya comenzó/i.test(m)) {
    return 'No puedes reservar una clase que ya comenzó.';
  }
  if (/not available during this time|no está disponible en este horario/i.test(m)) {
    return 'Esta clase no está disponible en este horario.';
  }
  if (/waitlist is not available|lista de espera no está disponible/i.test(m)) {
    return 'La lista de espera no está disponible en este estudio.';
  }
  if (/available spots|hay lugares disponibles/i.test(m)) {
    return 'Hay lugares disponibles. Reserva la clase directamente.';
  }
  if (/already on the waitlist|ya estás en la lista de espera/i.test(m)) {
    return 'Ya estás en la lista de espera de esta clase.';
  }

  // Day Pass purchase lifecycle. The legacy API 409 ("A Day Pass already exists for this
  // date") was raised for abandoned payment attempts too, so it is mapped to a retry-friendly
  // message rather than an ownership claim; the current API sends Spanish copy directly.
  if (/pase diario activo para esta fecha/i.test(m)) {
    return 'Ya tienes un pase diario activo para esta fecha.';
  }
  if (/pago está en proceso/i.test(m)) {
    return 'Tu pago está en proceso. En cuanto se confirme verás tu pase aquí; no vuelvas a pagar.';
  }
  if (/intento de compra en curso/i.test(m)) {
    return 'Ya hay un intento de compra en curso para esta fecha. Espera unos segundos e inténtalo de nuevo.';
  }
  if (/A Day Pass already exists for this date/i.test(m)) {
    return 'No pudimos iniciar el pago de tu pase diario. Espera unos segundos e inténtalo de nuevo.';
  }
  if (/validForDate must be today or a future date|hoy o una fecha pr/i.test(m)) {
    return 'Solo puedes comprar un pase diario para hoy o una fecha próxima.';
  }
  if (/No pudimos confirmar el estado de tu pase diario/i.test(m)) {
    return 'No pudimos confirmar el estado de tu pase diario para esta fecha. Contacta a tu estudio.';
  }
  if (/Day Pass no está disponible/i.test(m)) {
    return 'El pase diario no está disponible en este momento.';
  }

  if (m.length > 180) {
    return fallback;
  }
  return m;
}
