import { IsString, MaxLength, MinLength } from 'class-validator';
import { PASSWORD_MIN_LENGTH } from '../password-policy';

export class ResetPasswordDto {
  /** Opaque one-time token from the reset email (hex). */
  @IsString()
  @MinLength(16)
  @MaxLength(512)
  token!: string;

  /** Shape check only; the shared policy in password-policy.ts is the authority. */
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  newPassword!: string;
}
