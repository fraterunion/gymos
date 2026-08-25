import type { DayPassIntegrityStatus } from '../day-pass-stripe-price';

export type DayPassSettingsResponseDto = {
  /** False until an intentional PATCH/reconcile/checkout bootstrap persists a row. */
  configured: boolean;
  id: string | null;
  studioId: string;
  displayName: string;
  priceCents: number;
  currency: string;
  active: boolean;
  stripeProductId: string | null;
  stripePriceId: string | null;
  /** Valid for a single studio-local calendar day (existing Day Pass semantics). */
  validityDescription: string;
  integrity: {
    status: DayPassIntegrityStatus;
    stripeUnitAmount: number | null;
    stripeCurrency: string | null;
    stripePriceActive: boolean | null;
    stripePriceType: 'one_time' | 'recurring' | null;
  };
  updatedAt: string | null;
};

export type DayPassCatalogResponseDto = {
  displayName: string;
  priceCents: number;
  currency: string;
  active: boolean;
  /** Valid for a single studio-local calendar day. */
  validityDescription: string;
};

export type ReconcileDayPassStripePriceResult =
  | {
      status: 'already_synced';
      stripePriceId: string;
      settings: DayPassSettingsResponseDto;
    }
  | {
      status: 'reconciled';
      previousStripePriceId: string | null;
      newStripePriceId: string;
      settings: DayPassSettingsResponseDto;
    };
