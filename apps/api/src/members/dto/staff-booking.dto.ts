import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class StaffBookingDto {
  @IsString()
  scheduledClassId!: string;

  @IsOptional()
  @IsBoolean()
  overrideEntitlement?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  overrideReason?: string;
}
