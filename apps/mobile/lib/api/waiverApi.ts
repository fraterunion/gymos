import { apiRequest } from '@/lib/api/client';

export type PublicWaiverDto = {
  id: string;
  studioId: string;
  version: string;
  title: string;
  bodyMarkdown: string;
  effectiveAt: string;
};

export type WaiverStatusDto = {
  required: boolean;
  accepted: boolean;
  activeVersion: string | null;
  activeWaiverDocumentId: string | null;
  acceptedVersion: string | null;
  acceptedAt: string | null;
  method: 'SELF' | 'STAFF_ATTESTED' | null;
};

export async function fetchPublicWaiver(studioSlug: string): Promise<PublicWaiverDto | null> {
  return apiRequest<PublicWaiverDto | null>(`/public/studios/${studioSlug}/waiver`, {
    method: 'GET',
    skipAuth: true,
  });
}

export async function fetchMyWaiverStatus(studioId: string): Promise<WaiverStatusDto> {
  return apiRequest<WaiverStatusDto>(`/studios/${studioId}/me/waiver-status`, {
    method: 'GET',
  });
}

export async function acceptWaiver(
  studioId: string,
  waiverDocumentId: string,
): Promise<void> {
  await apiRequest(`/studios/${studioId}/me/waiver-acceptance`, {
    method: 'POST',
    body: JSON.stringify({ waiverDocumentId, accepted: true }),
  });
}
