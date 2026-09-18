import { apiRequest } from '@/lib/api/client';
import type { AuthBundle, AuthUser } from '@/lib/types';

export async function loginRequest(email: string, password: string): Promise<AuthBundle> {
  return apiRequest<AuthBundle>('/auth/login', {
    method: 'POST',
    skipAuth: true,
    body: JSON.stringify({ email, password }),
  });
}

export type RegisterBody = {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  studioSlug?: string;
  waiverAccepted?: boolean;
  waiverDocumentId?: string;
};

export async function registerRequest(body: RegisterBody): Promise<AuthBundle> {
  return apiRequest<AuthBundle>('/auth/register', {
    method: 'POST',
    skipAuth: true,
    body: JSON.stringify(body),
  });
}

export async function meRequest(): Promise<AuthUser> {
  return apiRequest<AuthUser>('/auth/me', { method: 'GET' });
}

export async function logoutRequest(refreshToken: string): Promise<void> {
  await apiRequest<void>('/auth/logout', {
    method: 'POST',
    skipAuth: true,
    body: JSON.stringify({ refreshToken }),
  });
}

/** Public capability probe: lets login hide recovery when the backend has it switched off. */
export async function fetchAuthCapabilities(): Promise<{ passwordRecoveryEnabled: boolean }> {
  return apiRequest<{ passwordRecoveryEnabled: boolean }>('/auth/capabilities', {
    method: 'GET',
    skipAuth: true,
  });
}

/**
 * Password recovery. `forgotPassword` always resolves with the same generic message —
 * the server never reveals whether the address belongs to an account, so the UI must not
 * branch on it either.
 */
export async function forgotPasswordRequest(
  email: string,
  studioSlug?: string,
): Promise<{ message: string }> {
  return apiRequest<{ message: string }>('/auth/forgot-password', {
    method: 'POST',
    skipAuth: true,
    body: JSON.stringify({ email, ...(studioSlug ? { studioSlug } : {}) }),
  });
}

export async function resetPasswordRequest(
  token: string,
  newPassword: string,
): Promise<{ message: string }> {
  return apiRequest<{ message: string }>('/auth/reset-password', {
    method: 'POST',
    skipAuth: true,
    body: JSON.stringify({ token, newPassword }),
  });
}

/** Returns a fresh session: the caller must persist the new tokens. */
export async function changePasswordRequest(
  currentPassword: string,
  newPassword: string,
): Promise<AuthBundle> {
  return apiRequest<AuthBundle>('/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}
