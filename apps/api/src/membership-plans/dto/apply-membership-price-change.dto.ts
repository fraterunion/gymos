import { MembershipPriceChangeScope } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  Equals,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class PreviewMembershipPriceChangeDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  newPriceCents!: number;
}

export class ApplyMembershipPriceChangeDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  newPriceCents!: number;

  @IsEnum(MembershipPriceChangeScope)
  scope!: MembershipPriceChangeScope;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  @IsString({ each: true })
  subscriptionIds?: string[];

  @IsString()
  @MinLength(8)
  @MaxLength(80)
  idempotencyKey!: string;

  /** Bulk price changes never run unless the client confirms them. */
  @IsBoolean()
  @Equals(true)
  confirm!: boolean;
}

export class RetryMembershipPriceChangeDto {
  @IsBoolean()
  @Equals(true)
  confirm!: boolean;
}
