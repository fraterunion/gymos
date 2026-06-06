import { IsString, Matches } from 'class-validator';

export class CreateDayPassPaymentSheetDto {
  /** Local calendar date for which the pass is valid, in YYYY-MM-DD format. */
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'validForDate must be a date in YYYY-MM-DD format',
  })
  validForDate!: string;
}
