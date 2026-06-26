import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class CreateScheduleTemplateDto {
  @IsString()
  @IsNotEmpty()
  classTemplateId!: string;

  /** 0 = Sunday … 6 = Saturday */
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  /** 'HH:MM' in 24-hour local studio time */
  @IsString()
  @Matches(/^\d{2}:\d{2}$/, { message: 'startTime must be HH:MM' })
  startTime!: string;

  @IsOptional()
  @IsString()
  instructorId?: string;

  /** Override capacity. Null uses the class template's defaultCapacity. */
  @IsOptional()
  @IsInt()
  @Min(1)
  capacity?: number;
}
