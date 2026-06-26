export class CheckoutPreviewDto {
  planPriceCents!: number;
  currency!: string;
  enrollmentFeeApplies!: boolean;
  enrollmentFeeCents!: number;
  promoLikelySlotsAvailable!: boolean;
  campaignName!: string | null;
}
