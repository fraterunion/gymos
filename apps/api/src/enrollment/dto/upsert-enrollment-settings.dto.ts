import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { CampaignAppliesTo, CampaignType } from '@prisma/client';

export class UpsertEnrollmentSettingsDto {
  @IsInt()
  @Min(0)
  enrollmentFeeCents!: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsBoolean()
  active!: boolean;

  @IsBoolean()
  campaignEnabled!: boolean;

  @IsOptional()
  @IsEnum(CampaignType)
  campaignType?: CampaignType;

  @IsOptional()
  @IsString()
  campaignName?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  campaignLimit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  campaignDiscountPct?: number;

  @IsOptional()
  @IsEnum(CampaignAppliesTo)
  campaignAppliesTo?: CampaignAppliesTo;
}
