import { IsDateString, IsIn, IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';

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
