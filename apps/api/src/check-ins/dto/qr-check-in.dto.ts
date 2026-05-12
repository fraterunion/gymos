import { IsString, MinLength } from 'class-validator';

export class QrCheckInDto {
  @IsString()
  @MinLength(10)
  qrToken!: string;
}
