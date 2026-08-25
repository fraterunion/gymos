import { apiRequest } from "@/lib/api/client";

export type DayPassIntegrityStatus =
  | "healthy"
  | "missing_price"
  | "price_mismatch"
  | "currency_mismatch"
  | "invalid_price"
  | "inactive_stripe_price"
  | "fetch_error";

export type DayPassSettingsDto = {
  configured: boolean;
  id: string | null;
  studioId: string;
  displayName: string;
  priceCents: number;
  currency: string;
  active: boolean;
  stripeProductId: string | null;
  stripePriceId: string | null;
  validityDescription: string;
  integrity: {
    status: DayPassIntegrityStatus;
    stripeUnitAmount: number | null;
    stripeCurrency: string | null;
    stripePriceActive: boolean | null;
    stripePriceType: "one_time" | "recurring" | null;
  };
  updatedAt: string | null;
};

export type DayPassSettingsUpdateInput = {
  displayName?: string;
  priceCents?: number;
  active?: boolean;
};

export type ReconcileDayPassStripePriceResult =
  | {
      status: "already_synced";
      stripePriceId: string;
      settings: DayPassSettingsDto;
    }
  | {
      status: "reconciled";
      previousStripePriceId: string | null;
      newStripePriceId: string;
      settings: DayPassSettingsDto;
    };

export function fetchDayPassSettings(studioId: string): Promise<DayPassSettingsDto> {
  return apiRequest<DayPassSettingsDto>(`/studios/${studioId}/day-pass/settings`);
}

export function updateDayPassSettings(
  studioId: string,
  input: DayPassSettingsUpdateInput,
): Promise<DayPassSettingsDto> {
  return apiRequest<DayPassSettingsDto>(`/studios/${studioId}/day-pass/settings`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function reconcileDayPassStripePrice(
  studioId: string,
): Promise<ReconcileDayPassStripePriceResult> {
  return apiRequest<ReconcileDayPassStripePriceResult>(
    `/studios/${studioId}/day-pass/reconcile-stripe-price`,
    { method: "POST" },
  );
}
