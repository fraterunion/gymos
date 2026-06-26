import { IsBoolean, IsEnum, IsISO8601, IsInt, IsOptional, Min, ValidateIf } from 'class-validator';

export enum GenerateMode {
  NEXT_30 = 'NEXT_30',
  NEXT_90 = 'NEXT_90',
  END_OF_YEAR = 'END_OF_YEAR',
  CUSTOM = 'CUSTOM',
}

export class GenerateDto {
  @IsEnum(GenerateMode)
  mode!: GenerateMode;

  /** ISO date string ('YYYY-MM-DD') required when mode = CUSTOM. */
  @ValidateIf((o: GenerateDto) => o.mode === GenerateMode.CUSTOM)
  @IsISO8601()
  toDate?: string;
}

export class UpdateAutomationDto {
  @IsBoolean()
  enabled!: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  minFutureDays?: number;
}
