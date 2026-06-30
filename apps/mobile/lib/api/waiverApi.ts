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

export type MemberWaiverStatusDto = {
  userId: string;
  required: boolean;
  accepted: boolean;
  activeVersion: string | null;
  activeWaiverDocumentId: string | null;
  acceptedVersion: string | null;
  acceptedAt: string | null;
  method: 'SELF' | 'STAFF_ATTESTED' | null;
};

export async function fetchMemberWaiverStatus(
  studioId: string,
  userId: string,
): Promise<MemberWaiverStatusDto> {
  return apiRequest<MemberWaiverStatusDto>(
    `/studios/${studioId}/members/${userId}/waiver-status`,
    { method: 'GET' },
  );
}

export async function attestMemberWaiver(
  studioId: string,
  userId: string,
  input: { waiverDocumentId: string; attestationNote?: string },
): Promise<void> {
  await apiRequest(`/studios/${studioId}/members/${userId}/waiver-attestation`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function waiverStatusLabel(status: MemberWaiverStatusDto): string {
  if (!status.required) return 'No requerida';
  if (!status.accepted) return 'Pendiente';
  if (status.method === 'STAFF_ATTESTED') return 'Firmada presencialmente';
  return 'Aceptada';
}
