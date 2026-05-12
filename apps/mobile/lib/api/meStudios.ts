import { apiRequest } from '@/lib/api/client';
import type { MyStudioRow } from '@/lib/types/studio';

export async function fetchMyStudios(): Promise<MyStudioRow[]> {
  return apiRequest<MyStudioRow[]>('/me/studios', { method: 'GET' });
}
