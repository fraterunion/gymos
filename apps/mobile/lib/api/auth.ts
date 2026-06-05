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
