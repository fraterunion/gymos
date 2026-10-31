import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { StudioLocalDateTimeDto } from './studio-local-datetime.dto';

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export class DuplicateClassDto {
  @ValidateNested()
  @Type(() => StudioLocalDateTimeDto)
  localStart!: StudioLocalDateTimeDto;

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
  instructorId?: string | null;

  @IsOptional()
  @IsBoolean()
  confirmWarnings?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  idempotencyKey?: string;
}

export class DuplicateWeekDto {
  /** Studio-local Monday of the source week (YYYY-MM-DD). */
  @IsString()
  @Matches(DATE_KEY)
  sourceWeekStart!: string;

  /** Studio-local Mondays of target weeks. Ignored when repeatWeeks is set. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @Matches(DATE_KEY, { each: true })
  targetWeekStarts?: string[];

  /** Repeat source week N times into consecutive future weeks (starting the week after source). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(52)
  repeatWeeks?: number;

  @IsOptional()
  @IsBoolean()
  confirmWarnings?: boolean;

  /** Confirm removing empty extra classes not present in the source week. */
  @IsOptional()
  @IsBoolean()
  confirmRemovals?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  idempotencyKey?: string;
}

export enum BulkScheduleOperation {
  CHANGE_INSTRUCTOR = 'CHANGE_INSTRUCTOR',
  CHANGE_CAPACITY = 'CHANGE_CAPACITY',
  MOVE_TIME = 'MOVE_TIME',
  CANCEL = 'CANCEL',
  DUPLICATE = 'DUPLICATE',
}

export class BulkScheduleOperationDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  scheduledClassIds!: string[];

  @IsEnum(BulkScheduleOperation)
  operation!: BulkScheduleOperation;

  @ValidateIf((o) => o.operation === BulkScheduleOperation.CHANGE_INSTRUCTOR)
  @IsString()
  @MinLength(1)
  instructorId?: string;

  @ValidateIf((o) => o.operation === BulkScheduleOperation.CHANGE_CAPACITY)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  capacity?: number;

  /** Minutes to shift start/end (MOVE_TIME). */
  @ValidateIf((o) => o.operation === BulkScheduleOperation.MOVE_TIME)
  @Type(() => Number)
  @IsInt()
  @Min(-7 * 24 * 60)
  @Max(7 * 24 * 60)
  timeDeltaMinutes?: number;

  @ValidateIf((o) => o.operation === BulkScheduleOperation.CANCEL)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  cancelReason?: string;

  @ValidateIf((o) => o.operation === BulkScheduleOperation.DUPLICATE)
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(52)
  weekOffsetWeeks?: number;

  @IsOptional()
  @IsBoolean()
  confirmWarnings?: boolean;

  @IsOptional()
  @IsBoolean()
  confirmReservations?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  idempotencyKey?: string;
}

/** "Cancelar clases por rango de fechas": studio-local dates, inclusive on both ends. */
export class RangeCancelPreviewDto {
  @Matches(DATE_KEY)
  fromDate!: string;

  @Matches(DATE_KEY)
  toDate!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  instructorIds?: string[];

  /** Class types (ClassTemplate ids). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  classTemplateIds?: string[];
}

export class RangeCancelExecuteDto extends RangeCancelPreviewDto {
  @Matches(/^[a-f0-9]{64}$/)
  previewFingerprint!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  cancelReason?: string;

  @IsBoolean()
  confirm!: boolean;

  @IsString()
  @MinLength(8)
  @MaxLength(64)
  idempotencyKey!: string;
}

/** Future unlinked occurrences that share the source class type, local weekday and local start time. */
export class MatchingDatesCancelPreviewDto {
  @IsString()
  @MinLength(1)
  scheduledClassId!: string;

  /** Default false: only the source instructor (including “no instructor”). */
  @IsOptional()
  @IsBoolean()
  includeOtherInstructors?: boolean;
}

export class MatchingDatesCancelExecuteDto extends MatchingDatesCancelPreviewDto {
  @Matches(/^[a-f0-9]{64}$/)
  previewFingerprint!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  cancelReason?: string;

  @IsBoolean()
  confirm!: boolean;

  @IsString()
  @MinLength(8)
  @MaxLength(64)
  idempotencyKey!: string;
}
