import { SubscriptionSource } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  Equals,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

const LIFECYCLE_FILTERS = [
  'ACTIVE',
  'TRIALING',
  'ENDING',
  'PAST_DUE',
  'PAUSED',
  'CANCELED',
  'REPLACED',
  'SCHEDULED',
  'EXPIRED',
  'NONE',
] as const;

export class CampaignFiltersDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  planIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsIn(LIFECYCLE_FILTERS, { each: true })
  statuses?: Array<(typeof LIFECYCLE_FILTERS)[number]>;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsIn([...Object.values(SubscriptionSource), 'NONE'], { each: true })
  paymentSources?: Array<SubscriptionSource | 'NONE'>;
}

export class PreviewCampaignDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => CampaignFiltersDto)
  filters?: CampaignFiltersDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  @IsString({ each: true })
  includeUserIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  @IsString({ each: true })
  excludeUserIds?: string[];

  @IsOptional()
  @IsBoolean()
  allMembers?: boolean;
}

export class CreateCampaignDto extends PreviewCampaignDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  subject!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(10_000)
  bodyText!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(80)
  idempotencyKey!: string;
}

export class ConfirmCampaignDto {
  @IsBoolean()
  @Equals(true)
  confirm!: boolean;
}
