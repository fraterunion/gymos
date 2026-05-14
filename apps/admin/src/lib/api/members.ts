import { apiRequest } from "@/lib/api/client";

export type MemberDto = {
  membershipId: string;
  role: string;
  createdAt: string;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    phone: string | null;
    createdAt: string;
  };
};

export async function fetchStudioMembers(studioId: string): Promise<MemberDto[]> {
  return apiRequest<MemberDto[]>(`/studios/${studioId}/members`, { method: "GET" });
}
