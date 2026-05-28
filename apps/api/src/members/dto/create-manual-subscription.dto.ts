import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateManualSubscriptionDto {
  @IsString()
  @MaxLength(255)
  planId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  stripeSubscriptionId?: string;
}
