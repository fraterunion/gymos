import { apiRequest } from "@/lib/api/client";

export type AuthUser = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  platformRole: "PLATFORM_ADMIN" | null;
  createdAt: string;
  updatedAt: string;
};

export type AuthBundle = {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
};

export async function loginRequest(email: string, password: string): Promise<AuthBundle> {
  return apiRequest<AuthBundle>("/auth/login", {
    method: "POST",
    skipAuth: true,
    body: JSON.stringify({ email, password }),
  });
}

export async function meRequest(): Promise<AuthUser> {
  return apiRequest<AuthUser>("/auth/me", { method: "GET" });
}

export async function logoutRequest(refreshToken: string): Promise<void> {
  await apiRequest<void>("/auth/logout", {
    method: "POST",
    skipAuth: true,
    body: JSON.stringify({ refreshToken }),
  });
}

/** Public capability probe: lets login hide recovery when the backend has it switched off. */
export async function fetchAuthCapabilities(): Promise<{ passwordRecoveryEnabled: boolean }> {
  return apiRequest<{ passwordRecoveryEnabled: boolean }>("/auth/capabilities", {
    method: "GET",
    skipAuth: true,
  });
}

/**
 * Password recovery. `forgotPasswordRequest` always resolves with the same generic message
 * — the API never reveals whether an address has an account, so no caller may branch on it.
 */
export async function forgotPasswordRequest(
  email: string,
  studioSlug?: string,
): Promise<{ message: string }> {
  return apiRequest<{ message: string }>("/auth/forgot-password", {
    method: "POST",
    skipAuth: true,
    body: JSON.stringify({ email, ...(studioSlug ? { studioSlug } : {}) }),
  });
}

export async function resetPasswordRequest(
  token: string,
  newPassword: string,
): Promise<{ message: string }> {
  return apiRequest<{ message: string }>("/auth/reset-password", {
    method: "POST",
    skipAuth: true,
    body: JSON.stringify({ token, newPassword }),
  });
}

/** Returns a fresh session; every other device is signed out. */
export async function changePasswordRequest(
  currentPassword: string,
  newPassword: string,
): Promise<AuthBundle> {
  return apiRequest<AuthBundle>("/auth/change-password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}
