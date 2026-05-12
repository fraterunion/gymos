import { apiRequest } from "@/lib/api/client";

export type AuthUser = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
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
