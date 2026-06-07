import { apiRequest } from '@/lib/api/client';

export type PublicStudioDto = {
  id: string;
  name: string;
  timezone: string;
};

export async function fetchPublicStudio(slug: string): Promise<PublicStudioDto> {
  return apiRequest<PublicStudioDto>(`/public/studios/${slug}`, {
    method: 'GET',
    skipAuth: true,
  });
}
