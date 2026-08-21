import { IsBoolean, IsEnum, IsOptional, IsString, Matches } from 'class-validator';

export enum FinishSeriesModeDto {
  AFTER_LAST_SCHEDULED = 'AFTER_LAST_SCHEDULED',
  ON_DATE = 'ON_DATE',
}

export class FinishSeriesDto {
  @IsEnum(FinishSeriesModeDto)
  mode!: FinishSeriesModeDto;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  boundaryDate?: string;

  @IsOptional()
  @IsString()
  cancelReason?: string;

  @IsOptional()
  @IsBoolean()
  confirmReservations?: boolean;
}
