import { IsString, MinLength } from 'class-validator';

/**
 * The scanned value from either credential type — a booking's signed JWT QR, or a
 * "gymos:v1:<raw>" Wallet identity credential. The field name is unchanged for backward
 * compatibility; CheckInsService.checkInWithQr dispatches on format server-side, so the
 * Front Desk scanner needs no changes to send either kind through this same field.
 */
export class QrCheckInDto {
  @IsString()
  @MinLength(10)
  qrToken!: string;
}
