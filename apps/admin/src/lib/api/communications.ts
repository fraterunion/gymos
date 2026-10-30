import { apiRequest } from "@/lib/api/client";

export type CampaignFilters = {
  planIds?: string[];
  statuses?: string[];
  paymentSources?: string[];
};

export type CampaignRecipient = {
  userId: string;
  email: string;
  name: string;
  planName: string | null;
  lifecycleStatus: string | null;
  paymentSource: string | null;
};

export type CampaignSummary = {
  id: string;
  subject: string;
  status: string;
  recipientCount: number;
  sentCount: number;
  failedCount: number;
  skippedCount: number;
  createdAt: string;
  confirmedAt: string | null;
  completedAt: string | null;
};

export type CampaignDetail = CampaignSummary & {
  bodyText: string;
  recipients: Array<CampaignRecipient & { id: string; status: string; error: string | null; sentAt: string | null }>;
};

export function previewCampaign(studioId: string, input: {
  filters?: CampaignFilters;
  includeUserIds?: string[];
  excludeUserIds?: string[];
  allMembers?: boolean;
}) {
  return apiRequest<{
    recipientCount: number;
    previewFingerprint: string;
    suppressedCount: number;
    recipients: CampaignRecipient[];
  }>(`/studios/${studioId}/communications/preview`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function createCampaign(studioId: string, input: {
  subject: string;
  bodyText: string;
  idempotencyKey: string;
  previewFingerprint?: string;
  filters?: CampaignFilters;
  includeUserIds?: string[];
  excludeUserIds?: string[];
  allMembers?: boolean;
}) {
  return apiRequest<CampaignDetail>(`/studios/${studioId}/communications/campaigns`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function confirmCampaign(studioId: string, campaignId: string) {
  return apiRequest<CampaignDetail>(`/studios/${studioId}/communications/campaigns/${campaignId}/confirm`, {
    method: "POST",
    body: JSON.stringify({ confirm: true }),
  });
}

export function fetchCampaigns(studioId: string) {
  return apiRequest<CampaignSummary[]>(`/studios/${studioId}/communications/campaigns`);
}

export function fetchCampaign(studioId: string, campaignId: string) {
  return apiRequest<CampaignDetail>(`/studios/${studioId}/communications/campaigns/${campaignId}`);
}
