import { ApiError } from '@/lib/api/errors';

/** Maps API / config errors to copy safe for members (no env var names, shorter technical noise). */
export function userFacingApiMessage(error: unknown, fallback = 'Algo salió mal. Por favor, inténtalo de nuevo.'): string {
  if (!(error instanceof ApiError)) {
    return fallback;
  }
  const m = error.message;
  if (/EXPO_PUBLIC_API_URL|not configured/i.test(m)) {
    return 'Esta app aún no está conectada a un servidor. Pídele a tu estudio una versión actualizada.';
  }
  if (/active subscription required/i.test(m)) {
    return 'Necesitas una membresía activa para hacer eso.';
  }
  if (error.status >= 500) {
    return 'El servicio del estudio no está disponible por el momento. Inténtalo de nuevo en un momento.';
  }
  if (error.status === 401) {
    if (/session/i.test(m)) return 'Tu sesión expiró. Inicia sesión de nuevo.';
    return 'No pudimos verificar tu cuenta. Inicia sesión de nuevo.';
  }
  if (m.length > 180 || /\[object /i.test(m)) {
    return fallback;
  }
  return m;
}
