import { apiRequest } from "@/lib/api/client";

export type RosterBooking = {
  id: string;
  userId: string;
  scheduledClassId: string;
  studioId: string;
  status: string;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    phone: string | null;
  };
};

export async function fetchClassRoster(
  studioId: string,
  classId: string,
): Promise<RosterBooking[]> {
  return apiRequest<RosterBooking[]>(`/studios/${studioId}/classes/${classId}/roster`, {
    method: "GET",
  });
}
