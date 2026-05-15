import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

function emptyToNull(v: unknown): unknown {
  if (v === '' || v === undefined) return null;
  return v;
}

export class UpdateStudioSettingsDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  timezone?: string;

  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v != null)
  @IsEmail()
  @MaxLength(320)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  supportEmail?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v != null)
  @IsString()
  @MaxLength(40)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  supportPhone?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v != null)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  websiteUrl?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v != null)
  @IsString()
  @MaxLength(100)
  @Transform(({ value }) => (typeof value === 'string' ? value.replace(/^@+/, '').trim() : value))
  instagramHandle?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v != null)
  @IsString()
  @MaxLength(2000)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  address?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v != null)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  privacyUrl?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v != null)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  termsUrl?: string | null;
}
