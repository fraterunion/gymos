import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

export class ForgotPasswordDto {
  @IsEmail()
  email!: string;

  /**
   * Which white-label app the request came from. Used ONLY to brand the email, and only
   * when the account actually belongs to that studio — it never affects whether a mail is
   * sent, and never appears in the response.
   */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  studioSlug?: string;
}
