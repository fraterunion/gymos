import { IsString, MinLength } from 'class-validator';
import { PASSWORD_MIN_LENGTH } from '../password-policy';

export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  currentPassword!: string;

  /** Shape check only; the shared policy in password-policy.ts is the authority. */
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  newPassword!: string;
}
