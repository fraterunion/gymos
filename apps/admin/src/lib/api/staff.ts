import { apiRequest } from "@/lib/api/client";

// ── Types ────────────────────────────────────────────────────────────────────

export type StaffType = "COACH" | "FRONT_DESK" | "MANAGER" | "OPERATIONS" | "OTHER";
export type StaffRole = "OWNER" | "ADMIN" | "STAFF" | "INSTRUCTOR" | "FRONT_DESK";

export type StaffProfile = {
  id: string;
  staffType: StaffType;
  phone: string | null;
  bio: string | null;
  specialties: string[];
  photoUrl: string | null;
  isActive: boolean;
};

export type StaffMember = {
  membershipId: string;
  userId: string;
  role: StaffRole;
  joinedAt: string;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    phone: string | null;
    createdAt: string;
  };
  staffProfile: StaffProfile | null;
  assignedClassesCount: number;
};

export type StaffListResponse = {
  data: StaffMember[];
  total: number;
  page: number;
  limit: number;
};

export type StaffListQuery = {
  search?: string;
  role?: StaffRole;
  staffType?: StaffType;
  isActive?: boolean;
  page?: number;
  limit?: number;
};

export type StaffInstructorDto = {
  userId: string;
  firstName: string;
  lastName: string;
  staffType: StaffType;
};

export type AddStaffInput = {
  email: string;
  firstName?: string;
  lastName?: string;
  role: "ADMIN" | "STAFF" | "INSTRUCTOR" | "FRONT_DESK";
  staffType: StaffType;
  phone?: string;
  bio?: string;
  specialties?: string[];
  photoUrl?: string;
  isActive?: boolean;
  temporaryPassword?: string;
};

export type UpdateStaffInput = {
  role?: "ADMIN" | "STAFF" | "FRONT_DESK";
  staffType?: StaffType;
  phone?: string;
  bio?: string;
  specialties?: string[];
  photoUrl?: string;
  isActive?: boolean;
};

// ── Fetchers ─────────────────────────────────────────────────────────────────

export async function fetchStaff(
  studioId: string,
  query: StaffListQuery = {},
): Promise<StaffListResponse> {
  const params = new URLSearchParams();
  if (query.search) params.set("search", query.search);
  if (query.role) params.set("role", query.role);
  if (query.staffType) params.set("staffType", query.staffType);
  if (query.isActive !== undefined) params.set("isActive", String(query.isActive));
  if (query.page) params.set("page", String(query.page));
  if (query.limit) params.set("limit", String(query.limit));
  const qs = params.toString();
  return apiRequest<StaffListResponse>(
    `/studios/${studioId}/staff${qs ? `?${qs}` : ""}`,
    { method: "GET" },
  );
}

export async function fetchStaffInstructors(
  studioId: string,
): Promise<StaffInstructorDto[]> {
  return apiRequest<StaffInstructorDto[]>(
    `/studios/${studioId}/staff/instructors`,
    { method: "GET" },
  );
}

export async function fetchStaffMember(
  studioId: string,
  userId: string,
): Promise<StaffMember> {
  return apiRequest<StaffMember>(
    `/studios/${studioId}/staff/${userId}`,
    { method: "GET" },
  );
}

export async function addStaffMember(
  studioId: string,
  input: AddStaffInput,
): Promise<StaffMember> {
  return apiRequest<StaffMember>(`/studios/${studioId}/staff`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateStaffMember(
  studioId: string,
  userId: string,
  input: UpdateStaffInput,
): Promise<StaffMember> {
  return apiRequest<StaffMember>(`/studios/${studioId}/staff/${userId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function deactivateStaffMember(
  studioId: string,
  userId: string,
): Promise<{ deactivated: boolean; futureClassesCount: number }> {
  return apiRequest<{ deactivated: boolean; futureClassesCount: number }>(
    `/studios/${studioId}/staff/${userId}`,
    { method: "DELETE" },
  );
}
