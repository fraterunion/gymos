import { apiRequest } from "@/lib/api/client";

export type MemberWaiverStatus = {
  userId: string;
  required: boolean;
  accepted: boolean;
  activeVersion: string | null;
  activeWaiverDocumentId: string | null;
  acceptedVersion: string | null;
  acceptedAt: string | null;
  method: "SELF" | "STAFF_ATTESTED" | null;
};

export type PublicWaiverDocument = {
  id: string;
  studioId: string;
  version: string;
  title: string;
  bodyMarkdown: string;
  effectiveAt: string;
};

export async function fetchMemberWaiverStatus(
  studioId: string,
  userId: string,
): Promise<MemberWaiverStatus> {
  return apiRequest<MemberWaiverStatus>(
    `/studios/${studioId}/members/${userId}/waiver-status`,
    { method: "GET" },
  );
}

export async function attestMemberWaiver(
  studioId: string,
  userId: string,
  input: { waiverDocumentId: string; attestationNote?: string },
): Promise<void> {
  await apiRequest(`/studios/${studioId}/members/${userId}/waiver-attestation`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchPublicWaiverBySlug(
  slug: string,
): Promise<PublicWaiverDocument | null> {
  return apiRequest<PublicWaiverDocument | null>(`/public/studios/${slug}/waiver`, {
    method: "GET",
    skipAuth: true,
  });
}

export function waiverStatusLabel(status: MemberWaiverStatus): string {
  if (!status.required) return "No requerida";
  if (!status.accepted) return "Pendiente";
  if (status.method === "STAFF_ATTESTED") return "Firmada presencialmente";
  return "Aceptada";
}
