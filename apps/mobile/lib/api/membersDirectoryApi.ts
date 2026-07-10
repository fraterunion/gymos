import { apiRequest } from '@/lib/api/client';

export type MemberSubscriptionSummary = {
  id: string;
  status: string;
  planName: string;
  planId: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
};

export type MemberListItem = {
  membershipId: string;
  role: string;
  joinedAt: string;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    phone: string | null;
    createdAt: string;
  };
  totalBookings: number;
  noShowCount: number;
  lastAttendanceAt: string | null;
  subscription: MemberSubscriptionSummary | null;
};

export type MemberListResponse = {
  data: MemberListItem[];
  total: number;
  page: number;
  limit: number;
};

export type StudioMembershipRole =
  | 'MEMBER'
  | 'INSTRUCTOR'
  | 'STAFF'
  | 'FRONT_DESK'
  | 'ADMIN'
  | 'OWNER';

export async function fetchMembers(
  studioId: string,
  query: {
    search?: string;
    role?: StudioMembershipRole;
    limit?: number;
    page?: number;
    sortBy?: 'joinDate' | 'lastAttendance' | 'totalBookings' | 'name';
    sortDir?: 'asc' | 'desc';
  } = {},
): Promise<MemberListResponse> {
  const params = new URLSearchParams();
  if (query.search) params.set('search', query.search);
  if (query.role) params.set('role', query.role);
  if (query.limit != null) params.set('limit', String(query.limit));
  if (query.page != null) params.set('page', String(query.page));
  if (query.sortBy) params.set('sortBy', query.sortBy);
  if (query.sortDir) params.set('sortDir', query.sortDir);
  const qs = params.toString();
  return apiRequest<MemberListResponse>(
    `/studios/${studioId}/members${qs ? `?${qs}` : ''}`,
    { method: 'GET' },
  );
}

export function memberDisplayName(member: Pick<MemberListItem, 'user'>): string {
  return `${member.user.firstName} ${member.user.lastName}`.trim();
}
