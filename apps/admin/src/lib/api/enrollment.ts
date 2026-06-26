import { apiRequest } from "@/lib/api/client";

export type EnrollmentFeeStatus = "PAID" | "WAIVED";
export type WaivedReason =
  | "FIRST_N_PROMO"
  | "FIRST_N_PROMO_OVERFLOW"
  | "ADMIN_WAIVER"
  | "STAFF"
  | "LEGACY_MEMBER"
  | "OTHER";
export type CampaignType = "FIRST_N_MEMBERS";
export type CampaignAppliesTo = "ENROLLMENT_FEE";

export type EnrollmentSettingsDto = {
  id: string;
  studioId: string;
  enrollmentFeeCents: number;
  currency: string;
  campaignEnabled: boolean;
  campaignType: CampaignType | null;
  campaignName: string | null;
  campaignLimit: number | null;
  campaignDiscountPct: number | null;
  campaignAppliesTo: CampaignAppliesTo | null;
  active: boolean;
  waivedCount: number;
  paidCount: number;
  createdAt: string;
  updatedAt: string;
};

export type EnrollmentSettingsInput = {
  enrollmentFeeCents: number;
  currency?: string;
  active: boolean;
  campaignEnabled: boolean;
  campaignType?: CampaignType;
  campaignName?: string;
  campaignLimit?: number;
  campaignDiscountPct?: number;
  campaignAppliesTo?: CampaignAppliesTo;
};

export type EnrollmentListItem = {
  id: string;
  studioId: string;
  userId: string;
  settingsId: string;
  status: EnrollmentFeeStatus;
  memberNumber: number | null;
  founderNumber: number | null;
  waivedReason: WaivedReason | null;
  stripeCheckoutSessionId: string | null;
  finalizedAt: string | null;
  createdAt: string;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
  };
};

export type EnrollmentListResponse = {
  data: EnrollmentListItem[];
  total: number;
  page: number;
  limit: number;
};

export function fetchEnrollmentSettings(studioId: string): Promise<EnrollmentSettingsDto | null> {
  return apiRequest<EnrollmentSettingsDto | null>(`/studios/${studioId}/enrollment/settings`);
}

export function upsertEnrollmentSettings(
  studioId: string,
  input: EnrollmentSettingsInput,
): Promise<EnrollmentSettingsDto> {
  return apiRequest<EnrollmentSettingsDto>(`/studios/${studioId}/enrollment/settings`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function fetchEnrollments(
  studioId: string,
  opts: { page?: number; limit?: number } = {},
): Promise<EnrollmentListResponse> {
  const params = new URLSearchParams();
  if (opts.page)  params.set("page",  String(opts.page));
  if (opts.limit) params.set("limit", String(opts.limit));
  const qs = params.toString() ? `?${params.toString()}` : "";
  return apiRequest<EnrollmentListResponse>(`/studios/${studioId}/enrollment/enrollments${qs}`);
}

export function waiveEnrollment(studioId: string, enrollmentId: string): Promise<EnrollmentListItem> {
  return apiRequest<EnrollmentListItem>(
    `/studios/${studioId}/enrollment/enrollments/${enrollmentId}/waive`,
    { method: "PATCH", body: "{}" },
  );
}
