import { apiRequest } from '@/lib/api/client';

export type StaffType = 'COACH' | 'FRONT_DESK' | 'MANAGER' | 'OPERATIONS' | 'OTHER';
export type StaffRole = 'OWNER' | 'ADMIN' | 'STAFF' | 'INSTRUCTOR' | 'FRONT_DESK';

export type StaffMemberDto = {
  membershipId: string;
  userId: string;
  role: StaffRole;
  joinedAt: string;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    phone?: string | null;
    createdAt?: string;
  };
  staffProfile: {
    id: string;
    staffType: string;
    phone?: string | null;
    bio?: string | null;
    specialties: string[];
    photoUrl?: string | null;
    isActive: boolean;
  } | null;
  assignedClassesCount: number;
};

export type StaffListResponseDto = {
  data: StaffMemberDto[];
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

export type AddStaffInput = {
  email: string;
  firstName?: string;
  lastName?: string;
  role: StaffRole;
  staffType: StaffType;
  phone?: string;
  bio?: string;
  specialties?: string[];
  photoUrl?: string;
  isActive?: boolean;
  temporaryPassword: string;
};

export type UpdateStaffInput = {
  email?: string;
  firstName?: string;
  lastName?: string;
  role?: StaffRole;
  staffType?: StaffType;
  phone?: string;
  bio?: string;
  specialties?: string[];
  photoUrl?: string;
  isActive?: boolean;
  temporaryPassword?: string;
};

export type StaffActivationResult = {
  isActive: boolean;
  futureClassesCount?: number;
};

export async function fetchStaff(
  studioId: string,
  query: StaffListQuery = {},
): Promise<StaffListResponseDto> {
  const params = new URLSearchParams();
  if (query.search) params.set('search', query.search);
  if (query.role) params.set('role', query.role);
  if (query.staffType) params.set('staffType', query.staffType);
  if (query.isActive !== undefined) params.set('isActive', String(query.isActive));
  if (query.page) params.set('page', String(query.page));
  if (query.limit) params.set('limit', String(query.limit));
  const qs = params.toString();
  return apiRequest<StaffListResponseDto>(
    `/studios/${studioId}/staff${qs ? `?${qs}` : ''}`,
    { method: 'GET' },
  );
}

export async function fetchStaffMember(
  studioId: string,
  userId: string,
): Promise<StaffMemberDto> {
  return apiRequest<StaffMemberDto>(`/studios/${studioId}/staff/${userId}`, {
    method: 'GET',
  });
}

export async function addStaffMember(
  studioId: string,
  input: AddStaffInput,
): Promise<StaffMemberDto> {
  return apiRequest<StaffMemberDto>(`/studios/${studioId}/staff`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateStaffMember(
  studioId: string,
  userId: string,
  input: UpdateStaffInput,
): Promise<StaffMemberDto> {
  return apiRequest<StaffMemberDto>(`/studios/${studioId}/staff/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function activateStaffMember(
  studioId: string,
  userId: string,
): Promise<StaffActivationResult> {
  return apiRequest<StaffActivationResult>(
    `/studios/${studioId}/staff/${userId}/activate`,
    { method: 'PATCH' },
  );
}

export async function deactivateStaffMember(
  studioId: string,
  userId: string,
): Promise<StaffActivationResult> {
  return apiRequest<StaffActivationResult>(
    `/studios/${studioId}/staff/${userId}/deactivate`,
    { method: 'PATCH' },
  );
}
