import { IsOptional, IsString, Matches } from 'class-validator';
import { MEMBER_ERRORS } from '../../member-facing/member-errors';

export class CreateDayPassPaymentSheetDto {
  /**
   * The studio-local calendar day the member wants the pass for, 'YYYY-MM-DD'.
   * A REQUEST, never authority: the server canonicalises it on the studio clock and rejects
   * past days, non-calendar keys and days beyond DAY_PASS_PURCHASE_HORIZON_DAYS.
   * Optional for older app builds: omitted means studio-local today.
   */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: MEMBER_ERRORS.dayPassDateInvalid })
  validForDate?: string;
}
