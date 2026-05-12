import { ApiError } from '@/lib/api/errors';

/** Maps API / config errors to copy safe for members (no env var names, shorter technical noise). */
export function userFacingApiMessage(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (!(error instanceof ApiError)) {
    return fallback;
  }
  const m = error.message;
  if (/EXPO_PUBLIC_API_URL|not configured/i.test(m)) {
    return 'This app is not connected to a server yet. Ask your studio for an updated build.';
  }
  if (/active subscription required/i.test(m)) {
    return 'A current membership is required before you can do that.';
  }
  if (error.status >= 500) {
    return 'The studio service is temporarily unavailable. Please try again in a moment.';
  }
  if (error.status === 401) {
    if (/session/i.test(m)) return 'Your session expired. Please sign in again.';
    return 'We could not verify your account. Please sign in again.';
  }
  if (m.length > 180 || /\[object /i.test(m)) {
    return fallback;
  }
  return m;
}
