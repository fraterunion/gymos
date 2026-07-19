import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { GYMOS_CUID_PATTERN } from '@gymos/utils';

/** Body for walk-in attendance — `memberId` is the member's User.id (Prisma cuid). */
export class ManualClassAttendanceDto {
  @IsString()
  @MinLength(20)
  @MaxLength(32)
  @Matches(GYMOS_CUID_PATTERN, {
    message: 'memberId must be a valid user id',
  })
  memberId!: string;
}
