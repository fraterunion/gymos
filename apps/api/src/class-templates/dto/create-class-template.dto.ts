import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { ClassCategory, IntensityLevel } from '@prisma/client';

export const HH_MM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export class CreateClassTemplateDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name!: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(2000)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  description?: string | null;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24 * 60)
  durationMinutes!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  defaultCapacity?: number;

  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(32)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  color?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  instructorId?: string | null;

  @IsOptional()
  @IsEnum(IntensityLevel)
  intensityLevel?: IntensityLevel | null;

  @IsOptional()
  @IsEnum(ClassCategory)
  category?: ClassCategory | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  equipment?: string[];

  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsUrl()
  @MaxLength(500)
  heroImageUrl?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsUrl()
  @MaxLength(500)
  thumbnailImageUrl?: string | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  tags?: string[];

  @IsOptional()
  @IsBoolean()
  isFeatured?: boolean;

  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(100)
  difficultyLabel?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  caloriesEstimateMin?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  caloriesEstimateMax?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(168)
  cancellationWindowHours?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  waitlistCapacity?: number | null;

  // Designates this template as unstructured Open Gym access rather than a coached class.
  // Multiple Open Gym templates per studio are allowed — the booking engine treats each by ID.
  @IsOptional()
  @IsBoolean()
  isOpenGymSlot?: boolean;

  // Local booking time window (HH:mm, 24h, studio timezone). Both bounds must be set together;
  // see ClassTemplatesService.assertValidAccessWindow for the start < end invariant.
  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @Matches(HH_MM_PATTERN, { message: 'accessWindowStart must be HH:mm (24h)' })
  accessWindowStart?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @Matches(HH_MM_PATTERN, { message: 'accessWindowEnd must be HH:mm (24h)' })
  accessWindowEnd?: string | null;
}
