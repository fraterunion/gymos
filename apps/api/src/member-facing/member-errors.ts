/** Canonical Spanish copy for expected MEMBER booking/waitlist rejections. */
export const MEMBER_ERRORS = {
  overlap:
    'Ya tienes una clase reservada a esta hora. Cancélala antes de reservar otra.',
  waitlistOverlap:
    'Ya tienes una clase reservada a esta hora. Cancélala antes de unirte a esta lista de espera.',
  alreadyBooked: 'Ya estás reservado en esta clase.',
  classNotOpen: 'Esta clase no está abierta para reservar.',
  classAlreadyStarted: 'No puedes reservar una clase que ya comenzó.',
  classFull: 'La clase está llena.',
  membershipExpired: 'Tu membresía no está vigente.',
  creditsExhausted: 'Ya usaste todos los créditos de tu membresía.',
  planRestricted: 'Tu membresía no incluye esta clase.',
  timeWindowDenied: 'Esta clase no está disponible en este horario.',
  membershipOrDayPassRequired:
    'Necesitas una membresía o pase de día activo para reservar esta clase.',
  waitlistNotOpen: 'Esta clase no está abierta para lista de espera.',
  waitlistAlreadyStarted: 'No puedes unirte a la lista de espera de una clase que ya comenzó.',
  waitlistDisabled: 'La lista de espera no está disponible en este estudio.',
  waitlistBookDirectly: 'Hay lugares disponibles. Reserva la clase directamente.',
  alreadyOnWaitlist: 'Ya estás en la lista de espera de esta clase.',
} as const;

export type MemberErrorKey = keyof typeof MEMBER_ERRORS;
