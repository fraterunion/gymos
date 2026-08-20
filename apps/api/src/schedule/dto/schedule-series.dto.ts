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

export enum SeriesMutationScopeDto {
  SINGLE = 'SINGLE',
  FOLLOWING = 'FOLLOWING',
  SERIES = 'SERIES',
}

export class CreateRecurringSeriesDto {
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  classTemplateId!: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  instructorId?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  capacity?: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  daysOfWeek!: number[];

  @Matches(/^\d{2}:\d{2}$/)
  startTime!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(52)
  intervalWeeks?: number;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  startsOn!: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== undefined && v !== '')
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  endsOn?: string | null;

  @IsOptional()
  @IsBoolean()
  confirmWarnings?: boolean;
}

export class EditSeriesOccurrenceDto {
  @IsEnum(SeriesMutationScopeDto)
  scope!: SeriesMutationScopeDto;

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
  @IsBoolean()
  confirmReservations?: boolean;
}

export class CancelSeriesOccurrenceDto {
  @IsEnum(SeriesMutationScopeDto)
  scope!: SeriesMutationScopeDto;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  cancelReason?: string;

  @IsOptional()
  @IsBoolean()
  confirmReservations?: boolean;
}
