import { apiRequest } from "@/lib/api/client";

export type MyStudioRow = {
  studio: {
    id: string;
    name: string;
    slug: string;
    timezone: string;
  };
  role: string;
};

export async function fetchMyStudios(): Promise<MyStudioRow[]> {
  return apiRequest<MyStudioRow[]>("/me/studios", { method: "GET" });
}
