import { Matches } from 'class-validator';

/** Studio-local calendar date + clock time (authoritative for staff scheduling). */
export class StudioLocalDateTimeDto {
  /** YYYY-MM-DD in the studio's local calendar */
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date!: string;

  /** HH:mm in 24-hour studio local time */
  @Matches(/^\d{2}:\d{2}$/, { message: 'time must be HH:mm' })
  time!: string;
}
