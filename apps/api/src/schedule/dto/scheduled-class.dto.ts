import { ClassStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { StudioLocalDateTimeDto } from './studio-local-datetime.dto';

export class CreateScheduledClassDto {
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  templateId!: string;

  /** @deprecated Prefer localStart/localEnd — interpreted as UTC instants when used. */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  startTime?: Date;

  /** @deprecated Prefer localStart/localEnd */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  endTime?: Date;

  /** Studio-local start (authoritative for staff calendar). */
  @IsOptional()
  @ValidateNested()
  @Type(() => StudioLocalDateTimeDto)
  localStart?: StudioLocalDateTimeDto;

  /** Studio-local end. When omitted with localStart, duration comes from class template. */
  @IsOptional()
  @ValidateNested()
  @Type(() => StudioLocalDateTimeDto)
  localEnd?: StudioLocalDateTimeDto;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  capacity?: number;

  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  instructorId?: string | null;
}

export class UpdateScheduledClassDto {
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  startTime?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  endTime?: Date;

  @IsOptional()
  @ValidateNested()
  @Type(() => StudioLocalDateTimeDto)
  localStart?: StudioLocalDateTimeDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => StudioLocalDateTimeDto)
  localEnd?: StudioLocalDateTimeDto;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  capacity?: number;

  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  instructorId?: string | null;

  @IsOptional()
  @IsEnum(ClassStatus)
  status?: ClassStatus;

  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(2000)
  cancelReason?: string | null;
}

export class CancelScheduledClassDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  cancelReason?: string;
}
