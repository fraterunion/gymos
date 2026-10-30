import { IsDateString, IsIn, IsInt, IsOptional, IsString, Min, MinLength, Matches } from 'class-validator';

export class CreateOfflineSubscriptionDto {
  @IsString()
  planId!: string;

  @IsInt()
  @Min(0)
  amountCents!: number;

  @IsOptional()
  @IsDateString()
  periodStart?: string;

  @IsOptional()
  @IsDateString()
  periodEnd?: string;

  /** Studio-local YYYY-MM-DD of the actual cash receipt. Not membership start. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  paidOn?: string;

  @IsIn(['CASH'])
  paymentMethod!: 'CASH';

  @IsOptional()
  @IsString()
  notes?: string;

  /** Required when amountCents differs from plan price (OWNER override). */
  @IsOptional()
  @IsString()
  @MinLength(3)
  priceOverrideNote?: string;

  /** Required when member has an active Stripe subscription. */
  @IsOptional()
  @IsIn(['cancel_immediately', 'cancel_at_period_end'])
  stripeResolution?: 'cancel_immediately' | 'cancel_at_period_end';
}
