import { IsBoolean, IsEmail, IsOptional, IsString, MinLength } from 'class-validator';
import { PASSWORD_MIN_LENGTH } from '../password-policy';

export class RegisterDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  firstName!: string;

  @IsString()
  @MinLength(1)
  lastName!: string;

  /** Shape check only; the shared policy in password-policy.ts is the authority. */
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  password!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  studioSlug?: string;

  @IsOptional()
  @IsBoolean()
  waiverAccepted?: boolean;

  @IsOptional()
  @IsString()
  waiverDocumentId?: string;
}
