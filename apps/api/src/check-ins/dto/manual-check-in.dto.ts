import { IsString, MinLength } from 'class-validator';

export class ManualCheckInDto {
  @IsString()
  @MinLength(1)
  bookingId!: string;
}
