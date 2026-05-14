import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

export class UpdateBookingSettingsDto {
  @IsOptional()
  @IsBoolean()
  allowWaitlist?: boolean;

  @IsOptional()
  @IsBoolean()
  autoConfirmWaitlist?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(24 * 14)
  cancellationWindowHours?: number;

  @IsOptional()
  @IsBoolean()
  lateCancelPenaltyEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(24 * 60)
  checkInWindowMinutes?: number;
}
