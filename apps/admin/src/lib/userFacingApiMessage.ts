import { ApiError } from "@/lib/api/errors";

/** Maps API / config errors to staff-friendly copy (no env var names in UI). */
export function userFacingApiMessage(error: unknown, fallback = "Something went wrong. Please try again."): string {
  if (!(error instanceof ApiError)) {
    return fallback;
  }
  const m = error.message;
  if (/NEXT_PUBLIC_API_URL|not configured/i.test(m)) {
    return "This desk app is not connected to your studio server yet. Ask your technical contact to finish setup.";
  }
  if (error.status >= 500) {
    return "The studio server is having trouble. Please try again in a moment.";
  }
  if (error.status === 401) {
    if (/session/i.test(m)) return "Your session expired. Please sign in again.";
    return "We could not verify your account. Please sign in again.";
  }
  if (m.length > 180 || /\[object /i.test(m)) {
    return fallback;
  }
  return m;
}
