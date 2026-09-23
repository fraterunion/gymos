import { IsOptional, IsString, Matches } from 'class-validator';

export class CreateDayPassPaymentSheetDto {
  /**
   * Local calendar date for which the pass is valid, YYYY-MM-DD in the studio timezone.
   * Optional: when omitted the server uses TODAY in the studio timezone, which is the only
   * product currently sold and removes any dependence on the device clock or timezone.
   * When sent it must be canonical, today or later, and within the purchase horizon.
   */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'validForDate must be a date in YYYY-MM-DD format',
  })
  validForDate?: string;
}
